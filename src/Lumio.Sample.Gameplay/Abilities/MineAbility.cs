using System;
using System.Collections.Generic;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.Sample.Gameplay.Components.Ore;
using Lumio.Sample.Gameplay.Components.Vein;
using Lumio.Sample.Gameplay.Config;
using Lumio.Sample.Gameplay.EntityTypes;

namespace Lumio.Sample.Gameplay;

/// <summary>
/// Decrements vein reserve on the bound entity. Voxel cell writes and M6a bind are
/// engine slots that are not public yet (R-00469); this ability does not invent them.
/// Cost names the stamina Base ledger for admit step 3 (R-00468 G2).
/// </summary>
[AbilityType(2u, Prediction = PredictionKind.AuthorityOnly, Cost = "Stamina")]
public sealed class MineAbility : AbilityType<MineAbility.Input>
{
    /// <summary>Stable ability type id. Must stay <c>2</c>.</summary>
    public const uint TypeId = 2u;

    /// <summary>Target vein as a net-entity hex string.</summary>
    public struct Input : IAbilityInput
    {
        /// <summary>Vein entity id in hex.</summary>
        public string TargetHex;

        /// <inheritdoc />
        public void Write(IList<object?> args) => args.Add(TargetHex);

        /// <inheritdoc />
        public bool TryRead(IReadOnlyList<object?> args, int start)
        {
            if (args is null || start < 0 || start >= args.Count) return false;
            string? value = args[start]?.ToString();
            if (string.IsNullOrWhiteSpace(value)) return false;
            TargetHex = value;
            return true;
        }
    }

    /// <summary>Registers this type on the GAS catalog.</summary>
    public static void Register() => AbilityTypeCatalog.Register<MineAbility, Input>(TypeId);

    /// <inheritdoc />
    public override bool CanActivate(in Input input)
    {
        if (!NetEntityId.TryParse(input.TargetHex, out NetEntityId veinId)) return false;
        AbilityComponent? owner = SampleAbilityAdmission.CurrentOwner;
        if (owner is null) return false;
        return AdmitTarget(owner, veinId);
    }

    /// <summary>Live vein with remaining hits. Stamina belongs to admit step 3, not this method.</summary>
    public static bool AdmitTarget(AbilityComponent owner, NetEntityId veinId)
    {
        if (owner is null) return false;
        World world = owner.World;
        if (!world.IsLive(veinId)) return false;
        VeinReserveComponent reserve = owner.Get<VeinReserveComponent>(veinId);
        return reserve.Remaining.Value > 0;
    }

    /// <inheritdoc />
    public override void Execute(in Input input, AbilityComponent owner)
    {
        if (!NetEntityId.TryParse(input.TargetHex, out NetEntityId veinId))
            throw new InvalidOperationException("MineAbility.Execute requires a parsed target.");
        if (!AdmitTarget(owner, veinId))
            throw new InvalidOperationException("MineAbility.Execute requires a passed CanActivate.");

        AttributeComponent attributes = owner.Get<AttributeComponent>();
        long stamina = attributes.GetBaseValue(SampleTables.StaminaAttributeName);
        // Deduct the table cost from Base. Current is recomputed from Base at settle; writing Current is wiped.
        attributes.SetBaseValue(SampleTables.StaminaAttributeName, stamina - SampleTables.StaminaCost);

        VeinReserveComponent reserve = owner.Get<VeinReserveComponent>(veinId);
        reserve.Remaining.Value -= 1;
        if (reserve.Remaining.Value > 0) return;

        // R-00469: no public voxel batch-write ABI. Do not pretend the cell became air.
        _ = TryRequestAirWrite(veinId);
        EntityOrder drop = owner.World.Commands.Create<OreDropEntity>();
        drop.Get<OrePileComponent>().Amount.Value = SampleTables.OrePerVein;
    }

    /// <summary>Always false until the engine exposes capture/write-cell. Callers must not treat this as a miss.</summary>
    public static bool TryRequestAirWrite(NetEntityId veinId)
    {
        _ = veinId;
        return false;
    }
}

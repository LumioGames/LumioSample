using System.Collections.Generic;
using System.Numerics;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.Sample.Gameplay.Components.Vein;
using Lumio.Sample.Gameplay.Config;

namespace Lumio.Sample.Gameplay;

/// <summary>
/// Decrements vein reserve on the bound entity. Voxel air-write is host-injected;
/// a missing writer is Sample consume not wired, not a missing ABI.
/// Cost names the stamina Base ledger for admit step 3 (R-00468 G2).
/// </summary>
[AbilityType(2u, Prediction = PredictionKind.AuthorityOnly, Cost = "Stamina")]
public sealed partial class MineAbility : AbilityType<MineAbility.Input>
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

    /// <summary>Registers this type on the GAS catalog. Cost name matches the generated registry.</summary>
    public static void Register() => AbilityTypeCatalog.Register<MineAbility, Input>(TypeId, SampleTables.StaminaAttributeName);

    /// <summary>Host voxel air-write. Null means Sample consume is not wired; do not treat that as a miss that still drops ore.</summary>
    public static ISampleVoxelWriter? Writer { get; set; }

    /// <inheritdoc />
    public override bool CanActivate(in Input input)
    {
        if (!NetEntityId.TryParse(input.TargetHex, out NetEntityId veinId)) return false;
        AbilityComponent? owner = SampleAbilityAdmission.CurrentOwner;
        if (owner is null) return false;
        return AdmitTarget(owner, veinId) && WithinReach(owner, veinId);
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

    /// <summary>
    /// Melee reach is the movement step from config. Veins without LogicTransform sit at the bound cell origin.
    /// </summary>
    public static bool WithinReach(AbilityComponent owner, NetEntityId veinId)
    {
        if (owner is null) return false;
        Vector3 player = owner.Get<LogicTransform>().LocalPosition;
        Vector3 vein = Vector3.Zero;
        try
        {
            vein = owner.Get<LogicTransform>(veinId).LocalPosition;
        }
        catch (System.InvalidOperationException)
        {
        }

        float reach = (float)SampleTables.StepMeters;
        Vector3 delta = player - vein;
        return delta.LengthSquared() <= reach * reach;
    }

    /// <inheritdoc />
    public override void Execute(in Input input, AbilityComponent owner) => ExecuteCore(in input, owner);

    static partial void ExecuteCore(in Input input, AbilityComponent owner);

    /// <summary>False when the host has not wired a writer. Callers must not deduct or drop on false.</summary>
    public static bool TryRequestAirWrite(NetEntityId veinId)
    {
        ISampleVoxelWriter? writer = Writer;
        if (writer is null) return false;
        return writer.TryWriteAir(veinId);
    }
}

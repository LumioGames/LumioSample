using System.Collections.Generic;
using System.Numerics;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.Sample.Gameplay.Components.Vein;
using Lumio.Sample.Gameplay.Config;
using Lumio.Sample.Gameplay.EntityTypes;

namespace Lumio.Sample.Gameplay;

/// <summary>Authority mining of a live cell-bound vein; the final hit settles when its terrain result returns.</summary>
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
    public static void Register() => AbilityTypeCatalog.Register<MineAbility, Input>(TypeId, "Stamina");

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
        if (!world.TypeOf(veinId).Is<VeinEntity>()) return false;
        VeinReserveComponent reserve = owner.Get<VeinReserveComponent>(veinId);
        bool bound = false;
        CheckBinding(owner, reserve, ref bound);
        return reserve.Remaining.Value > 0 && bound;
    }

    /// <summary>
    /// Melee reach is the movement step from config. The target is the authored cell center.
    /// </summary>
    public static bool WithinReach(AbilityComponent owner, NetEntityId veinId)
    {
        if (owner is null) return false;
        Vector3 player = owner.Get<LogicTransform>().LocalPosition;
        if (!owner.World.IsLive(veinId) || !owner.World.TypeOf(veinId).Is<VeinEntity>()) return false;
        VeinReserveComponent reserve = owner.Get<VeinReserveComponent>(veinId);
        if (!reserve.HasCell.Value) return false;
        Vector3 vein = reserve.CellCenter;

        float reach = (float)SampleConfigBinding.For(owner.World).Movement.StepMeters;
        Vector3 delta = player - vein;
        return delta.LengthSquared() <= reach * reach;
    }

    /// <inheritdoc />
    public override void Execute(in Input input, AbilityComponent owner) => ExecuteCore(in input, owner);

    static partial void CheckBinding(AbilityComponent owner, VeinReserveComponent reserve, ref bool bound);

    /// <summary>Legacy host probe retained for compatibility; production settlement uses the Native adapter.</summary>
    public static bool TryRequestAirWrite(World world, NetEntityId veinId)
    {
        ISampleVoxelWriter? writer = SampleVoxelWriterBinding.Resolve(world.Manager);
        return writer is not null && writer.TryWriteAir(veinId);
    }

    static partial void ExecuteCore(in Input input, AbilityComponent owner);

}

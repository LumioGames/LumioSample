using System.Collections.Generic;
using System.Numerics;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.Sample.Gameplay.Components.Ore;
using Lumio.Sample.Gameplay.Config;
using Lumio.Sample.Gameplay.EntityTypes;

namespace Lumio.Sample.Gameplay;

/// <summary>
/// Picks up a dropped ore pile. Costless: the engine's built-in context admits it even when
/// stamina is below the mining cost. Admission checks the drop is alive and within melee reach;
/// Execute claims the pile and queues <see cref="PickupOreEffect"/>, which phase 9 settles on the
/// picker's Ore base ledger (sample.md §2: pickup is a GAS instant Effect).
/// </summary>
[AbilityType(3u, Prediction = PredictionKind.AuthorityOnly)]
public sealed partial class PickupAbility : AbilityType<PickupAbility.Input>
{
    /// <summary>Stable ability type id. Must stay <c>3</c>.</summary>
    public const uint TypeId = 3u;

    /// <summary>Target drop as a net-entity hex string. Same wire shape as <see cref="MineAbility.Input"/>.</summary>
    public struct Input : IAbilityInput
    {
        /// <summary>Drop entity id in hex.</summary>
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

    /// <summary>Registers this type on the GAS catalog. No cost: pickup never touches the stamina ledger.</summary>
    public static void Register() => AbilityTypeCatalog.Register<PickupAbility, Input>(TypeId);

    /// <inheritdoc />
    public override bool CanActivate(in Input input, AbilityComponent owner, out string? failureCode)
    {
        failureCode = null;
        if (owner is null || !NetEntityId.TryParse(input.TargetHex, out NetEntityId dropId))
        {
            failureCode = "pickup_invalid_target";
            return false;
        }
        if (!IsLiveDrop(owner.World, dropId))
        {
            failureCode = "pickup_target_gone";
            return false;
        }
        if (!WithinReach(owner, dropId))
        {
            failureCode = "pickup_out_of_reach";
            return false;
        }
        return true;
    }

    /// <summary>
    /// A drop that is live, is an <see cref="OreDropEntity"/> and still holds ore. Execute empties the
    /// pile when it claims it, so a second picker in the same frame fails this check (the destroy
    /// order only lands at phase 9).
    /// </summary>
    public static bool IsLiveDrop(World world, NetEntityId dropId)
    {
        if (world is null || !world.IsLive(dropId)) return false;
        if (!world.TypeOf(dropId).Is<OreDropEntity>()) return false;
        return world.Get<OrePileComponent>(dropId).Amount.Value > 0;
    }

    /// <summary>Melee reach is the movement step from config, measured between the two logic positions.</summary>
    public static bool WithinReach(AbilityComponent owner, NetEntityId dropId)
    {
        if (owner is null || !owner.World.IsLive(dropId)) return false;
        Vector3 player = owner.Get<LogicTransform>().LocalPosition;
        Vector3 drop = owner.Get<LogicTransform>(dropId).LocalPosition;
        float reach = (float)SampleConfigBinding.For(owner.World).Movement.StepMeters;
        Vector3 delta = player - drop;
        return delta.LengthSquared() <= reach * reach;
    }

    /// <inheritdoc />
    public override void Execute(in Input input, AbilityComponent owner) => ExecuteCore(in input, owner);

    static partial void ExecuteCore(in Input input, AbilityComponent owner);
}

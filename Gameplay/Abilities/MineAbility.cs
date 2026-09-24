using System;
using System.Collections.Generic;
using System.Numerics;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.Sample.Gameplay.Components.Vein;
using Lumio.Sample.Gameplay.Config;
using Lumio.Sample.Gameplay.EntityTypes;

namespace Lumio.Sample.Gameplay;

/// <summary>
/// Mining of a live cell-bound vein. The final hit orders a terrain change and settles when that
/// order's result returns (tick.md §3 rule 5).
/// <para>
/// Prediction is <see cref="PredictionKind.LogicPredict"/>: ADR-106 §1 requires the client's dig to
/// change real terrain and collision at once, so the same <see cref="Execute"/> runs on both sides and
/// the side-specific step is only <em>where the dig is ordered</em> — the authority stages it on the world's
/// commit path, the client stages it into the GAS prediction session. Nothing here writes an Undo:
/// GAS owns recording, correcting and replaying the unconfirmed window (ADR-106 §1/§3).
/// </para>
/// </summary>
[AbilityType(2u, Prediction = PredictionKind.LogicPredict, Cost = "Stamina")]
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
    /// Melee reach is the movement step from config. The target is the cell this side's own
    /// binding-table bookkeeping (<see cref="SampleMiningComponent.TryLocate"/>) has the vein bound to
    /// — never a field on the vein itself (ADR-119: "位置只有一个来源：绑定表").
    /// <para>
    /// A miss (position unknown to this side) admits rather than refuses: on the authority that only
    /// ever happens in the one-tick window before <c>CompletePendingBind</c> lands, and on a predicting
    /// client it is <em>always</em> a miss — that side's own <see cref="SampleMiningComponent"/> never
    /// runs the scan — so treating it as "out of reach" would make every client-side activation refuse
    /// locally and never reach the authority. ADR-106 §8's "unknown 不是 air" rule applies the same way
    /// to distance: unknown is not "too far", it is "ask the authority".
    /// </para>
    /// </summary>
    public static bool WithinReach(AbilityComponent owner, NetEntityId veinId)
    {
        if (owner is null) return false;
        if (!owner.World.IsLive(veinId) || !owner.World.TypeOf(veinId).Is<VeinEntity>()) return false;
        if (!owner.World.Single<SampleMiningComponent>().TryLocate(veinId, out _, out _, out Vector3 cellCenter))
            return true;
        Vector3 player = owner.Get<LogicTransform>().LocalPosition;
        float reach = (float)SampleConfigBinding.For(owner.World).Movement.StepMeters;
        Vector3 delta = player - cellCenter;
        return delta.LengthSquared() <= reach * reach;
    }

    /// <summary>
    /// One hit, written once for both sides. The hits that touch no terrain settle here, on the
    /// business phase (tick.md §3 rule 5): nothing has to succeed elsewhere for the stamina and the
    /// reserve to move. The final hit only <em>orders</em> the dig — <see cref="OrderFinalDig"/> — and what
    /// settling it would owe is written by the side that owns the settlement, on the frame that
    /// order's result comes back, and not at all when it is refused.
    /// <para>
    /// A refused order means nothing was ordered and nothing is owed, so no cooldown is charged
    /// either; the activation still consumed its sequence.
    /// </para>
    /// </summary>
    public override void Execute(in Input input, AbilityComponent owner)
    {
        if (!NetEntityId.TryParse(input.TargetHex, out NetEntityId veinId))
            throw new InvalidOperationException("MineAbility.Execute requires a parsed target.");
        if (!AdmitTarget(owner, veinId))
            throw new InvalidOperationException("MineAbility.Execute requires a passed CanActivate.");

        VeinReserveComponent reserve = owner.Get<VeinReserveComponent>(veinId);
        if (!WithinReach(owner, veinId)) return;
        ISampleConfig config = SampleConfigBinding.For(owner.World);
        AttributeComponent attributes = owner.Get<AttributeComponent>();
        string stamina = config.Stamina.Name;
        long cost = config.Mining.StaminaCost;
        if (attributes.GetBaseValue(stamina) < cost) return;

        if (reserve.Remaining.Value <= 1)
        {
            bool ordered = false;
            OrderFinalDig(owner, reserve, ref ordered);
            if (!ordered) return;
        }
        else
        {
            attributes.SetBaseValue(stamina, attributes.GetBaseValue(stamina) - cost);
            reserve.Remaining.Value -= 1;
        }
        owner.SetCooldown(TypeId, checked(owner.World.Tick + config.Mining.CooldownTicks));
    }

    /// <summary>What a side may do with the cell its predicted or authoritative view reports.</summary>
    public enum PredictedDigVerdict
    {
        /// <summary>The cell is loaded, still holds a block and is still bound to this vein: dig it.</summary>
        Order,

        /// <summary>
        /// The region is not loaded or its publication is pending. ADR-106 §8: unknown is never air and
        /// no terrain is invented for a prediction — admit the input so the authority answers, and change
        /// nothing locally.
        /// </summary>
        AwaitAuthority,

        /// <summary>The view already knows the cell is gone, or that it is not this vein's cell.</summary>
        Refuse,
    }

    /// <summary>
    /// The whole "may I dig this cell now" rule, as a pure function of what one side's voxel view
    /// reports, so both the client's local admission and its predicted order read the same rule and a
    /// test can read it without a voxel world at all.
    /// </summary>
    /// <param name="hasCell">Whether the vein is bound to an authored cell at all.</param>
    /// <param name="hasBlockId">Whether the view could answer with a block id for that cell.</param>
    /// <param name="blockId">The block the view reports; <c>0</c> is air.</param>
    /// <param name="boundEntityHex">The sparse binding the view reports for that cell, or null.</param>
    /// <param name="veinHex">The vein this hit claims.</param>
    public static PredictedDigVerdict ClassifyPredictedDig(bool hasCell, bool hasBlockId, uint blockId,
        string? boundEntityHex, string veinHex)
    {
        if (!hasCell) return PredictedDigVerdict.Refuse;
        if (!hasBlockId) return PredictedDigVerdict.AwaitAuthority;
        if (blockId == 0) return PredictedDigVerdict.Refuse;
        return string.Equals(boundEntityHex, veinHex, StringComparison.Ordinal)
            ? PredictedDigVerdict.Order
            : PredictedDigVerdict.Refuse;
    }

    static partial void CheckBinding(AbilityComponent owner, VeinReserveComponent reserve, ref bool bound);

    /// <summary>
    /// Orders the cell dug. The authority stages it on the world's commit path; the client stages it
    /// into the GAS prediction session so the hole and its collision exist at once (ADR-106 §1).
    /// <paramref name="ordered"/> stays false when nothing was ordered.
    /// </summary>
    static partial void OrderFinalDig(AbilityComponent owner, VeinReserveComponent reserve, ref bool ordered);

    /// <summary>Legacy host probe retained for compatibility; production settlement uses the Native adapter.</summary>
    public static bool TryRequestAirWrite(World world, NetEntityId veinId)
    {
        ISampleVoxelWriter? writer = SampleVoxelWriterBinding.Resolve(world.Manager);
        return writer is not null && writer.TryWriteAir(veinId);
    }
}

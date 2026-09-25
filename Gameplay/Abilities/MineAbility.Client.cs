using System.Globalization;
using Lumio.GameRuntime.Coordination;
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Components.Vein;

namespace Lumio.Sample.Gameplay;

public sealed partial class MineAbility
{
    /// <summary>
    /// Prefix for the client's predicted dig order. It must not be the adapter's logical- or
    /// physical-dig prefix: those name authoritative commit identities and the adapter answers
    /// <c>OutcomeUnknown</c> for them outside its own coalescing path. Under prediction the journal
    /// key belongs to GAS, so this id is a diagnostic label, not a receipt to replay.
    /// </summary>
    private const string PredictedDigPrefix = "sample-predicted-dig:";

    /// <summary>
    /// The client's local admission. R-00768 restored this side's own reverse lookup
    /// (<see cref="SampleMiningComponent.TryLocate"/>, now client-reachable since
    /// R-00725/R-00768 unblocked <see cref="HostVoxelWorldAdapter.TryReadSectionBindings"/> for a
    /// predicting Client world), so this once again reads the predicted voxel view instead of always
    /// admitting blind. A location miss (Section not yet subscribed on this side) still admits rather
    /// than refuses (ADR-106 §8: unknown is never "not bound") — see <see cref="Classify"/>.
    /// </summary>
    static partial void CheckBinding(AbilityComponent owner, VeinReserveComponent reserve, ref bool bound) =>
        bound = Classify(owner, reserve, out _, out _, out _, out _) != PredictedDigVerdict.Refuse;

    /// <summary>
    /// The predicted order. <see cref="HostVoxelWorldAdapter"/> routes the dig into the GAS prediction
    /// session (block plus the cell's binding), so the hole and its collision exist for this frame's
    /// render and sweeps. GAS keeps the record, matches it to the authority's answer and undoes or
    /// replays it; this method neither remembers it nor pays anything for it.
    /// <para>
    /// Nothing is ordered when the verdict is not <see cref="PredictedDigVerdict.Order"/>: a refusal is
    /// the cell already being gone, and <see cref="PredictedDigVerdict.AwaitAuthority"/> is missing
    /// data — no voxel view yet, or this side does not (yet) know the vein's Section/cell — which
    /// ADR-106 §8 answers by waiting for the authority rather than by inventing terrain.
    /// </para>
    /// </summary>
    static partial void OrderFinalDig(AbilityComponent owner, VeinReserveComponent reserve, ref bool ordered)
    {
        if (Classify(owner, reserve, out HostVoxelWorldAdapter? adapter, out VoxelCellQuery cell,
                out ulong sectionKey, out int cellOffset) != PredictedDigVerdict.Order)
            return;
        string transaction = string.Concat(PredictedDigPrefix,
            owner.World.InstanceId.ToString("x16", CultureInfo.InvariantCulture), ":",
            owner.World.Tick.ToString("x16", CultureInfo.InvariantCulture), ":", owner.Entity.ToHex());
        VoxelStageResult result = adapter!.TryStageDigThrough(sectionKey, cellOffset, cell.SectionRevision, transaction);
        ordered = result.Status == VoxelStageStatus.Staged;
    }

    /// <summary>
    /// Reads this side's voxel view once and hands it to <see cref="ClassifyPredictedDig"/>. A world
    /// with no bound adapter, or an adapter with no open prediction session, has nothing to predict
    /// with: that is <see cref="PredictedDigVerdict.AwaitAuthority"/>, not a refusal. So is a vein this
    /// side's own binding-table scan (<see cref="SampleMiningComponent.TryLocate"/>) has not (yet)
    /// resolved to a Section/cell — every live vein is bound somewhere (ADR-119: a
    /// <see cref="VeinReserveComponent"/> only ever becomes live already bound), so a miss here means
    /// "not yet known to this side", never "not bound".
    /// </summary>
    private static PredictedDigVerdict Classify(AbilityComponent owner, VeinReserveComponent reserve,
        out HostVoxelWorldAdapter? adapter, out VoxelCellQuery cell, out ulong sectionKey, out int cellOffset)
    {
        adapter = null;
        cell = default;
        sectionKey = 0UL;
        cellOffset = 0;
        HostVoxelWorldAdapter? resolved = VoxelGameplayBinding.Resolve(owner.World.Manager);
        if (resolved?.Prediction is null) return PredictedDigVerdict.AwaitAuthority;
        if (!owner.World.Single<SampleMiningComponent>().TryLocate(reserve.Entity, out ulong section, out int offset, out _))
            return PredictedDigVerdict.AwaitAuthority;
        VoxelCellQuery read = resolved.Read(section, offset);
        PredictedDigVerdict verdict = ClassifyPredictedDig(true, read.HasBlockId, read.BlockId,
            read.HasBlockId ? resolved.BindingGet(section, offset) : null, reserve.Entity.ToHex());
        if (verdict != PredictedDigVerdict.Order) return verdict;
        adapter = resolved;
        cell = read;
        sectionKey = section;
        cellOffset = offset;
        return verdict;
    }
}

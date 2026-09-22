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
    /// The client's local admission. The replicated vein tells us whether it owns a cell at all; the
    /// predicted voxel view decides the rest. When there is no prediction session, or the section's
    /// data has not arrived, the input is still admitted so it reaches the authority (ADR-106 §8) —
    /// what must not happen is a local terrain change on a cell this side cannot see.
    /// </summary>
    static partial void CheckBinding(AbilityComponent owner, VeinReserveComponent reserve, ref bool bound) =>
        bound = Classify(owner, reserve, out _, out _) != PredictedDigVerdict.Refuse;

    /// <summary>
    /// The predicted order. <see cref="HostVoxelWorldAdapter"/> routes the dig into the GAS prediction
    /// session (block plus the cell's binding), so the hole and its collision exist for this frame's
    /// render and sweeps. GAS keeps the record, matches it to the authority's answer and undoes or
    /// replays it; this method neither remembers it nor pays anything for it.
    /// <para>
    /// Nothing is ordered when the verdict is not <see cref="PredictedDigVerdict.Order"/>: a refusal is
    /// the cell already being gone, and <see cref="PredictedDigVerdict.AwaitAuthority"/> is missing
    /// data, which ADR-106 §8 answers by waiting for the authority rather than by inventing terrain.
    /// </para>
    /// </summary>
    static partial void OrderFinalDig(AbilityComponent owner, VeinReserveComponent reserve, ref bool ordered)
    {
        if (Classify(owner, reserve, out HostVoxelWorldAdapter? adapter, out VoxelCellQuery cell)
            != PredictedDigVerdict.Order) return;
        string transaction = string.Concat(PredictedDigPrefix,
            owner.World.InstanceId.ToString("x16", CultureInfo.InvariantCulture), ":",
            owner.World.Tick.ToString("x16", CultureInfo.InvariantCulture), ":", owner.Entity.ToHex());
        VoxelStageResult result = adapter!.TryStageDigThrough(reserve.SectionKey.Value, reserve.CellOffset.Value,
            cell.SectionRevision, transaction);
        ordered = result.Status == VoxelStageStatus.Staged;
    }

    /// <summary>
    /// Reads this side's voxel view once and hands it to <see cref="ClassifyPredictedDig"/>. A world
    /// with no bound adapter, or an adapter with no open prediction session, has nothing to predict
    /// with: that is <see cref="PredictedDigVerdict.AwaitAuthority"/>, not a refusal.
    /// </summary>
    private static PredictedDigVerdict Classify(AbilityComponent owner, VeinReserveComponent reserve,
        out HostVoxelWorldAdapter? adapter, out VoxelCellQuery cell)
    {
        adapter = null;
        cell = default;
        if (!reserve.HasCell.Value) return PredictedDigVerdict.Refuse;
        HostVoxelWorldAdapter? resolved = VoxelGameplayBinding.Resolve(owner.World.Manager);
        if (resolved?.Prediction is null) return PredictedDigVerdict.AwaitAuthority;
        ulong section = reserve.SectionKey.Value;
        int offset = reserve.CellOffset.Value;
        VoxelCellQuery read = resolved.Read(section, offset);
        PredictedDigVerdict verdict = ClassifyPredictedDig(true, read.HasBlockId, read.BlockId,
            read.HasBlockId ? resolved.BindingGet(section, offset) : null, reserve.Entity.ToHex());
        if (verdict != PredictedDigVerdict.Order) return verdict;
        adapter = resolved;
        cell = read;
        return verdict;
    }
}

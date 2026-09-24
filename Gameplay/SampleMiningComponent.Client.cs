using System.Collections.Generic;
using System.Numerics;
using Lumio.GameRuntime.Coordination;
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Config;

namespace Lumio.Sample.Gameplay;

public sealed partial class SampleMiningComponent
{
    /// <summary>
    /// The client's own read-only reverse lookup (R-00768). Unlike the server this side never creates
    /// or binds a vein, so it keeps no scan-time location cache — it re-scans every authored candidate
    /// Section (<see cref="SampleMiningComponent.AllCandidateSections"/>) through this side's own
    /// already-received binding-table replica on each call, via
    /// <see cref="HostVoxelWorldAdapter.TryReadSectionBindings"/> (both the authority and a predicting
    /// Client world may call it since R-00725/R-00768 — Native answers only this side's own committed
    /// table, never another connection's). A Section this side has not (yet) subscribed to answers false
    /// and is skipped by <see cref="TryLocateInSections"/>, never treated as proof the vein is unbound —
    /// callers must keep reading a miss as "unknown", never "not bound" (ADR-106 §8).
    /// </summary>
    /// <remarks>
    /// This restores the pre-ADR-119 behavior <c>MineAbility.Client.cs</c>'s doc comment used to call a
    /// regression: <see cref="MineAbility.Execute"/> can again change real terrain and collision on both
    /// sides in the same tick (ADR-106 §1), because <c>MineAbility.Client.cs</c>'s <c>Classify</c> can
    /// once more resolve a vein's Section/cell to call <c>HostVoxelWorldAdapter.BindingGet</c> /
    /// <c>Read</c> / <c>TryStageDigThrough</c> against it. No second binding table is introduced: every
    /// answer here comes straight from the same committed table the authority itself reads.
    /// </remarks>
    public bool TryLocate(NetEntityId vein, out ulong sectionKey, out int cellOffset, out Vector3 cellCenter)
    {
        cellCenter = default;
        HostVoxelWorldAdapter? adapter = VoxelGameplayBinding.Resolve(World.Manager);
        if (adapter is null)
        {
            sectionKey = 0UL;
            cellOffset = 0;
            return false;
        }
        ISampleConfig config = SampleConfigBinding.For(World);
        List<ulong> candidates = AllCandidateSections(config.Map.Width, config.Map.Depth);
        bool located = TryLocateInSections(vein, candidates,
            (ulong key, out IReadOnlyList<SectionBindingEntry> entries) => adapter.TryReadSectionBindings(key, out entries, out _),
            out sectionKey, out cellOffset, out int worldX, out int worldZ);
        if (located) cellCenter = new Vector3(worldX + 0.5f, 0.5f, worldZ + 0.5f);
        return located;
    }
}

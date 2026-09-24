using System.Numerics;
using Lumio.GameRuntime.Coordination;
using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay;

public sealed partial class SampleMiningComponent
{
    /// <summary>
    /// A predicting client never runs the binding-table scan (no <c>SampleMiningSystem</c>
    /// registration on this side, and <see cref="HostVoxelWorldAdapter.TryReadSectionBindings"/> is
    /// Authority-only per ADR-119), so this side has no location cache to read and always misses.
    /// Callers must treat the miss as "unknown", never as "not bound" (ADR-106 §8) — see
    /// <see cref="MineAbility.WithinReach"/>, which admits rather than refuses on a miss.
    /// </summary>
    public bool TryLocate(NetEntityId vein, out ulong sectionKey, out int cellOffset, out Vector3 cellCenter)
    {
        _ = vein;
        sectionKey = 0UL;
        cellOffset = 0;
        cellCenter = default;
        return false;
    }
}

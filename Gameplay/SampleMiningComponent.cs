using System.Collections.Generic;
using Lumio.GameRuntime.Coordination;
using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay;

/// <summary>World-owned transient mining work; restored veins carry their own cell identity.</summary>
[EcsComponent]
public sealed partial class SampleMiningComponent : Component
{
    /// <summary>One side's answer for one candidate Section: <c>false</c> means the Section is not
    /// resident/subscribed on this side (a miss to skip, never proof the vein is unbound elsewhere);
    /// <c>true</c> hands back its committed binding entries. Matches
    /// <see cref="HostVoxelWorldAdapter.TryReadSectionBindings"/>'s own shape minus the SectionRevision
    /// out param neither side's scan needs.</summary>
    internal delegate bool SectionBindingReader(ulong sectionKey, out IReadOnlyList<SectionBindingEntry> entries);

    /// <summary>
    /// Every Section the authored map spans (R4/ADR-119 §4 B6, shared by both sides' scans): the
    /// server's create→bind walk and the client's read-only reverse lookup (R-00768) must agree on the
    /// same candidate set, computed once from map config, never from a coordinate field on an entity.
    /// </summary>
    internal static List<ulong> AllCandidateSections(int width, int depth)
    {
        var sections = new List<ulong>();
        var seen = new HashSet<ulong>();
        for (int z = 0; z < depth; z += 16)
        for (int x = 0; x < width; x += 16)
        {
            ulong section = ((ulong)(x >> 4) << 36) | (uint)(z >> 4);
            if (seen.Add(section)) sections.Add(section);
        }
        return sections;
    }

    /// <summary>
    /// The inverse of <see cref="AllCandidateSections"/>'s packing: this Section's own origin cell in
    /// world coordinates. Both sides need it — the server to place a newly discovered vein, the client
    /// to turn a bound cell offset back into a world position — so it lives here once rather than as a
    /// second copy of the same fixed voxel wire shift each side would otherwise carry.
    /// </summary>
    internal static void SectionOrigin(ulong section, out int originX, out int originZ)
    {
        originX = (int)(section >> 36) << 4;
        originZ = (int)(section & 0xFFFFFFFFUL) << 4;
    }

    /// <summary>
    /// Scans <paramref name="candidateSections"/> through <paramref name="read"/> for
    /// <paramref name="vein"/>'s committed binding (ADR-119 决策 2: "位置只有一个来源：绑定表"), the
    /// pure half of both sides' <c>TryLocate</c> — no adapter, no world, so a test can drive it with a
    /// fake reader. A Section <paramref name="read"/> misses on is skipped, not treated as proof the
    /// vein is unbound (ADR-106 §8: unknown is never "not bound").
    /// </summary>
    internal static bool TryLocateInSections(NetEntityId vein, IReadOnlyList<ulong> candidateSections,
        SectionBindingReader read, out ulong sectionKey, out int cellOffset, out int worldX, out int worldZ)
    {
        for (int i = 0; i < candidateSections.Count; i++)
        {
            ulong section = candidateSections[i];
            if (!read(section, out IReadOnlyList<SectionBindingEntry> entries)) continue;
            for (int j = 0; j < entries.Count; j++)
            {
                if (!entries[j].Entity.Equals(vein)) continue;
                sectionKey = section;
                cellOffset = entries[j].CellOffset;
                SectionOrigin(section, out int originX, out int originZ);
                worldX = originX + cellOffset % 16;
                worldZ = originZ + cellOffset / 16;
                return true;
            }
        }
        sectionKey = 0UL;
        cellOffset = 0;
        worldX = 0;
        worldZ = 0;
        return false;
    }
}

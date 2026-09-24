using System;
using System.Linq;
using System.Numerics;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Simulation;
using Lumio.Sample.Gameplay;
using Lumio.Sample.Gameplay.Components.Vein;

namespace Lumio.Sample.Gameplay.Tests;

/// <summary>
/// ADR-119 retires every coordinate field from <c>VeinReserveComponent</c> (<c>SectionKey</c>,
/// <c>CellOffset</c>, <c>CellX/Y/Z</c>, <c>HasCell</c>, <c>CellCenter</c>): a vein's cell now lives only
/// in <see cref="SampleMiningComponent"/>'s own scan-time binding bookkeeping
/// (<see cref="SampleMiningComponent.TryLocate"/>, "位置只有一个来源：绑定表"). This is the one place the
/// test suite now does that lookup, so the many call sites that used to read the field directly stay a
/// one-line change; <see cref="TickUntilBound"/> and <see cref="TickUntilScanSettles"/> are the one place
/// that drives B6's create→bind round trip to completion before a test asserts on a location or a count.
/// </summary>
internal static class VeinLocationTestSupport
{
    public readonly record struct VeinLocation(ulong Section, int Offset, int WorldX, int WorldZ, Vector3 CellCenter);

    public static bool TryLocate(World world, NetEntityId vein, out VeinLocation location)
    {
        if (world.Single<SampleMiningComponent>().TryLocate(vein, out ulong section, out int offset, out Vector3 center))
        {
            // Same section-origin + offset math ScanSection uses to place a cell (offset = zOff*16+xOff).
            int sectionOriginX = (int)(section >> 36) << 4;
            int sectionOriginZ = (int)(section & 0xFFFFFFFFUL) << 4;
            int worldX = sectionOriginX + offset % 16;
            int worldZ = sectionOriginZ + offset / 16;
            location = new VeinLocation(section, offset, worldX, worldZ, center);
            return true;
        }
        location = default;
        return false;
    }

    /// <summary>Finds the bound vein at authored cell (<paramref name="worldX"/>, <paramref name="worldZ"/>), ticking until B6's scan has bound one there. Throws after <paramref name="maxTicks"/>.</summary>
    public static VeinReserveComponent TickUntilVeinBoundAt(WorldManager manager, int worldX, int worldZ, int maxTicks = 64)
    {
        for (int i = 0; i < maxTicks; i++)
        {
            foreach (VeinReserveComponent vein in manager.World.Each<VeinReserveComponent>())
                if (TryLocate(manager.World, vein.Entity, out VeinLocation loc) && loc.WorldX == worldX && loc.WorldZ == worldZ)
                    return vein;
            manager.Tick();
        }
        throw new InvalidOperationException($"No vein bound at ({worldX},{worldZ}) within {maxTicks} ticks.");
    }

    /// <summary>The vein's current binding-table position. Throws if this side has not (yet) bound it — call <see cref="TickUntilBound"/> first on a freshly booted world.</summary>
    public static VeinLocation Locate(World world, NetEntityId vein)
    {
        if (!TryLocate(world, vein, out VeinLocation location))
            throw new InvalidOperationException(
                $"Vein {vein.ToHex()} is not yet bound (SampleMiningComponent has not scanned its Section yet); call {nameof(TickUntilBound)} first.");
        return location;
    }

    /// <summary>
    /// Ticks <paramref name="manager"/> until <see cref="SampleMiningComponent"/> has bound
    /// <paramref name="vein"/> to a cell (B6's create→bind round trip), or throws after
    /// <paramref name="maxTicks"/>. A hang here means the scan genuinely never completes for this vein,
    /// not a fixed-tick-count guess going stale as the scan's own per-Section tick budget changes.
    /// </summary>
    public static VeinLocation TickUntilBound(WorldManager manager, NetEntityId vein, int maxTicks = 64)
    {
        for (int i = 0; i < maxTicks; i++)
        {
            if (TryLocate(manager.World, vein, out VeinLocation location)) return location;
            manager.Tick();
        }
        throw new InvalidOperationException($"Vein {vein.ToHex()} did not bind within {maxTicks} ticks.");
    }

    /// <summary>
    /// Ticks <paramref name="manager"/> until at least one <see cref="VeinReserveComponent"/> is live,
    /// and returns its entity id — the entity-creation half of B6's create→bind round trip, before
    /// <see cref="TickUntilBound"/> waits out the bind half. Throws after <paramref name="maxTicks"/>.
    /// </summary>
    public static NetEntityId TickUntilFirstVeinExists(WorldManager manager, int maxTicks = 32)
    {
        for (int i = 0; i < maxTicks; i++)
        {
            VeinReserveComponent? vein = manager.World.Each<VeinReserveComponent>().FirstOrDefault();
            if (vein is not null) return vein.Entity;
            manager.Tick();
        }
        throw new InvalidOperationException("No vein was created within the tick budget.");
    }

    /// <summary>
    /// Ticks <paramref name="manager"/> until B6's scan has visited every Section the authored map spans
    /// and finished any create→bind round trip it started, observed as "the live
    /// <see cref="VeinReserveComponent"/> count held steady for <paramref name="quietTicks"/> consecutive
    /// ticks" — there is no public "scan done" signal, and the private scan queue processes at most one
    /// Section per tick (see <c>SampleMiningComponent.ContinueScanning</c>), so this is the black-box
    /// equivalent. Throws after <paramref name="maxTicks"/> if the count never settles.
    /// </summary>
    public static void TickUntilScanSettles(WorldManager manager, int quietTicks = 3, int maxTicks = 64)
    {
        int stableTicks = 0;
        int lastCount = -1;
        for (int i = 0; i < maxTicks; i++)
        {
            manager.Tick();
            int count = manager.World.Each<VeinReserveComponent>().Count();
            if (count == lastCount)
            {
                stableTicks++;
                if (stableTicks >= quietTicks) return;
            }
            else
            {
                stableTicks = 0;
                lastCount = count;
            }
        }
        throw new InvalidOperationException("Vein scan did not settle (live vein count kept changing) within the tick budget.");
    }
}

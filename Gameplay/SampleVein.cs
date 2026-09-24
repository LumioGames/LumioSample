using System;
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.EntityTypes;

namespace Lumio.Sample.Gameplay;

/// <summary>
/// Queues a vein create. Remaining is seeded in <c>VeinReserveComponent.PostAttribute</c>; the cell
/// binding itself is staged directly through <c>HostVoxelWorldAdapter</c> by
/// <see cref="SampleMiningComponent"/>'s own scan (ADR-119 §4 B6) — the sparse-ref host port
/// (<c>ISampleVoxelBinding</c>/<c>TryBind</c>, R-00469 era) is retired, not kept as a fallback.
/// </summary>
public static class SampleVein
{
    /// <summary>Queues <see cref="VeinEntity"/> on the command buffer. Call after lifecycle, not inside it.</summary>
    [System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1510", Justification = "Keep netstandard2.1 compatibility without conditional source branches.")]
    public static EntityOrder Queue(World world)
    {
        if (world is null) throw new ArgumentNullException(nameof(world));
        return world.Commands.Create<VeinEntity>();
    }
}

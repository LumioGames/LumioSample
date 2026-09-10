using System;
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.EntityTypes;

namespace Lumio.Sample.Gameplay;

/// <summary>Queues a vein create. Remaining is seeded in <c>VeinReserveComponent.PostAttribute</c>.</summary>
public static class SampleVein
{
    /// <summary>Queues <see cref="VeinEntity"/> on the command buffer. Call after lifecycle, not inside it.</summary>
    public static EntityOrder Queue(World world)
    {
        ArgumentNullException.ThrowIfNull(world);
        return world.Commands.Create<VeinEntity>();
    }

    /// <summary>
    /// Sparse-ref bind after the vein has an id. Null port is a documented miss (R-00469), not a fake success.
    /// </summary>
    public static bool TryBind(NetEntityId veinId, ISampleVoxelBinding? binding, ulong sectionKey, int cellOffset)
    {
        if (binding is null) return false;
        return binding.TryBind(veinId, sectionKey, cellOffset);
    }
}

using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay;

/// <summary>
/// Host-injected sparse-ref bind. Sample does not reference Coordination;
/// the host adapts R-00469 <c>binding_set</c> when that ABI is public.
/// </summary>
public interface ISampleVoxelBinding
{
    /// <summary>Binds a live vein entity to one cell. False if the host has no ABI.</summary>
    bool TryBind(NetEntityId veinId, ulong sectionKey, int cellOffset);
}

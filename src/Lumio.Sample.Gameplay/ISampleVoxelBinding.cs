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

/// <summary>Host-injected air write. False means the consume path is not wired, not that the ABI is missing.</summary>
public interface ISampleVoxelWriter
{
    /// <summary>Writes the bound vein cell to air. False if the host cannot commit.</summary>
    bool TryWriteAir(NetEntityId veinId);
}

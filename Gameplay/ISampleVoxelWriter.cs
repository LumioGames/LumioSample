using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay;

/// <summary>Host-injected air write. False means the consume path is not wired, not that the ABI is missing.</summary>
public interface ISampleVoxelWriter
{
    /// <summary>Writes the bound vein cell to air. False if the host cannot commit.</summary>
    bool TryWriteAir(NetEntityId veinId);
}

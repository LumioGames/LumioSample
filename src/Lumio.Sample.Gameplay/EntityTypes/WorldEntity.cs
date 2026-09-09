// 世界单例在注册表里必须恰好一个。TickRateHz 是无头宿主唯一能拿到的逻辑帧率，宿主不许另发明一个。
using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay.EntityTypes;

[EntityType(Mode.CS, World = true, TickRateHz = 20)]
[Has(typeof(WorldSaveComponent))]
public abstract class WorldEntity
{
}

// 矿脉不动，所以不挂任何 Transform。储量是实体上的业务数据；格子里只写真方块类型。
// 它是方块实体（ADR-119）：矿格的稀疏绑定指向它，Runtime 的绑定策略只接受 [BlockEntity] 声明过的类型；
// 方块实体不挂 ObserverComponent（没有连接绑到它），组件同步字段只准 Scope.Aoi / Claim / None。
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Components.Vein;

namespace Lumio.Sample.Gameplay.EntityTypes;

/// <summary>Immobile vein. Remaining hits live on the entity, not in the voxel cell.</summary>
[EntityType(Mode.CS)]
[BlockEntity]
[Has(typeof(VeinReserveComponent))]
public abstract class VeinEntity
{
}

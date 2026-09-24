// 矿脉不动、不需要 Transform：它是方块实体（ADR-119），位置只来自绑定表（体素格子的稀疏引用，
// 见 voxel.md M6a），不挂 ObserverComponent（没有连接绑定它）、不挂任何 Transform。储量是实体上的
// 业务数据；格子里只写真方块类型。Runtime 的绑定策略只接受 [BlockEntity] 声明过的类型（SetBindingPolicy）；
// 组件同步字段只准 Scope.Aoi / Claim / None。
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Components.Vein;

namespace Lumio.Sample.Gameplay.EntityTypes;

/// <summary>Immobile vein block entity. Remaining hits live on the entity; its cell lives only in the binding table.</summary>
[EntityType(Mode.CS)]
[BlockEntity]
[Has(typeof(VeinReserveComponent))]
public abstract class VeinEntity
{
}

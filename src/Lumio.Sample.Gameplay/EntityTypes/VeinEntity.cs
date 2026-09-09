// 矿脉不动，所以不挂 LogicTransform。储量是实体上的业务数据；格子里只写真方块类型（体素绑定等 R-00469）。
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Components.Vein;

namespace Lumio.Sample.Gameplay.EntityTypes;

/// <summary>Immobile vein. Remaining hits live on the entity, not in the voxel cell.</summary>
[EntityType(Mode.CS)]
[Has(typeof(ObserverComponent))]
[Has(typeof(VeinReserveComponent))]
public abstract class VeinEntity
{
}

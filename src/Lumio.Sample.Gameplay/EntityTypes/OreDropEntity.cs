// 掉落矿石是 CS 实体：有生命周期、能被捡，但不占地形格、不走矿脉稀疏引用。
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Components.Ore;

namespace Lumio.Sample.Gameplay.EntityTypes;

/// <summary>Dropped ore pile. Occupies no terrain cell and is not a vein bind.</summary>
[EntityType(Mode.CS)]
[Has(typeof(ObserverComponent))]
[Has(typeof(LogicTransform))]
[Has(typeof(OrePileComponent))]
public abstract class OreDropEntity
{
}

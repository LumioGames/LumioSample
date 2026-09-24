// 方块实体声明（ADR-119）：[BlockEntity] 与 [EntityType(Mode.CS)] 挂在同一个声明类上，箱子不挂
// ObserverComponent（没有绑定连接）、不挂任何 Transform，位置只来自绑定表。
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Components.Box;

namespace Lumio.Sample.Gameplay.EntityTypes;

/// <summary>A placed storage box. Demonstrates ADR-119 §4 B3's Scope.Claim private-field rule.</summary>
[EntityType(Mode.CS)]
[BlockEntity]
[Has(typeof(BoxComponent))]
public abstract class BoxEntity
{
}

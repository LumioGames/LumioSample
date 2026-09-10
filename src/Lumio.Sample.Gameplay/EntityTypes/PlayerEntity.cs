// 声明类必须 abstract、无成员。挂 IdentityComponent 承接平台 accountId 绑定与用户名。
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Components.Chat;
using Lumio.Sample.Gameplay.Components.Identity;

namespace Lumio.Sample.Gameplay.EntityTypes;

/// <summary>Admitted player.</summary>
[EntityType(Mode.CS)]
[Has(typeof(ObserverComponent))]
[Has(typeof(IdentityComponent))]
[Has(typeof(LogicTransform))]
[Has(typeof(ChatComponent))]
[Has(typeof(AbilityComponent))]
[Has(typeof(AttributeComponent))]
[Has(typeof(EffectComponent))]
public abstract class PlayerEntity
{
}

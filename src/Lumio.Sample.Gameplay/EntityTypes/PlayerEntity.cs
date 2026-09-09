// 声明类必须 abstract、无成员。Sample 不挂 Identity：说话人用 NetEntityId 十六进制，避免再造一份名字属性。
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Components.Chat;

namespace Lumio.Sample.Gameplay.EntityTypes;

[EntityType(Mode.CS)]
[Has(typeof(ObserverComponent))]
[Has(typeof(LogicTransform))]
[Has(typeof(ChatComponent))]
[Has(typeof(AbilityComponent))]
[Has(typeof(AttributeComponent))]
[Has(typeof(EffectComponent))]
public abstract class PlayerEntity
{
}

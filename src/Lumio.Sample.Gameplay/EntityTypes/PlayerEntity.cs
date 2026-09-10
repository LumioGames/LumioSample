// 声明类必须 abstract、无成员。挂 IdentityComponent 承接平台 accountId 绑定与用户名。
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Components.Chat;
using Lumio.Sample.Gameplay.Components.Identity;

namespace Lumio.Sample.Gameplay.EntityTypes;

/// <summary>
/// Admitted player. Identity binds platform accountId and display name;
/// chat still names the speaker by net entity id.
/// ADR-090 ledgers: Stamina and Ore, each Base + Current. Initials come from
/// <c>config/attributes.json</c> via <c>SampleAttributeSeed</c> (R-00468 G1 annotation not in the package yet).
/// </summary>
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

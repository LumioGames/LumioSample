using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Components.Chat;
using Lumio.Sample.Gameplay.Components.Identity;

namespace Lumio.Sample.Gameplay.EntityTypes;

/// <summary>Bot admissions use the same gameplay components as players.</summary>
[EntityType(Mode.CS)]
[DeclareAttribute("Stamina", Persist = true)]
[DeclareAttribute("Ore", Persist = true)]
[Has(typeof(ObserverComponent))]
[Has(typeof(IdentityComponent))]
[Has(typeof(LogicTransform))]
[Has(typeof(ChatComponent))]
[Has(typeof(AbilityComponent))]
[Has(typeof(AttributeComponent))]
[Has(typeof(EffectComponent))]
public abstract class BotEntity
{
}

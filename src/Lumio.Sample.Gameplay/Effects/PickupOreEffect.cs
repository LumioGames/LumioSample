using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.Sample.Gameplay.Config;

namespace Lumio.Sample.Gameplay;

/// <summary>
/// Instant ore credit. Settlement must already be entered; this type does not open a second ledger path.
/// </summary>
[EffectType(TypeId = 10, Instant = true)]
public sealed class PickupOreEffect : EffectType<PickupOreEffect.Parameters>
{
    public const uint TypeId = 10u;

    public const string FxKeyName = "pickup-ore";

    public struct Parameters : IEffectParameters
    {
        public long Amount;

        public long Magnitude => Amount;

        public string FxKey => FxKeyName;
    }

    public static void Register() =>
        EffectTypeCatalog.Register<PickupOreEffect, Parameters>(TypeId, static (target, magnitude) =>
        {
            var effect = new PickupOreEffect();
            var parameters = new Parameters { Amount = magnitude };
            effect.Apply(target, in parameters);
        });

    public override void Apply(NetEntityId target, in Parameters parameters)
    {
        World? world = EffectSettlementContext.CurrentWorld;
        if (world is null || !world.IsLive(target)) return;
        IEffectWriteGuard guard = EffectSettlementContext.Guard;
        if (!guard.CanWrite)
            throw new System.InvalidOperationException("PickupOreEffect.Apply requires EffectSettlementContext.");

        AttributeComponent attributes = world.Get<AttributeComponent>(target);
        long next = attributes.GetBaseValue(SampleTables.OreAttributeName) + parameters.Magnitude;
        attributes.GetBase(SampleTables.OreAttributeName).Value = next;
    }
}

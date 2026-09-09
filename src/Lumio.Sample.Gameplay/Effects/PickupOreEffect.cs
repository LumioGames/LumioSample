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
    /// <summary>Stable effect type id. Must stay <c>10</c>.</summary>
    public const uint TypeId = 10u;

    /// <summary>FX key the client spark looks up. Not a gameplay table number.</summary>
    public const string FxKeyName = "pickup-ore";

    /// <summary>How much ore to credit in one settlement.</summary>
    public struct Parameters : IEffectParameters
    {
        /// <summary>Units of ore to add.</summary>
        public long Amount;

        /// <inheritdoc />
        public long Magnitude => Amount;

        /// <inheritdoc />
        public string FxKey => FxKeyName;
    }

    /// <summary>Registers this type on the GAS catalog.</summary>
    public static void Register() =>
        EffectTypeCatalog.Register<PickupOreEffect, Parameters>(TypeId, static (target, magnitude) =>
        {
            var effect = new PickupOreEffect();
            var parameters = new Parameters { Amount = magnitude };
            effect.Apply(target, in parameters);
        });

    /// <inheritdoc />
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

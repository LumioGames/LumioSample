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

    public override void Settle(EffectSettlementContext context, NetEntityId target, long magnitude)
    {
        var parameters = new Parameters { Amount = magnitude };
        Apply(context, target, in parameters);
    }

    /// <inheritdoc />
    public override void Apply(EffectSettlementContext context, NetEntityId target, in Parameters parameters)
    {
        World? world = context.World;
        if (world is null || !world.IsLive(target)) return;
        if (!context.CanWrite)
            throw new System.InvalidOperationException("PickupOreEffect.Apply requires EffectSettlementContext.");

        AttributeComponent attributes = world.Get<AttributeComponent>(target);
        long next = attributes.GetBaseValue(SampleConfigBinding.For(world).Ore.Name) + parameters.Magnitude;
        attributes.GetBase(SampleConfigBinding.For(world).Ore.Name).Value = next;
    }
}

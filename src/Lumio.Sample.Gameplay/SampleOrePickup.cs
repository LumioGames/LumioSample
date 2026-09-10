using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.Sample.Gameplay.Components.Ore;

namespace Lumio.Sample.Gameplay;

/// <summary>Applies <see cref="PickupOreEffect"/> and queues drop destroy. Settlement is the only write path.</summary>
public static class SampleOrePickup
{
    /// <summary>Credits ore Base from the pile amount. False if either entity is gone.</summary>
    public static bool TryPickup(World world, NetEntityId picker, NetEntityId drop)
    {
        if (world is null || !world.IsLive(picker) || !world.IsLive(drop)) return false;

        int amount = world.Get<OrePileComponent>(drop).Amount.Value;
        var parameters = new PickupOreEffect.Parameters { Amount = amount };
        Effects.Apply<PickupOreEffect, PickupOreEffect.Parameters>(picker, in parameters, drop);
        EffectSettlement.Settle(world);
        world.Commands.Destroy(drop);
        return true;
    }
}

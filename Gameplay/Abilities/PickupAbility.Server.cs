using System;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.Sample.Gameplay.Components.Ore;

namespace Lumio.Sample.Gameplay;

public sealed partial class PickupAbility
{
    /// <summary>
    /// Business phase: claim the pile, queue the Effect slip, queue the destroy. No ledger is
    /// written here — the Ore base account changes when phase 9 settles the slip (gas.md M3).
    /// </summary>
    static partial void ExecuteCore(in Input input, AbilityComponent owner)
    {
        if (!NetEntityId.TryParse(input.TargetHex, out NetEntityId dropId) || !IsLiveDrop(owner.World, dropId))
            throw new InvalidOperationException("PickupAbility.Execute requires a passed CanActivate.");
        if (!WithinReach(owner, dropId)) return;

        OrePileComponent pile = owner.Get<OrePileComponent>(dropId);
        var parameters = new PickupOreEffect.Parameters { Amount = pile.Amount.Value };
        // Claim now: the pile is empty for anyone else who reaches it this frame, so the same drop
        // can only be cashed once even though the entity stays live until the phase-9 commit.
        pile.Amount.Value = 0;
        Effects.Apply<PickupOreEffect, PickupOreEffect.Parameters>(owner.World, owner.Entity, in parameters, dropId);
        owner.World.Commands.Destroy(dropId);
    }
}

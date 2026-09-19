using System;
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Components.Vein;
using Lumio.Sample.Gameplay.Config;

namespace Lumio.Sample.Gameplay;

public sealed partial class MineAbility
{
    /// <summary>
    /// The hits that touch no terrain settle here, on the business phase (tick.md §3 rule 5):
    /// nothing has to succeed elsewhere for the stamina and the reserve to move. The final hit only
    /// orders the dig and records what settling it would owe; the stamina, the zeroed reserve and the
    /// drop order are written by <see cref="SampleMiningComponent"/> on the frame that order's result
    /// comes back, and not at all when it is refused. The phase-8 callback only observes.
    /// </summary>
    static partial void ExecuteCore(in Input input, AbilityComponent owner)
    {
        if (!NetEntityId.TryParse(input.TargetHex, out NetEntityId veinId))
            throw new InvalidOperationException("MineAbility.Execute requires a parsed target.");
        if (!AdmitTarget(owner, veinId))
            throw new InvalidOperationException("MineAbility.Execute requires a passed CanActivate.");

        VeinReserveComponent reserve = owner.Get<VeinReserveComponent>(veinId);
        if (!WithinReach(owner, veinId)) return;
        ISampleConfig config = SampleConfigBinding.For(owner.World);
        AttributeComponent attributes = owner.Get<AttributeComponent>();
        string stamina = config.Stamina.Name;
        long cost = config.Mining.StaminaCost;
        if (attributes.GetBaseValue(stamina) < cost) return;

        // The last hit digs the cell. Staging only places the order and the pending settlement; a
        // staging refusal means nothing was ordered and nothing is owed (the activation still
        // consumed its sequence). Everything the dig pays for waits for its terrain result.
        if (reserve.Remaining.Value <= 1)
        {
            if (!owner.World.Single<SampleMiningComponent>().StageFinal(owner, reserve)) return;
        }
        else
        {
            attributes.SetBaseValue(stamina, attributes.GetBaseValue(stamina) - cost);
            reserve.Remaining.Value -= 1;
        }
        owner.SetCooldown(TypeId, checked(owner.World.Tick + config.Mining.CooldownTicks));
    }

    static partial void CheckBinding(AbilityComponent owner, VeinReserveComponent reserve, ref bool bound) =>
        bound = owner.World.Single<SampleMiningComponent>().CanMine(owner, reserve);
}

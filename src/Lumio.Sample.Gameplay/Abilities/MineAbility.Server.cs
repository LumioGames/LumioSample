using System;
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Components.Ore;
using Lumio.Sample.Gameplay.Components.Vein;
using Lumio.Sample.Gameplay.Config;
using Lumio.Sample.Gameplay.EntityTypes;

namespace Lumio.Sample.Gameplay;

public sealed partial class MineAbility
{
    /// <summary>
    /// All six hits settle here, on the business phase (tick.md §3 rule 5). The final hit
    /// first stages its terrain order; once that order passes this phase's admission it is
    /// treated as "will be published", so stamina, reserve and the drop order are written
    /// right away instead of waiting for the phase-8 Native callback (that callback only observes).
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

        // The last hit digs the cell. Staging is the terrain admission; a refusal here means
        // nothing was written and nothing is settled (the activation still consumed its sequence).
        bool final = reserve.Remaining.Value <= 1;
        if (final && !owner.World.Single<SampleMiningComponent>().StageFinal(owner, reserve)) return;

        attributes.SetBaseValue(stamina, attributes.GetBaseValue(stamina) - cost);
        reserve.Remaining.Value = final ? 0 : reserve.Remaining.Value - 1;
        if (final)
        {
            // Structure order: the drop entity appears at phase 9, the same tick the cell turns to air at phase 8.
            EntityOrder drop = owner.World.Commands.Create<OreDropEntity>();
            drop.Get<OrePileComponent>().Amount.Value = config.Mining.OrePerVein;
            drop.Get<OrePileComponent>().SpawnPosition = reserve.CellCenter;
        }
        owner.SetCooldown(TypeId, checked(owner.World.Tick + config.Mining.CooldownTicks));
    }

    static partial void CheckBinding(AbilityComponent owner, VeinReserveComponent reserve, ref bool bound) =>
        bound = owner.World.Single<SampleMiningComponent>().CanMine(owner, reserve);
}

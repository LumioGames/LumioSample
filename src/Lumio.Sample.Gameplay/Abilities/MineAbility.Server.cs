using System;
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Components.Ore;
using Lumio.Sample.Gameplay.Components.Vein;
using Lumio.Sample.Gameplay.Config;
using Lumio.Sample.Gameplay.EntityTypes;

namespace Lumio.Sample.Gameplay;

public sealed partial class MineAbility
{
    static partial void ExecuteCore(in Input input, AbilityComponent owner)
    {
        if (!NetEntityId.TryParse(input.TargetHex, out NetEntityId veinId))
            throw new InvalidOperationException("MineAbility.Execute requires a parsed target.");
        if (!AdmitTarget(owner, veinId))
            throw new InvalidOperationException("MineAbility.Execute requires a passed CanActivate.");

        VeinReserveComponent reserve = owner.Get<VeinReserveComponent>(veinId);
        if (!WithinReach(owner, veinId)) return;
        if (reserve.Remaining.Value <= 1)
        {
            if (owner.World.Single<SampleMiningComponent>().StageFinal(owner, reserve))
                owner.SetCooldown(TypeId, checked(owner.World.Tick + SampleConfigBinding.For(owner.World).Mining.CooldownTicks));
            return;
        }
        AttributeComponent attributes = owner.Get<AttributeComponent>();
        string stamina = SampleConfigBinding.For(owner.World).Stamina.Name;
        long cost = SampleConfigBinding.For(owner.World).Mining.StaminaCost;
        if (attributes.GetBaseValue(stamina) < cost) return;
        attributes.SetBaseValue(stamina, attributes.GetBaseValue(stamina) - cost);
        reserve.Remaining.Value -= 1;
        owner.SetCooldown(TypeId, checked(owner.World.Tick + SampleConfigBinding.For(owner.World).Mining.CooldownTicks));
    }

    static partial void CheckBinding(AbilityComponent owner, VeinReserveComponent reserve, ref bool bound) =>
        bound = owner.World.Single<SampleMiningComponent>().CanMine(owner, reserve);
}

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
        owner.SetCooldown(TypeId, checked(owner.World.Tick + SampleConfigBinding.For(owner.World).Mining.CooldownTicks));
        bool exhausts = reserve.Remaining.Value <= 1;
        if (exhausts && !TryRequestAirWrite(veinId))
            return;

        AttributeComponent attributes = owner.Get<AttributeComponent>();
        long stamina = attributes.GetBaseValue(SampleConfigBinding.For(owner.World).Stamina.Name);
        // Deduct the table cost from Base. Current is recomputed from Base at settle; writing Current is wiped.
        attributes.SetBaseValue(SampleConfigBinding.For(owner.World).Stamina.Name, stamina - SampleConfigBinding.For(owner.World).Mining.StaminaCost);
        reserve.Remaining.Value -= 1;
        if (reserve.Remaining.Value > 0) return;

        EntityOrder drop = owner.World.Commands.Create<OreDropEntity>();
        drop.Get<OrePileComponent>().Amount.Value = SampleConfigBinding.For(owner.World).Mining.OrePerVein;
    }
}

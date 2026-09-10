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
        bool exhausts = reserve.Remaining.Value <= 1;
        if (exhausts && !TryRequestAirWrite(veinId))
            return;

        AttributeComponent attributes = owner.Get<AttributeComponent>();
        long stamina = attributes.GetBaseValue(SampleTables.StaminaAttributeName);
        // Deduct the table cost from Base. Current is recomputed from Base at settle; writing Current is wiped.
        attributes.SetBaseValue(SampleTables.StaminaAttributeName, stamina - SampleTables.StaminaCost);
        reserve.Remaining.Value -= 1;
        if (reserve.Remaining.Value > 0) return;

        EntityOrder drop = owner.World.Commands.Create<OreDropEntity>();
        drop.Get<OrePileComponent>().Amount.Value = SampleTables.OrePerVein;
    }
}

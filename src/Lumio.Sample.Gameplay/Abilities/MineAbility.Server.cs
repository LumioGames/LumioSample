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
        if (!NetEntityId.TryParse(input.TargetHex, out NetEntityId veinId)) return;

        AttributeComponent attributes = owner.Get<AttributeComponent>();
        long stamina = attributes.GetCurrentValue(SampleTables.StaminaAttributeName);
        if (stamina < SampleTables.StaminaCost) return;

        World world = owner.World;
        if (!world.IsLive(veinId)) return;

        VeinReserveComponent reserve = owner.Get<VeinReserveComponent>(veinId);
        if (reserve.Remaining.Value <= 0) return;

        attributes.SetCurrentValue(SampleTables.StaminaAttributeName, stamina - SampleTables.StaminaCost);
        reserve.Remaining.Value -= 1;

        if (reserve.Remaining.Value > 0) return;

        // R-00469: no public voxel batch-write ABI. Do not pretend the cell became air.
        _ = TryRequestAirWrite(veinId);
        EntityOrder drop = world.Commands.Create<OreDropEntity>();
        drop.Get<OrePileComponent>().Amount.Value = SampleTables.OrePerVein;
    }
}

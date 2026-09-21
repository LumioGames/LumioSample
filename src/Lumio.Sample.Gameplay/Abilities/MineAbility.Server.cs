using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Components.Vein;

namespace Lumio.Sample.Gameplay;

public sealed partial class MineAbility
{
    /// <summary>
    /// The authority order. Staging places the terrain order and the pending settlement; a staging
    /// refusal means nothing was ordered and nothing is owed. The stamina, the zeroed reserve and the
    /// drop order are written by <see cref="SampleMiningComponent"/> on the frame that order's result
    /// comes back, and not at all when it is refused. The phase-8 callback only observes.
    /// </summary>
    static partial void OrderFinalDig(AbilityComponent owner, VeinReserveComponent reserve, ref bool ordered) =>
        ordered = owner.World.Single<SampleMiningComponent>().StageFinal(owner, reserve);

    static partial void CheckBinding(AbilityComponent owner, VeinReserveComponent reserve, ref bool bound) =>
        bound = owner.World.Single<SampleMiningComponent>().CanMine(owner, reserve);
}

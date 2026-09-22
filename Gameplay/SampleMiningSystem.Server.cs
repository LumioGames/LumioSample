using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Primitives;

namespace Lumio.Sample.Gameplay;

[System(TickPhase.ProcessorPlan)]
public sealed class SampleMiningSystem : EcsSystem
{
    public override void Execute(World world) => world.Single<SampleMiningComponent>().Advance();
}

using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay.Components.Ore;

public sealed partial class OrePileComponent
{
    [Persist]
    public Sync<int> Amount = new(Scope.Room);
}

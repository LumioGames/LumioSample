using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay.Components.Ore;

public sealed partial class OrePileComponent
{
    /// <summary>Units of ore in this pile.</summary>
    [Persist]
    public Sync<int> Amount = new(Scope.Room);
}

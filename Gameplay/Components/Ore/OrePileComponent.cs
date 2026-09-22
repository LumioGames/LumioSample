using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay.Components.Ore;

/// <summary>How much ore a drop entity is holding. Shared so both compile sides see Amount.</summary>
[EcsComponent]
public sealed partial class OrePileComponent : Component
{
    /// <summary>Units of ore in this pile.</summary>
    [Persist]
    public Sync<int> Amount = new(Scope.Room);
}

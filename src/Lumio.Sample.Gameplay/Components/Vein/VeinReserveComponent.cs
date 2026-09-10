using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay.Components.Vein;

/// <summary>Remaining hits on a vein entity. Shared so both compile sides see Remaining.</summary>
[EcsComponent]
public sealed partial class VeinReserveComponent : Component
{
    // 储量只活在实体上。体素格子不得再存一份剩余次数。
    /// <summary>Hits left before the vein is exhausted.</summary>
    [Persist]
    public Sync<int> Remaining = new(Scope.Room);
}

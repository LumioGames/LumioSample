using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay.Components.Vein;

public sealed partial class VeinReserveComponent
{
    // 储量只活在实体上。体素格子不得再存一份剩余次数。
    [Persist]
    public Sync<int> Remaining = new(Scope.Room);
}

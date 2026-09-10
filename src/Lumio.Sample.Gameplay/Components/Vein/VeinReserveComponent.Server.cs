using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Config;

namespace Lumio.Sample.Gameplay.Components.Vein;

public sealed partial class VeinReserveComponent
{
    // 储量只活在实体上。体素格子不得再存一份剩余次数。
    /// <summary>Hits left before the vein is exhausted.</summary>
    [Persist]
    public Sync<int> Remaining = new(Scope.Room);

    /// <summary>First appearance takes remaining from the mining table. RestorePersist still wins after this.</summary>
    partial void PostAttribute()
    {
        Remaining.Value = SampleTables.VeinHitsToBreak;
    }
}

using Lumio.Sample.Gameplay.Config;

namespace Lumio.Sample.Gameplay.Components.Vein;

public sealed partial class VeinReserveComponent
{
    /// <summary>First appearance takes remaining from the mining table. RestorePersist still wins after this.</summary>
    partial void PostAttribute()
    {
        Remaining.Value = SampleTables.VeinHitsToBreak;
    }
}

using System.Collections.Generic;

namespace Lumio.Sample.Gameplay.Config;

/// <summary>One map row on the client end; <c>spawn_*</c> is server-only (visibility S), so this Reader has no such columns.</summary>
internal static class SampleMapRows
{
    internal static MapRow Read(Dictionary<string, string> cells) =>
        new(SampleTypedTables.UInt(cells, "id"), SampleTypedTables.Text(cells, "name"), SampleTypedTables.Int(cells, "width"),
            SampleTypedTables.Int(cells, "depth"), SampleTypedTables.Double(cells, "vein_ratio"), SampleTypedTables.UInt(cells, "ore_block_type"));
}

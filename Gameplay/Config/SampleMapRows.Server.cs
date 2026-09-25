using System.Collections.Generic;

namespace Lumio.Sample.Gameplay.Config;

/// <summary>One map row on the server end, with the server-only admission pose (<c>spawn_*</c>, B-00121).</summary>
internal static class SampleMapRows
{
    internal static MapRow Read(Dictionary<string, string> cells) =>
        new(SampleTypedTables.UInt(cells, "id"), SampleTypedTables.Text(cells, "name"), SampleTypedTables.Int(cells, "width"),
            SampleTypedTables.Int(cells, "depth"), SampleTypedTables.Double(cells, "vein_ratio"), SampleTypedTables.UInt(cells, "ore_block_type"),
            SampleTypedTables.Double(cells, "spawn_x"), SampleTypedTables.Double(cells, "spawn_y"), SampleTypedTables.Double(cells, "spawn_z"));
}

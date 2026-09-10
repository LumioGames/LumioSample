using System;
using System.Collections.Generic;
using System.Globalization;
using Lumio.Config.Generated.Server;
using Lumio.GameRuntime.Config;

namespace Lumio.Sample.Gameplay.Config;

/// <summary>
/// M9 typed-table factory. Builds Config generated Readers from the snapshot M9 already parsed.
/// Gameplay never opens the JSON files itself.
/// </summary>
public sealed class SampleTypedTables : ITypedTableSet
{
    /// <summary>Binds the three gameplay tables Sample reads at runtime.</summary>
    public SampleTypedTables(MiningTable mining, MovementTable movement, AttributesTable attributes)
    {
        Mining = mining;
        Movement = movement;
        Attributes = attributes;
    }

    /// <summary>Mining typed Reader.</summary>
    public MiningTable Mining { get; }

    /// <summary>Movement typed Reader.</summary>
    public MovementTable Movement { get; }

    /// <summary>Attributes typed Reader.</summary>
    public AttributesTable Attributes { get; }

    /// <inheritdoc />
    public bool TryGetTable<TTable>(out TTable table)
    {
        if (typeof(TTable) == typeof(MiningTable))
        {
            table = (TTable)(object)Mining;
            return true;
        }

        if (typeof(TTable) == typeof(MovementTable))
        {
            table = (TTable)(object)Movement;
            return true;
        }

        if (typeof(TTable) == typeof(AttributesTable))
        {
            table = (TTable)(object)Attributes;
            return true;
        }

        table = default!;
        return false;
    }

    /// <summary>M9 <c>typedTableFactory</c> entry. Snapshot cells are already typed; this only constructs Readers.</summary>
    public static ITypedTableSet Create(ConfigTarget target, IReadOnlyList<ConfigSnapshotTable> tables)
    {
        _ = target;
        var mining = new List<MiningRow>();
        var movement = new List<MovementRow>();
        var attributes = new List<AttributesRow>();

        foreach (ConfigSnapshotTable tbl in tables)
        {
            foreach (ConfigSnapshotRow row in tbl.Rows)
            {
                Dictionary<string, string> cells = Cells(row);
                if (string.Equals(tbl.TableId, "mining", StringComparison.OrdinalIgnoreCase))
                    mining.Add(new MiningRow(UInt(cells, "id"), Text(cells, "name"), Long(cells, "stamina_cost"), Int(cells, "vein_hits_to_break"), Int(cells, "ore_per_vein")));
                else if (string.Equals(tbl.TableId, "movement", StringComparison.OrdinalIgnoreCase))
                    movement.Add(new MovementRow(UInt(cells, "id"), Text(cells, "name"), Double(cells, "step_meters"), Double(cells, "sweep_radius_meters")));
                else if (string.Equals(tbl.TableId, "attributes", StringComparison.OrdinalIgnoreCase))
                    attributes.Add(new AttributesRow(UInt(cells, "id"), Text(cells, "name"), Long(cells, "initial")));
            }
        }

        return new SampleTypedTables(
            new MiningTable(mining),
            new MovementTable(movement),
            new AttributesTable(attributes));
    }

    private static Dictionary<string, string> Cells(ConfigSnapshotRow row)
    {
        var cells = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (ConfigSnapshotCell cell in row.Cells)
            cells[cell.Column] = cell.CanonicalText;
        return cells;
    }

    private static string Text(Dictionary<string, string> cells, string column) =>
        cells.TryGetValue(column, out string? value) ? value : string.Empty;

    private static uint UInt(Dictionary<string, string> cells, string column) =>
        uint.TryParse(Text(cells, column), NumberStyles.Integer, CultureInfo.InvariantCulture, out uint value) ? value : 0u;

    private static int Int(Dictionary<string, string> cells, string column) =>
        int.TryParse(Text(cells, column), NumberStyles.Integer, CultureInfo.InvariantCulture, out int value) ? value : 0;

    private static long Long(Dictionary<string, string> cells, string column) =>
        long.TryParse(Text(cells, column), NumberStyles.Integer, CultureInfo.InvariantCulture, out long value) ? value : 0L;

    private static double Double(Dictionary<string, string> cells, string column) =>
        double.TryParse(Text(cells, column), NumberStyles.Float, CultureInfo.InvariantCulture, out double value) ? value : 0d;
}

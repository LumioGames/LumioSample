using System;
using System.Collections.Generic;
using System.IO;
using Lumio.Config.Generated.Server;
using Lumio.GameRuntime.Config;

namespace Lumio.Sample.Gameplay.Config;

/// <summary>
/// Gameplay numbers from the LumioConfig export in <c>config/</c>.
/// M9 (<see cref="LumioConfigLoader"/>) parses JSON once; this type only queries typed Readers.
/// </summary>
public static class SampleTables
{
    /// <summary>Environment variable that points at a LumioConfig export root (must contain manifest.json).</summary>
    public const string ConfigDirVariable = "LUMIO_CONFIG_DIR";

    private static readonly object Gate = new();
    private static readonly string[] RequiredTables = { "mining", "movement", "attributes" };
    private static SampleTypedTables? Tables;

    /// <summary>Meters per move step. From movement table.</summary>
    public static double StepMeters => MovementRow().StepMeters;

    /// <summary>Sweep capsule radius. From movement table.</summary>
    public static double SweepRadiusMeters => MovementRow().SweepRadiusMeters;

    /// <summary>Stamina spent per mine hit. From mining table.</summary>
    public static long StaminaCost => MiningRow().StaminaCost;

    /// <summary>Hits that exhaust a vein. From mining table.</summary>
    public static int VeinHitsToBreak => MiningRow().VeinHitsToBreak;

    /// <summary>Ore dropped when a vein is exhausted. From mining table.</summary>
    public static int OrePerVein => MiningRow().OrePerVein;

    /// <summary>Starting stamina. From attributes table.</summary>
    public static long StaminaInitial => AttributeRow("Stamina").Initial;

    /// <summary>Starting ore. From attributes table.</summary>
    public static long OreInitial => AttributeRow("Ore").Initial;

    /// <summary>Attribute ledger name for stamina.</summary>
    public static string StaminaAttributeName => AttributeRow("Stamina").Name;

    /// <summary>Attribute ledger name for ore.</summary>
    public static string OreAttributeName => AttributeRow("Ore").Name;

    /// <summary>Drops the cached tables so a test can point at another directory or inject rows.</summary>
    public static void ResetCache()
    {
        lock (Gate)
        {
            Tables = null;
        }
    }

    /// <summary>Test hook: install already-constructed Readers. Does not read disk.</summary>
    public static void Use(MiningTable mining, MovementTable movement, AttributesTable attributes)
    {
        lock (Gate)
        {
            Tables = new SampleTypedTables(mining, movement, attributes);
        }
    }

    /// <summary>Test hook: keep loaded movement/attributes, replace mining numbers.</summary>
    public static void OverrideMining(long staminaCost, int hits)
    {
        SampleTypedTables loaded = Load();
        MiningRow row = MiningRow();
        Use(
            new MiningTable(new[] { new MiningRow(row.Id, row.Name, staminaCost, hits, row.OrePerVein) }),
            loaded.Movement,
            loaded.Attributes);
    }

    /// <summary>Test hook: keep loaded movement/attributes, replace vein hits.</summary>
    public static void OverrideMiningHits(int hits)
    {
        MiningRow row = MiningRow();
        OverrideMining(row.StaminaCost, hits);
    }

    /// <summary>
    /// Resolves a LumioConfig export directory. Override and <see cref="ConfigDirVariable"/> win.
    /// The assembly output <c>config/manifest.json</c> is the only fallback — parent directories are not scanned.
    /// </summary>
    public static string ResolveDirectory(string? overrideDirectory = null, IReadOnlyDictionary<string, string?>? environment = null)
    {
        if (!string.IsNullOrWhiteSpace(overrideDirectory))
            return Path.GetFullPath(overrideDirectory);

        string? fromEnv = ReadEnv(environment, ConfigDirVariable);
        if (!string.IsNullOrWhiteSpace(fromEnv))
            return Path.GetFullPath(fromEnv);

        string nextToAssembly = Path.Combine(AppContext.BaseDirectory, "config");
        if (File.Exists(Path.Combine(nextToAssembly, "manifest.json")))
            return Path.GetFullPath(nextToAssembly);

        throw new InvalidOperationException(
            "Sample config export was not found. Set " + ConfigDirVariable + " to a LumioConfig export root that contains manifest.json.");
    }

    private static string? ReadEnv(IReadOnlyDictionary<string, string?>? environment, string name)
    {
        if (environment is not null && environment.TryGetValue(name, out string? value))
            return value;
        return Environment.GetEnvironmentVariable(name);
    }

    private static SampleTypedTables Load()
    {
        lock (Gate)
        {
            if (Tables is not null)
                return Tables;

            string directory = ResolveDirectory();
            LumioConfigLoadResult result = LumioConfigLoader.Load(
                directory,
                ConfigTarget.Server,
                requiredTables: RequiredTables,
                typedTableFactory: SampleTypedTables.Create);
            if (!result.IsSuccess || result.TypedTables is not SampleTypedTables typed)
            {
                throw new InvalidOperationException(
                    "LumioConfig M9 load failed: " + (result.ErrorCode ?? "unknown") + " " + (result.ErrorMessage ?? directory));
            }

            Tables = typed;
            return typed;
        }
    }

    private static MiningRow MiningRow()
    {
        IReadOnlyList<MiningRow> rows = Load().Mining.Rows;
        if (rows.Count == 0)
            throw new InvalidOperationException("mining table has no rows.");
        return rows[0];
    }

    private static MovementRow MovementRow()
    {
        IReadOnlyList<MovementRow> rows = Load().Movement.Rows;
        if (rows.Count == 0)
            throw new InvalidOperationException("movement table has no rows.");
        return rows[0];
    }

    private static AttributesRow AttributeRow(string name)
    {
        foreach (AttributesRow row in Load().Attributes.Rows)
        {
            if (string.Equals(row.Name, name, StringComparison.Ordinal))
                return row;
        }

        throw new InvalidOperationException("attributes table has no row named '" + name + "'.");
    }
}

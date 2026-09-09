using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.Json;

namespace Lumio.Sample.Gameplay.Config;

/// <summary>
/// Reads gameplay numbers from JSON files. Typed LumioConfig M8/M9 is not wired yet;
/// this is a file reader, not a second engine schema.
/// </summary>
public static class SampleTables
{
    public const string ConfigDirVariable = "LUMIO_CONFIG_DIR";

    private static readonly object Gate = new();
    private static string? LoadedDirectory;
    private static Dictionary<string, JsonElement>? Tables;

    public static double StepMeters => ReadNumber("movement", "step_meters");

    public static double SweepRadiusMeters => ReadNumber("movement", "sweep_radius_meters");

    public static long StaminaCost => ReadInt64("mining", "stamina_cost");

    public static int VeinHitsToBreak => ReadInt32("mining", "vein_hits_to_break");

    public static int OrePerVein => ReadInt32("mining", "ore_per_vein");

    public static long StaminaInitial => ReadInt64("attributes", "stamina_initial");

    public static long OreInitial => ReadInt64("attributes", "ore_initial");

    public static string StaminaAttributeName => ReadString("attributes", "stamina_name");

    public static string OreAttributeName => ReadString("attributes", "ore_name");

    public static void ResetCache()
    {
        lock (Gate)
        {
            LoadedDirectory = null;
            Tables = null;
        }
    }

    public static string ResolveDirectory(string? overrideDirectory = null, IReadOnlyDictionary<string, string?>? environment = null)
    {
        if (!string.IsNullOrWhiteSpace(overrideDirectory))
            return Path.GetFullPath(overrideDirectory);

        string? fromEnv = ReadEnv(environment, ConfigDirVariable);
        if (!string.IsNullOrWhiteSpace(fromEnv))
            return Path.GetFullPath(fromEnv);

        foreach (string start in new[] { AppContext.BaseDirectory, AppDomain.CurrentDomain.BaseDirectory })
        {
            string? found = WalkForConfig(start);
            if (found is not null) return found;
        }

        throw new InvalidOperationException(
            "Sample config directory was not found. Set " + ConfigDirVariable + " or keep config/movement.json next to the assembly.");
    }

    private static string? WalkForConfig(string start)
    {
        DirectoryInfo? current = new(start);
        while (current is not null)
        {
            string candidate = Path.Combine(current.FullName, "config");
            if (File.Exists(Path.Combine(candidate, "movement.json")))
                return Path.GetFullPath(candidate);
            current = current.Parent;
        }

        return null;
    }

    private static string? ReadEnv(IReadOnlyDictionary<string, string?>? environment, string name)
    {
        if (environment is not null && environment.TryGetValue(name, out string? value))
            return value;
        return Environment.GetEnvironmentVariable(name);
    }

    private static JsonElement Table(string fileStem)
    {
        Dictionary<string, JsonElement> tables = Load();
        if (!tables.TryGetValue(fileStem, out JsonElement table))
            throw new InvalidOperationException("Missing config table '" + fileStem + "'.");
        return table;
    }

    private static Dictionary<string, JsonElement> Load()
    {
        lock (Gate)
        {
            string directory = ResolveDirectory();
            if (Tables is not null && string.Equals(LoadedDirectory, directory, StringComparison.Ordinal))
                return Tables;

            var loaded = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
            foreach (string path in Directory.GetFiles(directory, "*.json"))
            {
                using JsonDocument document = JsonDocument.Parse(File.ReadAllText(path));
                loaded[Path.GetFileNameWithoutExtension(path)] = document.RootElement.Clone();
            }

            LoadedDirectory = directory;
            Tables = loaded;
            return loaded;
        }
    }

    private static string ReadString(string fileStem, string key)
    {
        if (!Table(fileStem).TryGetProperty(key, out JsonElement value) || value.ValueKind != JsonValueKind.String)
            throw new InvalidOperationException("Config " + fileStem + "." + key + " must be a string.");
        string text = value.GetString() ?? string.Empty;
        if (text.Length == 0)
            throw new InvalidOperationException("Config " + fileStem + "." + key + " must not be empty.");
        return text;
    }

    private static double ReadNumber(string fileStem, string key)
    {
        if (!Table(fileStem).TryGetProperty(key, out JsonElement value) || value.ValueKind != JsonValueKind.Number)
            throw new InvalidOperationException("Config " + fileStem + "." + key + " must be a number.");
        return value.GetDouble();
    }

    private static int ReadInt32(string fileStem, string key)
    {
        double number = ReadNumber(fileStem, key);
        if (Math.Abs(number - Math.Round(number)) > double.Epsilon)
            throw new InvalidOperationException("Config " + fileStem + "." + key + " must be an integer.");
        return Convert.ToInt32(number, CultureInfo.InvariantCulture);
    }

    private static long ReadInt64(string fileStem, string key)
    {
        double number = ReadNumber(fileStem, key);
        if (Math.Abs(number - Math.Round(number)) > double.Epsilon)
            throw new InvalidOperationException("Config " + fileStem + "." + key + " must be an integer.");
        return Convert.ToInt64(number, CultureInfo.InvariantCulture);
    }
}

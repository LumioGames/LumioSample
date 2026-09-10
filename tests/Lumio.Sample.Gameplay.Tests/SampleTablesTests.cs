using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;
using Lumio.Sample.Gameplay.Config;
using Xunit;

namespace Lumio.Sample.Gameplay.Tests;

public sealed class SampleTablesTests
{
    private static string RepoRoot =>
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));

    [Fact]
    public void TablesReadNumbersFromTheRepoConfigDirectory()
    {
        SampleTables.ResetCache();
        string directory = SampleTables.ResolveDirectory(Path.Combine(RepoRoot, "config"));
        Assert.Equal(Path.GetFullPath(Path.Combine(RepoRoot, "config")), directory);

        Environment.SetEnvironmentVariable(SampleTables.ConfigDirVariable, directory);
        try
        {
            SampleTables.ResetCache();
            Assert.Equal(ReadDouble("movement", "step_meters"), SampleTables.StepMeters);
            Assert.Equal(ReadInt("mining", "stamina_cost"), SampleTables.StaminaCost);
            Assert.Equal(ReadString("attributes", "name", "Stamina"), SampleTables.StaminaAttributeName);
        }
        finally
        {
            Environment.SetEnvironmentVariable(SampleTables.ConfigDirVariable, null);
            SampleTables.ResetCache();
        }
    }

    [Fact]
    public void ParentDirectoryTablesAreNotScanned()
    {
        string source = File.ReadAllText(Path.Combine(RepoRoot, "src", "Lumio.Sample.Gameplay", "Config", "SampleTables.cs"));
        Assert.DoesNotContain("WalkForConfig", source);
        Assert.DoesNotContain("JsonDocument", source);

        string isolated = Path.Combine(Path.GetTempPath(), "lumio-sample-parent-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(isolated);
        File.WriteAllText(Path.Combine(isolated, "movement.json"), "{\"step_meters\":99}");
        File.WriteAllText(Path.Combine(isolated, "mining.json"), "{\"stamina_cost\":1}");
        File.WriteAllText(Path.Combine(isolated, "attributes.json"), "{\"stamina_name\":\"Fake\",\"stamina_initial\":1}");

        Environment.SetEnvironmentVariable(SampleTables.ConfigDirVariable, isolated);
        try
        {
            SampleTables.ResetCache();
            Assert.Throws<InvalidOperationException>(() => _ = SampleTables.StepMeters);
        }
        finally
        {
            Environment.SetEnvironmentVariable(SampleTables.ConfigDirVariable, Path.Combine(RepoRoot, "config"));
            SampleTables.ResetCache();
            Directory.Delete(isolated, recursive: true);
        }
    }

    [Fact]
    public void HandwrittenSourceDoesNotEmbedConfigNumbers()
    {
        var banned = new HashSet<string>(System.StringComparer.Ordinal)
        {
            ReadRaw("movement", "step_meters"),
            ReadRaw("movement", "sweep_radius_meters"),
            ReadRaw("mining", "stamina_cost"),
            ReadRaw("mining", "vein_hits_to_break"),
            ReadRaw("mining", "ore_per_vein"),
            ReadRawNamed("attributes", "Stamina", "initial"),
            ReadRawNamed("attributes", "Ore", "initial"),
        };

        string gameplay = Path.Combine(RepoRoot, "src", "Lumio.Sample.Gameplay");
        foreach (string file in Directory.GetFiles(gameplay, "*.cs", SearchOption.AllDirectories))
        {
            if (file.Contains($"{Path.DirectorySeparatorChar}generated{Path.DirectorySeparatorChar}", StringComparison.Ordinal))
                continue;
            string text = File.ReadAllText(file);
            foreach (string token in banned)
            {
                string pattern = @"(?<![A-Za-z0-9.])" + Regex.Escape(token) + @"(?![A-Za-z0-9.])";
                Assert.False(Regex.IsMatch(text, pattern), file + " embeds config token " + token);
            }
        }
    }

    private static string ConfigPath(string stem) => Path.Combine(RepoRoot, "config", "server", stem + ".json");

    private static JsonElement Root(string stem) => JsonDocument.Parse(File.ReadAllText(ConfigPath(stem))).RootElement.Clone();

    private static JsonElement FirstRow(string stem) => Root(stem).GetProperty("rows")[0];

    private static string ReadRaw(string stem, string key) => FirstRow(stem).GetProperty(key).GetRawText();

    private static double ReadDouble(string stem, string key) =>
        double.Parse(ReadRaw(stem, key), CultureInfo.InvariantCulture);

    private static long ReadInt(string stem, string key) =>
        long.Parse(ReadRaw(stem, key), CultureInfo.InvariantCulture);

    private static string ReadString(string stem, string key, string? name = null)
    {
        if (name is null) return FirstRow(stem).GetProperty(key).GetString()!;
        foreach (JsonElement row in Root(stem).GetProperty("rows").EnumerateArray())
        {
            if (string.Equals(row.GetProperty("name").GetString(), name, StringComparison.Ordinal))
                return row.GetProperty(key).GetString()!;
        }

        throw new InvalidOperationException(stem + " has no row " + name);
    }

    private static string ReadRawNamed(string stem, string name, string key)
    {
        foreach (JsonElement row in Root(stem).GetProperty("rows").EnumerateArray())
        {
            if (string.Equals(row.GetProperty("name").GetString(), name, StringComparison.Ordinal))
                return row.GetProperty(key).GetRawText();
        }

        throw new InvalidOperationException(stem + " has no row " + name);
    }
}

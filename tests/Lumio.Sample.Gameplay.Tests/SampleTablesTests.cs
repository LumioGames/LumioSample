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
            Assert.Equal(ReadString("attributes", "stamina_name"), SampleTables.StaminaAttributeName);
        }
        finally
        {
            Environment.SetEnvironmentVariable(SampleTables.ConfigDirVariable, null);
            SampleTables.ResetCache();
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
            ReadRaw("attributes", "stamina_initial"),
            ReadRaw("attributes", "ore_initial"),
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

    private static string ConfigPath(string stem) => Path.Combine(RepoRoot, "config", stem + ".json");

    private static JsonElement Root(string stem) => JsonDocument.Parse(File.ReadAllText(ConfigPath(stem))).RootElement.Clone();

    private static string ReadRaw(string stem, string key) => Root(stem).GetProperty(key).GetRawText();

    private static double ReadDouble(string stem, string key) =>
        double.Parse(ReadRaw(stem, key), CultureInfo.InvariantCulture);

    private static long ReadInt(string stem, string key) =>
        long.Parse(ReadRaw(stem, key), CultureInfo.InvariantCulture);

    private static string ReadString(string stem, string key) => Root(stem).GetProperty(key).GetString()!;
}

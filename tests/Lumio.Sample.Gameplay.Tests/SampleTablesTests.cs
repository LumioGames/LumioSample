using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Config;
using Xunit;

namespace Lumio.Sample.Gameplay.Tests;

[Collection("SampleWorld")]
public sealed class SampleTablesTests
{
    private static readonly string[] ExcludedDirectories = { "generated", "obj", "bin" };
    private static readonly string[] CommentDelimiters = { "//" };
    private static string RepoRoot =>
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));

    [Fact]
    public void TablesReadNumbersFromTheRepoConfigDirectory()
    {
        string directory = SampleTables.ResolveDirectory(Path.Combine(RepoRoot, "config"));
        Assert.Equal(Path.GetFullPath(Path.Combine(RepoRoot, "config")), directory);

        using var manager = WorldManager.Create(GeneratedRegistry.Instance, 1, config: SampleConfigBinding.Load(directory));
        var config = Assert.IsAssignableFrom<ISampleConfig>(manager.World.GameplayConfig);
        Assert.Equal(ReadDouble("movement", "step_meters"), config.Movement.StepMeters);
        Assert.Equal(ReadInt("mining", "stamina_cost"), config.Mining.StaminaCost);
        Assert.Equal(ReadInt("mining", "vein_hits_to_break"), config.Mining.VeinHitsToBreak);
        Assert.Equal(ReadInt("mining", "ore_per_vein"), config.Mining.OrePerVein);
        Assert.Equal(ReadInt("mining", "cooldown_ticks"), (long)config.Mining.CooldownTicks);
        Assert.Equal(ReadInt("map", "width"), config.Map.Width);
        Assert.Equal(ReadInt("map", "depth"), config.Map.Depth);
        Assert.Equal(ReadDouble("map", "vein_ratio"), config.Map.VeinRatio);
        Assert.Equal(ReadString("attributes", "name", "Stamina"), config.Stamina.Name);
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

        try
        {
            Assert.Throws<InvalidOperationException>(() => SampleConfigBinding.Load(isolated));
        }
        finally
        {
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
            ReadRaw("mining", "cooldown_ticks"),
            ReadRaw("map", "width"),
            ReadRaw("map", "depth"),
            ReadRaw("map", "vein_ratio"),
            ReadRawNamed("attributes", "Stamina", "initial"),
            ReadRawNamed("attributes", "Ore", "initial"),
        };

        string gameplay = Path.Combine(RepoRoot, "src", "Lumio.Sample.Gameplay");
        foreach (string file in Directory.GetFiles(gameplay, "*.cs", SearchOption.AllDirectories))
        {
            if (Array.Exists(ExcludedDirectories, directory =>
                file.Contains($"{Path.DirectorySeparatorChar}{directory}{Path.DirectorySeparatorChar}", StringComparison.Ordinal)))
                continue;
            foreach (string line in File.ReadLines(file))
            {
                string code = line.Split(CommentDelimiters, 2, StringSplitOptions.None)[0].Trim();
                foreach (string token in banned)
                {
                    string pattern = @"(?<![A-Za-z0-9_.])" + Regex.Escape(token) + @"[uUlLfFdDmM]?(?![A-Za-z0-9_.])";
                    if (!Regex.IsMatch(code, pattern)) continue;
                    string path = Path.GetRelativePath(gameplay, file).Replace('\\', '/');
                    Assert.True(IsWireEncoding(path, code) || token == "1" && IsNonConfigOne(path, code),
                        file + " embeds config token " + token + ": " + code);
                }
            }
        }
    }

    // Fixed voxel wire coordinates are not gameplay configuration defaults.
    private static bool IsWireEncoding(string path, string code) =>
        path == "SampleMiningComponent.Server.cs" && code == "ulong section = ((ulong)(x >> 4) << 36) | (uint)(z >> 4);";

    private static bool IsNonConfigOne(string path, string code) => (path, code) switch
    {
        // Input normalization and argument indexing are not a cooldown default.
        ("Abilities/MoveAbility.cs", "[AbilityType(1u, Prediction = PredictionKind.LogicPredict)]") => true,
        ("Abilities/MoveAbility.cs", "public const uint TypeId = 1u;") => true,
        ("Abilities/MoveAbility.cs", "public const int MaxAbsStep = 1;") => true,
        ("Abilities/MoveAbility.cs", "if (args is null || start < 0 || start + 1 >= args.Count) return false;") => true,
        ("Abilities/MoveAbility.cs", "if (!int.TryParse(args[start + 1]?.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out int dz))") => true,
        // A sweep fraction is normalized to the unit interval.
        ("Abilities/MoveAbility.cs", "if (!float.IsFinite(travelFraction) || travelFraction < 0f || travelFraction > 1f) return false;") => true,
        ("Abilities/MoveAbility.cs", "if (!float.IsFinite(hit.TravelFraction) || hit.TravelFraction < 0f || hit.TravelFraction > 1f") => true,
        ("Abilities/MoveAbility.cs", "|| (!hit.Collided && hit.TravelFraction != 1f) || !IsFinite(hit.Point))") => true,
        // A player owns one unsettled dig at a time (R-00650); that ceiling is a rule, not tuning.
        ("Components/Mining/PendingDigComponent.cs", "public const int MaxPerPlayer = 1;") => true,
        // One activation consumes one hit; the initial reserve comes from config.
        ("Abilities/MineAbility.Server.cs", "if (reserve.Remaining.Value <= 1)") => true,
        ("Abilities/MineAbility.Server.cs", "reserve.Remaining.Value -= 1;") => true,
        // Snapshot identity belongs to the loader lifecycle, not gameplay tuning.
        ("Config/SampleConfigBinding.cs", "if (!module.Stage(result.CreateSnapshot(new ConfigSnapshotId(1))).Staged || !module.ActivateAtBarrier(default).Activated)") => true,
        _ => false,
    };

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

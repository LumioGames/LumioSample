using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Xunit;

namespace Lumio.Sample.Gameplay.Tests;

public sealed class SourceHygieneTests
{
    private static string GameplayRoot =>
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "Gameplay"));

    [Fact]
    public void SetLocalPositionIsOnlyCalledFromMoveAbility()
    {
        var hits = new List<string>();
        foreach (string file in Directory.GetFiles(GameplayRoot, "*.cs", SearchOption.AllDirectories))
        {
            if (file.Contains($"{Path.DirectorySeparatorChar}generated{Path.DirectorySeparatorChar}", System.StringComparison.Ordinal))
                continue;
            if (Path.GetFileName(file) == "MoveAbility.cs") continue;
            if (Path.GetFileName(file) == "SampleGameplay.cs") continue;
            if (Regex.IsMatch(File.ReadAllText(file), @"SetLocalPosition|SetWorldPosition|Translate\("))
                hits.Add(file);
        }

        Assert.Empty(hits);
    }

    [Fact]
    public void MiningCallbackOnlyObservesAndPickupIsAnAbility()
    {
        // tick.md §3 rule 5: the phase-8 DigApplied callback may log and assert, never write business
        // state. The settlement itself lives elsewhere in the same file — in the phase-4 Settle window
        // — so this guard reads the callback body alone instead of the whole file (R-00647).
        string source = File.ReadAllText(Path.Combine(GameplayRoot, "SampleMiningComponent.Server.cs"));
        string callback = MethodBody(source, "private void OnApplied(VoxelDigApplied applied)");
        Assert.DoesNotContain("SetBaseValue", callback);
        // Assignment only; the callback may still compare the reserve to assert the invariant.
        Assert.DoesNotMatch(new Regex(@"Remaining\.Value\s*=(?!=)"), callback);
        Assert.DoesNotContain("Commands.Create", callback);
        // It must also leave the pending record alone, or the settlement loses what it waits for.
        // Take and Clear are the only two ways to free a slot, so neither may appear here (R-00650).
        Assert.DoesNotContain("Take(", callback);
        Assert.DoesNotContain("Clear(", callback);
        Assert.DoesNotMatch(new Regex(@"Active\.Value\s*=(?!=)"), callback);
        // The settlement reads the terrain result back rather than settling when the order is placed.
        Assert.Contains("DrainResults()", source);
        // Pickup goes through GAS admission; the static helper with its inline settlement is gone.
        Assert.False(File.Exists(Path.Combine(GameplayRoot, "SampleOrePickup.cs")));
        Assert.True(File.Exists(Path.Combine(GameplayRoot, "Abilities", "PickupAbility.cs")));
        Assert.DoesNotContain("EffectSettlement.Settle", File.ReadAllText(Path.Combine(GameplayRoot, "Abilities", "PickupAbility.Server.cs")));
    }

    [Fact]
    public void PendingDigIsPersistedEntityStateAndNotAProcessDictionary()
    {
        // R-00650: a settlement that waits for the next frame can be snapshotted mid-wait, so the
        // record has to ride the entity snapshot instead of living in a field of this process.
        string mining = File.ReadAllText(Path.Combine(GameplayRoot, "SampleMiningComponent.Server.cs"));
        Assert.DoesNotContain("Dictionary<string, PendingDig>", mining);
        string path = Path.Combine(GameplayRoot, "Components", "Mining", "PendingDigComponent.cs");
        Assert.True(File.Exists(path), "The pending record must be a component on an entity: " + path);
        string component = File.ReadAllText(path);
        int fields = Regex.Count(component, @"public\s+Sync<");
        Assert.True(fields > 0, "PendingDigComponent declares no state.");
        // Every field of the record is snapshot state; an unmarked one would silently vanish on restore.
        Assert.Equal(fields, Regex.Count(component, @"\[Persist\]\s*public\s+Sync<"));
        // The player is the miner that owes the settlement, so the record rides that entity's snapshot.
        Assert.Contains("[Has(typeof(PendingDigComponent))]",
            File.ReadAllText(Path.Combine(GameplayRoot, "EntityTypes", "PlayerEntity.cs")));
    }

    /// <summary>Text of one method body, matched by its exact signature line and brace depth.</summary>
    private static string MethodBody(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, "Signature not found, so the guard would silently pass: " + signature);
        int open = source.IndexOf('{', start + signature.Length);
        Assert.True(open >= 0, "No body follows " + signature);
        int depth = 0;
        for (int index = open; index < source.Length; index++)
        {
            if (source[index] == '{') depth++;
            else if (source[index] == '}' && --depth == 0) return source[open..(index + 1)];
        }

        throw new InvalidOperationException("Unbalanced braces after " + signature);
    }

    [Fact]
    public void ServerJsonUsesRelativeAssemblyPaths()
    {
        string text = File.ReadAllText(Path.Combine(GameplayRoot, "..", "Server", "Config", "Startup", "server.json"));
        Assert.Contains("../../../Gameplay/bin/Debug/net10.0/Lumio.Sample.Gameplay.dll", text);
        Assert.DoesNotContain("/Users/", text);
        Assert.DoesNotContain("LumioGameEngine/", text);
        Assert.Contains("\"world_profile\": \"runtime+voxel\"", text);
        Assert.Contains("\"voxel_catalog\": \"../../Assets/Maps/official-catalog.json\"", text);
        Assert.Contains("\"durability\": \"snapshot_only\"", text);
        Assert.DoesNotContain("process-crash", text);
        Assert.DoesNotContain("power-loss", text);
        Assert.Contains("\"base_map_id\": \"sample\"", text);
        Assert.Contains("\"base_map_version\": \"0.1.0\"", text);
        Assert.Contains("\"base_map_path\": \"../../Assets/Maps/sample.voxel\"", text);
        Assert.DoesNotContain("0.1.0-placeholder", text);
        Assert.Matches(new Regex("\"base_map_content_sha256\": \"[0-9a-f]{64}\""), text);
        Assert.Contains("\"config_dir\": \"../Tables\"", text);
        Assert.Contains("\"voxel_quota_bytes\": 65536", text);
        Assert.Contains("Lumio.Server.HostEntry.HostEntry, Lumio.Server.HostEntry", text);
        Assert.Contains("LumioHostEntry", text);
        Assert.DoesNotContain("replace-host-entry", text);
        Assert.DoesNotContain("replace-server-audience", text);
        Assert.DoesNotContain("REPLACE_WITH_PLATFORM_32_BYTE_PUBLIC_KEY_HEX", text);
        Assert.Matches(new Regex("\"admission_public_key_hex\": \"[0-9a-fA-F]{64}\""), text);
    }

    [Fact]
    public void CommittedVoxelIsARestoreableCapture()
    {
        string repoRoot = Path.GetFullPath(Path.Combine(GameplayRoot, ".."));
        string mapPath = Path.Combine(repoRoot, "Server", "Assets", "Maps", "sample.voxel");
        byte[] bytes = File.ReadAllBytes(mapPath);
        string mapText = Encoding.UTF8.GetString(bytes);
        Assert.Contains("LUMIOSNP1", mapText);
        Assert.DoesNotContain("LUMIO-VOXEL-SNAPSHOT-V1", mapText);
        Assert.DoesNotContain("BLOCKED: this is not a restoreable VoxelEngine capture", mapText);
        Assert.DoesNotContain("do-not-restore: true", mapText);
        Assert.DoesNotContain("does not exist", mapText, StringComparison.OrdinalIgnoreCase);

        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(Path.Combine(repoRoot, "Server", "Config", "Startup", "server.json")));
        string declared = document.RootElement.GetProperty("base_map_content_sha256").GetString()!;
        string actual = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        Assert.Equal(actual, declared);
        Assert.Matches("^[0-9a-f]{64}$", declared);
        Assert.True(bytes.Length > 0);
    }

    [Fact]
    public void GameplayOutputShipsNet10SimulationWithDedicatedServerHostBinding()
    {
        DirectoryInfo output = new(AppContext.BaseDirectory);
        // SDK artifacts output is bin/<project>/<pivot>; ordinary output is bin/<configuration>/<tfm>.
        string gameplayOutput = output.Parent!.Name == "Lumio.Sample.Gameplay.Tests"
            ? Path.Combine(output.Parent.Parent!.FullName, "Lumio.Sample.Gameplay", output.Name)
            : Path.Combine(GameplayRoot, "bin", output.Parent.Name, "net10.0");
        string path = Path.Combine(gameplayOutput, "Lumio.GameRuntime.Simulation.dll");
        Assert.True(
            File.Exists(path),
            "Lumio.GameRuntime.Simulation.dll is missing from Sample gameplay output; HostEntry reflects DedicatedServerHostBinding beside the assemblies server.json names. Probed: " + path);

        Assembly assembly = Assembly.LoadFrom(path);
        Assert.True(
            assembly.GetType("Lumio.GameRuntime.Simulation.DedicatedServerHostBinding") is not null,
            "Lumio.GameRuntime.Simulation.DedicatedServerHostBinding is missing from " + path + ". A netstandard2.1 Simulation.dll Compile-Removes that type; sibling must resolve the net10.0 TFM.");
        Assert.True(
            assembly.GetType("Lumio.GameRuntime.Simulation.WorldTickBinding") is not null,
            "Lumio.GameRuntime.Simulation.WorldTickBinding is missing from " + path + ".");
    }

    [Fact]
    public void CiTakesTheEngineOnlyFromTheEngineSubmodule()
    {
        // ADR-123: build and test jobs fetch Engine/ with the checkout (submodules: true); no job
        // checks out a private engine repository or reads LUMIO_CI_PAT, and the native the GAS
        // wiring tests load is the release's (Server/Tests/EngineRelease.cs), not a provisioned one.
        string yml = File.ReadAllText(Path.Combine(GameplayRoot, "..", ".github", "workflows", "ci.yml"));
        Assert.Contains("submodules: true", yml);
        Assert.DoesNotContain("provision-engine-native.sh", yml);
        Assert.DoesNotContain("secrets.LUMIO_CI_PAT", yml);
        foreach (string repository in new[] { "LumioGameEngine", "LumioGameRuntime", "LumioNativeCore", "LumioVoxelEngine", "LumioServer", "LumioClient", "LumioPlatform" })
            Assert.DoesNotContain("repository: LumioGames/" + repository, yml);
        Assert.Contains("node --test Tools/server-profile.test.mjs", yml);
        Assert.Contains("node --test Tools/ds-config.test.mjs", yml);
        Assert.Contains("node --test Tools/sync-config-readers.test.mjs", yml);
        // LumioConfig is public: the zero-diff reader check still drives the real generator.
        Assert.Contains("LUMIO_CONFIG_ROOT", yml);
        Assert.Contains("repository: LumioGames/LumioConfig", yml);
    }
}

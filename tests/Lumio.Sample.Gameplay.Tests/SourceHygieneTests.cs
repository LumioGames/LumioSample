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
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src", "Lumio.Sample.Gameplay"));

    [Fact]
    public void SetLocalPositionIsOnlyCalledFromMoveAbility()
    {
        var hits = new List<string>();
        foreach (string file in Directory.GetFiles(GameplayRoot, "*.cs", SearchOption.AllDirectories))
        {
            if (file.Contains($"{Path.DirectorySeparatorChar}generated{Path.DirectorySeparatorChar}", System.StringComparison.Ordinal))
                continue;
            if (Path.GetFileName(file) == "MoveAbility.cs") continue;
            if (Regex.IsMatch(File.ReadAllText(file), @"SetLocalPosition|SetWorldPosition|Translate\("))
                hits.Add(file);
        }

        Assert.Empty(hits);
    }

    [Fact]
    public void MineAbilityDoesNotClaimAVoxelWrite()
    {
        Lumio.Sample.Gameplay.MineAbility.Writer = null;
        Assert.False(Lumio.Sample.Gameplay.MineAbility.TryRequestAirWrite(default));
    }

    [Fact]
    public void ServerJsonUsesRelativeAssemblyPaths()
    {
        string text = File.ReadAllText(Path.Combine(GameplayRoot, "..", "..", "server.json"));
        Assert.Contains("src/Lumio.Sample.Gameplay/bin/Debug/net10.0/Lumio.Sample.Gameplay.dll", text);
        Assert.DoesNotContain("/Users/", text);
        Assert.DoesNotContain("LumioGameEngine/", text);
        Assert.Contains("\"world_profile\": \"runtime+voxel\"", text);
        Assert.Contains("\"durability\": \"snapshot_only\"", text);
        Assert.DoesNotContain("process-crash", text);
        Assert.DoesNotContain("power-loss", text);
        Assert.Contains("\"base_map_id\": \"sample\"", text);
        Assert.Contains("\"base_map_version\": \"0.1.0\"", text);
        Assert.DoesNotContain("0.1.0-placeholder", text);
        Assert.Matches(new Regex("\"base_map_content_sha256\": \"[0-9a-f]{64}\""), text);
        Assert.Contains("\"config_dir\": \"config\"", text);
        Assert.Contains("\"voxel_quota_bytes\": 65536", text);
        Assert.Contains("Lumio.Server.EntityChat.HostEntry.HostEntry, Lumio.Server.EntityChat.HostEntry", text);
        Assert.Contains("LumioEntityChatEntry", text);
        Assert.DoesNotContain("replace-host-entry", text);
        Assert.DoesNotContain("replace-server-audience", text);
        Assert.DoesNotContain("REPLACE_WITH_PLATFORM_32_BYTE_PUBLIC_KEY_HEX", text);
        Assert.Matches(new Regex("\"admission_public_key_hex\": \"[0-9a-fA-F]{64}\""), text);
    }

    [Fact]
    public void CommittedVoxelIsARestoreableCapture()
    {
        string repoRoot = Path.GetFullPath(Path.Combine(GameplayRoot, "..", ".."));
        string mapPath = Path.Combine(repoRoot, "maps", "sample.voxel");
        byte[] bytes = File.ReadAllBytes(mapPath);
        string mapText = Encoding.UTF8.GetString(bytes);
        Assert.Contains("LUMIOSNP1", mapText);
        Assert.DoesNotContain("LUMIO-VOXEL-SNAPSHOT-V1", mapText);
        Assert.DoesNotContain("BLOCKED: this is not a restoreable VoxelEngine capture", mapText);
        Assert.DoesNotContain("do-not-restore: true", mapText);
        Assert.DoesNotContain("does not exist", mapText, StringComparison.OrdinalIgnoreCase);

        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(Path.Combine(repoRoot, "server.json")));
        string declared = document.RootElement.GetProperty("base_map_content_sha256").GetString()!;
        string actual = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
        Assert.Equal(actual, declared);
        Assert.Matches("^[0-9a-f]{64}$", declared);
        Assert.True(bytes.Length > 0);
    }

    [Fact]
    public void GameplayOutputShipsNet10SimulationWithDedicatedServerHostBinding()
    {
        string configuration = new DirectoryInfo(AppContext.BaseDirectory).Parent!.Name;
        string path = Path.Combine(GameplayRoot, "bin", configuration, "net10.0", "Lumio.GameRuntime.Simulation.dll");
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
    public void CiTestJobProvisionsNativeForGasActivate()
    {
        string yml = File.ReadAllText(Path.Combine(GameplayRoot, "..", "..", ".github", "workflows", "ci.yml"));
        Assert.Contains("provision-engine-native.sh", yml);
        Assert.Contains("repository: LumioGames/LumioNativeCore", yml);
        Assert.Contains("repository: LumioGames/LumioVoxelEngine", yml);
        Assert.Contains("path: native-core-src", yml);
        Assert.Contains("path: voxel-engine-src", yml);
        Assert.Contains("LUMIO_ENGINE_ROOT", yml);
        Assert.Contains("LUMIO_NATIVE_CORE_ROOT", yml);
        Assert.Contains("LUMIO_VOXEL_ROOT", yml);
        Assert.Contains("node --test integration/server-profile.test.mjs", yml);
        Assert.Contains("node --test integration/ds-config.test.mjs", yml);
        Assert.Contains("node --test integration/sync-config-readers.test.mjs", yml);
        Assert.Contains("LUMIO_CONFIG_ROOT", yml);
        Assert.Contains("repository: LumioGames/LumioConfig", yml);
    }
}

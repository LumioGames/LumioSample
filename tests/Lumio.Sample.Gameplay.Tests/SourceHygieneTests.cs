using System;
using System.Collections.Generic;
using System.IO;
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
        Assert.Contains("\"world_profile\": \"runtime-only\"", text);
        Assert.Contains("\"config_dir\": \"config\"", text);
        Assert.Contains("Lumio.Server.EntityChat.HostEntry.HostEntry, Lumio.Server.EntityChat.HostEntry", text);
        Assert.Contains("LumioEntityChatEntry", text);
        Assert.DoesNotContain("replace-host-entry", text);
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
    }
}

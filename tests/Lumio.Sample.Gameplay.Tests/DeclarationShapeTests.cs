using System;
using System.IO;
using System.Text.RegularExpressions;
using Xunit;

namespace Lumio.Sample.Gameplay.Tests;

public sealed class DeclarationShapeTests
{
    private static string GameplayRoot =>
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "src", "Lumio.Sample.Gameplay"));

    [Fact]
    public void WorldEntityIsTheOnlyWorldSingleton()
    {
        string[] files = Directory.GetFiles(GameplayRoot, "*.cs", SearchOption.AllDirectories);
        int worldTrue = 0;
        foreach (string file in files)
        {
            if (file.Contains($"{Path.DirectorySeparatorChar}generated{Path.DirectorySeparatorChar}", System.StringComparison.Ordinal))
                continue;
            worldTrue += Regex.Count(File.ReadAllText(file), @"World\s*=\s*true");
        }

        Assert.Equal(1, worldTrue);
        Assert.Contains("TickRateHz = 20", File.ReadAllText(Path.Combine(GameplayRoot, "EntityTypes", "WorldEntity.cs")));
    }

    [Fact]
    public void PlayerEntityUsesObserverIdentityTransformChatAndAbility()
    {
        string text = File.ReadAllText(Path.Combine(GameplayRoot, "EntityTypes", "PlayerEntity.cs"));
        Assert.Contains("ObserverComponent", text);
        Assert.Contains("IdentityComponent", text);
        Assert.Contains("LogicTransform", text);
        Assert.Contains("ChatComponent", text);
        Assert.Contains("AbilityComponent", text);
        Assert.DoesNotContain("#if", text);
    }

    [Fact]
    public void HandwrittenGameplayHasNoPreprocessorBranches()
    {
        foreach (string file in Directory.GetFiles(GameplayRoot, "*.cs", SearchOption.AllDirectories))
        {
            if (file.Contains($"{Path.DirectorySeparatorChar}generated{Path.DirectorySeparatorChar}", System.StringComparison.Ordinal))
                continue;
            Assert.DoesNotContain("#if", File.ReadAllText(file));
        }
    }
}

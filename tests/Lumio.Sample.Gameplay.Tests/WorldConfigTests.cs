using System;
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Config;
using Xunit;

namespace Lumio.Sample.Gameplay.Tests;

[Collection("SampleWorld")]
public sealed class WorldConfigTests
{
    [Fact]
    public void BootAndRestoreRequireDeclaredBinding()
    {
        Assert.Equal(typeof(ISampleConfig), GeneratedRegistry.Instance.RequiredGameplayConfigContract);
        Assert.Throws<WorldConfigBindingException>(() => WorldManager.Create(GeneratedRegistry.Instance, 1));
        using var manager = SampleGameplay.CreateWorld(1);
        var config = Assert.IsAssignableFrom<ISampleConfig>(manager.World.GameplayConfig);
        Assert.Equal(SampleTables.VeinHitsToBreak, config.Mining.VeinHitsToBreak);
        Assert.Throws<WorldConfigBindingException>(() => WorldManager.CreateFromSnapshot(manager.CaptureSnapshot(), GeneratedRegistry.Instance));
    }

    [Fact]
    public void RecompiledTableChangesNewWorldReserveAndLeavesExistingWorldUnchanged()
    {
        using var first = SampleWorldHarness.Boot();
        int original = first.Remaining;
        using var replacement = TempConfig.WithHits(1);
        using var restarted = SampleWorldHarness.Boot();
        Assert.Equal(1, restarted.Remaining);
        Assert.Equal(original, first.Remaining);
        Assert.NotSame(first.World.GameplayConfig, restarted.World.GameplayConfig);
    }
}

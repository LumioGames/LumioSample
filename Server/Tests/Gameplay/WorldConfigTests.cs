using System;
using System.Threading;
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
        // B3: worlds come from the process engine; a registry that declares a config
        // contract is rejected at the configuration step with the binding exception
        // wrapped in the registered EngineHostException for that step.
        EngineHostException missing = Assert.Throws<Lumio.GameRuntime.Hosting.EngineHostException>(() =>
            SampleWorldHarness.Engine.CreateWorld(new Lumio.GameRuntime.Hosting.WorldCreationOptions(GeneratedRegistry.Instance)
            {
                InstanceId = 1,
                Catalog = SampleWorldHarness.OfficialCatalog(),
            }));
        Assert.IsType<WorldConfigBindingException>(missing.InnerException);
        using var manager = SampleGameplay.CreateWorld(SampleWorldHarness.Engine, 1, SampleWorldHarness.OfficialCatalog());
        var config = Assert.IsAssignableFrom<ISampleConfig>(manager.World.GameplayConfig);
        Assert.Same(config, SampleConfigBinding.For(manager.World));
        EngineHostException unrestored = Assert.Throws<Lumio.GameRuntime.Hosting.EngineHostException>(() =>
            SampleWorldHarness.Engine.CreateWorld(new Lumio.GameRuntime.Hosting.WorldCreationOptions(GeneratedRegistry.Instance)
            {
                Catalog = SampleWorldHarness.OfficialCatalog(),
                Snapshot = manager.CaptureSnapshot(),
            }));
        Assert.IsType<WorldConfigBindingException>(unrestored.InnerException);
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

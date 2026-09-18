using System;
using System.IO;
using System.Linq;
using System.Threading;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Simulation;
using Lumio.Sample.Gameplay.Components.Vein;
using Xunit;

namespace Lumio.Sample.Gameplay.Tests;

[Collection("SampleWorld")]
public sealed class ProductionMiningTests
{
    [Fact]
    public void ProductionAttachCreatesVeinsFromRestoredOreCells()
    {
        string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        using WorldManager manager = SampleGameplay.CreateWorld(520);
        using DedicatedServerHostBinding binding = Assert.IsType<DedicatedServerHostBinding>(
            DedicatedServerHostBinding.TryAttach(manager, KernelConfigurationFixture.Create(),
                File.ReadAllBytes(Path.Combine(root, "maps", "official-catalog.json")),
                File.ReadAllBytes(Path.Combine(root, "maps", "sample.voxel"))));
        manager.Start(Thread.CurrentThread);
        WorldTickBinding.Bind(manager);
        manager.Tick();
        manager.Tick();
        Assert.Equal(4, manager.World.Each<VeinReserveComponent>().Count());
    }
}

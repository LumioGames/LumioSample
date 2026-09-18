using System;
using System.IO;
using System.Linq;
using System.Threading;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.GameRuntime.Coordination;
using Lumio.GameRuntime.Persistence;
using Lumio.Sample.Gameplay.Config;
using Lumio.Sample.Gameplay.Components.Ore;
using Lumio.GameRuntime.Simulation;
using Lumio.Sample.Gameplay.Components.Vein;
using Xunit;

namespace Lumio.Sample.Gameplay.Tests;

[Collection("SampleWorld")]
public sealed class ProductionMiningTests
{
    [Fact]
    public void AdmittedPlayerWalksToOreAndMinesThroughNativePhysics()
    {
        string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        using WorldManager manager = SampleGameplay.CreateWorld(521);
        using DedicatedServerHostBinding host = Assert.IsType<DedicatedServerHostBinding>(
            DedicatedServerHostBinding.TryAttach(manager, KernelConfigurationFixture.Create(),
                File.ReadAllBytes(Path.Combine(root, "maps", "official-catalog.json")),
                File.ReadAllBytes(Path.Combine(root, "maps", "sample.voxel"))));
        manager.Start(Thread.CurrentThread);
        WorldTickBinding.Bind(manager);
        EntityOrder player = PlayerLifecycleTests.QueuePlayer(manager.World, "walk-to-mine");
        for (int tick = 0; tick < 4; tick++) manager.Tick();
        AbilityComponent owner = manager.World.Get<AbilityComponent>(player.AssignedId);
        Assert.Equal(SampleConfigBinding.For(manager.World).Stamina.Initial,
            manager.World.Get<AttributeComponent>(player.AssignedId).GetBaseValue("Stamina"));
        Assert.Same(AbilityPhysicsBinding.Resolve(manager), owner.Physics);
        Assert.IsNotType<RecordingAbilityPhysicsPort>(owner.Physics);
        var move = new MoveAbility.Input { Dx = -1, Dz = -1 };
        for (int step = 0; step < 11; step++)
        {
            System.Numerics.Vector3 before = manager.World.Get<LogicTransform>(player.AssignedId).LocalPosition;
            AbilityActivateResult moved = owner.Activate<MoveAbility, MoveAbility.Input>(in move);
            Assert.True(moved.Succeeded, moved.FailureCode);
            Assert.Equal(before + new System.Numerics.Vector3(
                -(float)SampleConfigBinding.For(manager.World).Movement.StepMeters, 0,
                -(float)SampleConfigBinding.For(manager.World).Movement.StepMeters),
                manager.World.Get<LogicTransform>(player.AssignedId).LocalPosition);
            manager.Tick();
        }
        VeinReserveComponent vein = manager.World.Each<VeinReserveComponent>()
            .Single(value => value.CellX.Value == 2 && value.CellZ.Value == 2);
        Assert.True(MineAbility.WithinReach(owner, vein.Entity));
        var mine = new MineAbility.Input { TargetHex = vein.Entity.ToHex() };
        for (int hit = 0; hit < SampleConfigBinding.For(manager.World).Mining.VeinHitsToBreak; hit++)
        {
            Assert.True(SampleGameplay.ActivateMine(owner, in mine).Succeeded);
            manager.Tick();
        }
        Assert.Single(manager.World.Each<OrePileComponent>());
    }

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

    [Fact]
    public void ProductionAttachDiscoversOreOutsideAuthoringRectangle()
    {
        string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        using WorldManager manager = SampleGameplay.CreateWorld(522);
        using DedicatedServerHostBinding binding = Assert.IsType<DedicatedServerHostBinding>(
            DedicatedServerHostBinding.TryAttach(manager, KernelConfigurationFixture.Create(),
                File.ReadAllBytes(Path.Combine(root, "maps", "official-catalog.json")),
                File.ReadAllBytes(Path.Combine(root, "maps", "sample.voxel"))));
        manager.Start(Thread.CurrentThread);
        WorldTickBinding.Bind(manager);
        HostVoxelWorldAdapter adapter = VoxelGameplayBinding.Resolve(manager)!;
        const int offset = 10 * 16 + 10;
        VoxelCellQuery cell = adapter.Read(0, offset);
        uint ore = SampleConfigBinding.For(manager.World).Map.OreBlockType << 8;
        Assert.Equal(VoxelStageStatus.Staged, adapter.TryStageWrite(
            new[] { new VoxelWriteEntry(0, offset, ore, cell.SectionRevision) }, "ore-outside-authoring-rectangle").Status);
        for (int tick = 0; tick < 5; tick++) manager.Tick();
        VeinReserveComponent vein = Assert.Single(manager.World.Each<VeinReserveComponent>(),
            value => value.CellX.Value == 10 && value.CellZ.Value == 10);
        Assert.Equal(5, manager.World.Each<VeinReserveComponent>().Count());
        Assert.Equal(vein.Entity.ToHex(), adapter.BindingGet(0, offset));
        Assert.Equal(ore, adapter.Read(0, offset).BlockId);
    }

    [Fact]
    public void ConfiguredHitsPublishOneRewardAndReplayCannotPublishAgain()
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        int hits = world.Remaining;
        long cost = SampleConfigBinding.For(world.World).Mining.StaminaCost;
        world.World.Get<AttributeComponent>(world.Player).SetBaseValue("Stamina", cost * hits);
        VeinReserveComponent vein = world.World.Get<VeinReserveComponent>(world.Vein);
        ulong section = vein.SectionKey.Value;
        int offset = vein.CellOffset.Value;
        for (int hit = 1; hit < hits; hit++)
        {
            Assert.True(world.Mine().Succeeded);
            world.FlushCreates();
            Assert.Equal(hits - hit, world.Remaining);
            Assert.Empty(world.World.Each<OrePileComponent>());
            Assert.NotEqual(0U, world.Adapter.Read(section, offset).BlockId);
        }
        ulong revision = world.Adapter.Read(section, offset).SectionRevision;
        VoxelDigApplied? applied = null;
        int notifications = 0;
        world.Adapter.DigApplied += value =>
        {
            applied = value;
            notifications++;
            Assert.Equal(0, vein.Remaining.Value);
        };
        Assert.True(world.Mine().Succeeded);
        // The last hit settles at Execute: stamina and reserve are already final, the drop is an order.
        Assert.Equal(0, world.StaminaBase);
        Assert.Equal(0, world.Remaining);
        Assert.Empty(world.World.Each<OrePileComponent>());
        Assert.False(world.Mine().Succeeded);
        world.FlushCreates();
        Assert.Equal(0, world.StaminaBase);
        Assert.False(world.World.IsLive(world.Vein));
        Assert.Equal(0U, world.Adapter.Read(section, offset).BlockId);
        Assert.Null(world.Adapter.BindingGet(section, offset));
        Assert.Equal(SampleConfigBinding.For(world.World).Mining.OrePerVein,
            Assert.Single(world.World.Each<OrePileComponent>()).Amount.Value);
        Assert.Equal(1, notifications);
        string transaction = applied!.Value.TxnId;
        VoxelMutationOutcome original = Assert.Single(world.Adapter.DrainResults().Results).Outcome;
        Assert.Equal(VoxelTxnState.Applied, original.State);
        Assert.Equal(VoxelCommitDisposition.Original, original.Disposition);
        Assert.True(original.TokenConsumed);
        Assert.Equal(VoxelStageStatus.Staged, world.Adapter.TryStageDigThrough(
            section, offset, revision, transaction, VoxelSubmissionIntent.Replay).Status);
        world.FlushCreates();
        Assert.Equal(VoxelCommitDisposition.Duplicate, world.Adapter.DrainResults().Results.Single().Outcome.Disposition);
        Assert.Equal(1, notifications);
        Assert.Single(world.World.Each<OrePileComponent>());
        Assert.Equal(0, world.StaminaBase);
    }

    [Theory]
    [InlineData("invalid")]
    [InlineData("range")]
    [InlineData("stamina")]
    public void RejectedFinalHitNeverRewards(string reason)
    {
        using TempConfig config = TempConfig.WithHits(1);
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        if (reason == "range") PlayerLifecycleTests.PlaceFixturePlayer(world.World, world.Player, new System.Numerics.Vector3(100));
        if (reason == "stamina") world.World.Get<AttributeComponent>(world.Player).SetBaseValue("Stamina", 0);
        long stamina = world.StaminaBase;
        var input = new MineAbility.Input { TargetHex = reason == "invalid" ? "not-hex" : world.Vein.ToHex() };
        Assert.False(SampleGameplay.ActivateMine(world.World.Get<AbilityComponent>(world.Player), in input).Succeeded);
        world.FlushCreates();
        Assert.Equal(stamina, world.StaminaBase);
        Assert.Equal(1, world.Remaining);
        Assert.Empty(world.World.Each<OrePileComponent>());
        Assert.Equal(0, world.Adapter.QueuedCount);
    }

    [Fact]
    public void NativeManagersKeepMiningAndDisposalIsolated()
    {
        using TempConfig config = TempConfig.WithHits(1);
        using SampleWorldHarness first = SampleWorldHarness.Boot();
        using SampleWorldHarness second = SampleWorldHarness.Boot();
        Assert.NotSame(first.Adapter, second.Adapter);
        Assert.True(first.Mine().Succeeded);
        first.FlushCreates();
        Assert.Single(first.World.Each<OrePileComponent>());
        Assert.Empty(second.World.Each<OrePileComponent>());
        Assert.Equal(1, second.Remaining);
        first.Host.Dispose();
        Assert.True(second.Mine().Succeeded);
        second.FlushCreates();
        Assert.Single(second.World.Each<OrePileComponent>());
    }

    [Fact]
    public void PartialReserveAndDepletedCellSurviveNativeColdRestore()
    {
        using SampleWorldHarness source = SampleWorldHarness.Boot();
        Assert.True(source.Mine().Succeeded);
        source.FlushCreates();
        int remaining = source.Remaining;
        long stamina = source.StaminaBase;
        System.Numerics.Vector3 center = source.World.Get<VeinReserveComponent>(source.Vein).CellCenter;
        DualCutCaptureResult capture = source.Host.Capture();
        Assert.True(capture.Succeeded, capture.ErrorCode);
        string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        byte[] catalog = File.ReadAllBytes(Path.Combine(root, "maps", "official-catalog.json"));
        DedicatedServerRestoreResult restored = DedicatedServerHostBinding.RestoreNew(
            capture.Checkpoint!.Value.Runtime, capture.Checkpoint.Value.Voxel, GeneratedRegistry.Instance,
            KernelConfigurationFixture.Create(), null, source.World.Manager.IngressBudget, catalog, SampleConfigBinding.Load());
        Assert.True(restored.Succeeded, restored.ErrorCode);
        using DedicatedServerHostBinding host = restored.Binding!;
        using WorldManager manager = host.Manager;
        source.Host.Dispose();
        manager.Start(Thread.CurrentThread);
        WorldTickBinding.Bind(manager);
        manager.Tick();
        VeinReserveComponent vein = manager.World.Get<VeinReserveComponent>(source.Vein);
        ulong section = vein.SectionKey.Value;
        int offset = vein.CellOffset.Value;
        Assert.Equal(remaining, vein.Remaining.Value);
        Assert.Equal(center, vein.CellCenter);
        Assert.Equal(source.Vein.ToHex(), VoxelGameplayBinding.Resolve(manager)!.BindingGet(section, offset));
        AttributeComponent attributes = manager.World.Get<AttributeComponent>(source.Player);
        Assert.Equal(stamina, attributes.GetBaseValue("Stamina"));
        attributes.SetBaseValue("Stamina", remaining * SampleConfigBinding.For(manager.World).Mining.StaminaCost);
        var input = new MineAbility.Input { TargetHex = source.Vein.ToHex() };
        for (int hit = 0; hit < remaining; hit++)
        {
            Assert.True(SampleGameplay.ActivateMine(manager.World.Get<AbilityComponent>(source.Player), in input).Succeeded);
            manager.Tick();
        }
        OrePileComponent drop = Assert.Single(manager.World.Each<OrePileComponent>());
        Assert.Equal(center, manager.World.Get<LogicTransform>(drop.Entity).LocalPosition);
        DualCutCaptureResult depleted = host.Capture();
        Assert.True(depleted.Succeeded, depleted.ErrorCode);
        DedicatedServerRestoreResult cold = DedicatedServerHostBinding.RestoreNew(
            depleted.Checkpoint!.Value.Runtime, depleted.Checkpoint.Value.Voxel, GeneratedRegistry.Instance,
            KernelConfigurationFixture.Create(), null, manager.IngressBudget, catalog, SampleConfigBinding.Load());
        Assert.True(cold.Succeeded, cold.ErrorCode);
        using DedicatedServerHostBinding coldHost = cold.Binding!;
        using WorldManager coldManager = coldHost.Manager;
        host.Dispose();
        coldManager.Start(Thread.CurrentThread);
        WorldTickBinding.Bind(coldManager);
        coldManager.Tick();
        Assert.False(coldManager.World.IsLive(source.Vein));
        Assert.Equal(3, coldManager.World.Each<VeinReserveComponent>().Count());
        OrePileComponent coldDrop = Assert.Single(coldManager.World.Each<OrePileComponent>());
        Assert.Equal(SampleConfigBinding.For(coldManager.World).Mining.OrePerVein, coldDrop.Amount.Value);
        Assert.Equal(center, coldManager.World.Get<LogicTransform>(coldDrop.Entity).LocalPosition);
        Assert.Equal(0U, VoxelGameplayBinding.Resolve(coldManager)!.Read(section, offset).BlockId);
        AttributeComponent coldAttributes = coldManager.World.Get<AttributeComponent>(source.Player);
        string oreName = SampleConfigBinding.For(coldManager.World).Ore.Name;
        long oreBefore = coldAttributes.GetBaseValue(oreName);
        AbilityComponent coldAbilities = coldManager.World.Get<AbilityComponent>(source.Player);
        var pickup = new PickupAbility.Input { TargetHex = coldDrop.Entity.ToHex() };
        AbilityActivateResult picked = coldAbilities.Activate<PickupAbility, PickupAbility.Input>(in pickup);
        Assert.True(picked.Succeeded, picked.FailureCode);
        Assert.Equal(oreBefore, coldAttributes.GetBaseValue(oreName));
        coldManager.Tick();
        Assert.Equal(oreBefore + SampleConfigBinding.For(coldManager.World).Mining.OrePerVein,
            coldAttributes.GetBaseValue(oreName));
        Assert.Empty(coldManager.World.Each<OrePileComponent>());
    }

    [Fact]
    public void PickedUpDropStaysGoneAndOreLedgerSurvivesTwoColdRestores()
    {
        using TempConfig config = TempConfig.WithHits(1);
        using SampleWorldHarness source = SampleWorldHarness.Boot();
        string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        byte[] catalog = File.ReadAllBytes(Path.Combine(root, "maps", "official-catalog.json"));
        string oreName = SampleConfigBinding.For(source.World).Ore.Name;
        int veinsBefore = source.World.Each<VeinReserveComponent>().Count();
        Assert.True(source.Mine().Succeeded);
        source.FlushCreates();
        NetEntityId drop = Assert.Single(source.World.Each<OrePileComponent>()).Entity;
        long oreBefore = source.OreBase;
        Assert.True(source.Pickup(drop).Succeeded);
        source.FlushCreates();
        long oreAfter = source.OreBase;
        Assert.Equal(oreBefore + SampleConfigBinding.For(source.World).Mining.OrePerVein, oreAfter);
        Assert.Empty(source.World.Each<OrePileComponent>());

        // First restart: the drop must not come back and the ore ledger must be the settled value.
        DualCutCaptureResult firstCapture = source.Host.Capture();
        Assert.True(firstCapture.Succeeded, firstCapture.ErrorCode);
        DedicatedServerRestoreResult first = DedicatedServerHostBinding.RestoreNew(
            firstCapture.Checkpoint!.Value.Runtime, firstCapture.Checkpoint.Value.Voxel, GeneratedRegistry.Instance,
            KernelConfigurationFixture.Create(), null, source.World.Manager.IngressBudget, catalog, SampleConfigBinding.Load());
        Assert.True(first.Succeeded, first.ErrorCode);
        using DedicatedServerHostBinding firstHost = first.Binding!;
        using WorldManager firstManager = firstHost.Manager;
        source.Host.Dispose();
        firstManager.Start(Thread.CurrentThread);
        WorldTickBinding.Bind(firstManager);
        firstManager.Tick();
        Assert.Empty(firstManager.World.Each<OrePileComponent>());
        Assert.False(firstManager.World.IsLive(drop));
        Assert.False(firstManager.World.IsLive(source.Vein));
        Assert.Equal(veinsBefore - 1, firstManager.World.Each<VeinReserveComponent>().Count());
        Assert.Equal(oreAfter, firstManager.World.Get<AttributeComponent>(source.Player).GetBaseValue(oreName));

        // Second restart from the restored world: still no drop, ledger unchanged, nothing replayed.
        DualCutCaptureResult secondCapture = firstHost.Capture();
        Assert.True(secondCapture.Succeeded, secondCapture.ErrorCode);
        DedicatedServerRestoreResult second = DedicatedServerHostBinding.RestoreNew(
            secondCapture.Checkpoint!.Value.Runtime, secondCapture.Checkpoint.Value.Voxel, GeneratedRegistry.Instance,
            KernelConfigurationFixture.Create(), null, firstManager.IngressBudget, catalog, SampleConfigBinding.Load());
        Assert.True(second.Succeeded, second.ErrorCode);
        using DedicatedServerHostBinding secondHost = second.Binding!;
        using WorldManager secondManager = secondHost.Manager;
        firstHost.Dispose();
        secondManager.Start(Thread.CurrentThread);
        WorldTickBinding.Bind(secondManager);
        secondManager.Tick();
        Assert.Empty(secondManager.World.Each<OrePileComponent>());
        Assert.False(secondManager.World.IsLive(drop));
        Assert.Equal(veinsBefore - 1, secondManager.World.Each<VeinReserveComponent>().Count());
        Assert.Equal(oreAfter, secondManager.World.Get<AttributeComponent>(source.Player).GetBaseValue(oreName));
        AbilityComponent abilities = secondManager.World.Get<AbilityComponent>(source.Player);
        var replay = new PickupAbility.Input { TargetHex = drop.ToHex() };
        Assert.False(abilities.Activate<PickupAbility, PickupAbility.Input>(in replay).Succeeded);
        secondManager.Tick();
        Assert.Equal(oreAfter, secondManager.World.Get<AttributeComponent>(source.Player).GetBaseValue(oreName));
    }
}

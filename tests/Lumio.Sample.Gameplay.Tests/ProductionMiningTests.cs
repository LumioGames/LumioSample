using System;
using System.IO;
using System.Linq;
using System.Numerics;
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
        manager.Tick(); // the final dig's terrain result settles one frame after it commits
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
            // Phase 8 observes only: the reserve is still unsettled while the cell is published.
            Assert.Equal(1, vein.Remaining.Value);
        };
        Assert.True(world.Mine().Succeeded);
        // The last hit only orders the dig; stamina, reserve and the drop all wait for its result.
        Assert.Equal(cost, world.StaminaBase);
        Assert.Equal(1, world.Remaining);
        Assert.Empty(world.World.Each<OrePileComponent>());
        Assert.False(world.Mine().Succeeded);

        world.FlushCreates(); // phase 8 publishes the cell
        Assert.Equal(1, notifications);
        Assert.Equal(cost, world.StaminaBase);
        Assert.Equal(0U, world.Adapter.Read(section, offset).BlockId);
        Assert.Empty(world.World.Each<OrePileComponent>());

        world.FlushCreates(); // phase 4 reads the result back and settles the hit
        Assert.Equal(0, world.StaminaBase);
        Assert.False(world.World.IsLive(world.Vein));
        Assert.Null(world.Adapter.BindingGet(section, offset));
        Assert.Equal(SampleConfigBinding.For(world.World).Mining.OrePerVein,
            Assert.Single(world.World.Each<OrePileComponent>()).Amount.Value);

        // Sample owns the result queue now, so the settled transaction is already drained. Replaying
        // it reports a duplicate and, with no pending record left, pays nothing a second time.
        string transaction = applied!.Value.TxnId;
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
        first.FlushCreates();
        Assert.Single(first.World.Each<OrePileComponent>());
        Assert.Empty(second.World.Each<OrePileComponent>());
        Assert.Equal(1, second.Remaining);
        first.Host.Dispose();
        Assert.True(second.Mine().Succeeded);
        second.FlushCreates();
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
        manager.Tick(); // the final dig's terrain result settles one frame after it commits
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
    public void CheckpointTakenBeforeTheDigIsOrderedRestoresWithNothingOwed()
    {
        // R-00650, sampling moment 1 of 3: nothing is pending, so the restored world owes nothing
        // and the vein is still there to be mined through to settlement.
        using TempConfig config = TempConfig.WithHits(1);
        using SampleWorldHarness source = SampleWorldHarness.Boot();
        long stamina = source.StaminaBase;
        int remaining = source.Remaining;
        Vector3 center = source.World.Get<VeinReserveComponent>(source.Vein).CellCenter;
        using DedicatedServerHostBinding host = ColdRestore(source);
        WorldManager manager = host.Manager;

        Assert.Equal(stamina, Stamina(manager, source.Player));
        Assert.True(manager.World.IsLive(source.Vein));
        Assert.Equal(remaining, manager.World.Get<VeinReserveComponent>(source.Vein).Remaining.Value);
        Assert.Empty(manager.World.Each<OrePileComponent>());

        var input = new MineAbility.Input { TargetHex = source.Vein.ToHex() };
        Assert.True(SampleGameplay.ActivateMine(manager.World.Get<AbilityComponent>(source.Player), in input).Succeeded);
        manager.Tick();
        manager.Tick();
        Assert.Equal(stamina - SampleConfigBinding.For(manager.World).Mining.StaminaCost, Stamina(manager, source.Player));
        Assert.Equal(center, manager.World.Get<LogicTransform>(
            Assert.Single(manager.World.Each<OrePileComponent>()).Entity).LocalPosition);
    }

    [Fact]
    public void CheckpointTakenInsideTheCrossFrameWindowStillSettlesAfterAColdStart()
    {
        // R-00650, sampling moment 2 of 3 — the one that used to lose the ore. The cut lands between
        // "phase 8 published the cell" and "the next frame settles it": the cell is already air, the
        // vein is already destroyed, and before this card the debt died with the process. The record
        // now rides the same dual cut as the terrain, so the cold-started world pays it.
        using TempConfig config = TempConfig.WithHits(1);
        using SampleWorldHarness source = SampleWorldHarness.Boot();
        long stamina = source.StaminaBase;
        long cost = SampleConfigBinding.For(source.World).Mining.StaminaCost;
        VeinReserveComponent vein = source.World.Get<VeinReserveComponent>(source.Vein);
        ulong section = vein.SectionKey.Value;
        int offset = vein.CellOffset.Value;
        Vector3 center = vein.CellCenter;

        Assert.True(source.Mine().Succeeded);
        source.FlushCreates(); // phase 8 publishes the cell; the settlement is one frame away

        // The window really is open at the cut: terrain gone, ledgers untouched.
        Assert.Equal(0U, source.Adapter.Read(section, offset).BlockId);
        Assert.Equal(stamina, source.StaminaBase);
        Assert.Empty(source.World.Each<OrePileComponent>());

        using DedicatedServerHostBinding host = ColdRestore(source);
        WorldManager manager = host.Manager;

        Assert.Equal(stamina - cost, Stamina(manager, source.Player));
        OrePileComponent drop = Assert.Single(manager.World.Each<OrePileComponent>());
        Assert.Equal(SampleConfigBinding.For(manager.World).Mining.OrePerVein, drop.Amount.Value);
        Assert.Equal(center, manager.World.Get<LogicTransform>(drop.Entity).LocalPosition);
        Assert.False(manager.World.IsLive(source.Vein));
        Assert.Equal(0U, VoxelGameplayBinding.Resolve(manager)!.Read(section, offset).BlockId);

        // Settled once, not once per boot: another cold start from here pays nothing further.
        using DedicatedServerHostBinding second = ColdRestore(host);
        Assert.Equal(stamina - cost, Stamina(second.Manager, source.Player));
        Assert.Single(second.Manager.World.Each<OrePileComponent>());
    }

    [Fact]
    public void CheckpointTakenAfterSettlementDoesNotPayASecondTime()
    {
        // R-00650, sampling moment 3 of 3: the record was consumed before the cut, so the restored
        // world finds nothing pending and the ledgers keep exactly the one settlement they had.
        using TempConfig config = TempConfig.WithHits(1);
        using SampleWorldHarness source = SampleWorldHarness.Boot();
        long stamina = source.StaminaBase;
        long cost = SampleConfigBinding.For(source.World).Mining.StaminaCost;
        Assert.True(source.Mine().Succeeded);
        source.FlushCreates(); // phase 8 publishes
        source.FlushCreates(); // phase 4 settles
        Assert.Equal(stamina - cost, source.StaminaBase);
        Assert.Single(source.World.Each<OrePileComponent>());

        using DedicatedServerHostBinding host = ColdRestore(source);
        Assert.Equal(stamina - cost, Stamina(host.Manager, source.Player));
        Assert.Single(host.Manager.World.Each<OrePileComponent>());
        Assert.False(host.Manager.World.IsLive(source.Vein));
    }

    [Fact]
    public void RestoredRecordWhoseDigWasRefusedIsDiscardedWithoutTouchingAnyLedger()
    {
        // R-00650: the cut catches a record whose terrain order was refused — another writer took the
        // section revision first — and whose refusal is still sitting in a result queue that dies with
        // the process. The restored world reads the standing block, drops the record, moves no ledger,
        // throws nothing and faults nothing; the vein is mineable again.
        using TempConfig config = TempConfig.WithHits(1);
        using SampleWorldHarness source = SampleWorldHarness.Boot();
        long stamina = source.StaminaBase;
        long cost = SampleConfigBinding.For(source.World).Mining.StaminaCost;
        VeinReserveComponent vein = source.World.Get<VeinReserveComponent>(source.Vein);
        ulong section = vein.SectionKey.Value;
        int offset = vein.CellOffset.Value;
        VoxelCellQuery cell = source.Adapter.Read(section, offset);
        Assert.Equal(VoxelStageStatus.Staged, source.Adapter.TryStageWrite(
            new[] { new VoxelWriteEntry(section, 0, 0, cell.SectionRevision) }, "competing-write").Status);

        Assert.True(source.Mine().Succeeded);
        source.FlushCreates(); // phase 8 refuses the dig; the refusal has not been drained yet
        Assert.NotEqual(0U, source.Adapter.Read(section, offset).BlockId);
        Assert.Equal(stamina, source.StaminaBase);

        using DedicatedServerHostBinding host = ColdRestore(source);
        WorldManager manager = host.Manager;

        Assert.Equal(stamina, Stamina(manager, source.Player));
        Assert.Empty(manager.World.Each<OrePileComponent>());
        Assert.True(manager.World.IsLive(source.Vein));
        Assert.Equal(1, manager.World.Get<VeinReserveComponent>(source.Vein).Remaining.Value);
        Assert.NotEqual(0U, VoxelGameplayBinding.Resolve(manager)!.Read(section, offset).BlockId);

        // No fault latched and no slot left behind: the same vein settles normally now.
        var input = new MineAbility.Input { TargetHex = source.Vein.ToHex() };
        Assert.True(SampleGameplay.ActivateMine(manager.World.Get<AbilityComponent>(source.Player), in input).Succeeded);
        manager.Tick();
        manager.Tick();
        Assert.Equal(stamina - cost, Stamina(manager, source.Player));
        Assert.Single(manager.World.Each<OrePileComponent>());
    }

    private static long Stamina(WorldManager manager, NetEntityId player) =>
        manager.World.Get<AttributeComponent>(player).GetBaseValue(SampleConfigBinding.For(manager.World).Stamina.Name);

    /// <summary>Captures the dual cut, boots a new host from it and disposes the source.</summary>
    private static DedicatedServerHostBinding ColdRestore(SampleWorldHarness source)
    {
        DedicatedServerHostBinding host = ColdRestore(source.Host);
        source.Host.Dispose();
        return host;
    }

    /// <summary>Boots a new host from <paramref name="from"/>'s dual cut and ticks it into settlement.</summary>
    private static DedicatedServerHostBinding ColdRestore(DedicatedServerHostBinding from)
    {
        DualCutCaptureResult capture = from.Capture();
        Assert.True(capture.Succeeded, capture.ErrorCode);
        string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        DedicatedServerRestoreResult restored = DedicatedServerHostBinding.RestoreNew(
            capture.Checkpoint!.Value.Runtime, capture.Checkpoint.Value.Voxel, GeneratedRegistry.Instance,
            KernelConfigurationFixture.Create(), null, from.Manager.IngressBudget,
            File.ReadAllBytes(Path.Combine(root, "maps", "official-catalog.json")), SampleConfigBinding.Load());
        Assert.True(restored.Succeeded, restored.ErrorCode);
        DedicatedServerHostBinding host = restored.Binding!;
        WorldManager manager = host.Manager;
        manager.Start(Thread.CurrentThread);
        WorldTickBinding.Bind(manager);
        // Tick 1 rebuilds the transient voxel services, tick 2 reconciles any restored pending record
        // against the restored terrain, tick 3 makes the drop that reconciliation ordered live.
        for (int tick = 0; tick < 3; tick++) manager.Tick();
        return host;
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

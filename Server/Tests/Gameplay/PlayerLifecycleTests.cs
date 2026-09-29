using System;
using System.IO;
using System.Linq;
using System.Numerics;
using System.Reflection;
using System.Security.Cryptography;
using System.Threading;
using System.Text.Json;
using Lumio.Engine.NativeLoader;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.GameRuntime.Persistence;
using Lumio.GameRuntime.Simulation;
using Microsoft.Extensions.Logging;
using Lumio.Sample.Gameplay;
using Lumio.Sample.Gameplay.Components.Identity;
using Lumio.Sample.Gameplay.Config;
using Lumio.Sample.Gameplay.EntityTypes;
using Xunit;

namespace Lumio.Sample.Gameplay.Tests;

[Collection("SampleWorld")]
public sealed class PlayerLifecycleTests : IDisposable
{
    [Fact]
    public void RealHostAabbWallAndOpenMovementSurviveColdRestore()
    {
        // ADR-123: the native under test is the Engine/ release's, and the loaded image must be
        // the one its build-info.json names.
        string nativePath = Lumio.Sample.Tests.EngineRelease.Require(Lumio.Sample.Tests.EngineRelease.NativeLibrary,
            "SMP08 runs against the release native");
        using NativeEngineLease native = NativeEngineLoader.LoadFromBuildInfo(nativePath);
        (string buildId, string abiHash, string binarySha256) = Lumio.Sample.Tests.EngineRelease.NativeBuildInfo();
        Assert.Equal(buildId, native.BuildId);
        Assert.Equal(abiHash, native.AbiHash);
        string? evidencePath = Environment.GetEnvironmentVariable("LUMIO_SAMPLE_HOST_EVIDENCE");
        if (evidencePath is not null)
            File.WriteAllText(evidencePath + ".identity.json", JsonSerializer.Serialize(new
            {
                native.NativePath, native.BuildId, native.AbiHash, native.BinarySha256,
                Assemblies = new[] { typeof(SampleGameplay).Assembly, typeof(Lumio.GameRuntime.Hosting.LumioEngine).Assembly }
                    .Select(assembly => new { assembly.FullName, assembly.Location, assembly.ManifestModule.ModuleVersionId,
                        Sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))) })
            }));
        // The wall scene is this game's own, authored here on this very native image from the
        // committed base map (CatalogWorld; ADR-117: no engine test fixture). Same-source or fail.
        CatalogWorld.Scene scene = CatalogWorld.Author();
        Assert.Equal(binarySha256, scene.BinarySha256, ignoreCase: true);
        byte[] catalog = scene.Catalog;
        byte[] wall = scene.Capture;
        // B3: the process engine and per-world CreateWorld replace the retired frozen
        // DedicatedServerHostBinding attach/restore delegates. Same-source still holds:
        // LumioEngine.Start verified this build-info identity before any world existed.
        Lumio.GameRuntime.Hosting.LumioEngine engine = SampleWorldHarness.Engine;
        using WorldManager source = engine.CreateWorld(new Lumio.GameRuntime.Hosting.WorldCreationOptions(GeneratedRegistry.Instance)
        {
            InstanceId = 91UL,
            Config = SampleConfigBinding.Load(),
            Catalog = catalog,
            Subsystems = new Lumio.GameRuntime.Ecs.IWorldSubsystem[] { new Lumio.GameRuntime.Hosting.WorldPersistenceSubsystem() },
        });
        source.World.Single<WorldSaveComponent>().TickRate.Value = source.World.Registry.DeclaredTickRateHz;
        Lumio.Engine.NativeLoader.KernelHandle initialHandle = VoxelHandle(source);
        EntityOrder blockedOrder = QueuePlayer(source.World, "native-blocked");
        EntityOrder openOrder = QueuePlayer(source.World, "native-open");
        source.Tick();
        NetEntityId blocked = blockedOrder.AssignedId;
        NetEntityId open = openOrder.AssignedId;
        Assert.Same(AbilityPhysicsBinding.Resolve(source), source.World.Get<AbilityComponent>(blocked).Physics);
        Assert.IsNotType<RecordingAbilityPhysicsPort>(source.World.Get<AbilityComponent>(blocked).Physics);
        PlaceFixturePlayer(source.World, blocked, new Vector3(3f, 4.5f, 4.5f));
        PlaceFixturePlayer(source.World, open, new Vector3(3f, 4.5f, 6.5f));
        AttributeComponent ledger = source.World.Get<AttributeComponent>(blocked);
        long spent = SampleConfigBinding.For(source.World).Stamina.Initial - 1;
        ledger.SetBaseValue(SampleConfigBinding.For(source.World).Stamina.Name, spent);
        byte[] runtime = source.CaptureSnapshot();
        using WorldManager manager = engine.CreateWorld(new Lumio.GameRuntime.Hosting.WorldCreationOptions(GeneratedRegistry.Instance)
        {
            InstanceId = source.World.InstanceId,
            Config = SampleConfigBinding.Load(),
            Catalog = catalog,
            Snapshot = runtime,
            VoxelSnapshot = wall,
            IngressBudget = source.IngressBudget,
            Subsystems = new Lumio.GameRuntime.Ecs.IWorldSubsystem[] { new Lumio.GameRuntime.Hosting.WorldPersistenceSubsystem() },
        });
        Lumio.Engine.NativeLoader.KernelHandle firstHandle = VoxelHandle(manager);
        Assert.NotEqual(initialHandle, firstHandle);
        var sourcePhysics = AbilityPhysicsBinding.Resolve(source);
        var sourceConfig = SampleConfigBinding.For(source.World);
        source.Dispose();
        Assert.Same(AbilityPhysicsBinding.Resolve(manager), manager.World.Get<AbilityComponent>(blocked).Physics);
        Assert.NotSame(sourcePhysics, manager.World.Get<AbilityComponent>(blocked).Physics);
        Assert.Equal(spent, manager.World.Get<AttributeComponent>(blocked).GetBaseValue(sourceConfig.Stamina.Name));
        var input = new MoveAbility.Input { Dx = 1 };
        Assert.True(manager.World.Get<AbilityComponent>(blocked).Activate<MoveAbility, MoveAbility.Input>(in input).Succeeded);
        float boundary = 4f - (float)sourceConfig.Movement.SweepRadiusMeters;
        Assert.InRange(manager.World.Get<LogicTransform>(blocked).LocalPosition.X, boundary - 0.00001f, boundary + 0.00001f);
        Assert.True(manager.World.Get<AbilityComponent>(open).Activate<MoveAbility, MoveAbility.Input>(in input).Succeeded);
        Assert.Equal(new Vector3(3f + (float)sourceConfig.Movement.StepMeters, 4.5f, 6.5f), manager.World.Get<LogicTransform>(open).LocalPosition);
        DualCutCaptureResult capture = SampleWorldHarness.RequireService<Lumio.GameRuntime.Hosting.WorldPersistenceSubsystem>(manager).Capture();
        Assert.True(capture.Succeeded, capture.ErrorCode);
        DualCutCheckpointPayload checkpoint = capture.Checkpoint!.Value;
        Assert.True(checkpoint.SectionCount > 0);
        using WorldManager restored = engine.CreateWorld(new Lumio.GameRuntime.Hosting.WorldCreationOptions(GeneratedRegistry.Instance)
        {
            InstanceId = manager.World.InstanceId,
            Config = SampleConfigBinding.Load(),
            Catalog = catalog,
            Snapshot = checkpoint.Runtime,
            VoxelSnapshot = checkpoint.Voxel,
            IngressBudget = manager.IngressBudget,
            Subsystems = new Lumio.GameRuntime.Ecs.IWorldSubsystem[] { new Lumio.GameRuntime.Hosting.WorldPersistenceSubsystem() },
        });
        Assert.NotEqual(firstHandle, VoxelHandle(restored));
        Assert.NotSame(AbilityPhysicsBinding.Resolve(manager), AbilityPhysicsBinding.Resolve(restored));
        manager.Dispose();
        restored.Tick();
        Vector3 stopped = restored.World.Get<LogicTransform>(blocked).LocalPosition;
        Assert.True(restored.World.Get<AbilityComponent>(blocked).Activate<MoveAbility, MoveAbility.Input>(in input).Succeeded);
        Assert.Equal(stopped, restored.World.Get<LogicTransform>(blocked).LocalPosition);
        Vector3 openBefore = restored.World.Get<LogicTransform>(open).LocalPosition;
        Assert.True(restored.World.Get<AbilityComponent>(open).Activate<MoveAbility, MoveAbility.Input>(in input).Succeeded);
        Assert.Equal(openBefore + new Vector3((float)sourceConfig.Movement.StepMeters, 0, 0), restored.World.Get<LogicTransform>(open).LocalPosition);
        Assert.Equal(spent, restored.World.Get<AttributeComponent>(blocked).GetBaseValue(sourceConfig.Stamina.Name));
        if (evidencePath is not null)
        {
            File.WriteAllText(evidencePath, JsonSerializer.Serialize(new
            {
                native.NativePath, native.BuildId, native.AbiHash, native.BinarySha256,
                Assemblies = new[] { typeof(SampleGameplay).Assembly, typeof(Lumio.GameRuntime.Hosting.LumioEngine).Assembly }
                    .Select(assembly => new { assembly.FullName, assembly.Location, assembly.ManifestModule.ModuleVersionId,
                        Sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))) }),
                InitialWorld = initialHandle.ToString(), FirstWorld = firstHandle.ToString(), ColdWorld = VoxelHandle(restored).ToString(),
                WallCell = "4,4,4", BlockedStart = "3,4.5,4.5", OpenStart = "3,4.5,6.5", Input = "+X",
                HalfExtents = SampleConfigBinding.For(source.World).Movement.SweepRadiusMeters, Step = SampleConfigBinding.For(source.World).Movement.StepMeters,
                PartialBoundaryX = stopped.X, ColdBlockedX = restored.World.Get<LogicTransform>(blocked).LocalPosition.X,
                ColdOpenX = restored.World.Get<LogicTransform>(open).LocalPosition.X,
                OldBindingsDisposedBeforeNewQueries = true, CheckpointSections = checkpoint.SectionCount
            }));
        }
    }

    private static Lumio.Engine.NativeLoader.KernelHandle VoxelHandle(WorldManager manager) =>
        Lumio.GameRuntime.Hosting.NativeWorldVoxelResources.Require(manager).Voxel.NativeHandle;

    /// <summary>The world-owned native voxel identity (B3 KernelHandle); distinct worlds never share one.</summary>
    internal static void PlaceFixturePlayer(World world, NetEntityId player, Vector3 position)
    {
        LogicTransform logic = world.Get<LogicTransform>(player);
        TransformController controller = world.RegisterTransformController(player, nameof(MoveAbility));
        using (logic.BeginWrite(controller)) logic.SetLocalPosition(position);
    }

    public PlayerLifecycleTests()
    {
        Environment.SetEnvironmentVariable(SampleTables.ConfigDirVariable,
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "Server", "Config", "Tables")));
    }

    [Fact]
    public void StartAndHydratePreserveExplicitPhysicsBindings()
    {
        using SampleWorldHarness world = SampleWorldHarness.BootEmpty();
        var managerPort = new RecordingAbilityPhysicsPort();
        using IDisposable binding = AbilityPhysicsBinding.Bind(world.World.Manager, managerPort);
        EntityOrder order = QueuePlayer(world.World, "bound-player");
        world.FlushCreates();
        AbilityComponent owner = world.World.Get<AbilityComponent>(order.AssignedId);
        Assert.Same(managerPort, owner.Physics);
        var componentPort = new RecordingAbilityPhysicsPort();
        owner.Physics = componentPort;
        SampleGameplay.BindPlayer(world.World, order.AssignedId);
        Assert.Same(componentPort, owner.Physics);
        byte[] snapshot = world.World.Manager.CaptureSnapshot();
        using WorldManager restored = SampleWorldHarness.Engine.CreateWorld(new Lumio.GameRuntime.Hosting.WorldCreationOptions(GeneratedRegistry.Instance)
        {
            InstanceId = world.World.InstanceId,
            Config = SampleConfigBinding.Load(),
            Catalog = SampleWorldHarness.OfficialCatalog(),
            RuntimeOnlySnapshot = snapshot,
        });
        Assert.Same(AbilityPhysicsBinding.Resolve(restored), restored.World.Get<AbilityComponent>(order.AssignedId).Physics);
        Assert.NotSame(componentPort, restored.World.Get<AbilityComponent>(order.AssignedId).Physics);
        restored.World.Get<AbilityComponent>(order.AssignedId).Physics = null;
        using IDisposable restoredBinding = AbilityPhysicsBinding.Bind(restored, managerPort);
        SampleGameplay.BindPlayer(restored.World, order.AssignedId);
        Assert.Same(managerPort, restored.World.Get<AbilityComponent>(order.AssignedId).Physics);
    }

    [Fact]
    public void NormalCreateInitializesPlayerOnlyOnTheOwnerTick()
    {
        using SampleWorldHarness world = SampleWorldHarness.BootEmpty();
        ulong before = world.World.Tick;
        EntityOrder order = QueuePlayer(world.World, "lifecycle-player");
        Assert.Equal(before, world.World.Tick);
        Assert.Equal(0UL, order.AssignedId.Counter);
        world.FlushCreates();
        Assert.Equal(before + 1, world.World.Tick);
        AttributeComponent attributes = world.World.Get<AttributeComponent>(order.AssignedId);
        Assert.Equal(SampleConfigBinding.For(world.World).Stamina.Initial, attributes.GetBaseValue(SampleConfigBinding.For(world.World).Stamina.Name));
        Assert.Equal(SampleConfigBinding.For(world.World).Ore.Initial, attributes.GetBaseValue(SampleConfigBinding.For(world.World).Ore.Name));
        Assert.NotNull(world.World.Get<AbilityComponent>(order.AssignedId).ActivationContextFactory);
        Assert.Same(AbilityPhysicsBinding.Resolve(world.World.Manager), world.World.Get<AbilityComponent>(order.AssignedId).Physics);
        Assert.NotEqual(0, world.World.Get<IdentityComponent>(order.AssignedId).ColorHue.Value);
    }

    [Fact]
    public void HydrationPreservesLedgersAndRestoresTransientAbilityBindings()
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        AttributeComponent attributes = world.World.Get<AttributeComponent>(world.Player);
        long spent = SampleConfigBinding.For(world.World).Stamina.Initial - 1;
        long ore = SampleConfigBinding.For(world.World).Ore.Initial + 3;
        attributes.SetBaseValue(SampleConfigBinding.For(world.World).Stamina.Name, spent);
        attributes.SetCurrentValue(SampleConfigBinding.For(world.World).Stamina.Name, spent);
        attributes.SetBaseValue(SampleConfigBinding.For(world.World).Ore.Name, ore);
        attributes.SetCurrentValue(SampleConfigBinding.For(world.World).Ore.Name, ore);
        byte[] snapshot = world.World.Manager.CaptureSnapshot();
        using WorldManager restored = SampleWorldHarness.Engine.CreateWorld(new Lumio.GameRuntime.Hosting.WorldCreationOptions(GeneratedRegistry.Instance)
        {
            InstanceId = world.World.InstanceId,
            Config = SampleConfigBinding.Load(),
            Catalog = SampleWorldHarness.OfficialCatalog(),
            RuntimeOnlySnapshot = snapshot,
        });
        AttributeComponent next = restored.World.Get<AttributeComponent>(world.Player);
        // CURRENT is derived, never serialized; phase 9 uses this same evaluator.
        AttributeEvaluator.Recompute(restored.World);
        Assert.Equal(spent, next.GetBaseValue(SampleConfigBinding.For(world.World).Stamina.Name));
        Assert.Equal(spent, next.GetCurrentValue(SampleConfigBinding.For(world.World).Stamina.Name));
        Assert.Equal(ore, next.GetBaseValue(SampleConfigBinding.For(world.World).Ore.Name));
        Assert.Equal(ore, next.GetCurrentValue(SampleConfigBinding.For(world.World).Ore.Name));
        Assert.NotNull(restored.World.Get<AbilityComponent>(world.Player).ActivationContextFactory);
        Assert.Same(AbilityPhysicsBinding.Resolve(restored), restored.World.Get<AbilityComponent>(world.Player).Physics);
        Assert.NotSame(world.World.Get<AbilityComponent>(world.Player).Physics, restored.World.Get<AbilityComponent>(world.Player).Physics);
    }

    internal static EntityOrder QueuePlayer(World world, string account)
    {
        EntityOrder order = world.Commands.Create<PlayerEntity>();
        EcsRegistry.Generated(order.Get<IdentityComponent>())!.WriteField("accountId", account, silent: true);
        return order;
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(SampleTables.ConfigDirVariable, null);
    }
}

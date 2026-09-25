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
                Assemblies = new[] { typeof(SampleGameplay).Assembly, typeof(DedicatedServerHostBinding).Assembly }
                    .Select(assembly => new { assembly.FullName, assembly.Location, assembly.ManifestModule.ModuleVersionId,
                        Sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))) })
            }));
        // The wall scene is the release's catalog world, authored against this very native image
        // (ADR-117 决策 2: an engine-produced input consumed at run time, not an engine test
        // fixture). Same-source or fail: its evidence must name the native loaded above.
        string fixtures = Lumio.Sample.Tests.EngineRelease.Require(Lumio.Sample.Tests.EngineRelease.CatalogWorldFixture,
            "SMP08 needs the release's catalog world (the wall scene)");
        byte[] catalog = File.ReadAllBytes(Path.Combine(fixtures, "catalog-world.json"));
        byte[] wall = File.ReadAllBytes(Path.Combine(fixtures, "catalog-world.capture"));
        using (JsonDocument evidence = JsonDocument.Parse(File.ReadAllText(Path.Combine(fixtures, "catalog-world-evidence.json"))))
        {
            Assert.Equal(binarySha256, evidence.RootElement.GetProperty("BinarySha256").GetString(), ignoreCase: true);
        }
        // Resolve only the frozen public API; absence is an explicit failed test, never a fallback.
        MethodInfo attachMethod = Assert.IsType<MethodInfo>(typeof(DedicatedServerHostBinding).GetMethod("TryAttach", new[] { typeof(WorldManager), typeof(KernelConfig), typeof(byte[]) }), exactMatch: false);
        MethodInfo restoreMethod = Assert.IsType<MethodInfo>(typeof(DedicatedServerHostBinding).GetMethod("RestoreNew", new[]
        {
            typeof(byte[]), typeof(byte[]), typeof(EcsRegistry), typeof(KernelConfig), typeof(ILoggerFactory), typeof(WorldIngressBudget), typeof(byte[]), typeof(WorldConfigBinding)
        }), exactMatch: false);
        var attach = attachMethod.CreateDelegate<Func<WorldManager, KernelConfig, byte[], DedicatedServerHostBinding?>>();
        var restore = restoreMethod.CreateDelegate<Func<byte[], byte[], EcsRegistry, KernelConfig, ILoggerFactory?, WorldIngressBudget, byte[], WorldConfigBinding, DedicatedServerRestoreResult>>();
        using WorldManager source = SampleGameplay.CreateWorld(91UL);
        source.World.Single<WorldSaveComponent>().TickRate.Value = source.World.Registry.DeclaredTickRateHz;
        using DedicatedServerHostBinding initial = Assert.IsType<DedicatedServerHostBinding>(attach(source, KernelConfigurationFixture.Create(), catalog));
        source.Start(Thread.CurrentThread);
        WorldTickBinding.Bind(source);
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
        DedicatedServerRestoreResult loaded = restore(runtime, wall, GeneratedRegistry.Instance, KernelConfigurationFixture.Create(), null, source.IngressBudget, catalog, SampleConfigBinding.Load());
        Assert.True(loaded.Succeeded, loaded.ErrorCode);
        using DedicatedServerHostBinding first = Assert.IsType<DedicatedServerHostBinding>(loaded.Binding);
        using WorldManager manager = first.Manager;
        Assert.NotEqual(initial.VoxelWorldHandle, first.VoxelWorldHandle);
        initial.Dispose();
        manager.Start(Thread.CurrentThread);
        WorldTickBinding.Bind(manager);
        Assert.Same(AbilityPhysicsBinding.Resolve(manager), manager.World.Get<AbilityComponent>(blocked).Physics);
        Assert.NotSame(AbilityPhysicsBinding.Resolve(source), manager.World.Get<AbilityComponent>(blocked).Physics);
        Assert.Equal(spent, manager.World.Get<AttributeComponent>(blocked).GetBaseValue(SampleConfigBinding.For(source.World).Stamina.Name));
        var input = new MoveAbility.Input { Dx = 1 };
        Assert.True(manager.World.Get<AbilityComponent>(blocked).Activate<MoveAbility, MoveAbility.Input>(in input).Succeeded);
        float boundary = 4f - (float)SampleConfigBinding.For(source.World).Movement.SweepRadiusMeters;
        Assert.InRange(manager.World.Get<LogicTransform>(blocked).LocalPosition.X, boundary - 0.00001f, boundary + 0.00001f);
        Assert.True(manager.World.Get<AbilityComponent>(open).Activate<MoveAbility, MoveAbility.Input>(in input).Succeeded);
        Assert.Equal(new Vector3(3f + (float)SampleConfigBinding.For(source.World).Movement.StepMeters, 4.5f, 6.5f), manager.World.Get<LogicTransform>(open).LocalPosition);
        DualCutCaptureResult capture = first.Capture();
        Assert.True(capture.Succeeded, capture.ErrorCode);
        DualCutCheckpointPayload checkpoint = capture.Checkpoint!.Value;
        Assert.True(checkpoint.SectionCount > 0);
        DedicatedServerRestoreResult cold = restore(checkpoint.Runtime, checkpoint.Voxel, GeneratedRegistry.Instance, KernelConfigurationFixture.Create(), null, manager.IngressBudget, catalog, SampleConfigBinding.Load());
        Assert.True(cold.Succeeded, cold.ErrorCode);
        using DedicatedServerHostBinding second = Assert.IsType<DedicatedServerHostBinding>(cold.Binding);
        using WorldManager restored = second.Manager;
        Assert.NotEqual(first.VoxelWorldHandle, second.VoxelWorldHandle);
        Assert.NotSame(AbilityPhysicsBinding.Resolve(manager), AbilityPhysicsBinding.Resolve(restored));
        first.Dispose();
        restored.Start(Thread.CurrentThread);
        WorldTickBinding.Bind(restored);
        restored.Tick();
        Vector3 stopped = restored.World.Get<LogicTransform>(blocked).LocalPosition;
        Assert.True(restored.World.Get<AbilityComponent>(blocked).Activate<MoveAbility, MoveAbility.Input>(in input).Succeeded);
        Assert.Equal(stopped, restored.World.Get<LogicTransform>(blocked).LocalPosition);
        Vector3 openBefore = restored.World.Get<LogicTransform>(open).LocalPosition;
        Assert.True(restored.World.Get<AbilityComponent>(open).Activate<MoveAbility, MoveAbility.Input>(in input).Succeeded);
        Assert.Equal(openBefore + new Vector3((float)SampleConfigBinding.For(source.World).Movement.StepMeters, 0, 0), restored.World.Get<LogicTransform>(open).LocalPosition);
        Assert.Equal(spent, restored.World.Get<AttributeComponent>(blocked).GetBaseValue(SampleConfigBinding.For(source.World).Stamina.Name));
        if (evidencePath is not null)
        {
            File.WriteAllText(evidencePath, JsonSerializer.Serialize(new
            {
                native.NativePath, native.BuildId, native.AbiHash, native.BinarySha256,
                Assemblies = new[] { typeof(SampleGameplay).Assembly, typeof(DedicatedServerHostBinding).Assembly }
                    .Select(assembly => new { assembly.FullName, assembly.Location, assembly.ManifestModule.ModuleVersionId,
                        Sha256 = Convert.ToHexString(SHA256.HashData(File.ReadAllBytes(assembly.Location))) }),
                InitialWorld = initial.VoxelWorldHandle, FirstWorld = first.VoxelWorldHandle, ColdWorld = second.VoxelWorldHandle,
                WallCell = "4,4,4", BlockedStart = "3,4.5,4.5", OpenStart = "3,4.5,6.5", Input = "+X",
                HalfExtents = SampleConfigBinding.For(source.World).Movement.SweepRadiusMeters, Step = SampleConfigBinding.For(source.World).Movement.StepMeters,
                PartialBoundaryX = stopped.X, ColdBlockedX = restored.World.Get<LogicTransform>(blocked).LocalPosition.X,
                ColdOpenX = restored.World.Get<LogicTransform>(open).LocalPosition.X,
                OldBindingsDisposedBeforeNewQueries = true, CheckpointSections = checkpoint.SectionCount
            }));
        }
    }

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
        using WorldManager restored = WorldManager.CreateFromSnapshot(snapshot, GeneratedRegistry.Instance, config: SampleConfigBinding.Load());
        Assert.Null(restored.World.Get<AbilityComponent>(order.AssignedId).Physics);
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
        Assert.Null(world.World.Get<AbilityComponent>(order.AssignedId).Physics);
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
        using WorldManager restored = WorldManager.CreateFromSnapshot(snapshot, GeneratedRegistry.Instance, config: SampleConfigBinding.Load());
        AttributeComponent next = restored.World.Get<AttributeComponent>(world.Player);
        // CURRENT is derived, never serialized; phase 9 uses this same evaluator.
        AttributeEvaluator.Recompute(restored.World);
        Assert.Equal(spent, next.GetBaseValue(SampleConfigBinding.For(world.World).Stamina.Name));
        Assert.Equal(spent, next.GetCurrentValue(SampleConfigBinding.For(world.World).Stamina.Name));
        Assert.Equal(ore, next.GetBaseValue(SampleConfigBinding.For(world.World).Ore.Name));
        Assert.Equal(ore, next.GetCurrentValue(SampleConfigBinding.For(world.World).Ore.Name));
        Assert.NotNull(restored.World.Get<AbilityComponent>(world.Player).ActivationContextFactory);
        Assert.Null(restored.World.Get<AbilityComponent>(world.Player).Physics);
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

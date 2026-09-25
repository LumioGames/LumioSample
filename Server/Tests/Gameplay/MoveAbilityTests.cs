using System;
using System.Collections.Generic;
using System.IO;
using System.Numerics;
using System.Threading;
using Lumio.Engine.NativeLoader;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.GameRuntime.Persistence;
using Lumio.GameRuntime.Simulation;
using Lumio.Sample.Gameplay;
using Lumio.Sample.Gameplay.Components.Identity;
using Lumio.Sample.Gameplay.Config;
using Lumio.Sample.Gameplay.EntityTypes;
using Xunit;

namespace Lumio.Sample.Gameplay.Tests;

public sealed class MoveAbilityTests
{
    [Fact]
    public void MoveInputRoundTripsThroughTheArgumentVector()
    {
        var input = new MoveAbility.Input { Dx = -1, Dz = 1 };
        var args = new List<object?>();
        input.Write(args);

        var decoded = new MoveAbility.Input();
        Assert.True(decoded.TryRead(args, 0));
        Assert.Equal(input.Dx, decoded.Dx);
        Assert.Equal(input.Dz, decoded.Dz);
    }

    [Fact]
    public void CanActivateRejectsAStationaryIntent()
    {
        Assert.False(new MoveAbility().CanActivate(new MoveAbility.Input { Dx = 0, Dz = 0 }));
        Assert.True(new MoveAbility().CanActivate(new MoveAbility.Input { Dx = 1, Dz = 0 }));
        Assert.True(new MoveAbility().CanActivate(new MoveAbility.Input { Dx = 1, Dz = 1 }));
    }

    [Fact]
    public void MissingPhysicsPortIsRejectedAndLeavesPositionUnchanged()
    {
        var origin = new Vector3(3f, 0f, 4f);
        var input = new MoveAbility.Input { Dx = 1, Dz = 0 };

        bool admitted = MoveAbility.TryAdmitMove(
            input,
            origin,
            stepMeters: 1f,
            hasPhysicsPort: false,
            sweepOk: true,
            collided: false,
            travelFraction: 1f,
            out Vector3 next);

        Assert.False(admitted);
        Assert.Equal(origin, next);
    }

    [Fact]
    public void AbnormalSweepIsRejectedAndLeavesPositionUnchanged()
    {
        var origin = new Vector3(3f, 0f, 4f);
        var input = new MoveAbility.Input { Dx = 1, Dz = 0 };

        bool threw = MoveAbility.TryAdmitMove(
            input,
            origin,
            stepMeters: 1f,
            hasPhysicsPort: true,
            sweepOk: false,
            collided: false,
            travelFraction: 1f,
            out Vector3 afterThrow);
        bool outOfRange = MoveAbility.TryAdmitMove(
            input,
            origin,
            stepMeters: 1f,
            hasPhysicsPort: true,
            sweepOk: true,
            collided: true,
            travelFraction: 2f,
            out Vector3 afterBadFraction);

        Assert.False(threw);
        Assert.Equal(origin, afterThrow);
        Assert.False(outOfRange);
        Assert.Equal(origin, afterBadFraction);
    }

    [Fact]
    public void OversizeStepIsRejectedAndLeavesPositionUnchanged()
    {
        var origin = new Vector3(3f, 0f, 4f);
        var input = new MoveAbility.Input { Dx = 1_000_000, Dz = 0 };

        Assert.False(new MoveAbility().CanActivate(input));

        bool admitted = MoveAbility.TryAdmitMove(
            input,
            origin,
            stepMeters: 1f,
            hasPhysicsPort: true,
            sweepOk: true,
            collided: false,
            travelFraction: 1f,
            out Vector3 next);

        Assert.False(admitted);
        Assert.Equal(origin, next);
    }

    [Fact]
    public void ResolveMoveStopsAtAHardSweepHit()
    {
        var origin = new Vector3(0f, 0f, 0f);
        var displacement = new Vector3(2f, 0f, 0f);
        Vector3 stopped = MoveAbility.ResolveMove(origin, displacement, collided: true, travelFraction: 0f);
        Assert.Equal(origin, stopped);
    }

    [Fact]
    public void ResolveMoveTravelsTheFullDisplacementWhenTheSweepMisses()
    {
        var origin = new Vector3(3f, 0f, 4f);
        var displacement = new Vector3(0f, 0f, 2f);
        Vector3 next = MoveAbility.ResolveMove(origin, displacement, collided: false, travelFraction: 1f);
        Assert.Equal(origin + displacement, next);
    }
}

[Collection("SampleWorld")]
public sealed class MoveAbilityWorldTests : IDisposable
{
    [Theory]
    [InlineData(false, 1f)]
    [InlineData(true, 0f)]
    [InlineData(true, 0.25f)]
    public void BoxAdmissionQueriesOnceBeforeCost(bool collided, float fraction)
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        AbilityComponent owner = world.World.Get<AbilityComponent>(world.Player);
        LogicTransform logic = world.World.Get<LogicTransform>(world.Player);
        Vector3 origin = logic.LocalPosition;
        long balance = 10;
        int writes = 0;
        owner.ActivationContext = new AbilityActivationContext(() => balance, value => { balance = value; writes++; }, _ => { });
        var port = new BoxPort((o, d, h) =>
        {
            Assert.Equal(10, balance);
            Assert.Equal(0, writes);
            Assert.Equal(0, owner.Count);
            Assert.Equal(0UL, owner.GetCooldown(MoveAbility.TypeId));
            Assert.Equal(origin, logic.LocalPosition);
            Assert.Equal(new Vector3((float)SampleConfigBinding.For(world.World).Movement.SweepRadiusMeters), h);
            Assert.Equal(new Vector3((float)SampleConfigBinding.For(world.World).Movement.StepMeters, 0, 0), d);
            return new AbilitySweepHit(collided, fraction, o + d * fraction);
        });
        owner.Physics = port;
        var input = new MoveAbility.Input { Dx = 1 };
        Assert.True(owner.Activate<MoveAbility, MoveAbility.Input>(in input).Succeeded);
        Assert.Equal(origin + new Vector3((float)SampleConfigBinding.For(world.World).Movement.StepMeters * fraction, 0, 0), logic.LocalPosition);
        Assert.Equal(1, port.Queries);
        Assert.Equal(1, writes);
    }

    [Fact]
    public void UnresolvedRejectsBeforeCostWhileOtherPlayerAndLaterInputSucceed()
    {
        using SampleWorldHarness world = SampleWorldHarness.BootEmpty();
        NetEntityId a = world.AdmitPlayer("reject-a");
        NetEntityId b = world.AdmitPlayer("accept-b");
        AbilityComponent owner = world.World.Get<AbilityComponent>(a);
        LogicTransform logic = world.World.Get<LogicTransform>(a);
        Vector3 origin = logic.LocalPosition;
        long balance = 10;
        int writes = 0;
        owner.ActivationContext = new AbilityActivationContext(() => balance, value => { balance = value; writes++; }, _ => { });
        owner.Physics = new BoxPort((_, _, _) => throw new AbilityPhysicsRejectedException("physics_unresolved", "section unavailable"));
        var input = new MoveAbility.Input { Dx = 1 };
        AbilityActivateResult result = owner.Activate<MoveAbility, MoveAbility.Input>(in input, 77);
        Assert.False(result.Succeeded);
        Assert.Equal(5, result.RejectedStep);
        Assert.Equal("physics_unresolved", result.FailureCode);
        Assert.Equal(10, balance);
        Assert.Equal(0, writes);
        Assert.Equal(0, owner.Count);
        Assert.Equal(0UL, owner.GetCooldown(MoveAbility.TypeId));
        Assert.Equal(origin, logic.LocalPosition);
        AbilityComponent other = world.World.Get<AbilityComponent>(b);
        other.Physics = new RecordingAbilityPhysicsPort();
        Vector3 otherOrigin = world.World.Get<LogicTransform>(b).LocalPosition;
        Assert.True(other.Activate<MoveAbility, MoveAbility.Input>(in input).Succeeded);
        Assert.Equal(otherOrigin + new Vector3((float)SampleConfigBinding.For(world.World).Movement.StepMeters, 0, 0), world.World.Get<LogicTransform>(b).LocalPosition);
        world.FlushCreates();
        owner.Physics = new RecordingAbilityPhysicsPort();
        Assert.True(owner.Activate<MoveAbility, MoveAbility.Input>(in input, 77).Succeeded);
        Assert.Equal(origin + new Vector3((float)SampleConfigBinding.For(world.World).Movement.StepMeters, 0, 0), logic.LocalPosition);
        Assert.Equal(1, writes);
    }

    [Fact]
    public void UnknownQueryFaultPreservesOriginalDiagnostic()
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        AbilityComponent owner = world.World.Get<AbilityComponent>(world.Player);
        var fault = new InvalidOperationException("query invariant broke");
        owner.Physics = new BoxPort((_, _, _) => throw fault);
        var input = new MoveAbility.Input { Dx = 1 };
        Assert.Same(fault, Assert.Throws<InvalidOperationException>(() => owner.Activate<MoveAbility, MoveAbility.Input>(in input)));
        Assert.Equal(0, owner.Count);
        Assert.Equal(0UL, owner.GetCooldown(MoveAbility.TypeId));
    }

    [Theory]
    [InlineData(float.NaN)]
    [InlineData(float.PositiveInfinity)]
    [InlineData(-0.1f)]
    [InlineData(1.1f)]
    public void CorruptQueryFractionIsAnInternalFault(float fraction)
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        AbilityComponent owner = world.World.Get<AbilityComponent>(world.Player);
        owner.Physics = new BoxPort((o, _, _) => new AbilitySweepHit(true, fraction, o));
        var input = new MoveAbility.Input { Dx = 1 };
        Assert.Throws<InvalidOperationException>(() => owner.Activate<MoveAbility, MoveAbility.Input>(in input));
        Assert.Equal(0, owner.Count);
        Assert.Equal(0UL, owner.GetCooldown(MoveAbility.TypeId));
    }

    [Theory]
    [InlineData(0, 0)]
    [InlineData(2, 0)]
    [InlineData(int.MinValue, 1)]
    public void InvalidActivationDoesNotQuery(int dx, int dz)
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        AbilityComponent owner = world.World.Get<AbilityComponent>(world.Player);
        var port = new BoxPort((_, _, _) => throw new InvalidOperationException("must not query"));
        owner.Physics = port;
        var input = new MoveAbility.Input { Dx = dx, Dz = dz };
        AbilityActivateResult result = owner.Activate<MoveAbility, MoveAbility.Input>(in input);
        Assert.False(result.Succeeded);
        Assert.Equal(5, result.RejectedStep);
        Assert.Equal(0, port.Queries);
    }

    [Fact]
    public void ConsecutiveActivationsUseCurrentOriginAndDirectExecuteFails()
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        AbilityComponent owner = world.World.Get<AbilityComponent>(world.Player);
        var port = new BoxPort((o, d, _) => new AbilitySweepHit(false, 1, o + d));
        owner.Physics = port;
        var input = new MoveAbility.Input { Dx = 1 };
        Vector3 origin = world.World.Get<LogicTransform>(world.Player).LocalPosition;
        Assert.Throws<InvalidOperationException>(() => new MoveAbility().Execute(in input, owner));
        Assert.True(owner.Activate<MoveAbility, MoveAbility.Input>(in input).Succeeded);
        world.FlushCreates();
        input = new MoveAbility.Input { Dz = -1 };
        Assert.True(owner.Activate<MoveAbility, MoveAbility.Input>(in input).Succeeded);
        Assert.Equal(origin + new Vector3((float)SampleConfigBinding.For(world.World).Movement.StepMeters, 0, -(float)SampleConfigBinding.For(world.World).Movement.StepMeters), world.World.Get<LogicTransform>(world.Player).LocalPosition);
        Assert.Equal(2, port.Queries);
    }

    [Fact]
    public void PreparationCannotSurviveMismatchRefusalOrConsumption()
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        AbilityComponent owner = world.World.Get<AbilityComponent>(world.Player);
        var port = new BoxPort((o, d, _) => new AbilitySweepHit(false, 1, o + d));
        owner.Physics = port;
        var ability = new MoveAbility();
        var input = new MoveAbility.Input { Dx = 1 };
        var mismatch = new MoveAbility.Input { Dz = 1 };
        Assert.True(ability.CanActivate(in input, owner, out _));
        Assert.Throws<InvalidOperationException>(() => ability.Execute(in mismatch, owner));
        Assert.Throws<InvalidOperationException>(() => ability.Execute(in input, owner));
        Assert.True(ability.CanActivate(in input, owner, out _));
        var rejected = new MoveAbility.Input();
        Assert.False(ability.CanActivate(in rejected, owner, out _));
        Assert.Throws<InvalidOperationException>(() => ability.Execute(in input, owner));
        Assert.Equal(2, port.Queries);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void CorruptQueryPointFailsBeforeCost(bool nonfinite)
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        AbilityComponent owner = world.World.Get<AbilityComponent>(world.Player);
        owner.Physics = new BoxPort((o, d, _) => new AbilitySweepHit(false, 1,
            nonfinite ? new Vector3(float.NaN) : o + d + Vector3.One));
        var input = new MoveAbility.Input { Dx = 1 };
        Assert.Throws<InvalidOperationException>(() => owner.Activate<MoveAbility, MoveAbility.Input>(in input));
        Assert.Equal(0, owner.Count);
        Assert.Equal(0UL, owner.GetCooldown(MoveAbility.TypeId));
    }

    private sealed class BoxPort(Func<Vector3, Vector3, Vector3, AbilitySweepHit> query) : IAbilityPhysicsPort
    {
        public int Queries { get; private set; }
        public AbilitySweepHit SweepBox(Vector3 origin, Vector3 displacement, Vector3 halfExtents)
        {
            Queries++;
            return query(origin, displacement, halfExtents);
        }
        public AbilitySweepHit Sweep(Vector3 origin, Vector3 displacement, float radius) => throw new InvalidOperationException("sphere is not AABB");
        public AbilityRayHit Raycast(Vector3 origin, Vector3 direction, float maxDistance) => throw new NotSupportedException();
        public AbilityOverlapHit Overlap(Vector3 center, Vector3 halfExtents) => throw new NotSupportedException();
    }

    public MoveAbilityWorldTests()
    {
        string repoConfig = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "Server", "Config", "Tables"));
        Environment.SetEnvironmentVariable(SampleTables.ConfigDirVariable, repoConfig);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(SampleTables.ConfigDirVariable, null);
    }

    [Fact]
    public void BindPlayerPlacesAnAdmittedPlayerAboveTheCaptureFloor()
    {
        using SampleWorldHarness world = SampleWorldHarness.BootEmpty();
        NetEntityId player = world.AdmitPlayer("acct-spawn");
        Assert.Equal(SampleGameplay.AdmittedPlayerPosition, world.World.Get<LogicTransform>(player).LocalPosition);
        SampleGameplay.BindPlayer(world.World, player);
        Assert.Equal(SampleGameplay.AdmittedPlayerPosition, world.World.Get<LogicTransform>(player).LocalPosition);
        Assert.Equal(1.5f, SampleGameplay.AdmittedPlayerPosition.Y);
        Assert.Equal(16.5f, SampleGameplay.AdmittedPlayerPosition.X);
        Assert.Equal(16.5f, SampleGameplay.AdmittedPlayerPosition.Z);
    }

    [Fact]
    public void NativeSweepAtAdmissionPoseAdmitsAHorizontalStep()
    {
        string nativePath = Lumio.Sample.Tests.EngineRelease.Require(Lumio.Sample.Tests.EngineRelease.NativeLibrary,
            "NativeSweepAtAdmissionPoseAdmitsAHorizontalStep sweeps against the release native");
        using NativeEngineLease native = NativeEngineLoader.LoadFromBuildInfo(nativePath);
        byte[] catalog = File.ReadAllBytes(Path.Combine(RepoRoot(), "Server", "Assets", "Maps", "official-catalog.json"));
        byte[] voxel = File.ReadAllBytes(Path.Combine(RepoRoot(), "Server", "Assets", "Maps", "sample.voxel"));
        using WorldManager source = SampleGameplay.CreateWorld(17UL);
        source.World.Single<WorldSaveComponent>().TickRate.Value = source.World.Registry.DeclaredTickRateHz;
        using DedicatedServerHostBinding attached = Assert.IsType<DedicatedServerHostBinding>(
            DedicatedServerHostBinding.TryAttach(source, KernelConfigurationFixture.Create(), catalog));
        source.Start(Thread.CurrentThread);
        WorldTickBinding.Bind(source);
        EntityOrder order = PlayerLifecycleTests.QueuePlayer(source.World, "acct-native-spawn");
        source.Tick();
        byte[] runtime = source.CaptureSnapshot();
        attached.Dispose();
        DedicatedServerRestoreResult restored = DedicatedServerHostBinding.RestoreNew(
            runtime,
            voxel,
            GeneratedRegistry.Instance,
            KernelConfigurationFixture.Create(),
            null,
            source.IngressBudget,
            catalog,
            SampleConfigBinding.Load());
        Assert.True(restored.Succeeded, restored.ErrorCode);
        using DedicatedServerHostBinding binding = Assert.IsType<DedicatedServerHostBinding>(restored.Binding);
        using WorldManager manager = binding.Manager;
        manager.Start(Thread.CurrentThread);
        WorldTickBinding.Bind(manager);
        NetEntityId player = order.AssignedId;
        Assert.Equal(SampleGameplay.AdmittedPlayerPosition, manager.World.Get<LogicTransform>(player).LocalPosition);
        AbilityComponent abilities = manager.World.Get<AbilityComponent>(player);
        Assert.Same(AbilityPhysicsBinding.Resolve(manager), abilities.Physics);
        var input = new MoveAbility.Input { Dx = 1, Dz = 0 };
        AbilityActivateResult result = abilities.Activate<MoveAbility, MoveAbility.Input>(in input);
        Assert.True(result.Succeeded, result.FailureCode ?? "MoveAbility refused the committed sample.voxel admission pose");
        Assert.Equal(
            SampleGameplay.AdmittedPlayerPosition + new Vector3((float)SampleConfigBinding.For(manager.World).Movement.StepMeters, 0f, 0f),
            manager.World.Get<LogicTransform>(player).LocalPosition);
        _ = native;
    }

    [Fact]
    public void TryAttachRestoresCommittedSampleVoxelAndAdmitsAHorizontalStep()
    {
        string nativePath = Lumio.Sample.Tests.EngineRelease.Require(Lumio.Sample.Tests.EngineRelease.NativeLibrary,
            "TryAttachRestoresCommittedSampleVoxelAndAdmitsAHorizontalStep restores against the release native");
        using NativeEngineLease native = NativeEngineLoader.LoadFromBuildInfo(nativePath);
        byte[] catalog = File.ReadAllBytes(Path.Combine(RepoRoot(), "Server", "Assets", "Maps", "official-catalog.json"));
        byte[] voxel = File.ReadAllBytes(Path.Combine(RepoRoot(), "Server", "Assets", "Maps", "sample.voxel"));
        using WorldManager manager = SampleGameplay.CreateWorld(19UL);
        manager.World.Single<WorldSaveComponent>().TickRate.Value = manager.World.Registry.DeclaredTickRateHz;
        using DedicatedServerHostBinding binding = Assert.IsType<DedicatedServerHostBinding>(
            DedicatedServerHostBinding.TryAttach(manager, KernelConfigurationFixture.Create(), catalog, voxel));
        manager.Start(Thread.CurrentThread);
        WorldTickBinding.Bind(manager);
        EntityOrder order = PlayerLifecycleTests.QueuePlayer(manager.World, "acct-tryattach-spawn");
        manager.Tick();
        NetEntityId player = order.AssignedId;
        Assert.Equal(SampleGameplay.AdmittedPlayerPosition, manager.World.Get<LogicTransform>(player).LocalPosition);
        AbilityComponent abilities = manager.World.Get<AbilityComponent>(player);
        Assert.Same(AbilityPhysicsBinding.Resolve(manager), abilities.Physics);
        var input = new MoveAbility.Input { Dx = 1, Dz = 0 };
        AbilityActivateResult result = abilities.Activate<MoveAbility, MoveAbility.Input>(in input);
        Assert.True(result.Succeeded, result.FailureCode ?? "MoveAbility refused TryAttach-restored sample.voxel");
        Assert.Equal(
            SampleGameplay.AdmittedPlayerPosition + new Vector3((float)SampleConfigBinding.For(manager.World).Movement.StepMeters, 0f, 0f),
            manager.World.Get<LogicTransform>(player).LocalPosition);
        _ = native;
    }

    private static string RepoRoot() =>
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));

    [Fact]
    public void AdmitPlayerActivateMoveChangesLogicTransformWhenPhysicsPortIsPresent()
    {
        using SampleWorldHarness world = SampleWorldHarness.BootEmpty();
        NetEntityId player = world.AdmitPlayer("acct-move");

        Assert.True(world.World.IsLive(player));
        Assert.True(GeneratedRegistry.Instance.TryResolveEntityType("PlayerEntity", out Type entityType));
        Assert.Equal(typeof(PlayerEntity), entityType);
        Assert.Equal(typeof(PlayerEntity), world.World.TypeOf(player).ClrType);
        Assert.True(world.World.TryGetAccount("acct-move", out NetEntityId indexed));
        Assert.Equal(player, indexed);
        Assert.Equal("acct-move", world.World.Get<IdentityComponent>(player).AccountId.Value);

        AbilityComponent abilities = world.World.Get<AbilityComponent>(player);
        Assert.IsType<RecordingAbilityPhysicsPort>(abilities.Physics);

        LogicTransform logic = world.World.Get<LogicTransform>(player);
        Assert.Equal(SampleGameplay.AdmittedPlayerPosition, logic.LocalPosition);
        Vector3 origin = logic.LocalPosition;
        var input = new MoveAbility.Input { Dx = 1, Dz = 0 };
        AbilityActivateResult result = abilities.Activate<MoveAbility, MoveAbility.Input>(in input);

        Assert.True(result.Succeeded, "MoveAbility must admit with the harness's explicit physics port.");
        Assert.Equal(0, result.RejectedStep);
        Vector3 next = logic.LocalPosition;
        Assert.NotEqual(origin, next);
        float step = (float)SampleConfigBinding.For(world.World).Movement.StepMeters;
        Assert.Equal(origin + new Vector3(step, 0f, 0f), next);
    }

    [Fact]
    public void ActivateMoveWithoutPhysicsPortLeavesLogicTransformUnchanged()
    {
        using SampleWorldHarness world = SampleWorldHarness.BootEmpty();
        NetEntityId player = world.AdmitPlayer("acct-fail-closed");
        AbilityComponent abilities = world.World.Get<AbilityComponent>(player);
        abilities.Physics = null;
        Assert.Null(AbilityPhysicsBinding.Resolve(world.World.Manager));
        long balance = 10;
        int writes = 0;
        abilities.ActivationContext = new AbilityActivationContext(() => balance, value => { balance = value; writes++; }, _ => { });

        LogicTransform logic = world.World.Get<LogicTransform>(player);
        Vector3 origin = logic.LocalPosition;
        var input = new MoveAbility.Input { Dx = 1, Dz = 0 };
        AbilityActivateResult result = abilities.Activate<MoveAbility, MoveAbility.Input>(in input);

        Assert.False(result.Succeeded);
        Assert.Equal(5, result.RejectedStep);
        Assert.Equal("physics_unavailable", result.FailureCode);
        Assert.Equal(0UL, abilities.GetCooldown(MoveAbility.TypeId));
        Assert.Equal(0, abilities.Count);
        Assert.Equal(10, balance);
        Assert.Equal(0, writes);
        Assert.Equal(origin, logic.LocalPosition);
    }
}

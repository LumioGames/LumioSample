using System;
using System.Collections.Generic;
using System.IO;
using System.Numerics;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
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
    public MoveAbilityWorldTests()
    {
        string repoConfig = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "config"));
        Environment.SetEnvironmentVariable(SampleTables.ConfigDirVariable, repoConfig);
        SampleTables.ResetCache();
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(SampleTables.ConfigDirVariable, null);
        SampleTables.ResetCache();
        MineAbility.Writer = null;
    }

    [Fact]
    public void AdmitPlayerActivateMoveChangesLogicTransformWhenPhysicsPortIsPresent()
    {
        using SampleWorldHarness world = SampleWorldHarness.BootEmpty();
        NetEntityId player = SampleGameplay.AdmitPlayer(world.World, "acct-move");

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
        Vector3 origin = logic.LocalPosition;
        var input = new MoveAbility.Input { Dx = 1, Dz = 0 };
        AbilityActivateResult result = abilities.Activate<MoveAbility, MoveAbility.Input>(in input);

        Assert.True(result.Succeeded, "MoveAbility must admit when BindPlayer mounted RecordingAbilityPhysicsPort.");
        Assert.Equal(0, result.RejectedStep);
        Vector3 next = logic.LocalPosition;
        Assert.NotEqual(origin, next);
        float step = (float)SampleTables.StepMeters;
        Assert.Equal(origin + new Vector3(step, 0f, 0f), next);
    }

    [Fact]
    public void ActivateMoveWithoutPhysicsPortLeavesLogicTransformUnchanged()
    {
        using SampleWorldHarness world = SampleWorldHarness.BootEmpty();
        NetEntityId player = SampleGameplay.AdmitPlayer(world.World, "acct-fail-closed");
        AbilityComponent abilities = world.World.Get<AbilityComponent>(player);
        abilities.Physics = null;

        LogicTransform logic = world.World.Get<LogicTransform>(player);
        Vector3 origin = logic.LocalPosition;
        var input = new MoveAbility.Input { Dx = 1, Dz = 0 };
        AbilityActivateResult result = abilities.Activate<MoveAbility, MoveAbility.Input>(in input);

        Assert.True(result.Succeeded, "Missing port is Execute fail-closed, not an admit reject.");
        Assert.Equal(origin, logic.LocalPosition);
    }
}

using System.Collections.Generic;
using System.Numerics;
using Lumio.Sample.Gameplay;
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

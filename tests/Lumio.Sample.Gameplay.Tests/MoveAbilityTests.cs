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

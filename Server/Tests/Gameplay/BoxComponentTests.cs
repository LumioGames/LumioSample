using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Components.Box;
using Xunit;

namespace Lumio.Sample.Gameplay.Tests;

/// <summary>
/// Object-level coverage for <see cref="BoxComponent"/> (ADR-119 §4 B3, block-entity.md): the field
/// scopes it declares and the <see cref="BoxComponent.Open"/>/<see cref="BoxComponent.Close"/>
/// membership edit that Runtime's own <c>WorldManager.Claim</c> pass turns into
/// <c>granted</c>/<c>revoked</c> wire events (mirrors the upstream
/// <c>ChestComponent</c>/<c>BlockEntityFixtureTests</c> fixture in LumioGameRuntime). This exercises
/// the component as a plain object — no World/Registry — because <see cref="BoxComponent.Openers"/> is
/// <c>Scope.None</c> bookkeeping the component itself edits; the wire-level granted/revoked distribution
/// this drives is Runtime's own responsibility and is not re-tested here.
/// </summary>
public sealed class BoxComponentTests
{
    [Fact]
    public void FieldsCarryTheDeclaredScopes()
    {
        var box = new BoxComponent();
        // Inventory is the private field (block-entity.md B3): Scope.Claim, gated by Openers.
        Assert.Equal(Scope.Claim, box.Inventory.Scope);
        Assert.Equal(nameof(BoxComponent.Openers), box.Inventory.ClaimBy);
        // Openers itself never rides the wire or a save: Scope.None, and PostAttribute never marks it
        // [Persist] (see BoxComponent.cs) — every box starts closed to everyone after a restart.
        Assert.Equal(Scope.None, box.Openers.Scope);
        Assert.Null(box.Openers.ClaimBy);
    }

    [Fact]
    public void EveryBoxStartsClosedWithEmptyInventory()
    {
        var box = new BoxComponent();
        Assert.Equal(0, box.Openers.Count);
        Assert.Equal(0, box.Inventory.Count);
    }

    [Fact]
    public void OpenAddsTheOpenerExactlyOnceEvenWhenCalledTwice()
    {
        var box = new BoxComponent();
        var opener = new NetEntityId(1, 7);

        box.Open(opener);
        box.Open(opener); // No-op: already open for this connection.

        Assert.Equal(1, box.Openers.Count);
        Assert.Equal(opener, box.Openers[0]);
    }

    [Fact]
    public void CloseRemovesOnlyTheMatchingOpener()
    {
        var box = new BoxComponent();
        var first = new NetEntityId(1, 7);
        var second = new NetEntityId(1, 9);
        box.Open(first);
        box.Open(second);

        box.Close(first);

        Assert.Equal(1, box.Openers.Count);
        Assert.Equal(second, box.Openers[0]);
    }

    [Fact]
    public void CloseOnAConnectionThatNeverOpenedIsANoOp()
    {
        var box = new BoxComponent();
        var opener = new NetEntityId(1, 7);
        box.Open(opener);

        box.Close(new NetEntityId(1, 99));

        Assert.Equal(1, box.Openers.Count);
        Assert.Equal(opener, box.Openers[0]);
    }
}

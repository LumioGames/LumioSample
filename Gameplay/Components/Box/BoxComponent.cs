using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay.Components.Box;

/// <summary>
/// A placed storage box: the sample's block-entity demonstration of private fields (ADR-119
/// §4 B3, <c>block-entity.md</c>). Shared: server and client both compile it; only server writes
/// <see cref="Inventory"/> or <see cref="Openers"/>.
/// <para>
/// <see cref="Name"/> and <see cref="Locked"/> are what every observer holding the box's Section
/// sees (<c>Scope.Aoi</c>). <see cref="Inventory"/> is <c>Scope.Claim</c>, constrained by
/// <see cref="Openers"/>: adding a connection's <see cref="NetEntityId"/> to <see cref="Openers"/>
/// sends that connection the inventory's current full value tagged <c>granted</c>; removing it
/// sends <c>revoked</c> (Runtime's own Scope.Claim membership sync, ADR-119 决策 6 — this
/// component never composes a granted/revoked message itself, it only edits the list).
/// </para>
/// <para><see cref="Openers"/> is <c>Scope.None</c> and carries no <c>[Persist]</c>: it never
/// reaches the wire or a save, so every box starts closed to everyone after a restart or restore.</para>
/// </summary>
[EcsComponent]
public sealed partial class BoxComponent : Component
{
    /// <summary>Drawn: every observer holding the box's Section sees it.</summary>
    [Persist] public Sync<string> Name = new(Scope.Aoi);

    /// <summary>Drawn: whether the box is locked.</summary>
    [Persist] public Sync<bool> Locked = new(Scope.Aoi);

    /// <summary>Private: only sent to a connection currently in <see cref="Openers"/>.</summary>
    [Persist] public SyncList<int> Inventory = new(Scope.Claim, claimBy: nameof(Openers));

    /// <summary>Current openers. Not on the wire, not persisted (ADR-119 §4 B3).</summary>
    public SyncList<NetEntityId> Openers = new(Scope.None);
}

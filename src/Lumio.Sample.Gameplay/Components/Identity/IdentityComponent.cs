using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay.Components.Identity;

/// <summary>Player and bot identity component providing admission account binding.</summary>
[EcsComponent]
public sealed partial class IdentityComponent : Component
{
    /// <summary>Display name visible to room.</summary>
    [Persist]
    public Sync<string> Name = new(Scope.Room, Authority.Owner);
}

using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay.Components.Identity;

/// <summary>Player and bot identity component providing admission account binding.</summary>
[EcsComponent]
public sealed partial class IdentityComponent : Component
{
    /// <summary>Display name visible to room.</summary>
    [Persist]
    public Sync<string> Name = new(Scope.Room, Authority.Owner);

    /// <summary>
    /// Stable hue (0-359) the server stamps at admission from the account id.
    /// The value itself replicates at Room scope: every client reads the same
    /// color out of the world snapshot instead of deriving it locally.
    /// Deliberately not <c>[Persist]</c>: it is re-stamped on every admission,
    /// so the snapshot schema of existing stores stays untouched.
    /// </summary>
    public Sync<int> ColorHue = new(Scope.Room, Authority.Server);
}

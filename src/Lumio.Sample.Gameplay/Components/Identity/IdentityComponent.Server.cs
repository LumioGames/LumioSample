using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay.Components.Identity;

public sealed partial class IdentityComponent
{
    /// <summary>Account identity binding. Server private.</summary>
    [Persist]
    public Sync<string> AccountId = new(Scope.None);
}

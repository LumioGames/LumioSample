using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay.Components.Identity;

public sealed partial class IdentityComponent
{
    /// <summary>Account identity binding. Server private.</summary>
    [Persist]
    public Sync<string> AccountId = new(Scope.None);

    protected override void Awake()
    {
        _ = Config.SampleConfigBinding.For(World);
    }

    protected override void Start()
    {
        SampleGameplay.BindPlayer(World, Entity);
        ColorHue.Value = SampleGameplay.StableAccountHue(AccountId.Value ?? string.Empty);
    }

    protected override void OnHydrate()
    {
        _ = Config.SampleConfigBinding.For(World);
        SampleGameplay.BindPlayer(World, Entity);
        ColorHue.Value = SampleGameplay.StableAccountHue(AccountId.Value ?? string.Empty);
    }
}

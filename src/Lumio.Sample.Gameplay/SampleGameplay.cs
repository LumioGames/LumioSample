using System;
using System.Diagnostics.CodeAnalysis;
using System.Numerics;
using System.Runtime.CompilerServices;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.Sample.Gameplay.Config;

[assembly: InternalsVisibleTo("Lumio.Sample.Gameplay.Tests")]

namespace Lumio.Sample.Gameplay;

/// <summary>Thread-local owner for <see cref="MineAbility.CanActivate"/>. R-00468 G2 does not pass owner yet.</summary>
public static class SampleAbilityAdmission
{
    [ThreadStatic]
    private static AbilityComponent? _owner;

    /// <summary>Owner of the Activate currently being admitted. Set by BindPlayer's cost reader for generic Activate.</summary>
    public static AbilityComponent? CurrentOwner
    {
        get => _owner;
        set => _owner = value;
    }
}

/// <summary>Sample catalog hooks: Effect register, player seed, and mine Activate with admission owner.</summary>
public static class SampleGameplay
{
    [SuppressMessage("Usage", "CA2255", Justification = "DS loads this assembly as application code; the catalog must register on load.")]
    [ModuleInitializer]
    internal static void RegisterCatalog()
    {
        PickupOreEffect.Register();
    }

    /// <summary>Boots a server world with the generated registry. Hosts and tests share this entry.</summary>
    public static WorldManager CreateWorld(ulong instanceId) =>
        WorldManager.Create(GeneratedRegistry.Instance, instanceId, config: SampleConfigBinding.Load());

    /// <summary>Binds transient ability ports to the player's existing ledgers.</summary>
    public static void BindPlayer(World world, NetEntityId player)
    {
#if NET5_0_OR_GREATER
        ArgumentNullException.ThrowIfNull(world);
#else
        if (world is null) throw new ArgumentNullException(nameof(world));
#endif
        if (!world.IsLive(player))
            throw new InvalidOperationException("BindPlayer requires a live player.");

        AttributeComponent attributes = world.Get<AttributeComponent>(player);

        AbilityComponent abilities = world.Get<AbilityComponent>(player);
        string stamina = SampleConfigBinding.For(world).Stamina.Name;
        // R-00468 G2 still rejects only when the cost Base is <= 0. Map "below table cost" to 0 so
        // insufficient stamina is admit step 3 on today's engine. Execute still deducts the table cost from Base.
        // Generic Activate (AbilityComponent.Activate / catalog RPC) uses this context; readCostBase
        // publishes the owner so CanActivate can see the world without SampleGameplay.ActivateMine.
        abilities.ActivationContext = new AbilityActivationContext(
            () =>
            {
                SampleAbilityAdmission.CurrentOwner = abilities;
                return attributes.GetBaseValue(stamina) < SampleConfigBinding.For(world).Mining.StaminaCost ? 0L : attributes.GetBaseValue(stamina);
            },
            _ => { },
            _ => attributes.SetCurrentValue(stamina, attributes.GetBaseValue(stamina)));
        PlaceAdmittedPlayer(world, player);
    }

    /// <summary>
    /// Capture floor is y=0 with a one-cell wall at y=1. Default LogicTransform
    /// is the origin, which SweepBox cannot answer without sealing the DS.
    /// MoveAbility is the sole writer; this is the admission pose, not a step.
    /// Y is the open-cell height already proven by
    /// <c>RealHostAabbWallAndOpenMovementSurviveColdRestore</c> (y=4.5).
    /// Wave B r13 issued MoveAbility from (16.5, 1.5, 16.5) and every replica
    /// stayed there: the configured AABB at y=1.5 overlaps unwritten y=1 interior
    /// cells, which SweepBox reports as unresolved rather than air.
    /// </summary>
    internal static readonly Vector3 AdmittedPlayerPosition = new(16.5f, 4.5f, 16.5f);

    private static void PlaceAdmittedPlayer(World world, NetEntityId player)
    {
        LogicTransform logic = world.Get<LogicTransform>(player);
        if (logic.LocalPosition != Vector3.Zero) return;
        TransformController controller = world.RegisterTransformController(player, nameof(MoveAbility));
        using (logic.BeginWrite(controller))
            logic.SetLocalPosition(AdmittedPlayerPosition);
    }

    /// <summary>Generic Activate. Owner for CanActivate comes from <see cref="BindPlayer"/>'s context, not this wrapper.</summary>
    public static AbilityActivateResult ActivateMine(AbilityComponent owner, in MineAbility.Input input, ulong sequence = 0)
    {
#if NET5_0_OR_GREATER
        ArgumentNullException.ThrowIfNull(owner);
#else
        if (owner is null) throw new ArgumentNullException(nameof(owner));
#endif
        return owner.Activate<MineAbility, MineAbility.Input>(in input, sequence);
    }

    /// <summary>
    /// Deterministic per-person hue (FNV-1a over the account id, no RNG). The
    /// server stamps it once at admission and the replicated field carries it
    /// to every client; clients never re-derive the color.
    /// </summary>
    internal static int StableAccountHue(string accountId)
    {
        uint hash = 2166136266u;
        foreach (char letter in accountId)
        {
            hash ^= letter;
            hash *= 16777619u;
        }

        return (int)(hash % 360u);
    }
}

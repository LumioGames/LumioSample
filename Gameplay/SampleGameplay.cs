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
public static partial class SampleGameplay
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
    [SuppressMessage("Design", "CA1510", Justification = "Keep netstandard2.1 compatibility without conditional source branches.")]
    public static void BindPlayer(World world, NetEntityId player)
    {
        if (world is null) throw new ArgumentNullException(nameof(world));
        if (!world.IsLive(player))
            throw new InvalidOperationException("BindPlayer requires a live player.");

        AttributeComponent attributes = world.Get<AttributeComponent>(player);

        AbilityComponent abilities = world.Get<AbilityComponent>(player);
        string stamina = SampleConfigBinding.For(world).Stamina.Name;
        // R-00468 G2 still rejects only when the cost Base is <= 0. Map "below table cost" to 0 so
        // insufficient stamina is admit step 3 on today's engine. Execute still deducts the table cost from Base.
        // Generic Activate (AbilityComponent.Activate / catalog RPC) uses this context; readCostBase
        // publishes the owner so CanActivate can see the world without SampleGameplay.ActivateMine.
        var mining = new AbilityActivationContext(
            () =>
            {
                SampleAbilityAdmission.CurrentOwner = abilities;
                return attributes.GetBaseValue(stamina) < SampleConfigBinding.For(world).Mining.StaminaCost ? 0L : attributes.GetBaseValue(stamina);
            },
            _ => { },
            _ => attributes.SetCurrentValue(stamina, attributes.GetBaseValue(stamina)));
        // Per-ability selection (engine/wire/ability-context-selection-v1): only MineAbility pays stamina.
        // MoveAbility and PickupAbility return null and get the engine's built-in costless context, so a
        // tired player can still walk to the drop and pick it up. Rebound on every Start / OnHydrate.
        abilities.ActivationContextFactory = ability => ability == typeof(MineAbility) ? mining : null;
        PlaceAdmittedPlayer(world, player);
    }

    /// <summary>
    /// Admission pose placement (<c>SampleGameplay.Server.cs</c>). Admission runs only on the
    /// authoritative world, so the client build carries no implementation and no call.
    /// </summary>
    static partial void PlaceAdmittedPlayer(World world, NetEntityId player);

    internal static void PlaceDrop(World world, NetEntityId drop, Vector3 position)
    {
        LogicTransform logic = world.Get<LogicTransform>(drop);
        TransformController controller = world.RegisterTransformController(drop, nameof(MineAbility));
        using (logic.BeginWrite(controller)) logic.SetLocalPosition(position);
    }

    /// <summary>Generic Activate. Owner for CanActivate comes from <see cref="BindPlayer"/>'s context, not this wrapper.</summary>
    [SuppressMessage("Design", "CA1510", Justification = "Keep netstandard2.1 compatibility without conditional source branches.")]
    public static AbilityActivateResult ActivateMine(AbilityComponent owner, in MineAbility.Input input, ulong sequence = 0)
    {
        if (owner is null) throw new ArgumentNullException(nameof(owner));
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

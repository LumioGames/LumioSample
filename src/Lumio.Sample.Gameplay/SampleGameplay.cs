using System;
using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.Sample.Gameplay.Components.Identity;
using Lumio.Sample.Gameplay.Config;
using Lumio.Sample.Gameplay.EntityTypes;

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
        SampleAttributeSeed.Register();
        PickupOreEffect.Register();
    }

    /// <summary>Boots a server world with the generated registry. Hosts and tests share this entry.</summary>
    public static WorldManager CreateWorld(ulong instanceId) =>
        WorldManager.Create(GeneratedRegistry.Instance, instanceId);

    /// <summary>Seeds the four ledgers and wires cost admit to the stamina Base book.</summary>
    public static void BindPlayer(World world, NetEntityId player)
    {
        ArgumentNullException.ThrowIfNull(world);
        if (!world.IsLive(player))
            throw new InvalidOperationException("BindPlayer requires a live player.");

        AttributeComponent attributes = world.Get<AttributeComponent>(player);
        SampleAttributeSeed.ApplyTo(attributes);

        AbilityComponent abilities = world.Get<AbilityComponent>(player);
        string stamina = SampleTables.StaminaAttributeName;
        // R-00468 G2 still rejects only when the cost Base is <= 0. Map "below table cost" to 0 so
        // insufficient stamina is admit step 3 on today's engine. Execute still deducts the table cost from Base.
        // Generic Activate (AbilityComponent.Activate / catalog RPC) uses this context; readCostBase
        // publishes the owner so CanActivate can see the world without SampleGameplay.ActivateMine.
        abilities.ActivationContext = new AbilityActivationContext(
            () =>
            {
                SampleAbilityAdmission.CurrentOwner = abilities;
                return attributes.GetBaseValue(stamina) < SampleTables.StaminaCost ? 0L : attributes.GetBaseValue(stamina);
            },
            _ => { },
            _ => attributes.SetCurrentValue(stamina, attributes.GetBaseValue(stamina)));
        // Open-space sweep so in-process Activate<MoveAbility> can write LogicTransform.
        // Execute stays fail-closed when this port is missing.
        abilities.Physics = new RecordingAbilityPhysicsPort();
    }

    /// <summary>
    /// Appears a <see cref="PlayerEntity"/>, binds GAS (including the open-space physics port),
    /// and stamps Identity.accountId so <see cref="World.TryGetAccount"/> can find it.
    /// Spectator connections use this same type; there is no spectator entity.
    /// </summary>
    public static NetEntityId AdmitPlayer(World world, string accountId)
    {
        ArgumentNullException.ThrowIfNull(world);
        ArgumentException.ThrowIfNullOrWhiteSpace(accountId);

        EntityOrder order = world.Commands.Create<PlayerEntity>();
        // IndexAccount runs at Attach; stamp the order before Tick so TryGetAccount works after appear.
        WriteAccountId(order.Get<IdentityComponent>(), accountId);
        WriteColorHue(order.Get<IdentityComponent>(), accountId, silent: true);
        world.Manager.Tick();

        NetEntityId player = order.AssignedId;
        if (player.Counter == 0 || !world.IsLive(player))
            throw new InvalidOperationException("AdmitPlayer requires the create to appear on Tick.");

        BindPlayer(world, player);
        WriteAccountId(world.Get<IdentityComponent>(player), accountId);
        // Non-silent on the live entity: the hue must dirty-track so it rides
        // the replication wire (create record / FieldChange) to every client.
        // A silent write here would leave every client painting the default.
        WriteColorHue(world.Get<IdentityComponent>(player), accountId, silent: false);
        return player;
    }

    /// <summary>Generic Activate. Owner for CanActivate comes from <see cref="BindPlayer"/>'s context, not this wrapper.</summary>
    public static AbilityActivateResult ActivateMine(AbilityComponent owner, in MineAbility.Input input, ulong sequence = 0)
    {
        ArgumentNullException.ThrowIfNull(owner);
        return owner.Activate<MineAbility, MineAbility.Input>(in input, sequence);
    }

    private static void WriteAccountId(IdentityComponent identity, string accountId)
    {
        if (EcsRegistry.Generated(identity) is not IGeneratedComponent generated)
            return;
        generated.WriteField("accountId", accountId, silent: true);
    }

    private static void WriteColorHue(IdentityComponent identity, string accountId, bool silent)
    {
        if (EcsRegistry.Generated(identity) is not IGeneratedComponent generated)
            return;
        generated.WriteField("colorHue", StableAccountHue(accountId), silent);
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

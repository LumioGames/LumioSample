using System;
using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.Sample.Gameplay.Config;

namespace Lumio.Sample.Gameplay;

/// <summary>Thread-local owner for <see cref="MineAbility.CanActivate"/>. R-00468 G2 does not pass owner yet.</summary>
public static class SampleAbilityAdmission
{
    [ThreadStatic]
    private static AbilityComponent? _owner;

    /// <summary>Owner of the Activate currently being admitted. Null outside <see cref="SampleGameplay.ActivateMine"/>.</summary>
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
        abilities.ActivationContext = new AbilityActivationContext(
            () => attributes.GetBaseValue(stamina) < SampleTables.StaminaCost ? 0L : attributes.GetBaseValue(stamina),
            _ => { },
            _ => attributes.SetCurrentValue(stamina, attributes.GetBaseValue(stamina)));
    }

    /// <summary>Activate mine with the admission owner so <see cref="MineAbility.CanActivate"/> can see the world.</summary>
    public static AbilityActivateResult ActivateMine(AbilityComponent owner, in MineAbility.Input input, ulong sequence = 0)
    {
        ArgumentNullException.ThrowIfNull(owner);
        SampleAbilityAdmission.CurrentOwner = owner;
        try
        {
            return owner.Activate<MineAbility, MineAbility.Input>(in input, sequence);
        }
        finally
        {
            SampleAbilityAdmission.CurrentOwner = null;
        }
    }
}

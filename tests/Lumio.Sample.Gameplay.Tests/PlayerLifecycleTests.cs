using System;
using System.IO;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.Sample.Gameplay;
using Lumio.Sample.Gameplay.Components.Identity;
using Lumio.Sample.Gameplay.Config;
using Lumio.Sample.Gameplay.EntityTypes;
using Xunit;

namespace Lumio.Sample.Gameplay.Tests;

[Collection("SampleWorld")]
public sealed class PlayerLifecycleTests : IDisposable
{
    public PlayerLifecycleTests()
    {
        Environment.SetEnvironmentVariable(SampleTables.ConfigDirVariable,
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "config")));
        SampleTables.ResetCache();
    }

    [Fact]
    public void StartAndHydratePreserveExplicitPhysicsBindings()
    {
        using SampleWorldHarness world = SampleWorldHarness.BootEmpty();
        var managerPort = new RecordingAbilityPhysicsPort();
        using IDisposable binding = AbilityPhysicsBinding.Bind(world.World.Manager, managerPort);
        EntityOrder order = QueuePlayer(world.World, "bound-player");
        world.FlushCreates();
        AbilityComponent owner = world.World.Get<AbilityComponent>(order.AssignedId);
        Assert.Same(managerPort, owner.Physics);
        var componentPort = new RecordingAbilityPhysicsPort();
        owner.Physics = componentPort;
        SampleGameplay.BindPlayer(world.World, order.AssignedId);
        Assert.Same(componentPort, owner.Physics);
        byte[] snapshot = world.World.Manager.CaptureSnapshot();
        using WorldManager restored = WorldManager.CreateFromSnapshot(snapshot, GeneratedRegistry.Instance);
        Assert.Null(restored.World.Get<AbilityComponent>(order.AssignedId).Physics);
        using IDisposable restoredBinding = AbilityPhysicsBinding.Bind(restored, managerPort);
        SampleGameplay.BindPlayer(restored.World, order.AssignedId);
        Assert.Same(managerPort, restored.World.Get<AbilityComponent>(order.AssignedId).Physics);
    }

    [Fact]
    public void NormalCreateInitializesPlayerOnlyOnTheOwnerTick()
    {
        using SampleWorldHarness world = SampleWorldHarness.BootEmpty();
        ulong before = world.World.Tick;
        EntityOrder order = QueuePlayer(world.World, "lifecycle-player");
        Assert.Equal(before, world.World.Tick);
        Assert.Equal(0UL, order.AssignedId.Counter);
        world.FlushCreates();
        Assert.Equal(before + 1, world.World.Tick);
        AttributeComponent attributes = world.World.Get<AttributeComponent>(order.AssignedId);
        Assert.Equal(SampleTables.StaminaInitial, attributes.GetBaseValue(SampleTables.StaminaAttributeName));
        Assert.Equal(SampleTables.OreInitial, attributes.GetBaseValue(SampleTables.OreAttributeName));
        Assert.NotNull(world.World.Get<AbilityComponent>(order.AssignedId).ActivationContext);
        Assert.Null(world.World.Get<AbilityComponent>(order.AssignedId).Physics);
        Assert.NotEqual(0, world.World.Get<IdentityComponent>(order.AssignedId).ColorHue.Value);
    }

    [Fact]
    public void HydrationPreservesLedgersAndRestoresTransientAbilityBindings()
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        AttributeComponent attributes = world.World.Get<AttributeComponent>(world.Player);
        long spent = SampleTables.StaminaInitial - 1;
        long ore = SampleTables.OreInitial + 3;
        attributes.SetBaseValue(SampleTables.StaminaAttributeName, spent);
        attributes.SetCurrentValue(SampleTables.StaminaAttributeName, spent);
        attributes.SetBaseValue(SampleTables.OreAttributeName, ore);
        attributes.SetCurrentValue(SampleTables.OreAttributeName, ore);
        byte[] snapshot = world.World.Manager.CaptureSnapshot();
        using WorldManager restored = WorldManager.CreateFromSnapshot(snapshot, GeneratedRegistry.Instance);
        AttributeComponent next = restored.World.Get<AttributeComponent>(world.Player);
        // CURRENT is derived, never serialized; phase 9 uses this same evaluator.
        AttributeEvaluator.Recompute(restored.World);
        Assert.Equal(spent, next.GetBaseValue(SampleTables.StaminaAttributeName));
        Assert.Equal(spent, next.GetCurrentValue(SampleTables.StaminaAttributeName));
        Assert.Equal(ore, next.GetBaseValue(SampleTables.OreAttributeName));
        Assert.Equal(ore, next.GetCurrentValue(SampleTables.OreAttributeName));
        Assert.NotNull(restored.World.Get<AbilityComponent>(world.Player).ActivationContext);
        Assert.Null(restored.World.Get<AbilityComponent>(world.Player).Physics);
    }

    internal static EntityOrder QueuePlayer(World world, string account)
    {
        EntityOrder order = world.Commands.Create<PlayerEntity>();
        EcsRegistry.Generated(order.Get<IdentityComponent>())!.WriteField("accountId", account, silent: true);
        return order;
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(SampleTables.ConfigDirVariable, null);
        SampleTables.ResetCache();
        MineAbility.Writer = null;
    }
}

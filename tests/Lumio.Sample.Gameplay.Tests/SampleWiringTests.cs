using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text.Json;
using System.Threading;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.Sample.Gameplay;
using Lumio.Sample.Gameplay.Components.Ore;
using Lumio.Sample.Gameplay.Components.Vein;
using Lumio.Sample.Gameplay.Config;
using Lumio.Sample.Gameplay.EntityTypes;
using Xunit;

namespace Lumio.Sample.Gameplay.Tests;

[CollectionDefinition("SampleWorld", DisableParallelization = true)]
public sealed class SampleWorldSerialDefinition
{
}

[Collection("SampleWorld")]
public sealed class SampleWiringTests : IDisposable
{
    private readonly string _repoConfig;

    public SampleWiringTests()
    {
        _repoConfig = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "config"));
        PointAt(_repoConfig);
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(SampleTables.ConfigDirVariable, null);
        SampleTables.ResetCache();
    }

    [Fact]
    public void SeedCreatesFourLedgersFromAttributesTable()
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        AttributeComponent attrs = world.World.Get<AttributeComponent>(world.Player);
        Assert.Equal(SampleTables.StaminaInitial, attrs.GetBaseValue(SampleTables.StaminaAttributeName));
        Assert.Equal(SampleTables.StaminaInitial, attrs.GetCurrentValue(SampleTables.StaminaAttributeName));
        Assert.Equal(SampleTables.OreInitial, attrs.GetBaseValue(SampleTables.OreAttributeName));
        Assert.Equal(SampleTables.OreInitial, attrs.GetCurrentValue(SampleTables.OreAttributeName));
        Assert.Contains(SampleTables.StaminaAttributeName, attrs.AttributeNames);
        Assert.Contains(SampleTables.OreAttributeName, attrs.AttributeNames);
    }

    [Fact]
    public void VeinPostAttributeSeedsRemainingFromMiningTable()
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        VeinReserveComponent reserve = world.World.Get<VeinReserveComponent>(world.Vein);
        Assert.Equal(SampleTables.VeinHitsToBreak, reserve.Remaining.Value);
    }

    [Fact]
    public void SparseBindIsFalseWithoutAHostPort()
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        Assert.False(SampleVein.TryBind(world.Vein, binding: null, sectionKey: 1, cellOffset: 1));
    }

    [Fact]
    public void SparseBindDelegatesToTheHostPort()
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        var port = new RecordingVoxelBinding();
        Assert.True(SampleVein.TryBind(world.Vein, port, sectionKey: 1, cellOffset: 2));
        Assert.Equal(world.Vein, port.VeinId);
        Assert.Equal(1UL, port.SectionKey);
        Assert.Equal(2, port.CellOffset);
    }

    [Fact]
    public void CanActivateRejectsUnparsedHexAndMissingOwner()
    {
        var ability = new MineAbility();
        Assert.False(ability.CanActivate(new MineAbility.Input { TargetHex = "not-hex" }));
        Assert.False(ability.CanActivate(new MineAbility.Input { TargetHex = "0000000000000001" }));
    }

    [Fact]
    public void MineDeductsStaminaBaseAndLeavesCurrentUntouchedUntilCopy()
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        long staminaBefore = world.StaminaBase;
        int remainingBefore = world.Remaining;
        long currentBefore = world.StaminaCurrent;

        AbilityActivateResult result = world.Mine();
        Assert.True(result.Succeeded, "mine should succeed while stamina covers the table cost");
        Assert.Equal(0, result.RejectedStep);
        Assert.Equal(staminaBefore - SampleTables.StaminaCost, world.StaminaBase);
        Assert.Equal(remainingBefore - 1, world.Remaining);
        Assert.Equal(currentBefore, world.StaminaCurrent);
    }

    [Fact]
    public void InsufficientStaminaRejectsAtCostStepAndWritesNothing()
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        Assert.True(world.Mine().Succeeded);
        long stamina = world.StaminaBase;
        int remaining = world.Remaining;
        OnFxLog.Items.Clear();

        AbilityActivateResult result = world.Mine();
        Assert.False(result.Succeeded);
        Assert.Equal(3, result.RejectedStep);
        Assert.Equal(stamina, world.StaminaBase);
        Assert.Equal(remaining, world.Remaining);
        Assert.Empty(OnFxLog.Items);
    }

    [Fact]
    public void ExhaustingTheVeinQueuesAnOreDropWithTableAmount()
    {
        using TempConfig config = TempConfig.WithHits(1);
        PointAt(config.Directory);
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        Assert.Equal(1, world.Remaining);

        Assert.True(world.Mine().Succeeded);
        Assert.Equal(0, world.Remaining);
        world.FlushCreates();

        OrePileComponent? pile = null;
        foreach (OrePileComponent item in world.World.Each<OrePileComponent>())
            pile = item;
        Assert.NotNull(pile);
        Assert.Equal(SampleTables.OrePerVein, pile!.Amount.Value);
    }

    [Fact]
    public void PickupOreEffectIsRegisteredAndCreditsOreBase()
    {
        PickupOreEffect.Register();
        Assert.Equal(PickupOreEffect.TypeId, EffectTypeCatalog.TypeIdOf(typeof(PickupOreEffect)));

        using TempConfig config = TempConfig.WithHits(1);
        PointAt(config.Directory);
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        long oreBefore = world.OreBase;
        Assert.True(world.Mine().Succeeded);
        world.FlushCreates();

        NetEntityId drop = default;
        foreach (OrePileComponent pile in world.World.Each<OrePileComponent>())
            drop = pile.Entity;
        Assert.True(world.World.IsLive(drop));

        OnFxLog.Items.Clear();
        Assert.True(SampleOrePickup.TryPickup(world.World, world.Player, drop));
        Assert.Equal(oreBefore + SampleTables.OrePerVein, world.OreBase);
        Assert.Contains(OnFxLog.Items, row => row.FxKey == PickupOreEffect.FxKeyName);
    }

    [Fact]
    public void MineAbilityCostNameMatchesAttributesTable()
    {
        object[] attrs = typeof(MineAbility).GetCustomAttributes(inherit: false);
        AbilityTypeAttribute? mark = null;
        foreach (object attr in attrs)
        {
            if (attr is AbilityTypeAttribute typed)
                mark = typed;
        }

        Assert.NotNull(mark);
        Assert.Equal(SampleTables.StaminaAttributeName, mark!.Cost);
    }

    private static void PointAt(string directory)
    {
        Environment.SetEnvironmentVariable(SampleTables.ConfigDirVariable, directory);
        SampleTables.ResetCache();
    }
}

internal sealed class RecordingVoxelBinding : ISampleVoxelBinding
{
    public NetEntityId VeinId { get; private set; }
    public ulong SectionKey { get; private set; }
    public int CellOffset { get; private set; }

    public bool TryBind(NetEntityId veinId, ulong sectionKey, int cellOffset)
    {
        VeinId = veinId;
        SectionKey = sectionKey;
        CellOffset = cellOffset;
        return true;
    }
}

internal sealed class TempConfig : IDisposable
{
    private TempConfig(string directory) => Directory = directory;

    public string Directory { get; }

    public static TempConfig WithHits(int hits)
    {
        string repo = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "config"));
        string dir = Path.Combine(Path.GetTempPath(), "lumio-sample-wiring-" + Guid.NewGuid().ToString("N"));
        System.IO.Directory.CreateDirectory(dir);
        foreach (string file in System.IO.Directory.GetFiles(repo, "*.json"))
            File.Copy(file, Path.Combine(dir, Path.GetFileName(file)));

        string miningPath = Path.Combine(dir, "mining.json");
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(miningPath));
        var values = new Dictionary<string, JsonElement>(StringComparer.Ordinal);
        foreach (JsonProperty property in document.RootElement.EnumerateObject())
            values[property.Name] = property.Value.Clone();

        using var stream = new MemoryStream();
        using (var writer = new Utf8JsonWriter(stream))
        {
            writer.WriteStartObject();
            foreach (KeyValuePair<string, JsonElement> pair in values)
            {
                writer.WritePropertyName(pair.Key);
                if (string.Equals(pair.Key, "vein_hits_to_break", StringComparison.Ordinal))
                    writer.WriteNumberValue(hits);
                else
                    pair.Value.WriteTo(writer);
            }

            writer.WriteEndObject();
        }

        File.WriteAllBytes(miningPath, stream.ToArray());
        return new TempConfig(dir);
    }

    public void Dispose()
    {
        try { System.IO.Directory.Delete(Directory, recursive: true); }
        catch (IOException)
        {
        }
    }
}

internal sealed class SampleWorldHarness : IDisposable
{
    private readonly WorldManager _manager;

    private SampleWorldHarness(WorldManager manager, NetEntityId player, NetEntityId vein)
    {
        _manager = manager;
        Player = player;
        Vein = vein;
    }

    public World World => _manager.World;
    public NetEntityId Player { get; }
    public NetEntityId Vein { get; }
    public long StaminaBase => World.Get<AttributeComponent>(Player).GetBaseValue(SampleTables.StaminaAttributeName);
    public long StaminaCurrent => World.Get<AttributeComponent>(Player).GetCurrentValue(SampleTables.StaminaAttributeName);
    public long OreBase => World.Get<AttributeComponent>(Player).GetBaseValue(SampleTables.OreAttributeName);
    public int Remaining => World.Get<VeinReserveComponent>(Vein).Remaining.Value;

    public static SampleWorldHarness Boot()
    {
        WorldManager manager = SampleGameplay.CreateWorld(11UL);
        manager.World.Single<WorldSaveComponent>().TickRate.Value = manager.World.Registry.DeclaredTickRateHz;
        manager.Start(Thread.CurrentThread);

        MethodInfo commit = typeof(WorldManager).GetMethod("CommitCommandBuffer", BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("WorldManager.CommitCommandBuffer is missing; cannot appear entities without Simulation.");
        manager.BindTickLoop(new CommitTickLoop(manager, commit));

        EntityOrder player = manager.World.Commands.Create<PlayerEntity>();
        EntityOrder vein = SampleVein.Queue(manager.World);
        manager.Tick();
        SampleGameplay.BindPlayer(manager.World, player.AssignedId);
        return new SampleWorldHarness(manager, player.AssignedId, vein.AssignedId);
    }

    public AbilityActivateResult Mine()
    {
        var input = new MineAbility.Input { TargetHex = Vein.ToHex() };
        AbilityComponent abilities = World.Get<AbilityComponent>(Player);
        return SampleGameplay.ActivateMine(abilities, in input);
    }

    public void FlushCreates() => _manager.Tick();

    public void Dispose() => _manager.Dispose();

    private sealed class CommitTickLoop : IWorldTickLoop
    {
        private readonly WorldManager _manager;
        private readonly MethodInfo _commit;

        public CommitTickLoop(WorldManager manager, MethodInfo commit)
        {
            _manager = manager;
            _commit = commit;
        }

        public void ExecuteTick() => _commit.Invoke(_manager, null);
    }
}

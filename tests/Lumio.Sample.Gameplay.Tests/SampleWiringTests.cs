using System;
using System.IO;
using System.Reflection;
using System.Linq;
using System.Threading;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.GameRuntime.Coordination;
using Lumio.GameRuntime.Simulation;
using Lumio.Sample.Gameplay;
using Lumio.Sample.Gameplay.Components.Ore;
using Lumio.Sample.Gameplay.Components.Vein;
using Lumio.Sample.Gameplay.Config;
using Lumio.Sample.Gameplay.EntityTypes;
using Xunit;

namespace Lumio.Sample.Gameplay.Tests;

[CollectionDefinition("SampleWorld", DisableParallelization = true)]
public sealed class SampleWorldSerialDefinition : ICollectionFixture<SampleWorldNativeFixture>
{
}

public sealed class SampleWorldNativeFixture : IDisposable
{
    public SampleWorldNativeFixture()
    {
        GasHfsmFacade.BindNative(KernelConfigurationFixture.Create());
    }

    public void Dispose() => GasHfsmFacade.Unbind();
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
    }

    [Fact]
    public void MineAbilityDoesNotClaimAVoxelWrite()
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        world.VoxelWriter = null;
        Assert.False(MineAbility.TryRequestAirWrite(world.World, world.Vein));
    }

    [Fact]
    public void VoxelWritersAreIsolatedAndStaleLeaseCannotDetachReplacement()
    {
        using SampleWorldHarness first = SampleWorldHarness.Boot();
        using SampleWorldHarness second = SampleWorldHarness.Boot();
        using IDisposable old = SampleVoxelWriterBinding.Bind(first.World.Manager, new FailingVoxelWriter());
        Assert.False(MineAbility.TryRequestAirWrite(first.World, first.Vein));
        Assert.True(MineAbility.TryRequestAirWrite(second.World, second.Vein));
        using IDisposable replacement = SampleVoxelWriterBinding.Bind(first.World.Manager, new SucceedingVoxelWriter());
        old.Dispose();
        Assert.True(MineAbility.TryRequestAirWrite(first.World, first.Vein));
        replacement.Dispose();
        Assert.False(MineAbility.TryRequestAirWrite(first.World, first.Vein));
        Assert.True(MineAbility.TryRequestAirWrite(second.World, second.Vein));
    }

    [Fact]
    public void SeedCreatesFourLedgersFromAttributesTable()
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        AttributeComponent attrs = world.World.Get<AttributeComponent>(world.Player);
        Assert.Equal(SampleConfigBinding.For(world.World).Stamina.Initial, attrs.GetBaseValue(SampleConfigBinding.For(world.World).Stamina.Name));
        Assert.Equal(SampleConfigBinding.For(world.World).Stamina.Initial, attrs.GetCurrentValue(SampleConfigBinding.For(world.World).Stamina.Name));
        Assert.Equal(SampleConfigBinding.For(world.World).Ore.Initial, attrs.GetBaseValue(SampleConfigBinding.For(world.World).Ore.Name));
        Assert.Equal(SampleConfigBinding.For(world.World).Ore.Initial, attrs.GetCurrentValue(SampleConfigBinding.For(world.World).Ore.Name));
        Assert.Contains(SampleConfigBinding.For(world.World).Stamina.Name, attrs.AttributeNames);
        Assert.Contains(SampleConfigBinding.For(world.World).Ore.Name, attrs.AttributeNames);
    }

    [Fact]
    public void VeinPostAttributeSeedsRemainingFromMiningTable()
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        VeinReserveComponent reserve = world.World.Get<VeinReserveComponent>(world.Vein);
        Assert.Equal(SampleConfigBinding.For(world.World).Mining.VeinHitsToBreak, reserve.Remaining.Value);
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
    public void GenericActivateWithoutActivateMineWrapperStillAdmits()
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        var input = new MineAbility.Input { TargetHex = world.Vein.ToHex() };
        AbilityComponent abilities = world.World.Get<AbilityComponent>(world.Player);
        AbilityActivateResult result = abilities.Activate<MineAbility, MineAbility.Input>(in input);
        Assert.True(result.Succeeded);
        Assert.Equal(0, result.RejectedStep);
    }

    [Fact]
    public void NativeRefusingAnAdmittedFinalDigIsAnEngineFaultNotABusinessOutcome()
    {
        // tick.md §3 rule 5: once the terrain order passes phase-3 admission the hit settles at once.
        // A dig Native later refuses at phase 8 is therefore an engine fault (the classic
        // "stamina paid, block still there"), surfaced on the next Advance instead of swallowed.
        using TempConfig config = TempConfig.WithHits(1);
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        long stamina = world.StaminaBase;
        long cost = SampleConfigBinding.For(world.World).Mining.StaminaCost;
        VeinReserveComponent vein = world.World.Get<VeinReserveComponent>(world.Vein);
        VoxelCellQuery cell = world.Adapter.Read(vein.SectionKey.Value, vein.CellOffset.Value);
        // A foreign write to the same section commits first, so the dig carries a stale section revision.
        Assert.Equal(VoxelStageStatus.Staged, world.Adapter.TryStageWrite(
            new[] { new VoxelWriteEntry(vein.SectionKey.Value, 0, 0, cell.SectionRevision) }, "competing-write").Status);
        Assert.True(world.Mine().Succeeded);
        Assert.Equal(stamina - cost, world.StaminaBase);
        Assert.Equal(0, world.Remaining);
        world.FlushCreates();
        Assert.Single(world.World.Each<OrePileComponent>());
        Assert.NotEqual(0U, world.Adapter.Read(vein.SectionKey.Value, vein.CellOffset.Value).BlockId);
        InvalidOperationException fault = Assert.Throws<InvalidOperationException>(world.FlushCreates);
        Assert.Contains("Native refused admitted dig", fault.ToString(), StringComparison.Ordinal);
    }

    [Fact]
    public void SecondFinalDigInTheSameSectionWaitsForTheNextFrame()
    {
        // Native validates the frame-initial revision per section, so two digs in one section in
        // one frame would refuse the second at commit. CanMine keeps that conflict out at admission.
        using TempConfig config = TempConfig.WithHits(1);
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        VeinReserveComponent first = world.World.Get<VeinReserveComponent>(world.Vein);
        VeinReserveComponent second = world.World.Each<VeinReserveComponent>()
            .First(vein => vein.Entity != world.Vein && vein.SectionKey.Value == first.SectionKey.Value);
        NetEntityId other = world.AdmitPlayer("same-section");
        PlayerLifecycleTests.PlaceFixturePlayer(world.World, other, second.CellCenter);
        AbilityComponent otherAbilities = world.World.Get<AbilityComponent>(other);
        long otherStamina = world.World.Get<AttributeComponent>(other).GetBaseValue("Stamina");
        var otherInput = new MineAbility.Input { TargetHex = second.Entity.ToHex() };

        Assert.True(world.Mine().Succeeded);
        AbilityActivateResult blocked = SampleGameplay.ActivateMine(otherAbilities, in otherInput);
        Assert.False(blocked.Succeeded);
        Assert.Equal(5, blocked.RejectedStep);
        Assert.Equal(otherStamina, world.World.Get<AttributeComponent>(other).GetBaseValue("Stamina"));
        Assert.Equal(1, second.Remaining.Value);
        world.FlushCreates();
        Assert.Single(world.World.Each<OrePileComponent>());

        Assert.True(SampleGameplay.ActivateMine(otherAbilities, in otherInput).Succeeded);
        Assert.Equal(0, second.Remaining.Value);
        world.FlushCreates();
        Assert.Equal(2, world.World.Each<OrePileComponent>().Count());
        Assert.False(world.World.IsLive(second.Entity));
    }

    [Fact]
    public void RejectedStep1WhenOwnerIsDead()
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        AbilityComponent abilities = world.World.Get<AbilityComponent>(world.Player);
        var input = new MineAbility.Input { TargetHex = world.Vein.ToHex() };
        world.World.Commands.Destroy(world.Player);
        world.FlushCreates();
        AbilityActivateResult result = abilities.Activate<MineAbility, MineAbility.Input>(in input);
        Assert.False(result.Succeeded);
        Assert.Equal(1, result.RejectedStep);
    }

    [Fact]
    public void RejectedStep2WhenOnCooldown()
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        AbilityComponent abilities = world.World.Get<AbilityComponent>(world.Player);
        abilities.SetCooldown(MineAbility.TypeId, world.World.Tick + 10);
        AbilityActivateResult result = world.Mine();
        Assert.False(result.Succeeded);
        Assert.Equal(2, result.RejectedStep);
        Assert.Equal(SampleConfigBinding.For(world.World).Mining.VeinHitsToBreak, world.Remaining);
    }

    [Fact]
    public void RejectedStep5WhenTargetIsNotLive()
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        world.World.Commands.Destroy(world.Vein);
        world.FlushCreates();
        AbilityActivateResult result = world.Mine();
        Assert.False(result.Succeeded);
        Assert.Equal(5, result.RejectedStep);
    }

    [Fact]
    public void MiningALivePlayerIsRejectedWithoutSideEffects()
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        long stamina = world.StaminaBase;
        int remaining = world.Remaining;
        AbilityComponent abilities = world.World.Get<AbilityComponent>(world.Player);
        var input = new MineAbility.Input { TargetHex = world.Player.ToHex() };

        AbilityActivateResult result = SampleGameplay.ActivateMine(abilities, in input);

        Assert.False(result.Succeeded);
        Assert.Equal(5, result.RejectedStep);
        Assert.Equal(stamina, world.StaminaBase);
        Assert.Equal(remaining, world.Remaining);
        world.FlushCreates();
        Assert.Empty(world.World.Each<OrePileComponent>());
        Assert.True(world.World.IsLive(world.Player));
        Assert.True(world.World.IsLive(world.Vein));
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
        Assert.Equal(staminaBefore - SampleConfigBinding.For(world.World).Mining.StaminaCost, world.StaminaBase);
        Assert.Equal(remainingBefore - 1, world.Remaining);
        Assert.Equal(currentBefore, world.StaminaCurrent);
    }

    [Fact]
    public void InsufficientStaminaRejectsAtCostStepAndWritesNothing()
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        world.World.Get<AttributeComponent>(world.Player).SetBaseValue(
            SampleConfigBinding.For(world.World).Stamina.Name,
            SampleConfigBinding.For(world.World).Mining.StaminaCost + 1);
        Assert.True(world.Mine().Succeeded);
        // GAS sets cooldown to Tick+1 on a successful Activate. Advance one tick so
        // admit step 2 is clear and the remaining single stamina fails step 3.
        world.FlushCreates();
        long stamina = world.StaminaBase;
        int remaining = world.Remaining;
        int fxBefore = OnFxLog.ForWorld(world.World).Count;

        AbilityActivateResult result = world.Mine();
        Assert.False(result.Succeeded);
        Assert.Equal(3, result.RejectedStep);
        Assert.Equal(stamina, world.StaminaBase);
        Assert.Equal(remaining, world.Remaining);
        Assert.Equal(fxBefore, OnFxLog.ForWorld(world.World).Count);
    }

    [Fact]
    public void ExhaustingTheVeinQueuesAnOreDropWithTableAmount()
    {
        using TempConfig config = TempConfig.WithHits(1);
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        Assert.Equal(1, world.Remaining);

        Assert.True(world.Mine().Succeeded);
        VeinReserveComponent reserve = world.World.Get<VeinReserveComponent>(world.Vein);
        Assert.Equal(0, reserve.Remaining.Value);
        Assert.Empty(world.World.Each<OrePileComponent>());
        world.Adapter.DigApplied += _ => Assert.Equal(0, reserve.Remaining.Value);
        world.FlushCreates();
        Assert.False(world.World.IsLive(world.Vein));

        OrePileComponent? pile = null;
        foreach (OrePileComponent item in world.World.Each<OrePileComponent>())
            pile = item;
        Assert.NotNull(pile);
        Assert.Equal(SampleConfigBinding.For(world.World).Mining.OrePerVein, pile!.Amount.Value);
    }

    [Fact]
    public void PickupOreEffectIsRegisteredAndCreditsOreBase()
    {
        PickupOreEffect.Register();
        Assert.Equal(PickupOreEffect.TypeId, EffectTypeCatalog.TypeIdOf(typeof(PickupOreEffect)));

        using TempConfig config = TempConfig.WithHits(1);
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        long oreBefore = world.OreBase;
        Assert.True(world.Mine().Succeeded);
        world.FlushCreates();

        NetEntityId drop = default;
        foreach (OrePileComponent pile in world.World.Each<OrePileComponent>())
            drop = pile.Entity;
        Assert.True(world.World.IsLive(drop));

        AbilityActivateResult picked = world.Pickup(drop);
        Assert.True(picked.Succeeded, picked.FailureCode);
        // Execute only queued the slip and the destroy; the ledger moves when phase 9 settles.
        Assert.Equal(oreBefore, world.OreBase);
        Assert.True(world.World.IsLive(drop));
        world.FlushCreates();
        Assert.Equal(oreBefore + SampleConfigBinding.For(world.World).Mining.OrePerVein, world.OreBase);
        Assert.False(world.World.IsLive(drop));
        Assert.Contains(OnFxLog.ForWorld(world.World), row => row.FxKey == PickupOreEffect.FxKeyName);
    }

    [Fact]
    public void StaminaBelowMiningCostStillAdmitsMoveAndRejectsMineWithoutSideEffects()
    {
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        AbilityComponent abilities = world.World.Get<AbilityComponent>(world.Player);
        Assert.NotNull(abilities.ActivationContextFactory);
        world.World.Get<AttributeComponent>(world.Player).SetBaseValue(SampleConfigBinding.For(world.World).Stamina.Name, 9);
        Assert.True(9 < SampleConfigBinding.For(world.World).Mining.StaminaCost);
        int remaining = world.Remaining;

        AbilityActivateResult mine = world.Mine();
        Assert.False(mine.Succeeded);
        Assert.Equal(3, mine.RejectedStep);
        Assert.Equal(9, world.StaminaBase);
        Assert.Equal(remaining, world.Remaining);
        Assert.Equal(0, abilities.Count);

        System.Numerics.Vector3 origin = world.World.Get<LogicTransform>(world.Player).LocalPosition;
        var step = new MoveAbility.Input { Dx = 1 };
        AbilityActivateResult moved = abilities.Activate<MoveAbility, MoveAbility.Input>(in step);
        Assert.True(moved.Succeeded, moved.FailureCode);
        Assert.NotEqual(origin, world.World.Get<LogicTransform>(world.Player).LocalPosition);
        Assert.Equal(9, world.StaminaBase);
        world.FlushCreates();
        Assert.Empty(world.World.Each<OrePileComponent>());
    }

    [Fact]
    public void StaminaBelowMiningCostStillAdmitsPickup()
    {
        using TempConfig config = TempConfig.WithHits(1);
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        Assert.True(world.Mine().Succeeded);
        world.FlushCreates();
        NetEntityId drop = Assert.Single(world.World.Each<OrePileComponent>()).Entity;
        world.World.Get<AttributeComponent>(world.Player).SetBaseValue(SampleConfigBinding.For(world.World).Stamina.Name, 9);
        long oreBefore = world.OreBase;

        AbilityActivateResult picked = world.Pickup(drop);
        Assert.True(picked.Succeeded, picked.FailureCode);
        world.FlushCreates();
        Assert.Equal(oreBefore + SampleConfigBinding.For(world.World).Mining.OrePerVein, world.OreBase);
        Assert.Equal(9, world.StaminaBase);
        Assert.Empty(world.World.Each<OrePileComponent>());
    }

    [Fact]
    public void TwoPlayersFinalHitOnTheSameVeinInOneFrameSettlesOnlyOnce()
    {
        using TempConfig config = TempConfig.WithHits(1);
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        NetEntityId rival = world.AdmitPlayer("rival-miner");
        VeinReserveComponent vein = world.World.Get<VeinReserveComponent>(world.Vein);
        PlayerLifecycleTests.PlaceFixturePlayer(world.World, rival, vein.CellCenter);
        AbilityComponent rivalAbilities = world.World.Get<AbilityComponent>(rival);
        Assert.True(MineAbility.WithinReach(rivalAbilities, world.Vein));
        long cost = SampleConfigBinding.For(world.World).Mining.StaminaCost;
        long stamina = world.StaminaBase;
        long rivalStamina = world.World.Get<AttributeComponent>(rival).GetBaseValue("Stamina");
        var input = new MineAbility.Input { TargetHex = world.Vein.ToHex() };

        Assert.True(world.Mine().Succeeded);
        AbilityActivateResult second = SampleGameplay.ActivateMine(rivalAbilities, in input);
        Assert.False(second.Succeeded);
        Assert.Equal(5, second.RejectedStep);
        Assert.Equal(stamina - cost, world.StaminaBase);
        Assert.Equal(rivalStamina, world.World.Get<AttributeComponent>(rival).GetBaseValue("Stamina"));
        Assert.Equal(0, rivalAbilities.Count);
        Assert.Equal(0UL, rivalAbilities.GetCooldown(MineAbility.TypeId));
        world.FlushCreates();
        Assert.Single(world.World.Each<OrePileComponent>());
        Assert.False(world.World.IsLive(world.Vein));
        Assert.Equal(rivalStamina, world.World.Get<AttributeComponent>(rival).GetBaseValue("Stamina"));
    }

    [Fact]
    public void TwoPlayersPickingTheSameDropInOneFrameCashItOnce()
    {
        using TempConfig config = TempConfig.WithHits(1);
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        Assert.True(world.Mine().Succeeded);
        world.FlushCreates();
        NetEntityId drop = Assert.Single(world.World.Each<OrePileComponent>()).Entity;
        NetEntityId rival = world.AdmitPlayer("rival-picker");
        PlayerLifecycleTests.PlaceFixturePlayer(world.World, rival, world.World.Get<LogicTransform>(drop).LocalPosition);
        AbilityComponent rivalAbilities = world.World.Get<AbilityComponent>(rival);
        string ore = SampleConfigBinding.For(world.World).Ore.Name;
        long oreBefore = world.OreBase;
        long rivalOreBefore = world.World.Get<AttributeComponent>(rival).GetBaseValue(ore);
        var input = new PickupAbility.Input { TargetHex = drop.ToHex() };
        Assert.True(PickupAbility.WithinReach(rivalAbilities, drop));

        Assert.True(world.Pickup(drop).Succeeded);
        AbilityActivateResult second = rivalAbilities.Activate<PickupAbility, PickupAbility.Input>(in input);
        Assert.False(second.Succeeded);
        Assert.Equal(5, second.RejectedStep);
        Assert.Equal("pickup_target_gone", second.FailureCode);
        world.FlushCreates();
        Assert.Equal(oreBefore + SampleConfigBinding.For(world.World).Mining.OrePerVein, world.OreBase);
        Assert.Equal(rivalOreBefore, world.World.Get<AttributeComponent>(rival).GetBaseValue(ore));
        Assert.Empty(world.World.Each<OrePileComponent>());
        Assert.Single(OnFxLog.ForWorld(world.World), row => row.FxKey == PickupOreEffect.FxKeyName);
    }

    [Fact]
    public void RepeatedSequenceForMineAndPickupNeverPaysTwice()
    {
        using TempConfig config = TempConfig.WithHits(1);
        using SampleWorldHarness world = SampleWorldHarness.Boot();
        long cost = SampleConfigBinding.For(world.World).Mining.StaminaCost;
        long stamina = world.StaminaBase;

        Assert.True(world.Mine(sequence: 41).Succeeded);
        AbilityActivateResult replayedMine = world.Mine(sequence: 41);
        Assert.False(replayedMine.Succeeded);
        Assert.Equal(0, replayedMine.RejectedStep); // duplicate, refused before admission
        Assert.Equal(stamina - cost, world.StaminaBase);
        world.FlushCreates();
        NetEntityId drop = Assert.Single(world.World.Each<OrePileComponent>()).Entity;
        Assert.Equal(stamina - cost, world.StaminaBase);
        long oreBefore = world.OreBase;

        Assert.True(world.Pickup(drop, sequence: 42).Succeeded);
        AbilityActivateResult replayedPickup = world.Pickup(drop, sequence: 42);
        Assert.False(replayedPickup.Succeeded);
        Assert.Equal(0, replayedPickup.RejectedStep);
        world.FlushCreates();
        Assert.Equal(oreBefore + SampleConfigBinding.For(world.World).Mining.OrePerVein, world.OreBase);
        AbilityActivateResult afterCommit = world.Pickup(drop, sequence: 42);
        Assert.False(afterCommit.Succeeded);
        Assert.Equal(oreBefore + SampleConfigBinding.For(world.World).Mining.OrePerVein, world.OreBase);
    }

    [Fact]
    public void MineAbilityCostNameMatchesAttributesTable()
    {
        using SampleWorldHarness world = SampleWorldHarness.BootEmpty();
        object[] attrs = typeof(MineAbility).GetCustomAttributes(inherit: false);
        AbilityTypeAttribute? mark = null;
        foreach (object attr in attrs)
        {
            if (attr is AbilityTypeAttribute typed)
                mark = typed;
        }

        Assert.NotNull(mark);
        Assert.Equal(SampleConfigBinding.For(world.World).Stamina.Name, mark!.Cost);
    }

    private static void PointAt(string directory)
    {
        Environment.SetEnvironmentVariable(SampleTables.ConfigDirVariable, directory);
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

internal sealed class SucceedingVoxelWriter : ISampleVoxelWriter
{
    public bool TryWriteAir(NetEntityId veinId)
    {
        _ = veinId;
        return true;
    }
}

internal sealed class FailingVoxelWriter : ISampleVoxelWriter
{
    public bool TryWriteAir(NetEntityId veinId)
    {
        _ = veinId;
        return false;
    }
}

internal sealed class TempConfig : IDisposable
{
    private readonly string? _previous = Environment.GetEnvironmentVariable(SampleTables.ConfigDirVariable);
    private TempConfig(string directory) => Directory = directory;

    public string Directory { get; }

    public static TempConfig WithHits(int hits)
    {
        string repo = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        string directory = Path.Combine(Path.GetTempPath(), "sample527-" + Guid.NewGuid().ToString("N"));
        var result = new TempConfig(directory);
        string source = Path.Combine(directory, "source");
        string export = Path.Combine(directory, "export");
        foreach (string file in System.IO.Directory.GetFiles(Path.Combine(repo, "config", "source"), "*", SearchOption.AllDirectories))
        {
            string target = Path.Combine(source, Path.GetRelativePath(Path.Combine(repo, "config", "source"), file));
            System.IO.Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            File.Copy(file, target);
        }
        string table = Path.Combine(source, "tables", "mining.txt");
        File.WriteAllText(table, File.ReadAllText(table).Replace("| 6 |", "| " + hits + " |", StringComparison.Ordinal));
        var start = new System.Diagnostics.ProcessStartInfo(OperatingSystem.IsWindows() ? "py" : "python3") { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true };
        if (OperatingSystem.IsWindows()) start.ArgumentList.Add("-3");
        string compiler = Environment.GetEnvironmentVariable("LUMIO_CONFIG_ROOT") ?? Path.GetFullPath(Path.Combine(repo, "..", "LumioConfig"));
        foreach (string argument in new[] { Path.Combine(compiler, "tools", "lumio_config.py"), "export", "--root", source, "--out", export }) start.ArgumentList.Add(argument);
        using var process = System.Diagnostics.Process.Start(start)!;
        string output = process.StandardOutput.ReadToEnd();
        string error = process.StandardError.ReadToEnd();
        process.WaitForExit();
        if (process.ExitCode != 0) throw new InvalidOperationException(output + error);
        Environment.SetEnvironmentVariable(SampleTables.ConfigDirVariable, export);
        return result;
    }

    public void Dispose()
    {
        Environment.SetEnvironmentVariable(SampleTables.ConfigDirVariable, _previous);
        System.IO.Directory.Delete(Directory, recursive: true);
    }
}

internal sealed class SampleWorldHarness : IDisposable
{
    private readonly WorldManager _manager;
    private IDisposable? _writerBinding;
    private DedicatedServerHostBinding? _host;
    public DedicatedServerHostBinding Host => _host!;
    public HostVoxelWorldAdapter Adapter => VoxelGameplayBinding.Resolve(_manager)!;

    private SampleWorldHarness(WorldManager manager, NetEntityId player, NetEntityId vein)
    {
        _manager = manager;
        VoxelWriter = new SucceedingVoxelWriter();
        Player = player;
        Vein = vein;
    }

    public World World => _manager.World;
    public ISampleVoxelWriter? VoxelWriter
    {
        set
        {
            _writerBinding?.Dispose();
            _writerBinding = value is null ? null : SampleVoxelWriterBinding.Bind(_manager, value);
        }
    }
    public NetEntityId Player { get; }
    public NetEntityId Vein { get; }
    public long StaminaBase => World.Get<AttributeComponent>(Player).GetBaseValue(SampleConfigBinding.For(World).Stamina.Name);
    public long StaminaCurrent => World.Get<AttributeComponent>(Player).GetCurrentValue(SampleConfigBinding.For(World).Stamina.Name);
    public long OreBase => World.Get<AttributeComponent>(Player).GetBaseValue(SampleConfigBinding.For(World).Ore.Name);
    public int Remaining => World.Get<VeinReserveComponent>(Vein).Remaining.Value;

    public static SampleWorldHarness Boot()
    {
        WorldManager manager = SampleGameplay.CreateWorld(11UL);
        string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        DedicatedServerHostBinding host = Assert.IsType<DedicatedServerHostBinding>(
            DedicatedServerHostBinding.TryAttach(manager, KernelConfigurationFixture.Create(),
                File.ReadAllBytes(Path.Combine(root, "maps", "official-catalog.json")),
                File.ReadAllBytes(Path.Combine(root, "maps", "sample.voxel"))));
        manager.Start(Thread.CurrentThread);
        WorldTickBinding.Bind(manager);
        EntityOrder player = manager.World.Commands.Create<PlayerEntity>();
        for (int i = 0; i < 4; i++) manager.Tick();
        VeinReserveComponent vein = manager.World.Each<VeinReserveComponent>().First();
        PlayerLifecycleTests.PlaceFixturePlayer(manager.World, player.AssignedId, vein.CellCenter);
        AbilityComponent abilities = manager.World.Get<AbilityComponent>(player.AssignedId);
        Assert.True(MineAbility.WithinReach(abilities, vein.Entity));
        Assert.True(MineAbility.AdmitTarget(abilities, vein.Entity));
        abilities.Physics = new RecordingAbilityPhysicsPort();
        return new SampleWorldHarness(manager, player.AssignedId, vein.Entity) { _host = host };
    }

    /// <summary>Started world with no player; tests explicitly drive the Owner tick.</summary>
    public static SampleWorldHarness BootEmpty() => new(StartManager(), default, default);

    public NetEntityId AdmitPlayer(string accountId)
    {
        EntityOrder order = PlayerLifecycleTests.QueuePlayer(World, accountId);
        _manager.Tick();
        World.Get<AbilityComponent>(order.AssignedId).Physics = new RecordingAbilityPhysicsPort();
        return order.AssignedId;
    }

    private static WorldManager StartManager()
    {
        WorldManager manager = SampleGameplay.CreateWorld(11UL);
        manager.World.Single<WorldSaveComponent>().TickRate.Value = manager.World.Registry.DeclaredTickRateHz;
        manager.Start(Thread.CurrentThread);

        MethodInfo commit = typeof(WorldManager).GetMethod("CommitCommandBuffer", BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("WorldManager.CommitCommandBuffer is missing; cannot appear entities without Simulation.");
        MethodInfo publish = typeof(WorldManager).GetMethod("PublishEgress", BindingFlags.Instance | BindingFlags.NonPublic)
            ?? throw new InvalidOperationException("WorldManager.PublishEgress is missing; GAS one-tick cooldown cannot expire.");
        manager.BindTickLoop(new CommitTickLoop(manager, commit, publish));
        return manager;
    }

    public AbilityActivateResult Mine(ulong sequence = 0)
    {
        var input = new MineAbility.Input { TargetHex = Vein.ToHex() };
        AbilityComponent abilities = World.Get<AbilityComponent>(Player);
        return SampleGameplay.ActivateMine(abilities, in input, sequence);
    }

    public AbilityActivateResult Pickup(NetEntityId drop, ulong sequence = 0)
    {
        var input = new PickupAbility.Input { TargetHex = drop.ToHex() };
        AbilityComponent abilities = World.Get<AbilityComponent>(Player);
        return abilities.Activate<PickupAbility, PickupAbility.Input>(in input, sequence);
    }

    public void FlushCreates() => _manager.Tick();

    public void Dispose()
    {
        _writerBinding?.Dispose();
        _host?.Dispose();
        _manager.Dispose();
    }

    private sealed class CommitTickLoop : IWorldTickLoop
    {
        private readonly WorldManager _manager;
        private readonly MethodInfo _commit;
        private readonly MethodInfo _publish;

        public CommitTickLoop(WorldManager manager, MethodInfo commit, MethodInfo publish)
        {
            _manager = manager;
            _commit = commit;
            _publish = publish;
        }

        public void ExecuteTick()
        {
            _commit.Invoke(_manager, null);
            _publish.Invoke(_manager, null);
        }
    }
}

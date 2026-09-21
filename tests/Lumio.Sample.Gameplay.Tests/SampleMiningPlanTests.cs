using System;
using System.Collections.Generic;
using System.IO;
using System.Text.Json;
using System.Text.RegularExpressions;
using Lumio.Sample.Bots;
using Lumio.Sample.Gameplay.EntityTypes;
using Xunit;

namespace Lumio.Sample.Gameplay.Tests;

/// <summary>
/// The bot mining scenario's decision procedure. Everything the live scenario decides lives in
/// <see cref="SampleMiningPlan"/>, which takes a census and answers one command, so these run
/// without a replica, a session or a Bot.Host — the adapter around it only turns that one answer
/// into an ability activation.
/// </summary>
public sealed class SampleMiningPlanTests
{
    private const string SelfHex = "00000001:00000002";
    private const string VeinHex = "00000001:0000000a";
    private const string OtherVeinHex = "00000001:0000000b";
    private const string DropHex = "00000001:0000001a";

    private static string RepoRoot =>
        Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));

    private static SampleBotEntity Self => new(SelfHex, "player");

    private static SampleBotEntity Vein(string hex) => new(hex, SampleMiningPlan.VeinEntityType);

    private static SampleBotEntity Drop(string hex) => new(hex, SampleMiningPlan.OreDropEntityType);

    /// <summary>The census names entity types by the registry's wire name, so the plan must too.</summary>
    [Fact]
    public void TargetEntityTypesAreTheGeneratedRegistryWireNames()
    {
        Assert.Equal(SampleMiningPlan.VeinEntityType, GeneratedRegistry.Instance.WireName(typeof(VeinEntity)));
        Assert.Equal(SampleMiningPlan.OreDropEntityType, GeneratedRegistry.Instance.WireName(typeof(OreDropEntity)));
    }

    /// <summary>Nothing is issued before the replica says who this bot is.</summary>
    [Fact]
    public void NothingIsIssuedBeforeSelfIsBound()
    {
        var plan = new SampleMiningPlan();
        for (int tick = 0; tick < SampleMiningPlan.DwellTicks; tick++)
        {
            SampleBotCommand command = plan.Advance(false, string.Empty, new[] { Vein(VeinHex) });
            Assert.Equal(SampleBotAct.Wait, command.Act);
        }

        Assert.Equal(SampleMiningPhase.AwaitingSelf, plan.Phase);
        Assert.False(plan.SelfBound);
        Assert.Equal(0, plan.MineOrders);
    }

    /// <summary>A visible vein becomes the target, and the target is what the mine input carries.</summary>
    [Fact]
    public void AVisibleVeinBecomesTheMineTarget()
    {
        var plan = new SampleMiningPlan();
        SampleBotCommand command = plan.Advance(true, SelfHex, new[] { Self, Vein(VeinHex) });

        Assert.Equal(SampleBotAct.Mine, command.Act);
        Assert.Equal(VeinHex, command.TargetHex);
        Assert.Equal(VeinHex, plan.TargetHex);
        Assert.Equal(SampleMiningPhase.Mining, plan.Phase);
    }

    /// <summary>
    /// The break count is not in the bot. The plan keeps hitting for as long as the census shows
    /// the vein — far past the configured <c>vein_hits_to_break</c> — and only a vein that leaves
    /// the census ends the phase.
    /// </summary>
    [Fact]
    public void MiningContinuesWhileTheVeinIsVisibleAndOutlastsTheConfiguredBreakCount()
    {
        int configuredHits = ReadInt("mining", "vein_hits_to_break");
        var plan = new SampleMiningPlan();
        var census = new[] { Self, Vein(VeinHex) };

        for (int tick = 0; tick < configuredHits * (SampleMiningPlan.DwellTicks + 1); tick++)
        {
            SampleBotCommand command = plan.Advance(true, SelfHex, census);
            Assert.True(command.Act == SampleBotAct.Mine || command.Act == SampleBotAct.Move, command.Act.ToString());
            if (command.Act == SampleBotAct.Mine) Assert.Equal(VeinHex, command.TargetHex);
        }

        Assert.False(plan.TargetVeinGone);
        Assert.Equal(SampleMiningPhase.Mining, plan.Phase);
        Assert.True(plan.MineOrders > configuredHits, "the plan stopped mining before the vein was gone");
    }

    /// <summary>A vein that leaves the census is what digging through one looks like from a client.</summary>
    [Fact]
    public void TheDroppedOreIsClaimedOnlyAfterTheTargetVeinLeavesTheCensus()
    {
        var plan = new SampleMiningPlan();
        Assert.Equal(SampleBotAct.Mine, plan.Advance(true, SelfHex, new[] { Self, Vein(VeinHex) }).Act);

        // The drop is already visible, but the vein is too: the plan does not abandon its dig.
        SampleBotCommand stillMining = plan.Advance(true, SelfHex, new[] { Self, Vein(VeinHex), Drop(DropHex) });
        Assert.Equal(SampleBotAct.Mine, stillMining.Act);
        Assert.Equal(SampleMiningPhase.Mining, plan.Phase);

        Assert.Equal(SampleBotAct.Wait, plan.Advance(true, SelfHex, new[] { Self, Drop(DropHex) }).Act);
        Assert.True(plan.TargetVeinGone);
        Assert.Equal(SampleMiningPhase.Collecting, plan.Phase);

        SampleBotCommand claim = plan.Advance(true, SelfHex, new[] { Self, Drop(DropHex) });
        Assert.Equal(SampleBotAct.Pickup, claim.Act);
        Assert.Equal(DropHex, claim.TargetHex);
    }

    /// <summary>A dug vein whose drop has not replicated yet is waited for, not walked away from.</summary>
    [Fact]
    public void ADropThatHasNotArrivedYetIsWaitedForBeforeTheSweepResumes()
    {
        var plan = new SampleMiningPlan();
        plan.Advance(true, SelfHex, new[] { Self, Vein(VeinHex) });
        plan.Advance(true, SelfHex, new[] { Self });
        Assert.Equal(SampleMiningPhase.Collecting, plan.Phase);

        for (int tick = 0; tick < SampleMiningPlan.SettleGraceTicks; tick++)
            Assert.Equal(SampleBotAct.Wait, plan.Advance(true, SelfHex, new[] { Self }).Act);

        Assert.Equal(SampleBotAct.Move, plan.Advance(true, SelfHex, new[] { Self }).Act);
    }

    /// <summary>A claimed drop that leaves the census ends the run, and the run stays ended.</summary>
    [Fact]
    public void TheRunCompletesWhenTheClaimedDropLeavesTheCensus()
    {
        var plan = new SampleMiningPlan();
        plan.Advance(true, SelfHex, new[] { Self, Vein(VeinHex) });
        plan.Advance(true, SelfHex, new[] { Self, Drop(DropHex) });
        Assert.Equal(SampleBotAct.Pickup, plan.Advance(true, SelfHex, new[] { Self, Drop(DropHex) }).Act);

        Assert.Equal(SampleBotAct.Done, plan.Advance(true, SelfHex, new[] { Self }).Act);
        Assert.True(plan.TargetDropGone);
        Assert.Equal(SampleMiningPhase.Complete, plan.Phase);
        Assert.Equal(SampleBotAct.Done, plan.Advance(true, SelfHex, new[] { Self, Vein(VeinHex) }).Act);
    }

    /// <summary>
    /// With nothing to work on the plan sweeps, and every step it emits is one the move ability
    /// admits — the bot never asks the authority for a teleport or a stationary step.
    /// </summary>
    [Fact]
    public void EverySweepStepIsAnAdmittedMoveInput()
    {
        var plan = new SampleMiningPlan();
        var census = new[] { Self };
        int steps = 0;

        for (int tick = 0; tick < SampleMiningPlan.SweepArmCells * SampleMiningPlan.DwellTicks; tick++)
        {
            SampleBotCommand command = plan.Advance(true, SelfHex, census);
            if (command.Act != SampleBotAct.Move) continue;
            steps++;
            Assert.True(MoveAbility.IsAdmittedStep(command.Dx, command.Dz), $"{command.Dx},{command.Dz}");
        }

        Assert.True(steps > SampleMiningPlan.SweepArmCells, "the sweep never advanced");
        Assert.Equal(steps, plan.MoveOrders);
    }

    /// <summary>
    /// Two bots in the same world pick different veins from the same census. The authority admits
    /// one unsettled dig per vein, so bots that all queued on the first one would starve.
    /// </summary>
    [Fact]
    public void TwoBotsSpreadOverTheVeinsTheySee()
    {
        var census = new[] { Self, Vein(VeinHex), Vein(OtherVeinHex) };
        var picks = new HashSet<string>(StringComparer.Ordinal);
        foreach (string self in new[] { "00000001:00000002", "00000001:00000003", "00000001:00000004", "00000001:00000005" })
            picks.Add(new SampleMiningPlan().Advance(true, self, census).TargetHex);

        Assert.Equal(2, picks.Count);
        Assert.Contains(VeinHex, picks);
        Assert.Contains(OtherVeinHex, picks);
    }

    /// <summary>The same bot id always plans the same run: a replayed seed replays the commands.</summary>
    [Fact]
    public void TheSameSelfIdPlansTheSameRun()
    {
        var census = new[] { Self, Vein(VeinHex), Vein(OtherVeinHex) };
        var first = new SampleMiningPlan();
        var second = new SampleMiningPlan();
        for (int tick = 0; tick < SampleMiningPlan.DwellTicks * SampleMiningPlan.SettleGraceTicks; tick++)
        {
            SampleBotCommand left = first.Advance(true, SelfHex, census);
            SampleBotCommand right = second.Advance(true, SelfHex, census);
            Assert.Equal(left.Act, right.Act);
            Assert.Equal(left.TargetHex, right.TargetHex);
            Assert.Equal(left.Dx, right.Dx);
            Assert.Equal(left.Dz, right.Dz);
        }
    }

    /// <summary>
    /// The bot assembly carries no gameplay table number. It has no business knowing what a hit
    /// costs, how many hits break a vein or how much ore one holds: those are authority rules it
    /// observes the effect of.
    /// </summary>
    [Fact]
    public void BotSourceEmbedsNoGameplayTableNumbers()
    {
        var banned = new HashSet<string>(StringComparer.Ordinal)
        {
            ReadRaw("mining", "vein_hits_to_break"),
            ReadRaw("mining", "stamina_cost"),
            ReadRaw("mining", "ore_per_vein"),
            ReadRawNamed("attributes", "Stamina", "initial"),
            ReadRawNamed("attributes", "Ore", "initial"),
            ReadRaw("movement", "step_meters"),
            ReadRaw("movement", "sweep_radius_meters"),
        };

        string bots = Path.Combine(RepoRoot, "Client", "Bots");
        Assert.True(Directory.Exists(bots), bots);
        foreach (string file in Directory.GetFiles(bots, "*.cs", SearchOption.AllDirectories))
        {
            if (Array.Exists(GeneratedDirectories, directory =>
                file.Contains($"{Path.DirectorySeparatorChar}{directory}{Path.DirectorySeparatorChar}", StringComparison.Ordinal)))
                continue;
            foreach (string line in File.ReadLines(file))
            {
                string code = line.Split("//", 2, StringSplitOptions.None)[0].Trim();
                foreach (string token in banned)
                {
                    string pattern = @"(?<![A-Za-z0-9_.])" + Regex.Escape(token) + @"[uUlLfFdDmM]?(?![A-Za-z0-9_.])";
                    Assert.False(Regex.IsMatch(code, pattern), file + " embeds config token " + token + ": " + code);
                }
            }
        }
    }

    private static readonly string[] GeneratedDirectories = { "obj", "bin" };

    private static string ReadRaw(string stem, string key)
    {
        using JsonDocument document = Open(stem);
        return document.RootElement.GetProperty("rows")[0].GetProperty(key).GetRawText();
    }

    private static string ReadRawNamed(string stem, string name, string key)
    {
        using JsonDocument document = Open(stem);
        foreach (JsonElement row in document.RootElement.GetProperty("rows").EnumerateArray())
            if (row.GetProperty("name").GetString() == name) return row.GetProperty(key).GetRawText();
        throw new InvalidOperationException("No " + stem + " row named " + name);
    }

    private static int ReadInt(string stem, string key)
    {
        using JsonDocument document = Open(stem);
        return document.RootElement.GetProperty("rows")[0].GetProperty(key).GetInt32();
    }

    private static JsonDocument Open(string stem) =>
        JsonDocument.Parse(File.ReadAllText(Path.Combine(RepoRoot, "config", "server", stem + ".json")));
}

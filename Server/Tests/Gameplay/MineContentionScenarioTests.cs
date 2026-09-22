using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.RegularExpressions;
using System.Threading;
using Lumio.GameRuntime.Coordination;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.GameRuntime.Simulation;
using Lumio.Sample.Gameplay.Components.Mining;
using Lumio.Sample.Gameplay.Components.Ore;
using Lumio.Sample.Gameplay.Components.Vein;
using Lumio.Sample.Gameplay.Config;
using Xunit;

namespace Lumio.Sample.Gameplay.Tests;

/// <summary>
/// The workload R-00654 asks for: one miner holding an unsettled dig in a section while another
/// writer lands an authoritative change in another cell of the <em>same</em> section, and movers who
/// touch no terrain at all. It is the authority-side twin of the client shape being measured — a
/// record that validated on section revision <c>r</c> while someone else pushed that section to
/// <c>r + 1</c> — because Sample's own settlement is what tells us a refusal cost nobody anything.
/// </summary>
[Collection("SampleWorld")]
public sealed class MineContentionScenarioTests : IDisposable
{
    public MineContentionScenarioTests() =>
        Environment.SetEnvironmentVariable(SampleTables.ConfigDirVariable,
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..", "Server", "Config", "Tables")));

    public void Dispose() => Environment.SetEnvironmentVariable(SampleTables.ConfigDirVariable, null);

    [Fact]
    public void MineIsLogicPredictAndPickupIsAuthorityOnly()
    {
        Assert.Equal(PredictionKind.LogicPredict, Declared(typeof(MineAbility)));
        Assert.Equal(PredictionKind.AuthorityOnly, Declared(typeof(PickupAbility)));
        Assert.Equal(PredictionKind.LogicPredict, Declared(typeof(MoveAbility)));
    }

    [Fact]
    public void GameplayWritesNoUndoAndOwnsNoPredictionBookkeeping()
    {
        // ADR-106 §1: GAS records, undoes and replays. A game that grew its own undo, its own
        // journal or its own replay loop would be the second prediction orchestrator that decision
        // forbids, so the ability files must stay free of all three.
        string abilities = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", "..",
            "Gameplay", "Abilities"));
        // Declarations and calls, not prose: the doc comments are allowed to explain whose job this is.
        var handwritten = new Regex(@"\b(Undo|Replay|Rollback|Correct)\w*\s*\(", RegexOptions.None, TimeSpan.FromSeconds(5));
        foreach (string file in Directory.GetFiles(abilities, "*.cs"))
        {
            foreach (string line in File.ReadLines(file))
            {
                string code = line.Split("///", 2, StringSplitOptions.None)[0].Split("//", 2, StringSplitOptions.None)[0];
                Assert.False(handwritten.IsMatch(code), file + " grows its own prediction bookkeeping: " + line.Trim());
            }
        }
    }

    [Theory]
    // A vein with no authored cell is not diggable by anyone.
    [InlineData(false, true, 1000u, "vein", MineAbility.PredictedDigVerdict.Refuse)]
    // ADR-106 §8: an unloaded or still-publishing section is not air and is not invented terrain.
    // The input is admitted so the authority answers it; nothing is changed locally.
    [InlineData(true, false, 0u, null, MineAbility.PredictedDigVerdict.AwaitAuthority)]
    [InlineData(true, false, 1000u, "vein", MineAbility.PredictedDigVerdict.AwaitAuthority)]
    // The view can already see the cell is gone, or that it stopped being this vein's cell.
    [InlineData(true, true, 0u, null, MineAbility.PredictedDigVerdict.Refuse)]
    [InlineData(true, true, 1000u, null, MineAbility.PredictedDigVerdict.Refuse)]
    [InlineData(true, true, 1000u, "someone-else", MineAbility.PredictedDigVerdict.Refuse)]
    // Loaded, still a block, still bound here: this is the one case that digs.
    [InlineData(true, true, 1000u, "vein", MineAbility.PredictedDigVerdict.Order)]
    public void MissingSectionDataIsNeverPredictedAsAir(bool hasCell, bool hasBlockId, uint blockId,
        string? boundEntityHex, MineAbility.PredictedDigVerdict expected) =>
        Assert.Equal(expected, MineAbility.ClassifyPredictedDig(hasCell, hasBlockId, blockId, boundEntityHex, "vein"));

    [Fact]
    public void SecondMinerInTheSameSectionBumpsTheRevisionAnOlderRecordValidatedOn()
    {
        using var world = new ContentionWorld(miners: 2, movers: 0);
        VeinReserveComponent first = world.Veins[0], second = world.Veins[1];
        ulong section = first.SectionKey.Value;
        // Both veins are destroyed by their own settlement, so keep the cells as values, not components.
        int firstCell = first.CellOffset.Value, secondCell = second.CellOffset.Value;
        Assert.Equal(section, second.SectionKey.Value);
        Assert.NotEqual(firstCell, secondCell);

        world.WearDownToTheLastHit(0, first);
        world.WearDownToTheLastHit(1, second);
        ulong validatedOn = world.Adapter.Read(section, firstCell).SectionRevision;

        // Both final hits are ordered in the same frame and both records are still unsettled here:
        // the terrain result only comes back on the next frame (tick.md §3 rule 5).
        Assert.True(world.Mine(0, first).Succeeded);
        Assert.True(world.Mine(1, second).Succeeded);
        Assert.Equal(2, world.UnsettledRecords);
        Assert.Empty(world.World.Each<OrePileComponent>());

        world.Tick(); // phase 8 publishes both cells
        Assert.Equal(validatedOn + 1, world.Adapter.Read(section, firstCell).SectionRevision);
        Assert.Equal(0U, world.Adapter.Read(section, firstCell).BlockId);
        Assert.Equal(0U, world.Adapter.Read(section, secondCell).BlockId);

        world.Tick(); // the results come back and each record settles exactly once
        Assert.Equal(0, world.UnsettledRecords);
        Assert.Equal(2, world.World.Each<OrePileComponent>().Count());

        // This is the failure R-00654 is measuring the frequency of: anything that still expects the
        // revision it validated on loses to the section's own bump, even for a cell nobody touched.
        VeinReserveComponent untouched = world.Veins[2];
        int untouchedCell = untouched.CellOffset.Value;
        Assert.Equal(section, untouched.SectionKey.Value);
        Assert.Equal(VoxelStageStatus.Staged, world.Adapter.TryStageMutation(
            new[] { new VoxelWriteEntry(section, untouchedCell, 0, validatedOn) },
            Array.Empty<VoxelBindingOp>(), "record-validated-on-the-old-revision").Status);
        VoxelMutationOutcome refused = world.Adapter.CommitTransactionWithResult("record-validated-on-the-old-revision");
        Assert.NotEqual(0, refused.Status);
        Assert.NotEqual(VoxelTxnState.Applied, refused.State);
        Assert.NotEqual(0U, world.Adapter.Read(section, untouchedCell).BlockId);

        // A stale expectation is an ordinary refusal, so the world keeps running and the same cell is
        // still minable on the current revision.
        world.Tick();
        world.RefillStamina(0);
        world.WearDownToTheLastHit(0, untouched, walkTo: true);
        Assert.True(world.Mine(0, untouched).Succeeded);
        world.Tick();
        world.Tick();
        Assert.Equal(3, world.World.Each<OrePileComponent>().Count());
    }

    [Fact]
    public void MinerWhoLosesTheCellToAnotherMinerIsRefusedWithoutPayingOrRestoringTheBlock()
    {
        using var world = new ContentionWorld(miners: 2, movers: 0);
        VeinReserveComponent contested = world.Veins[0];
        ulong section = contested.SectionKey.Value;
        int offset = contested.CellOffset.Value;
        world.PlaceAt(1, contested);

        world.WearDownToTheLastHit(0, contested);
        long spentByA = world.Stamina(0), spentByB = world.Stamina(1);

        // A takes the cell: its final hit is ordered and its record is unsettled.
        Assert.True(world.Mine(0, contested).Succeeded);
        Assert.Equal(1, world.UnsettledRecords);

        // B reaches for the same cell in the same frame. One unsettled dig per cell, so B is refused
        // on admission: a legal business outcome, not a fault and not a second payout.
        Assert.False(world.Mine(1, contested).Succeeded);
        Assert.Equal(1, world.UnsettledRecords);
        Assert.Equal(spentByB, world.Stamina(1));

        world.Tick(); // phase 8 publishes A's dig
        Assert.Equal(0U, world.Adapter.Read(section, offset).BlockId);
        // B is refused again, and the refusal must not put the block back for anyone.
        Assert.False(world.Mine(1, contested).Succeeded);
        Assert.Equal(0U, world.Adapter.Read(section, offset).BlockId);

        world.Tick(); // A's result comes back and settles once
        Assert.Equal(0, world.UnsettledRecords);
        Assert.Equal(spentByA - SampleConfigBinding.For(world.World).Mining.StaminaCost, world.Stamina(0));
        Assert.Equal(spentByB, world.Stamina(1));
        OrePileComponent drop = Assert.Single(world.World.Each<OrePileComponent>());
        Assert.Equal(SampleConfigBinding.For(world.World).Mining.OrePerVein, drop.Amount.Value);
        Assert.False(world.World.IsLive(contested.Entity));
        Assert.Null(world.Adapter.BindingGet(section, offset));

        // Still exactly one reward after the vein is gone, and the cell never flashes back to stone.
        Assert.False(world.Mine(1, contested).Succeeded);
        world.Tick();
        world.Tick();
        Assert.Single(world.World.Each<OrePileComponent>());
        Assert.Equal(0U, world.Adapter.Read(section, offset).BlockId);
        Assert.Equal(spentByB, world.Stamina(1));

        // The world is not faulted by the refusals: another vein in the same section still settles.
        world.WearDownToTheLastHit(1, world.Veins[1], walkTo: true);
        Assert.True(world.Mine(1, world.Veins[1]).Succeeded);
        world.Tick();
        world.Tick();
        Assert.Equal(2, world.World.Each<OrePileComponent>().Count());
    }

    [Fact]
    public void MoversNeverChangeTheSectionTheMinerIsHoldingARecordIn()
    {
        using var world = new ContentionWorld(miners: 1, movers: 3);
        VeinReserveComponent vein = world.Veins[0];
        ulong section = vein.SectionKey.Value;
        int cell = vein.CellOffset.Value;
        world.WearDownToTheLastHit(0, vein);
        ulong revision = world.Adapter.Read(section, cell).SectionRevision;

        // The miner's order is placed and its record is unsettled for the rest of this frame.
        Assert.True(world.Mine(0, vein).Succeeded);
        Assert.Equal(1, world.UnsettledRecords);
        Assert.Equal(3, world.MoveEveryMover(right: true));
        Assert.Equal(revision, world.Adapter.Read(section, cell).SectionRevision);
        Assert.Equal(1, world.UnsettledRecords);

        world.Tick(); // phase 8 publishes the dig; the movers did not contribute to that bump
        Assert.Equal(revision + 1, world.Adapter.Read(section, cell).SectionRevision);
        Assert.Equal(1, world.UnsettledRecords);
        Assert.Equal(3, world.MoveEveryMover(right: false));
        Assert.Equal(revision + 1, world.Adapter.Read(section, cell).SectionRevision);

        world.Tick(); // the result comes back and settles
        Assert.Equal(0, world.UnsettledRecords);
        Assert.Single(world.World.Each<OrePileComponent>());
        Assert.Equal(revision + 1, world.Adapter.Read(section, cell).SectionRevision);
        Assert.Equal(0, world.Adapter.QueuedCount);
    }

    private static PredictionKind Declared(Type ability) =>
        ((AbilityTypeAttribute[])ability.GetCustomAttributes(typeof(AbilityTypeAttribute), inherit: false))
        .Single().Prediction;

    /// <summary>
    /// One started world with several miners on veins of a single section plus movers who only walk.
    /// Activations go through the same <see cref="SampleGameplay.ActivateMine"/> the catalog RPC uses.
    /// </summary>
    private sealed class ContentionWorld : IDisposable
    {
        private readonly WorldManager _manager;
        private readonly DedicatedServerHostBinding _host;
        private readonly NetEntityId[] _miners;
        private readonly NetEntityId[] _movers;

        internal ContentionWorld(int miners, int movers)
        {
            string root = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
            _manager = SampleGameplay.CreateWorld(654);
            _host = Assert.IsType<DedicatedServerHostBinding>(DedicatedServerHostBinding.TryAttach(_manager,
                KernelConfigurationFixture.Create(),
                File.ReadAllBytes(Path.Combine(root, "Server", "Assets", "Maps", "official-catalog.json")),
                File.ReadAllBytes(Path.Combine(root, "Server", "Assets", "Maps", "sample.voxel"))));
            _manager.Start(Thread.CurrentThread);
            WorldTickBinding.Bind(_manager);
            var queued = new List<EntityOrder>();
            for (int index = 0; index < miners + movers; index++)
                queued.Add(PlayerLifecycleTests.QueuePlayer(_manager.World, "contender-" + index));
            for (int tick = 0; tick < 4; tick++) _manager.Tick();
            _miners = queued.Take(miners).Select(order => order.AssignedId).ToArray();
            _movers = queued.Skip(miners).Select(order => order.AssignedId).ToArray();
            // Veins are authored per cell; one section holding several of them is what this workload needs.
            Veins = World.Each<VeinReserveComponent>().Where(vein => vein.HasCell.Value)
                .GroupBy(vein => vein.SectionKey.Value).OrderByDescending(group => group.Count())
                .First().OrderBy(vein => vein.CellOffset.Value).ToArray();
            Assert.True(Veins.Length >= miners + 1, "The map must author more veins in one section than there are miners.");
            for (int index = 0; index < miners; index++) PlaceAt(index, Veins[index]);
        }

        internal World World => _manager.World;
        internal HostVoxelWorldAdapter Adapter => VoxelGameplayBinding.Resolve(_manager)!;
        internal VeinReserveComponent[] Veins { get; }

        /// <summary>Dig orders that have been placed and are still waiting for their terrain result.</summary>
        internal int UnsettledRecords => World.Each<PendingDigComponent>().Count(record => record.Active.Value);

        internal long Stamina(int miner) =>
            World.Get<AttributeComponent>(_miners[miner]).GetBaseValue(SampleConfigBinding.For(World).Stamina.Name);

        /// <summary>
        /// Back to a full vein's worth of stamina. A second vein costs a second vein's stamina, and
        /// this workload is about terrain contention, not about the configured stamina budget.
        /// </summary>
        internal void RefillStamina(int miner)
        {
            ISampleConfig config = SampleConfigBinding.For(World);
            World.Get<AttributeComponent>(_miners[miner])
                .SetBaseValue(config.Stamina.Name, config.Mining.StaminaCost * config.Mining.VeinHitsToBreak);
        }

        internal void PlaceAt(int miner, VeinReserveComponent vein) =>
            PlayerLifecycleTests.PlaceFixturePlayer(World, _miners[miner], vein.CellCenter);

        internal AbilityActivateResult Mine(int miner, VeinReserveComponent vein)
        {
            var input = new MineAbility.Input { TargetHex = vein.Entity.ToHex() };
            return SampleGameplay.ActivateMine(World.Get<AbilityComponent>(_miners[miner]), in input);
        }

        /// <summary>
        /// Spends the vein down to its last hit, so the next activation is the one that orders terrain.
        /// Those hits touch no terrain at all, which is why they settle where they are written.
        /// </summary>
        internal void WearDownToTheLastHit(int miner, VeinReserveComponent vein, bool walkTo = false)
        {
            if (walkTo) PlaceAt(miner, vein);
            while (vein.Remaining.Value > 1)
            {
                int before = vein.Remaining.Value;
                Assert.True(Mine(miner, vein).Succeeded);
                Assert.Equal(before - 1, vein.Remaining.Value);
                Tick(); // one configured cooldown tick
            }
        }

        /// <summary>
        /// One step per mover in the current frame; returns how many were accepted. GAS admits one
        /// activation of an ability per frame, so a second step belongs to a later frame.
        /// </summary>
        internal int MoveEveryMover(bool right)
        {
            int accepted = 0;
            var input = new MoveAbility.Input { Dx = right ? 1 : -1, Dz = 0 };
            foreach (NetEntityId mover in _movers)
            {
                if (World.Get<AbilityComponent>(mover).Activate<MoveAbility, MoveAbility.Input>(in input).Succeeded)
                    accepted++;
            }

            return accepted;
        }

        internal void Tick() => _manager.Tick();

        public void Dispose()
        {
            _host.Dispose();
            _manager.Dispose();
        }
    }
}

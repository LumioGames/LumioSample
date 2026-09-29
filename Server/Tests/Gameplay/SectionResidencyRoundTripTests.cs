using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using Lumio.GameRuntime.Coordination;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Persistence;
using Lumio.GameRuntime.Primitives;
using Lumio.GameRuntime.Simulation;
using Lumio.Sample.Gameplay.Components.Vein;
using Lumio.Sample.Gameplay.Config;
using Xunit;

namespace Lumio.Sample.Gameplay.Tests;

/// <summary>
/// block-entity.md B4/B5/B6 end-to-end probe for veins, added in the R-00736 fix round (P1 finding #1):
/// a real Section-level unload → reload round trip through Runtime's own residency orchestrator
/// (<see cref="SectionResidencyOrchestrator"/>, ADR-119 决策 7 / R-00730 — merged to LumioGameRuntime
/// main at commit <c>0b52c22</c>, after this PR's first pass had already been written; see this PR's
/// fix-round evidence comment for the merge-base check). <see cref="ProductionMiningTests"/> already
/// covers a full-process cold restart (<c>DualCutCheckpointPayload</c>/<c>RestoreNew</c>); this covers the
/// same-process Section-level eviction/reload path acceptance item 2 and block-entity.md B4–B6 actually
/// ask for, which nothing in this test project exercised before.
/// <para>
/// Mirrors the production wiring LumioServer's own <c>HostEntry.TryEnableSectionResidency</c> uses
/// (<c>EnableSectionResidency</c> + <see cref="SectionResidencyOptions"/> + fresh
/// <see cref="SectionResidencyRegistry"/> + <c>Lumio.Engine.SDK.VoxelSectionExportLimits</c>), against a
/// real native voxel world (the engine-assembled <c>AuthoritySectionSubsystem</c>) — not the mocked
/// <c>IVoxelSectionResidencyPort</c> GameRuntime's own orchestrator unit tests use.
/// </para>
/// </summary>
[Collection("SampleWorld")]
public sealed class SectionResidencyRoundTripTests
{
    private static string Root => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));

    /// <summary>The production Section egress shape LumioServer HostEntry attaches with.</summary>
    private static SectionProducerOptions SectionEgress => new(
        new SectionProducerLimits(
            MaxPhysicalPublications: 16,
            MaxSectionReferences: 64,
            MaxLeases: 64,
            MaxManagedBytes: 1_000_000,
            // The wire egress budget the DS codec enforces (SectionFrameCodec.MaxPayloadBytes).
            MaxPayloadBytes: 32_000),
        new Lumio.Engine.SDK.VoxelSectionExportLimits(
            MaxSnapshots: 64, MaxRetainedBytes: 4_000_000, MaxScratchBytes: 2_000_000));

    [Fact]
    public void SectionUnloadThenReloadKeepsEveryVeinNumberAndValueAndNeverRescansTheSameCells()
    {
        using WorldManager manager = SampleWorldHarness.Engine.CreateWorld(new Lumio.GameRuntime.Hosting.WorldCreationOptions(GeneratedRegistry.Instance)
        {
            InstanceId = 900,
            Config = SampleConfigBinding.Load(),
            Catalog = File.ReadAllBytes(Path.Combine(Root, "Server", "Assets", "Maps", "official-catalog.json")),
            InitialVoxelSnapshot = File.ReadAllBytes(Path.Combine(Root, "Server", "Assets", "Maps", "sample.voxel")),
            Subsystems = new Lumio.GameRuntime.Ecs.IWorldSubsystem[] { new Lumio.GameRuntime.Hosting.AuthoritySectionSubsystem(SectionEgress) },
        }).EnsureSucceeded();
        Lumio.GameRuntime.Hosting.AuthoritySectionSubsystem host = SampleWorldHarness.RequireService<Lumio.GameRuntime.Hosting.AuthoritySectionSubsystem>(manager);

        // No player is ever admitted in this test: PrepareSectionUnload refuses a Section holding a
        // live LogicTransform entity, and B6's scan must have already settled before we pick a Section.
        VeinLocationTestSupport.TickUntilScanSettles(manager);
        int totalBefore = manager.World.Each<VeinReserveComponent>().Count();
        Assert.True(totalBefore > 0, "the authored map must scan at least one vein for this probe to mean anything");

        List<(VeinReserveComponent Vein, VeinLocationTestSupport.VeinLocation Loc)> chosen = manager.World
            .Each<VeinReserveComponent>()
            .Select(v => (Vein: v, Loc: VeinLocationTestSupport.Locate(manager.World, v.Entity)))
            .GroupBy(pair => pair.Loc.Section)
            .OrderByDescending(group => group.Count())
            .First()
            .ToList();
        ulong sectionKey = chosen[0].Loc.Section;
        NetEntityId[] sectionVeinIds = chosen.Select(pair => pair.Vein.Entity).ToArray();
        int[] remainingBefore = chosen.Select(pair => pair.Vein.Remaining.Value).ToArray();
        Assert.All(sectionVeinIds, id => Assert.True(manager.World.IsLive(id)));

        SectionResidencyOrchestrator residency = host.EnableSectionResidency(
            new SectionResidencyOptions(GraceTicks: 0UL),
            new SectionResidencyRegistry(),
            new Lumio.Engine.SDK.VoxelSectionExportLimits(MaxSnapshots: 8, MaxRetainedBytes: 1_000_000, MaxScratchBytes: 1_000_000));

        // B4/B5: capturing both halves in this Tick-between step already takes the Section's veins out
        // of the live world — not a destruction (block-entity.md: "不进墓碑、号码保留").
        SectionUnloadPrepareResult prepared = residency.PrepareSectionUnload(sectionKey);
        Assert.True(prepared.Succeeded, prepared.ErrorCode);
        Assert.NotNull(prepared.Record);
        Assert.Equal(SectionResidencyState.Unloading, residency.StateOf(sectionKey));
        Assert.All(sectionVeinIds, id =>
        {
            Assert.False(manager.World.IsLive(id));
            Assert.False(manager.World.IsTombstoned(id));
            Assert.True(manager.World.IsNonResident(id));
        });

        // B4: "顺序为体素回执 → 体素卸载". This test has no real durability/Storage container (out of this
        // card's owned files), so the receipt is fabricated exactly as a fsynced container would report
        // it once both halves are durable.
        SectionUnloadCompleteResult completed = residency.CompleteSectionUnload(
            sectionKey, new SectionDurabilityReceipt(EntityHalfDurable: true, BlockHalfDurable: true));
        Assert.True(completed.Succeeded, completed.ErrorCode);
        Assert.False(completed.Aborted);
        Assert.Equal(SectionResidencyState.NonResident, residency.StateOf(sectionKey));

        // B5: a non-resident number never reads as tombstoned or destroyed while it waits.
        Assert.All(sectionVeinIds, id =>
        {
            Assert.True(manager.World.IsNonResident(id));
            Assert.False(manager.World.IsTombstoned(id));
            Assert.False(manager.World.IsLive(id));
        });

        StableResult loaded = residency.LoadSection(sectionKey, prepared.Record!.Value);
        Assert.True(loaded.Succeeded, loaded.ErrorId);
        Assert.Equal(SectionResidencyState.Resident, residency.StateOf(sectionKey));

        // B4: every number and value the Section held comes back unchanged, and no new vein was minted.
        Assert.All(sectionVeinIds, id =>
        {
            Assert.True(manager.World.IsLive(id));
            Assert.False(manager.World.IsNonResident(id));
        });
        int[] remainingAfter = sectionVeinIds.Select(id => manager.World.Get<VeinReserveComponent>(id).Remaining.Value).ToArray();
        Assert.Equal(remainingBefore, remainingAfter);
        Assert.Equal(totalBefore, manager.World.Each<VeinReserveComponent>().Count());

        // B6: further ticks (which re-visit every Section B6's own bookkeeping still tracks) must never
        // rescan this Section's already-bound cells into a second vein at any of them.
        for (int i = 0; i < 5; i++) manager.Tick();
        Assert.Equal(totalBefore, manager.World.Each<VeinReserveComponent>().Count());
        Assert.All(sectionVeinIds, id => Assert.True(manager.World.IsLive(id)));
    }
}

using System.Collections.Generic;
using Lumio.GameRuntime.Ecs;
using Xunit;

namespace Lumio.Sample.Gameplay.Tests;

/// <summary>
/// R-00768: <see cref="SampleMiningComponent.TryLocateInSections"/> is the pure half both sides'
/// <c>TryLocate</c> share — no ECS World, no adapter, just a reader function over candidate Section
/// keys — so it is tested directly, the same way <see cref="MineAbility.ClassifyPredictedDig"/> is
/// tested without a voxel world in <c>MineContentionScenarioTests</c>.
/// </summary>
public sealed class SampleMiningLocationTests
{
    private static readonly NetEntityId Vein = new(1, 7);
    private static readonly NetEntityId Other = new(1, 9);
    private static readonly ulong[] TwoUnresidentSections = { 0UL, 1UL };
    private static readonly ulong[] OneResidentSection = { 5UL };
    private static readonly ulong[] OneUnresidentThenTheOwningSection = { 0UL, 5UL };

    [Fact]
    public void MissesWhenNoCandidateSectionIsResident()
    {
        // Every candidate Section answers "not resident/subscribed" — exactly a predicting client
        // that has not received this Section yet (ADR-119: 位置只有一个来源：绑定表).
        bool located = SampleMiningComponent.TryLocateInSections(Vein, TwoUnresidentSections,
            (ulong _, out IReadOnlyList<SectionBindingEntry> entries) =>
            {
                entries = System.Array.Empty<SectionBindingEntry>();
                return false;
            },
            out ulong sectionKey, out int cellOffset, out int worldX, out int worldZ);

        Assert.False(located);
        Assert.Equal(0UL, sectionKey);
        Assert.Equal(0, cellOffset);
        Assert.Equal(0, worldX);
        Assert.Equal(0, worldZ);
    }

    [Fact]
    public void MissesWhenTheResidentSectionsBindingTableDoesNotNameTheVein()
    {
        // The Section is resident (subscribed) but its committed table binds a different entity —
        // a real miss, not a "not yet resident" one, and still correctly reported as a miss.
        bool located = SampleMiningComponent.TryLocateInSections(Vein, OneResidentSection,
            (ulong key, out IReadOnlyList<SectionBindingEntry> entries) =>
            {
                entries = new[] { new SectionBindingEntry(3, Other) };
                return true;
            },
            out _, out _, out _, out _);

        Assert.False(located);
    }

    [Fact]
    public void HitsOnceTheOwningSectionIsSubscribedAndBindsTheVein()
    {
        // Section key 5 packs Z-section-index 5, X-section-index 0 (((x>>4)<<36) | (z>>4)); its
        // committed table names the vein at cell offset 20 = 1*16 + 4, i.e. local (x=4, z=1) inside
        // the Section, so world space is (0*16 + 4, 5*16 + 1) = (4, 81).
        bool located = SampleMiningComponent.TryLocateInSections(Vein, OneUnresidentThenTheOwningSection,
            (ulong key, out IReadOnlyList<SectionBindingEntry> entries) =>
            {
                if (key == 5UL)
                {
                    entries = new[] { new SectionBindingEntry(20, Vein) };
                    return true;
                }
                entries = System.Array.Empty<SectionBindingEntry>();
                return false;
            },
            out ulong sectionKey, out int cellOffset, out int worldX, out int worldZ);

        Assert.True(located);
        Assert.Equal(5UL, sectionKey);
        Assert.Equal(20, cellOffset);
        Assert.Equal(4, worldX);
        Assert.Equal(81, worldZ);
    }

    [Fact]
    public void CandidateSectionsCoverTheAuthoredMapOnce()
    {
        List<ulong> sections = SampleMiningComponent.AllCandidateSections(width: 32, depth: 20);

        // 32 wide -> sections 0,1 on X; 20 deep -> sections 0,1 on Z (16-cell Sections): 4 total, each once.
        Assert.Equal(4, sections.Count);
        Assert.Equal(sections.Count, new HashSet<ulong>(sections).Count);
    }
}

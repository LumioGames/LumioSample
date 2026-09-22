using System;
using System.Collections.Generic;
using Lumio.Client.Bot;
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay;

namespace Lumio.Sample.Bots;

/// <summary>
/// The restore-verification bot (tour step 14): re-admits into a world restored from a
/// checkpoint and asserts, from the replica census a real client actually received, that the
/// world is the one that was played — the dug vein is gone (its entity was destroyed at
/// dig-through, so it must not resurrect from the base map) and the claimed drop is gone
/// (it was picked up, so it must not respawn either). Against a fresh base map this fails
/// with four veins — that is the point: "restored the base map instead of the save" must be
/// a red assertion, not a silent pass.
/// <para>
/// Numbers are the census's own: the authored map has four vein cells
/// (<c>Server/Assets/Maps/sample.layout.json</c>, a 2×2 patch) and the mining tour digs exactly one of
/// them, so a correct restore shows <see cref="ExpectedVeins"/> veins and no ore drops.
/// </para>
/// </summary>
public sealed class SampleRestoreVerifyScenario : BotScenario
{
    /// <summary>Wire mapping the one no-op activation travels under.</summary>
    public const string RequiredCapability = WireCodec.ServerRpc;

    /// <summary>Four authored vein cells, one dug through by the mining tour.</summary>
    public const int ExpectedVeins = 3;

    /// <summary>The tour's drop was picked up before the save; a restore must not respawn it.</summary>
    public const int ExpectedOreDrops = 0;

    private static readonly string[] Capabilities = { RequiredCapability };

    private bool _selfBound;
    private bool _activated;
    private int _veins;
    private int _drops;

    /// <inheritdoc />
    public override IReadOnlyList<string> RequiredCapabilities
    {
        get { return Capabilities; }
    }

    private static readonly string[] ProbeStep = { "1", "0" };

    /// <inheritdoc />
    public override BotStepResult Step(in BotDriverContext context)
    {
        BotWorldView world = context.World;
        if (!world.HasSelf)
        {
            return BotStepResult.Continue;
        }

        _selfBound = true;
        _veins = 0;
        _drops = 0;
        IReadOnlyList<BotVisibleEntity> all = world.VisibleEntities.All;
        for (int i = 0; i < all.Count; i++)
        {
            if (string.Equals(all[i].EntityType, SampleMiningPlan.VeinEntityType, StringComparison.Ordinal)) _veins++;
            if (string.Equals(all[i].EntityType, SampleMiningPlan.OreDropEntityType, StringComparison.Ordinal)) _drops++;
        }

        // One activation so the run cannot pass without ever having reached the wire.
        BotIssueResult issued = context.Issue(BotIssuedCommand.Activate(nameof(MoveAbility), ProbeStep, 1UL));
        _activated = issued.Accepted;
        return BotStepResult.Complete;
    }

    /// <inheritdoc />
    public override void Assert(in BotDriverContext context, BotAssertionSink sink)
    {
        ArgumentNullException.ThrowIfNull(sink);
        sink.That(_selfBound, "self_bound");
        sink.That(_activated, "activation_accepted");
        sink.That(_veins == ExpectedVeins, $"veins=={ExpectedVeins}(got {_veins})");
        sink.That(_drops == ExpectedOreDrops, $"oreDrops=={ExpectedOreDrops}(got {_drops})");
    }
}

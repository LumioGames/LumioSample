using System;
using System.Collections.Generic;
using System.IO;
using Lumio.Client.Bot;
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay;

namespace Lumio.Sample.Bots;

/// <summary>
/// Criterion-6 restore verifier: re-admits into a store that <see cref="AcceptancePersistenceScenario"/>
/// left in the three intermediate states and asserts, from the replica census a real client
/// received, that all three survived the restart — two veins still live (the half-dug one and the
/// untouched one), exactly one ore drop still on the ground (the unpicked one), and the picked
/// drop did not respawn. Reports its own entity id so the driver can pair account ↔ entity in the
/// observer stream (ore ledger check).
/// </summary>
public sealed class AcceptancePersistenceVerifyScenario : BotScenario
{
    /// <summary>Wire mapping the one probe activation travels under.</summary>
    public const string RequiredCapability = WireCodec.ServerRpc;

    /// <summary>Four authored veins, two dug through by the persistence scenario.</summary>
    public const int ExpectedVeins = 2;

    /// <summary>One drop left unpicked on purpose; the picked one must not respawn.</summary>
    public const int ExpectedOreDrops = 1;

    private static readonly string[] Capabilities = { RequiredCapability };

    private bool _selfBound;
    private bool _activated;
    private int _veins;
    private int _drops;
    private string _selfId = string.Empty;
    private int _stableFrames;

    /// <inheritdoc />
    public override IReadOnlyList<string> RequiredCapabilities => Capabilities;

    private static readonly string[] ProbeStep = { "1", "0" };

    /// <inheritdoc />
    public override BotStepResult Step(in BotDriverContext context)
    {
        BotWorldView world = context.World;
        if (!world.HasSelf) return BotStepResult.Continue;

        _selfBound = true;
        _selfId = world.Self.NetEntityId;
        _veins = 0;
        _drops = 0;
        IReadOnlyList<BotVisibleEntity> all = world.VisibleEntities.All;
        for (int i = 0; i < all.Count; i++)
        {
            if (string.Equals(all[i].EntityType, SampleMiningPlan.VeinEntityType, StringComparison.Ordinal)) _veins++;
            else if (string.Equals(all[i].EntityType, SampleMiningPlan.OreDropEntityType, StringComparison.Ordinal)) _drops++;
        }

        // Watch a few frames so a late Section delivery cannot pass us with a partial census.
        _stableFrames++;
        if (_stableFrames < 240) return BotStepResult.Continue;

        if (!_activated)
        {
            _activated = true;
            context.Issue(BotIssuedCommand.Activate(nameof(MoveAbility), ProbeStep, 1u));
            return BotStepResult.Continue;
        }

        // The census keeps refreshing until the end; the host stops the scenario once the probe
        // has had a window to reach the wire (result.ndjson lands when this returns Complete).
        return _stableFrames >= 600 && context.Uplinks > 0 ? BotStepResult.Complete : BotStepResult.Continue;
    }

    /// <inheritdoc />
    public override void Assert(in BotDriverContext context, BotAssertionSink sink)
    {
        ArgumentNullException.ThrowIfNull(sink);
        string? path = Environment.GetEnvironmentVariable("LUMIO_PERSIST_REPORT");
        if (!string.IsNullOrWhiteSpace(path)) {
            try { System.IO.File.WriteAllText(path, $"role=verify self={_selfId} target=\n"); }
            catch (Exception error) when (error is IOException or System.Security.SecurityException or UnauthorizedAccessException) { /* 断言照常 */ }
        }
        sink.That(_selfBound, "self_bound");
        sink.That(_selfId.Length > 0, "self_report:" + _selfId);
        sink.That(_veins == ExpectedVeins, "veins==" + ExpectedVeins + " saw=" + _veins);
        sink.That(_drops == ExpectedOreDrops, "oreDrops==" + ExpectedOreDrops + " saw=" + _drops);
        sink.That(context.Uplinks >= 1, "bot_uplinked");
    }}

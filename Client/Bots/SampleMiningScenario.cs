using System;
using System.Collections.Generic;
using System.Globalization;
using Lumio.Client.Bot;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.Sample.Gameplay;

namespace Lumio.Sample.Bots;

/// <summary>
/// The sample's live mining bot: find a vein, hit it until it is gone, then claim the ore it
/// dropped. Bot.Host selects it by full type name —
/// <c>--gameplay &lt;Lumio.Sample.Gameplay.dll&gt; --scenario &lt;Lumio.Sample.Bots.dll&gt;
/// --scenario-name Lumio.Sample.Bots.SampleMiningScenario</c>.
/// <para>
/// This type is only the adapter: <see cref="SampleMiningPlan"/> owns every decision, and all
/// this does is read the census out of the read-only world view, hand it over, and turn the one
/// answer into an ability activation. Payload words are written by the ability's own input
/// struct, so the wire layout <c>[typeName, ...payload, sequence]</c> cannot drift from what the
/// authority parses.
/// </para>
/// <para>
/// Nothing here predicts anything and nothing here counts hits. A refusal on the authority
/// (out of reach, on cooldown, out of stamina, a vein somebody else already has an unsettled dig
/// on) is a legal answer that this side never sees; the run is steered only by what leaves and
/// enters the census.
/// </para>
/// </summary>
public sealed class SampleMiningScenario : BotScenario
{
    /// <summary>
    /// Wire mapping the activations travel under. Ability <c>Activate</c> is an ordinary
    /// <c>server.rpc</c>, so this is the capability the host must be able to offer.
    /// </summary>
    public const string RequiredCapability = WireCodec.ServerRpc;

    private static readonly string[] Capabilities = { RequiredCapability };

    private readonly SampleMiningPlan _plan = new();
    private readonly List<SampleBotEntity> _census = new();
    private ulong _sequence;
    private int _accepted;
    private string _lastReject = string.Empty;

    /// <inheritdoc />
    public override IReadOnlyList<string> RequiredCapabilities
    {
        get { return Capabilities; }
    }

    /// <summary>Activations this bot's sink accepted onto the outbox.</summary>
    public int AcceptedActivations
    {
        get { return _accepted; }
    }

    /// <inheritdoc />
    public override BotStepResult Step(in BotDriverContext context)
    {
        BotWorldView world = context.World;
        SampleBotCommand command = _plan.Advance(world.HasSelf, world.Self.NetEntityId, ReadCensus(in world));
        switch (command.Act)
        {
            case SampleBotAct.Mine:
                Issue(in context, nameof(MineAbility), Payload(new MineAbility.Input { TargetHex = command.TargetHex }));
                return BotStepResult.Continue;
            case SampleBotAct.Pickup:
                Issue(in context, nameof(PickupAbility), Payload(new PickupAbility.Input { TargetHex = command.TargetHex }));
                return BotStepResult.Continue;
            case SampleBotAct.Move:
                Issue(in context, nameof(MoveAbility), Payload(new MoveAbility.Input { Dx = command.Dx, Dz = command.Dz }));
                return BotStepResult.Continue;
            case SampleBotAct.Done:
                // Stay in the loop until the session has actually flushed something, so a run that
                // reported completion without ever reaching the wire cannot pass.
                return context.Uplinks > 0 ? BotStepResult.Complete : BotStepResult.Continue;
            default:
                return BotStepResult.Continue;
        }
    }

    /// <inheritdoc />
    public override void Assert(in BotDriverContext context, BotAssertionSink sink)
    {
        ArgumentNullException.ThrowIfNull(sink);
        sink.That(_plan.SelfBound, "self_bound");
        sink.That(_plan.MineOrders > 0, "mine_activated");
        sink.That(_plan.TargetVeinGone, "vein_dug_through");
        sink.That(_plan.PickupOrders > 0, "pickup_activated");
        sink.That(_plan.TargetDropGone, "drop_collected");
        sink.That(_accepted > 0, "activation_accepted:" + _lastReject);
        // The assertion that can actually go red on a silent run: something reached the wire.
        sink.That(context.Uplinks >= 1, "bot_uplinked");
    }

    /// <summary>This frame's census as the plan reads it. The list is reused, never handed out.</summary>
    private List<SampleBotEntity> ReadCensus(in BotWorldView world)
    {
        _census.Clear();
        IReadOnlyList<BotVisibleEntity> all = world.VisibleEntities.All;
        for (int i = 0; i < all.Count; i++)
            _census.Add(new SampleBotEntity(all[i].NetEntityId, all[i].EntityType));
        return _census;
    }

    private void Issue(in BotDriverContext context, string abilityTypeName, IReadOnlyList<string> payload)
    {
        _sequence++;
        BotIssueResult issued = context.Issue(BotIssuedCommand.Activate(abilityTypeName, payload, _sequence));
        if (issued.Accepted) _accepted++;
        else _lastReject = issued.Reason;
    }

    /// <summary>
    /// Payload words for one activation, written by the ability's own input struct. Nothing here
    /// names a gameplay field or fixes an argument order.
    /// </summary>
    private static string[] Payload<TInput>(TInput input)
        where TInput : struct, IAbilityInput
    {
        var written = new List<object?>();
        input.Write(written);
        var words = new string[written.Count];
        for (int i = 0; i < written.Count; i++)
            words[i] = Convert.ToString(written[i], CultureInfo.InvariantCulture) ?? string.Empty;
        return words;
    }
}

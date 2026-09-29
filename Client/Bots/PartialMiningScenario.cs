using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Lumio.Client.Bot;
using Lumio.Client.Gameplay.ECS;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.Sample.Gameplay;

namespace Lumio.Sample.Bots;

/// <summary>
/// Half-dug-in-save scenario (criterion 6, toolfix v0.0.4): swing the pickaxe at one vein until
/// the <em>authority</em> has accepted exactly <c>k</c> hits (<c>LUMIO_PARTIAL_MINING_SWINGS</c>,
/// default 3), then <em>stop on its own</em> and let the bot log out normally — unlike
/// <see cref="AcceptancePersistenceScenario"/>'s <c>half</c> role, which relies on the driver
/// killing the process between two pickaxes and on a stamina-39 config side-file. Here nothing is
/// killed and no config is swapped: <c>k</c> is below the authored <c>vein_hits_to_break = 6</c>
/// (each accepted hit decrements <c>VeinReserveComponent.Remaining</c> by exactly one, stamina
/// 13/hit out of 100, so k=3 costs 39 and cannot possibly break the vein through), and the
/// scenario completes the moment the confirmed reserve has dropped by k. The driver then waits
/// for the post-logout checkpoint before stopping the server, so the half-dug reserve reaches the
/// store through the server's own write path, not through a kill racing the gameplay.
/// <para>
/// Discipline (B-00172 轮重写): the bot view has identities, not vein positions (SampleMiningPlan
/// 的既定事实:位置唯一来源是权威绑定表,不下发), so there is no navigation toward a vein — the
/// bot walks the same blind square spiral the tour uses and swings at its target every cooldown;
/// the authority answers out-of-reach swings with an ordinary refusal (invisible here, only as
/// the reserve not moving). The client's local prediction accepts every swing ("unknown distance
/// is ask-the-authority"), so the only honest hit counter is the <b>confirmed</b>
/// <c>VeinReserveComponent.remaining</c> read through <see cref="BotWorldView.Fields"/>:
/// baseline − current = accepted hits. Census-only targeting, same discipline as
/// <see cref="SampleMiningScenario"/>.
/// </para>
/// </summary>
public sealed class PartialMiningScenario : BotScenario
{
    /// <summary>Wire mapping the activations travel under.</summary>
    public const string RequiredCapability = WireCodec.ServerRpc;

    private static readonly string[] Capabilities = { RequiredCapability };

    private const int DefaultSwings = 3;
    /// <summary>Authored vein_hits_to_break; a swing count at or above it would break the vein through.</summary>
    private const int MaxSafeSwings = 5;
    /// <summary>VeinReserveComponent.remaining 的字段地址(BotFieldLookup 直读确认值)。</summary>
    private const string ReserveField = "VeinReserveComponent.remaining";
    /// <summary>Ticks between two swings: cooldown is 1 tick (mining table), one spare tick keeps the cadence observable.</summary>
    private const int SwingIntervalTicks = 2;
    private const string VeinType = SampleMiningPlan.VeinEntityType;
    private static readonly int[] SweepX = { 1, 0, -1, 0 };
    private static readonly int[] SweepZ = { 0, 1, 0, -1 };

    private readonly int _plannedSwings = ReadPlannedSwings();
    private uint _seed = 1u;
    private int _leg;
    private int _legLength = 1;
    private int _legRemaining;
    private int _legTurns;
    private string _target = string.Empty;
    private readonly List<SampleBotEntity> _census = new();
    private ulong _sequence;
    private int _accepted;
    private int _swingCooldown;
    private string _selfId = string.Empty;
    private int _baseline = -1;
    private int _confirmed;
    private BotFieldLookup _fields;

    private static int ReadPlannedSwings()
    {
        string? raw = Environment.GetEnvironmentVariable("LUMIO_PARTIAL_MINING_SWINGS");
        return int.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out int value) ? value : DefaultSwings;
    }

    /// <inheritdoc />
    public override IReadOnlyList<string> RequiredCapabilities => Capabilities;

    /// <inheritdoc />
    public override BotStepResult Step(in BotDriverContext context)
    {
        BotWorldView world = context.World;
        if (world.HasSelf) _selfId = world.Self.NetEntityId;
        _fields = world.Fields;
        SampleBotCommand command = Advance(world.HasSelf, world.Self.NetEntityId, ReadCensus(in world),
            hex => world.Departures[hex].Vanished);
        switch (command.Act)
        {
            case SampleBotAct.Mine:
                Issue(in context, nameof(MineAbility), Payload(new MineAbility.Input { TargetHex = command.TargetHex }));
                return BotStepResult.Continue;
            case SampleBotAct.Move:
                Issue(in context, nameof(MoveAbility), Payload(new MoveAbility.Input { Dx = command.Dx, Dz = command.Dz }));
                return BotStepResult.Continue;
            case SampleBotAct.Done:
                return context.Uplinks > 0 ? BotStepResult.Complete : BotStepResult.Continue;
            default:
                return BotStepResult.Continue;
        }
    }

    /// <inheritdoc />
    public override void Assert(in BotDriverContext context, BotAssertionSink sink)
    {
        ArgumentNullException.ThrowIfNull(sink);
        WriteReport();
        sink.That(_plannedSwings is > 0 and <= MaxSafeSwings, $"planned_swings:{_plannedSwings} (scenario limit:{MaxSafeSwings})");
        sink.That(_selfId.Length > 0, "self_report:" + _selfId);
        sink.That(_accepted > 0, "activation_accepted");
        sink.That(context.Uplinks >= 1, "bot_uplinked");
        // 权威确认的储量下降恰等于计划数(本地预测接受不作数,见类头),一次不多。
        sink.That(_confirmed == _plannedSwings, $"confirmed_hits:{_confirmed} == planned:{_plannedSwings}");
        // 没挖穿:剩余储量 > 0,且目标 vein 仍在 census(挖穿即 terminated、从 census 消失)。
        sink.That(ReadReserve() > 0, $"reserve_not_broken_through:{ReadReserve()}");
        sink.That(_target.Length > 0, "target_report:" + _target);
        BotWorldView world = context.World;
        sink.That(Holds(ReadCensus(in world), _target, VeinType), "vein_still_present:" + _target);
    }

    /// <summary>
    /// 机器可读汇报:Self id、目标脉与确认计数写进 LUMIO_PARTIAL_MINING_REPORT 指向的文件,
    /// 驱动器用它对观察流的账号↔实体配对与「储量已下降但未挖穿」断言。
    /// </summary>
    private void WriteReport()
    {
        string? path = Environment.GetEnvironmentVariable("LUMIO_PARTIAL_MINING_REPORT");
        if (string.IsNullOrWhiteSpace(path)) return;
        try
        {
            File.WriteAllText(path,
                $"self={_selfId} target={_target} planned={_plannedSwings} confirmed={_confirmed} baseline={_baseline} reserve={ReadReserve()}\n");
        }
        catch (Exception error) when (error is IOException or System.Security.SecurityException or UnauthorizedAccessException)
        {
            // 报告写不进去不是玩法失败:断言照常,驱动器会看到缺文件并如实报 FAIL。
        }
    }

    /// <summary>
    /// 盲扫 + 持续挥镐 + 按确认储量计镐数。每 tick:先按 Fields 的确认储量更新
    /// baseline/confirmed;confirmed 达到 k 即 Done;否则每个 SwingIntervalTicks 对目标挥一镐,
    /// 其余 tick 走螺旋(权威把超距/冷却/无体力的镐当普通答案拒绝,refusal 不可见)。
    /// </summary>
    private SampleBotCommand Advance(bool hasSelf, string? selfHex, IReadOnlyList<SampleBotEntity> census,
        Func<string, bool> isVanished)
    {
        if (!hasSelf) return SampleBotCommand.Wait;
        if (_seed == 1u)
        {
            _seed = Mix(selfHex);
            _leg = (int)(_seed & 3u);
        }

        // 目标被别人挖穿(专用 boot 不应发生):如实换目标,基数与计数一并重来。
        if (_target.Length != 0 && !Holds(census, _target, VeinType) && isVanished(_target))
        {
            _target = string.Empty;
            _baseline = -1;
            _confirmed = 0;
            _swingCooldown = 0;
        }

        if (_target.Length == 0)
        {
            string picked = Choose(census, VeinType);
            if (picked.Length == 0) return NextSweepStep();
            _target = picked;
            _baseline = -1;
            _swingCooldown = 0;
        }

        int current = ReadReserve();
        if (current >= 0)
        {
            if (_baseline < 0 || current > _baseline) _baseline = current;
            _confirmed = Math.Max(_confirmed, _baseline - current);
        }

        if (_confirmed >= _plannedSwings) return SampleBotCommand.Done;

        // 首中之后停止扫掠:此刻已处于触及内,原地按冷却连挥,后续各镐即刻落地
        // (继续盲扫要等整圈螺旋再次经过目标,3 镐可能超出驱动的 15 分钟窗口)。
        if (_confirmed > 0)
        {
            if (_swingCooldown > 0)
            {
                _swingCooldown--;
                return SampleBotCommand.Wait;
            }
            _swingCooldown = SwingIntervalTicks - 1;
            return SampleBotCommand.Mine(_target);
        }

        if (_swingCooldown > 0)
        {
            _swingCooldown--;
            return NextSweepStep();
        }
        _swingCooldown = SwingIntervalTicks - 1;
        return SampleBotCommand.Mine(_target);
    }

    /// <summary>VeinReserveComponent.remaining 的确认值;Fields 未投递到本副本时返回 -1(照常盲扫)。</summary>
    private int ReadReserve()
    {
        try
        {
            if (_target.Length == 0) return -1;
            ReplicaFieldObservation observed = _fields[_target, ReserveField];
            long? value = observed.Found ? observed.Value.WholeNumber : null;
            return value.HasValue ? (int)value.Value : -1;
        }
        catch (Exception error) when (error is IndexOutOfRangeException or KeyNotFoundException or InvalidOperationException)
        {
            return -1;
        }
    }

    private static bool Holds(IReadOnlyList<SampleBotEntity> census, string hex, string entityType)
    {
        for (int i = 0; i < census.Count; i++)
        {
            if (string.Equals(census[i].NetEntityId, hex, StringComparison.Ordinal)
                && string.Equals(census[i].EntityType, entityType, StringComparison.Ordinal)) return true;
        }

        return false;
    }

    private string Choose(IReadOnlyList<SampleBotEntity> census, string entityType)
    {
        int count = 0;
        for (int i = 0; i < census.Count; i++)
            if (string.Equals(census[i].EntityType, entityType, StringComparison.Ordinal)) count++;
        if (count == 0) return string.Empty;

        int wanted = (int)(_seed % (uint)count);
        int seen = 0;
        for (int i = 0; i < census.Count; i++)
        {
            if (!string.Equals(census[i].EntityType, entityType, StringComparison.Ordinal)) continue;
            if (seen == wanted) return census[i].NetEntityId;
            seen++;
        }

        return string.Empty;
    }

    private SampleBotCommand NextSweepStep()
    {
        if (_legRemaining == 0)
        {
            _leg = (_leg + 1) & 3;
            _legTurns++;
            if ((_legTurns & 1) == 0 && _legLength < SampleMiningPlan.SweepArmCells) _legLength++;
            _legRemaining = _legLength;
        }

        _legRemaining--;
        return SampleBotCommand.Move(SweepX[_leg], SweepZ[_leg]);
    }

    private static uint Mix(string? selfHex)
    {
        uint hash = 2166136261u;
        string text = selfHex ?? string.Empty;
        for (int i = 0; i < text.Length; i++)
        {
            hash ^= text[i];
            hash *= 16777619u;
        }

        return hash == 0u ? 1u : hash;
    }

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
    }

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

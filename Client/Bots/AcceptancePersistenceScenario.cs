using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using Lumio.Client.Bot;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.Sample.Gameplay;

namespace Lumio.Sample.Bots;

/// <summary>
/// Criterion-6 acceptance scenario (integration/acceptance-v0.0.2/criterion6): one bot, one role,
/// selected by the <c>LUMIO_PERSIST_ROLE</c> environment variable —
///   <c>half</c>  : keep mining veins until the driver kills it on the first observed
///                 VeinReserveComponent.remaining decrement (the half-dug verdict is the
///                 observer stream, not this side’s count),
///                 (stamina 100 / 13 a hit buys exactly this much; the authority refuses the rest),
///   <c>leave</c> : dig one vein through and leave its drop on the ground,
///   <c>pick</c>  : dig one vein through and pick its drop up.
/// The three roles run as three accounts, strictly sequentially (the driver waits for each
/// result.ndjson), so they never contend for the same vein and the store ends with the three
/// intermediate persistence states: half-dug vein / unpicked drop / picked drop. The authored map
/// has four vein cells, so a later restore must show two live veins and exactly one ore drop.
/// Census-only decisions, same discipline as <see cref="SampleMiningScenario"/>.
/// </summary>
public sealed class AcceptancePersistenceScenario : BotScenario
{
    /// <summary>Wire mapping the activations travel under.</summary>
    public const string RequiredCapability = WireCodec.ServerRpc;

    private static readonly string[] Capabilities = { RequiredCapability };

    private const int SettleGraceTicks = 160;
    private const int DwellTicks = SampleMiningPlan.DwellTicks;
    private const int SlowCycleTicks = 45;
    private const int ApproachStepBudget = 3000;
    private const int SweepArmCells = SampleMiningPlan.SweepArmCells;
    private static readonly int[] SweepX = { 1, 0, -1, 0 };
    private static readonly int[] SweepZ = { 0, 1, 0, -1 };
    private const string VeinType = SampleMiningPlan.VeinEntityType;
    private const string DropType = SampleMiningPlan.OreDropEntityType;

    private readonly string _role = Environment.GetEnvironmentVariable("LUMIO_PERSIST_ROLE") ?? "half";
    private readonly HashSet<string> _used = new(
        (Environment.GetEnvironmentVariable("LUMIO_PERSIST_AVOID") ?? string.Empty)
            .Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries));
    private uint _seed = 1u;
    private int _leg;
    private int _legLength = 1;
    private int _legRemaining;
    private int _legTurns;
    private int _dwell;
    private int _grace;
    private string _target = string.Empty;
    private readonly List<SampleBotEntity> _census = new();
    private ulong _sequence;
    private int _accepted;
    private string _lastReject = string.Empty;
    private string _selfId = string.Empty;

    private int _mineOrdersOnTarget;
    private int _cycleTick;
    private int _approachSteps;
    private string _selfHex = string.Empty;
    private bool _veinDugThrough;
    private bool _dropPicked;
    private int _dropSeen;

    /// <inheritdoc />
    public override IReadOnlyList<string> RequiredCapabilities => Capabilities;

    /// <inheritdoc />
    public override BotStepResult Step(in BotDriverContext context)
    {
        BotWorldView world = context.World;
        if (world.HasSelf) _selfId = world.Self.NetEntityId;
        (double X, double Y, double Z) PositionOf(string hex)
        {
            var position = world.WorldPositions[hex];
            return (position.X, position.Y, position.Z);
        }

        SampleBotCommand command = Advance(world.HasSelf, world.Self.NetEntityId, ReadCensus(in world),
            hex => world.Departures[hex].Vanished, PositionOf);
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
        sink.That(_role is "half" or "leave" or "pick", "role:" + _role);
        sink.That(_selfId.Length > 0, "self_report:" + _selfId);
        sink.That(_accepted > 0, "activation_accepted:" + _lastReject);
        sink.That(context.Uplinks >= 1, "bot_uplinked");
        if (_role == "half")
        {
            // half 角色由驱动器在观察流看到储量首次下降时强杀：这里只报告它挖了谁、
            // 是否一直在场；「半挖」的判定真值是观察流里的 VeinReserveComponent.remaining。
            sink.That(_mineOrdersOnTarget > 0, "half_orders_issued:" + _mineOrdersOnTarget);
        }
        else
        {
            sink.That(_veinDugThrough, "vein_dug_through");
            if (_role == "pick")
            {
                sink.That(_dropSeen > 0, "drop_seen");
                sink.That(_dropPicked, "drop_picked");
            }
        }
    }

    /// <summary>
    /// 机器可读汇报（断言 label 只在失败时落盘，成功时无处可写）：把角色、Self id 与
    /// half 角色的目标脉写进 LUMIO_PERSIST_REPORT 指向的文件——驱动器用它做后续角色的
    /// LUMIO_PERSIST_AVOID 与观察流的账号↔实体配对。
    /// </summary>
    private void WriteReport()
    {
        string? path = Environment.GetEnvironmentVariable("LUMIO_PERSIST_REPORT");
        if (string.IsNullOrWhiteSpace(path)) return;
        try
        {
            File.WriteAllText(path, $"role={_role} self={_selfId} target={_target}\n");
        }
        catch (Exception error) when (error is IOException or System.Security.SecurityException or UnauthorizedAccessException)
        {
            // 报告写不进去不是玩法失败：断言照常，驱动器会看到缺文件并如实报 FAIL。
        }
    }

    private SampleBotCommand Advance(bool hasSelf, string? selfHex, IReadOnlyList<SampleBotEntity> census,
        Func<string, bool> isVanished, Func<string, (double X, double Y, double Z)> positionOf)
    {
        if (!hasSelf) return SampleBotCommand.Wait;
        if (_seed == 1u)
        {
            _seed = Mix(selfHex);
            _leg = (int)(_seed & 3u);
        }
        _selfHex = selfHex ?? string.Empty;

        return _role == "half" ? AdvanceSlowMining(census, isVanished, positionOf) : AdvanceFull(census, isVanished);
    }

    /// <summary>
    /// half 角色的慢镐速循环：每个 <see cref="SlowCycleTicks"/> 周期只发一镐（其余时间 Wait，
    /// 每 4 个周期补一步游走）。命中频率被压到 ~1 镐 / 2.25 s，驱动器对观察流 500 ms 一轮
    /// 必能在储量首次下降后、下一镐到来前杀掉本进程——「半挖」由数据面判定，两侧时序
    /// 无需精确同步。远处被拒的镐不耗体力、无副作用（判据 5 的测试证过该路径）。
    /// </summary>
    private SampleBotCommand AdvanceSlowMining(IReadOnlyList<SampleBotEntity> census, Func<string, bool> isVanished,
        Func<string, (double X, double Y, double Z)>? positionOf)
    {
        if (_target.Length != 0 && !Holds(census, _target, VeinType) && isVanished(_target))
        {
            _used.Add(_target); // 被别人挖穿了（不应发生：驱动器会避开）；换一条。
            _target = string.Empty;
            _cycleTick = 0;
        }

        if (_target.Length == 0)
        {
            string picked = Choose(census, VeinType);
            if (picked.Length == 0) return NextSweepStep();
            _target = picked;
            _cycleTick = 0;
        }

        // 靠近阶段：每 tick 一步游走（tour 同速）。看得见够不着时挖了也是被拒，
        // 先用位置查询贴到目标旁边（格心距 ≤2.1，覆盖对角邻接（地图角落的矿脉只能对角贴近））。
        if (positionOf != null && _approachSteps < ApproachStepBudget)
        {
            try
            {
                (double vx, _, double vz) = positionOf(_target);
                (double sx, _, double sz) = positionOf(_selfHex);
                double dx = vx - sx;
                double dz = vz - sz;
                if (dx * dx + dz * dz > 2.1 * 2.1)
                {
                    _approachSteps++;
                    return SampleBotCommand.Move(Math.Sign(dx), Math.Sign(dz));
                }
            }
            catch (Exception error) when (error is IndexOutOfRangeException or KeyNotFoundException or InvalidOperationException)
            {
                // 位置查不到（方块实体可能不带位置条目 / AOI 边缘）：计入预算后退回游走，
                // 预算耗尽后无条件进入慢镐阶段——被拒的镐无副作用，落地一镐即达成半挖。
                _approachSteps++;
                return NextSweepStep();
            }
        }

        // 贴近后：慢镐速——每 SlowCycleTicks 一镐，驱动器 500ms 一轮必能在储量首次
        // 下降后、下一镐到来前把本进程杀掉。
        if (_cycleTick == 0)
        {
            _cycleTick = 1;
            _mineOrdersOnTarget++;
            return SampleBotCommand.Mine(_target);
        }

        _cycleTick++;
        if (_cycleTick < SlowCycleTicks) return SampleBotCommand.Wait;
        _cycleTick = 0;
        return SampleBotCommand.Wait;
    }

    private SampleBotCommand AdvanceFull(IReadOnlyList<SampleBotEntity> census, Func<string, bool> isVanished)
    {
        if (_target.Length == 0 && !_veinDugThrough)
        {
            string picked = Choose(census, VeinType);
            if (picked.Length == 0) return NextSweepStep();
            _target = picked;
            _dwell = 1;
            _mineOrdersOnTarget++;
            return SampleBotCommand.Mine(picked);
        }

        if (!_veinDugThrough)
        {
            if (!Holds(census, _target, VeinType))
            {
                if (!isVanished(_target)) return SampleBotCommand.Wait;
                _veinDugThrough = true;
                _used.Add(_target);
                _target = string.Empty;
                _dwell = 0;
                _grace = 0;
                if (_role != "pick")
                {

                    return SampleBotCommand.Done;
                }
                return SampleBotCommand.Wait;
            }

            if (_dwell < DwellTicks)
            {
                _dwell++;
                return SampleBotCommand.Mine(_target);
            }

            _dwell = 0;
            return NextSweepStep();
        }

        // pick role: collect this vein's drop.
        if (_target.Length != 0)
        {
            if (!Holds(census, _target, DropType))
            {
                if (!isVanished(_target)) return SampleBotCommand.Wait;
                _dropPicked = true;

                return SampleBotCommand.Done;
            }

            if (_dwell < DwellTicks)
            {
                _dwell++;
                return SampleBotCommand.Pickup(_target);
            }

            _dwell = 0;
            return NextSweepStep();
        }

        string drop = Choose(census, DropType);
        if (drop.Length == 0)
        {
            if (_grace < SettleGraceTicks)
            {
                _grace++;
                return SampleBotCommand.Wait;
            }

            return NextSweepStep();
        }

        _grace = 0;
        _dropSeen++;
        _target = drop;
        _dwell = 1;
        return SampleBotCommand.Pickup(drop);
    }

    private static bool Is(SampleBotEntity entity, string entityType)
        => string.Equals(entity.EntityType, entityType, StringComparison.Ordinal);

    private string Choose(IReadOnlyList<SampleBotEntity> census, string entityType)
    {
        int count = 0;
        for (int i = 0; i < census.Count; i++)
            if (Is(census[i], entityType) && !_used.Contains(census[i].NetEntityId)) count++;
        if (count == 0) return string.Empty;

        int wanted = (int)(_seed % (uint)count);
        int seen = 0;
        for (int i = 0; i < census.Count; i++)
        {
            if (!Is(census[i], entityType) || _used.Contains(census[i].NetEntityId)) continue;
            if (seen == wanted) return census[i].NetEntityId;
            seen++;
        }

        return string.Empty;
    }

    private static bool Holds(IReadOnlyList<SampleBotEntity> census, string hex, string entityType)
    {
        for (int i = 0; i < census.Count; i++)
            if (string.Equals(census[i].NetEntityId, hex, StringComparison.Ordinal) && Is(census[i], entityType)) return true;
        return false;
    }

    private SampleBotCommand NextSweepStep()
    {
        if (_legRemaining == 0)
        {
            _leg = (_leg + 1) & 3;
            _legTurns++;
            if ((_legTurns & 1) == 0 && _legLength < SweepArmCells) _legLength++;
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
        else _lastReject = issued.Reason;
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

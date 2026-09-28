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
/// Half-dug-in-save scenario (criterion 6, toolfix v0.0.3): swing the pickaxe a fixed
/// <c>k</c> times (<c>LUMIO_PARTIAL_MINING_SWINGS</c>, default 3) against one vein, then
/// <em>stop on its own</em> and let the bot log out normally — unlike
/// <see cref="AcceptancePersistenceScenario"/>'s <c>half</c> role, which relies on the
/// driver killing the process between two pickaxes and on a stamina-39 config side-file.
/// Here nothing is killed and no config is swapped: <c>k</c> is below the authored
/// <c>vein_hits_to_break = 6</c> (each accepted hit decrements
/// <c>VeinReserveComponent.Remaining</c> by exactly one, stamina 13/hit out of 100, so
/// k=3 costs 39 and cannot possibly break the vein through), and the scenario completes
/// the moment the k-th swing is accepted. The driver then waits for the post-logout
/// checkpoint before stopping the server, so the half-dug reserve reaches the store
/// through the server's own write path, not through a kill racing the gameplay.
/// Census-only decisions, same discipline as <see cref="SampleMiningScenario"/>; the
/// authoritative half-dug verdict is the observer stream's <c>Remaining</c>, not this
/// side's count.
/// </summary>
public sealed class PartialMiningScenario : BotScenario
{
    /// <summary>Wire mapping the activations travel under.</summary>
    public const string RequiredCapability = WireCodec.ServerRpc;

    private static readonly string[] Capabilities = { RequiredCapability };

    private const int DefaultSwings = 3;
    /// <summary>Authored vein_hits_to_break; a swing count at or above it would break the vein through.</summary>
    private const int MaxSafeSwings = 5;
    private const int ApproachStepBudget = 3000;
    /// <summary>Covers the diagonal-adjacent cells (corner veins can only be approached diagonally).</summary>
    private const double ApproachRadius = 2.1;
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
    private int _acceptedSwings;
    private int _swingCooldown;
    private int _approachSteps;
    private string _selfId = string.Empty;

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
        SampleBotCommand command = Advance(world.HasSelf, world.Self.NetEntityId, ReadCensus(in world),
            hex => world.Departures[hex].Vanished, hex => PositionOf(in world, hex));
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
        // 挥满 k 镐后必须已自律停手:被接受的挥镐数恰好等于计划数,一次不多。
        sink.That(_acceptedSwings == _plannedSwings, $"swings_accepted:{_acceptedSwings} == planned:{_plannedSwings}");
        // 没挖穿:目标 vein 仍在 census(挖穿即 terminated、从 census 消失)。
        sink.That(_target.Length > 0, "target_report:" + _target);
        BotWorldView world = context.World;
        sink.That(Holds(ReadCensus(in world), _target, VeinType), "vein_still_present:" + _target);
    }

    /// <summary>
    /// 机器可读汇报:Self id 与目标脉写进 LUMIO_PARTIAL_MINING_REPORT 指向的文件,
    /// 驱动器用它对观察流的账号↔实体配对与「储量已下降但未挖穿」断言。
    /// </summary>
    private void WriteReport()
    {
        string? path = Environment.GetEnvironmentVariable("LUMIO_PARTIAL_MINING_REPORT");
        if (string.IsNullOrWhiteSpace(path)) return;
        try
        {
            File.WriteAllText(path, $"self={_selfId} target={_target} planned={_plannedSwings} accepted={_acceptedSwings}\n");
        }
        catch (Exception error) when (error is IOException or System.Security.SecurityException or UnauthorizedAccessException)
        {
            // 报告写不进去不是玩法失败:断言照常,驱动器会看到缺文件并如实报 FAIL。
        }
    }

    /// <summary>位置直查(照 tour/判据 6 的同款路径):查不到就抛,调用方按预算退回游走。</summary>
    private static (double X, double Y, double Z) PositionOf(in BotWorldView world, string hex)
    {
        var position = world.WorldPositions[hex];
        return (position.X, position.Y, position.Z);
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
        string self = selfHex ?? string.Empty;

        // 目标被别人挖穿(专用 boot 不应发生):如实换目标,不把挖穿当半挖。
        if (_target.Length != 0 && !Holds(census, _target, VeinType) && isVanished(_target))
        {
            _target = string.Empty;
            _swingCooldown = 0;
        }
        if (_acceptedSwings >= _plannedSwings) return SampleBotCommand.Done;

        if (_target.Length == 0)
        {
            string picked = Choose(census, VeinType);
            if (picked.Length == 0) return NextSweepStep();
            _target = picked;
            _swingCooldown = 0;
        }

        // 靠近阶段:贴到目标旁(格心距 ≤ 2.1,覆盖对角邻接)再挥镐,避免白挥。
        if (_approachSteps < ApproachStepBudget)
        {
            try
            {
                var veinAt = positionOf(_target);
                var selfAt = positionOf(self);
                double dx = veinAt.X - selfAt.X;
                double dz = veinAt.Z - selfAt.Z;
                if (dx * dx + dz * dz > ApproachRadius * ApproachRadius)
                {
                    _approachSteps++;
                    return SampleBotCommand.Move(Math.Sign(dx), Math.Sign(dz));
                }
            }
            catch (Exception error) when (error is IndexOutOfRangeException or KeyNotFoundException or InvalidOperationException)
            {
                // 位置查不到(方块实体可能不带位置条目 / AOI 边缘):计入预算后退回游走,
                // 预算耗尽后照挥——被拒的镐无副作用,接受数不加,不会超过 k。
                _approachSteps++;
                return NextSweepStep();
            }
        }

        // 挥镐阶段:每 SwingIntervalTicks 一镐,直到第 k 次被接受即停手。
        if (_swingCooldown > 0)
        {
            _swingCooldown--;
            return SampleBotCommand.Wait;
        }
        _swingCooldown = SwingIntervalTicks - 1;
        return SampleBotCommand.Mine(_target);
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
        if (!issued.Accepted) return;
        _accepted++;
        // 只数被接受的挥镐:被拒的镐(够不着/冷却中)无副作用,不占用 k。
        if (abilityTypeName == nameof(MineAbility)) _acceptedSwings++;
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

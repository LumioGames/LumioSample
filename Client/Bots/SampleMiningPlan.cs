using System;
using System.Collections.Generic;

namespace Lumio.Sample.Bots;

/// <summary>Where a mining bot is in the dig → drop → pickup run.</summary>
public enum SampleMiningPhase
{
    /// <summary>No Self binding yet: the replica has not told the bot who it is.</summary>
    AwaitingSelf,

    /// <summary>A vein is (or is being looked for as) the target.</summary>
    Mining,

    /// <summary>The targeted vein left the census; the drop it left behind is the target.</summary>
    Collecting,

    /// <summary>The targeted drop left the census: the run is over.</summary>
    Complete,
}

/// <summary>What the plan wants the scenario to put on the wire this tick.</summary>
public enum SampleBotAct
{
    /// <summary>Issue nothing this tick.</summary>
    Wait,

    /// <summary>Activate the mine ability against <see cref="SampleBotCommand.TargetHex"/>.</summary>
    Mine,

    /// <summary>Activate the pickup ability against <see cref="SampleBotCommand.TargetHex"/>.</summary>
    Pickup,

    /// <summary>Activate the move ability with <see cref="SampleBotCommand.Dx"/>/<see cref="SampleBotCommand.Dz"/>.</summary>
    Move,

    /// <summary>The run reached its end; the scenario may report completion.</summary>
    Done,
}

/// <summary>
/// One entity the replica currently shows, reduced to the two things the plan needs: the
/// net-entity id an ability input targets, and the entity type the census reports it under.
/// This mirrors the client's own visible-entity record without depending on it, so the plan
/// stays a pure function that a test can drive without a replica world.
/// </summary>
public readonly struct SampleBotEntity
{
    /// <summary>Builds a census row. Null parts read as empty, never as null.</summary>
    public SampleBotEntity(string? netEntityId, string? entityType)
    {
        NetEntityId = netEntityId ?? string.Empty;
        EntityType = entityType ?? string.Empty;
    }

    /// <summary>Net entity id in hex — exactly what a target-by-entity ability input carries.</summary>
    public string NetEntityId { get; }

    /// <summary>Entity type as the gameplay registry's wire name.</summary>
    public string EntityType { get; }
}

/// <summary>One tick's decision. Only the fields the chosen <see cref="Act"/> uses are filled.</summary>
public readonly struct SampleBotCommand
{
    private SampleBotCommand(SampleBotAct act, string targetHex, int dx, int dz)
    {
        Act = act;
        TargetHex = targetHex;
        Dx = dx;
        Dz = dz;
    }

    /// <summary>Issue nothing.</summary>
    public static SampleBotCommand Wait
    {
        get { return new SampleBotCommand(SampleBotAct.Wait, string.Empty, 0, 0); }
    }

    /// <summary>The run is over.</summary>
    public static SampleBotCommand Done
    {
        get { return new SampleBotCommand(SampleBotAct.Done, string.Empty, 0, 0); }
    }

    /// <summary>Hit <paramref name="targetHex"/> once.</summary>
    public static SampleBotCommand Mine(string targetHex)
    {
        return new SampleBotCommand(SampleBotAct.Mine, targetHex ?? string.Empty, 0, 0);
    }

    /// <summary>Claim the drop <paramref name="targetHex"/>.</summary>
    public static SampleBotCommand Pickup(string targetHex)
    {
        return new SampleBotCommand(SampleBotAct.Pickup, targetHex ?? string.Empty, 0, 0);
    }

    /// <summary>Walk one grid cell.</summary>
    public static SampleBotCommand Move(int dx, int dz)
    {
        return new SampleBotCommand(SampleBotAct.Move, string.Empty, dx, dz);
    }

    /// <summary>What to do this tick.</summary>
    public SampleBotAct Act { get; }

    /// <summary>Target net entity id in hex for <see cref="SampleBotAct.Mine"/> / <see cref="SampleBotAct.Pickup"/>.</summary>
    public string TargetHex { get; }

    /// <summary>Signed X step for <see cref="SampleBotAct.Move"/>.</summary>
    public int Dx { get; }

    /// <summary>Signed Z step for <see cref="SampleBotAct.Move"/>.</summary>
    public int Dz { get; }
}

/// <summary>
/// The mining bot's whole decision procedure, as a pure state machine over the replica census.
/// It never reads a gameplay table and never counts hits: how many times a vein must be struck,
/// what a hit costs and how long the cooldown is are authority-side rules, so the plan simply
/// keeps hitting its target until the census stops showing it, and treats every refusal the
/// authority makes (out of reach, on cooldown, out of stamina, somebody else's vein) as an
/// ordinary answer rather than a fault — the bot cannot see refusals at all, only their absence
/// of effect.
/// <para>
/// Approach is a blind sweep on purpose. The client's read-only bot view reports identities, not
/// positions, so nothing here can steer toward a vein; it walks a deterministic square spiral,
/// seeded per bot, and dwells long enough on each cell for a full break to land when the spiral
/// happens to bring it inside the authority's melee reach.
/// </para>
/// </summary>
public sealed class SampleMiningPlan
{
    /// <summary>
    /// Wire name of the vein entity type. Asserted against the generated registry by
    /// <c>SampleMiningPlanTests</c> so a renamed entity fails a test instead of a live run.
    /// </summary>
    public const string VeinEntityType = "vein";

    /// <summary>Wire name of the dropped-ore entity type. Same test guards it.</summary>
    public const string OreDropEntityType = "oreDrop";

    /// <summary>
    /// Ticks the bot keeps working one target before it takes another sweep step. This is bot
    /// pacing, not a gameplay number: it only has to outlast the ability cooldown often enough
    /// that a break can complete while the sweep is inside reach.
    /// </summary>
    public const int DwellTicks = 12;

    /// <summary>Ticks the bot stands still waiting for a dug vein's drop to reach the census.</summary>
    public const int SettleGraceTicks = 8;

    /// <summary>Longest sweep arm, so the spiral keeps circling instead of growing forever.</summary>
    public const int SweepArmCells = 24;

    private static readonly int[] SweepX = { 1, 0, -1, 0 };
    private static readonly int[] SweepZ = { 0, 1, 0, -1 };

    private string _target = string.Empty;
    private uint _seed = 1u;
    private int _leg;
    private int _legLength = 1;
    private int _legRemaining;
    private int _legTurns;
    private int _dwell;
    private int _grace;

    /// <summary>Where the run currently is.</summary>
    public SampleMiningPhase Phase { get; private set; } = SampleMiningPhase.AwaitingSelf;

    /// <summary>The net entity id the plan is working on, or empty while it is looking for one.</summary>
    public string TargetHex
    {
        get { return _target; }
    }

    /// <summary>True once the replica reported a Self binding.</summary>
    public bool SelfBound { get; private set; }

    /// <summary>Mine activations the plan asked for.</summary>
    public int MineOrders { get; private set; }

    /// <summary>Pickup activations the plan asked for.</summary>
    public int PickupOrders { get; private set; }

    /// <summary>Move activations the plan asked for.</summary>
    public int MoveOrders { get; private set; }

    /// <summary>
    /// True once the vein this bot was hitting left the census. That is what digging through a
    /// vein looks like from a client — and it is all a client can honestly claim: another miner's
    /// final hit looks exactly the same from here.
    /// </summary>
    public bool TargetVeinGone { get; private set; }

    /// <summary>
    /// True once any vein entered this connection's census. A vein is a block entity (ADR-119):
    /// it reaches a client only through a delivered Section's binding table, so this is the
    /// end-to-end proof the voxel Section channel carried content to this bot.
    /// </summary>
    public bool VeinSeenInCensus { get; private set; }

    /// <summary>True once the drop this bot was claiming left the census.</summary>
    public bool TargetDropGone { get; private set; }

    /// <summary>
    /// One tick. <paramref name="visible"/> is this frame's census; <paramref name="selfHex"/>
    /// seeds the per-bot sweep and target choice so two bots in one world do not queue behind the
    /// same vein (the authority admits one unsettled dig per vein).
    /// <para>
    /// <paramref name="isVanished"/> answers, for one net-entity id the plan is currently tracking,
    /// whether it left the census because it was actually destroyed (<c>terminated</c>) rather than
    /// merely because this connection's Section subscription changed (<c>left_aoi</c> — block
    /// entities, ADR-119, can leave the census that way without dying, and the number may come back
    /// under the same id). Omitting it (<c>null</c>) keeps the old, coarser "gone from the census at
    /// all" reading, so a caller that cannot yet tell the two apart still compiles and runs.
    /// </para>
    /// </summary>
    public SampleBotCommand Advance(bool hasSelf, string? selfHex, IReadOnlyList<SampleBotEntity>? visible,
        Func<string, bool>? isVanished = null)
    {
        IReadOnlyList<SampleBotEntity> census = visible ?? Array.Empty<SampleBotEntity>();
        if (Phase == SampleMiningPhase.Complete) return SampleBotCommand.Done;
        // A binding that has not arrived — or one that was lost — pauses the run instead of
        // ending it: the host may still be admitting this bot.
        if (!hasSelf) return SampleBotCommand.Wait;
        if (Phase == SampleMiningPhase.AwaitingSelf)
        {
            SelfBound = true;
            _seed = Mix(selfHex);
            _leg = (int)(_seed & 3u);
            Phase = SampleMiningPhase.Mining;
        }

        return Phase == SampleMiningPhase.Mining ? AdvanceMining(census, isVanished) : AdvanceCollecting(census, isVanished);
    }

    private SampleBotCommand AdvanceMining(IReadOnlyList<SampleBotEntity> census, Func<string, bool>? isVanished)
    {
        if (_target.Length != 0)
        {
            if (!Holds(census, _target, VeinEntityType))
            {
                // Only a real dig-through (terminated) ends the mining leg. A block-entity vein that
                // merely left this connection's Section subscription (left_aoi) is not gone — it may
                // return under the same id — so the plan keeps waiting on it rather than declaring
                // victory and wandering off to look for a drop that was never made.
                if (isVanished is not null && !isVanished(_target)) return SampleBotCommand.Wait;
                TargetVeinGone = true;
                Phase = SampleMiningPhase.Collecting;
                _target = string.Empty;
                _dwell = 0;
                _grace = 0;
                return SampleBotCommand.Wait;
            }

            if (_dwell < DwellTicks)
            {
                _dwell++;
                MineOrders++;
                return SampleBotCommand.Mine(_target);
            }

            _dwell = 0;
            return NextSweepStep();
        }

        string picked = Choose(census, VeinEntityType);
        if (picked.Length == 0) return NextSweepStep();
        VeinSeenInCensus = true;
        _target = picked;
        _dwell = 1;
        MineOrders++;
        return SampleBotCommand.Mine(picked);
    }

    private SampleBotCommand AdvanceCollecting(IReadOnlyList<SampleBotEntity> census, Func<string, bool>? isVanished)
    {
        if (_target.Length != 0)
        {
            if (!Holds(census, _target, OreDropEntityType))
            {
                if (isVanished is not null && !isVanished(_target)) return SampleBotCommand.Wait;
                TargetDropGone = true;
                Phase = SampleMiningPhase.Complete;
                _target = string.Empty;
                return SampleBotCommand.Done;
            }

            if (_dwell < DwellTicks)
            {
                _dwell++;
                PickupOrders++;
                return SampleBotCommand.Pickup(_target);
            }

            _dwell = 0;
            return NextSweepStep();
        }

        string picked = Choose(census, OreDropEntityType);
        if (picked.Length == 0)
        {
            // The dig settles a frame after the cell publishes, so the drop is worth waiting for
            // where the bot already stands before the sweep walks it away from its own ore.
            if (_grace < SettleGraceTicks)
            {
                _grace++;
                return SampleBotCommand.Wait;
            }

            return NextSweepStep();
        }

        _grace = 0;
        _target = picked;
        _dwell = 1;
        PickupOrders++;
        return SampleBotCommand.Pickup(picked);
    }

    /// <summary>
    /// The next cell of a square spiral: arms of 1, 1, 2, 2, 3, 3 … cells, capped so the walk
    /// keeps circling a bounded area. Every step is one non-zero cell on each axis at most, which
    /// is exactly what the move ability admits.
    /// </summary>
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
        MoveOrders++;
        return SampleBotCommand.Move(SweepX[_leg], SweepZ[_leg]);
    }

    /// <summary>True when <paramref name="hex"/> is still in the census under <paramref name="entityType"/>.</summary>
    private static bool Holds(IReadOnlyList<SampleBotEntity> census, string hex, string entityType)
    {
        for (int i = 0; i < census.Count; i++)
        {
            if (string.Equals(census[i].NetEntityId, hex, StringComparison.Ordinal)
                && string.Equals(census[i].EntityType, entityType, StringComparison.Ordinal))
                return true;
        }

        return false;
    }

    /// <summary>
    /// One entity of <paramref name="entityType"/>, chosen by this bot's own seed so a crowd
    /// spreads over the veins it can see instead of every bot queueing on the first one. Empty
    /// when the census shows none.
    /// </summary>
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

    /// <summary>FNV-1a over the Self id. Deterministic per bot, and never zero.</summary>
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
}

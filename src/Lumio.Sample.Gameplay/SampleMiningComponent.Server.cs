using System;
using System.Collections.Generic;
using System.Linq;
using Lumio.GameRuntime.Coordination;
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Components.Vein;
using Lumio.Sample.Gameplay.Config;
using Lumio.Sample.Gameplay.EntityTypes;
using Microsoft.Extensions.Logging;

namespace Lumio.Sample.Gameplay;

public sealed partial class SampleMiningComponent
{
    // Correlate short ASCII records by transaction; the Native sink caps each payload at 240 bytes.
    private static readonly Action<ILogger, string, ulong, int, string?, Exception?> LogStage =
        LoggerMessage.Define<string, ulong, int, string?>(LogLevel.Information, default,
            "mining_stage txn={Txn} section={Section} cell={Cell} bound={Bound}");
    private static readonly Action<ILogger, string, uint, ulong, Exception?> LogBefore =
        LoggerMessage.Define<string, uint, ulong>(LogLevel.Information, default,
            "mining_pre txn={Txn} block={Block} revision={Revision}");
    private static readonly Action<ILogger, string, ulong, int, string, Exception?> LogApplied =
        LoggerMessage.Define<string, ulong, int, string>(LogLevel.Information, default,
            "mining_applied txn={Txn} section={Section} cell={Cell} vein={Vein}");
    private static readonly Action<ILogger, string, uint, ulong, string?, Exception?> LogAfter =
        LoggerMessage.Define<string, uint, ulong, string?>(LogLevel.Information, default,
            "mining_post txn={Txn} block={Block} revision={Revision} bound={Bound}");
    private static readonly Action<ILogger, string, int, Exception?> LogReward =
        LoggerMessage.Define<string, int>(LogLevel.Information, default,
            "mining_reward txn={Txn} amount={Amount}");

    private HostVoxelWorldAdapter? _adapter;
    private readonly Dictionary<string, PendingDig> _pending = new(StringComparer.Ordinal);
    private bool _initialized;
    private ulong _serial;

    internal void Advance()
    {
        HostVoxelWorldAdapter? current = VoxelGameplayBinding.Resolve(World.Manager);
        if (!ReferenceEquals(current, _adapter))
        {
            Detach();
            _adapter = current;
            if (current is not null) current.DigApplied += OnApplied;
        }
        if (current is null) return;
        // This world component owns Sample's result window. Applied digs left _pending in OnApplied;
        // a result that still maps to a pending dig means Native refused an admitted order after the
        // business phase already settled it. That is an engine fault, not a business outcome
        // (tick.md §3 rule 5 / §6): surface it instead of silently dropping the entry.
        foreach (VoxelTransactionResult result in current.DrainResults().Results)
        {
            if (!_pending.TryGetValue(result.TransactionId, out PendingDig? refused)) continue;
            _pending.Remove(result.TransactionId);
            throw new InvalidOperationException(
                $"Native refused admitted dig {result.TransactionId} (state {result.Outcome.State}, status {result.Outcome.Status}) "
                + $"for vein {refused.Vein.ToHex()}; its settlement already happened in MineAbility.Execute.");
        }
        if (!_initialized) Initialize(current);
    }

    internal bool CanMine(AbilityComponent owner, VeinReserveComponent vein)
    {
        HostVoxelWorldAdapter? adapter = VoxelGameplayBinding.Resolve(World.Manager);
        if (adapter is null || !vein.HasCell.Value || !_initialized) return false;
        // "Who digs owns the cell": one dig per player, per vein and per section each frame. Native
        // checks the frame-initial revision per section, so a second dig in the same section this
        // frame would be refused at commit; the gameplay avoids the conflict here instead (tick.md §3 rule 5).
        foreach (PendingDig pending in _pending.Values)
            if (pending.Player == owner.Entity || pending.Vein == vein.Entity || pending.Section == vein.SectionKey.Value) return false;
        VoxelCellQuery cell = adapter.Read(vein.SectionKey.Value, vein.CellOffset.Value);
        return cell.HasBlockId && cell.BlockId != 0
            && adapter.BindingGet(vein.SectionKey.Value, vein.CellOffset.Value) == vein.Entity.ToHex();
    }

    internal bool StageFinal(AbilityComponent owner, VeinReserveComponent vein)
    {
        if (!CanMine(owner, vein)) return false;
        HostVoxelWorldAdapter adapter = VoxelGameplayBinding.Resolve(World.Manager)!;
        VoxelCellQuery cell = adapter.Read(vein.SectionKey.Value, vein.CellOffset.Value);
        string transaction = NextTransaction("dig");
        var pending = new PendingDig(owner.Entity, vein.Entity, vein.SectionKey.Value, vein.CellOffset.Value,
            SampleConfigBinding.For(World).Mining.OrePerVein);
        _pending.Add(transaction, pending);
        VoxelStageResult result = adapter.TryStageDigThrough(vein.SectionKey.Value, vein.CellOffset.Value,
            cell.SectionRevision, transaction);
        if (result.Status == VoxelStageStatus.Staged)
        {
            LogStage(Log, transaction, vein.SectionKey.Value, vein.CellOffset.Value,
                adapter.BindingGet(vein.SectionKey.Value, vein.CellOffset.Value), null);
            LogBefore(Log, transaction, cell.BlockId, cell.SectionRevision, null);
            return true;
        }
        _pending.Remove(transaction);
        return false;
    }

    /// <summary>
    /// Phase-8 observer only. The business writes (stamina, reserve, drop order) already happened in
    /// <c>MineAbility.Execute</c>; this callback logs the published facts and asserts they match the
    /// dig Sample staged. It must never write business state (tick.md §3 rule 5).
    /// </summary>
    private void OnApplied(VoxelDigApplied applied)
    {
        if (!ReferenceEquals(VoxelGameplayBinding.Resolve(World.Manager), _adapter)) return;
        if (!_pending.TryGetValue(applied.TxnId, out PendingDig? pending)) return;
        _pending.Remove(applied.TxnId);
        if (applied.SectionKey != pending.Section || applied.CellOffset != pending.Cell
            || applied.BoundEntityId != pending.Vein.ToHex())
            throw new InvalidOperationException("Applied dig does not match its Sample owner.");
        if (World.Get<VeinReserveComponent>(pending.Vein).Remaining.Value != 0)
            throw new InvalidOperationException("Applied dig found a vein whose reserve was not settled at Execute.");
        VoxelCellQuery published = _adapter!.Read(pending.Section, pending.Cell);
        LogApplied(Log, applied.TxnId, pending.Section, pending.Cell, pending.Vein.ToHex(), null);
        LogAfter(Log, applied.TxnId, published.BlockId, published.SectionRevision,
            _adapter.BindingGet(pending.Section, pending.Cell), null);
        LogReward(Log, applied.TxnId, pending.Amount, null);
    }

    private void Initialize(HostVoxelWorldAdapter adapter)
    {
        ISampleConfig config = SampleConfigBinding.For(World);
        int width = config.Map.Width;
        int depth = config.Map.Depth;
        uint oreType = config.Map.OreBlockType;
        var veins = World.Each<VeinReserveComponent>().Where(v => v.HasCell.Value).ToList();
        bool created = false;
        var bindings = new List<VoxelBindingOp>();
        for (int z = 0; z < depth; z++)
        for (int x = 0; x < width; x++)
        {
            // Authored floor cells use the wire section/cell encoding, never a transform fallback.
            ulong section = ((ulong)(x >> 4) << 36) | (uint)(z >> 4);
            int offset = (z & 15) * 16 + (x & 15);
            VoxelCellQuery cell = adapter.Read(section, offset);
            if (!cell.HasBlockId) return;
            if ((cell.BlockId >> 8) != oreType) continue;
            VeinReserveComponent? vein = veins.SingleOrDefault(v => v.SectionKey.Value == section && v.CellOffset.Value == offset);
            if (vein is null)
            {
                if (adapter.BindingGet(section, offset) is not null)
                    throw new InvalidOperationException("Restored ore binding has no matching live vein.");
                EntityOrder order = SampleVein.Queue(World);
                vein = order.Get<VeinReserveComponent>();
                vein.HasCell.Value = true;
                vein.SectionKey.Value = section;
                vein.CellOffset.Value = offset;
                vein.CellX.Value = x;
                vein.CellY.Value = 0;
                vein.CellZ.Value = z;
                created = true;
                continue;
            }
            string? bound = adapter.BindingGet(section, offset);
            if (bound == vein.Entity.ToHex()) continue;
            if (bound is not null) throw new InvalidOperationException("Ore cell belongs to another entity.");
            bindings.Add(new VoxelBindingOp(section, offset, vein.Entity.ToHex()) { ExpectedSectionRevision = cell.SectionRevision });
        }
        if (created) return; // Binding metadata may only name entities made live by normal command-buffer commit.
        adapter.ReplaceBindingContext(new[] { new VoxelBindingPolicyEntry(oreType, World.Registry.WireName(typeof(VeinEntity))) },
            veins.Select(v => v.Entity).ToArray());
        if (bindings.Count != 0)
        {
            VoxelStageResult result = adapter.TryStageMutation(
                Array.Empty<VoxelWriteEntry>(), bindings, NextTransaction("bind"));
            if (result.Status != VoxelStageStatus.Staged) return;
            return; // Observe the published bindings next tick; Staged is not initialization success.
        }
        _initialized = true;
    }

    private string NextTransaction(string kind) => $"sample-{kind}-{World.InstanceId}-{World.Tick}-{++_serial}";

    private void Detach()
    {
        if (_adapter is not null) _adapter.DigApplied -= OnApplied;
        _adapter = null;
        _pending.Clear();
        _initialized = false;
    }

    protected override void OnDestroy() => Detach();

    private sealed record PendingDig(NetEntityId Player, NetEntityId Vein, ulong Section, int Cell, int Amount);
}

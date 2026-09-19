using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using Lumio.GameRuntime.Coordination;
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Components.Mining;
using Lumio.Sample.Gameplay.Components.Ore;
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
    private static readonly Action<ILogger, string, string, int, Exception?> LogRefused =
        LoggerMessage.Define<string, string, int>(LogLevel.Information, default,
            "mining_refused txn={Txn} vein={Vein} status={Status}");
    private static readonly Action<ILogger, string, string, bool, Exception?> LogRestored =
        LoggerMessage.Define<string, string, bool>(LogLevel.Information, default,
            "mining_restored txn={Txn} vein={Vein} settled={Settled}");

    private HostVoxelWorldAdapter? _adapter;
    // Which transactions this process placed and can therefore still expect a result for. The record
    // itself lives on the player entity. Restored delivery facts are drained before checking
    // records whose result is unavailable; this set only tracks work staged by this process.
    private readonly HashSet<string> _awaiting = new(StringComparer.Ordinal);
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
        Settle(current);
        if (!_initialized) Initialize(current);
    }

    /// <summary>
    /// Sample's settlement window, on the business phase (tick.md §3 rule 5). A terrain order only
    /// orders work; the stamina, the zeroed reserve and the drop order are written here, on the frame
    /// the terrain result comes back, and only when that result says the cell was actually published.
    /// A refusal is a legal business outcome — another writer took the section revision first — so the
    /// pending record is dropped, no ledger moves and nothing faults. Settlements are applied in
    /// staging order so two results drained in one frame land deterministically.
    /// </summary>
    private void Settle(HostVoxelWorldAdapter adapter)
    {
        List<(PendingDig Dig, int Status, bool Published)>? drained = null;
        foreach (VoxelTransactionResult result in adapter.DrainResults().Results)
        {
            PendingDigComponent? record = Find(result.TransactionId);
            if (record is null) continue;
            _awaiting.Remove(result.TransactionId);
            (drained ??= new()).Add((Take(record), result.Outcome.Status, Published(result.Outcome)));
        }
        if (drained is not null)
        {
            drained.Sort(static (left, right) => left.Dig.Serial.CompareTo(right.Dig.Serial));
            foreach ((PendingDig dig, int status, bool published) in drained)
            {
                if (!published)
                {
                    LogRefused(Log, dig.Transaction, dig.Vein, status, null);
                    continue;
                }
                Pay(dig);
            }
        }
        Reconcile();
    }

    /// <summary>
    /// Any restored result was already consumed by Settle. Remaining restored records have no
    /// obtainable outcome (including legacy saves) and are discarded without changing a ledger.
    /// Air or a cleared binding cannot identify which transaction changed that cell.
    /// </summary>
    private void Reconcile()
    {
        List<PendingDig>? restored = null;
        foreach (PendingDigComponent record in World.Each<PendingDigComponent>())
        {
            if (!record.Active.Value || _awaiting.Contains(record.Transaction.Value)) continue;
            (restored ??= new()).Add(Take(record));
        }
        if (restored is null) return;
        restored.Sort(static (left, right) => left.Serial.CompareTo(right.Serial));
        foreach (PendingDig dig in restored)
        {
            LogRestored(Log, dig.Transaction, dig.Vein, false, null);
        }
    }

    /// <summary>Writes what a published dig owes: the stamina debit, the zeroed reserve and the drop.</summary>
    private void Pay(PendingDig dig)
    {
        // The cell is air now, so the ore leaves the ground whatever became of the miner; only the
        // stamina debit needs the player to still be there, and the record itself is that player's.
        if (World.IsLive(dig.Player))
        {
            AttributeComponent attributes = World.Get<AttributeComponent>(dig.Player);
            string stamina = SampleConfigBinding.For(World).Stamina.Name;
            attributes.SetBaseValue(stamina, attributes.GetBaseValue(stamina) - dig.Cost);
        }
        // A published dig destroys the vein bound to the cell at phase 8, so this zero is only
        // observable when something kept the entity alive. It is never written on a refusal.
        if (NetEntityId.TryParse(dig.Vein, out NetEntityId vein) && World.IsLive(vein))
            World.Get<VeinReserveComponent>(vein).Remaining.Value = 0;
        EntityOrder drop = World.Commands.Create<OreDropEntity>();
        drop.Get<OrePileComponent>().Amount.Value = dig.Amount;
        drop.Get<OrePileComponent>().SpawnPosition = dig.Center;
        LogReward(Log, dig.Transaction, dig.Amount, null);
    }

    /// <summary>The Runtime's own "this transaction reached the world" test, read off one drained result.</summary>
    private static bool Published(VoxelMutationOutcome outcome) =>
        outcome.Status == 0 && outcome.State == VoxelTxnState.Applied && outcome.TokenConsumed
        && (outcome.Disposition == VoxelCommitDisposition.Original || outcome.Disposition == VoxelCommitDisposition.Duplicate);

    internal bool CanMine(AbilityComponent owner, VeinReserveComponent vein)
    {
        HostVoxelWorldAdapter? adapter = VoxelGameplayBinding.Resolve(World.Manager);
        if (adapter is null || !vein.HasCell.Value || !_initialized) return false;
        // "Who digs owns the cell": one unsettled dig per player and one per vein. Two players may
        // order digs on two veins of one section in one frame — Native refuses whichever loses the
        // section revision race, and under tick.md §3 rule 5 a refusal settles nothing and retries.
        string target = vein.Entity.ToHex();
        int inflight = 0;
        int owned = 0;
        foreach (PendingDigComponent pending in World.Each<PendingDigComponent>())
        {
            if (!pending.Active.Value) continue;
            inflight++;
            if (string.Equals(pending.VeinHex.Value, target, StringComparison.Ordinal)) return false;
            if (pending.Entity == owner.Entity) owned++;
        }
        // Refuse the activation rather than let unsettled work grow without bound (R-00650).
        if (owned >= PendingDigComponent.MaxPerPlayer || inflight >= PendingDigComponent.MaxPerWorld) return false;
        VoxelCellQuery cell = adapter.Read(vein.SectionKey.Value, vein.CellOffset.Value);
        return cell.HasBlockId && cell.BlockId != 0
            && adapter.BindingGet(vein.SectionKey.Value, vein.CellOffset.Value) == target;
    }

    /// <summary>
    /// Orders the final dig and records what settling it would owe. Nothing is paid here; the record
    /// waits on the miner's <see cref="PendingDigComponent"/> — persisted state, not a process-only
    /// dictionary — until <see cref="Settle"/> reads the terrain result or <see cref="Reconcile"/>
    /// reads the restored terrain.
    /// </summary>
    internal bool StageFinal(AbilityComponent owner, VeinReserveComponent vein)
    {
        if (!CanMine(owner, vein)) return false;
        HostVoxelWorldAdapter adapter = VoxelGameplayBinding.Resolve(World.Manager)!;
        VoxelCellQuery cell = adapter.Read(vein.SectionKey.Value, vein.CellOffset.Value);
        string transaction = NextTransaction("dig");
        ISampleConfig config = SampleConfigBinding.For(World);
        PendingDigComponent record = World.Get<PendingDigComponent>(owner.Entity);
        record.Transaction.Value = transaction;
        record.VeinHex.Value = vein.Entity.ToHex();
        record.SectionKey.Value = vein.SectionKey.Value;
        record.CellOffset.Value = vein.CellOffset.Value;
        record.CellX.Value = vein.CellX.Value;
        record.CellY.Value = vein.CellY.Value;
        record.CellZ.Value = vein.CellZ.Value;
        record.Amount.Value = config.Mining.OrePerVein;
        record.StaminaCost.Value = unchecked((ulong)config.Mining.StaminaCost);
        record.Serial.Value = _serial;
        record.Active.Value = true;
        _awaiting.Add(transaction);
        VoxelStageResult result = adapter.TryStageDigThrough(vein.SectionKey.Value, vein.CellOffset.Value,
            cell.SectionRevision, transaction);
        if (result.Status == VoxelStageStatus.Staged)
        {
            LogStage(Log, transaction, vein.SectionKey.Value, vein.CellOffset.Value,
                adapter.BindingGet(vein.SectionKey.Value, vein.CellOffset.Value), null);
            LogBefore(Log, transaction, cell.BlockId, cell.SectionRevision, null);
            return true;
        }
        Clear(record);
        _awaiting.Remove(transaction);
        return false;
    }

    /// <summary>
    /// Phase-8 observer only. It logs the published facts and asserts they match the dig Sample
    /// staged; the business writes happen later, when <see cref="Settle"/> reads this transaction's
    /// result. It must never write business state and must never consume the pending record, or the
    /// settlement would lose the entry it is waiting for (tick.md §3 rule 5).
    /// </summary>
    private void OnApplied(VoxelDigApplied applied)
    {
        if (!ReferenceEquals(VoxelGameplayBinding.Resolve(World.Manager), _adapter)) return;
        PendingDigComponent? pending = Find(applied.TxnId);
        if (pending is null) return;
        if (applied.SectionKey != pending.SectionKey.Value || applied.CellOffset != pending.CellOffset.Value
            || !string.Equals(applied.BoundEntityId, pending.VeinHex.Value, StringComparison.Ordinal))
            throw new InvalidOperationException("Applied dig does not match its Sample owner.");
        if (NetEntityId.TryParse(pending.VeinHex.Value, out NetEntityId vein) && World.IsLive(vein)
            && World.Get<VeinReserveComponent>(vein).Remaining.Value == 0)
            throw new InvalidOperationException("Applied dig found a vein already settled before its result came back.");
        VoxelCellQuery published = _adapter!.Read(pending.SectionKey.Value, pending.CellOffset.Value);
        LogApplied(Log, applied.TxnId, pending.SectionKey.Value, pending.CellOffset.Value, pending.VeinHex.Value, null);
        LogAfter(Log, applied.TxnId, published.BlockId, published.SectionRevision,
            _adapter.BindingGet(pending.SectionKey.Value, pending.CellOffset.Value), null);
    }

    /// <summary>The live record that owes <paramref name="transaction"/>, or null when none does.</summary>
    private PendingDigComponent? Find(string transaction)
    {
        foreach (PendingDigComponent record in World.Each<PendingDigComponent>())
            if (record.Active.Value && string.Equals(record.Transaction.Value, transaction, StringComparison.Ordinal))
                return record;
        return null;
    }

    /// <summary>Reads a record out and frees its slot in one step, so no settlement path can pay twice.</summary>
    private static PendingDig Take(PendingDigComponent record)
    {
        var dig = new PendingDig(record.Entity, record.Transaction.Value, record.VeinHex.Value,
            record.SectionKey.Value, record.CellOffset.Value, record.Amount.Value,
            unchecked((long)record.StaminaCost.Value), record.CellCenter, record.Serial.Value);
        Clear(record);
        return dig;
    }

    /// <summary>Frees a slot without settling anything: the record owes nothing after this.</summary>
    private static void Clear(PendingDigComponent record)
    {
        record.Active.Value = false;
        record.Transaction.Value = string.Empty;
        record.VeinHex.Value = string.Empty;
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
        // Only the queue expectation is dropped. The records are world state on their players: after a
        // a fresh restored adapter supplies its durable results before unavailable records are cleared.
        _awaiting.Clear();
        _initialized = false;
    }

    protected override void OnDestroy() => Detach();

    /// <summary>One record read out of its slot, as values, for the frame that settles it.</summary>
    private sealed record PendingDig(NetEntityId Player, string Transaction, string Vein, ulong Section,
        int Cell, int Amount, long Cost, Vector3 Center, ulong Serial);
}

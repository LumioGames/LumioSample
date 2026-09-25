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

    /// <summary>
    /// A live vein's binding-table position (ADR-119: "位置只有一个来源：绑定表"). Populated only by
    /// <see cref="ScanSection"/>/<see cref="CompletePendingBind"/>, both authority-only — a predicting
    /// client's own <see cref="SampleMiningComponent"/> instance never runs the scan (no
    /// <c>SampleMiningSystem</c> registration on that side), so <see cref="TryLocate"/> always misses
    /// there and callers must treat a miss as "unknown", never as "not bound" (ADR-106 §8).
    /// </summary>
    private readonly record struct VeinLocation(ulong SectionKey, int CellOffset, int WorldX, int WorldZ)
    {
        public Vector3 CellCenter => new(WorldX + 0.5f, 0.5f, WorldZ + 0.5f);
    }

    private readonly Dictionary<NetEntityId, VeinLocation> _location = new();
    // Section readiness last observed, to fire B6's scan on the *rising* edge only (a Section that was
    // already ready last tick is not scanned again just because it is still ready this tick).
    private readonly Dictionary<ulong, bool> _sectionReady = new();
    private readonly Queue<ulong> _scanQueue = new();
    private List<ulong>? _candidateSections;
    // One create→bind round trip in flight at a time, so the freshly-live veins a tick later can be
    // correlated to the offsets that were queued for them purely by creation order — no coordinate
    // field on the entity to match them back up with (ADR-119).
    private ulong? _pendingSection;
    private List<int>? _pendingOffsets;

    /// <summary>
    /// Reverse-looks-up a live vein's Section/cell/world-space center from this side's own binding-table
    /// bookkeeping. False means "unknown to this side" — not bound at all, or (always, on a predicting
    /// client) this side never scans; callers must not treat a miss as proof the vein is unbound.
    /// </summary>
    public bool TryLocate(NetEntityId vein, out ulong sectionKey, out int cellOffset, out Vector3 cellCenter)
    {
        if (_location.TryGetValue(vein, out VeinLocation loc))
        {
            sectionKey = loc.SectionKey;
            cellOffset = loc.CellOffset;
            cellCenter = loc.CellCenter;
            return true;
        }
        sectionKey = 0UL;
        cellOffset = 0;
        cellCenter = default;
        return false;
    }

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
        if (!_initialized) SetupBindingPolicy(current);
        ContinueScanning(current);
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
        if (adapter is null || !_initialized) return false;
        // Position comes only from this side's own binding-table bookkeeping (ADR-119); a vein this
        // scan has not (yet) bound to a cell cannot be mined.
        if (!TryLocate(vein.Entity, out ulong sectionKey, out int cellOffset, out _)) return false;
        // "Who digs owns the cell": one unsettled dig per player and one per vein. Two players may
        // order digs on two veins of one section in one frame through one physical batch.
        // Each logical result settles its own miner; a refusal pays nothing.
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
        VoxelCellQuery cell = adapter.Read(sectionKey, cellOffset);
        return cell.HasBlockId && cell.BlockId != 0
            && adapter.BindingGet(sectionKey, cellOffset) == target;
    }

    /// <summary>
    /// Orders the final dig and records what settling it would owe. Nothing is paid here; the record
    /// waits on the miner's <see cref="PendingDigComponent"/> — persisted state, not a process-only
    /// dictionary — until <see cref="Settle"/> reads the terrain result or <see cref="Reconcile"/>
    /// reads the restored authentic result delivery.
    /// </summary>
    internal bool StageFinal(AbilityComponent owner, VeinReserveComponent vein)
    {
        if (!CanMine(owner, vein)) return false;
        HostVoxelWorldAdapter adapter = VoxelGameplayBinding.Resolve(World.Manager)!;
        // CanMine already proved this lookup succeeds; nothing between there and here can invalidate
        // it (both run inside the same synchronous ability activation).
        VeinLocation loc = _location[vein.Entity];
        ulong sectionKey = loc.SectionKey;
        int cellOffset = loc.CellOffset;
        VoxelCellQuery cell = adapter.Read(sectionKey, cellOffset);
        string transaction = $"{HostVoxelWorldAdapter.LogicalDigPrefix}{World.InstanceId:x16}:{World.Tick:x16}:{++_serial:x16}";
        ISampleConfig config = SampleConfigBinding.For(World);
        PendingDigComponent record = World.Get<PendingDigComponent>(owner.Entity);
        record.Transaction.Value = transaction;
        record.VeinHex.Value = vein.Entity.ToHex();
        record.SectionKey.Value = sectionKey;
        record.CellOffset.Value = cellOffset;
        record.CellX.Value = loc.WorldX;
        record.CellY.Value = 0;
        record.CellZ.Value = loc.WorldZ;
        record.Amount.Value = config.Mining.OrePerVein;
        record.StaminaCost.Value = unchecked((ulong)config.Mining.StaminaCost);
        record.Serial.Value = _serial;
        record.Active.Value = true;
        _awaiting.Add(transaction);
        VoxelStageResult result = adapter.TryStageCoalescibleDigThrough(sectionKey, cellOffset,
            cell.SectionRevision, transaction);
        if (result.Status == VoxelStageStatus.Staged)
        {
            LogStage(Log, transaction, sectionKey, cellOffset,
                adapter.BindingGet(sectionKey, cellOffset), null);
            LogBefore(Log, transaction, cell.BlockId, cell.SectionRevision, null);
            return true;
        }
        Clear(record);
        _awaiting.Remove(transaction);
        if (World.Manager.CurrentOperation is not null)
            World.Manager.ReportCurrentOperationOutcome(new(OperationOutcomeKind.BusinessReject,
                OperationCommitFact.NotApplied, result.Code ?? "voxel_mutation_rejected"));
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

    /// <summary>
    /// Declares the block-type → block-entity-type binding policy once (R4/ADR-119 决策 1). Runtime
    /// derives the live candidate list itself from every entity of a declared type from here on
    /// (<c>RefreshBindingContext</c>) — Sample no longer assembles or replaces that list by hand.
    /// </summary>
    private void SetupBindingPolicy(HostVoxelWorldAdapter adapter)
    {
        ISampleConfig config = SampleConfigBinding.For(World);
        adapter.SetBindingPolicy(new[]
        {
            new VoxelBindingPolicyEntry(config.Map.OreBlockType, World.Registry.WireName(typeof(VeinEntity))),
        });
        _initialized = true;
    }

    /// <summary>
    /// One scan step per tick (ADR-119 §4 B6): first finishes any create→bind round trip a previous
    /// tick started, otherwise polls every candidate Section's residency-readiness edge and, on a
    /// newly-ready Section, scans its unbound ore cells. One step at a time keeps the
    /// freshly-created-veins ↔ requested-offsets correlation in <see cref="CompletePendingBind"/>
    /// unambiguous — nothing else in this component creates <see cref="VeinReserveComponent"/> entities.
    /// </summary>
    private void ContinueScanning(HostVoxelWorldAdapter adapter)
    {
        if (!_initialized) return;
        ISampleConfig config = SampleConfigBinding.For(World);
        PollSectionReadiness(adapter, config);
        if (_pendingSection is ulong pendingSection)
        {
            CompletePendingBind(adapter, pendingSection);
            return;
        }
        if (_scanQueue.Count == 0) return;
        ScanSection(adapter, _scanQueue.Dequeue(), config);
    }

    /// <summary>
    /// Every Section the authored map spans, computed once. A Section becoming newly readable
    /// (<see cref="HostVoxelWorldAdapter.TryReadSectionBindings"/> false→true) is this side's only
    /// signal that it "entered residency" — from the base map on first boot, or from its partition
    /// record after a reload; both look identical here, which is exactly B6's point.
    /// </summary>
    private List<ulong> CandidateSections(ISampleConfig config)
    {
        if (_candidateSections is not null) return _candidateSections;
        // Same formula as the client's reverse lookup (R-00768): AllCandidateSections is the one place
        // that encodes it now, so this side and the client side cannot drift apart.
        _candidateSections = AllCandidateSections(config.Map.Width, config.Map.Depth);
        return _candidateSections;
    }

    private void PollSectionReadiness(HostVoxelWorldAdapter adapter, ISampleConfig config)
    {
        List<ulong> candidates = CandidateSections(config);
        for (int i = 0; i < candidates.Count; i++)
        {
            ulong section = candidates[i];
            bool ready = adapter.TryReadSectionBindings(section, out _, out _);
            bool wasReady = _sectionReady.TryGetValue(section, out bool prior) && prior;
            _sectionReady[section] = ready;
            if (ready && !wasReady) _scanQueue.Enqueue(section);
        }
    }

    /// <summary>
    /// Scans one Section's ore cells for ones the committed binding table does not yet name (ADR-119
    /// §4 B6): an already-bound cell only refreshes this side's own location cache (so a restart, not
    /// just a Section reload, re-learns where every live vein already is); an unbound one queues a new
    /// vein. No "first load" flag is kept — idempotency is the binding-table check itself.
    /// </summary>
    private void ScanSection(HostVoxelWorldAdapter adapter, ulong section, ISampleConfig config)
    {
        if (!adapter.TryReadSectionBindings(section, out IReadOnlyList<SectionBindingEntry> entries, out _))
            return; // No longer ready; the next false→true edge re-queues it.

        var bound = new Dictionary<int, NetEntityId>(entries.Count);
        for (int i = 0; i < entries.Count; i++) bound[entries[i].CellOffset] = entries[i].Entity;

        SectionOrigin(section, out int sectionOriginX, out int sectionOriginZ);
        int width = config.Map.Width;
        int depth = config.Map.Depth;
        uint oreType = config.Map.OreBlockType;

        var toCreate = new List<int>();
        for (int zOff = 0; zOff < 16; zOff++)
        for (int xOff = 0; xOff < 16; xOff++)
        {
            int worldX = sectionOriginX + xOff;
            int worldZ = sectionOriginZ + zOff;
            if (worldX >= width || worldZ >= depth) continue; // Section straddles the map edge.
            int offset = zOff * 16 + xOff;
            VoxelCellQuery cell = adapter.Read(section, offset);
            if (!cell.HasBlockId || (cell.BlockId >> 8) != oreType) continue;
            if (bound.TryGetValue(offset, out NetEntityId existing))
            {
                _location[existing] = new VeinLocation(section, offset, worldX, worldZ);
                continue;
            }
            toCreate.Add(offset);
        }
        if (toCreate.Count == 0) return;
        // Ascending offset order matches the ascending-counter order CompletePendingBind zips these
        // against next tick — command-buffer creates are issued, and therefore numbered, in order.
        for (int i = 0; i < toCreate.Count; i++) SampleVein.Queue(World);
        _pendingSection = section;
        _pendingOffsets = toCreate;
    }

    /// <summary>
    /// Finishes a create→bind round trip a previous tick's <see cref="ScanSection"/> started: the
    /// veins it queued are now live (command-buffer creates commit between Ticks), so it correlates
    /// them to the requested offsets by ascending <see cref="NetEntityId.Counter"/> — the same order
    /// they were queued in — refreshes the binding candidate list so Native accepts naming them, and
    /// stages their bindings. A count mismatch is a framework invariant break (something else created
    /// a <see cref="VeinReserveComponent"/>), not a business refusal, and faults loudly.
    /// </summary>
    private void CompletePendingBind(HostVoxelWorldAdapter adapter, ulong section)
    {
        List<int> offsets = _pendingOffsets!;
        var fresh = new List<VeinReserveComponent>();
        foreach (VeinReserveComponent vein in World.Each<VeinReserveComponent>())
            if (!_location.ContainsKey(vein.Entity)) fresh.Add(vein);
        fresh.Sort(static (a, b) => a.Entity.Counter.CompareTo(b.Entity.Counter));
        if (fresh.Count != offsets.Count)
            throw new InvalidOperationException(
                $"SampleMiningComponent expected {offsets.Count} freshly-created veins for Section {section:x16}, found {fresh.Count}.");

        adapter.RefreshBindingContext();
        SectionOrigin(section, out int sectionOriginX, out int sectionOriginZ);
        var bindings = new List<VoxelBindingOp>(offsets.Count);
        for (int i = 0; i < offsets.Count; i++)
        {
            int offset = offsets[i];
            NetEntityId entity = fresh[i].Entity;
            int worldX = sectionOriginX + offset % 16;
            int worldZ = sectionOriginZ + offset / 16;
            _location[entity] = new VeinLocation(section, offset, worldX, worldZ);
            VoxelCellQuery cell = adapter.Read(section, offset);
            bindings.Add(new VoxelBindingOp(section, offset, entity.ToHex()) { ExpectedSectionRevision = cell.SectionRevision });
        }
        // Fire-and-forget like the old Initialize: a refusal here (e.g. a revision race) simply leaves
        // these offsets unbound, and the next false→true readiness edge (or a later poll noticing the
        // cell still unbound) is not re-armed automatically today — a known limitation, see the PR notes.
        adapter.TryStageMutation(Array.Empty<VoxelWriteEntry>(), bindings, NextTransaction("bind"));
        _pendingSection = null;
        _pendingOffsets = null;
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
        // Every one of these is this-process bookkeeping over the old adapter's binding table, not
        // world state: rebuilding it from the fresh adapter is exactly SetupBindingPolicy + a full
        // re-poll (idempotent — ScanSection only ever fills gaps the committed table doesn't already
        // have bound), never a second copy of anything durable.
        _location.Clear();
        _sectionReady.Clear();
        _scanQueue.Clear();
        _pendingSection = null;
        _pendingOffsets = null;
    }

    protected override void OnDestroy() => Detach();

    /// <summary>One record read out of its slot, as values, for the frame that settles it.</summary>
    private sealed record PendingDig(NetEntityId Player, string Transaction, string Vein, ulong Section,
        int Cell, int Amount, long Cost, Vector3 Center, ulong Serial);
}

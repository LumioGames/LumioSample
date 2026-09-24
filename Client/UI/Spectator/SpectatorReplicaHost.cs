using System;
using System.Collections.Generic;
using System.Threading;
using Lumio.Client.Gameplay.ECS;
using Lumio.GameRuntime.Ecs;
using Lumio.Client.Spectator;
using Lumio.Sample.Gameplay;

namespace Lumio.Sample.Client.Spectator;

/// <summary>Browser host of the same replica used by Bot sessions; owns no simulation logic.</summary>
public sealed class SpectatorReplicaHost : IDisposable
{
    /// <summary>
    /// Upper bound on undrained SectionFrames. The page drains after every inbound
    /// frame, so a queue this deep means the page stopped pulling; that is a defect,
    /// not backpressure, and it fails loudly instead of growing without limit.
    /// </summary>
    internal const int MaxQueuedSectionFrames = 64;

    private readonly Queue<SpectatorSectionFrame> _sections = new();
    private IClientReplica? _replica;
    private bool _faulted;
    private bool _superseded;
    private ulong _sequence;
    private string _lastApplyError = string.Empty;

    public SpectatorReplicaHost(Func<WorldManager> managerFactory)
    {
        _replica = new ClientReplicaFactory(managerFactory).Create();
        _replica.ResetForNewSession(new ReplicaResetRequest(1));
    }

    public static WorldManager CreateSampleWorld()
    {
        // The Sample client registry declares a gameplay config contract, so the
        // binding is not optional: WorldManager refuses a registry/binding mismatch.
        // It carries the typed tables and installs the attribute seed provider
        // (player Stamina / Ore initial values) through the Sample adapter's BindWorld.
        WorldConfigBinding config = SpectatorDump.LoadSampleConfig();
        WorldManager manager;
        try
        {
            manager = WorldManager.Create(GeneratedRegistry.Instance, config: config);
        }
        catch
        {
            config.Dispose();
            throw;
        }

        manager.Start(Thread.CurrentThread);
        manager.BindTickLoop(new ReplicaApplyTickLoop(manager));
        return manager;
    }

    public World? World => _replica?.World.Manager.World;
    public bool InputEnabled => _replica?.World.InputEnabled == true;
    public string ConnectionState => _faulted ? "faulted" : _superseded ? "superseded" : _replica is null ? "closed" : InputEnabled ? "active" : "synchronizing";
    public string LastApplyError => _lastApplyError;

    public bool ApplyFrame(byte[] frame)
    {
        if (_replica is null) throw new ObjectDisposedException(nameof(SpectatorReplicaHost));
        try
        {
            // Voxel half of the downlink. WireCodec has no SectionFrame case, so the
            // envelope is read here and queued for the page; the Section bytes stay
            // opaque and are never applied to the managed world (ADR-078 决策 3: the
            // voxel world lives in the Rust wasm instance, not in .NET).
            if (SpectatorSectionFrame.TryRead(frame, out SpectatorSectionFrame section))
            {
                if (_sections.Count >= MaxQueuedSectionFrames)
                    throw new InvalidOperationException("section_queue_overflow");
                _sections.Enqueue(section);
                return false;
            }

            WorldMessage message;
            try
            {
                message = WireCodec.DecodePack(frame);
            }
            catch (FormatException error) when (IsUnknownMessageType(error))
            {
                // Bot.Host maps the remaining unknown types (HandshakeAck,
                // OperationReceipt under the baseline profile) to Unknown and
                // drops them. DecodePack must not fault the replica on those
                // same-tick hello frames or the dump stays empty.
                return false;
            }
            if (message is WelcomeMessage)
            {
                if (!_replica.TryObserveWelcome(frame)) throw new InvalidOperationException("welcome_rejected");
                return true;
            }
            if (message is ConnectionSupersededMessage)
            {
                if (_replica.TryObserveConnectionSuperseded(frame, out ReplicaConnectionSuperseded notice) && notice.Received)
                {
                    _superseded = true;
                    Dispose();
                }
                return false;
            }
            if (message is ErrorMessage envelope)
                throw new InvalidOperationException("authority_error:" + envelope.Code + ":" + envelope.Detail);
            if (message is not WorldChangeMessage) throw new InvalidOperationException("authority_message_rejected:" + message.GetType().Name);
            ReplicaCommittedMetadata previous = _replica.GetSnapshot().Committed;
            ReplicaUpdateKind kind = previous.HasBaseline ? ReplicaUpdateKind.Delta : ReplicaUpdateKind.FullSnapshot;
            ulong next = _sequence + 1;
            var request = new ReplicaStageRequest(previous.Generation, kind,
                previous.Baseline, previous.Revision, next, next, frame, ReadOnlyMemory<ulong>.Empty, ReadOnlyMemory<ulong>.Empty);
            ReplicaStageResult stage = _replica.StageAuthority(in request, out ReplicaStageHandle handle, out _);
            if (stage.Status == ReplicaStageStatus.DuplicateIgnored) return false;
            if (stage.Status != ReplicaStageStatus.Staged)
                throw new InvalidOperationException("authority_stage_rejected:" + stage.Status + ":" + kind);
            ReplicaOutcomeStatus outcome = _replica.ObserveRuntimeOutcome(handle, ReplicaRuntimeOutcome.CommittedOutcome(), out _);
            if (outcome == ReplicaOutcomeStatus.DuplicateIgnored) return false;
            WorldChangeApplyResult? receipt = _replica.GetLastApplyResult();
            if (outcome != ReplicaOutcomeStatus.Observed)
                throw new InvalidOperationException("authority_apply_failed:" + outcome + ":" + kind, receipt?.Error);
            if (receipt is null)
                throw new InvalidOperationException("authority_apply_failed:no_receipt:" + kind);
            if (!receipt.AuthorityApplied || !receipt.PredictionCompleted)
                throw new InvalidOperationException(
                    "authority_apply_failed:" + receipt.Status + ":authority=" + receipt.AuthorityApplied
                    + ":prediction=" + receipt.PredictionCompleted
                    + (receipt.FailureStage is null ? string.Empty : ":" + receipt.FailureStage),
                    receipt.Error);
            _sequence = next;
            return true;
        }
        catch (Exception error)
        {
            _lastApplyError = FormatApplyError(error);
            _faulted = true;
            Dispose();
            throw;
        }
    }

    public string TakeOutbound() => _replica is null || !InputEnabled ? "[]" : SpectatorDump.EncodeOutbound(_replica.World.DrainOutbound());

    /// <summary>SectionFrames read off the wire and not yet pulled by the page.</summary>
    public int PendingSectionFrames => _sections.Count;

    /// <summary>
    /// Envelope of the next queued SectionFrame, or <c>""</c> when none is waiting.
    /// Peek only: <see cref="TakeSectionBytes"/> is what dequeues.
    /// </summary>
    public string PeekSectionHeader() => _sections.Count == 0 ? string.Empty : _sections.Peek().ToHeaderJson();

    /// <summary>
    /// Dequeues the next SectionFrame and hands back its 32-byte
    /// <c>payloadSha256</c> followed by its payload bytes, so the page copies both
    /// into the Rust wasm linear memory in one go. Empty when nothing is queued.
    /// </summary>
    public byte[] TakeSectionBytes()
    {
        if (_sections.Count == 0) return Array.Empty<byte>();
        SpectatorSectionFrame frame = _sections.Dequeue();
        var bytes = new byte[frame.PayloadSha256.Length + frame.Payload.Length];
        frame.PayloadSha256.CopyTo(bytes, 0);
        frame.Payload.CopyTo(bytes, frame.PayloadSha256.Length);
        return bytes;
    }

    internal static bool IsUnknownMessageType(FormatException error) =>
        error.Message.StartsWith("unknown messageType:", StringComparison.Ordinal);

    internal static string FormatApplyError(Exception error)
    {
        var text = new System.Text.StringBuilder();
        for (Exception? current = error; current != null; current = current.InnerException)
        {
            if (text.Length > 0) text.Append(" | ");
            text.Append(current.GetType().Name).Append(':').Append(current.Message);
        }

        return text.ToString();
    }

    public void Dispose()
    {
        IClientReplica? replica = _replica;
        _replica = null;
        // Undrained voxel bytes belong to the session that is ending; a later
        // session must not be handed them.
        _sections.Clear();
        replica?.Dispose();
    }
}


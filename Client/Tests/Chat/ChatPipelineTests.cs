using System;
using System.Linq;
using System.Threading;
using Lumio.Client.Gameplay.ECS;
using Lumio.Engine.NativeLoader;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Simulation;
using Lumio.Sample.Gameplay;
using Lumio.Sample.Gameplay.Config;
using Xunit;

namespace Lumio.Sample.Client.Chat.Tests;

public sealed class ChatPipelineTests
{
    [Fact]
    public void ExactTextAndAbsentSenderSurviveRealCommit()
    {
        using var fixture = new Fixture();
        using var consumer = fixture.Create();
        const string text = "  雪😀\0{\"n\":\"001\"}  ";
        Commit(consumer, Request(1, Rpc(1, text)));
        var line = Assert.Single(consumer.CopySnapshot().Lines);
        Assert.Equal(text, line.Text);
        Assert.Equal(Sender, line.Sender);
        Assert.Equal(1UL, line.MessageId);
        Assert.False(consumer.Replica.World.Manager.World.IsLive(Sender));
        Assert.Equal(RegistrySide.Client, consumer.Replica.World.Manager.Registry.Side);
        Assert.Equal(WorldChangeApplyStatus.Applied, consumer.Replica.GetLastApplyResult()!.Status);
        Assert.Empty(consumer.Replica.World.CopyChatWindow());
    }

    [Theory]
    [InlineData("scope")]
    [InlineData("arguments")]
    [InlineData("empty")]
    [InlineData("target")]
    [InlineData("sender")]
    [InlineData("message")]
    [InlineData("sequence")]
    public void LaterMalformedChatRejectsWholeCandidate(string defect)
    {
        using var fixture = new Fixture();
        using var consumer = fixture.Create();
        Commit(consumer, Request(1, Rpc(1)));
        var before = consumer.Replica.GetSnapshot().Committed;
        var manager = consumer.Replica.World.Manager;
        var malformed = new ClientRpcRecord(defect == "target" ? new NetEntityId(1, 78) : Sender,
            ChatRpcIdentity.ComponentId, ChatRpcIdentity.Method,
            defect == "arguments" ? new object?[] { "one", "two" } : defect == "empty" ? Array.Empty<object?>() : new object?[] { "bad" },
            defect == "message" ? 0UL : 3UL, defect == "sequence" ? 0UL : 3UL,
            defect == "sender" ? default : Sender, 22, defect == "scope" ? Scope.Owner : Scope.Room);
        Assert.Equal(ReplicaStageStatus.Rejected, consumer.Replica.StageAuthority(Request(2, Rpc(2), malformed), out var stage, out _).Status);
        Assert.True(stage.IsEmpty);
        Assert.Equal(before, consumer.Replica.GetSnapshot().Committed);
        Assert.Same(manager, consumer.Replica.World.Manager);
        Assert.Single(consumer.CopySnapshot().Lines);
        Assert.Equal(1UL, consumer.CopySnapshot().MessageHighWater);
        Assert.Equal(0, consumer.Replica.GetSnapshot().OpenStageCount);
    }

    [Fact]
    public void UnrelatedMultiargumentRecordsPassAndTombstonedSenderStillPublishes()
    {
        using var fixture = new Fixture();
        using var consumer = fixture.Create();
        var unrelated = new ClientRpcRecord(Sender, ChatRpcIdentity.ComponentId, "Other",
            new object?[] { "one", "two", "雪" }, 0, 0, default, 0, Scope.Room);
        var otherComponent = new ClientRpcRecord(Sender, "OtherComponent", ChatRpcIdentity.Method,
            new object?[] { "three", "four" }, 0, 0, default, 0, Scope.Room);
        var request = Request(1, unrelated, otherComponent, Rpc(1));
        request = new ReplicaStageRequest(7, ReplicaUpdateKind.FullSnapshot, 10, 0, 1, 1,
            request.Update, new ulong[] { Sender.Counter }, Array.Empty<ulong>());
        Commit(consumer, request);
        Assert.Single(consumer.CopySnapshot().Lines);
        Assert.False(consumer.Replica.World.Manager.World.IsLive(Sender));
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void EitherRegressingCursorIsPresentationErrorWhileAuthorityStaysApplied(bool message)
    {
        using var fixture = new Fixture();
        using var consumer = fixture.Create();
        Commit(consumer, Request(1, Rpc(10)));
        Commit(consumer, Request(2, Rpc(message ? 10UL : 11UL, sequence: message ? 11UL : 10UL)));
        var snapshot = consumer.CopySnapshot();
        Assert.Single(snapshot.Lines);
        Assert.Equal("chat_cursor_not_advancing", snapshot.LastError);
        Assert.Equal(10UL, snapshot.MessageHighWater);
        Assert.Equal(10UL, snapshot.RoomSequenceHighWater);
        Assert.Equal(WorldChangeApplyStatus.Applied, consumer.Replica.GetLastApplyResult()!.Status);
        Commit(consumer, Request(3, Rpc(11), Rpc(12)));
        Assert.Equal(new ulong[] { 10, 11, 12 }, consumer.CopySnapshot().Lines.Select(line => line.MessageId));
    }

    [Fact]
    public void DuplicateAndAbortedOutcomesNeverReplayAndCallbackFailureDoesNotReject()
    {
        using var fixture = new Fixture();
        using var consumer = fixture.Create(_ => throw new InvalidOperationException("consumer"));
        Commit(consumer, Request(1));
        var request = Request(2, Rpc(1), Rpc(2));
        var first = Stage(consumer, request);
        var duplicate = Stage(consumer, request);
        Assert.Equal(ReplicaOutcomeStatus.Observed, consumer.Replica.ObserveRuntimeOutcome(first, ReplicaRuntimeOutcome.CommittedOutcome(), out _));
        Assert.Equal("rpc_observer_failed", consumer.Replica.World.LastRejectCode);
        Assert.Equal("chat_callback_failed", consumer.CopySnapshot().LastError);
        Assert.Equal(WorldChangeApplyStatus.Applied, consumer.Replica.GetLastApplyResult()!.Status);
        Assert.Equal(ReplicaOutcomeStatus.DuplicateIgnored, consumer.Replica.ObserveRuntimeOutcome(duplicate, ReplicaRuntimeOutcome.CommittedOutcome(), out _));
        Assert.Equal(ReplicaStageStatus.DuplicateIgnored, consumer.Replica.StageAuthority(request, out _, out _).Status);
        Assert.Equal(2, consumer.CopySnapshot().Lines.Count);
        Assert.Equal(2UL, consumer.CopySnapshot().MessageHighWater);
        var aborted = Stage(consumer, Request(3, Rpc(3)));
        consumer.Replica.ObserveRuntimeOutcome(aborted, ReplicaRuntimeOutcome.AbortedOutcome(), out _);
        Assert.Equal(2, consumer.CopySnapshot().Lines.Count);
    }

    [Fact]
    public void SnapshotsAndSessionsResetOnlyAfterReplacementSucceeds()
    {
        using var fixture = new Fixture();
        using var consumer = fixture.Create();
        Commit(consumer, Request(1, Rpc(9)));
        var old = consumer.CopySnapshot();
        var manager = consumer.Replica.World.Manager;
        fixture.FailCreation = true;
        Assert.Throws<InvalidOperationException>(() => consumer.Replica.ResetForNewSession(new ReplicaResetRequest(8)));
        Assert.Same(manager, consumer.Replica.World.Manager);
        Assert.Equal(9UL, consumer.CopySnapshot().MessageHighWater);
        var replacement = Request(2, true, Rpc(1));
        var failed = Stage(consumer, replacement);
        Assert.Equal(ReplicaOutcomeStatus.Rejected, consumer.Replica.ObserveRuntimeOutcome(failed, ReplicaRuntimeOutcome.CommittedOutcome(), out _));
        Assert.Equal(9UL, Assert.Single(consumer.CopySnapshot().Lines).MessageId);
        fixture.FailCreation = false;
        Commit(consumer, Request(3, true, Rpc(1)));
        Assert.Equal(1UL, Assert.Single(consumer.CopySnapshot().Lines).MessageId);
        Assert.Equal(9UL, Assert.Single(old.Lines).MessageId);
        var stale = Stage(consumer, Request(4, Rpc(2)));
        consumer.Replica.ResetForNewSession(new ReplicaResetRequest(8));
        Assert.Empty(consumer.CopySnapshot().Lines);
        Assert.Equal(0UL, consumer.CopySnapshot().RoomSequenceHighWater);
        Assert.NotEqual(ReplicaOutcomeStatus.Observed, consumer.Replica.ObserveRuntimeOutcome(stale, ReplicaRuntimeOutcome.CommittedOutcome(), out _));
        Assert.Empty(consumer.CopySnapshot().Lines);
    }

    [Fact]
    public void ConsumersOwnIndependentSnapshotsAndDisposePredictablyWithoutEviction()
    {
        using var fixture = new Fixture();
        using var first = fixture.Create();
        using var second = fixture.Create();
        Commit(first, Request(1, Enumerable.Range(1, 300).Select(i => Rpc((ulong)i, new string('x', 1024))).ToArray()));
        var copy = first.CopySnapshot();
        Assert.Equal(300, copy.Lines.Count);
        Assert.Empty(second.CopySnapshot().Lines);
        first.Dispose();
        first.Dispose();
        Assert.Empty(first.CopySnapshot().Lines);
        Assert.Equal(300, copy.Lines.Count);
        Commit(second, Request(1, Rpc(1)));
        Assert.Single(second.CopySnapshot().Lines);
    }

    [Fact]
    public void PreviouslyLiveSenderCanBeDestroyedBeforeRoomObservation()
    {
        using var fixture = new Fixture();
        using var consumer = fixture.Create();
        var initial = Request(1);
        var change = (WorldChangeMessage)WireCodec.DecodePack(initial.Update.Span);
        var withSender = new WorldChangeMessage(change.Tick, 0,
            change.Creates.Concat(new[] { new CreateRecord("player", Sender, Array.Empty<FieldValue>()) }).ToArray(),
            change.Fields, change.Destroys, change.Rpcs);
        Commit(consumer, new ReplicaStageRequest(7, ReplicaUpdateKind.FullSnapshot, 10, 0, 1, 1,
            WireCodec.EncodePack(withSender), Array.Empty<ulong>(), Array.Empty<ulong>()));
        Assert.True(consumer.Replica.World.Manager.World.IsLive(Sender));
        Assert.NotNull(consumer.Replica.World.Manager.World.Get<Gameplay.Components.Chat.ChatComponent>(Sender));
        var destroyed = new WorldChangeMessage(22, 0, Array.Empty<CreateRecord>(), Array.Empty<FieldChange>(),
            new[] { new DestroyRecord(Sender, DestroyReason.Terminated) }, new[] { Rpc(1) });
        Commit(consumer, new ReplicaStageRequest(7, ReplicaUpdateKind.Delta, 10, 1, 2, 2,
            WireCodec.EncodePack(destroyed), new[] { Sender.Counter }, Array.Empty<ulong>()));
        Assert.False(consumer.Replica.World.Manager.World.IsLive(Sender));
        Assert.Equal(Sender, Assert.Single(consumer.CopySnapshot().Lines).Sender);
    }

    [Fact]
    public void DisposalDuringCallbackUsesClientSafePointAndSuppressesLaterLines()
    {
        using var fixture = new Fixture();
        ChatConsumer? consumer = null;
        int callbacks = 0;
        consumer = fixture.Create(_ => { callbacks++; consumer!.Dispose(); });
        using (consumer)
        {
            Commit(consumer, Request(1, Rpc(1), Rpc(2)));
            Assert.Equal(1, callbacks);
            Assert.Empty(consumer.CopySnapshot().Lines);
            Assert.True(consumer.Replica.GetSnapshot().Committed.HasBaseline);
        }
    }

    private static NetEntityId Sender => new(1, 77);
    private static ClientRpcRecord Rpc(ulong id, string text = "line", ulong? sequence = null) =>
        new(Sender, ChatRpcIdentity.ComponentId, ChatRpcIdentity.Method, new object?[] { text }, id, sequence ?? id, Sender, 19, Scope.Room);

    private static ReplicaStageRequest Request(ulong revision, params ClientRpcRecord[] rpcs) => Request(revision, revision == 1, rpcs);
    private static ReplicaStageRequest Request(ulong revision, bool full, params ClientRpcRecord[] rpcs) =>
        new(7, full ? ReplicaUpdateKind.FullSnapshot : ReplicaUpdateKind.Delta, 10, full ? 0 : revision - 1, revision, revision,
            WireCodec.EncodePack(new WorldChangeMessage(20 + revision, 0,
                full ? new[] { new CreateRecord("world", new NetEntityId(1, 2), Array.Empty<FieldValue>()), new CreateRecord("player", new NetEntityId(1, 1), Array.Empty<FieldValue>()) } : Array.Empty<CreateRecord>(),
                Array.Empty<FieldChange>(), Array.Empty<DestroyRecord>(), rpcs)), Array.Empty<ulong>(), Array.Empty<ulong>());

    private static ReplicaStageHandle Stage(ChatConsumer consumer, ReplicaStageRequest request)
    {
        Assert.Equal(ReplicaStageStatus.Staged, consumer.Replica.StageAuthority(request, out var stage, out _).Status);
        return stage;
    }

    private static void Commit(ChatConsumer consumer, ReplicaStageRequest request) =>
        Assert.Equal(ReplicaOutcomeStatus.Observed, consumer.Replica.ObserveRuntimeOutcome(Stage(consumer, request), ReplicaRuntimeOutcome.CommittedOutcome(), out _));

    private sealed class Fixture : IDisposable
    {
        private readonly NativeEngineLease _lease;
        private readonly NativeKernelContext _context;
        public bool FailCreation { get; set; }

        public Fixture()
        {
            _lease = NativeEngineLoader.LoadFromBuildInfo(Environment.GetEnvironmentVariable("LUMIO_NATIVE_TEST_PATH")
                ?? throw new InvalidOperationException("LUMIO_NATIVE_TEST_PATH must name the verified DLL."));
            _context = _lease.CreateKernelContext(new KernelConfig
            {
                MaxContexts = 8, MaxHandles = 64, MaxNativeBytes = 1024 * 1024,
                MaxJobsQueued = 8, MaxJobsRunning = 2, MaxCompletionItems = 16, LogMailboxCapacity = 128
            });
        }

        public ChatConsumer Create(Action<ChatLine>? callback = null)
        {
            // The retained legacy Client chat predicate must not validate or render Sample
            // records for these tests: all chat behavior is exercised through our hooks.
            var factory = new ClientReplicaFactory(CreateManager, new ReplicaChatRpcIdentity("LegacyFixture", "Unused"));
            var consumer = ChatConsumer.Create(factory, callback);
            consumer.Replica.ResetForNewSession(new ReplicaResetRequest(7));
            Assert.True(consumer.Replica.TryObserveWelcome(WireCodec.EncodePack(new WelcomeMessage(1, new NetEntityId(1, 1), 55))));
            return consumer;
        }

        private WorldManager CreateManager()
        {
            if (FailCreation) throw new InvalidOperationException("replacement fixture");
            var manager = WorldManager.Create(GeneratedRegistry.Instance, config: SampleConfigBinding.Load());
            try
            {
                manager.Start(Thread.CurrentThread);
                WorldTickBinding.Bind(manager, _context.Hfsm, null);
                return manager;
            }
            catch { manager.Dispose(); throw; }
        }

        public void Dispose() { _context.Dispose(); _lease.Dispose(); }
    }
}

using System;
using System.Numerics;
using System.Text;
using System.Text.Json;
using System.Threading;
using Lumio.Sample.Gameplay.Components.Identity;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Replication.Binding;
using Lumio.GameRuntime.Simulation;
using Lumio.Sample.Gameplay;

namespace Lumio.Sample.Client.Spectator.Tests;

public sealed class SpectatorReplicaHostTests
{
    [Fact]
    public void MalformedFrameTerminatesAndClearsReplica()
    {
        using var host = new SpectatorReplicaHost(CreateManager);
        Assert.ThrowsAny<Exception>(() => host.ApplyFrame(new byte[] { 1, 2, 3 }));
        Assert.Equal("faulted", host.ConnectionState);
        Assert.Null(host.World);
        Assert.Equal("[]", host.TakeOutbound());
    }

    [Fact]
    public void WelcomeBindingGenerationIsIndependentAndDuplicatesDoNotRecreateWorld()
    {
        using var host = new SpectatorReplicaHost(CreateManager);
        var self = new NetEntityId(7, 2);
        byte[] frame = WireCodec.EncodePack(new WelcomeMessage(7, self, 9));
        Assert.True(host.ApplyFrame(frame));
        World? world = host.World;
        Assert.True(host.ApplyFrame(frame));
        Assert.Same(world, host.World);
        Assert.Equal("synchronizing", host.ConnectionState);
        Assert.ThrowsAny<Exception>(() => host.ApplyFrame(WireCodec.EncodePack(new WelcomeMessage(7, new NetEntityId(7, 3), 9))));
        Assert.Equal("faulted", host.ConnectionState);
        Assert.Null(host.World);
    }

    [Fact]
    public void SupersessionDisposesOnlyMatchingBinding()
    {
        using var host = new SpectatorReplicaHost(CreateManager);
        var self = new NetEntityId(7, 2);
        host.ApplyFrame(WireCodec.EncodePack(new WelcomeMessage(7, self, 9)));
        host.ApplyFrame(WireCodec.EncodePack(new ConnectionSupersededMessage(new NetEntityId(7, 3), 10)));
        Assert.Equal("synchronizing", host.ConnectionState);
        host.ApplyFrame(WireCodec.EncodePack(new ConnectionSupersededMessage(self, 10)));
        Assert.Equal("superseded", host.ConnectionState);
        Assert.Null(host.World);
    }

    [Fact]
    public void IssueSelfMoveOnActiveReplicaHostWritesInputCommandWithoutJsCodec()
    {
        using var host = new SpectatorReplicaHost(CreateManager);
        var self = new NetEntityId(7, 2);
        host.ApplyFrame(WireCodec.EncodePack(new WelcomeMessage(7, self, 9)));
        Assert.True(host.ApplyFrame(InitialChange(self)));
        Assert.True(host.InputEnabled);
        Assert.Equal("active", host.ConnectionState);

        ulong sequence = 0;
        uint rng = SpectatorDump.MixSeed(self.ToHex());
        Assert.True(SpectatorDump.IssueSelfMove(host.World!, ref sequence, ref rng));
        Assert.Equal(1UL, sequence);

        using JsonDocument outbound = JsonDocument.Parse(host.TakeOutbound());
        Assert.Equal(JsonValueKind.Array, outbound.RootElement.ValueKind);
        Assert.True(outbound.RootElement.GetArrayLength() >= 1);
        JsonElement envelope = outbound.RootElement[0];
        Assert.Equal("InputCommand", envelope.GetProperty("messageType").GetString());
        Assert.True(envelope.GetProperty("commands").GetArrayLength() >= 1);
    }

    [Fact]
    public void SuccessfulInitialAndDeltaChangesCommitBeforeInputIsEnabled()
    {
        using var host = new SpectatorReplicaHost(CreateManager);
        var self = new NetEntityId(7, 2);
        host.ApplyFrame(WireCodec.EncodePack(new WelcomeMessage(7, self, 9)));
        Assert.False(host.InputEnabled);

        Assert.True(host.ApplyFrame(InitialChange(self)));
        Assert.True(host.InputEnabled);
        Assert.Equal("active", host.ConnectionState);
        Assert.Equal(new Vector3(1, 0, 2), host.World!.Get<LogicTransform>(self).LocalPosition);

        byte[] delta = WireCodec.EncodePack(new WorldChangeMessage(2, 0, Array.Empty<CreateRecord>(),
            new[] { new FieldChange(self, nameof(LogicTransform), "localPosition", "5,0,6", ChangeReason.Sync) },
            Array.Empty<DestroyRecord>(), Array.Empty<ClientRpcRecord>()));
        Assert.True(host.ApplyFrame(delta));
        Assert.Equal(new Vector3(5, 0, 6), host.World.Get<LogicTransform>(self).LocalPosition);
    }

    [Fact]
    public void DuplicateAuthorityAndWelcomeLeaveTheActiveWorldIntact()
    {
        using var host = new SpectatorReplicaHost(CreateManager);
        var self = new NetEntityId(7, 2);
        byte[] welcome = WireCodec.EncodePack(new WelcomeMessage(7, self, 9));
        host.ApplyFrame(welcome);
        byte[] initial = InitialChange(self);
        host.ApplyFrame(initial);
        World world = host.World!;

        Assert.False(host.ApplyFrame(initial));
        Assert.True(host.ApplyFrame(welcome));
        Assert.Same(world, host.World);
        Assert.True(host.InputEnabled);
        Assert.Equal("active", host.ConnectionState);
    }

    [Fact]
    public void DataApplicationFailureDisposesTheSessionAndRejectsLaterFrames()
    {
        using var host = new SpectatorReplicaHost(CreateManager);
        var self = new NetEntityId(7, 2);
        host.ApplyFrame(WireCodec.EncodePack(new WelcomeMessage(7, self, 9)));
        host.ApplyFrame(InitialChange(self));
        byte[] broken = WireCodec.EncodePack(new WorldChangeMessage(2, 0, Array.Empty<CreateRecord>(),
            new[] { new FieldChange(self, nameof(IdentityComponent), "colorHue", "invalid-color", ChangeReason.Sync) },
            Array.Empty<DestroyRecord>(), Array.Empty<ClientRpcRecord>()));

        Assert.Throws<InvalidOperationException>(() => host.ApplyFrame(broken));

        Assert.Equal("faulted", host.ConnectionState);
        Assert.False(host.InputEnabled);
        Assert.Null(host.World);
        Assert.Equal("[]", host.TakeOutbound());
        Assert.Throws<ObjectDisposedException>(() => host.ApplyFrame(InitialChange(self)));
    }

    [Fact]
    public void DisposeReleasesTheManagerWithoutCreatingAReplacement()
    {
        var managers = new System.Collections.Generic.List<WorldManager>();
        using var host = new SpectatorReplicaHost(() =>
        {
            WorldManager manager = CreateManager();
            managers.Add(manager);
            return manager;
        });
        int created = managers.Count;

        host.Dispose();
        host.Dispose();

        Assert.Equal(created, managers.Count);
        Assert.All(managers, manager => Assert.Throws<ObjectDisposedException>(() =>
            manager.Enqueue(new WelcomeMessage(7, new NetEntityId(7, 2), 9))));
        Assert.Null(host.World);
        Assert.False(host.InputEnabled);
        Assert.Equal("closed", host.ConnectionState);
    }

    [Fact]
    public void InitialAuthorityRetainsNondefaultAttributeBaseAndCurrent()
    {
        using var host = new SpectatorReplicaHost(CreateManager);
        var self = new NetEntityId(7, 2);
        host.ApplyFrame(WireCodec.EncodePack(new WelcomeMessage(7, self, 9)));
        byte[] frame = WireCodec.EncodePack(new WorldChangeMessage(1, 0,
            new[]
            {
                new CreateRecord("world", new NetEntityId(7, 1), Array.Empty<FieldValue>()),
                new CreateRecord("player", self, new[]
                {
                    new FieldValue(nameof(AttributeComponent), "staminaBase", 81L),
                    new FieldValue(nameof(AttributeComponent), "staminaCurrent", 37L),
                    new FieldValue(nameof(AttributeComponent), "oreBase", 24L),
                    new FieldValue(nameof(AttributeComponent), "oreCurrent", 12L),
                }),
            },
            Array.Empty<FieldChange>(), Array.Empty<DestroyRecord>(), Array.Empty<ClientRpcRecord>()));

        Assert.True(host.ApplyFrame(frame));
        Assert.True(host.InputEnabled);
        AttributeComponent attributes = host.World!.Get<AttributeComponent>(self);
        Assert.Equal((81L, 37L, 24L, 12L),
            (attributes.GetBaseValue("Stamina"), attributes.GetCurrentValue("Stamina"),
             attributes.GetBaseValue("Ore"), attributes.GetCurrentValue("Ore")));
    }

    [Fact]
    public void AuthorityDeltaParsesSignedAttributeValuesFromWire()
    {
        using var host = new SpectatorReplicaHost(CreateManager);
        var self = new NetEntityId(7, 2);
        host.ApplyFrame(WireCodec.EncodePack(new WelcomeMessage(7, self, 9)));
        host.ApplyFrame(InitialChange(self));
        byte[] frame = WireCodec.EncodePack(new WorldChangeMessage(2, 0, Array.Empty<CreateRecord>(),
            new[]
            {
                new FieldChange(self, nameof(AttributeComponent), "staminaBase", long.MinValue, ChangeReason.Sync),
                new FieldChange(self, nameof(AttributeComponent), "staminaCurrent", long.MaxValue, ChangeReason.Sync),
                new FieldChange(self, nameof(AttributeComponent), "oreBase", -24L, ChangeReason.Sync),
                new FieldChange(self, nameof(AttributeComponent), "oreCurrent", 12L, ChangeReason.Sync),
            },
            Array.Empty<DestroyRecord>(), Array.Empty<ClientRpcRecord>()));

        Assert.True(host.ApplyFrame(frame));
        AttributeComponent attributes = host.World!.Get<AttributeComponent>(self);
        Assert.Equal((long.MinValue, long.MaxValue, -24L, 12L),
            (attributes.GetBaseValue("Stamina"), attributes.GetCurrentValue("Stamina"),
             attributes.GetBaseValue("Ore"), attributes.GetCurrentValue("Ore")));
    }

    [Theory]
    [InlineData("not-an-integer")]
    [InlineData("9223372036854775808")]
    public void InvalidAuthorityAttributeFaultsAndDisposesTheHost(string value)
    {
        using var host = new SpectatorReplicaHost(CreateManager);
        var self = new NetEntityId(7, 2);
        host.ApplyFrame(WireCodec.EncodePack(new WelcomeMessage(7, self, 9)));
        host.ApplyFrame(InitialChange(self));
        byte[] frame = WireCodec.EncodePack(new WorldChangeMessage(2, 0, Array.Empty<CreateRecord>(),
            new[] { new FieldChange(self, nameof(AttributeComponent), "staminaCurrent", value, ChangeReason.Sync) },
            Array.Empty<DestroyRecord>(), Array.Empty<ClientRpcRecord>()));

        Assert.Throws<InvalidOperationException>(() => host.ApplyFrame(frame));
        Assert.Equal("faulted", host.ConnectionState);
        Assert.False(host.InputEnabled);
        Assert.Null(host.World);
    }

    [Fact]
    public void JsonWelcomeThenWorldChangeFeedsDumpPositions()
    {
        using var host = new SpectatorReplicaHost(CreateManager);
        var self = new NetEntityId(1, 0x66);
        string welcome = "{\"connectionGeneration\":1,\"instanceId\":1,\"messageType\":\"Welcome\",\"selfNetEntityId\":\"" + self.ToHex() + "\"}";
        string change = Encoding.UTF8.GetString(InitialChange(self));
        Assert.True(host.ApplyFrame(Encoding.UTF8.GetBytes(welcome)));
        Assert.True(host.ApplyFrame(Encoding.UTF8.GetBytes(change)));
        Assert.Equal("active", host.ConnectionState);
        using JsonDocument dump = JsonDocument.Parse(SpectatorDump.DumpPositions(host.World!));
        Assert.True(dump.RootElement.GetArrayLength() >= 1);
        Assert.Contains(dump.RootElement.EnumerateArray(), row => row.GetProperty("id").GetString() == self.ToHex());
    }

    [Fact]
    public void SectionFrameAfterWelcomeIsQueuedForTheVoxelWorldAndWorldChangeStillActivates()
    {
        using var host = new SpectatorReplicaHost(CreateManager);
        var self = new NetEntityId(7, 2);
        Assert.True(host.ApplyFrame(WireCodec.EncodePack(new WelcomeMessage(7, self, 9))));
        // A SectionFrame still applies no entity frame, so this is still false —
        // but it is no longer thrown away: the envelope is read and queued for the
        // page to push into the Rust voxel world. The fixture's sectionKey is the
        // contract's canonical s:<x>:<y>:<z>; it used to be filler because nothing
        // parsed it, and a non-canonical key is now refused (see
        // SpectatorSectionFrameTests).
        Assert.False(host.ApplyFrame(Encoding.UTF8.GetBytes(
            "{\"messageType\":\"SectionFrame\",\"tick\":1,\"sectionKey\":\"s:0:0:0\",\"sectionRevision\":1,\"encoding\":\"Uniform\",\"payloadLength\":4,\"payload\":\"00000000\",\"payloadSha256\":\"0000000000000000000000000000000000000000000000000000000000000000\",\"observerPresence\":\"ready\",\"deliveryReason\":\"first\"}")));
        Assert.Equal("synchronizing", host.ConnectionState);
        Assert.NotNull(host.World);
        Assert.Equal(1, host.PendingSectionFrames);
        Assert.False(host.ApplyFrame(Encoding.UTF8.GetBytes(
            "{\"messageType\":\"HandshakeAck\",\"sessionId\":\"s-1\",\"role\":\"player\",\"accepted\":true,\"contractId\":\"lumio.mvp.v0\"}")));
        Assert.False(host.ApplyFrame(Encoding.UTF8.GetBytes(
            "{\"messageType\":\"OperationReceipt\",\"version\":1}")));
        Assert.True(host.ApplyFrame(InitialChange(self)));
        Assert.Equal("active", host.ConnectionState);
        using JsonDocument dump = JsonDocument.Parse(SpectatorDump.DumpPositions(host.World!));
        Assert.Contains(dump.RootElement.EnumerateArray(), row => row.GetProperty("id").GetString() == self.ToHex());
    }

    [Fact]
    public void UnknownFieldOnWorldChangeStillFaults()
    {
        using var host = new SpectatorReplicaHost(CreateManager);
        var self = new NetEntityId(7, 2);
        host.ApplyFrame(WireCodec.EncodePack(new WelcomeMessage(7, self, 9)));
        byte[] extra = Encoding.UTF8.GetBytes(
            "{\"appliedInputSequence\":0,\"creates\":[],\"destroys\":[],\"fields\":[],\"messageType\":\"WorldChange\",\"rpcs\":[],\"tick\":1,\"extra\":\"nope\"}");
        Assert.Throws<FormatException>(() => host.ApplyFrame(extra));
        Assert.Equal("faulted", host.ConnectionState);
        Assert.Null(host.World);
        Assert.Contains("unknown field: extra", host.LastApplyError, StringComparison.Ordinal);
    }

    [Fact]
    public void PlayerOnlyFullSnapshotRecordsAuthorityApplyFailed()
    {
        using var host = new SpectatorReplicaHost(CreateManager);
        var self = new NetEntityId(7, 2);
        host.ApplyFrame(WireCodec.EncodePack(new WelcomeMessage(7, self, 9)));
        byte[] playerOnly = WireCodec.EncodePack(new WorldChangeMessage(1, 0,
            new[] { new CreateRecord("player", self, new[] { new FieldValue(nameof(LogicTransform), "localPosition", "1,0,2") }) },
            Array.Empty<FieldChange>(), Array.Empty<DestroyRecord>(), Array.Empty<ClientRpcRecord>()));
        InvalidOperationException error = Assert.Throws<InvalidOperationException>(() => host.ApplyFrame(playerOnly));
        Assert.StartsWith("authority_apply_failed:", error.Message, StringComparison.Ordinal);
        Assert.Equal("faulted", host.ConnectionState);
        Assert.Contains("authority_apply_failed:", host.LastApplyError, StringComparison.Ordinal);
        Assert.Contains("FullSnapshot", host.LastApplyError, StringComparison.Ordinal);
    }

    /// <summary>
    /// Late spectator joining a room that already holds 100 active players: the
    /// catch-up census is produced by a real server-side WorldManager.Project
    /// (Sample registry, WorldTickBinding, EntityBindingQuery admission) and fed
    /// through the real SpectatorReplicaHost.ApplyFrame in wire order
    /// (Welcome first, then the census WorldChange). This is the r19/r20
    /// 100+2 shape; player-only fixtures cannot stand in for it.
    /// </summary>
    [Fact]
    public void LateSpectatorCensusOfHundredPlayerRoomAppliesAsFullSnapshot()
    {
        const int players = 100;
        WorldManager server = WorldManager.Create(new ServerSideRegistryWrapper(GeneratedRegistry.Instance), 0x1000000000000001UL);
        server.World.Single<WorldSaveComponent>().TickRate.Value = 20UL;
        SpectatorDump.BindSampleAttributeSeeds(server);
        server.Start(Thread.CurrentThread);
        server.BindTickLoop(new ServerProjectTickLoop(server));
        // The client compile drops *.Server.cs (IdentityComponent.AccountId), so
        // EntityBindingQuery.Admit cannot run here. Create the observers the way
        // Admit does internally: pending create + Connected observer + generation 1.
        for (int i = 0; i < players; i++)
        {
            EntityOrder order = server.World.Commands.CreateFor(typeof(Lumio.Sample.Gameplay.EntityTypes.PlayerEntity));
            var observer = (ObserverComponent)order.NamedComponent(nameof(ObserverComponent))!;
            observer.Connected = true;
            observer.ConnectionGeneration = 1;
        }
        server.Tick();
        server.DrainOutbox();

        EntityOrder spectatorOrder = server.World.Commands.CreateFor(typeof(Lumio.Sample.Gameplay.EntityTypes.PlayerEntity));
        var spectatorObserver = (ObserverComponent)spectatorOrder.NamedComponent(nameof(ObserverComponent))!;
        spectatorObserver.Connected = true;
        spectatorObserver.ConnectionGeneration = 1;
        server.Tick();
        WorldDrainResponse drain = server.DrainOutbox();
        NetEntityId spectatorId = spectatorOrder.AssignedId;

        using var host = new SpectatorReplicaHost(CreateManager);
        byte[] welcome = Array.Empty<byte>();
        byte[] census = Array.Empty<byte>();
        foreach (WorldMessage frame in drain.Frames)
        {
            if (frame is WelcomeMessage greet && greet.Self == spectatorId) welcome = WireCodec.EncodePack(greet);
            else if (frame is WorldChangeMessage change && change.ObserverId == spectatorId) census = WireCodec.EncodePack(change);
        }
        Assert.NotEmpty(welcome);
        Assert.NotEmpty(census);

        Assert.True(host.ApplyFrame(welcome));
        Assert.True(host.ApplyFrame(census), "late spectator census rejected: " + host.LastApplyError);
        Assert.Equal("active", host.ConnectionState);
        Assert.True(host.InputEnabled);
        using JsonDocument dump = JsonDocument.Parse(SpectatorDump.DumpPositions(host.World!));
        // 100 bots + the spectator itself.
        Assert.Equal(players + 1, dump.RootElement.GetArrayLength());
        DumpFramesForBrowserReplay(welcome, census);
    }

    /// <summary>Diagnostic only: LUMIO_CENSUS_DUMP=&lt;dir&gt; writes the two wire
    /// frames so the deployed wasm can be replayed against them in a browser.</summary>
    private static void DumpFramesForBrowserReplay(byte[] welcome, byte[] census)
    {
        string? dir = Environment.GetEnvironmentVariable("LUMIO_CENSUS_DUMP");
        if (string.IsNullOrEmpty(dir)) return;
        System.IO.Directory.CreateDirectory(dir);
        System.IO.File.WriteAllText(System.IO.Path.Combine(dir, "welcome.json"), Encoding.UTF8.GetString(welcome));
        System.IO.File.WriteAllText(System.IO.Path.Combine(dir, "census.json"), Encoding.UTF8.GetString(census));
    }

    /// <summary>Mirrors the Runtime test ClientSideRegistryWrapper: same wire
    /// names and templates, only the side flips so Project() runs. The wasm
    /// consumer keeps the real client registry.</summary>
    private sealed class ServerSideRegistryWrapper : EcsRegistry
    {
        private readonly EcsRegistry _inner;
        public ServerSideRegistryWrapper(EcsRegistry inner) => _inner = inner;
        public override RegistrySide Side => RegistrySide.Server;
        public override Type WorldEntityType => _inner.WorldEntityType;
        public override IReadOnlyList<Lumio.GameRuntime.Ecs.Annotations.FieldAttributeDeclaration> AttributeDeclarations => _inner.AttributeDeclarations;
        public override Component[] CreateComponents(Type entityType) => _inner.CreateComponents(entityType);
        public override string WireName(Type entityType) => _inner.WireName(entityType);
        public override bool TryResolveEntityType(string name, out Type entityType) => _inner.TryResolveEntityType(name, out entityType);
        public override bool IsEntityType(Type concrete, Type query) => _inner.IsEntityType(concrete, query);
        public override int ComponentIndex(Type entityType, Type componentType) => _inner.ComponentIndex(entityType, componentType);
        public override int ComponentIndex(Type entityType, string componentName) => _inner.ComponentIndex(entityType, componentName);
    }

    /// <summary>Managed tick loop for the producer world: same phase order as
    /// WorldTickBinding's replication slice, without NativeLoader (tests must
    /// not pin any engine native ABI).</summary>
    private sealed class ServerProjectTickLoop : IWorldTickLoop
    {
        private static readonly System.Reflection.BindingFlags Flags =
            System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.NonPublic;
        private readonly WorldManager _manager;
        private readonly System.Reflection.MethodInfo _capture;
        private readonly System.Reflection.MethodInfo _apply;
        private readonly System.Reflection.MethodInfo _commit;
        private readonly System.Reflection.MethodInfo _project;
        private readonly System.Reflection.MethodInfo _finalize;
        private readonly System.Reflection.MethodInfo _egress;

        public ServerProjectTickLoop(WorldManager manager)
        {
            _manager = manager;
            System.Type type = typeof(WorldManager);
            _capture = Required(type, "CaptureIngress");
            _apply = Required(type, "ApplyCapturedInputs");
            _commit = Required(type, "CommitCommandBuffer");
            _project = Required(type, "ProjectReplication");
            _finalize = Required(type, "FinalizeGasAndEvents");
            _egress = Required(type, "PublishEgress");
        }

        public bool IsFaulted => false;
        public string FaultedPhaseName => string.Empty;
        public void SettlePrediction(World world) { }

        public void ExecuteTick()
        {
            _capture.Invoke(_manager, null);
            _apply.Invoke(_manager, null);
            _commit.Invoke(_manager, null);
            _project.Invoke(_manager, null);
            _finalize.Invoke(_manager, null);
            _egress.Invoke(_manager, null);
        }

        private static System.Reflection.MethodInfo Required(System.Type type, string name)
            => type.GetMethod(name, Flags) ?? throw new InvalidOperationException("WorldManager missing " + name);
    }

    private static byte[] InitialChange(NetEntityId self) => WireCodec.EncodePack(new WorldChangeMessage(1, 0,
        new[]
        {
            new CreateRecord("world", new NetEntityId(self.InstanceId, 1), Array.Empty<FieldValue>()),
            new CreateRecord("player", self, new[] { new FieldValue(nameof(LogicTransform), "localPosition", "1,0,2") }),
        },
        Array.Empty<FieldChange>(), Array.Empty<DestroyRecord>(), Array.Empty<ClientRpcRecord>()));

    internal static WorldManager CreateManager() => SpectatorReplicaHost.CreateSampleWorld();
}


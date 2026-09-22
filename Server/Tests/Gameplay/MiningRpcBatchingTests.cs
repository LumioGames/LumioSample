using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Threading;
using Lumio.GameRuntime.Coordination;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.GameRuntime.Persistence;
using Lumio.GameRuntime.Replication.Binding;
using Lumio.GameRuntime.Simulation;
using Lumio.Sample.Gameplay.Components.Ore;
using Lumio.Sample.Gameplay.Components.Vein;
using Lumio.Sample.Gameplay.Config;
using Xunit;

namespace Lumio.Sample.Gameplay.Tests;

[Collection("SampleWorld")]
public sealed class MiningRpcBatchingTests
{
    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void TwoAuthenticatedPlayersPublishOnePhysicalBatchAndSettleExactlyOnce(bool reverseArrival)
    {
        using var fixture = new RpcWorld();
        World world = fixture.Manager.World;
        VeinReserveComponent a = fixture.Veins[0], b = fixture.Veins[1];
        ulong sectionA = a.SectionKey.Value, sectionB = b.SectionKey.Value;
        int cellA = a.CellOffset.Value, cellB = b.CellOffset.Value;
        int hits = SampleConfigBinding.For(world).Mining.VeinHitsToBreak;
        Assert.Equal(6, hits);
        long cost = SampleConfigBinding.For(world).Mining.StaminaCost;
        long initial = fixture.Stamina(fixture.A);
        for (ulong hit = 1; hit < (ulong)hits; hit++)
        {
            fixture.SendPair(hit, a.Entity, b.Entity, reverseArrival);
            fixture.Manager.Tick();
            Assert.All(fixture.Manager.DrainOutbox().Operations, row => Assert.Equal(OperationOutcomeKind.Succeeded, row.Outcome.Kind));
        }
        Assert.Equal(1, a.Remaining.Value);
        Assert.Equal(1, b.Remaining.Value);
        long before = initial - (hits - 1) * cost;
        ulong revision = fixture.Adapter.Read(sectionA, cellA).SectionRevision;
        ulong frame = world.Tick;
        fixture.SendPair((ulong)hits, a.Entity, b.Entity, reverseArrival);
        fixture.Manager.Tick();
        Assert.Equal(frame + 1, world.Tick);
        Assert.False(world.IsLive(a.Entity));
        Assert.False(world.IsLive(b.Entity));
        Assert.Equal(0U, fixture.Adapter.Read(sectionA, cellA).BlockId);
        Assert.Equal(0U, fixture.Adapter.Read(sectionB, cellB).BlockId);
        Assert.Null(fixture.Adapter.BindingGet(sectionA, cellA));
        Assert.Null(fixture.Adapter.BindingGet(sectionB, cellB));
        Assert.Equal(revision + 1, fixture.Adapter.Read(sectionA, cellA).SectionRevision);
        Assert.Equal(before, fixture.Stamina(fixture.A));
        Assert.Equal(before, fixture.Stamina(fixture.B));
        Assert.Empty(world.Each<OrePileComponent>());
        VoxelResultCheckpoint rows = fixture.Adapter.CaptureResultCheckpoint();
        Assert.Equal(2, rows.Results.Length);
        Assert.Equal(2, rows.AppliedDigs.Length);
        Assert.Equal(2, rows.DestroyedEntities.Length);
        Assert.Equal(rows.Results[0].BatchTransactionId, rows.Results[1].BatchTransactionId);
        Assert.NotNull(rows.Results[0].BatchTransactionId);
        Assert.Equal(rows.Results[0].Outcome.Receipt.OriginalReceiptBytes.ToArray(), rows.Results[1].Outcome.Receipt.OriginalReceiptBytes.ToArray());
        WorldOperationResult[] operations = fixture.Manager.DrainOutbox().Operations.ToArray();
        Assert.Equal(2, operations.Length);
        foreach (VoxelTransactionResult row in rows.Results)
        {
            WorldOperationResult operation = operations.Single(value => value.Operation == row.Operation);
            Assert.Equal(row.TransactionId, operation.TransactionId);
            Assert.Equal(OperationOutcomeKind.Succeeded, operation.Outcome.Kind);
            Assert.Equal(OperationCommitFact.Applied, operation.Outcome.CommitFact);
            Assert.Equal((ulong)hits, operation.Operation.Sequence);
            Assert.Equal(0, operation.Operation.PartIndex);
            Assert.Equal(1UL, operation.Operation.ConnectionGeneration);
            Assert.Equal(operation.Operation.Sender == fixture.A ? "miner-a" : "miner-b", operation.Operation.Connection);
        }
        Assert.Equal(fixture.A, rows.Results[0].Operation!.Value.Sender);
        Assert.Equal(fixture.B, rows.Results[1].Operation!.Value.Sender);

        DualCutCaptureResult capture = fixture.Host.Capture();
        Assert.True(capture.Succeeded, capture.ErrorCode);
        // Reopening the same pre-settlement cut creates independent worlds, each owing one payout.
        for (int restore = 0; restore < 2; restore++)
        {
            using DedicatedServerHostBinding cold = RpcWorld.Restore(capture.Checkpoint!.Value);
            HostVoxelWorldAdapter adapter = VoxelGameplayBinding.Resolve(cold.Manager)!;
            Assert.Equal(2, adapter.CaptureResultCheckpoint().Results.Length);
            Assert.Equal(VoxelTxnState.Unknown, adapter.Abi.QueryReceipt(adapter.Handle, rows.Results[0].BatchTransactionId!).State);
            Assert.Empty(cold.Manager.DrainOutbox().Operations);
            Assert.Equal(before, RpcWorld.Stamina(cold.Manager.World, fixture.A));
            cold.Manager.Tick();
            Assert.Equal(before - cost, RpcWorld.Stamina(cold.Manager.World, fixture.A));
            Assert.Equal(before - cost, RpcWorld.Stamina(cold.Manager.World, fixture.B));
            Assert.Equal(2, cold.Manager.World.Each<OrePileComponent>().Count());
            Assert.Empty(adapter.CaptureResultCheckpoint().Results);
            cold.Manager.Tick();
            Assert.Equal(before - cost, RpcWorld.Stamina(cold.Manager.World, fixture.A));
            DualCutCaptureResult settled = cold.Capture();
            Assert.True(settled.Succeeded, settled.ErrorCode);
            using DedicatedServerHostBinding again = RpcWorld.Restore(settled.Checkpoint!.Value);
            again.Manager.Tick();
            Assert.Equal(before - cost, RpcWorld.Stamina(again.Manager.World, fixture.A));
            Assert.Equal(2, again.Manager.World.Each<OrePileComponent>().Count());
        }
        fixture.Manager.Tick();
        Assert.Equal(before - cost, fixture.Stamina(fixture.A));
        Assert.Equal(before - cost, fixture.Stamina(fixture.B));
        fixture.SendPair((ulong)hits, a.Entity, b.Entity, reverseArrival);
        fixture.Manager.Tick();
        Assert.All(fixture.Manager.DrainOutbox().Operations, row => Assert.Equal(OperationOutcomeKind.ProtocolReject, row.Outcome.Kind));
        Assert.Equal(before - cost, fixture.Stamina(fixture.A));
        Assert.Equal(2, world.Each<OrePileComponent>().Count());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void SameDepositCanonicalFirstPlayerWinsRegardlessOfArrival(bool reverseArrival)
    {
        using TempConfig config = TempConfig.WithHits(1);
        using var fixture = new RpcWorld();
        VeinReserveComponent vein = fixture.Veins[0];
        PlayerLifecycleTests.PlaceFixturePlayer(fixture.Manager.World, fixture.B, vein.CellCenter);
        long before = fixture.Stamina(fixture.A);
        fixture.SendPair(1, vein.Entity, vein.Entity, reverseArrival);
        fixture.Manager.Tick();
        WorldOperationResult[] results = fixture.Manager.DrainOutbox().Operations.ToArray();
        Assert.Equal(OperationOutcomeKind.Succeeded, results.Single(row => row.Operation.Sender == fixture.A).Outcome.Kind);
        Assert.Equal(OperationOutcomeKind.BusinessReject, results.Single(row => row.Operation.Sender == fixture.B).Outcome.Kind);
        Assert.Single(fixture.Adapter.CaptureResultCheckpoint().Results);
        Assert.Equal(before, fixture.Stamina(fixture.A));
        Assert.Equal(before, fixture.Stamina(fixture.B));
        fixture.Manager.Tick();
        Assert.Equal(before - SampleConfigBinding.For(fixture.Manager.World).Mining.StaminaCost, fixture.Stamina(fixture.A));
        Assert.Equal(before, fixture.Stamina(fixture.B));
        Assert.Single(fixture.Manager.World.Each<OrePileComponent>());
    }

    [Fact]
    public void ImmediateStageRefusalIsBusinessRejectDespiteGasCompletedReturn()
    {
        using TempConfig config = TempConfig.WithHits(1);
        using var fixture = new RpcWorld();
        VeinReserveComponent vein = fixture.Veins[0];
        ulong revision = fixture.Adapter.Read(vein.SectionKey.Value, vein.CellOffset.Value).SectionRevision;
        Assert.Equal(VoxelStageStatus.Staged, fixture.Adapter.TryStageDigThrough(vein.SectionKey.Value,
            vein.CellOffset.Value, revision, "external-same-cell").Status);
        long before = fixture.Stamina(fixture.A);
        fixture.Manager.Enqueue(RpcWorld.Input(1, fixture.A, vein.Entity, "miner-a"));
        fixture.Manager.Tick();
        WorldOperationResult result = Assert.Single(fixture.Manager.DrainOutbox().Operations);
        Assert.Equal(OperationOutcomeKind.BusinessReject, result.Outcome.Kind);
        Assert.Equal(OperationCommitFact.NotApplied, result.Outcome.CommitFact);
        Assert.Null(result.TransactionId);
        Assert.Equal(before, fixture.Stamina(fixture.A));
        fixture.Manager.Tick();
        Assert.Equal(before, fixture.Stamina(fixture.A));
        Assert.Empty(fixture.Manager.World.Each<OrePileComponent>());
    }

    [Fact]
    public void ObserverFaultCannotEraseEitherRpcCompletion()
    {
        using TempConfig config = TempConfig.WithHits(1);
        using var fixture = new RpcWorld();
        int observations = 0;
        fixture.Adapter.DigApplied += _ =>
        {
            observations++;
            Assert.Equal(2, fixture.Adapter.CaptureResultCheckpoint().Results.Length);
            throw new InvalidOperationException("observer fault");
        };
        fixture.SendPair(1, fixture.Veins[0].Entity, fixture.Veins[1].Entity, true);
        Assert.ThrowsAny<Exception>(fixture.Manager.Tick);
        WorldOperationResult[] rows = fixture.Manager.DrainOutbox().Operations.ToArray();
        Assert.Equal(2, rows.Length);
        Assert.All(rows, row =>
        {
            Assert.Equal(OperationOutcomeKind.Succeeded, row.Outcome.Kind);
            Assert.Equal(OperationCommitFact.Applied, row.Outcome.CommitFact);
        });
        Assert.Equal(2, observations);
        Assert.Equal(2, fixture.Adapter.DrainResults().AppliedDigs.Count);
        Assert.Empty(fixture.Manager.World.Each<OrePileComponent>());
    }

    [Fact]
    public void MixedColdCutPaysTwoSuccessesButNeverTheRejectedOwnerWhoseCellAnotherWriterCleared()
    {
        using TempConfig config = TempConfig.WithHits(1);
        using var fixture = new RpcWorld(third: true);
        World world = fixture.Manager.World;
        NetEntityId rejectedVein = fixture.Veins[1].Entity;
        ulong section = fixture.Veins[1].SectionKey.Value;
        int cell = fixture.Veins[1].CellOffset.Value;
        long before = fixture.Stamina(fixture.A);
        Assert.True(world.TryReserveDestroyBatch(new[] { rejectedVein }, out WorldDestroyReservation? held));
        using (held)
        {
            fixture.Manager.Enqueue(RpcWorld.Input(1, fixture.C, fixture.Veins[2].Entity, "miner-c"));
            fixture.Manager.Enqueue(RpcWorld.Input(1, fixture.B, rejectedVein, "miner-b"));
            fixture.Manager.Enqueue(RpcWorld.Input(1, fixture.A, fixture.Veins[0].Entity, "miner-a"));
            fixture.Manager.Tick();
        }
        WorldOperationResult[] operations = fixture.Manager.DrainOutbox().Operations.ToArray();
        Assert.Equal(3, operations.Length);
        Assert.Equal(2, operations.Count(row => row.Outcome.Kind == OperationOutcomeKind.Succeeded));
        WorldOperationResult rejected = operations.Single(row => row.Operation.Sender == fixture.B);
        Assert.Equal(OperationOutcomeKind.BusinessReject, rejected.Outcome.Kind);
        Assert.Equal(OperationCommitFact.NotApplied, rejected.Outcome.CommitFact);
        Assert.Equal(5, rejected.NativeStatus);
        Assert.True(world.IsLive(rejectedVein));
        VoxelResultCheckpoint outcomes = fixture.Adapter.CaptureResultCheckpoint();
        Assert.Equal(3, outcomes.Results.Length);
        Assert.Equal(2, outcomes.AppliedDigs.Length);
        Assert.Single(outcomes.Results.Select(row => row.BatchTransactionId).Distinct());
        Assert.Equal(before, fixture.Stamina(fixture.A));
        Assert.Equal(before, fixture.Stamina(fixture.B));
        Assert.Equal(before, fixture.Stamina(fixture.C));

        // A different, explicit transaction now removes B's terrain. Its receipt must never
        // authorize B's refused logical request, even though a terrain-only inference would pay.
        ulong revision = fixture.Adapter.Read(section, cell).SectionRevision;
        Assert.Equal(VoxelStageStatus.Staged, fixture.Adapter.TryStageMutation(
            new[] { new VoxelWriteEntry(section, cell, 0, revision) },
            new[] { new VoxelBindingOp(section, cell, null) { ExpectedSectionRevision = revision } }, "foreign-clear").Status);
        Assert.Equal(VoxelTxnState.Applied, fixture.Adapter.CommitTransactionWithResult("foreign-clear").State);
        Assert.Equal(0U, fixture.Adapter.Read(section, cell).BlockId);
        Assert.Null(fixture.Adapter.BindingGet(section, cell));
        DualCutCaptureResult capture = fixture.Host.Capture();
        Assert.True(capture.Succeeded, capture.ErrorCode);
        using DedicatedServerHostBinding cold = RpcWorld.Restore(capture.Checkpoint!.Value);
        Assert.Empty(cold.Manager.DrainOutbox().Operations);
        Assert.Equal(4, VoxelGameplayBinding.Resolve(cold.Manager)!.CaptureResultCheckpoint().Results.Length);
        cold.Manager.Tick();
        long cost = SampleConfigBinding.For(cold.Manager.World).Mining.StaminaCost;
        Assert.Equal(before - cost, RpcWorld.Stamina(cold.Manager.World, fixture.A));
        Assert.Equal(before, RpcWorld.Stamina(cold.Manager.World, fixture.B));
        Assert.Equal(before - cost, RpcWorld.Stamina(cold.Manager.World, fixture.C));
        Assert.Equal(1, cold.Manager.World.Get<VeinReserveComponent>(rejectedVein).Remaining.Value);
        Assert.Equal(2, cold.Manager.World.Each<OrePileComponent>().Count());
        cold.Manager.Tick();
        Assert.Equal(before, RpcWorld.Stamina(cold.Manager.World, fixture.B));
        Assert.Equal(2, cold.Manager.World.Each<OrePileComponent>().Count());
    }

    private sealed class RpcWorld : IDisposable
    {
        private static string Root => Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));
        internal readonly WorldManager Manager;
        internal readonly DedicatedServerHostBinding Host;
        private readonly EntityBindingQuery _connections;
        internal readonly NetEntityId A, B, C;
        internal readonly VeinReserveComponent[] Veins;
        internal HostVoxelWorldAdapter Adapter => VoxelGameplayBinding.Resolve(Manager)!;
        internal RpcWorld(bool third = false)
        {
            Manager = SampleGameplay.CreateWorld(647);
            Host = Assert.IsType<DedicatedServerHostBinding>(DedicatedServerHostBinding.TryAttach(Manager,
                KernelConfigurationFixture.Create(), File.ReadAllBytes(Path.Combine(Root, "Server", "Assets", "Maps", "official-catalog.json")),
                File.ReadAllBytes(Path.Combine(Root, "Server", "Assets", "Maps", "sample.voxel"))));
            Manager.Start(Thread.CurrentThread);
            WorldTickBinding.Bind(Manager);
            _connections = EntityBindingQuery.Create(Manager);
            Manager.Enqueue(new AdmitConnectionMessage("miner-a", "account-a", "mining", "player"));
            Manager.Enqueue(new AdmitConnectionMessage("miner-b", "account-b", "mining", "player"));
            if (third) Manager.Enqueue(new AdmitConnectionMessage("miner-c", "account-c", "mining", "player"));
            for (int i = 0; i < 4; i++) Manager.Tick();
            Assert.True(_connections.TryResolveConnectionState("miner-a", out A, out ulong ga));
            Assert.True(_connections.TryResolveConnectionState("miner-b", out B, out ulong gb));
            Assert.Equal(1UL, ga); Assert.Equal(1UL, gb);
            if (third) Assert.True(_connections.TryResolveConnectionState("miner-c", out C, out _));
            Veins = Manager.World.Each<VeinReserveComponent>().GroupBy(row => row.SectionKey.Value)
                .First(group => group.Count() >= (third ? 3 : 2)).Take(third ? 3 : 2).ToArray();
            PlayerLifecycleTests.PlaceFixturePlayer(Manager.World, A, Veins[0].CellCenter);
            PlayerLifecycleTests.PlaceFixturePlayer(Manager.World, B, Veins[1].CellCenter);
            if (third) PlayerLifecycleTests.PlaceFixturePlayer(Manager.World, C, Veins[2].CellCenter);
            Assert.IsNotType<RecordingAbilityPhysicsPort>(Manager.World.Get<AbilityComponent>(A).Physics);
            Manager.DrainOutbox();
        }
        internal void SendPair(ulong sequence, NetEntityId targetA, NetEntityId targetB, bool reverse)
        {
            InputCommandMessage a = Input(sequence, A, targetA, "miner-a");
            InputCommandMessage b = Input(sequence, B, targetB, "miner-b");
            Manager.Enqueue(reverse ? b : a); Manager.Enqueue(reverse ? a : b);
        }
        internal static InputCommandMessage Input(ulong sequence, NetEntityId sender, NetEntityId target, string connection) =>
            new(sequence, WireCodec.ServerRpc, sender, EncodeRpc(target, sequence), connection, 1) { ReceiptParts = new[] { 0 } };
        private static byte[] EncodeRpc(NetEntityId target, ulong sequence)
        {
            // WireCodec's encoder is internal to ECS. Invoke the actual encoder without adding
            // Sample friendship or duplicating its wire layout; server dispatch stays generated.
            MethodInfo encode = typeof(WireCodec).GetMethod("EncodeServerRpc", BindingFlags.Static | BindingFlags.NonPublic,
                null, new[] { typeof(string), typeof(string), typeof(object[]) }, null)!;
            return (byte[])encode.Invoke(null, new object[] { nameof(AbilityComponent), "Activate",
                new object?[] { nameof(MineAbility), target.ToHex(), sequence } })!;
        }
        internal long Stamina(NetEntityId entity) => Stamina(Manager.World, entity);
        internal static long Stamina(World world, NetEntityId entity) => world.Get<AttributeComponent>(entity).GetBaseValue("Stamina");
        internal static DedicatedServerHostBinding Restore(DualCutCheckpointPayload checkpoint)
        {
            DedicatedServerRestoreResult restored = DedicatedServerHostBinding.RestoreNew(checkpoint.Runtime, checkpoint.Voxel,
                GeneratedRegistry.Instance, KernelConfigurationFixture.Create(), null, WorldIngressBudget.Default,
                File.ReadAllBytes(Path.Combine(Root, "Server", "Assets", "Maps", "official-catalog.json")), SampleConfigBinding.Load());
            Assert.True(restored.Succeeded, restored.ErrorCode);
            DedicatedServerHostBinding host = restored.Binding!;
            host.Manager.Start(Thread.CurrentThread); WorldTickBinding.Bind(host.Manager);
            return host;
        }
        public void Dispose() { _connections.Dispose(); Host.Dispose(); Manager.Dispose(); }
    }
}

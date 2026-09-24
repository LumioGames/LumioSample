using System;
using System.Globalization;
using System.Text;
using System.Text.Json;
using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Client.Spectator.Tests;

/// <summary>
/// The SectionFrame envelope reader itself (<c>SpectatorSectionFrame</c>) is an engine
/// part and is tested in LumioClient. These cases are the half that needs this game:
/// the spectator host queues frames on the Sample client world and the dump names
/// Sample entities by their declared wire type.
/// </summary>
public sealed class SpectatorSectionQueueTests
{
    /// <summary>
    /// The engine wire contract's own valid SectionFrame fixture, copied verbatim
    /// from <c>engine/wire/voxel-section-transport-v1.json</c> → <c>testCases[0]</c>.
    /// </summary>
    private const string ContractSectionFrame =
        "{\"messageType\":\"SectionFrame\",\"tick\":1,\"sectionKey\":\"s:0:0:0\",\"sectionRevision\":1,"
        + "\"encoding\":\"Uniform\",\"payloadLength\":4,\"payload\":\"00000000\","
        + "\"payloadSha256\":\"df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119\","
        + "\"observerPresence\":\"absent\",\"deliveryReason\":\"first\"}";

    private static byte[] Utf8(string text) => Encoding.UTF8.GetBytes(text);

    [Fact]
    public void ApplyFrameQueuesTheSectionWithoutFaultingTheEntityReplica()
    {
        using var host = new SpectatorReplicaHost(SpectatorReplicaHost.CreateSampleWorld);
        var self = new NetEntityId(7, 2);
        Assert.True(host.ApplyFrame(WireCodec.EncodePack(new WelcomeMessage(7, self, 9))));

        // A SectionFrame is not an entity frame, so it applies nothing...
        Assert.False(host.ApplyFrame(Utf8(ContractSectionFrame)));
        // ...and it must not take the session down the way an unknown type used to.
        Assert.Equal("synchronizing", host.ConnectionState);
        Assert.NotNull(host.World);
        Assert.Equal(1, host.PendingSectionFrames);

        using JsonDocument header = JsonDocument.Parse(host.PeekSectionHeader());
        Assert.Equal("s:0:0:0", header.RootElement.GetProperty("sectionKey").GetString());
        Assert.Equal(0, header.RootElement.GetProperty("sectionX").GetInt32());
        // u64 revisions cross to JS as strings so nothing is lost past 2^53.
        Assert.Equal("1", header.RootElement.GetProperty("sectionRevision").GetString());
        Assert.Equal(32, header.RootElement.GetProperty("digestBytes").GetInt32());
        Assert.Equal(4, header.RootElement.GetProperty("payloadBytes").GetInt32());
        // Peek does not consume.
        Assert.Equal(1, host.PendingSectionFrames);

        byte[] bytes = host.TakeSectionBytes();
        Assert.Equal(36, bytes.Length);
        Assert.Equal(
            "df3f619804a92fdb4057192dc43dd748ea778adc52bc498ce80524c014b81119",
            Convert.ToHexString(bytes, 0, 32).ToLowerInvariant());
        Assert.Equal(new byte[] { 0, 0, 0, 0 }, bytes[32..]);

        Assert.Equal(0, host.PendingSectionFrames);
        Assert.Equal(string.Empty, host.PeekSectionHeader());
        Assert.Empty(host.TakeSectionBytes());
    }

    [Fact]
    public void AnUndrainedQueueFailsLoudlyInsteadOfGrowingWithoutLimit()
    {
        using var host = new SpectatorReplicaHost(SpectatorReplicaHost.CreateSampleWorld);
        byte[] frame = Utf8(ContractSectionFrame);
        for (int i = 0; i < SpectatorReplicaHost.MaxQueuedSectionFrames; i++) Assert.False(host.ApplyFrame(frame));
        Assert.Equal(SpectatorReplicaHost.MaxQueuedSectionFrames, host.PendingSectionFrames);
        Assert.ThrowsAny<Exception>(() => host.ApplyFrame(frame));
    }

    [Fact]
    public void DisposeDropsVoxelBytesThatBelongedToTheEndingSession()
    {
        var host = new SpectatorReplicaHost(SpectatorReplicaHost.CreateSampleWorld);
        Assert.False(host.ApplyFrame(Utf8(ContractSectionFrame)));
        Assert.Equal(1, host.PendingSectionFrames);
        host.Dispose();
        Assert.Equal(0, host.PendingSectionFrames);
        Assert.Equal(string.Empty, host.PeekSectionHeader());
    }

    [Fact]
    public void DumpPositionsNamesEachEntityByItsDeclaredWireType()
    {
        const ulong instance = 31UL;
        NetEntityId worldId = new(instance, 1UL);
        NetEntityId self = new(instance, 2UL);

        // The browser world the spectator actually runs: replica apply loop, no
        // Native context to bind (WorldTickBinding wants one and wasm has none).
        WorldManager client = SpectatorReplicaHost.CreateSampleWorld();
        try
        {
            client.Enqueue(new WelcomeMessage(instance, self, 1UL));
            client.Enqueue(new WorldChangeMessage(
                1UL,
                0UL,
                new[]
                {
                    new CreateRecord("world", worldId, Array.Empty<FieldValue>()),
                    new CreateRecord("player", self, new[]
                    {
                        new FieldValue(nameof(LogicTransform), "localPosition",
                            string.Format(CultureInfo.InvariantCulture, "{0},{1},{2}", 4f, 0f, 6f)),
                    }),
                },
                Array.Empty<FieldChange>(),
                Array.Empty<DestroyRecord>(),
                Array.Empty<ClientRpcRecord>()));
            client.Tick();

            using JsonDocument document = JsonDocument.Parse(SpectatorDump.DumpPositions(client.World));
            JsonElement row = Assert.Single(document.RootElement.EnumerateArray());
            Assert.Equal(self.ToHex(), row.GetProperty("id").GetString());
            // The wire name the registry declared, not a shape the page guessed.
            Assert.Equal("player", row.GetProperty("type").GetString());
        }
        finally
        {
            client.Dispose();
        }
    }
}

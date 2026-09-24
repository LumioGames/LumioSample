using System.Globalization;
using System.Numerics;
using System.Text.Json;
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay;
using Lumio.Sample.Gameplay.Components.Identity;

namespace Lumio.Sample.Client.Spectator.Tests;

public sealed class SpectatorExportTests
{
    [Fact]
    public void DumpPositionsMatchesLiveLogicTransformLocalPosition()
    {
        const ulong instance = 7UL;
        NetEntityId worldId = new(instance, 1UL);
        NetEntityId self = new(instance, 2UL);
        NetEntityId other = new(instance, 3UL);
        NetEntityId third = new(instance, 4UL);
        var poses = new Dictionary<NetEntityId, Vector3>
        {
            [self] = new Vector3(1.25f, 0f, 2.5f),
            [other] = new Vector3(-4f, 0f, 8f),
            [third] = new Vector3(10f, 0f, -3f),
        };

        using WorldManager client = BootClient();

        client.Enqueue(new WelcomeMessage(instance, self, 1UL));
        client.Enqueue(new WorldChangeMessage(
            1UL,
            0UL,
            new[]
            {
                new CreateRecord("world", worldId, Array.Empty<FieldValue>()),
                PlayerCreate(self, poses[self]),
                PlayerCreate(other, poses[other]),
                PlayerCreate(third, poses[third]),
            },
            Array.Empty<FieldChange>(),
            Array.Empty<DestroyRecord>(),
            Array.Empty<ClientRpcRecord>()));
        client.Tick();

        string json = SpectatorDump.DumpPositions(client.World);
        using JsonDocument document = JsonDocument.Parse(json);
        Assert.Equal(JsonValueKind.Array, document.RootElement.ValueKind);

        var dumped = new Dictionary<string, (float X, float Z)>();
        foreach (JsonElement row in document.RootElement.EnumerateArray())
        {
            Assert.True(row.TryGetProperty("id", out JsonElement id));
            Assert.True(row.TryGetProperty("x", out JsonElement x));
            Assert.True(row.TryGetProperty("z", out JsonElement z));
            Assert.True(row.TryGetProperty("hue", out JsonElement hue));
            dumped[id.GetString()!] = (x.GetSingle(), z.GetSingle());
        }

        Assert.Equal(poses.Count, dumped.Count);
        foreach (LogicTransform transform in client.World.Each<LogicTransform>())
        {
            Vector3 local = transform.LocalPosition;
            Assert.True(dumped.TryGetValue(transform.Entity.ToHex(), out (float X, float Z) row));
            Assert.Equal(local.X, row.X);
            Assert.Equal(local.Z, row.Z);
            Assert.Equal(poses[transform.Entity].X, local.X);
            Assert.Equal(poses[transform.Entity].Z, local.Z);
        }
    }

    [Fact]
    public void ApplyPackWelcomeAndWorldChangeFeedsDump()
    {
        const ulong instance = 11UL;
        NetEntityId worldId = new(instance, 1UL);
        NetEntityId self = new(instance, 2UL);
        var pose = new Vector3(6f, 0f, -2f);

        using WorldManager client = BootClient();
        byte[] welcome = WireCodec.EncodePack(new WelcomeMessage(instance, self, 1UL));
        byte[] change = WireCodec.EncodePack(new WorldChangeMessage(
            1UL,
            0UL,
            new[]
            {
                new CreateRecord("world", worldId, Array.Empty<FieldValue>()),
                PlayerCreate(self, pose),
            },
            Array.Empty<FieldChange>(),
            Array.Empty<DestroyRecord>(),
            Array.Empty<ClientRpcRecord>()));

        SpectatorDump.ApplyPack(client, welcome);
        SpectatorDump.ApplyPack(client, change);

        LogicTransform live = client.World.Get<LogicTransform>(self);
        using JsonDocument document = JsonDocument.Parse(SpectatorDump.DumpPositions(client.World));
        JsonElement row = document.RootElement[0];
        Assert.Equal(self.ToHex(), row.GetProperty("id").GetString());
        Assert.True(row.GetProperty("self").GetBoolean());
        Assert.Equal(live.LocalPosition.X, row.GetProperty("x").GetSingle());
        Assert.Equal(live.LocalPosition.Z, row.GetProperty("z").GetSingle());
        Assert.Equal(pose.X, live.LocalPosition.X);
        Assert.Equal(pose.Z, live.LocalPosition.Z);
    }

    [Fact]
    public void IssueSelfMoveWritesInputCommandEnvelopeWithoutJsCodec()
    {
        const ulong instance = 13UL;
        NetEntityId worldId = new(instance, 1UL);
        NetEntityId self = new(instance, 2UL);

        using WorldManager client = BootClient();
        SpectatorDump.ApplyPack(client, WireCodec.EncodePack(new WelcomeMessage(instance, self, 1UL)));
        SpectatorDump.ApplyPack(client, WireCodec.EncodePack(new WorldChangeMessage(
            1UL,
            0UL,
            new[]
            {
                new CreateRecord("world", worldId, Array.Empty<FieldValue>()),
                PlayerCreate(self, new Vector3(4f, 0f, 6f)),
            },
            Array.Empty<FieldChange>(),
            Array.Empty<DestroyRecord>(),
            Array.Empty<ClientRpcRecord>())));

        ulong sequence = 0;
        uint rng = SpectatorDump.MixSeed(self.ToHex());
        Assert.True(SpectatorDump.IssueSelfMove(client.World, ref sequence, ref rng));
        Assert.Equal(1UL, sequence);

        using JsonDocument outbound = JsonDocument.Parse(SpectatorDump.TakeOutbound(client));
        Assert.Equal(JsonValueKind.Array, outbound.RootElement.ValueKind);
        Assert.True(outbound.RootElement.GetArrayLength() >= 1);
        JsonElement envelope = outbound.RootElement[0];
        Assert.Equal("InputCommand", envelope.GetProperty("messageType").GetString());
        Assert.True(envelope.GetProperty("commands").GetArrayLength() >= 1);
    }

    [Fact]
    public void NextMapStepInsidePlaneIsSeededAndNonStationary()
    {
        uint a = SpectatorDump.MixSeed("self-a");
        uint b = a;
        var first = new List<string>();
        for (int i = 0; i < 12; i++)
        {
            SpectatorDump.NextMapStep(16f, 16f, ref a, out int dx, out int dz);
            first.Add(dx + "," + dz);
            SpectatorDump.NextMapStep(16f, 16f, ref b, out int dx2, out int dz2);
            Assert.Equal(dx, dx2);
            Assert.Equal(dz, dz2);
            Assert.False(dx == 0 && dz == 0);
            Assert.InRange(dx, -1, 1);
            Assert.InRange(dz, -1, 1);
        }

        Assert.True(first.Distinct(StringComparer.Ordinal).Count() >= 2);
    }

    /// <summary>
    /// The browser world the spectator actually runs: Sample config binding plus the
    /// replica apply loop. WorldTickBinding.Bind demands a bound Native Context and
    /// wasm has none, so the spectator host never takes that path — booting the export
    /// tests through anything else would test a world the page cannot build.
    /// </summary>
    private static WorldManager BootClient() => SpectatorReplicaHost.CreateSampleWorld();

    [Fact]
    public void DumpPositionsCarriesTheReplicatedColorHue()
    {
        const ulong instance = 21UL;
        NetEntityId worldId = new(instance, 1UL);
        NetEntityId self = new(instance, 2UL);
        NetEntityId other = new(instance, 3UL);

        using WorldManager client = BootClient();
        client.Enqueue(new WelcomeMessage(instance, self, 1UL));
        client.Enqueue(new WorldChangeMessage(
            1UL,
            0UL,
            new[]
            {
                new CreateRecord("world", worldId, Array.Empty<FieldValue>()),
                PlayerCreate(self, new Vector3(1f, 0f, 1f), hue: 120),
                PlayerCreate(other, new Vector3(4f, 0f, 4f), hue: 300),
            },
            Array.Empty<FieldChange>(),
            Array.Empty<DestroyRecord>(),
            Array.Empty<ClientRpcRecord>()));
        client.Tick();

        using JsonDocument document = JsonDocument.Parse(SpectatorDump.DumpPositions(client.World));
        var hues = new Dictionary<string, int>();
        foreach (JsonElement row in document.RootElement.EnumerateArray())
        {
            hues[row.GetProperty("id").GetString()!] = row.GetProperty("hue").GetInt32();
        }

        // The hue must come out of the replicated Identity field, identical for
        // every client; the page paints it at 75% alpha and derives nothing.
        Assert.Equal(120, hues[self.ToHex()]);
        Assert.Equal(300, hues[other.ToHex()]);
    }

    private static CreateRecord PlayerCreate(NetEntityId id, Vector3 local, int? hue = null)
    {
        string value = string.Format(
            CultureInfo.InvariantCulture,
            "{0},{1},{2}",
            local.X,
            local.Y,
            local.Z);
        var fields = new List<FieldValue> { new(nameof(LogicTransform), "localPosition", value) };
        if (hue.HasValue)
        {
            fields.Add(new FieldValue(
                nameof(IdentityComponent),
                "colorHue",
                hue.Value.ToString(CultureInfo.InvariantCulture)));
        }

        return new CreateRecord("player", id, fields.ToArray());
    }
}


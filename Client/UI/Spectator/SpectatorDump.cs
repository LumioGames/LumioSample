using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using Lumio.GameRuntime.Config;
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay;
using Lumio.Sample.Gameplay.Components.Identity;

namespace Lumio.Sample.Client.Spectator;

/// <summary>Desktop-safe dump of live LogicTransform poses. JS never parses the wire.</summary>
public static class SpectatorDump
{
    /// <summary>
    /// Resource prefix of the Sample LumioConfig export embedded beside these sources.
    /// The Sample client registry declares a gameplay config contract, so a World
    /// cannot be created without the projected tables, and browser wasm has no host
    /// filesystem for <c>SampleTables.ResolveDirectory</c> to resolve. The export
    /// therefore travels inside the assembly and is read back through the Runtime's
    /// own <see cref="IConfigArtifactBytes"/> seam. Paths match the export layout
    /// (<c>manifest.json</c>, <c>client/&lt;table&gt;.json</c>).
    /// </summary>
    private const string SampleExportPrefix = "SampleConfigExport/";

    private static readonly Lazy<IAttributeSeedProvider> SampleSeeds = new(ProjectSampleSeeds);

    /// <summary>
    /// Loads and activates the Sample config export, then hands back the binding the
    /// Sample client registry requires. Attribute seeds ride along: the projected
    /// Sample config is itself the <see cref="IAttributeSeedProvider"/>, and the Sample
    /// adapter's <c>BindWorld</c> installs it when the binding is attached.
    /// </summary>
    public static WorldConfigBinding LoadSampleConfig()
    {
        IGameConfigExportBinding entry = CreateSampleConfigEntry();
        var module = ConfigModule.Create();
        if (!module.Stage(LoadSampleExport(entry)).Staged || !module.ActivateAtBarrier(default).Activated)
            throw new InvalidOperationException("Sample config activation failed.");
        return new WorldConfigBinding(module, GeneratedRegistry.Instance, entry);
    }

    /// <summary>
    /// Binds the Sample attribute seeds on a World whose registry declares no gameplay
    /// config contract — the producer-side wrapper the tests use — where a
    /// <see cref="WorldConfigBinding"/> cannot attach. The values still come from the
    /// Sample config export: the projected config is the seed provider. Worlds built on
    /// the real registry take the seeds through <see cref="LoadSampleConfig"/> instead.
    /// </summary>
    public static void BindSampleAttributeSeeds(WorldManager manager)
    {
        if (manager is null) throw new ArgumentNullException(nameof(manager));
        manager.World.SeedProvider ??= SampleSeeds.Value;
    }

    private static IGameConfigExportBinding CreateSampleConfigEntry() =>
        GeneratedRegistry.Instance.CreateGameplayConfigBinding()
        ?? throw new InvalidOperationException("Sample registry declares no gameplay config binding.");

    private static ConfigSnapshot LoadSampleExport(IGameConfigExportBinding entry)
    {
        ConfigTarget target = GeneratedRegistry.Instance.Side == RegistrySide.Server ? ConfigTarget.Server : ConfigTarget.Client;
        LumioConfigLoadResult result = LumioConfigLoader.Load(new EmbeddedSampleExport(), target,
            requiredTables: entry.RequiredTables, typedTableFactory: entry.CreateTypedTables);
        if (!result.IsSuccess) throw new InvalidOperationException(result.ErrorMessage);
        return result.CreateSnapshot(new ConfigSnapshotId(1));
    }

    private static IAttributeSeedProvider ProjectSampleSeeds()
    {
        IGameConfigExportBinding entry = CreateSampleConfigEntry();
        return entry.Project(LoadSampleExport(entry)) as IAttributeSeedProvider
            ?? throw new InvalidOperationException("Projected Sample config carries no attribute seeds.");
    }

    private sealed class EmbeddedSampleExport : IConfigArtifactBytes
    {
        public ReadOnlyMemory<byte> ReadFile(string relativePath)
        {
            if (string.IsNullOrEmpty(relativePath)) return ReadOnlyMemory<byte>.Empty;
            using Stream? stream = typeof(SpectatorDump).Assembly
                .GetManifestResourceStream(SampleExportPrefix + relativePath.Replace('\\', '/'));
            if (stream is null) return ReadOnlyMemory<byte>.Empty;
            using var buffer = new MemoryStream();
            stream.CopyTo(buffer);
            return buffer.ToArray();
        }
    }

    public static string DumpPositions(World world)
    {
        if (world is null) throw new ArgumentNullException(nameof(world));
        string? selfId = null;
        try
        {
            selfId = world.Self.Id.ToHex();
        }
        catch (InvalidOperationException)
        {
            // Welcome has not bound Self yet; dump still lists replica poses.
        }
        var json = new StringBuilder();
        json.Append('[');
        bool first = true;
        foreach (LogicTransform transform in world.Each<LogicTransform>())
        {
            if (!first) json.Append(',');
            first = false;
            System.Numerics.Vector3 pos = transform.LocalPosition;
            string id = transform.Entity.ToHex();
            // The hue is a replicated Identity field the server stamped at
            // admission; the dump only reads what the world snapshot carried
            // in, so every client paints the same color for the same person.
            json.Append("{\"id\":");
            AppendString(json, id);
            json.Append(",\"x\":").Append(Format(pos.X));
            json.Append(",\"z\":").Append(Format(pos.Z));
            json.Append(",\"hue\":").Append(HueOf(world, transform.Entity).ToString(CultureInfo.InvariantCulture));
            // Declared entity wire name (player / vein / oreDrop / ...). The page
            // groups dots by it; it never infers a kind from the id or the pose.
            json.Append(",\"type\":");
            AppendString(json, TypeNameOf(world, transform.Entity));
            if (selfId is not null && string.Equals(id, selfId, StringComparison.Ordinal))
                json.Append(",\"self\":true");
            json.Append('}');
        }

        json.Append(']');
        return json.ToString();
    }

    /// <summary>
    /// Declared wire name of a live entity, from the registry that created it.
    /// Entities the registry cannot name (the world entity) dump an empty string
    /// rather than a guess.
    /// </summary>
    private static string TypeNameOf(World world, NetEntityId id)
    {
        try
        {
            string name = world.Registry.WireName(world.TypeOf(id).ClrType) ?? string.Empty;
            // AppendString does not escape; a name that would need it is dropped
            // rather than allowed to produce a broken dump the page cannot parse.
            foreach (char c in name)
            {
                bool plain = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')
                    || (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
                if (!plain) return string.Empty;
            }

            return name;
        }
        catch (InvalidOperationException)
        {
            return string.Empty;
        }
        catch (ArgumentException)
        {
            return string.Empty;
        }
        catch (KeyNotFoundException)
        {
            return string.Empty;
        }
    }

    private static int HueOf(World world, NetEntityId id)
    {
        try
        {
            return world.Get<IdentityComponent>(id).ColorHue.Value;
        }
        catch (InvalidOperationException)
        {
            // Entities without IdentityComponent (e.g. the world entity) carry
            // no admission color; the page falls back to a neutral gray.
            return -1;
        }
    }

    public static void ApplyPack(WorldManager manager, ReadOnlySpan<byte> frame)
    {
        if (manager is null) throw new ArgumentNullException(nameof(manager));
        WorldMessage message = WireCodec.DecodePack(frame);
        if (message is WelcomeMessage or WorldChangeMessage)
        {
            manager.Enqueue(message);
            manager.Tick();
        }
    }

    public static byte[] DecodeFrameText(string frame)
    {
        if (string.IsNullOrEmpty(frame)) throw new ArgumentException("frame required", nameof(frame));
        char lead = frame[0];
        if (lead == '{' || lead == '[') return Encoding.UTF8.GetBytes(frame);
        return Convert.FromBase64String(frame);
    }

    /// <summary>Sample <c>Server/Assets/Maps/sample.layout.json</c> is a 32×32 plane with a wall ring; inner walkable is 1..30.</summary>
    public const float MapMin = 1f;

    public const float MapMax = 30f;

    public const float MapStepMeters = 1.25f;

    /// <summary>
    /// Issues one owner <c>Activate&lt;MoveAbility&gt;</c> for World.Self. The replica
    /// outbox holds the InputCommand; JS only sends those bytes (no second codec).
    /// </summary>
    public static bool IssueSelfMove(World world, ref ulong sequence, ref uint rng)
    {
        if (world is null) throw new ArgumentNullException(nameof(world));
        Entity self;
        try
        {
            self = world.Self;
        }
        catch (InvalidOperationException)
        {
            return false;
        }

        AbilityComponent abilities;
        LogicTransform logic;
        try
        {
            abilities = self.Get<AbilityComponent>();
            logic = self.Get<LogicTransform>();
        }
        catch (InvalidOperationException)
        {
            return false;
        }

        System.Numerics.Vector3 pos = logic.LocalPosition;
        NextMapStep(pos.X, pos.Z, ref rng, out int dx, out int dz);
        sequence++;
        var input = new MoveAbility.Input { Dx = dx, Dz = dz };
        abilities.Activate<MoveAbility, MoveAbility.Input>(in input, sequence);
        return true;
    }

    /// <summary>Drain replica outbox and return JSON array of C-1 InputCommand envelopes.</summary>
    public static string TakeOutbound(WorldManager manager)
    {
        if (manager is null) throw new ArgumentNullException(nameof(manager));
        WorldDrainResponse drain = manager.DrainOutbox();
        return EncodeOutbound(drain.Frames);
    }

    public static string EncodeOutbound(IReadOnlyList<WorldMessage> frames)
    {
        var json = new StringBuilder();
        json.Append('[');
        bool first = true;
        for (int i = 0; i < frames.Count; i++)
        {
            if (frames[i] is not InputCommandMessage input) continue;
            byte[] encoded = WireCodec.EncodeInput(input);
            if (!first) json.Append(',');
            first = false;
            json.Append(Encoding.UTF8.GetString(encoded));
        }

        json.Append(']');
        return json.ToString();
    }

    public static uint MixSeed(string accountId)
    {
        uint hash = 2166136261u;
        string text = accountId ?? string.Empty;
        for (int i = 0; i < text.Length; i++)
        {
            hash ^= text[i];
            hash *= 16777619u;
        }

        return hash == 0u ? 1u : hash;
    }

    public static uint NextRng(ref uint state)
    {
        uint x = state == 0u ? 1u : state;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        state = x == 0u ? 1u : x;
        return state;
    }

    public static void NextMapStep(float x, float z, ref uint rng, out int dx, out int dz)
    {
        bool inside = x >= MapMin && x <= MapMax && z >= MapMin && z <= MapMax;
        if (!inside)
        {
            int wantX = x < MapMin ? 1 : x > MapMax ? -1 : 0;
            int wantZ = z < MapMin ? 1 : z > MapMax ? -1 : 0;
            if (wantX == 0 && wantZ == 0)
            {
                dx = 1;
                dz = 0;
                return;
            }

            uint toward = NextRng(ref rng) % 3u;
            if (wantX != 0 && wantZ != 0)
            {
                dx = toward == 0u ? wantX : toward == 1u ? 0 : wantX;
                dz = toward == 0u ? 0 : wantZ;
            }
            else
            {
                dx = wantX;
                dz = wantZ;
            }

            if (dx == 0 && dz == 0) dx = wantX != 0 ? wantX : 1;
            return;
        }

        uint pick = NextRng(ref rng) % 8u;
        if (pick >= 4u) pick++;
        dx = ((int)pick / 3) - 1;
        dz = ((int)pick % 3) - 1;
        if (dx == 0 && dz == 0) dx = 1;
    }

    private static string Format(float value) => value.ToString("G9", CultureInfo.InvariantCulture);

    private static void AppendString(StringBuilder json, string value)
    {
        json.Append('"');
        json.Append(value);
        json.Append('"');
    }
}


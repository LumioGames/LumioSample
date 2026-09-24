using System;
using System.Runtime.InteropServices.JavaScript;
using System.Linq;
using System.Text.Json;

namespace Lumio.Sample.Client.Spectator;

internal static class Program
{
    private static int Main() => 0;
}

public static partial class SpectatorExports
{
    [JSExport]
    public static string DevLoadedModules() => JsonSerializer.Serialize(AppDomain.CurrentDomain.GetAssemblies()
        .Where(assembly => !assembly.IsDynamic)
        .Select(assembly => new { name = assembly.GetName().Name, mvid = assembly.ManifestModule.ModuleVersionId, path = "" }));
    private static SpectatorReplicaHost? s_client;
    private static ulong s_moveSequence;
    private static uint s_rng = 1u;

    [JSExport]
    public static void Boot()
    {
        s_client?.Dispose();
        s_client = new SpectatorReplicaHost(SpectatorReplicaHost.CreateSampleWorld);
        s_moveSequence = 0;
        s_rng = 1u;
    }

    [JSExport]
    public static bool OnBytes(byte[] frame)
    {
        if (s_client is null || frame is null) throw new InvalidOperationException("spectator_not_started");
        return s_client.ApplyFrame(frame);
    }

    [JSExport]
    public static bool OnFrame(string frame)
    {
        if (s_client is null) throw new InvalidOperationException("spectator_not_started");
        return s_client.ApplyFrame(System.Text.Encoding.UTF8.GetBytes(frame));
    }

    [JSExport]
    public static void Close() => s_client?.Dispose();

    [JSExport]
    public static string ConnectionState() => s_client?.ConnectionState ?? "closed";

    [JSExport]
    public static string LastApplyError() => s_client?.LastApplyError ?? string.Empty;

    [JSExport]
    public static string DumpPositions()
    {
        if (s_client?.World is null) return "[]";
        return SpectatorDump.DumpPositions(s_client.World);
    }

    /// <summary>Number of SectionFrames read off the wire and not yet pulled.</summary>
    [JSExport]
    public static int PendingSectionFrames() => s_client?.PendingSectionFrames ?? 0;

    /// <summary>
    /// Envelope of the next SectionFrame as JSON, or <c>""</c> when none is waiting.
    /// The page pairs it with <see cref="TakeSectionBytes"/>, which is what dequeues.
    /// </summary>
    [JSExport]
    public static string PeekSectionHeader() => s_client?.PeekSectionHeader() ?? string.Empty;

    /// <summary>
    /// Dequeues the next SectionFrame's bytes: 32-byte <c>payloadSha256</c> followed
    /// by the Section payload. Neither half is interpreted here — the page copies
    /// them into the VoxelEngine Rust wasm instance and the Rust world is what
    /// decodes the Section (ADR-078 决策 1 / 决策 3).
    /// </summary>
    [JSExport]
    public static byte[] TakeSectionBytes() => s_client?.TakeSectionBytes() ?? Array.Empty<byte>();

    [JSExport]
    public static string WorldInstanceId()
    {
        // Bound from the server Welcome: stable across entity joins and bot
        // reconnects during a probe, unlike any per-entity frame key.
        return s_client?.World is null ? string.Empty : s_client.World.InstanceId.ToString("x16", System.Globalization.CultureInfo.InvariantCulture);
    }

    [JSExport]
    public static void IssueSelfMove()
    {
        if (s_client?.World is null || !s_client.InputEnabled) return;
        try
        {
            if (s_moveSequence == 0UL)
            {
                try
                {
                    s_rng = SpectatorDump.MixSeed(s_client.World.Self.Id.ToHex());
                }
                catch (InvalidOperationException)
                {
                    s_rng = 1u;
                }
            }

            SpectatorDump.IssueSelfMove(s_client.World, ref s_moveSequence, ref s_rng);
        }
        catch (Exception)
        {
            // Welcome/self/AbilityComponent not ready yet; dump still paints.
        }
    }

    [JSExport]
    public static string TakeOutbound()
    {
        return s_client?.TakeOutbound() ?? "[]";
    }
}


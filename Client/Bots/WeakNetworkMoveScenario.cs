using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Diagnostics.Metrics;
using System.Globalization;
using System.IO;
using Lumio.Client.Bot;
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay;

namespace Lumio.Sample.Bots;

/// <summary>Movement-only probe. Timing comes from the Bot's real connection Meter, not Issue success.</summary>
public sealed class WeakNetworkMoveScenario : BotScenario
{
    private static readonly string[] Capabilities = { WireCodec.ServerRpc };
    private ulong _sequence;
    private long _nextSend;
    private uint _random = 0x9e3779b9;

    /// <summary>Install the listener before the host constructs and dials its sessions.</summary>
    public WeakNetworkMoveScenario() => WeakNetworkMeasurements.Start();

    /// <inheritdoc />
    public override IReadOnlyList<string> RequiredCapabilities => Capabilities;

    /// <inheritdoc />
    public override void Setup(in BotDriverContext context)
    {
        foreach (char value in context.World.Self.NetEntityId) _random = (_random ^ value) * 16777619;
        _nextSend = Stopwatch.GetTimestamp() + (long)((_random % 250) * (Stopwatch.Frequency / 1000d));
    }

    /// <inheritdoc />
    public override BotStepResult Step(in BotDriverContext context)
    {
        long now = Stopwatch.GetTimestamp();
        if (!context.World.HasSelf || now < _nextSend) return BotStepResult.Continue;
        _nextSend = now + Stopwatch.Frequency / 4; // Same approximately 4 Hz movement load as R-00588.
        _random ^= _random << 13;
        _random ^= _random >> 17;
        _random ^= _random << 5;
        (int dx, int dz) = (_random % 4) switch { 0 => (1, 0), 1 => (-1, 0), 2 => (0, 1), _ => (0, -1) };
        var payload = new List<object?>();
        new MoveAbility.Input { Dx = dx, Dz = dz }.Write(payload);
        var words = new string[payload.Count];
        for (int i = 0; i < words.Length; i++) words[i] = Convert.ToString(payload[i], CultureInfo.InvariantCulture) ?? string.Empty;
        context.Issue(BotIssuedCommand.Activate(nameof(MoveAbility), words, ++_sequence));
        return BotStepResult.Continue;
    }
}

internal static class WeakNetworkMeasurements
{
    private static readonly object Gate = new();
    private static MeterListener? _listener;
    private static StreamWriter? _writer;

    internal static void Start()
    {
        lock (Gate)
        {
            if (_listener is not null) return;
            string? directory = Environment.GetEnvironmentVariable("LUMIO_WEAKNET_METRICS_DIR");
            if (string.IsNullOrWhiteSpace(directory)) throw new InvalidOperationException("LUMIO_WEAKNET_METRICS_DIR is required for the measurement scenario.");
            Directory.CreateDirectory(directory);
            _writer = new StreamWriter(Path.Combine(directory, $"metrics-{Environment.ProcessId}.csv"), append: false);
            _writer.WriteLine("metric,account,generation,unix_ms,sequence,applied_sequence,authority_tick,state,value");
            _writer.AutoFlush = true;
            _listener = new MeterListener
            {
                InstrumentPublished = (instrument, listener) =>
                {
                    if (instrument.Meter.Name == "Lumio.Client.Bot.Network") listener.EnableMeasurementEvents(instrument);
                },
            };
            _listener.SetMeasurementEventCallback<double>(Record);
            _listener.Start();
        }
    }

    private static void Record(Instrument instrument, double value, ReadOnlySpan<KeyValuePair<string, object?>> tags, object? state)
    {
        _ = state;
        string account = "", generation = "", time = "", sequence = "", applied = "", tick = "", session = "";
        foreach (KeyValuePair<string, object?> tag in tags)
        {
            string text = Convert.ToString(tag.Value, CultureInfo.InvariantCulture) ?? string.Empty;
            switch (tag.Key)
            {
                case "account": account = text; break;
                case "generation": generation = text; break;
                case "unix_ms": time = text; break;
                case "sequence": sequence = text; break;
                case "applied_sequence": applied = text; break;
                case "authority_tick": tick = text; break;
                case "state": session = text; break;
            }
        }
        lock (Gate)
        {
            _writer!.WriteLine(string.Join(',', Csv(instrument.Name), Csv(account), generation, time, sequence, applied, tick, Csv(session), value.ToString("R", CultureInfo.InvariantCulture)));
        }
    }

    private static string Csv(string text) => "\"" + text.Replace("\"", "\"\"", StringComparison.Ordinal) + "\"";
}

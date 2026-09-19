using System;
using System.Diagnostics;
using System.Reflection;
using System.Runtime.CompilerServices;
using Lumio.GameRuntime.Simulation.Tick;

namespace Lumio.Sample.Client.Chat.Tests;

internal sealed class TestTickClock : ITickMonotonicClock
{
    // Runtime deliberately restricts clock injection to its friend test assemblies.
    // This fixture uses the same test-only seam as Client's retained pipeline tests.
    [ModuleInitializer]
    internal static void Install() => typeof(TickClockResolver)
        .GetMethod("InstallTestFallback", BindingFlags.Static | BindingFlags.NonPublic)!
        .Invoke(null, new object[] { new TestTickClock() });

    public ulong NowNanos() => (ulong)((UInt128)(ulong)Stopwatch.GetTimestamp() * 1_000_000_000UL / (ulong)Stopwatch.Frequency);
}

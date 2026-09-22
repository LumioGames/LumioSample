using System;
using System.Runtime.CompilerServices;
using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay;

/// <summary>Associates a host writer with one world without owning its Native resources.</summary>
public static class SampleVoxelWriterBinding
{
    private static readonly ConditionalWeakTable<WorldManager, Lease> Bindings = new();
    private static readonly object Gate = new();

    /// <summary>Replaces the manager's writer. Disposing an older lease cannot remove its replacement.</summary>
    [System.Diagnostics.CodeAnalysis.SuppressMessage("Design", "CA1510", Justification = "Keep netstandard2.1 compatibility.")]
    public static IDisposable Bind(WorldManager manager, ISampleVoxelWriter writer)
    {
        if (manager is null) throw new ArgumentNullException(nameof(manager));
        if (writer is null) throw new ArgumentNullException(nameof(writer));
        manager.EnsureOwnerAccess();
        var lease = new Lease(manager, writer);
        lock (Gate)
        {
            Bindings.Remove(manager);
            Bindings.Add(manager, lease);
        }
        return lease;
    }

    internal static ISampleVoxelWriter? Resolve(WorldManager manager)
    {
        manager.EnsureOwnerAccess();
        lock (Gate)
            return Bindings.TryGetValue(manager, out Lease? lease) ? lease.Writer : null;
    }

    private sealed class Lease(WorldManager manager, ISampleVoxelWriter writer) : IDisposable
    {
        private WorldManager? _manager = manager;
        internal ISampleVoxelWriter? Writer { get; private set; } = writer;

        public void Dispose()
        {
            // Host cleanup can follow manager disposal and must only detach this lease's binding.
            lock (Gate)
            {
                if (_manager is null) return;
                if (Bindings.TryGetValue(_manager, out Lease? current) && ReferenceEquals(current, this))
                    Bindings.Remove(_manager);
                Writer = null;
                _manager = null;
            }
        }
    }
}

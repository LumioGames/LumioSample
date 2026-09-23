using System;
using System.Collections.Generic;
using Lumio.Client.Gameplay.ECS;
using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Client.Chat
{
    /// <summary>Owner-thread presentation hooks; Client owns commit and lifecycle admission.</summary>
    public sealed class ChatRpcAdapter : IReplicaRpcPreflight, IReplicaRpcObserver, IDisposable
    {
        private readonly List<ChatLine> _lines = new List<ChatLine>();
        private Action<ChatLine>? _onLine;
        private ulong _message;
        private ulong _sequence;
        private string? _lastError;
        private bool _disposed;

        public ChatRpcAdapter(Action<ChatLine>? onLine = null) => _onLine = onLine;

        public ChatPresentation CopySnapshot() => new ChatPresentation(_lines.ToArray(), _message, _sequence, _lastError);

        public bool TryValidate(in ReplicaRpcContext context, in ReplicaRpcView rpc, out string rejectCode)
        {
            bool valid = !ChatRpcIdentity.Matches(rpc.ComponentId, rpc.Method) ||
                (rpc.Scope == Scope.Room && rpc.ArgumentCount == 1 && rpc.Target == rpc.Sender &&
                 rpc.Sender != default && rpc.MessageId != 0 && rpc.RoomSequence != 0);
            rejectCode = valid ? string.Empty : "bad_envelope";
            return valid;
        }

        public void OnCommitted(in ReplicaRpcContext context, in ReplicaRpcView rpc)
        {
            if (_disposed || !ChatRpcIdentity.Matches(rpc.ComponentId, rpc.Method)) return;
            if (rpc.MessageId <= _message || rpc.RoomSequence <= _sequence)
            {
                _lastError = "chat_cursor_not_advancing";
                return;
            }

            // Consume both cursors before append or user code: exceptions cannot replay a line.
            _message = rpc.MessageId;
            _sequence = rpc.RoomSequence;
            var line = new ChatLine(rpc.MessageId, rpc.RoomSequence, rpc.Sender, rpc.GetArgument(0), rpc.AppliedTick);
            _lines.Add(line);
            try { _onLine?.Invoke(line); }
            catch
            {
                _lastError = "chat_callback_failed";
                throw; // Client isolates each callback and preserves its Applied receipt.
            }
        }

        public void OnReset(in ReplicaRpcContext context, ReplicaRpcResetReason reason)
        {
            if (!_disposed && (reason == ReplicaRpcResetReason.FullSnapshot || reason == ReplicaRpcResetReason.NewSession)) Clear();
        }

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            _onLine = null;
            Clear();
        }

        private void Clear()
        {
            _lines.Clear();
            _message = 0;
            _sequence = 0;
            _lastError = null;
        }
    }
}

using System;
using Lumio.Client.Gameplay.ECS;
using Lumio.Sample.Gameplay;

namespace Lumio.Sample.Client.Chat
{
    /// <summary>One replica and fresh adapter, composed before the first authority stage.</summary>
    public sealed class ChatConsumer : IDisposable
    {
        private readonly ChatRpcAdapter _adapter;

        private ChatConsumer(IClientReplica replica, ChatRpcAdapter adapter)
        {
            Replica = replica;
            _adapter = adapter;
        }

        public IClientReplica Replica { get; }
        public ChatPresentation CopySnapshot() => _adapter.CopySnapshot();

        public static ChatConsumer Create(IClientReplicaFactory factory, Action<ChatLine>? onLine = null)
        {
            if (factory == null) throw new ArgumentNullException(nameof(factory));
            var adapter = new ChatRpcAdapter(onLine);
            var hooks = new ReplicaRpcHooks(adapter, adapter);
            try { return new ChatConsumer(factory.Create(GeneratedRegistry.Instance, in hooks), adapter); }
            catch { adapter.Dispose(); throw; }
        }

        // Client detaches and disposes the hook at its safe point, including callback disposal
        // and retryable native cleanup. Do not mark this owner disposed before cleanup succeeds.
        public void Dispose() => Replica.Dispose();
    }
}

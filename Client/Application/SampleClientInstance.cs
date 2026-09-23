using System;
using System.Diagnostics.CodeAnalysis;
using System.Threading;
using System.Threading.Tasks;
using Lumio.Client.Application;
using Lumio.Client.Gameplay.Session;
using Lumio.Sample.Client.Chat;

namespace Lumio.Sample.Client.Application;

/// <summary>One Sample Application instance and its currently active chat presentation.</summary>
[SuppressMessage("Design", "CA1001:Types that own disposable fields should be disposable",
    Justification = "Client owns and disposes the adapter through ReplicaRpcHooks; this instance only reads its presentation.")]
public sealed class SampleClientInstance
{
    private readonly Action<ChatLine>? _onLine;
    private ChatRpcAdapter? _adapter;
    private ClientInstance? _client;

    internal SampleClientInstance(Action<ChatLine>? onLine)
    {
        _onLine = onLine;
    }

    internal Lumio.Client.Gameplay.ECS.ReplicaRpcHooks CreateHooks()
    {
        _adapter = new ChatRpcAdapter(_onLine);
        return new Lumio.Client.Gameplay.ECS.ReplicaRpcHooks(_adapter, _adapter);
    }

    internal void Attach(ClientInstance client) => _client = client;
    internal void Clear() => _adapter = null;
    public ClientInstance Client => _client ?? throw new InvalidOperationException("The Sample instance is not created.");
    public ChatPresentation CopyChatSnapshot() => _adapter?.CopySnapshot() ?? ChatPresentation.Empty;
    public SessionCommandResult Connect(CancellationToken cancellationToken = default) => Client.Connect(cancellationToken);
    public Task<ClientCloseResult> CloseAsync(CancellationToken cancellationToken = default) => Client.CloseAsync(cancellationToken);
}

using System;
using Lumio.Client.Application;
using Lumio.Sample.Client.Chat;
using Lumio.Sample.Gameplay;

namespace Lumio.Sample.Client.Application;

/// <summary>Sample-owned composition entry point for hosts using the Client Application API.</summary>
public sealed class SampleClientApplication
{
    private readonly ClientHost _host;

    public SampleClientApplication(ClientHost host)
    {
        _host = host ?? throw new ArgumentNullException(nameof(host));
    }

    public SampleClientInstance CreateInstance(ClientInstanceOptions options, Action<ChatLine>? onLine = null)
    {
        ArgumentNullException.ThrowIfNull(options);
        var instance = new SampleClientInstance(onLine);
        var composed = new ClientInstanceOptions
        {
            Registry = GeneratedRegistry.Instance,
            ConfigDirectory = options.ConfigDirectory,
            Endpoint = options.Endpoint,
            InputMapper = options.InputMapper,
            Connections = options.Connections,
            EndpointProvider = options.EndpointProvider,
            Capabilities = options.Capabilities,
            HandshakeFrames = options.HandshakeFrames,
            OutboundObserver = options.OutboundObserver,
            AllowWelcomeOnlyAdmission = options.AllowWelcomeOnlyAdmission,
            ReplicaRpcHooksFactory = instance.CreateHooks
        };
        try
        {
            instance.Attach(_host.CreateInstance(composed));
            return instance;
        }
        catch
        {
            instance.Clear();
            throw;
        }
    }
}

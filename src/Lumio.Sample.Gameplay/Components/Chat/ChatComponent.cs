using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay.Components.Chat;

/// <summary>Room chat. Shared declarations only; server and client bodies live in sibling files.</summary>
[EcsComponent]
public sealed partial class ChatComponent : Component
{
    /// <summary>Client-to-server speak intent. Mapping id is <c>chat.input</c>.</summary>
    [ServerRpc("chat.input")]
    public partial void SendMessage(string text);

    /// <summary>Server-to-room line. The payload is already <c>id: text</c>.</summary>
    [ClientRpc(Scope.Room)]
    public partial void OnChatMessage(string line);
}

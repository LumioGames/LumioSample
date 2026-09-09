using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay.Components.Chat;

[EcsComponent]
public sealed partial class ChatComponent : Component
{
    [ServerRpc("chat.input")]
    public partial void SendMessage(string text);

    [ClientRpc(Scope.Room)]
    public partial void OnChatMessage(string line);
}

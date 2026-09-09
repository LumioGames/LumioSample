using Lumio.GameRuntime.Ecs;
using Microsoft.Extensions.Logging;

namespace Lumio.Sample.Gameplay.Components.Chat;

public sealed partial class ChatComponent
{
    public void Say(string text)
    {
        Log.LogInformation("{Entity} says: {Text}", Entity.ToHex(), text);
        SendMessage(text);
    }

    public partial void OnChatMessage(string line) => Log.LogInformation("{Line}", line);
}

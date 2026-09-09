using Lumio.GameRuntime.Ecs;
using Microsoft.Extensions.Logging;

namespace Lumio.Sample.Gameplay.Components.Chat;

public sealed partial class ChatComponent
{
    /// <summary>Client convenience wrapper around <see cref="SendMessage"/>.</summary>
    public void Say(string text)
    {
        Log.LogInformation("{Entity} says: {Text}", Entity.ToHex(), text);
        SendMessage(text);
    }

    /// <inheritdoc />
    public partial void OnChatMessage(string line) => Log.LogInformation("{Line}", line);
}

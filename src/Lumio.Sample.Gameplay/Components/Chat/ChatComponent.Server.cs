using System.Text;
using Lumio.GameRuntime.Ecs;
using Microsoft.Extensions.Logging;

namespace Lumio.Sample.Gameplay.Components.Chat;

public sealed partial class ChatComponent
{
    /// <summary>Last spoken text. Persisted, not replicated.</summary>
    [Persist]
    public Sync<string> LastMessageText = new(Scope.None);

    /// <summary>Tick of <see cref="LastMessageText"/>.</summary>
    [Persist]
    public Sync<ulong> LastMessageTick = new(Scope.None);

    /// <inheritdoc />
    public partial void SendMessage(string text)
    {
        if (text.Length == 0) return;

        // 说话人用网络身份，不用 Identity.Name。512 是生成器给 chat.input 写死的 UTF-8 上限，不是玩法配表。
        string line = Entity.ToHex() + ": " + text;
        if (Encoding.UTF8.GetByteCount(line) > 512) return;

        Log.LogInformation("{Entity} says: {Text}", Entity.ToHex(), text);
        LastMessageText.Value = text;
        LastMessageTick.Value = World.Tick;
        OnChatMessage(line);
    }
}

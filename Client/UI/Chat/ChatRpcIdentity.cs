using System;
using Lumio.Sample.Gameplay.Components.Chat;

namespace Lumio.Sample.Client.Chat
{
    public static class ChatRpcIdentity
    {
        public const string ComponentId = nameof(ChatComponent);
        public const string Method = nameof(ChatComponent.OnChatMessage);

        public static bool Matches(string componentId, string method) =>
            string.Equals(componentId, ComponentId, StringComparison.Ordinal) &&
            string.Equals(method, Method, StringComparison.Ordinal);
    }
}

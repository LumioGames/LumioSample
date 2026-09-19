using System;
using System.Collections.Generic;

namespace Lumio.Sample.Client.Chat
{
    /// <summary>A copied, immutable view that remains valid after reset or disposal.</summary>
    public sealed class ChatPresentation
    {
        public static ChatPresentation Empty { get; } = new ChatPresentation(Array.Empty<ChatLine>(), 0, 0, null);
        internal ChatPresentation(ChatLine[] lines, ulong message, ulong sequence, string? error)
        {
            Lines = Array.AsReadOnly(lines);
            MessageHighWater = message;
            RoomSequenceHighWater = sequence;
            LastError = error;
        }

        public IReadOnlyList<ChatLine> Lines { get; }
        public ulong MessageHighWater { get; }
        public ulong RoomSequenceHighWater { get; }
        public string? LastError { get; }
    }
}

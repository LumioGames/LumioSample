using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Client.Chat
{
    public readonly struct ChatLine
    {
        internal ChatLine(ulong messageId, ulong roomSequence, NetEntityId sender, string text, ulong appliedTick)
        {
            MessageId = messageId;
            RoomSequence = roomSequence;
            Sender = sender;
            Text = text;
            AppliedTick = appliedTick;
        }

        public ulong MessageId { get; }
        public ulong RoomSequence { get; }
        public NetEntityId Sender { get; }
        public string Text { get; }
        public ulong AppliedTick { get; }
    }
}

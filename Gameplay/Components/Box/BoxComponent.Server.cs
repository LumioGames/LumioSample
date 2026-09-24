using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay.Components.Box;

public sealed partial class BoxComponent
{
    /// <summary>
    /// Opens the box for <paramref name="opener"/>: adding it to <see cref="Openers"/> is what
    /// triggers Runtime's own Claim granted resync (ADR-119 决策 6) — this method never writes
    /// <see cref="Inventory"/> or composes a wire message itself. A no-op if already open for it.
    /// </summary>
    public void Open(NetEntityId opener)
    {
        for (int i = 0; i < Openers.Count; i++)
            if (Openers[i] == opener) return;
        Openers.Add(opener);
    }

    /// <summary>Closes the box for <paramref name="opener"/>: removal triggers Claim revoked.</summary>
    public void Close(NetEntityId opener)
    {
        for (int i = 0; i < Openers.Count; i++)
        {
            if (Openers[i] != opener) continue;
            Openers.RemoveAt(i);
            return;
        }
    }
}

using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay.Components.Mining;

/// <summary>
/// The one unsettled dig its player owns, as persisted state on the player entity (R-00650).
/// A final hit only orders the terrain change and writes this record; the stamina debit, the zeroed
/// reserve and the drop order are paid on the frame that order's result comes back. That window
/// crosses a frame boundary, so a checkpoint may be taken inside it: the record therefore rides the
/// dynamic-entity snapshot at the same cut point as the voxel change layer it is waiting on
/// (save-load.md ①②), and is not process-only C# state.
/// Every field is <see cref="Scope.None"/>: server bookkeeping that is persisted and dirty-tracked
/// but never placed on the replication wire.
/// The slot is the bound. One player carries exactly one record, which is the same mutual exclusion
/// <c>SampleMiningComponent.CanMine</c> admits on, so an unsettled dig can never accumulate per player.
/// </summary>
[EcsComponent]
public sealed partial class PendingDigComponent : Component
{
    /// <summary>
    /// Unsettled digs one player may owe. It is the slot itself, and the same exclusion
    /// <c>SampleMiningComponent.CanMine</c> admits on, restated as the declared bound.
    /// </summary>
    public const int MaxPerPlayer = 1;

    /// <summary>
    /// Unsettled digs one world may hold before a further mining activation is refused. Records are
    /// bounded by the live player count already; this is the second, explicit ceiling so a world can
    /// never grow the set without bound. The authored sample map holds four veins, so play never
    /// reaches it — it exists to make the bound stated rather than incidental.
    /// </summary>
    public const int MaxPerWorld = 64;

    /// <summary>True while this player owes a settlement for <see cref="Transaction"/>.</summary>
    [Persist] public Sync<bool> Active = new(Scope.None);

    /// <summary>Terrain transaction id whose result settles this record.</summary>
    [Persist] public Sync<string> Transaction = new(Scope.None);

    /// <summary>Target vein as a net-entity hex string; the entity itself is gone once the dig publishes.</summary>
    [Persist] public Sync<string> VeinHex = new(Scope.None);

    /// <summary>Wire section key of the dug cell.</summary>
    [Persist] public Sync<ulong> SectionKey = new(Scope.None);

    /// <summary>Wire cell offset inside the section.</summary>
    [Persist] public Sync<int> CellOffset = new(Scope.None);

    /// <summary>Authored cell coordinates, kept so the drop lands on the cell center after a restore.</summary>
    [Persist] public Sync<int> CellX = new(Scope.None);

    /// <summary>Authored cell coordinates, kept so the drop lands on the cell center after a restore.</summary>
    [Persist] public Sync<int> CellY = new(Scope.None);

    /// <summary>Authored cell coordinates, kept so the drop lands on the cell center after a restore.</summary>
    [Persist] public Sync<int> CellZ = new(Scope.None);

    /// <summary>Ore the settlement drops. Snapshotted when the dig is ordered, not re-read at settlement.</summary>
    [Persist] public Sync<int> Amount = new(Scope.None);

    /// <summary>
    /// Stamina the settlement debits, snapshotted when the dig is ordered. Persisted as the sign-extended
    /// UInt64 encoding of the <c>long</c> cost, the same round trip <c>IPersistWriter.WriteInt32</c> documents.
    /// </summary>
    [Persist] public Sync<ulong> StaminaCost = new(Scope.None);

    /// <summary>Staging order, so two records settled in one frame land deterministically.</summary>
    [Persist] public Sync<ulong> Serial = new(Scope.None);

    /// <summary>Center of the dug cell; the drop spawns here whether or not the vein still exists.</summary>
    public System.Numerics.Vector3 CellCenter => new(CellX.Value + 0.5f, CellY.Value + 0.5f, CellZ.Value + 0.5f);
}

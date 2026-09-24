using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay.Components.Vein;

/// <summary>Remaining hits on a vein entity. Shared so both compile sides see Remaining.</summary>
[EcsComponent]
public sealed partial class VeinReserveComponent : Component
{
    // 储量只活在实体上。体素格子不得再存一份剩余次数。
    // VeinEntity 是方块实体（ADR-119）：字段不得用 Scope.Room，Aoi 即「持有该 Section 的连接」。
    /// <summary>Hits left before the vein is exhausted.</summary>
    [Persist]
    public Sync<int> Remaining = new(Scope.Aoi);

    [Persist] public Sync<bool> HasCell = new(Scope.Aoi);
    [Persist] public Sync<ulong> SectionKey = new(Scope.Aoi);
    [Persist] public Sync<int> CellOffset = new(Scope.Aoi);
    [Persist] public Sync<int> CellX = new(Scope.Aoi);
    [Persist] public Sync<int> CellY = new(Scope.Aoi);
    [Persist] public Sync<int> CellZ = new(Scope.Aoi);

    public System.Numerics.Vector3 CellCenter => new(CellX.Value + 0.5f, CellY.Value + 0.5f, CellZ.Value + 0.5f);
}

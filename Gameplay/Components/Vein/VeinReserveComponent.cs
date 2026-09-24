using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay.Components.Vein;

/// <summary>
/// Remaining hits on a vein block entity (ADR-119). The vein no longer carries its own cell
/// coordinates: a block entity's position is the binding table entry that points at it, and
/// nothing else (<c>block-entity.md</c> §4 B1/B4: "位置只有一个来源：绑定表"). Both sides locate
/// a live vein through <c>SampleMiningComponent</c>'s scan-time binding bookkeeping, never
/// through a field on this component.
/// </summary>
[EcsComponent]
public sealed partial class VeinReserveComponent : Component
{
    // 储量只活在实体上。体素格子不得再存一份剩余次数，实体上也不得再存一份格子坐标（ADR-119）。
    // Remaining 是「画」的字段（block-entity.md §4 B1/B3：名字、是否上锁一类），可见性只跟 Section
    // 订阅表走：BlockEntityAttribute 生成器拒绝方块实体组件字段用 Scope.Room / Scope.Owner
    // （BLOCK005 / BLOCK006），只准 Aoi / Claim / None。
    /// <summary>Hits left before the vein is exhausted. Drawn: every observer holding the vein's Section sees it.</summary>
    [Persist]
    public Sync<int> Remaining = new(Scope.Aoi);
}

using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay.Components.Fx;

/// <summary>Local-only spark marker. Not replicated and not persisted.</summary>
[EcsComponent]
public sealed partial class MiningSparkComponent : Component
{
}

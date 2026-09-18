namespace Lumio.Sample.Gameplay.Components.Ore;

/// <summary>Server-side ore pile body. Amount lives on the shared declaration.</summary>
public sealed partial class OrePileComponent
{
    internal System.Numerics.Vector3 SpawnPosition { get; set; }

    protected override void Start() => SampleGameplay.PlaceDrop(World, Entity, SpawnPosition);
}

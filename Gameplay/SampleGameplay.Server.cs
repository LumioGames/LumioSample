using System.Numerics;
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Config;

namespace Lumio.Sample.Gameplay;

public static partial class SampleGameplay
{
    /// <summary>
    /// The admission pose, from the server map row (<c>map.spawn_x/y/z</c>, B-00121): each base map
    /// names its own, because a DS running another map points <c>config_dir</c> at that map's
    /// profile export (<c>Server/Config/Profiles/&lt;name&gt;</c>). The default <c>sample.voxel</c> row
    /// keeps the pose it always had — capture floor y=0 with a one-cell wall at y=1, so
    /// (16.5, 1.5, 16.5) is the interior cell above the floor, which keeps the movement AABB clear
    /// and the floor ore within the configured three-dimensional mining reach. Default
    /// LogicTransform is the origin, which SweepBox cannot answer without sealing the DS.
    /// MoveAbility is the sole writer; this is the admission pose, not a step.
    /// </summary>
    internal static Vector3 AdmittedPlayerPosition(World world)
    {
        MapRow map = SampleConfigBinding.For(world).Map;
        return new Vector3((float)map.SpawnX, (float)map.SpawnY, (float)map.SpawnZ);
    }

    static partial void PlaceAdmittedPlayer(World world, NetEntityId player)
    {
        LogicTransform logic = world.Get<LogicTransform>(player);
        if (logic.LocalPosition != Vector3.Zero) return;
        TransformController controller = world.RegisterTransformController(player, nameof(MoveAbility));
        using (logic.BeginWrite(controller))
            logic.SetLocalPosition(AdmittedPlayerPosition(world));
    }
}

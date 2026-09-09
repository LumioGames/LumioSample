using System.Collections.Generic;
using System.Globalization;
using System.Numerics;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.Sample.Gameplay.Config;

namespace Lumio.Sample.Gameplay;

/// <summary>
/// Sole writer of player LogicTransform. Speed and sweep radius come from config files,
/// not from literals in this type.
/// </summary>
[AbilityType(1u, Prediction = PredictionKind.LogicPredict)]
public sealed class MoveAbility : AbilityType<MoveAbility.Input>
{
    public const uint TypeId = 1u;

    public struct Input : IAbilityInput
    {
        public int Dx;
        public int Dz;

        public void Write(IList<object?> args)
        {
            args.Add(Dx.ToString(CultureInfo.InvariantCulture));
            args.Add(Dz.ToString(CultureInfo.InvariantCulture));
        }

        public bool TryRead(IReadOnlyList<object?> args, int start)
        {
            if (args is null || start < 0 || start + 1 >= args.Count) return false;
            if (!int.TryParse(args[start]?.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out int dx))
                return false;
            if (!int.TryParse(args[start + 1]?.ToString(), NumberStyles.Integer, CultureInfo.InvariantCulture, out int dz))
                return false;
            Dx = dx;
            Dz = dz;
            return true;
        }
    }

    public static void Register() => AbilityTypeCatalog.Register<MoveAbility, Input>(TypeId);

    public override bool CanActivate(in Input input) => input.Dx != 0 || input.Dz != 0;

    /// <summary>
    /// Applies a sweep result without knowing voxels. A missing physics port is empty space,
    /// not a second collision engine.
    /// </summary>
    public static Vector3 ResolveMove(Vector3 origin, Vector3 displacement, bool collided, float travelFraction)
    {
        if (!collided) return origin + displacement;
        return origin + (displacement * travelFraction);
    }

    public override void Execute(in Input input, AbilityComponent owner)
    {
        float step = (float)SampleTables.StepMeters;
        float radius = (float)SampleTables.SweepRadiusMeters;
        LogicTransform logic = owner.Get<LogicTransform>();
        Vector3 origin = logic.LocalPosition;
        Vector3 displacement = new(input.Dx * step, 0f, input.Dz * step);

        bool collided = false;
        float travelFraction = 1f;
        if (owner.Physics is IAbilityPhysicsPort physics)
        {
            AbilitySweepHit hit = physics.Sweep(origin, displacement, radius);
            collided = hit.Collided;
            travelFraction = hit.TravelFraction;
        }

        Vector3 next = ResolveMove(origin, displacement, collided, travelFraction);
        TransformController controller = owner.World.RegisterTransformController(owner.Entity, nameof(MoveAbility));
        using (logic.BeginWrite(controller))
        {
            logic.SetLocalPosition(next);
        }
    }
}

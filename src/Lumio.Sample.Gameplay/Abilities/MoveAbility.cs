using System;
using System.Collections.Generic;
using System.Globalization;
using System.Numerics;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;
using Lumio.Sample.Gameplay.Config;

namespace Lumio.Sample.Gameplay;

/// <summary>
/// Sole writer of player LogicTransform. Speed and sweep radius come from config files,
/// not from literals in this type. Shared by both sides: prediction stays on GAS
/// (<see cref="PredictionKind.LogicPredict"/>), not a server-only path.
/// </summary>
[AbilityType(1u, Prediction = PredictionKind.LogicPredict)]
public sealed class MoveAbility : AbilityType<MoveAbility.Input>
{
    /// <summary>Stable ability type id. Must stay <c>1</c>.</summary>
    public const uint TypeId = 1u;

    /// <summary>
    /// One grid cell per activate. Larger integers are a teleport (unbounded
    /// <see cref="Input.Dx"/> / <see cref="Input.Dz"/>), not a longer walk.
    /// </summary>
    public const int MaxAbsStep = 1;

    /// <summary>Grid step on XZ. Stationary and oversize intents are rejected in <see cref="CanActivate"/>.</summary>
    public struct Input : IAbilityInput
    {
        /// <summary>Signed step on X. Absolute value must be at most <see cref="MaxAbsStep"/>.</summary>
        public int Dx;
        /// <summary>Signed step on Z. Absolute value must be at most <see cref="MaxAbsStep"/>.</summary>
        public int Dz;

        /// <inheritdoc />
        public void Write(IList<object?> args)
        {
            args.Add(Dx.ToString(CultureInfo.InvariantCulture));
            args.Add(Dz.ToString(CultureInfo.InvariantCulture));
        }

        /// <inheritdoc />
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

    /// <summary>Registers this type on the GAS catalog.</summary>
    public static void Register() => AbilityTypeCatalog.Register<MoveAbility, Input>(TypeId);

    /// <inheritdoc />
    public override bool CanActivate(in Input input) => IsAdmittedStep(input.Dx, input.Dz);

    /// <summary>True when the intent is a non-zero step of at most one cell on each axis.</summary>
    public static bool IsAdmittedStep(int dx, int dz) =>
        (dx != 0 || dz != 0) && WithinAbs(dx, MaxAbsStep) && WithinAbs(dz, MaxAbsStep);

    /// <summary>
    /// Applies a sweep result without knowing voxels. Callers must already have
    /// admitted the step and a finite sweep; this method does not invent a port.
    /// </summary>
    public static Vector3 ResolveMove(Vector3 origin, Vector3 displacement, bool collided, float travelFraction)
    {
        if (!collided) return origin + displacement;
        return origin + (displacement * travelFraction);
    }

    /// <summary>
    /// Fail-closed admission used by <see cref="Execute"/>. A missing port, a failed
    /// sweep, or a non-finite / out-of-range travel fraction leaves <paramref name="next"/>
    /// at <paramref name="origin"/>.
    /// </summary>
    public static bool TryAdmitMove(
        in Input input,
        Vector3 origin,
        float stepMeters,
        bool hasPhysicsPort,
        bool sweepOk,
        bool collided,
        float travelFraction,
        out Vector3 next)
    {
        next = origin;
        if (!IsAdmittedStep(input.Dx, input.Dz)) return false;
        if (!hasPhysicsPort || !sweepOk) return false;
        if (!float.IsFinite(travelFraction) || travelFraction < 0f || travelFraction > 1f) return false;
        Vector3 displacement = new(input.Dx * stepMeters, 0f, input.Dz * stepMeters);
        next = ResolveMove(origin, displacement, collided, travelFraction);
        return true;
    }

    /// <inheritdoc />
    public override void Execute(in Input input, AbilityComponent owner)
    {
        float step = (float)SampleTables.StepMeters;
        float radius = (float)SampleTables.SweepRadiusMeters;
        LogicTransform logic = owner.Get<LogicTransform>();
        Vector3 origin = logic.LocalPosition;

        bool hasPhysicsPort = false;
        bool sweepOk = false;
        bool collided = false;
        float travelFraction = 1f;
        if (owner.Physics is IAbilityPhysicsPort physics)
        {
            hasPhysicsPort = true;
            Vector3 displacement = new(input.Dx * step, 0f, input.Dz * step);
            try
            {
                AbilitySweepHit hit = physics.Sweep(origin, displacement, radius);
                sweepOk = true;
                collided = hit.Collided;
                travelFraction = hit.TravelFraction;
            }
            catch (Exception)
            {
                sweepOk = false;
            }
        }

        if (!TryAdmitMove(input, origin, step, hasPhysicsPort, sweepOk, collided, travelFraction, out Vector3 next))
            return;

        TransformController controller = owner.World.RegisterTransformController(owner.Entity, nameof(MoveAbility));
        using (logic.BeginWrite(controller))
        {
            logic.SetLocalPosition(next);
        }
    }

    /// <summary>
    /// Inclusive absolute bound that does not call <see cref="Math.Abs(int)"/>, so
    /// <see cref="int.MinValue"/> cannot overflow into a false admit.
    /// </summary>
    private static bool WithinAbs(int value, int max) => value <= max && value >= -max;
}

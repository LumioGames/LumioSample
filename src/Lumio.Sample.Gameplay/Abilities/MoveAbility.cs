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

    private AbilityComponent? _preparedOwner;
    private Input _preparedInput;
    private Vector3 _preparedPosition;
    private ulong _preparedTick;

    /// <summary>
    /// One grid cell per activate. Larger integers are a teleport (unbounded
    /// <see cref="Input.Dx"/> / <see cref="Input.Dz"/>), not a longer walk.
    /// </summary>
    public const int MaxAbsStep = 1;

    /// <summary>Grid step on XZ. Stationary and oversize intents are rejected during admission.</summary>
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
    /// Pure admission helper. A missing port, a failed
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
    public override bool CanActivate(in Input input, AbilityComponent owner, out string? failureCode)
    {
        _preparedOwner = null;
        failureCode = null;
        if (!CanActivate(in input))
        {
            failureCode = "can_activate_rejected";
            return false;
        }
        if (owner.Physics is not IAbilityPhysicsPort physics)
        {
            failureCode = "physics_unavailable";
            return false;
        }
        float step = (float)SampleConfigBinding.For(owner.World).Movement.StepMeters;
        // The existing configured radius is explicitly the half-size on each AABB axis.
        float radius = (float)SampleConfigBinding.For(owner.World).Movement.SweepRadiusMeters;
        LogicTransform logic = owner.Get<LogicTransform>();
        Vector3 origin = logic.LocalPosition;
        Vector3 displacement = new(input.Dx * step, 0f, input.Dz * step);
        if (!IsFinite(origin) || !IsFinite(displacement) || !float.IsFinite(radius) || radius <= 0f)
        {
            failureCode = "physics_invalid_query";
            return false;
        }

        // GAS step 5 translates only AbilityPhysicsRejectedException to a refusal.
        // Unknown exceptions and corrupt return values retain their fault diagnostics.
        AbilitySweepHit hit = physics.SweepBox(origin, displacement, new Vector3(radius));
        if (!float.IsFinite(hit.TravelFraction) || hit.TravelFraction < 0f || hit.TravelFraction > 1f
            || (!hit.Collided && hit.TravelFraction != 1f) || !IsFinite(hit.Point))
            throw new InvalidOperationException("MoveAbility received a corrupt AABB sweep result.");
        Vector3 next = ResolveMove(origin, displacement, hit.Collided, hit.TravelFraction);
        if (!IsFinite(next) || hit.Point != next)
            throw new InvalidOperationException("MoveAbility received an inconsistent AABB sweep point.");

        _preparedInput = input;
        _preparedPosition = next;
        _preparedTick = owner.World.Tick;
        _preparedOwner = owner;
        return true;
    }

    /// <inheritdoc />
    public override void Execute(in Input input, AbilityComponent owner)
    {
        AbilityComponent? preparedOwner = _preparedOwner;
        _preparedOwner = null; // Consume even on contract failure; never reuse a prepared write.
        if (!ReferenceEquals(preparedOwner, owner) || _preparedTick != owner.World.Tick
            || input.Dx != _preparedInput.Dx || input.Dz != _preparedInput.Dz)
            throw new InvalidOperationException("MoveAbility.Execute requires this activation's successful admission.");

        LogicTransform logic = owner.Get<LogicTransform>();
        TransformController controller = owner.World.RegisterTransformController(owner.Entity, nameof(MoveAbility));
        using (logic.BeginWrite(controller))
        {
            logic.SetLocalPosition(_preparedPosition);
        }
    }

    private static bool IsFinite(Vector3 value) =>
        float.IsFinite(value.X) && float.IsFinite(value.Y) && float.IsFinite(value.Z);

    /// <summary>
    /// Inclusive absolute bound that does not call <see cref="Math.Abs(int)"/>, so
    /// <see cref="int.MinValue"/> cannot overflow into a false admit.
    /// </summary>
    private static bool WithinAbs(int value, int max) => value <= max && value >= -max;
}

using Lumio.GameRuntime.Coordination;
using Lumio.GameRuntime.Ecs;
using Lumio.Sample.Gameplay.Components.Vein;

namespace Lumio.Sample.Gameplay;

public sealed partial class MineAbility
{
    /// <summary>
    /// The client's local admission and prediction. Both degrade to "admit and wait for the
    /// authority" (never locally refuse, never locally order a dig) because a predicting client has
    /// no way to resolve a vein's Section/cell from its bare <see cref="NetEntityId"/> any more
    /// (ADR-119: the committed binding-table read, <see cref="HostVoxelWorldAdapter.TryReadSectionBindings"/>,
    /// is Authority-only, and this side's own <see cref="SampleMiningComponent"/> never runs the scan
    /// that would populate a location cache — see <see cref="SampleMiningComponent.TryLocate"/>).
    /// </summary>
    /// <remarks>
    /// This is a real, documented regression from pre-ADR-119 behavior: the ability's own doc comment
    /// (<c>Prediction = PredictionKind.LogicPredict</c>) and ADR-106 §1 call for the same
    /// <see cref="Execute"/> to change real terrain and collision on both sides at once. Today it can
    /// only do that on the authority — the hole a client-side miner sees appears one round trip later
    /// than before, on the authority's own published WorldChange. The underlying gap (no
    /// client-reachable reverse cell lookup for a block entity) is an upstream Runtime capability this
    /// card does not own; it is reported in the PR / hand-off, not silently patched over here.
    /// </remarks>
    static partial void CheckBinding(AbilityComponent owner, VeinReserveComponent reserve, ref bool bound)
    {
        _ = owner;
        _ = reserve;
        bound = true; // Server.CanMine is the real gate; a local refusal here would stop the input from ever reaching it.
    }

    static partial void OrderFinalDig(AbilityComponent owner, VeinReserveComponent reserve, ref bool ordered)
    {
        _ = owner;
        _ = reserve;
        ordered = false; // Nothing to predict locally; MineAbility.Server.cs orders it once the authority processes the input.
    }
}

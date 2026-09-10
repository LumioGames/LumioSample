using System.Collections.Generic;
using System.Globalization;
using Lumio.GameRuntime.Ecs;
using Lumio.GameRuntime.Gas;

namespace Lumio.Sample.Gameplay;

/// <summary>
/// Decrements vein reserve on the bound entity. Voxel cell writes and M6a bind are
/// engine slots that are not public yet (R-00469); this ability does not invent them.
/// </summary>
[AbilityType(2u, Prediction = PredictionKind.AuthorityOnly)]
public sealed partial class MineAbility : AbilityType<MineAbility.Input>
{
    /// <summary>Stable ability type id. Must stay <c>2</c>.</summary>
    public const uint TypeId = 2u;

    /// <summary>Target vein as a net-entity hex string.</summary>
    public struct Input : IAbilityInput
    {
        /// <summary>Vein entity id in hex.</summary>
        public string TargetHex;

        /// <inheritdoc />
        public void Write(IList<object?> args) => args.Add(TargetHex);

        /// <inheritdoc />
        public bool TryRead(IReadOnlyList<object?> args, int start)
        {
            if (args is null || start < 0 || start >= args.Count) return false;
            string? value = args[start]?.ToString();
            if (string.IsNullOrWhiteSpace(value)) return false;
            TargetHex = value;
            return true;
        }
    }

    /// <summary>Registers this type on the GAS catalog.</summary>
    public static void Register() => AbilityTypeCatalog.Register<MineAbility, Input>(TypeId);

    /// <inheritdoc />
    public override bool CanActivate(in Input input) => NetEntityId.TryParse(input.TargetHex, out _);

    /// <inheritdoc />
    public override void Execute(in Input input, AbilityComponent owner) => ExecuteCore(in input, owner);

    static partial void ExecuteCore(in Input input, AbilityComponent owner);

    /// <summary>Always false until the engine exposes capture/write-cell. Callers must not treat this as a miss.</summary>
    public static bool TryRequestAirWrite(NetEntityId veinId)
    {
        _ = veinId;
        return false;
    }
}

using System;
using System.Collections.Generic;
using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay.Config;

/// <summary>
/// ADR-090 seed: gameplay supplies initials from <c>config/attributes.json</c>.
/// Runtime asks the provider during the normal PostAttribute lifecycle.
/// </summary>
public static class SampleAttributeSeed
{
    internal static IAttributeSeedProvider Provider { get; } = new TableProvider();

    private sealed class TableProvider : IAttributeSeedProvider
    {
        public bool TryGetSeedValue(Type entityType, string attributeName, out long seedValue)
        {
            _ = entityType;
            return TryGetInitial(attributeName, out seedValue);
        }
    }
    /// <summary>The two named ledgers. Each expands to Base + Current (four books).</summary>
    public static IReadOnlyList<string> DeclaredNames => new[]
    {
        SampleTables.StaminaAttributeName,
        SampleTables.OreAttributeName
    };

    /// <summary>Engine-shaped ask: name in, initial out. Unknown name is a hard miss, not zero.</summary>
    public static bool TryGetInitial(string attributeName, out long value)
    {
        if (string.Equals(attributeName, SampleTables.StaminaAttributeName, StringComparison.Ordinal))
        {
            value = SampleTables.StaminaInitial;
            return true;
        }

        if (string.Equals(attributeName, SampleTables.OreAttributeName, StringComparison.Ordinal))
        {
            value = SampleTables.OreInitial;
            return true;
        }

        value = 0;
        return false;
    }

}

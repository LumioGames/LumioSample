using System;
using System.Collections.Generic;
using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay.Config;

/// <summary>
/// ADR-090 seed: gameplay supplies initials from <c>config/attributes.json</c>.
/// Engine <c>IAttributeSeed</c> / PostAttribute ask (R-00468 G1) is not in the public package yet.
/// </summary>
public static class SampleAttributeSeed
{
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

    /// <summary>Creates both named ledgers and writes Base and Current from the table.</summary>
    public static void ApplyTo(AttributeComponent attributes)
    {
        ArgumentNullException.ThrowIfNull(attributes);
        if (!TryGetInitial(SampleTables.StaminaAttributeName, out long stamina))
            throw new InvalidOperationException("SampleAttributeSeed has no stamina initial.");
        if (!TryGetInitial(SampleTables.OreAttributeName, out long ore))
            throw new InvalidOperationException("SampleAttributeSeed has no ore initial.");

        attributes.SetBaseValue(SampleTables.StaminaAttributeName, stamina);
        attributes.SetCurrentValue(SampleTables.StaminaAttributeName, stamina);
        attributes.SetBaseValue(SampleTables.OreAttributeName, ore);
        attributes.SetCurrentValue(SampleTables.OreAttributeName, ore);
    }

    /// <summary>Reserved for R-00468 G1 <c>IAttributeSeed</c> registration. No-op until that type ships.</summary>
    public static void Register()
    {
    }
}

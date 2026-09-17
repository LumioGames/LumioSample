using System;
using System.Collections.Generic;
using System.Linq;
using Lumio.GameRuntime.Config;
using Lumio.GameRuntime.Ecs;

namespace Lumio.Sample.Gameplay.Config;

public interface ISampleConfig : IWorldGameplayConfig
{
    MiningRow Mining { get; }
    MovementRow Movement { get; }
    MapRow Map { get; }
    AttributesRow Stamina { get; }
    AttributesRow Ore { get; }
}

public sealed class SampleConfigBinding : IGameConfigExportBinding
{
    private sealed class Settings(MiningRow mining, MovementRow movement, MapRow map, AttributesRow stamina, AttributesRow ore) : ISampleConfig, IAttributeSeedProvider
    {
        public MiningRow Mining => mining;
        public MovementRow Movement => movement;
        public MapRow Map => map;
        public AttributesRow Stamina => stamina;
        public AttributesRow Ore => ore;
        public bool TryGetSeedValue(Type entityType, string attributeName, out long seedValue)
        {
            seedValue = attributeName == stamina.Name ? stamina.Initial : ore.Initial;
            return attributeName == stamina.Name || attributeName == ore.Name;
        }
    }

    public RegistrySide Side => GeneratedRegistry.Instance.Side;
    public Type RequiredGameplayContract => typeof(ISampleConfig);
    public IReadOnlyList<string> RequiredTables { get; } = Array.AsReadOnly(new[] { "mining", "movement", "attributes", "map" });
    public ITypedTableSet CreateTypedTables(ConfigTarget target, IReadOnlyList<ConfigSnapshotTable> tables)
    {
        if (target != SampleConfigProjection.Target) throw new ArgumentException("Sample config target does not match registry side.", nameof(target));
        return SampleTypedTables.Create(target, tables);
    }
    public IWorldGameplayConfig Project(IConfigSnapshotView snapshot)
    {
        if (!snapshot.TryGetTable<MiningTable>(out var mining) || !snapshot.TryGetTable<MovementTable>(out var movement)
            || !snapshot.TryGetTable<AttributesTable>(out var attributes) || !snapshot.TryGetTable<MapTable>(out var map))
            throw new InvalidOperationException("Sample typed tables are missing.");
        return new Settings(mining.Rows.Single(), movement.Rows.Single(), map.Rows.Single(),
            attributes.Rows.Single(row => row.Name == "Stamina"), attributes.Rows.Single(row => row.Name == "Ore"));
    }
    public void BindWorld(World world) => world.SeedProvider = (IAttributeSeedProvider)world.GameplayConfig!;

    public static ISampleConfig For(World world) => world.GameplayConfig as ISampleConfig
        ?? throw new InvalidOperationException("Sample world requires its gameplay config binding.");

    public static WorldConfigBinding Load(string? directory = null)
    {
        var entry = new SampleConfigBinding();
        var result = LumioConfigLoader.Load(SampleTables.ResolveDirectory(directory), SampleConfigProjection.Target,
            requiredTables: entry.RequiredTables, typedTableFactory: entry.CreateTypedTables);
        if (!result.IsSuccess) throw new InvalidOperationException(result.ErrorMessage);
        var module = ConfigModule.Create();
        if (!module.Stage(result.CreateSnapshot(new ConfigSnapshotId(1))).Staged || !module.ActivateAtBarrier(default).Activated)
            throw new InvalidOperationException("Sample config activation failed.");
        return new WorldConfigBinding(module, GeneratedRegistry.Instance, entry);
    }
}

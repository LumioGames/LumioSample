using System;
using System.Collections;
using System.IO;
using System.Reflection;
using System.Text.Json;
using Xunit;

namespace Lumio.Sample.Server.HostTests;

/// <summary>
/// After Admit, a Sample registry world must contain a live PlayerEntity plus
/// LogicTransform.
///
/// ADR-115 §3 / R-00692: these two cases used to live in LumioServer as
/// <c>SampleAdmitSpawnTests</c>. An engine test may not reach back into one game,
/// so they moved to the game workspace. What they assert is still the
/// <em>engine's</em> guarantee, not the game's, and each of those assertions is
/// kept verbatim:
///
/// <list type="number">
/// <item>the catalog bytes the host retains are a defensive copy, and mutating
/// the caller's array afterwards changes nothing;</item>
/// <item>a corrupted voxel half makes restore refuse, and the live
/// <c>Manager</c> identity does not change;</item>
/// <item>after a successful restore the <c>IngressBudget</c> object identity is
/// preserved while <c>Manager</c> is a new instance;</item>
/// <item><c>ActivationContextFactory</c> answers non-null for
/// <c>MineAbility</c> and null for <c>MoveAbility</c> / <c>PickupAbility</c>;</item>
/// <item>a <c>runtime-only</c> snapshot carries no <c>voxelBase64</c>;</item>
/// <item><c>Physics</c> is present exactly when the world profile is
/// <c>runtime+voxel</c>.</item>
/// </list>
///
/// HostEntry is one process-scoped Default ALC, so both cases carry
/// <c>[Trait("Isolation", "Process")]</c> and <c>Tools/test-server-host.mjs</c>
/// runs each of them in its own process — the same contract LumioServer's
/// <c>Tools/test-host-entry.mjs</c> <c>isolatedCases</c> manifest enforced.
/// </summary>
public sealed class SampleAdmitSpawnTests : IDisposable
{
    public SampleAdmitSpawnTests() => ShutdownHost();

    private readonly string? _configDirectory = Environment.GetEnvironmentVariable("LUMIO_CONFIG_DIR");

    public void Dispose()
    {
        try { ShutdownHost(); }
        finally { Environment.SetEnvironmentVariable("LUMIO_CONFIG_DIR", _configDirectory); }
    }

    private static void ShutdownHost()
    {
        JsonElement result = HostEntryBridge.Send("{\"op\":\"shutdown\"}", out string raw);
        Assert.True(result.GetProperty("ok").GetBoolean(), raw);
    }

    /// <summary>
    /// ADR-119 (SH/R-00733): the fixed admission-baseline region this boot request used to carry is
    /// retired — first delivery and release are now driven entirely by Runtime's per-connection Section
    /// subscription table (taken every tick), not by a Section box named at boot. Sending the old
    /// <c>voxelBaselineRegion</c> field here would now be rejected as an unknown/retired field.
    /// </summary>
    private const string VoxelProfileFields = ",\"worldProfile\":\"runtime+voxel\"";

    // ADR-123: the named three-path is the release's SDK/Managed, the set HostEntry was built with.
    private static (string Replication, string Ecs) RequireRuntime() => (
        Lumio.Sample.Tests.EngineRelease.Require(Lumio.Sample.Tests.EngineRelease.ReplicationAssembly, "the host wires Runtime from the named three-path"),
        Lumio.Sample.Tests.EngineRelease.Require(Lumio.Sample.Tests.EngineRelease.EcsAssembly, "the host wires Runtime from the named three-path"));

    private static string RequireSampleGameplayDll() => HostEntryBridge.Require(
        "LUMIO_SAMPLE_GAMEPLAY_DLL",
        "this run's freshly built Sample gameplay assembly; missing artifacts are not a passing combination");

    private static JsonElement Boot(string replication, string ecs, string registry, out string raw,
        bool voxel, string? catalog, string config, string? voxelSnapshot)
    {
        string request = "{\"op\":\"boot\",\"kernelConfig\":" + KernelConfigurationFixture.Json +
            ",\"replicationAssembly\":" + JsonSerializer.Serialize(replication) +
            ",\"ecsAssembly\":" + JsonSerializer.Serialize(ecs) +
            ",\"registryAssembly\":" + JsonSerializer.Serialize(registry) +
            ",\"configDir\":" + JsonSerializer.Serialize(config) +
            (voxel ? VoxelProfileFields : ",\"worldProfile\":\"runtime-only\"") +
            (catalog is null ? "" : ",\"voxelCatalogBase64\":" + JsonSerializer.Serialize(catalog)) +
            (voxelSnapshot is null ? "" : ",\"voxelSnapshotBase64\":" + JsonSerializer.Serialize(voxelSnapshot)) + "}";
        return HostEntryBridge.Send(request, out raw);
    }

    [Fact]
    [Trait("Isolation", "Process")]
    public void AdmitOnSampleRegistryRuntimeOnly() => AdmitOnSampleRegistryLeavesALivePlayerEntityWithLogicTransform(false);

    [Fact]
    [Trait("Isolation", "Process")]
    public void AdmitOnSampleRegistryWithVoxel() => AdmitOnSampleRegistryLeavesALivePlayerEntityWithLogicTransform(true);

    private static void AdmitOnSampleRegistryLeavesALivePlayerEntityWithLogicTransform(bool voxel)
    {
        (string replication, string ecs) = RequireRuntime();
        string sample = RequireSampleGameplayDll();
        string config = HostEntryBridge.Require("LUMIO_CONFIG_DIR",
            "Sample requires its matching per-end config export (Server/Config/Tables)");

        // HostEntry is one process-scoped Default ALC. Sample's own bin/ carries
        // a second copy of Runtime assemblies; LoadFrom of that path after a
        // Username boot throws FileLoadException. Stage the gameplay dll next
        // to the same three-path this suite already loaded.
        string staging = StageSampleBesideRuntime(sample, replication);
        try
        {
            string stagedSample = Path.Combine(staging, "Lumio.Sample.Gameplay.dll");
            string? fixture = voxel ? HostEntryBridge.Path("LUMIO_TEST_VOXEL_FIXTURE_DIR") : null;
            if (voxel)
            {
                Assert.True(!string.IsNullOrEmpty(fixture),
                    "LUMIO_TEST_VOXEL_FIXTURE_DIR is required: a real matching catalog/world fixture directory "
                    + "(catalog-world.json + catalog-world.capture) authored against this run's native image");
            }
            byte[]? catalogBytes = voxel ? File.ReadAllBytes(Path.Combine(fixture!, "catalog-world.json")) : null;
            string? catalog = voxel ? " \t" + Convert.ToBase64String(catalogBytes!) + "\r\n" : null;
            string? voxelSnapshot = voxel ? Convert.ToBase64String(File.ReadAllBytes(Path.Combine(fixture!, "catalog-world.capture"))) : null;
            JsonElement booted = Boot(replication, ecs, stagedSample, out string bootRaw, voxel, catalog, config, voxelSnapshot);
            Assert.True(booted.GetProperty("ok").GetBoolean(), bootRaw);
            if (voxel)
            {
                byte[] retainedCopy = HostEntryBridge.ReadCatalogCopy();
                Assert.Equal(catalogBytes, retainedCopy);
                retainedCopy[0] ^= 0xff;
                Assert.Equal(catalogBytes, HostEntryBridge.ReadCatalogCopy());
            }

            ulong before = HostEntryBridge.ReadWorldTick();

            JsonElement enqueued = HostEntryBridge.Send(
                "{\"op\":\"enqueue\",\"messageType\":\"AdmitConnectionMessage\",\"connection\":\"c-sample-1\",\"accountId\":\"acct-sample-1\",\"roomId\":\"room-a\",\"entityType\":\"PlayerEntity\"}",
                out string enqueueRaw);
            Assert.True(enqueued.GetProperty("ok").GetBoolean(), enqueueRaw);
            Assert.Equal(before, HostEntryBridge.ReadWorldTick());

            JsonElement ticked = HostEntryBridge.Send("{\"op\":\"tick\"}", out string tickRaw);
            Assert.True(ticked.GetProperty("ok").GetBoolean(), tickRaw);
            Assert.Equal(before + 1, ticked.GetProperty("appliedTick").GetUInt64());

            AssertLivePlayerWithLogicTransform("acct-sample-1");
            object attributes = SampleComponent("acct-sample-1", "AttributeComponent");
            object manager = HostEntryBridge.ReadManager();
            object world = manager.GetType().GetProperty("World")!.GetValue(manager)!;
            object gameplayConfig = world.GetType().GetProperty("GameplayConfig")!.GetValue(world)!;
            Type configContract = Assembly.LoadFrom(stagedSample).GetType("Lumio.Sample.Gameplay.Config.ISampleConfig")!;
            object staminaRow = configContract.GetProperty("Stamina")!.GetValue(gameplayConfig)!;
            string stamina = (string)staminaRow.GetType().GetProperty("Name")!.GetValue(staminaRow)!;
            attributes.GetType().GetMethod("SetBaseValue")!.Invoke(attributes, new object[] { stamina, 37L });
            JsonElement snapshot = HostEntryBridge.Send("{\"op\":\"snapshot\"}", out string snapshotRaw);
            Assert.True(snapshot.GetProperty("ok").GetBoolean(), snapshotRaw);
            var restoreRequest = new System.Collections.Generic.Dictionary<string, object?> {
                ["op"] = "restore", ["registryAssembly"] = stagedSample, ["roomId"] = "room-a",
                ["bytesBase64"] = snapshot.GetProperty("bytesBase64").GetString(),
            };
            if (voxel) restoreRequest["voxelBase64"] = snapshot.GetProperty("voxelBase64").GetString();
            else Assert.False(snapshot.TryGetProperty("voxelBase64", out _));
            object oldManager = HostEntryBridge.ReadManager();
            object oldBudget = oldManager.GetType().GetProperty("IngressBudget")!.GetValue(oldManager)!;
            if (voxel)
            {
                object? validVoxel = restoreRequest["voxelBase64"];
                restoreRequest["voxelBase64"] = "AQ==";
                JsonElement refused = HostEntryBridge.Send(JsonSerializer.Serialize(restoreRequest), out string refusedRaw);
                Assert.False(refused.GetProperty("ok").GetBoolean(), refusedRaw);
                Assert.Same(oldManager, HostEntryBridge.ReadManager());
                Assert.Equal(catalogBytes, HostEntryBridge.ReadCatalogCopy());
                restoreRequest["voxelBase64"] = validVoxel;
            }
            JsonElement restored = HostEntryBridge.Send(JsonSerializer.Serialize(restoreRequest), out string restoreRaw);
            Assert.True(restored.GetProperty("ok").GetBoolean(), restoreRaw);
            Assert.NotSame(oldManager, HostEntryBridge.ReadManager());
            if (voxel)
            {
                Assert.Same(oldBudget, HostEntryBridge.ReadManager().GetType().GetProperty("IngressBudget")!.GetValue(HostEntryBridge.ReadManager()));
                Assert.Equal(catalogBytes, HostEntryBridge.ReadCatalogCopy());
            }
            object hydratedAttributes = SampleComponent("acct-sample-1", "AttributeComponent");
            Assert.Equal(37L, (long)hydratedAttributes.GetType().GetMethod("GetBaseValue")!.Invoke(hydratedAttributes, new object[] { stamina })!);
            object ability = SampleComponent("acct-sample-1", "AbilityComponent");
            Delegate contextFactory = Assert.IsAssignableFrom<Delegate>(
                ability.GetType().GetProperty("ActivationContextFactory")!.GetValue(ability));
            Assembly gameplay = Assembly.LoadFrom(stagedSample);
            Assert.NotNull(contextFactory.DynamicInvoke(gameplay.GetType("Lumio.Sample.Gameplay.MineAbility")!));
            Assert.Null(contextFactory.DynamicInvoke(gameplay.GetType("Lumio.Sample.Gameplay.MoveAbility")!));
            Assert.Null(contextFactory.DynamicInvoke(gameplay.GetType("Lumio.Sample.Gameplay.PickupAbility")!));
            if (voxel) Assert.NotNull(ability.GetType().GetProperty("Physics")!.GetValue(ability));
            else Assert.Null(ability.GetType().GetProperty("Physics")!.GetValue(ability));
            Assert.True(HostEntryBridge.Send("{\"op\":\"tick\"}", out tickRaw).GetProperty("ok").GetBoolean(), tickRaw);
        }
        finally
        {
            try { Directory.Delete(staging, recursive: true); }
            catch (IOException) { }
            catch (UnauthorizedAccessException) { }
        }
    }

    /// <summary>
    /// Copy SampleGameplay.dll into a temp directory that already has the
    /// Runtime siblings from the named three-path, so LoadFrom does not pick
    /// a second MVID of Command/Ecs/Replication.
    /// </summary>
    private static string StageSampleBesideRuntime(string sampleDll, string replication)
    {
        string staging = Path.Combine(Path.GetTempPath(), "lumio-sample-admit-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(staging);
        string runtimeDir = Path.GetDirectoryName(replication)!;
        foreach (string file in Directory.GetFiles(runtimeDir, "*.dll"))
            File.Copy(file, Path.Combine(staging, Path.GetFileName(file)), overwrite: true);
        File.Copy(sampleDll, Path.Combine(staging, "Lumio.Sample.Gameplay.dll"), overwrite: true);
        return staging;
    }

    private static object SampleComponent(string accountId, string name)
    {
        object manager = HostEntryBridge.ReadManager();
        object world = manager.GetType().GetProperty("World")!.GetValue(manager)!;
        MethodInfo account = world.GetType().GetMethod("TryGetAccount")!;
        Type idType = account.GetParameters()[1].ParameterType;
        object?[] arguments = { accountId, Activator.CreateInstance(idType.IsByRef ? idType.GetElementType()! : idType) };
        Assert.True((bool)account.Invoke(world, arguments)!);
        return world.GetType().GetMethod("NamedComponent")!.Invoke(world, new[] { arguments[1], name })!;
    }

    private static void AssertLivePlayerWithLogicTransform(string accountId)
    {
        object manager = HostEntryBridge.ReadManager();
        object world = manager.GetType().GetProperty("World")!.GetValue(manager)!;
        Type worldType = world.GetType();
        MethodInfo tryGetAccount = worldType.GetMethod("TryGetAccount")
            ?? throw new MissingMethodException(worldType.FullName, "TryGetAccount");
        object[] tryGet = new object[2];
        tryGet[0] = accountId;
        Type idType = tryGetAccount.GetParameters()[1].ParameterType;
        tryGet[1] = Activator.CreateInstance(idType.IsByRef ? idType.GetElementType()! : idType)!;
        bool found = (bool)tryGetAccount.Invoke(world, tryGet)!;
        Assert.True(found, "TryGetAccount must find the admitted Sample player " + accountId);
        object accountEntity = tryGet[1];
        Assert.False((bool)accountEntity.GetType().GetProperty("IsDefault")!.GetValue(accountEntity)!);

        object issued = worldType.GetProperty("IssuedIds")!.GetValue(world)!;
        object? playerId = null;
        object? playerType = null;
        MethodInfo typeOf = worldType.GetMethod("TypeOf")!;
        foreach (object id in (IEnumerable)issued)
        {
            object typeRef = typeOf.Invoke(world, new[] { id })!;
            Type clr = (Type)typeRef.GetType().GetProperty("ClrType")!.GetValue(typeRef)!;
            if (string.Equals(clr.Name, "PlayerEntity", StringComparison.Ordinal)
                || string.Equals(clr.FullName, "Lumio.Sample.Gameplay.EntityTypes.PlayerEntity", StringComparison.Ordinal))
            {
                playerId = id;
                playerType = clr;
                break;
            }
        }
        Assert.NotNull(playerId);
        Assert.NotNull(playerType);

        MethodInfo named = worldType.GetMethod("NamedComponent")!;
        object? transform = named.Invoke(world, new[] { playerId, "LogicTransform" });
        Assert.NotNull(transform);
        Assert.Equal("LogicTransform", transform!.GetType().Name);
    }
}

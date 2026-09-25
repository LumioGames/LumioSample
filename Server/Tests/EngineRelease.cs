using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace Lumio.Sample.Tests;

/// <summary>
/// ADR-123: every engine binary a test runs against comes from the <c>Engine/</c> submodule
/// (LumioEngineRelease pinned at a release tag) — the same release the build restored
/// <c>Lumio.Engine.SDK</c> from. No environment variable names an engine artefact, and there is
/// no sibling checkout to fall back to. A missing input is a named failure, never a skip.
/// Compiled into both Sample test projects (Tools/*.Tests csproj link this file).
/// </summary>
internal static class EngineRelease
{
    internal const string InitCommand = "git submodule update --init --depth 1 Engine";

    internal static string RepoRoot { get; } = FindRepoRoot();

    internal static string Root => Path.Combine(RepoRoot, "Engine");

    /// <summary>This process's runtime identifier, spelled the way the release names platforms.</summary>
    internal static string Rid => RuntimeInformation.RuntimeIdentifier;

    internal static string Server => Path.Combine(Root, "server", Rid);

    internal static string NativeLibrary => Path.Combine(Server, "SDK", "Native", Rid, NativeFileName);

    internal static string HostEntry => Path.Combine(Server, "Application", "Lumio.Server.HostEntry.dll");

    internal static string ReplicationAssembly => Path.Combine(Server, "SDK", "Managed", "Lumio.GameRuntime.Replication.dll");

    internal static string EcsAssembly => Path.Combine(Server, "SDK", "Managed", "Lumio.GameRuntime.Ecs.dll");

    /// <summary>
    /// The catalog world authored against this release's own native image (catalog-world.json,
    /// catalog-world.capture, catalog-world-evidence.json). An engine test input shipped with the
    /// release; requested of the release pipeline by R-00779 (ADR-117 决策 2: run-time
    /// consumption of an engine-produced input, never a compile-time reference).
    /// </summary>
    internal static string CatalogWorldFixture => Path.Combine(Root, "tools", "fixtures", "catalog-world");

    internal static string Require(string path, string why)
    {
        if (!File.Exists(path) && !Directory.Exists(path))
        {
            throw new InvalidOperationException(
                $"ENGINE_RELEASE_INPUT_MISSING: {path} ({why}). Engine/ is the LumioEngineRelease submodule; "
                + $"fill it with `{InitCommand}`, and make sure its manifest lists {Rid}.");
        }
        return path;
    }

    /// <summary>build-info.json beside the release native: the identity the loader checks.</summary>
    internal static (string BuildId, string AbiHash, string BinarySha256) NativeBuildInfo()
    {
        string sidecar = Require(Path.Combine(Path.GetDirectoryName(NativeLibrary)!, "build-info.json"),
            "the release native's identity sidecar");
        using JsonDocument document = JsonDocument.Parse(File.ReadAllText(sidecar));
        JsonElement root = document.RootElement;
        return (root.GetProperty("buildId").GetString()!, root.GetProperty("abiHash").GetString()!,
            root.GetProperty("binarySha256").GetString()!);
    }

    private static string NativeFileName =>
        OperatingSystem.IsWindows() ? "lumio_engine_native.dll"
        : OperatingSystem.IsMacOS() ? "liblumio_engine_native.dylib"
        : "liblumio_engine_native.so";

    private static string FindRepoRoot()
    {
        for (DirectoryInfo? directory = new(AppContext.BaseDirectory); directory is not null; directory = directory.Parent)
        {
            if (File.Exists(Path.Combine(directory.FullName, "LumioSample.slnx"))) return directory.FullName;
        }
        throw new InvalidOperationException($"LumioSample.slnx not found above {AppContext.BaseDirectory}");
    }
}

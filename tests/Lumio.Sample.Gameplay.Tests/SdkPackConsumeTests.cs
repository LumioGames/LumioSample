using System;
using System.Diagnostics;
using System.IO;
using Xunit;

namespace Lumio.Sample.Gameplay.Tests
{
    public sealed class SdkPackConsumeTests
    {
        private static string RepoRoot =>
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));

        [Fact]
        public void GameplayBuildFailsWithoutAnEnginePath()
        {
            string isolatedPackages = Path.Combine(Path.GetTempPath(), "lumio-sdk-test-" + Guid.NewGuid().ToString("N"));
            string isolatedIntermediate = Path.Combine(isolatedPackages, "obj");
            Directory.CreateDirectory(isolatedPackages);

            try
            {
                var start = new ProcessStartInfo
                {
                    FileName = "dotnet",
                    WorkingDirectory = RepoRoot,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                };
                start.ArgumentList.Add("build");
                start.ArgumentList.Add(Path.Combine("src", "Lumio.Sample.Gameplay", "Lumio.Sample.Gameplay.csproj"));
                start.ArgumentList.Add("--nologo");
                start.ArgumentList.Add("-p:LumioRuntimeRoot=");
                start.ArgumentList.Add("-p:LumioLocalFeed=");
                start.ArgumentList.Add($"-p:NuGetPackageRoot={isolatedPackages}");
                start.ArgumentList.Add($"-p:RestoreSources={isolatedPackages}");
                start.ArgumentList.Add($"-p:BaseIntermediateOutputPath={isolatedIntermediate}{Path.DirectorySeparatorChar}");
                start.ArgumentList.Add($"-p:NuGetLockFilePath={Path.Combine(isolatedIntermediate, "packages.lock.json")}");
                start.Environment.Remove("LumioRuntimeRoot");
                start.Environment.Remove("LumioLocalFeed");

                using Process process = Process.Start(start)!;
                string output = process.StandardOutput.ReadToEnd();
                string error = process.StandardError.ReadToEnd();
                process.WaitForExit();

                Assert.NotEqual(0, process.ExitCode);
                Assert.Contains("LUMIO_SDK_UNRESOLVED", output + Environment.NewLine + error);
            }
            finally
            {
                Directory.Delete(isolatedPackages, recursive: true);
            }
        }

        [Fact]
        public void InvalidSiblingRuntimeDoesNotFallBackToAnSdkFeed()
        {
            string isolatedRoot = Path.Combine(Path.GetTempPath(), "lumio-sdk-invalid-runtime-" + Guid.NewGuid().ToString("N"));
            string isolatedPackages = Path.Combine(isolatedRoot, "packages");
            string isolatedFeed = Path.Combine(isolatedRoot, "feed");
            string isolatedIntermediate = Path.Combine(isolatedRoot, "obj");
            Directory.CreateDirectory(isolatedPackages);
            Directory.CreateDirectory(isolatedFeed);
            File.WriteAllBytes(Path.Combine(isolatedFeed, "Lumio.Engine.SDK.0.1.0.nupkg"), Array.Empty<byte>());

            try
            {
                var start = new ProcessStartInfo
                {
                    FileName = "dotnet",
                    WorkingDirectory = RepoRoot,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    UseShellExecute = false,
                };
                start.ArgumentList.Add("build");
                start.ArgumentList.Add(Path.Combine("src", "Lumio.Sample.Gameplay", "Lumio.Sample.Gameplay.csproj"));
                start.ArgumentList.Add("--nologo");
                start.ArgumentList.Add("-p:LumioRuntimeRoot=" + Path.Combine(isolatedRoot, "missing-runtime"));
                start.ArgumentList.Add("-p:LumioLocalFeed=" + isolatedFeed);
                start.ArgumentList.Add($"-p:NuGetPackageRoot={isolatedPackages}");
                start.ArgumentList.Add($"-p:RestoreSources={isolatedPackages}");
                start.ArgumentList.Add($"-p:BaseIntermediateOutputPath={isolatedIntermediate}{Path.DirectorySeparatorChar}");
                start.ArgumentList.Add($"-p:NuGetLockFilePath={Path.Combine(isolatedIntermediate, "packages.lock.json")}");
                start.Environment.Remove("LumioRuntimeRoot");
                start.Environment.Remove("LumioLocalFeed");

                using Process process = Process.Start(start)!;
                string output = process.StandardOutput.ReadToEnd();
                string error = process.StandardError.ReadToEnd();
                process.WaitForExit();

                Assert.NotEqual(0, process.ExitCode);
                Assert.Contains("LUMIO_SDK_UNRESOLVED", output + Environment.NewLine + error);
            }
            finally
            {
                Directory.Delete(isolatedRoot, recursive: true);
            }
        }

        [Fact]
        public void CentralPackageManifestPinsTheEngineSdkVersion()
        {
            string props = File.ReadAllText(Path.Combine(RepoRoot, "Directory.Packages.props"));
            Assert.Contains("PackageVersion Include=\"Lumio.Engine.SDK\" Version=\"0.1.0\"", props);
        }

        [Fact]
        public void SiblingRuntimePathProvidesBothRuntimeProjectReferences()
        {
            string targets = File.ReadAllText(Path.Combine(RepoRoot, "Directory.Build.targets"));
            Assert.Contains("Lumio.GameRuntime.Ecs.csproj", targets);
            Assert.Contains("Lumio.GameRuntime.Replication.csproj", targets);
            Assert.Contains("PackageReference Include=\"Lumio.Engine.SDK\"", targets);
            Assert.Contains("Condition=\"'$(LumioSdkMode)' == ''\"", targets);
        }
    }
}

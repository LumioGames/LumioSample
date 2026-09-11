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
            string isolatedRoot = Path.Combine(Path.GetTempPath(), "lumio-sdk-test-" + Guid.NewGuid().ToString("N"));
            try
            {
                string output = RunResolveLumioSdk(isolatedRoot, runtimeRoot: Path.Combine(isolatedRoot, "no-runtime"), localFeed: "");
                Assert.Contains("LUMIO_SDK_UNRESOLVED", output);
            }
            finally
            {
                Directory.Delete(isolatedRoot, recursive: true);
            }
        }

        [Fact]
        public void InvalidSiblingRuntimeDoesNotFallBackToAnSdkFeed()
        {
            string isolatedRoot = Path.Combine(Path.GetTempPath(), "lumio-sdk-invalid-runtime-" + Guid.NewGuid().ToString("N"));
            string isolatedFeed = Path.Combine(isolatedRoot, "feed");
            try
            {
                Directory.CreateDirectory(isolatedFeed);
                File.WriteAllBytes(Path.Combine(isolatedFeed, "Lumio.Engine.SDK.0.1.0.nupkg"), Array.Empty<byte>());
                string output = RunResolveLumioSdk(
                    isolatedRoot,
                    runtimeRoot: Path.Combine(isolatedRoot, "missing-runtime"),
                    localFeed: isolatedFeed);
                Assert.Contains("LUMIO_SDK_UNRESOLVED", output);
            }
            finally
            {
                Directory.Delete(isolatedRoot, recursive: true);
            }
        }

        /// <summary>
        /// Hits the shipped <c>ResolveLumioSdk</c> target without a NuGet restore.
        /// Isolated RestoreSources used to fail restore of Logging.Abstractions first,
        /// so the gate never ran and the log was only restore text. This helper uses
        /// <c>eng/ResolveLumioSdk.proj</c> so sibling auto-detect cannot hide the miss.
        /// </summary>
        private static string RunResolveLumioSdk(string isolatedRoot, string runtimeRoot, string localFeed)
        {
            Directory.CreateDirectory(isolatedRoot);
            var start = new ProcessStartInfo
            {
                FileName = "dotnet",
                WorkingDirectory = RepoRoot,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
            };
            start.ArgumentList.Add("msbuild");
            start.ArgumentList.Add(Path.Combine("eng", "ResolveLumioSdk.proj"));
            start.ArgumentList.Add("-nologo");
            start.ArgumentList.Add("-restore:false");
            start.ArgumentList.Add("-t:ResolveLumioSdk");
            start.ArgumentList.Add("-p:LumioRuntimeRoot=" + runtimeRoot);
            start.ArgumentList.Add("-p:LumioLocalFeed=" + localFeed);
            start.ArgumentList.Add("-p:NuGetPackageRoot=" + Path.Combine(isolatedRoot, "packages"));
            start.Environment["LumioRuntimeRoot"] = runtimeRoot;
            start.Environment["LumioLocalFeed"] = localFeed;

            using Process process = Process.Start(start)!;
            string output = process.StandardOutput.ReadToEnd();
            string error = process.StandardError.ReadToEnd();
            process.WaitForExit();

            Assert.NotEqual(0, process.ExitCode);
            return output + Environment.NewLine + error;
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
            Assert.Contains("Lumio.GameRuntime.Gas.csproj", targets);
            Assert.Contains("Lumio.GameRuntime.Simulation.csproj", targets);
            Assert.Contains("PackageReference Include=\"Lumio.Engine.SDK\"", targets);
            Assert.Contains("Condition=\"'$(LumioSdkMode)' == ''\"", targets);
        }

        [Fact]
        public void TestProjectDisablesEcsGeneration()
        {
            string targets = File.ReadAllText(Path.Combine(RepoRoot, "Directory.Build.targets"));
            string csproj = File.ReadAllText(Path.Combine(RepoRoot, "tests", "Lumio.Sample.Gameplay.Tests", "Lumio.Sample.Gameplay.Tests.csproj"));
            Assert.Contains("<LumioEcsGenerate>false</LumioEcsGenerate>", csproj);
            Assert.Contains("MSBuildProjectName)' == 'Lumio.Sample.Gameplay.Tests'", targets);
            Assert.Contains("<LumioEcsGenerate>false</LumioEcsGenerate>", targets);
        }
    }
}

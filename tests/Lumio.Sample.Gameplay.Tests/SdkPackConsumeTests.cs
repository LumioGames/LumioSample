using System;
using System.IO;
using Xunit;

namespace Lumio.Sample.Gameplay.Tests
{
    public sealed class SdkPackConsumeTests
    {
        private static string RepoRoot =>
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", "..", "..", ".."));

        [Fact]
        public void Gameplay工程不再列出netstandard21()
        {
            string csproj = File.ReadAllText(Path.Combine(RepoRoot, "src", "Lumio.Sample.Gameplay", "Lumio.Sample.Gameplay.csproj"));
            Assert.DoesNotContain("<TargetFrameworks>", csproj);
            Assert.DoesNotContain("net10.0;netstandard2.1", csproj);
            Assert.Contains("<TargetFramework>net10.0</TargetFramework>", csproj);
            Assert.DoesNotContain("PackageReference Include=\"Lumio.Engine.SDK\"", csproj);
        }

        [Fact]
        public void 中央包清单已预登记引擎SDK版本()
        {
            string props = File.ReadAllText(Path.Combine(RepoRoot, "Directory.Packages.props"));
            Assert.Contains("PackageVersion Include=\"Lumio.Engine.SDK\" Version=\"0.1.0\"", props);
        }
    }
}

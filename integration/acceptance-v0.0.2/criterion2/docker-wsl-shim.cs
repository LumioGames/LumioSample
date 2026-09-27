// docker.exe -> WSL docker forwarder (acceptance environment adapter, 2026-09-27).
// This machine has no Docker Desktop: the docker engine lives in WSL Ubuntu-24.04.
// The LumioSample launcher spawns `docker` with Windows absolute paths (compose -f,
// LUMIO_GAME_PLATFORM_DIR). This shim translates those to /mnt/<drive>/... and forwards
// to `wsl.exe -d Ubuntu-24.04 --exec docker ...`, passing exit code and stdio through.
// Env vars cross the WSL boundary via WSLENV: LUMIO_GAME_PLATFORM_DIR is flagged /p so
// WSL itself rewrites the Windows path.
using System;
using System.Diagnostics;
using System.Text;
using System.Text.RegularExpressions;

internal static class Program
{
    private static readonly Regex WindowsPath = new("^[A-Za-z]:[\\\\/].*$", RegexOptions.Compiled);
    private const string Forwarded = "LUMIO_PLATFORM_IMAGE:LUMIO_GAME_PLATFORM_DIR/p:LUMIO_PLATFORM_HOST_PORT:LUMIO_PLATFORM_COMPOSE_PROJECT";

    private static int Main(string[] args)
    {
        var argv = new StringBuilder();
        foreach (var arg in args)
        {
            var value = WindowsPath.IsMatch(arg) ? ToWslPath(arg) : arg;
            if (argv.Length > 0) argv.Append(' ');
            argv.Append(value.Replace(" ", "\\ "));
        }

        var existing = Environment.GetEnvironmentVariable("WSLENV") ?? "";
        Environment.SetEnvironmentVariable("WSLENV", string.IsNullOrEmpty(existing) ? Forwarded : existing + ":" + Forwarded);

        var info = new ProcessStartInfo
        {
            FileName = "wsl.exe",
            Arguments = "-d Ubuntu-24.04 --exec docker " + argv,
            UseShellExecute = false,
        };
        using var child = Process.Start(info);
        if (child is null) { Console.Error.WriteLine("docker-shim: failed to start wsl.exe"); return 127; }
        child.WaitForExit();
        return child.ExitCode;
    }

    private static string ToWslPath(string windowsPath)
    {
        var normalized = windowsPath.Replace('\\', '/');
        return "/mnt/" + char.ToLowerInvariant(normalized[0]) + normalized.Substring(2);
    }
}

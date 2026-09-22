// Explicit integration proof; builds real artifacts without writing sibling bin/obj.
// node Tools/verify-config-artifacts.mjs <fresh-artifact-root> [SDK-feed]
// Omit SDK-feed to exercise the public sibling build path.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
assert.ok(process.argv[2], 'Provide a fresh artifact root');
const artifacts = path.resolve(process.argv[2]);
assert.ok(!existsSync(artifacts), 'Use a fresh root so clean-output assertions are meaningful');
mkdirSync(artifacts, { recursive: true });
const feed = process.argv[3];
const properties = [`-p:ArtifactsPath=${path.join(artifacts, 'build')}`,
  ...(feed ? ['-p:LumioSdkMode=nuget', `-p:LumioRuntimeRoot=${path.join(artifacts, 'missing-runtime')}`,
    `-p:LumioLocalFeed=${path.resolve(feed)}`, `-p:RestorePackagesPath=${path.join(artifacts, 'packages')}`] : [])];
const project = 'Gameplay/Lumio.Sample.Gameplay.csproj';
function dotnet(args, log) {
  try {
    const output = execFileSync('dotnet', args, { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    writeFileSync(path.join(artifacts, `${log}.log`), output);
    return output;
  } catch (error) {
    writeFileSync(path.join(artifacts, `${log}.log`), `${error.stdout}\n${error.stderr}`);
    throw error;
  }
}
function files(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(path.join(dir, entry.name), `${prefix}${entry.name}/`) : [`${prefix}${entry.name}`]).sort();
}
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');

// A separate process per assembly avoids sharing the identical Client/Server assembly identity.
const probe = path.join(artifacts, 'probe');
mkdirSync(probe);
writeFileSync(path.join(probe, 'probe.csproj'), '<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><TargetFramework>net10.0</TargetFramework><OutputType>Exe</OutputType></PropertyGroup></Project>');
writeFileSync(path.join(probe, 'Program.cs'), `
using System;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json.Nodes;
var directory = Path.GetFullPath(args[0]);
AssemblyLoadContext.Default.Resolving += (_, name) => {
    var file = Path.Combine(directory, name.Name + ".dll");
    return File.Exists(file) ? AssemblyLoadContext.Default.LoadFromAssemblyPath(file) : null;
};
var assembly = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(directory, "Lumio.Sample.Gameplay.dll"));
var side = args[1] == "client" ? "Client" : "Server";
if (side == "Server") {
    var simulation = AssemblyLoadContext.Default.LoadFromAssemblyPath(Path.Combine(directory, "Lumio.GameRuntime.Simulation.dll"));
    if (!simulation.GetTypes().Any(t => t.Name == "DedicatedServerHostBinding"))
        throw new Exception("Server output lacks DedicatedServerHostBinding");
}
var readers = assembly.GetTypes().Where(t => t.Namespace?.StartsWith("Lumio.Config.Generated.", StringComparison.Ordinal) == true).ToArray();
if (readers.Length == 0 || readers.Any(t => t.Namespace != "Lumio.Config.Generated." + side))
    throw new Exception("Wrong configuration reader projection");
Console.WriteLine(string.Join("\\n", readers.Select(t => t.FullName)));
Environment.SetEnvironmentVariable("LUMIO_CONFIG_DIR", Path.Combine(directory, "config"));
var tables = assembly.GetType("Lumio.Sample.Gameplay.Config.SampleTables", true);
var reset = tables.GetMethod("ResetCache");
var value = tables.GetProperty("StaminaCost");
Console.WriteLine("Loaded StaminaCost=" + value.GetValue(null));
var fileToCorrupt = Path.Combine(directory, "config", args[1], "mining.json");
var original = File.ReadAllBytes(fileToCorrupt);
try {
    // Exercise the Runtime's existing fingerprint metadata check, without bypassing it.
    var changed = JsonNode.Parse(File.ReadAllText(fileToCorrupt));
    changed["contentFingerprint"] = "mismatched-fingerprint";
    File.WriteAllText(fileToCorrupt, changed.ToJsonString());
    reset.Invoke(null, null);
    try { value.GetValue(null); throw new Exception("Invalid table accepted"); }
    catch (TargetInvocationException e) when (e.InnerException is InvalidOperationException &&
        e.InnerException.Message.Contains("TABLE_CONTENT_FINGERPRINT_MISMATCH", StringComparison.Ordinal)) {
        Console.WriteLine("Mismatched fingerprint rejected: " + e.InnerException.Message);
    }
} finally { File.WriteAllBytes(fileToCorrupt, original); }
reset.Invoke(null, null);
Console.WriteLine("Restored StaminaCost=" + value.GetValue(null));
`);
dotnet(['build', path.join(probe, 'probe.csproj'), '--verbosity', 'minimal'], 'probe-build');

const identities = {};
for (const [index, side] of ['client', 'server', 'client', 'server'].entries()) {
  const args = [...properties, `-p:LumioEcsSide=${side}`];
  const evaluation = JSON.parse(dotnet(['msbuild', project, ...args,
    '-getProperty:LumioSdkMode,TargetDir,IntermediateOutputPath'], `${index}-${side}-evaluation`)).Properties;
  assert.equal(evaluation.LumioSdkMode, feed ? 'nuget' : 'sibling');
  dotnet(['build', project, ...args, '--verbosity', 'minimal'], `${index}-${side}-build`);
  const output = evaluation.TargetDir;
  assert.ok(path.resolve(output).startsWith(artifacts));
  const config = path.join(output, 'config');
  // ADR-115 / split-export/1: the whole per-end table root is copied verbatim,
  // so the output tree must equal that end's source tree byte for byte.
  const tables = path.join(root, side === 'client' ? 'Client' : 'Server', 'Config', 'Tables');
  const expected = files(tables);
  assert.deepEqual(files(config), expected);
  for (const file of expected) assert.equal(hash(path.join(config, file)), hash(path.join(tables, file)), file);
  dotnet([path.join(probe, 'bin/Debug/net10.0/probe.dll'), output, side], `${index}-${side}-probe`);
  const identity = hash(path.join(output, 'Lumio.Sample.Gameplay.dll'));
  if (identities[side]) assert.equal(identity, identities[side].sha256, 'Repeated side build changed assembly');
  identities[side] = { output, sha256: identity };
  console.log(`${index}: ${side} projection, actual reader types, loading and fingerprint-mismatch rejection passed`);
}
assert.notEqual(identities.client.output, identities.server.output);
writeFileSync(path.join(artifacts, 'identities.json'), JSON.stringify(identities, null, 2));
console.log(JSON.stringify(identities, null, 2));

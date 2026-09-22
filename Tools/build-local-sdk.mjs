import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const hash = path => createHash('sha512').update(readFileSync(path)).digest('base64');
const xml = value => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;');

export function readIdentity(path) {
  const identity = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
  if (identity.schemaVersion !== 1 || identity.packageId !== 'Lumio.Engine.SDK'
      || !/^\d+\.\d+\.\d+(?:-[0-9a-z]+(?:[.-][0-9a-z]+)*)?$/.test(identity.version)
      || typeof identity.nupkgPath !== 'string' || typeof identity.sha512 !== 'string') {
    throw new Error('sdk_identity_invalid');
  }
  if (basename(identity.nupkgPath).toLowerCase() !== `lumio.engine.sdk.${identity.version}.nupkg`
      || hash(identity.nupkgPath) !== identity.sha512) {
    throw new Error('sdk_package_identity_conflict');
  }
  return identity;
}

export function verifyAssets(path, identity) {
  const assets = JSON.parse(readFileSync(path, 'utf8'));
  const sdk = assets.libraries?.[`${identity.packageId}/${identity.version}`];
  if (sdk?.type !== 'package' || sdk.sha512 !== identity.sha512) {
    throw new Error('sdk_restored_identity_mismatch');
  }
  // The Sample test project may reference Sample gameplay; engine projects may not enter this proof.
  for (const [name, library] of Object.entries(assets.libraries)) {
    if (library.type === 'project' && !name.startsWith('Lumio.Sample.')) {
      throw new Error(`sdk_source_reference: ${name}`);
    }
  }
}

export function buildLocalSdk(identityPath, root = resolve(fileURLToPath(new URL('..', import.meta.url)))) {
  const identity = readIdentity(identityPath);
  const proof = mkdtempSync(join(tmpdir(), 'lumio-sample-sdk-'));
  const feed = join(proof, 'feed');
  const packages = join(proof, 'packages');
  const artifacts = join(proof, 'artifacts');
  mkdirSync(feed);
  const archive = join(feed, basename(identity.nupkgPath));
  copyFileSync(identity.nupkgPath, archive);
  if (hash(archive) !== identity.sha512) throw new Error('sdk_package_identity_conflict');
  const config = join(proof, 'NuGet.config');
  // Exact source mapping prevents a public or inherited feed from supplying a different SDK.
  writeFileSync(config, `<configuration>
  <packageSources><clear/><add key="local-sdk" value="${xml(feed)}"/>
    <add key="nuget.org" value="https://api.nuget.org/v3/index.json"/></packageSources>
  <packageSourceMapping><clear/><packageSource key="local-sdk"><package pattern="Lumio.Engine.SDK"/></packageSource>
    <packageSource key="nuget.org"><package pattern="*"/></packageSource></packageSourceMapping>
  <fallbackPackageFolders><clear/></fallbackPackageFolders>
</configuration>`);
  console.log(`SDK_PROOF_DIRECTORY=${proof}`);
  const result = spawnSync('dotnet', ['build', 'LumioSample.slnx',
    '-p:LumioSdkMode=nuget', `-p:LumioSdkVersion=${identity.version}`,
    `-p:LumioLocalFeed=${feed}`, `-p:RestoreConfigFile=${config}`,
    `-p:RestorePackagesPath=${packages}`, `-p:ArtifactsPath=${artifacts}`],
  { cwd: root, stdio: 'inherit', env: { ...process.env, NUGET_PACKAGES: packages } });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`sdk_build_failed: ${result.status}`);
  const cached = join(packages, 'lumio.engine.sdk', identity.version, `lumio.engine.sdk.${identity.version}.nupkg`);
  if (hash(cached) !== identity.sha512) throw new Error('sdk_cached_identity_mismatch');
  for (const project of ['Lumio.Sample.Gameplay', 'Lumio.Sample.Gameplay.Tests']) {
    verifyAssets(join(artifacts, 'obj', project, 'project.assets.json'), identity);
  }
  const evidence = { schemaVersion: 1, version: identity.version, sha512: identity.sha512,
    sourceArchive: identity.nupkgPath, cachedArchive: cached, proof, status: 'PASS' };
  writeFileSync(join(proof, 'verification.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node Tools/build-local-sdk.mjs <pack-sdk-identity.json>');
    buildLocalSdk(resolve(process.argv[2]));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

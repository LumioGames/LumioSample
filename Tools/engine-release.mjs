/**
 * The one place this repository takes the engine from: the read-only submodule `Engine/`
 * (LumioEngineRelease pinned at a release tag, ADR-123). Every tool that needs an engine
 * binary, script or compose file resolves it here; there is no sibling checkout, no
 * environment variable naming a loose artefact, and no other platform standing in for the
 * one this machine is.
 *
 * Failure semantics (ADR-123「失败语义」):
 * - Engine/ empty (cloned without --recursive): run `git submodule update --init --depth 1 Engine`
 *   once; still empty is BLOCKED_ENV.
 * - this machine's <rid> not in manifest.platforms: BLOCKED_ENV naming the <rid>, no fall-back.
 * - Engine/tools/verify-release.mjs rejects the tree (sha256 / version mismatch): a hard
 *   failure (`ENGINE_RELEASE_INVALID`), not an environment block.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';

export const ENGINE_DIR = 'Engine';
export const ENGINE_URL = 'https://github.com/LumioGames/LumioEngineRelease';
/** The exact command ADR-123 prints wherever Engine/ is found empty. */
export const SUBMODULE_INIT_ARGS = Object.freeze(['submodule', 'update', '--init', '--depth', '1', ENGINE_DIR]);
export const SUBMODULE_INIT_COMMAND = `git ${SUBMODULE_INIT_ARGS.join(' ')}`;

export class BlockedEnvError extends Error {
  constructor(message) {
    super(`BLOCKED_ENV: ${message}`);
    this.name = 'BlockedEnvError';
    this.code = 'BLOCKED_ENV';
  }
}

export function blocked(message) {
  return new BlockedEnvError(message);
}

export class EngineReleaseError extends Error {
  constructor(message) {
    super(`ENGINE_RELEASE_INVALID: ${message}`);
    this.name = 'EngineReleaseError';
    this.code = 'ENGINE_RELEASE_INVALID';
  }
}

/** The .NET runtime identifier of this machine, spelled the way the release names platforms. */
export function hostRid(platform = process.platform, arch = process.arch) {
  const os = { win32: 'win', darwin: 'osx', linux: 'linux' }[platform] ?? platform;
  const cpu = { x64: 'x64', arm64: 'arm64', ia32: 'x86', arm: 'arm' }[arch] ?? arch;
  return `${os}-${cpu}`;
}

export function engineDir(repoRoot) {
  return join(resolve(repoRoot), ENGINE_DIR);
}

/** `lumio_engine_native` under the host's library naming. */
export function nativeLibraryName(rid) {
  if (rid.startsWith('win-')) return 'lumio_engine_native.dll';
  if (rid.startsWith('osx-')) return 'liblumio_engine_native.dylib';
  return 'liblumio_engine_native.so';
}

/**
 * The ADR-123 release tree, for one platform. Paths only; nothing here checks existence
 * (verify-release.mjs owns that).
 */
export function releaseLayout(root, rid) {
  const base = resolve(root);
  const server = join(base, 'server', rid);
  const nativeDir = join(server, 'SDK', 'Native', rid);
  const application = join(server, 'Application');
  const managed = join(server, 'SDK', 'Managed');
  const bot = join(base, 'bot', rid);
  const web = join(base, 'web');
  const tools = join(base, 'tools');
  return {
    root: base,
    rid,
    manifest: join(base, 'manifest.json'),
    sdkFeed: join(base, 'sdk'),
    server,
    dsExe: join(server, rid.startsWith('win-') ? 'lumio-ds.exe' : 'lumio-ds'),
    application,
    hostEntry: join(application, 'Lumio.Server.HostEntry.dll'),
    hostEntryRuntimeConfig: join(application, 'Lumio.Server.HostEntry.runtimeconfig.json'),
    managed,
    replicationAssembly: join(managed, 'Lumio.GameRuntime.Replication.dll'),
    ecsAssembly: join(managed, 'Lumio.GameRuntime.Ecs.dll'),
    nativeDir,
    engineNative: join(nativeDir, nativeLibraryName(rid)),
    bot,
    botHost: join(bot, 'Lumio.Client.Bot.Host.dll'),
    web,
    webSpectator: join(web, 'spectator'),
    voxelWasm: join(web, 'lumio_voxel_wasm.wasm'),
    tools,
    processTools: join(tools, 'process-tools.mjs'),
    verifyRelease: join(tools, 'verify-release.mjs'),
    platformCompose: join(base, 'platform', 'docker-compose.yml'),
  };
}

export function readManifest(root) {
  const path = join(resolve(root), 'manifest.json');
  if (!existsSync(path)) return null;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new EngineReleaseError(`${path} is not valid JSON: ${error.message}`);
  }
  if (!manifest || typeof manifest !== 'object' || typeof manifest.version !== 'string' || !Array.isArray(manifest.platforms)) {
    throw new EngineReleaseError(`${path} lacks version / platforms (ADR-123 manifest.json).`);
  }
  return manifest;
}

function defaultGit(args, { cwd }) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function defaultNode(args, { cwd }) {
  return spawnSync(process.execPath, args, { cwd, encoding: 'utf8' });
}

function commandText(result) {
  return `${result?.stdout ?? ''}${result?.stderr ?? ''}${result?.error ? result.error.message : ''}`.trim();
}

/**
 * Engine/ has a manifest, or gets one from exactly one `git submodule update --init --depth 1
 * Engine`. Anything else is BLOCKED_ENV with the command in the message.
 */
export function ensureEngine({ repoRoot, git = defaultGit, log = () => {} } = {}) {
  const dir = engineDir(repoRoot);
  let manifest = readManifest(dir);
  if (manifest) return { dir, manifest, initialized: false };
  log(`Engine/ is empty; running: ${SUBMODULE_INIT_COMMAND}`);
  const result = git([...SUBMODULE_INIT_ARGS], { cwd: resolve(repoRoot) });
  manifest = readManifest(dir);
  if (!manifest) {
    const detail = commandText(result);
    throw blocked(`Engine/ is empty and "${SUBMODULE_INIT_COMMAND}" did not fill it${detail ? ` (${detail.split('\n').slice(-3).join(' | ')})` : ''}. `
      + 'Check network access to github.com/LumioGames/LumioEngineRelease, then re-run that command.');
  }
  return { dir, manifest, initialized: true };
}

export function assertPlatform(manifest, rid) {
  if (!manifest.platforms.includes(rid)) {
    throw blocked(`this machine is ${rid}, and Engine/manifest.json (v${manifest.version}) ships only [${manifest.platforms.join(', ')}]. `
      + 'No other platform is used in its place; switch to a release that lists this platform.');
  }
}

/**
 * Run the release's own verify-release.mjs for one platform. Its CLI is
 * `node <root>/tools/verify-release.mjs --root <root> --rid <rid>` (exit 0 = the tree matches
 * manifest.json). It is the only implementation of that check (R-00781).
 */
export function verifyRelease({ root, rid, node = defaultNode } = {}) {
  const script = join(resolve(root), 'tools', 'verify-release.mjs');
  if (!existsSync(script)) {
    throw new EngineReleaseError(`${script} is missing; this release cannot be verified.`);
  }
  const result = node([script, '--root', resolve(root), '--rid', rid], { cwd: resolve(root) });
  if (result.error || result.status !== 0) {
    throw new EngineReleaseError(`verify-release rejected ${resolve(root)} for ${rid}: ${commandText(result) || `exit ${result.status}`}`);
  }
  return commandText(result);
}

/** ensure → platform → verify, in that order; returns the verified layout for this machine. */
export function prepareEngine({ repoRoot, rid = hostRid(), git, node, log } = {}) {
  const { dir, manifest, initialized } = ensureEngine({ repoRoot, git, log });
  assertPlatform(manifest, rid);
  verifyRelease({ root: dir, rid, node });
  return { dir, manifest, rid, initialized, layout: releaseLayout(dir, rid) };
}

function versionKey(name) {
  return name.split(/[.-]/).map((part) => (/^\d+$/.test(part) ? part.padStart(8, '0') : part)).join('.');
}

function whichDotnet(dotnet, env) {
  if (dotnet.includes('/') || dotnet.includes('\\')) return existsSync(dotnet) ? dotnet : null;
  const names = process.platform === 'win32' ? [`${dotnet}.exe`, dotnet] : [dotnet];
  for (const dir of String(env.PATH ?? env.Path ?? '').split(delimiter)) {
    for (const name of names) {
      const candidate = join(dir, name);
      if (dir && existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    }
  }
  return null;
}

/**
 * hostfxr of this machine's .NET install (ADR-123: taken from the local dotnet, not from a
 * variable). DOTNET_ROOT when set, else the directory of the `dotnet` on PATH; the highest
 * host/fxr/<version>/ wins.
 */
export function resolveHostfxr({ dotnet = 'dotnet', env = process.env, platform = process.platform } = {}) {
  const roots = [];
  if (env.DOTNET_ROOT) roots.push(resolve(env.DOTNET_ROOT));
  const exe = whichDotnet(dotnet, env);
  if (exe) {
    try { roots.push(dirname(realpathSync(exe))); } catch { roots.push(dirname(exe)); }
  }
  const file = platform === 'win32' ? 'hostfxr.dll' : platform === 'darwin' ? 'libhostfxr.dylib' : 'libhostfxr.so';
  for (const root of roots) {
    const fxr = join(root, 'host', 'fxr');
    if (!existsSync(fxr)) continue;
    const versions = readdirSync(fxr).filter((name) => existsSync(join(fxr, name, file))).sort((a, b) => versionKey(b).localeCompare(versionKey(a)));
    if (versions.length > 0) return join(fxr, versions[0], file);
  }
  throw blocked(`hostfxr (${file}) was not found under ${roots.length ? roots.map((root) => join(root, 'host', 'fxr')).join(', ') : 'any dotnet on PATH'}; install the .NET SDK named in global.json.`);
}

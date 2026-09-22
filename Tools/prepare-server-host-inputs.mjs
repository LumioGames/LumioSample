#!/usr/bin/env node

/**
 * Produce and name every input `Tools/test-server-host.mjs` demands, so the two
 * engine-level admit/spawn cases can run in CI (R-00702).
 *
 * R-00692 landed the cases and ran them once, by hand, on one machine. ADR-113
 * 决策 3 puts the obligation on the CI job instead: the job that needs an
 * artifact produces it, verifies it, and exports its path. Nothing here skips —
 * every missing or mismatched input throws with the variable's name and the
 * step that produces it.
 *
 *   node Tools/prepare-server-host-inputs.mjs \
 *     --engine-root <LumioGameEngine> \
 *     --hostentry-dir <dir holding Lumio.Server.HostEntry.dll> \
 *     --gameplay-bin <Gameplay/bin/Release/net10.0> \
 *     --output <scratch dir for the voxel fixture>
 *
 * `--gameplay-bin` must be a build against the *same* `Lumio.Engine.SDK`
 * release HostEntry was compiled against. HostEntry checks that at boot and
 * answers `sdk_version_mismatch` otherwise (ADR-102) — a sibling-mode gameplay
 * build carries Runtime 1.0.0 assemblies and a packaged HostEntry wants 0.1.0.
 * The three-path Runtime is read out of that same directory for the same
 * reason, so one matched set covers host, runtime and gameplay.
 *
 * The voxel fixture is *made here, from this run's native image*, never read
 * from a committed directory. `LumioGameRuntime/modules/coordination/tests/
 * fixtures/voxel-native` is authored against a different native build; the
 * voxel case fails on it with `load_suspended_missing_voxel`, which is how
 * R-00692 found the drift. The recipe is the same one LumioServer uses in
 * `Tools/prepare-runtime-test-inputs.mjs`:
 *
 *   1. the native author-time air capture (cargo, `root_api`), then
 *   2. the managed catalog world (Engine `Lumio.Engine.NativeLoader.Tests`),
 *
 * and the emitted `catalog-world-evidence.json` must carry the same
 * `BinarySha256` as the native image's `build-info.json`. Same-source or fail.
 */

import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { REQUIRED_ENV } from './test-server-host.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const ROOT = resolve(HERE, '..');

/** The three files the fixture producers must leave behind. */
export const FIXTURE_FILES = ['catalog-world.json', 'catalog-world.capture', 'catalog-world-evidence.json'];

/** `cargo --release` writes the host's own library name; no `--target` is passed. */
export function nativeLibraryName(platform = process.platform) {
  if (platform === 'darwin') return 'liblumio_engine_native.dylib';
  if (platform === 'win32') return 'lumio_engine_native.dll';
  return 'liblumio_engine_native.so';
}

export function missing(variable, why) {
  return new Error(`MISSING_INPUT: ${variable} — ${why}. These cases carry engine guarantees (ADR-113): a missing artifact is a failure, never a skip.`);
}

function requireFile(path, variable, why) {
  if (!path) throw missing(variable, why);
  const full = resolve(path);
  if (!existsSync(full) || !statSync(full).isFile()) throw missing(variable, `${why}; not a file: ${full}`);
  return full;
}

function requireDirectory(path, variable, why) {
  if (!path) throw missing(variable, why);
  const full = resolve(path);
  if (!existsSync(full) || !statSync(full).isDirectory()) throw missing(variable, `${why}; not a directory: ${full}`);
  return full;
}

/**
 * The production native image this run built, plus the `build-info.json` the
 * loader's identity check reads. `provision-engine-native.sh` writes both and
 * exports `LUMIO_ENGINE_NATIVE_PATH`; a bare library with no sidecar is not a
 * usable input.
 */
export function resolveNative({ engineRoot, env = process.env, platform = process.platform } = {}) {
  const named = env.LUMIO_ENGINE_NATIVE_PATH;
  const fallback = engineRoot
    ? join(resolve(engineRoot), '.build', 'native-target', 'release', nativeLibraryName(platform))
    : undefined;
  const image = requireFile(named || fallback, 'LUMIO_ENGINE_NATIVE_PATH',
    'this run\'s production native image, from the "Provision liblumio_engine_native" step');
  const sidecar = requireFile(join(dirname(image), 'build-info.json'), 'LUMIO_ENGINE_NATIVE_PATH',
    `the image at ${image} has no build-info.json beside it, so its identity cannot be compared`);
  const info = JSON.parse(readFileSync(sidecar, 'utf8'));
  for (const field of ['buildId', 'abiHash', 'binarySha256']) {
    if (typeof info[field] !== 'string' || info[field] === '')
      throw missing('LUMIO_ENGINE_NATIVE_PATH', `build-info.json is missing ${field}: ${sidecar}`);
  }
  return { image, sidecar, info };
}

/** Run a producer; any non-zero status is a failure named by step. */
function runner(execute) {
  return (step, command, args, options) => {
    const result = execute(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options });
    process.stdout.write(result.stdout ?? '');
    process.stderr.write(result.stderr ?? '');
    if (result.error || result.status !== 0)
      throw new Error(`FIXTURE_STEP_FAILED: ${step} exited ${result.status}${result.error ? ` (${result.error.message})` : ''}`);
    return result;
  };
}

/**
 * Author the catalog world fixture against `native`, into `output`.
 *
 * Both producers are the upstream ones; this function owns no fixture content
 * of its own. The final check is the one that matters: the evidence file's
 * `BinarySha256` is the image the fixture was authored against, and it must be
 * the image this job is about to run the cases on.
 */
export function buildVoxelFixture({ engineRoot, native, output, execute = spawnSync, env = process.env } = {}) {
  const engine = requireDirectory(engineRoot, 'LUMIO_ENGINE_ROOT', 'the LumioGameEngine checkout that owns both fixture producers');
  const directory = resolve(output);
  mkdirSync(directory, { recursive: true });
  const run = runner(execute);
  const capture = join(directory, 'air.capture');
  const manifest = join(engine, 'engine/native/Cargo.toml');
  const targetDirectory = join(engine, '.build/native-target');
  const producerEnv = {
    ...env,
    LUMIO_CATALOG_AIR_CAPTURE: capture,
    LUMIO_CATALOG_TEST_NATIVE: native.image,
    LUMIO_CATALOG_TEST_OUTPUT: directory,
    LUMIO_ENGINE_NATIVE_PATH: native.image,
    LUMIO_BUILD_ID: native.info.buildId,
    LUMIO_ABI_HASH: native.info.abiHash,
  };
  // 1. Native author-time air snapshot. Same target directory as the provision
  //    step so the already-built workspace is reused rather than re-stamped.
  run('air-capture (cargo root_api)', 'cargo',
    ['test', '--manifest-path', manifest, '-p', 'lumio-engine-native', '--target-dir', targetDirectory,
      '--test', 'root_api', 'catalog_author_time_air_capture_prerequisite', '--', '--exact'],
    { cwd: join(engine, 'engine/native'), env: producerEnv });
  if (!existsSync(capture)) throw new Error('FIXTURE_STEP_FAILED: the native test did not emit air.capture');
  // 2. Managed catalog world built on top of that snapshot.
  run('catalog-world (Engine NativeLoader tests)', 'dotnet',
    ['test', join(engine, 'engine/managed/Lumio.Engine.NativeLoader.Tests/Lumio.Engine.NativeLoader.Tests.csproj'),
      '-c', 'Release', '--filter', 'FullyQualifiedName~CallerCatalogLifetimeAndPublicMutationProduceRealNonemptyAabb'],
    { cwd: engine, env: producerEnv });
  for (const file of FIXTURE_FILES) {
    if (!existsSync(join(directory, file)))
      throw new Error(`FIXTURE_STEP_FAILED: the catalog-world producer did not emit ${file} into ${directory}`);
  }
  const evidence = JSON.parse(readFileSync(join(directory, 'catalog-world-evidence.json'), 'utf8'));
  if (evidence.BinarySha256 !== native.info.binarySha256) {
    throw new Error(
      'VOXEL_FIXTURE_NATIVE_MISMATCH: the catalog world was authored against a different native image '
      + `(fixture ${evidence.BinarySha256}, this run ${native.info.binarySha256}). `
      + 'This is the committed-fixture drift R-00692 hit as load_suspended_missing_voxel; author the fixture in this job, do not reuse one.');
  }
  return { directory, capture, evidence };
}

/**
 * The six named values, resolved and checked. Callers get exactly the set
 * `Tools/test-server-host.mjs` requires — no more, no fewer — so a variable
 * added there fails here by name instead of arriving empty.
 */
export function resolveInputs({ hostEntryDirectory, gameplayBin, configDir, fixtureDirectory } = {}) {
  const gameplay = requireDirectory(gameplayBin, 'LUMIO_SAMPLE_GAMEPLAY_DLL',
    'the server-side Gameplay build output of this run, built against the same SDK release as HostEntry (ADR-102)');
  const values = {
    LUMIO_SERVER_HOSTENTRY_DLL: requireFile(
      hostEntryDirectory ? join(resolve(hostEntryDirectory), 'Lumio.Server.HostEntry.dll') : undefined,
      'LUMIO_SERVER_HOSTENTRY_DLL',
      'this run\'s Lumio.Server.HostEntry.dll, from the server-hostentry job artifact'),
    LUMIO_RUNTIME_REPLICATION_DLL: requireFile(join(gameplay, 'Lumio.GameRuntime.Replication.dll'),
      'LUMIO_RUNTIME_REPLICATION_DLL', 'the named three-path Runtime, from the same SDK release, beside the Gameplay build'),
    LUMIO_RUNTIME_ECS_DLL: requireFile(join(gameplay, 'Lumio.GameRuntime.Ecs.dll'),
      'LUMIO_RUNTIME_ECS_DLL', 'the named three-path Runtime, from the same SDK release, beside the Gameplay build'),
    LUMIO_SAMPLE_GAMEPLAY_DLL: requireFile(join(gameplay, 'Lumio.Sample.Gameplay.dll'),
      'LUMIO_SAMPLE_GAMEPLAY_DLL', 'this run\'s server-side Sample gameplay assembly'),
    LUMIO_CONFIG_DIR: requireDirectory(configDir ?? join(ROOT, 'Server/Config/Tables'),
      'LUMIO_CONFIG_DIR', 'the server end\'s config export (Server/Config/Tables)'),
    LUMIO_TEST_VOXEL_FIXTURE_DIR: requireDirectory(fixtureDirectory, 'LUMIO_TEST_VOXEL_FIXTURE_DIR',
      'the catalog world authored in this job against this run\'s native image'),
  };
  const names = Object.keys(values).sort();
  const expected = [...REQUIRED_ENV].sort();
  if (JSON.stringify(names) !== JSON.stringify(expected)) {
    throw new Error(
      `REQUIRED_ENV_DRIFT: Tools/test-server-host.mjs requires ${expected.join(', ')} but this script resolves ${names.join(', ')}. `
      + 'Teach this script the new input; do not let the suite start with an empty one.');
  }
  return values;
}

/** `--engine-root x` → `{ engineRoot: 'x' }`. Unknown flags are rejected, not ignored. */
export const FLAGS = {
  '--engine-root': 'engineRoot',
  '--hostentry-dir': 'hostEntryDirectory',
  '--gameplay-bin': 'gameplayBin',
  '--config-dir': 'configDir',
  '--output': 'output',
};

export function parseArguments(argv) {
  const usage = `Usage: node Tools/prepare-server-host-inputs.mjs ${Object.keys(FLAGS).map(flag => `${flag} <dir>`).join(' ')}`;
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!Object.hasOwn(FLAGS, flag ?? '') || value === undefined || value.startsWith('--'))
      throw new Error(`${usage}; bad argument near ${flag}`);
    options[FLAGS[flag]] = value;
  }
  return options;
}

export function prepare({ engineRoot, hostEntryDirectory, gameplayBin, output, configDir, env = process.env, execute = spawnSync } = {}) {
  const native = resolveNative({ engineRoot, env });
  const fixture = buildVoxelFixture({ engineRoot, native, output, execute, env });
  const values = resolveInputs({ hostEntryDirectory, gameplayBin, configDir, fixtureDirectory: fixture.directory });
  const exported = { ...values, LUMIO_ENGINE_NATIVE_PATH: native.image };
  if (env.GITHUB_ENV)
    appendFileSync(env.GITHUB_ENV, Object.entries(exported).map(([key, value]) => `${key}=${value}\n`).join(''));
  return { ...exported, nativeBuildId: native.info.buildId, nativeSha256: native.info.binarySha256,
    fixtureCaptureSha256: fixture.evidence.captureSha256 };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(prepare(parseArguments(process.argv.slice(2))), null, 2));
}

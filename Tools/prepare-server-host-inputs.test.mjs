import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { REQUIRED_ENV } from './test-server-host.mjs';
import {
  FIXTURE_FILES,
  buildVoxelFixture,
  nativeLibraryName,
  parseArguments,
  prepare,
  resolveInputs,
  resolveNative,
} from './prepare-server-host-inputs.mjs';

const BINARY = 'a'.repeat(64);
const scratch = () => mkdtempSync(join(tmpdir(), 'lumio-hostci-'));

function nativeTree(binarySha256 = BINARY) {
  const root = scratch();
  const release = join(root, '.build/native-target/release');
  mkdirSync(release, { recursive: true });
  const image = join(release, nativeLibraryName());
  writeFileSync(image, 'not a real library');
  writeFileSync(join(release, 'build-info.json'),
    JSON.stringify({ buildId: 'b'.repeat(32), abiHash: 'c'.repeat(64), binarySha256 }));
  return { root, image, release };
}

/** A fake `spawnSync` that writes what the real producers write and records the calls. */
function fakeProducers(directory, { evidenceSha = BINARY, omit = [] } = {}) {
  const calls = [];
  return {
    calls,
    execute(command, args, options) {
      calls.push({ command, cwd: options?.cwd, env: options?.env });
      if (command === 'cargo') {
        writeFileSync(options.env.LUMIO_CATALOG_AIR_CAPTURE, 'air');
      } else {
        mkdirSync(directory, { recursive: true });
        for (const file of FIXTURE_FILES) {
          if (omit.includes(file)) continue;
          writeFileSync(join(directory, file), file.endsWith('evidence.json')
            ? JSON.stringify({ BinarySha256: evidenceSha, captureSha256: 'd'.repeat(64) })
            : 'fixture');
        }
      }
      return { status: 0, stdout: '', stderr: '' };
    },
  };
}

function gameplayTree({ omit = [] } = {}) {
  const bin = join(scratch(), 'bin');
  mkdirSync(bin, { recursive: true });
  for (const dll of ['Lumio.Sample.Gameplay.dll', 'Lumio.GameRuntime.Replication.dll', 'Lumio.GameRuntime.Ecs.dll']) {
    if (omit.includes(dll)) continue;
    writeFileSync(join(bin, dll), 'dll');
  }
  return bin;
}

function hostEntryTree({ present = true } = {}) {
  const directory = join(scratch(), 'hostentry');
  mkdirSync(directory, { recursive: true });
  if (present) writeFileSync(join(directory, 'Lumio.Server.HostEntry.dll'), 'dll');
  return directory;
}

test('the resolved set is exactly what the suite requires, so a new input cannot arrive empty', () => {
  const fixture = scratch();
  writeFileSync(join(fixture, 'catalog-world.json'), '{}');
  const values = resolveInputs({
    hostEntryDirectory: hostEntryTree(),
    gameplayBin: gameplayTree(),
    fixtureDirectory: fixture,
  });
  assert.deepEqual(Object.keys(values).sort(), [...REQUIRED_ENV].sort());
});

test('a missing HostEntry artifact fails by name and is never a skip', () => {
  assert.throws(() => resolveInputs({
    hostEntryDirectory: hostEntryTree({ present: false }),
    gameplayBin: gameplayTree(),
    fixtureDirectory: scratch(),
  }), error => {
    assert.match(error.message, /MISSING_INPUT: LUMIO_SERVER_HOSTENTRY_DLL/u);
    assert.match(error.message, /never a skip/u);
    assert.doesNotMatch(error.message, /BLOCKED_ENV/u);
    return true;
  });
});

test('a missing gameplay assembly fails by name', () => {
  assert.throws(() => resolveInputs({
    hostEntryDirectory: hostEntryTree(),
    gameplayBin: gameplayTree({ omit: ['Lumio.Sample.Gameplay.dll'] }),
    fixtureDirectory: scratch(),
  }), /MISSING_INPUT: LUMIO_SAMPLE_GAMEPLAY_DLL/u);
});

test('a gameplay build without the named three-path Runtime fails by name', () => {
  assert.throws(() => resolveInputs({
    hostEntryDirectory: hostEntryTree(),
    gameplayBin: gameplayTree({ omit: ['Lumio.GameRuntime.Ecs.dll'] }),
    fixtureDirectory: scratch(),
  }), /MISSING_INPUT: LUMIO_RUNTIME_ECS_DLL/u);
});

test('a missing voxel fixture directory fails by name', () => {
  assert.throws(() => resolveInputs({
    hostEntryDirectory: hostEntryTree(),
    gameplayBin: gameplayTree(),
    fixtureDirectory: join(scratch(), 'never-created'),
  }), /MISSING_INPUT: LUMIO_TEST_VOXEL_FIXTURE_DIR/u);
});

test('a native image with no build-info.json beside it is not a usable input', () => {
  const root = scratch();
  const release = join(root, '.build/native-target/release');
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, nativeLibraryName()), 'not a real library');
  assert.throws(() => resolveNative({ engineRoot: root, env: {} }),
    /MISSING_INPUT: LUMIO_ENGINE_NATIVE_PATH .* has no build-info\.json/su);
});

test('the fixture is authored in the job, against this run\'s image', () => {
  const native = nativeTree();
  const output = join(scratch(), 'fixture');
  const producers = fakeProducers(output);
  const result = buildVoxelFixture({ engineRoot: native.root, output, execute: producers.execute,
    native: { image: native.image, info: { buildId: 'b'.repeat(32), abiHash: 'c'.repeat(64), binarySha256: BINARY } } });
  assert.equal(result.directory, output);
  assert.deepEqual(producers.calls.map(call => call.command), ['cargo', 'dotnet']);
  // The producers must be pointed at this run's image, not at a committed one.
  for (const call of producers.calls) assert.equal(call.env.LUMIO_ENGINE_NATIVE_PATH, native.image);
});

test('a fixture authored against another native image is rejected, not consumed', () => {
  const native = nativeTree();
  const output = join(scratch(), 'fixture');
  const producers = fakeProducers(output, { evidenceSha: 'e'.repeat(64) });
  assert.throws(() => buildVoxelFixture({ engineRoot: native.root, output, execute: producers.execute,
    native: { image: native.image, info: { buildId: 'b'.repeat(32), abiHash: 'c'.repeat(64), binarySha256: BINARY } } }),
  /VOXEL_FIXTURE_NATIVE_MISMATCH/u);
});

test('a producer that emits nothing fails instead of leaving an empty fixture directory', () => {
  const native = nativeTree();
  const output = join(scratch(), 'fixture');
  const producers = fakeProducers(output, { omit: ['catalog-world.capture'] });
  assert.throws(() => buildVoxelFixture({ engineRoot: native.root, output, execute: producers.execute,
    native: { image: native.image, info: { buildId: 'b'.repeat(32), abiHash: 'c'.repeat(64), binarySha256: BINARY } } }),
  /FIXTURE_STEP_FAILED: the catalog-world producer did not emit catalog-world\.capture/u);
});

test('a producer that exits non-zero fails by step name', () => {
  const native = nativeTree();
  assert.throws(() => buildVoxelFixture({ engineRoot: native.root, output: join(scratch(), 'fixture'),
    execute: () => ({ status: 101, stdout: '', stderr: '' }),
    native: { image: native.image, info: { buildId: 'b'.repeat(32), abiHash: 'c'.repeat(64), binarySha256: BINARY } } }),
  /FIXTURE_STEP_FAILED: air-capture \(cargo root_api\) exited 101/u);
});

test('prepare writes every required name into GITHUB_ENV', () => {
  const native = nativeTree();
  const output = join(scratch(), 'fixture');
  const githubEnv = join(scratch(), 'github.env');
  writeFileSync(githubEnv, '');
  const values = prepare({
    engineRoot: native.root,
    hostEntryDirectory: hostEntryTree(),
    gameplayBin: gameplayTree(),
    output,
    env: { GITHUB_ENV: githubEnv, LUMIO_ENGINE_NATIVE_PATH: native.image },
    execute: fakeProducers(output).execute,
  });
  const written = new Map(readFileSync(githubEnv, 'utf8').split('\n').filter(Boolean)
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
  for (const name of REQUIRED_ENV) assert.equal(written.get(name), values[name], name);
  assert.equal(written.get('LUMIO_ENGINE_NATIVE_PATH'), native.image);
});

test('unknown flags are rejected rather than silently dropped', () => {
  assert.deepEqual(parseArguments(['--engine-root', '/e', '--output', '/o']), { engineRoot: '/e', output: '/o' });
  assert.throws(() => parseArguments(['--fixture-dir', '/f']), /Usage: node Tools\/prepare-server-host-inputs\.mjs/u);
  assert.throws(() => parseArguments(['--engine-root']), /bad argument near --engine-root/u);
});

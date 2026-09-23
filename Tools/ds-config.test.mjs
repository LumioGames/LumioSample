import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { test } from 'node:test';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  ALLOCATION_KEYS,
  DS_CLR_INPUTS,
  PLACEHOLDER_PUBLIC_KEY,
  assertDsClrInputs,
  assertRunnableDsConfig,
  deriveRunDsConfig,
  writeKernelConfigForRun,
} from './ds-config.mjs';

const committed = JSON.parse(readFileSync(new URL('../Server/Config/Startup/server.json', import.meta.url), 'utf8'));
const sample = JSON.parse(readFileSync(new URL('../Server/Config/Startup/server.sample.json', import.meta.url), 'utf8'));

test('committed server.json is not blocked by replace-* or REPLACE_WITH_PLATFORM tokens', () => {
  const allocation = committed.allocation;
  for (const key of ALLOCATION_KEYS) {
    assert.equal(typeof allocation[key], 'string');
    assert.notEqual(allocation[key].trim(), '');
    assert.doesNotMatch(allocation[key], /^replace-/);
  }
  assert.notEqual(committed.admission_public_key_hex, PLACEHOLDER_PUBLIC_KEY);
  assert.match(committed.admission_public_key_hex, /^[0-9a-fA-F]{64}$/);
  assert.equal(committed.world_profile, 'runtime+voxel');
  assert.equal(committed.durability, 'snapshot_only');
  assert.doesNotThrow(() => assertRunnableDsConfig(committed));
});

test('server.sample.json keeps fill-me tokens so a copied-unfilled file fails loudly', () => {
  assert.equal(sample.admission_public_key_hex, PLACEHOLDER_PUBLIC_KEY);
  for (const key of ALLOCATION_KEYS) {
    assert.match(sample.allocation[key], /^replace-/);
  }
  assert.throws(
    () => assertRunnableDsConfig(sample),
    (error) => {
      assert.equal(error.code, 'MISSING_VALUE');
      assert.match(error.message, /missing required value/);
      assert.doesNotMatch(error.message, /BLOCKED_ENV/);
      return true;
    },
  );
});

test('missing required values are loud MISSING_VALUE errors, not BLOCKED_ENV', () => {
  const config = structuredClone(committed);
  delete config.allocation.roomId;
  assert.throws(
    () => assertRunnableDsConfig(config),
    (error) => {
      assert.equal(error.code, 'MISSING_VALUE');
      assert.match(error.message, /allocation\.roomId/);
      assert.doesNotMatch(error.message, /BLOCKED_ENV/);
      return true;
    },
  );
  config.allocation.roomId = '   ';
  assert.throws(() => assertRunnableDsConfig(config), /allocation\.roomId/);
  config.allocation.roomId = 'sample';
  config.admission_public_key_hex = PLACEHOLDER_PUBLIC_KEY;
  assert.throws(
    () => assertRunnableDsConfig(config),
    (error) => {
      assert.equal(error.code, 'MISSING_VALUE');
      assert.match(error.message, /admission_public_key_hex/);
      assert.doesNotMatch(error.message, /BLOCKED_ENV/);
      return true;
    },
  );
});


test('server.sample.json carries every key server.json needs so a copy is refused on values, not schema', () => {
  // The template is only useful if a copied-unfilled file reaches the loud
  // fill-me complaint. A key the sample is missing outright makes `lumio-ds
  // --check-config` refuse it on serde grounds first, about a block the
  // operator was never told to fill. Required-key parity with the runnable
  // config is what keeps the rejection about the `replace-*` values.
  assert.deepEqual(Object.keys(sample).sort(), Object.keys(committed).sort());
  assert.deepEqual(Object.keys(sample.clr).sort(), Object.keys(committed.clr).sort());
  // Kernel limits are local resource bounds, not Platform tickets: the sample
  // states them explicitly (no hidden defaults) rather than tokenising them,
  // so the generated per-run copy resolves from the template as-copied.
  assert.deepEqual(sample.clr.kernel_config, committed.clr.kernel_config);
  const dir = mkdtempSync(join(tmpdir(), 'sample-kernel-config-parity-'));
  const input = join(dir, 'server.json');
  const output = join(dir, 'kernel-config.json');
  writeFileSync(input, `${JSON.stringify(sample)}\n`);
  assert.doesNotThrow(() => writeKernelConfigForRun(input, output));
  assert.deepEqual(JSON.parse(readFileSync(output, 'utf8')), committed.clr.kernel_config);
});

test('missing explicit KernelConfig is rejected instead of receiving hidden limits', () => {
  const path = new URL('../Server/Config/Startup/server.json', import.meta.url);
  const copy = JSON.parse(readFileSync(path, 'utf8'));
  delete copy.clr.kernel_config;
  const dir = mkdtempSync(join(tmpdir(), 'sample-kernel-config-'));
  const input = join(dir, 'server.json');
  const output = join(dir, 'kernel-config.json');
  writeFileSync(input, `${JSON.stringify(copy)}\n`);
  assert.throws(() => writeKernelConfigForRun(input, output), /clr.kernel_config/);
});

const TEMPLATE_PATH = fileURLToPath(new URL('../Server/Config/Startup/server.json', import.meta.url));

test('a run config is the template with absolute paths, a fresh store, its own debug log dir', () => {
  const run = deriveRunDsConfig(committed, {
    templatePath: TEMPLATE_PATH,
    storePath: '/run/store',
    logDir: '/run/ds-boot-1',
    checkpointSeconds: 15,
  });
  const base = dirname(TEMPLATE_PATH);
  // Written outside Server/Config/Startup, so nothing may stay relative to the template.
  for (const field of ['config_dir', 'voxel_catalog', 'base_map_path']) {
    assert.ok(isAbsolute(run[field]), field);
    assert.equal(run[field], resolve(base, committed[field]));
  }
  for (const field of ['engine_native', 'hostfxr', 'runtime_config', 'assembly', 'replication_assembly', 'ecs_assembly', 'registry_assembly']) {
    assert.equal(run.clr[field], resolve(base, committed.clr[field]), field);
  }
  assert.equal(run.store_path, '/run/store');
  assert.deepEqual(run.logging, { ...committed.logging, dir: '/run/ds-boot-1', min_level: 'debug' });
  assert.equal(run.checkpoint_seconds, 15);
  assert.deepEqual(run.clr.kernel_config, committed.clr.kernel_config);
  assert.deepEqual(Object.keys(run).sort(), Object.keys(committed).sort(), 'lumio-ds denies unknown fields');
  // The template itself is untouched.
  assert.equal(committed.store_path, '../../Storage/Worlds');
  assert.equal(deriveRunDsConfig(committed, { templatePath: TEMPLATE_PATH }).checkpoint_seconds, committed.checkpoint_seconds);
});

test('a run config takes the launch claims, the admission key and CLR files from the operator, not from a machine', () => {
  const launch = {
    serverAudience: 'aud-1', gameId: 'sample', gameReleaseId: 'rel-1', contractId: 'c-1', roomId: 'room-1', allocationId: 'alloc-1',
    admissionCredential: 'secret-ticket',
  };
  const env = {
    LUMIO_PLATFORM_ADMISSION_KEY: 'ab'.repeat(32),
    LUMIO_HOSTFXR: '/opt/dotnet/hostfxr.dll',
    LUMIO_SERVER_HOSTENTRY_DLL: '/srv/HostEntry/Lumio.Server.HostEntry.dll',
    LUMIO_ENGINE_NATIVE: '/srv/native/lumio_engine_native.dll',
    LUMIO_SAMPLE_GAMEPLAY_DLL: '/srv/gameplay/Lumio.Sample.Gameplay.dll',
  };
  const run = deriveRunDsConfig(committed, { templatePath: TEMPLATE_PATH, env, launch });
  assert.deepEqual(run.allocation, Object.fromEntries(ALLOCATION_KEYS.map((key) => [key, launch[key]])));
  assert.ok(!JSON.stringify(run).includes('secret-ticket'), 'the ticket itself never enters a config file');
  assert.equal(run.admission_public_key_hex, env.LUMIO_PLATFORM_ADMISSION_KEY);
  assert.equal(run.clr.hostfxr, resolve(env.LUMIO_HOSTFXR));
  assert.equal(run.clr.assembly, resolve(env.LUMIO_SERVER_HOSTENTRY_DLL));
  assert.equal(run.clr.runtime_config, resolve('/srv/HostEntry/Lumio.Server.HostEntry.runtimeconfig.json'));
  assert.equal(run.clr.engine_native, resolve(env.LUMIO_ENGINE_NATIVE));
  assert.equal(run.clr.registry_assembly, resolve(env.LUMIO_SAMPLE_GAMEPLAY_DLL));
  // Unset variables leave the template's value (made absolute) in place.
  assert.equal(run.clr.ecs_assembly, resolve(dirname(TEMPLATE_PATH), committed.clr.ecs_assembly));
  // A launch without the six claims (an injected test session) keeps the template's block.
  assert.deepEqual(deriveRunDsConfig(committed, { templatePath: TEMPLATE_PATH, launch: { admissionCredential: 'x' } }).allocation, committed.allocation);
});

test('a CLR input that is neither set nor on disk is BLOCKED_ENV naming its variable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sample-clr-inputs-'));
  const clr = {};
  for (const input of DS_CLR_INPUTS) {
    clr[input.field] = join(dir, `${input.field}.bin`);
    writeFileSync(clr[input.field], '');
  }
  assert.doesNotThrow(() => assertDsClrInputs({ clr }));
  for (const input of DS_CLR_INPUTS) {
    for (const value of [undefined, '', join(dir, 'gone', `${input.field}.bin`)]) {
      assert.throws(
        () => assertDsClrInputs({ clr: { ...clr, [input.field]: value } }),
        (error) => {
          assert.equal(error.code, 'BLOCKED_ENV');
          assert.match(error.message, new RegExp(`${input.env} is not set and DS config clr\\.${input.field} is not a file`));
          return true;
        },
      );
    }
  }
  // The committed template names no real machine's files, so it alone is always BLOCKED_ENV.
  assert.throws(() => assertDsClrInputs(deriveRunDsConfig(committed, { templatePath: TEMPLATE_PATH })), /LUMIO_ENGINE_NATIVE is not set/);
});

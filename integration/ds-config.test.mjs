import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { test } from 'node:test';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ALLOCATION_KEYS,
  PLACEHOLDER_PUBLIC_KEY,
  assertRunnableDsConfig,
  writeKernelConfigForRun,
} from './ds-config.mjs';

const committed = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
const sample = JSON.parse(readFileSync(new URL('../server.sample.json', import.meta.url), 'utf8'));

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
  const path = new URL('../server.json', import.meta.url);
  const copy = JSON.parse(readFileSync(path, 'utf8'));
  delete copy.clr.kernel_config;
  const dir = mkdtempSync(join(tmpdir(), 'sample-kernel-config-'));
  const input = join(dir, 'server.json');
  const output = join(dir, 'kernel-config.json');
  writeFileSync(input, `${JSON.stringify(copy)}\n`);
  assert.throws(() => writeKernelConfigForRun(input, output), /clr.kernel_config/);
});

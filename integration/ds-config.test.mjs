import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import {
  ALLOCATION_KEYS,
  PLACEHOLDER_PUBLIC_KEY,
  assertRunnableDsConfig,
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

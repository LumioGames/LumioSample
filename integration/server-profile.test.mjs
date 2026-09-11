import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  FROZEN_DURABILITY,
  FROZEN_ENTRY_METHOD,
  FROZEN_ENTRY_TYPE,
  FROZEN_WORLD_PROFILE,
  assertFrozenServerProfile,
  describeLocalOverlay,
  inspectBaseMap,
  loadCommittedServerJson,
  refusePlaceholderAsBaseMap,
} from './server-profile.mjs';

test('committed server.json is runtime+voxel snapshot_only with required base_map_*', () => {
  const config = loadCommittedServerJson();
  assert.equal(config.world_profile, FROZEN_WORLD_PROFILE);
  assert.equal(config.durability, FROZEN_DURABILITY);
  assert.notEqual(config.durability, 'process-crash');
  assert.notEqual(config.durability, 'power-loss');
  assert.equal(config.clr.entry_type, FROZEN_ENTRY_TYPE);
  assert.equal(config.clr.entry_method, FROZEN_ENTRY_METHOD);
  assert.match(config.base_map_content_sha256, /^[0-9a-f]{64}$/);
  assert.equal(config.transport.voxel_quota_bytes, 65536);
  const map = inspectBaseMap();
  assert.equal(config.base_map_content_sha256, map.sha256);
});

test('placeholder maps/sample.voxel is refused as a base map', () => {
  const map = inspectBaseMap();
  assert.equal(map.placeholder, true);
  assert.equal(map.restorable, false);
  assert.equal(map.blocked, true);
  assert.match(map.missingCommand, /no committed capture CLI/);
  assert.throws(() => refusePlaceholderAsBaseMap(), (error) => {
    assert.equal(error.code, 'BLOCKED_ENV');
    assert.match(error.message, /placeholder/);
    assert.match(error.message, /must not be treated as a base map|refuse it as a base map/);
    assert.doesNotMatch(error.message, /does not exist|not public/);
    return true;
  });
});

test('sha mismatch and retired durability are refused before treating bytes as a map', () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-server-profile-'));
  mkdirSync(join(isolated, 'maps'), { recursive: true });
  const fakeBytes = Buffer.from('canonical-looking-but-invented-bytes');
  writeFileSync(join(isolated, 'maps', 'sample.voxel'), fakeBytes);
  const config = {
    world_profile: 'runtime+voxel',
    durability: 'snapshot_only',
    base_map_id: 'sample',
    base_map_version: '0.1.0-placeholder',
    base_map_content_sha256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    clr: {
      entry_type: FROZEN_ENTRY_TYPE,
      entry_method: FROZEN_ENTRY_METHOD,
    },
  };
  assert.throws(
    () => assertFrozenServerProfile(config, isolated),
    /base_map_content_sha256 must match/,
  );
  config.base_map_content_sha256 = createHash('sha256').update(fakeBytes).digest('hex');
  config.durability = 'process-crash';
  assert.throws(
    () => assertFrozenServerProfile(config, isolated),
    /snapshot_only/,
  );
  config.durability = 'snapshot_only';
  config.base_map_version = '0.1.0-placeholder';
  assert.throws(
    () => assertFrozenServerProfile(config, isolated),
    (error) => error.code === 'BLOCKED_ENV',
  );
});

test('local overlay documentation names the gitignored .run file', () => {
  const overlay = describeLocalOverlay();
  assert.equal(overlay.committed, 'server.json');
  assert.equal(overlay.overlay, '.run/server.local.json');
  assert.match(overlay.note, /gitignored/);
  assert.match(overlay.note, /runtime-only/);
});

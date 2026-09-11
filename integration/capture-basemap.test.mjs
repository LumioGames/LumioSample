import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectVoxelCaptureApi, inspectPlaceholderMap, runCapture } from './capture-basemap.mjs';
import { loadCommittedServerJson } from './server-profile.mjs';

test('committed sample.voxel is a placeholder and is not restorable', () => {
  const map = inspectPlaceholderMap();
  assert.equal(map.placeholder, true);
  assert.equal(map.restorable, false);
  assert.equal(map.blocked, true);
  assert.match(map.sha256, /^[0-9a-f]{64}$/);
  assert.equal(loadCommittedServerJson().base_map_content_sha256, map.sha256);
});

test('capture API exists but Sample consume is not wired so the script stays BLOCKED_ENV', () => {
  const api = detectVoxelCaptureApi();
  assert.equal(api.writeCell, false);
  assert.equal(api.capture, true);
  assert.equal(api.restore, true);
  assert.match(api.reason, /consume/);
  assert.match(api.missingCommand, /no committed capture CLI/);
  assert.doesNotMatch(api.reason, /does not exist|not public/);
  assert.throws(() => runCapture(), (error) => {
    assert.equal(error.code, 'BLOCKED_ENV');
    assert.match(error.message, /placeholder/);
    assert.match(error.message, /must not be treated as a base map/);
    assert.match(error.message, /Missing command/);
    return true;
  });
});

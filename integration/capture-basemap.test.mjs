import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detectVoxelCaptureApi, inspectPlaceholderMap, runCapture } from './capture-basemap.mjs';

test('committed sample.voxel is a placeholder and is not restorable', () => {
  const map = inspectPlaceholderMap();
  assert.equal(map.placeholder, true);
  assert.equal(map.restorable, false);
});

test('capture API exists but Sample consume is not wired so the script stays BLOCKED_ENV', () => {
  const api = detectVoxelCaptureApi();
  assert.equal(api.writeCell, false);
  assert.equal(api.capture, true);
  assert.equal(api.restore, true);
  assert.match(api.reason, /consume/);
  assert.doesNotMatch(api.reason, /does not exist|not public/);
  assert.throws(() => runCapture(), (error) => error.code === 'BLOCKED_ENV');
});

import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  captureArgs,
  detectVoxelCaptureApi,
  inspectPlaceholderMap,
  loadLayout,
  runCapture,
} from './capture-basemap.mjs';
import { loadCommittedServerJson } from './server-profile.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('committed sample.voxel is a restoreable VoxelEngine capture', () => {
  const map = inspectPlaceholderMap();
  assert.equal(map.placeholder, false);
  assert.equal(map.restorable, true);
  assert.equal(map.blocked, false);
  assert.match(map.sha256, /^[0-9a-f]{64}$/);
  assert.equal(loadCommittedServerJson().base_map_content_sha256, map.sha256);
  const bytes = readFileSync(new URL('../maps/sample.voxel', import.meta.url));
  assert.ok(bytes.includes(Buffer.from('LUMIOSNP1')));
  assert.equal(bytes.toString('utf8').includes('do-not-restore: true'), false);
  assert.equal(bytes.toString('utf8').includes('BLOCKED: this is not a restoreable VoxelEngine capture'), false);
});

test('layout config names W×D and the vein; capture args call the Engine CLI', () => {
  const layout = loadLayout(ROOT);
  assert.equal(layout.width, 32);
  assert.equal(layout.depth, 32);
  assert.deepEqual(layout.vein, { x: 1, z: 1, width: 2, depth: 2 });
  const args = captureArgs(layout, '/tmp/out.voxel');
  assert.deepEqual(args.slice(0, 6), ['--width', '32', '--depth', '32', '--vein', '1,1,2,2']);
  assert.ok(args.includes('--verify-restore'));
});

test('gameplay and DS sources do not import the layout script', () => {
  const gameplayRoot = resolve(ROOT, 'src', 'Lumio.Sample.Gameplay');
  const hits = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      const info = statSync(path);
      if (info.isDirectory()) {
        walk(path);
        continue;
      }
      if (!name.endsWith('.cs') && !name.endsWith('.csproj')) continue;
      const text = readFileSync(path, 'utf8');
      if (text.includes('capture-basemap') || text.includes('sample.layout.json')) hits.push(path);
    }
  };
  walk(gameplayRoot);
  assert.deepEqual(hits, []);
  const launcher = readFileSync(new URL('launcher.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(launcher, /from '\.\/capture-basemap\.mjs'/);
  const dsConfig = readFileSync(new URL('../server.json', import.meta.url), 'utf8');
  assert.doesNotMatch(dsConfig, /capture-basemap|sample\.layout\.json/);
});

test('missing Engine capture CLI stays BLOCKED_ENV and does not invent an encoder', () => {
  const isolatedRoot = mkdtempSync(join(tmpdir(), 'lumio-capture-missing-'));
  const api = detectVoxelCaptureApi({
    env: { LUMIO_ENGINE_ROOT: '/no-such-engine' },
    repoRoot: isolatedRoot,
  });
  assert.equal(api.cli, null);
  assert.equal(api.capture, false);
  assert.match(api.missingCommand, /capture-voxel\.mjs/);
  assert.throws(
    () => runCapture({ env: { LUMIO_ENGINE_ROOT: '/no-such-engine' }, repoRoot: isolatedRoot }),
    (error) => {
      assert.equal(error.code, 'BLOCKED_ENV');
      assert.match(error.message, /Missing command|cannot be recaptured/);
      return true;
    },
  );
  const source = readFileSync(new URL('capture-basemap.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /function encodeVoxel|invent.*snapshot/);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MAP_BOUNDS, buildAcceptanceMap, createCodec } from './acceptance-map.mjs';
import { buildOfficialCatalog, loadLayout } from './official-catalog.mjs';

// B-00121: the acceptance DS runs acceptance-lakeside.voxel (32 x 16) with its own server-end
// config profile, whose map row names an admission pose on that map — in front of the lakeside
// house door, standing on the ground — instead of the default sample.voxel pose (16.5, 1.5, 16.5),
// which lies outside this map and left every move `physics_unresolved`.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STARTUP = join(ROOT, 'Server', 'Config', 'Startup');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));
const spawnOf = (configDir) => {
  const table = readJson(join(configDir, 'server', 'map.json'));
  assert.equal(table.rows.length, 1, 'Sample binds exactly one map row');
  const { spawn_x: x, spawn_y: y, spawn_z: z } = table.rows[0];
  return { x, y, z };
};
const sweepRadius = () => readJson(join(ROOT, 'Server', 'Config', 'Tables', 'server', 'movement.json')).rows[0].sweep_radius_meters;

const catalog = buildOfficialCatalog(loadLayout(ROOT));
const codec = createCodec(catalog);
const map = buildAcceptanceMap(catalog);
const cells = new Map(map.cells.map((cell) => [`${cell.x},${cell.y},${cell.z}`, cell]));
const nameAt = (x, y, z) => {
  const cell = cells.get(`${x},${y},${z}`);
  return cell ? codec.decode(cell.blockId).name : 'air';
};

test('the acceptance DS config reads the acceptance profile export', () => {
  const acceptance = readJson(join(STARTUP, 'server.acceptance.json'));
  assert.equal(resolve(STARTUP, acceptance.config_dir), join(ROOT, 'Server', 'Config', 'Profiles', 'acceptance'));
  assert.equal(acceptance.base_map_path, '../../Assets/Maps/acceptance-lakeside.voxel');
  // The default DS keeps the default export and its pose.
  const standard = readJson(join(STARTUP, 'server.json'));
  assert.equal(resolve(STARTUP, standard.config_dir), join(ROOT, 'Server', 'Config', 'Tables'));
  assert.deepEqual(spawnOf(join(ROOT, 'Server', 'Config', 'Tables')), { x: 16.5, y: 1.5, z: 16.5 });
});

test('the acceptance admission pose stands on the ground in front of the house door, inside the map', () => {
  const spawn = spawnOf(join(ROOT, 'Server', 'Config', 'Profiles', 'acceptance'));
  const r = sweepRadius();
  for (const axis of ['x', 'y', 'z']) {
    assert.ok(spawn[axis] - r >= MAP_BOUNDS.min[axis] && spawn[axis] + r <= MAP_BOUNDS.max[axis] + 1,
      `spawn ${axis}=${spawn[axis]} must keep the movement AABB inside the map`);
  }
  // Every cell the movement AABB touches is open air.
  for (let x = Math.floor(spawn.x - r); x <= Math.floor(spawn.x + r); x++)
    for (let y = Math.floor(spawn.y - r); y <= Math.floor(spawn.y + r); y++)
      for (let z = Math.floor(spawn.z - r); z <= Math.floor(spawn.z + r); z++)
        assert.equal(nameAt(x, y, z), 'air', `AABB cell (${x},${y},${z}) must be air`);
  // Standing on the ground: the cell right under the pose's cell is a ground block.
  const [cx, cy, cz] = [Math.floor(spawn.x), Math.floor(spawn.y), Math.floor(spawn.z)];
  assert.equal(nameAt(cx, cy - 1, cz), 'lumio.grass_block');
  // In front of the door: the house door is a few cells north (-z) in the same column.
  const doorDistance = [1, 2, 3].find((d) => nameAt(cx, cy + 1, cz - d) === 'lumio.oak_door');
  assert.ok(doorDistance, `no lumio.oak_door within three cells north of (${cx},${cy + 1},${cz})`);
});

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ACCEPTANCE_BLOCK_NAMES,
  CELLS_RELATIVE,
  MAP_BOUNDS,
  POINTS_RELATIVE,
  buildAcceptanceMap,
  createCodec,
  serializeCells,
  serializePoints,
  shapeOf,
} from './acceptance-map.mjs';
import { buildOfficialCatalog, loadLayout, stateFields } from './official-catalog.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const catalog = buildOfficialCatalog(loadLayout(ROOT));
const codec = createCodec(catalog);
const map = buildAcceptanceMap(catalog);
const key = (x, y, z) => `${x},${y},${z}`;
const cellAt = new Map(map.cells.map((cell) => [key(cell.x, cell.y, cell.z), cell]));
const nameAt = (x, y, z) => {
  const cell = cellAt.get(key(x, y, z));
  return cell ? codec.decode(cell.blockId).name : 'air';
};

// C0 block list (ADR-124 r1 C0): every one of these must be on the map.
const C0_NAMES = [
  'lumio.stone', 'lumio.hard_wall', 'lumio.ore', 'lumio.dirt', 'lumio.grass_block', 'lumio.oak_planks',
  'lumio.oak_log', 'lumio.oak_leaves', 'lumio.glass', 'lumio.blue_stained_glass', 'lumio.ice',
  'lumio.glowstone', 'lumio.water', 'lumio.lava', 'lumio.oak_stairs', 'lumio.oak_slab', 'lumio.oak_door',
  'lumio.oak_fence', 'lumio.glass_pane', 'lumio.iron_bars', 'lumio.torch', 'lumio.poppy',
  'lumio.short_grass', 'lumio.oak_sapling',
];

test('generation is deterministic and the committed files are the generator output', () => {
  const again = buildAcceptanceMap(buildOfficialCatalog(loadLayout(ROOT)));
  assert.equal(serializeCells(again), serializeCells(map));
  assert.equal(serializePoints(again), serializePoints(map));
  assert.equal(readFileSync(resolve(ROOT, CELLS_RELATIVE), 'utf8'), serializeCells(map));
  assert.equal(readFileSync(resolve(ROOT, POINTS_RELATIVE), 'utf8'), serializePoints(map));
});

test('cells file is eng/capture-voxel input: {cells:[{x,y,z,blockId}]} sorted y, z, x without duplicates', () => {
  const parsed = JSON.parse(serializeCells(map));
  assert.ok(Array.isArray(parsed.cells));
  assert.ok(parsed.cells.length > 1000);
  let previous = -1;
  for (const cell of parsed.cells) {
    assert.deepEqual(Object.keys(cell), ['x', 'y', 'z', 'blockId']);
    assert.ok(Number.isInteger(cell.blockId) && cell.blockId > 0 && cell.blockId <= 0xffffffff);
    assert.ok(cell.y >= 0 && cell.y <= 255);
    const order = cell.y * 1_000_000 + cell.z * 1000 + cell.x;
    assert.ok(order > previous, 'sorted and unique');
    previous = order;
  }
});

test('the map stays inside its bounds, in two Sections', () => {
  const sections = new Set();
  for (const { x, y, z } of map.cells) {
    assert.ok(x >= MAP_BOUNDS.min.x && x <= MAP_BOUNDS.max.x);
    assert.ok(y >= MAP_BOUNDS.min.y && y <= MAP_BOUNDS.max.y);
    assert.ok(z >= MAP_BOUNDS.min.z && z <= MAP_BOUNDS.max.z);
    sections.add(key(x >> 4, y >> 4, z >> 4));
  }
  assert.deepEqual([...sections].sort(), ['0,0,0', '1,0,0']);
  assert.deepEqual(map.points.sections, [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }]);
});

test('every block of the C0 list is on the map, and nothing else', () => {
  assert.deepEqual([...ACCEPTANCE_BLOCK_NAMES], C0_NAMES);
  const seen = new Set(map.cells.map((cell) => codec.decode(cell.blockId).name));
  for (const name of C0_NAMES) assert.ok(seen.has(name), `${name} missing`);
  assert.deepEqual([...seen].filter((name) => !C0_NAMES.includes(name)), []);
  assert.deepEqual(Object.keys(map.points.blocks), C0_NAMES);
  for (const [name, at] of Object.entries(map.points.blocks)) {
    assert.equal(nameAt(at.x, at.y, at.z), name, `sample for ${name}`);
  }
});

test('every BlockState field is in range and no bit above the layout is set', () => {
  for (const cell of map.cells) {
    const row = catalog.rows[(cell.blockId >>> 8) - 256];
    assert.ok(row, `blockType ${cell.blockId >>> 8} is a catalog row`);
    const state = cell.blockId & 0xff;
    const fields = stateFields(row);
    const total = fields.reduce((sum, f) => sum + f.width, 0);
    assert.equal(state >>> total, 0, `${row.name} state ${state} sets bits above ${total}`);
    for (const field of fields) {
      const value = (state >>> field.offset) & ((1 << field.width) - 1);
      assert.ok(value < field.count, `${row.name}.${field.name} = ${value}`);
    }
  }
});

test('door halves agree: lower Up = 0 under upper Up = 1, same Direction / Open / RightHinge', () => {
  const doors = map.cells.filter((cell) => codec.decode(cell.blockId).name === 'lumio.oak_door');
  assert.ok(doors.length >= 2);
  let lowers = 0;
  for (const cell of doors) {
    const { fields } = codec.decode(cell.blockId);
    const otherY = fields.Up === 0 ? cell.y + 1 : cell.y - 1;
    const other = cellAt.get(key(cell.x, otherY, cell.z));
    assert.ok(other, `door at ${key(cell.x, cell.y, cell.z)} has no other half`);
    const mate = codec.decode(other.blockId);
    assert.equal(mate.name, 'lumio.oak_door');
    assert.equal(mate.fields.Up, 1 - fields.Up);
    for (const f of ['Direction', 'Open', 'RightHinge']) assert.equal(mate.fields[f], fields[f], f);
    if (fields.Up === 0) lowers += 1;
  }
  assert.equal(lowers * 2, doors.length);
  // The house door is closed, the garden gate is open.
  const opens = new Set(doors.map((cell) => codec.decode(cell.blockId).fields.Open));
  assert.deepEqual([...opens].sort(), [0, 1]);
});

// Contract transform vectors (LumioGameEngine af56fb1 engine/wire/voxel-world-v1.json shapeTable.transformVectors).
test('shape transform reproduces the contract transform vectors', () => {
  const stairs = catalog.rows.find((row) => row.name === 'lumio.oak_stairs');
  const door = catalog.rows.find((row) => row.name === 'lumio.oak_door');
  const st = catalog.shapeTable;
  assert.deepEqual(shapeOf(stairs, st['lumio.oak_stairs'], 1).boxes, [[0, 0, 0, 16, 8, 16], [8, 8, 0, 16, 16, 16]]);
  assert.deepEqual(shapeOf(stairs, st['lumio.oak_stairs'], 6).boxes, [[0, 8, 0, 16, 16, 16], [0, 0, 8, 16, 8, 16]]);
  assert.deepEqual(shapeOf(stairs, st['lumio.oak_stairs'], 17).boxes,
    [[0, 0, 0, 16, 8, 16], [8, 8, 0, 16, 16, 16], [0, 8, 8, 8, 16, 16]]);
  assert.deepEqual(shapeOf(door, st['lumio.oak_door'], 4).boxes, [[0, 0, 0, 3, 16, 16]]);
  assert.deepEqual(shapeOf(door, st['lumio.oak_door'], 13).boxes, [[0, 0, 13, 16, 16, 16]]);
  const mount = { behaviorTemplate: 'Model', stateLayout: { directions: 'C1F0B0L0R0', subShapeNum: 1 } };
  const mountEntry = [{ boxes: [[7, 0, 7, 9, 10, 9]], crosses: [] }];
  assert.deepEqual(shapeOf(mount, mountEntry, 1).boxes, [[7, 7, 0, 9, 9, 10]]);
  assert.deepEqual(shapeOf(mount, mountEntry, 2).boxes, [[7, 7, 6, 9, 9, 16]]);
  assert.deepEqual(shapeOf(mount, mountEntry, 3).boxes, [[0, 7, 7, 10, 9, 9]]);
  assert.deepEqual(shapeOf(mount, mountEntry, 4).boxes, [[6, 7, 7, 16, 9, 9]]);
  const flame = { behaviorTemplate: 'Model', stateLayout: { directions: 'C1F0', subShapeNum: 1 } };
  assert.deepEqual(shapeOf(flame, [{ boxes: [], crosses: [[6, 0, 6, 10, 10, 10]] }], 1).crossPlanes, [
    [[6, 10, 0], [10, 6, 0], [10, 6, 10], [6, 10, 10]],
    [[6, 6, 0], [10, 10, 0], [10, 10, 10], [6, 6, 10]],
  ]);
  const turntable = { behaviorTemplate: 'Model', stateLayout: { subShapeNum: 1, yawSplitNum: 4 } };
  assert.deepEqual(shapeOf(turntable, [{ boxes: [[0, 0, 0, 16, 8, 8]], crosses: [] }], 1).boxes, [[8, 0, 0, 16, 8, 16]]);
  const fence = catalog.rows.find((row) => row.name === 'lumio.oak_fence');
  const arms = shapeOf(fence, st['lumio.oak_fence'], 0, { north: true, east: false, south: true, west: false }).boxes;
  assert.deepEqual(arms, [...st['lumio.oak_fence'][0].boxes, ...st['lumio.oak_fence'][1].boxes, ...st['lumio.oak_fence'][3].boxes]);
});

function upperQuarters(boxes) {
  const quarters = [];
  for (const [qx, qz, label] of [[0, 0, 'NW'], [8, 0, 'NE'], [0, 8, 'SW'], [8, 8, 'SE']]) {
    const covered = boxes.some(([x0, y0, z0, x1, y1, z1]) => x0 <= qx && x1 >= qx + 8 && z0 <= qz && z1 >= qz + 8 && y0 <= 8 && y1 >= 16);
    if (covered) quarters.push(label);
  }
  return quarters;
}

test('eaves stairs: each corner SubShapeId agrees with the roof and the neighbouring stairs', () => {
  const stairsRow = catalog.rows.find((row) => row.name === 'lumio.oak_stairs');
  const entry = catalog.shapeTable['lumio.oak_stairs'];
  const eaves = map.cells.filter((cell) => codec.decode(cell.blockId).name === 'lumio.oak_stairs' && cell.y === 7);
  assert.ok(eaves.length > 20);
  const kinds = new Map();
  for (const cell of eaves) {
    const shape = shapeOf(stairsRow, entry, cell.blockId & 0xff);
    assert.ok(shape.boxes.some((b) => b.join() === '0,0,0,16,8,16'), 'lower half is a full slab');
    const roof = (dx, dz) => nameAt(cell.x + dx, cell.y, cell.z + dz) === 'lumio.oak_planks';
    const expected = [];
    for (const [dx, dz, label] of [[-1, -1, 'NW'], [1, -1, 'NE'], [-1, 1, 'SW'], [1, 1, 'SE']]) {
      if (roof(dx, 0) || roof(0, dz) || roof(dx, dz)) expected.push(label);
    }
    assert.deepEqual(upperQuarters(shape.boxes), expected, `stairs at ${key(cell.x, cell.y, cell.z)}`);
    const sub = codec.decode(cell.blockId).fields.SubShapeId;
    const kind = sub === 0 ? 'straight' : sub <= 2 ? 'inner' : 'outer';
    assert.equal(kind, expected.length === 2 ? 'straight' : expected.length === 3 ? 'inner' : 'outer');
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
    // A neighbouring eaves stair continues the raised part along the shared edge.
    for (const [dx, dz, mine, theirs] of [[1, 0, ['NE', 'SE'], ['NW', 'SW']], [0, 1, ['SW', 'SE'], ['NW', 'NE']]]) {
      const other = cellAt.get(key(cell.x + dx, cell.y, cell.z + dz));
      if (!other || codec.decode(other.blockId).name !== 'lumio.oak_stairs') continue;
      const theirQuarters = upperQuarters(shapeOf(stairsRow, entry, other.blockId & 0xff).boxes);
      const a = mine.map((q) => upperQuarters(shape.boxes).includes(q));
      const b = theirs.map((q) => theirQuarters.includes(q));
      assert.ok(a.some(Boolean) === b.some(Boolean), `raised part breaks between ${key(cell.x, cell.y, cell.z)} and its neighbour`);
    }
  }
  assert.ok(kinds.get('outer') >= 4, 'outer corners');
  assert.ok(kinds.get('inner') >= 1, 'inner corner');
  assert.ok(kinds.get('straight') >= 10, 'straight runs');
});

test('points name a coordinate for every ADR-124 verification item that needs the map', () => {
  const ids = map.points.points.map((point) => point.id);
  for (const required of [
    'mesh.stone_wall_single_quad',
    'cull.stone_wall_beside_lower_slab',
    'cull.leaves_beside_leaves',
    'cull.water_beside_lava',
    'cull.water_beside_glass',
    'connected.pane_and_bars_segment',
    'connected.section_border_unresolved',
    'connected.fence_toggle_full_block',
    'connected.fence_beside_full_block',
    'shape.door_closed_blocks',
    'shape.door_open_passable',
    'shape.stairs_walk_up',
    'shape.slab_step',
    'shape.eaves_ring',
    'collision.blocks',
    'collision.passes_through',
    'light.torch_falloff',
    'light.glowstone_neighbours',
    'light.lava_source',
    'light.roof_blocks_skylight',
    'light.leaves_keep_skylight',
    'render.grass_block_sides',
    'render.stained_glass_shows_lake',
  ]) {
    assert.ok(ids.includes(required), `point ${required}`);
  }
  assert.equal(new Set(ids).size, ids.length);
  for (const point of map.points.points) {
    assert.ok(point.verify && point.expect, point.id);
    assert.ok(point.cells.length > 0, point.id);
    for (const cell of point.cells) {
      assert.equal(nameAt(cell.x, cell.y, cell.z), cell.block, `${point.id} at ${key(cell.x, cell.y, cell.z)}`);
    }
  }
  const covered = new Set(map.points.cameras.flatMap((camera) => camera.covers));
  for (const name of C0_NAMES) assert.ok(covered.has(name), `a camera covers ${name}`);
});

// B-00122: sky light spreads sideways (ADR-124, Owner 2026-09-25), so the roof point is a
// "spread in through door / windows" probe, not "0 under the roof". The native evidence tool
// (LumioGameEngine eng/voxel-evidence) judges the values against the linked VoxelEngine: 12, 11.
test('roof skylight point probes cells under the roof and expects the sideways-spread values', () => {
  const point = map.points.points.find((p) => p.id === 'light.roof_blocks_skylight');
  assert.ok(point);
  const inside = point.cells.filter((cell) => cell.block === 'air');
  assert.equal(inside.length, 2);
  for (const cell of inside) {
    let covered = false;
    for (let y = cell.y + 1; y <= MAP_BOUNDS.max.y; y += 1) {
      if (nameAt(cell.x, y, cell.z) !== 'air') covered = true;
    }
    assert.ok(covered, `${key(cell.x, cell.y, cell.z)} has a roof above it (column value 0)`);
  }
  assert.match(point.expect, /12、11/);
  assert.doesNotMatch(point.expect, /天光 = 0|不横向扩散/);
});

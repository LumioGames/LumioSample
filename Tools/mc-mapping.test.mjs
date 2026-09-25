import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MAPPING_PATH, mappingDocument, mcNames, renderMapping } from './mc-mapping.mjs';
import { CATALOG_RELATIVE, directionList, loadOfficialCatalog, stateFields } from './official-catalog.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const MC_IMPORT_DIR = dirname(MAPPING_PATH);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

test('committed mc-mapping.json is exactly what Tools/mc-mapping.mjs generates', () => {
  assert.equal(readFileSync(MAPPING_PATH, 'utf8'), renderMapping(),
    'run `node Tools/mc-mapping.mjs` and re-run assess; the mapping file is generated, not hand-edited');
});

test('every rule targets an official catalog block or air, with fields the target actually has', () => {
  const rows = new Map(loadOfficialCatalog().rows.map((row) => [row.name, row]));
  const derive = mappingDocument.derive;
  for (const rule of mappingDocument.rules) {
    const where = `${JSON.stringify(rule.mc).slice(0, 60)} -> ${rule.to}`;
    assert.ok(['exact', 'degraded', 'dropped'].includes(rule.tier), `${where}: tier`);
    if (rule.to === 'air') {
      assert.equal(rule.fields, undefined, `${where}: air takes no fields`);
      assert.equal(rule.derive, undefined, `${where}: air takes no derive`);
      continue;
    }
    const row = rows.get(rule.to);
    assert.ok(row, `${where}: not in ${CATALOG_RELATIVE} (no new blocks from this card)`);
    const fields = new Map(stateFields(row).map((f) => [f.name, f]));
    const directions = row.stateLayout.directions === undefined ? [] : directionList(row.stateLayout);
    const check = (name, value) => {
      const field = fields.get(name);
      assert.ok(field, `${where}: ${row.name} has no BlockState field ${name}`);
      if (name === 'Direction') {
        assert.ok(directions.includes(value), `${where}: direction ${value} not allowed on ${row.name}`);
      } else {
        assert.ok(Number.isInteger(value) && value >= 0 && value < field.count,
          `${where}: ${name}=${value} out of range 0..${field.count - 1}`);
      }
    };
    for (const [name, value] of Object.entries(rule.fields ?? {})) check(name, value);
    if (rule.derive !== undefined) {
      const group = derive[rule.derive];
      assert.ok(group, `${where}: unknown derive group ${rule.derive}`);
      for (const [name, spec] of Object.entries(group)) {
        for (const value of Object.values(spec.map)) check(name, value);
      }
    }
  }
});

test('no MC name appears twice with the same `when` (the tool would refuse the table)', () => {
  const seen = new Set();
  for (const rule of mappingDocument.rules) {
    const when = JSON.stringify(Object.entries(rule.when ?? {}).sort());
    for (const name of Array.isArray(rule.mc) ? rule.mc : [rule.mc]) {
      const key = `${name} ${when}`;
      assert.ok(!seen.has(key), `duplicate row ${key}`);
      seen.add(key);
    }
  }
  assert.ok(mcNames().size > 0);
});

test('committed import reports were produced from this mapping and catalog, with nothing unmapped', () => {
  const mappingSha = sha256(readFileSync(MAPPING_PATH));
  const catalogSha = sha256(readFileSync(join(ROOT, CATALOG_RELATIVE)));
  const reports = readdirSync(MC_IMPORT_DIR).filter((f) => f.endsWith('.import-report.json'));
  assert.ok(reports.length >= 2, `expected at least two reports, found ${reports}`);
  for (const file of reports) {
    const text = readFileSync(join(MC_IMPORT_DIR, file), 'utf8');
    const report = JSON.parse(text);
    assert.equal(report.mappingSha256, mappingSha, `${file}: stale mapping sha; re-run assess`);
    assert.equal(report.catalogSha256, catalogSha, `${file}: stale catalog sha; re-run assess`);
    assert.equal(report.lenient, false, `${file}: must be a strict run`);
    assert.equal(report.tiers.unmapped, 0, `${file}: unmapped`);
    assert.deepEqual(report.unmapped, [], `${file}: unmapped list`);
    assert.ok(!/"\/|[A-Za-z]:\\\\/.test(text), `${file}: absolute path in report`);
  }
});

test('mc-import holds no MC save data or converted maps', () => {
  const allowed = /^(mc-mapping\.json|[a-z0-9.-]+\.import-report\.json|README\.md|SOURCES\.md)$/;
  for (const file of readdirSync(MC_IMPORT_DIR)) {
    assert.match(file, allowed, `${file} does not belong in mc-import (no .mca / .mcc / .voxel / MC assets)`);
  }
});

// ---- 映射语义：按契约的变换把我们的方块算成几何，与 MC 原版几何逐项对照
//
// 我们这一侧只照 LumioGameEngine `engine/wire/voxel-world-v1.json` 写：
// /shapeTable/transform/primitives（Yaw、MirrorY、MirrorX、WallNorth）、/shapeTable/transform/byDirection、
// /shapeTable/transform/composition（Model、Door）、/shapeTable/doorHinge、
// /blockId/stateLayout/fields/HeightLevel；子形状用本游戏目录的 shapeTable（与契约 fixtureShapeTable 的
// 楼梯、门同形）。MC 一侧是原版行为：楼梯按 facing 那半边加左右（左 = facing 俯视逆时针转 90°）的
// 四分之一块、上下半只交换台阶与台面的高度；墙上火把的 facing 是火苗朝向，挂在反方向的墙上；门按
// DoorBlock 的碰撞盒（facing 东关着贴 x 0 ~ 3，开着按 hinge 贴北或南沿）；液位 0 源头、1 ~ 7 离源头格数、
// 8 ~ 15 下落。
const identity = (p) => p;
const Yaw = ([x, y, z]) => [16 - z, y, x];
const MirrorY = ([x, y, z]) => [x, 16 - y, z];
const MirrorX = ([x, y, z]) => [16 - x, y, z];
const WallNorth = ([x, y, z]) => [x, 16 - z, y];
const times = (f, n) => (p) => { let q = p; for (let i = 0; i < n; i += 1) q = f(q); return q; };
/** `compose(A, B)` = A ∘ B：先做 B。 */
const compose = (...fs) => (p) => fs.reduceRight((q, f) => f(q), p);

function byDirection(shorthand) {
  const r = Number(shorthand[1]);
  switch (shorthand[0]) {
    case 'C': return r === 2 ? MirrorY : identity;
    case 'D': return times(Yaw, r);
    case 'U': return compose(times(Yaw, r), MirrorY);
    case 'F': return compose(WallNorth, times(Yaw, r));
    case 'R': return compose(Yaw, WallNorth, times(Yaw, r));
    case 'B': return compose(times(Yaw, 2), WallNorth, times(Yaw, r));
    case 'L': return compose(times(Yaw, 3), WallNorth, times(Yaw, r));
    default: throw new Error(`unknown direction ${shorthand}`);
  }
}

function transformBox(t, [x0, y0, z0, x1, y1, z1]) {
  const a = t([x0, y0, z0]);
  const b = t([x1, y1, z1]);
  return [0, 1, 2].map((i) => Math.min(a[i], b[i])).concat([0, 1, 2].map((i) => Math.max(a[i], b[i])));
}

/** 方盒并集占了哪些 8×8×8 的八分块（楼梯的方盒都对齐八分块）。 */
function octets(boxes) {
  const out = new Set();
  for (let ox = 0; ox < 2; ox += 1) for (let oy = 0; oy < 2; oy += 1) for (let oz = 0; oz < 2; oz += 1) {
    const [cx, cy, cz] = [ox * 8 + 4, oy * 8 + 4, oz * 8 + 4];
    if (boxes.some(([x0, y0, z0, x1, y1, z1]) => cx > x0 && cx < x1 && cy > y0 && cy < y1 && cz > z0 && cz < z1)) {
      out.add(`${ox}${oy}${oz}`);
    }
  }
  return [...out].sort();
}

const HORIZONTAL = ['north', 'east', 'south', 'west'];
const clockwise = (d) => HORIZONTAL[(HORIZONTAL.indexOf(d) + 1) % 4];
const counterClockwise = (d) => HORIZONTAL[(HORIZONTAL.indexOf(d) + 3) % 4];
/** 水平四分块 (qx, qz) 在 d 那一侧：北 z 小、南 z 大、西 x 小、东 x 大。 */
const onSide = (d, qx, qz) => ({ north: qz === 0, south: qz === 1, west: qx === 0, east: qx === 1 })[d];

function mcStairOctets(facing, half, shape) {
  const left = counterClockwise(facing);
  const right = clockwise(facing);
  const step = {
    straight: (qx, qz) => onSide(facing, qx, qz),
    outer_left: (qx, qz) => onSide(facing, qx, qz) && onSide(left, qx, qz),
    outer_right: (qx, qz) => onSide(facing, qx, qz) && onSide(right, qx, qz),
    inner_left: (qx, qz) => onSide(facing, qx, qz) || onSide(left, qx, qz),
    inner_right: (qx, qz) => onSide(facing, qx, qz) || onSide(right, qx, qz),
  }[shape];
  const slabY = half === 'bottom' ? 0 : 1;
  const out = [];
  for (let qx = 0; qx < 2; qx += 1) for (let qz = 0; qz < 2; qz += 1) {
    out.push(`${qx}${slabY}${qz}`);
    if (step(qx, qz)) out.push(`${qx}${1 - slabY}${qz}`);
  }
  return out.sort();
}

const catalogDoc = () => JSON.parse(readFileSync(join(ROOT, CATALOG_RELATIVE), 'utf8'));
const catalogRow = (doc, name) => doc.rows.find((row) => row.name === name);

test('stairs: facing / half / shape land on the same quarters as MC (incl. left/right on half=top)', () => {
  const doc = catalogDoc();
  const row = catalogRow(doc, 'lumio.oak_stairs');
  const subShapes = doc.shapeTable['lumio.oak_stairs'];
  assert.equal(subShapes.length, row.stateLayout.subShapeNum);
  const { Direction, SubShapeId } = mappingDocument.derive.stairs;
  assert.deepEqual(Direction.props, ['half', 'facing']);
  assert.deepEqual(SubShapeId.props, ['shape']);
  for (const half of ['bottom', 'top']) {
    for (const facing of HORIZONTAL) {
      for (const shape of ['straight', 'inner_left', 'inner_right', 'outer_left', 'outer_right']) {
        const direction = Direction.map[`${half},${facing}`];
        const sub = SubShapeId.map[shape];
        assert.ok(directionList(row.stateLayout).includes(direction), `${direction} allowed on stairs`);
        const t = byDirection(direction);
        const ours = octets(subShapes[sub].boxes.map((b) => transformBox(t, b)));
        assert.deepEqual(ours, mcStairOctets(facing, half, shape),
          `stairs facing=${facing} half=${half} shape=${shape} -> ${direction} SubShapeId ${sub}`);
      }
    }
  }
});

test('wall torch: MC facing is the flame direction, so the torch hangs on the opposite wall', () => {
  const doc = catalogDoc();
  const row = catalogRow(doc, 'lumio.torch');
  const map = mappingDocument.derive.wall_torch.Direction.map;
  // 书写姿态的底面中心 (8, 0, 8) 是贴附点：变换后必须落在支撑墙面上。
  const wallFace = { north: [8, 8, 0], south: [8, 8, 16], west: [0, 8, 8], east: [16, 8, 8] };
  const opposite = { north: 'south', south: 'north', east: 'west', west: 'east' };
  for (const facing of HORIZONTAL) {
    const direction = map[facing];
    assert.ok(directionList(row.stateLayout).includes(direction), `${direction} allowed on lumio.torch`);
    assert.deepEqual(byDirection(direction)([8, 0, 8]), wallFace[opposite[facing]],
      `wall_torch facing=${facing} -> ${direction} must hang on the ${opposite[facing]} wall`);
  }
  // 地上的火把（C1）底面仍贴地。
  const floor = mappingDocument.rules.find((r) => r.mc === 'minecraft:torch');
  assert.deepEqual(byDirection(floor.fields.Direction)([8, 0, 8]), [8, 0, 8]);
});

test('door: facing / hinge / open / half give the same panel as MC DoorBlock', () => {
  const doc = catalogDoc();
  const row = catalogRow(doc, 'lumio.oak_door');
  const [closed, opened] = doc.shapeTable['lumio.oak_door'];
  const { Direction, Open, RightHinge, Up } = mappingDocument.derive.door;
  // MC DoorBlock 的四块板，名字是「关着时朝这个方向」的那块。
  const EAST = [0, 0, 0, 3, 16, 16];
  const WEST = [13, 0, 0, 16, 16, 16];
  const SOUTH = [0, 0, 0, 16, 16, 3];
  const NORTH = [0, 0, 13, 16, 16, 16];
  const mc = {
    east: { closed: EAST, right: NORTH, left: SOUTH },
    south: { closed: SOUTH, right: EAST, left: WEST },
    west: { closed: WEST, right: SOUTH, left: NORTH },
    north: { closed: NORTH, right: WEST, left: EAST },
  };
  const dirs = directionList(row.stateLayout);
  for (const facing of HORIZONTAL) {
    for (const hinge of ['left', 'right']) {
      for (const open of ['false', 'true']) {
        const d = dirs.indexOf(Direction.map[facing]);
        assert.ok(d >= 0 && d < 4, `door ${facing} -> ${Direction.map[facing]}`);
        const h = RightHinge.map[hinge];
        const sub = Open.map[open] === 1 ? opened : closed;
        const t = compose(times(Yaw, d), times(MirrorX, h));
        const ours = sub.boxes.map((b) => transformBox(t, b));
        const want = open === 'true' ? mc[facing][hinge] : mc[facing].closed;
        assert.deepEqual(ours, [want], `door facing=${facing} hinge=${hinge} open=${open}`);
      }
    }
  }
  assert.deepEqual(Up.map, { lower: 0, upper: 1 });
});

test('liquid: MC level 0 / 1-7 / 8-15 -> HeightLevel source / distance / falling of each target', () => {
  const doc = catalogDoc();
  const map = mappingDocument.derive.liquid.HeightLevel.map;
  for (const name of ['lumio.water', 'lumio.lava']) {
    const spread = catalogRow(doc, name).stateLayout.spreadDistance ?? 7;
    assert.ok(spread >= 7, `${name}: MC flowing levels 1..7 need spreadDistance >= 7`);
    for (let level = 0; level < 16; level += 1) {
      const want = level === 0 ? 0 : level < 8 ? level : spread + 1;
      assert.equal(map[String(level)], want, `${name}: MC level ${level}`);
    }
  }
});

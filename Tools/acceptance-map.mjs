#!/usr/bin/env node

/**
 * ADR-124 acceptance base map, "lakeside cabin" (ADR-124 「例子」 step 1): source data only.
 *
 * Writes two generated files - never edit them by hand:
 *
 *   Server/Assets/Maps/acceptance-lakeside.cells.json   per-cell source, the input format of the
 *       engine's author-time capture CLI (eng/capture-voxel, shipped as Engine/tools/capture-voxel.mjs):
 *       { "cells": [ { "x", "y", "z", "blockId" } ] } with the full BlockId = BlockType << 8 | BlockState
 *   Server/Assets/Maps/acceptance-lakeside.points.json  evidence points for ADR-124 「验证」: a sample
 *       cell per block, the merge / culling / connection / door / stairs / light probes, camera spots
 *
 *   node Tools/acceptance-map.mjs            # rewrite both files
 *   node Tools/acceptance-map.mjs --check    # exit 1 if a committed file differs
 *   node --test Tools/acceptance-map.test.mjs
 *
 * Capturing the cells into a .voxel, booting a DS on it and the browser page are C9, not this script;
 * it does not replace the default sample.voxel. Every BlockState is computed from the catalog row's
 * v2 stateLayout (Tools/official-catalog.mjs stateFields) - there are no hand-written state numbers.
 *
 * Layout (x east, z south, y up; 32 x 16 x 16 = Sections (0,0,0) and (1,0,0)):
 *   ground   y0 stone, y1 dirt, y2 grass block; things stand at y = 3
 *   z = 0    a 16 x 16 stone wall, x 0..15, y 0..15 (north face is the one-quad merge probe)
 *   house    L-shaped footprint x 3..9, z 4..10 minus the north-east 3 x 3; planks floor y3, walls
 *            y4..6, roof y7, eaves ring of stairs at y7 (outer corners + one inner corner), closed
 *            door in the south wall with a slab step, glass window west, blue stained glass window
 *            east (looks over the garden to the lake), glowstone inside, a floor torch and a wall torch
 *   garden   fence ring x 13..18, z 9..14 with an open door as its gate, flowers, grass, a sapling
 *   lake     water x 20..27, z 9..14 (y1..2), ice on it, a lava pit touching it, a glass post on the shore
 *   tree     oak log x 29, z 4 (y3..7) with leaves, a leaves bush on the ground
 *   probes   glass pane / iron bars run across the Section border, walk-up stairs, dirt / ore / hard wall
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FIRST_OFFICIAL_BLOCK_TYPE,
  MINTED_BLOCKS,
  buildOfficialCatalog,
  directionList,
  loadLayout,
  stateFields,
} from './official-catalog.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CELLS_RELATIVE = 'Server/Assets/Maps/acceptance-lakeside.cells.json';
export const POINTS_RELATIVE = 'Server/Assets/Maps/acceptance-lakeside.points.json';
export const MAP_BOUNDS = Object.freeze({ min: { x: 0, y: 0, z: 0 }, max: { x: 31, y: 15, z: 15 } });
const GENERATED_BY = 'node Tools/acceptance-map.mjs - generated, do not edit by hand';

/** The ADR-124 C0 block list: the three legacy named blocks, then the minted ones in list order. */
export const ACCEPTANCE_BLOCK_NAMES = Object.freeze([
  'lumio.stone', 'lumio.hard_wall', 'lumio.ore', ...MINTED_BLOCKS.map((block) => block.name),
]);

// ---------------------------------------------------------------------------------------------
// BlockId codec over the v2 stateLayout.

export function createCodec(catalog) {
  const byName = new Map(catalog.rows.map((row) => [row.name, row]));
  const row = (name) => {
    const found = byName.get(name);
    if (!found) throw new Error(`unknown block ${name}`);
    return found;
  };
  /** values: field name -> number, or a direction shorthand (e.g. 'D2') for Direction. */
  const state = (name, values = {}) => {
    const r = row(name);
    const fields = stateFields(r);
    for (const key of Object.keys(values)) {
      if (!fields.some((f) => f.name === key)) throw new Error(`${name} has no BlockState field ${key}`);
    }
    let bits = 0;
    for (const field of fields) {
      let value = values[field.name] ?? 0;
      if (field.name === 'Direction' && typeof value === 'string') {
        value = directionList(r.stateLayout).indexOf(value);
        if (value < 0) throw new Error(`${name} does not allow direction ${values.Direction}`);
      }
      if (!Number.isInteger(value) || value < 0 || value >= field.count) {
        throw new Error(`${name}.${field.name} = ${value} is out of range 0..${field.count - 1}`);
      }
      bits |= value << field.offset;
    }
    return bits;
  };
  const blockId = (name, values) => ((row(name).blockType << 8) | state(name, values)) >>> 0;
  const decode = (id) => {
    const r = catalog.rows[(id >>> 8) - FIRST_OFFICIAL_BLOCK_TYPE];
    if (!r || r.blockType !== id >>> 8) throw new Error(`blockType ${id >>> 8} is not in the catalog`);
    const bits = id & 0xff;
    const fields = {};
    for (const field of stateFields(r)) fields[field.name] = (bits >>> field.offset) & ((1 << field.width) - 1);
    return { name: r.name, row: r, fields };
  };
  return { row, state, blockId, decode };
}

// ---------------------------------------------------------------------------------------------
// Shape transform (voxel-world-v1 shapeTable.transform), used to pick stair corners and in tests.

const identity = (p) => p;
const yaw = ([x, y, z]) => [16 - z, y, x];
const mirrorY = ([x, y, z]) => [x, 16 - y, z];
const mirrorX = ([x, y, z]) => [16 - x, y, z];
const wallNorth = ([x, y, z]) => [x, 16 - z, y];
const times = (f, n) => (p) => { let q = p; for (let i = 0; i < n; i += 1) q = f(q); return q; };
/** compose(A, B)(p) = A(B(p)): the contract's A ∘ B. */
const compose = (...fs) => (p) => fs.reduceRight((q, f) => f(q), p);

function directionTransform(shorthand) {
  const kind = shorthand[0];
  const r = Number(shorthand[1]);
  switch (kind) {
    case 'C': return r === 2 ? mirrorY : identity;
    case 'D': return times(yaw, r);
    case 'U': return compose(times(yaw, r), mirrorY);
    case 'F': return compose(wallNorth, times(yaw, r));
    case 'R': return compose(yaw, wallNorth, times(yaw, r));
    case 'B': return compose(times(yaw, 2), wallNorth, times(yaw, r));
    case 'L': return compose(times(yaw, 3), wallNorth, times(yaw, r));
    default: throw new Error(`direction ${shorthand}`);
  }
}

function fieldValues(row, bits) {
  const values = {};
  for (const field of stateFields(row)) values[field.name] = (bits >>> field.offset) & ((1 << field.width) - 1);
  return values;
}

function transformBox(t, [x0, y0, z0, x1, y1, z1]) {
  const a = t([x0, y0, z0]);
  const b = t([x1, y1, z1]);
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2]),
    Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])];
}

function crossPlanes(t, [x0, y0, z0, x1, y1, z1]) {
  return [
    [[x0, y0, z0], [x1, y0, z1], [x1, y1, z1], [x0, y1, z0]],
    [[x0, y0, z1], [x1, y0, z0], [x1, y1, z0], [x0, y1, z1]],
  ].map((plane) => plane.map((corner) => t(corner)));
}

/**
 * Boxes and crossed-plane corners of one cell: row (behaviorTemplate + stateLayout), its shape-table
 * entry, the BlockState bits, and for Connected the computed connections {north, east, south, west}.
 */
export function shapeOf(row, entry, bits, connections = {}) {
  const values = fieldValues(row, bits);
  let t = identity;
  let parts;
  if (row.behaviorTemplate === 'Model') {
    const dirs = row.stateLayout.directions === undefined ? null : directionList(row.stateLayout);
    const direction = dirs ? directionTransform(dirs[values.Direction ?? 0]) : identity;
    const split = row.stateLayout.yawSplitNum ?? 1;
    t = compose(times(yaw, ((values.YawSplitIndex ?? 0) * 4) / split), direction);
    parts = [entry[values.SubShapeId ?? 0]];
  } else if (row.behaviorTemplate === 'Door') {
    t = compose(times(yaw, values.Direction), times(mirrorX, values.RightHinge));
    parts = [entry[values.Open]];
  } else if (row.behaviorTemplate === 'Connected') {
    parts = [entry[0]];
    ['north', 'east', 'south', 'west'].forEach((side, index) => {
      if (connections[side]) parts.push(entry[index + 1]);
    });
  } else {
    throw new Error(`${row.behaviorTemplate} has no shape-table entry`);
  }
  return {
    boxes: parts.flatMap((part) => part.boxes.map((box) => transformBox(t, box))),
    crossPlanes: parts.flatMap((part) => part.crosses.flatMap((cross) => crossPlanes(t, cross))),
  };
}

// ---------------------------------------------------------------------------------------------
// The map.

const inHouse = (x, z) => x >= 3 && x <= 9 && z >= 4 && z <= 10 && !(x >= 7 && z <= 6);
const NEIGHBOURS4 = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const isHouseWall = (x, z) => inHouse(x, z) && NEIGHBOURS4.some(([dx, dz]) => !inHouse(x + dx, z + dz));
const inLake = (x, z) => x >= 20 && x <= 27 && z >= 9 && z <= 14
  && !((x === 20 || x === 27) && (z === 9 || z === 14));

/** Raised quarters an eaves stair needs: a quarter is raised when the roof touches it. */
function eavesQuarters(x, z) {
  const quarters = [];
  for (const [dx, dz, label] of [[-1, -1, 'NW'], [1, -1, 'NE'], [-1, 1, 'SW'], [1, 1, 'SE']]) {
    if (inHouse(x + dx, z) || inHouse(x, z + dz) || inHouse(x + dx, z + dz)) quarters.push(label);
  }
  return quarters;
}

function raisedQuarters(boxes) {
  const quarters = [];
  for (const [qx, qz, label] of [[0, 0, 'NW'], [8, 0, 'NE'], [0, 8, 'SW'], [8, 8, 'SE']]) {
    if (boxes.some(([x0, y0, z0, x1, y1, z1]) => x0 <= qx && x1 >= qx + 8 && z0 <= qz && z1 >= qz + 8 && y0 <= 8 && y1 >= 16)) {
      quarters.push(label);
    }
  }
  return quarters;
}

const SUB_SHAPE_KIND = ['straight', 'inner-left', 'inner-right', 'outer-left', 'outer-right'];

/** Pick the upright stair (D0..D3 x sub-shape) whose raised part matches the quarters; first match wins. */
function stairFor(codec, catalog, quarters) {
  const row = codec.row('lumio.oak_stairs');
  const entry = catalog.shapeTable['lumio.oak_stairs'];
  for (const direction of ['D0', 'D1', 'D2', 'D3']) {
    for (let sub = 0; sub < entry.length; sub += 1) {
      const values = { Direction: direction, SubShapeId: sub };
      const shape = shapeOf(row, entry, codec.state('lumio.oak_stairs', values));
      if (raisedQuarters(shape.boxes).join() === quarters.join()) return values;
    }
  }
  throw new Error(`no stair shape raises quarters ${quarters.join('+')}`);
}

const at = (x, y, z, block) => ({ x, y, z, block });

export function buildAcceptanceMap(catalog) {
  const codec = createCodec(catalog);
  const cells = new Map();
  const put = (x, y, z, name, values) => {
    cells.set(`${x},${y},${z}`, { x, y, z, blockId: codec.blockId(name, values) });
  };

  // Ground and the 16 x 16 stone wall on the north edge.
  for (let x = 0; x <= 31; x += 1) {
    for (let z = 0; z <= 15; z += 1) {
      if (z === 0 && x <= 15) continue;
      put(x, 0, z, 'lumio.stone');
      put(x, 1, z, 'lumio.dirt');
      put(x, 2, z, 'lumio.grass_block');
    }
  }
  for (let x = 0; x <= 15; x += 1) for (let y = 0; y <= 15; y += 1) put(x, y, 0, 'lumio.stone');
  put(5, 3, 1, 'lumio.oak_slab', { SubShapeId: 0 }); // lower slab against the wall: the wall face stays

  // House.
  const eaves = [];
  for (let x = 2; x <= 10; x += 1) {
    for (let z = 3; z <= 11; z += 1) {
      if (inHouse(x, z)) {
        put(x, 3, z, 'lumio.oak_planks');
        if (isHouseWall(x, z)) for (let y = 4; y <= 6; y += 1) put(x, y, z, 'lumio.oak_planks');
        put(x, 7, z, 'lumio.oak_planks');
        continue;
      }
      const quarters = eavesQuarters(x, z);
      if (quarters.length === 0) continue;
      const values = stairFor(codec, catalog, quarters);
      put(x, 7, z, 'lumio.oak_stairs', values);
      eaves.push({ x, z, values });
    }
  }
  const houseDoor = { Direction: 'D2', Open: 0, RightHinge: 0 };
  put(5, 4, 10, 'lumio.oak_door', { ...houseDoor, Up: 0 });
  put(5, 5, 10, 'lumio.oak_door', { ...houseDoor, Up: 1 });
  put(5, 3, 11, 'lumio.oak_slab', { SubShapeId: 0 }); // door step
  put(3, 5, 7, 'lumio.glass');
  put(9, 5, 8, 'lumio.blue_stained_glass');
  put(5, 4, 7, 'lumio.glowstone');
  put(6, 3, 11, 'lumio.torch', { Direction: 'C1' }); // on the ground
  put(4, 5, 11, 'lumio.torch', { Direction: 'F0' }); // on the house's south wall (its north side)

  // Connectors across the Section border x 15 | 16, ending on a dirt block.
  put(13, 3, 3, 'lumio.dirt');
  put(14, 3, 3, 'lumio.glass_pane');
  put(15, 3, 3, 'lumio.glass_pane');
  put(16, 3, 3, 'lumio.iron_bars');
  put(17, 3, 3, 'lumio.iron_bars');

  // Walk-up stairs: west to east onto a planks block.
  put(16, 3, 7, 'lumio.oak_stairs', { Direction: 'D1', SubShapeId: 0 });
  put(17, 3, 7, 'lumio.oak_planks');

  // Garden: fence ring with an open door as the gate on its west side.
  for (let x = 13; x <= 18; x += 1) {
    for (let z = 9; z <= 14; z += 1) {
      if (x === 13 || x === 18 || z === 9 || z === 14) put(x, 3, z, 'lumio.oak_fence');
    }
  }
  const gate = { Direction: 'D3', Open: 1, RightHinge: 0 };
  put(13, 3, 11, 'lumio.oak_door', { ...gate, Up: 0 });
  put(13, 4, 11, 'lumio.oak_door', { ...gate, Up: 1 });
  put(14, 3, 10, 'lumio.poppy');
  put(16, 3, 12, 'lumio.poppy');
  put(15, 3, 11, 'lumio.short_grass');
  put(17, 3, 13, 'lumio.short_grass');
  put(14, 3, 13, 'lumio.short_grass');
  put(16, 3, 10, 'lumio.oak_sapling');
  put(11, 3, 12, 'lumio.poppy');
  put(12, 3, 10, 'lumio.short_grass');
  put(10, 3, 13, 'lumio.short_grass');
  put(19, 3, 13, 'lumio.ore'); // a full block the fence at (18, 3, 13) connects to

  // Lake, ice, lava pit, glass post on the shore.
  for (let x = 20; x <= 27; x += 1) {
    for (let z = 9; z <= 14; z += 1) {
      if (!inLake(x, z)) continue;
      put(x, 1, z, 'lumio.water', { HeightLevel: 0 });
      put(x, 2, z, 'lumio.water', { HeightLevel: 0 });
    }
  }
  put(24, 2, 12, 'lumio.ice');
  for (const [x, z] of [[28, 11], [29, 11], [28, 12], [29, 12]]) put(x, 2, z, 'lumio.lava', { HeightLevel: 0 });
  put(19, 2, 11, 'lumio.glass');
  put(19, 3, 11, 'lumio.glass');

  // Tree and a leaves bush.
  for (let y = 3; y <= 7; y += 1) put(29, y, 4, 'lumio.oak_log');
  for (const y of [6, 7]) {
    for (let dx = -2; dx <= 2; dx += 1) {
      for (let dz = -2; dz <= 2; dz += 1) {
        if ((Math.abs(dx) === 2 && Math.abs(dz) === 2) || (dx === 0 && dz === 0)) continue;
        put(29 + dx, y, 4 + dz, 'lumio.oak_leaves');
      }
    }
  }
  for (let dx = -1; dx <= 1; dx += 1) for (let dz = -1; dz <= 1; dz += 1) put(29 + dx, 8, 4 + dz, 'lumio.oak_leaves');
  for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) put(29 + dx, 9, 4 + dz, 'lumio.oak_leaves');
  put(26, 3, 6, 'lumio.oak_leaves');

  // Loose dirt, ore and a hard wall block.
  put(1, 3, 13, 'lumio.dirt');
  put(2, 3, 13, 'lumio.dirt');
  put(1, 3, 14, 'lumio.ore');
  put(2, 3, 14, 'lumio.ore');
  put(3, 3, 14, 'lumio.ore');
  put(4, 3, 14, 'lumio.hard_wall');

  const sorted = [...cells.values()].sort((a, b) => a.y - b.y || a.z - b.z || a.x - b.x);
  return { cells: sorted, points: buildPoints(codec, eaves) };
}

function buildPoints(codec, eaves) {
  const blocks = {
    'lumio.stone': { x: 8, y: 8, z: 0 },
    'lumio.hard_wall': { x: 4, y: 3, z: 14 },
    'lumio.ore': { x: 2, y: 3, z: 14 },
    'lumio.dirt': { x: 1, y: 3, z: 13 },
    'lumio.grass_block': { x: 10, y: 2, z: 15 },
    'lumio.oak_planks': { x: 5, y: 7, z: 7 },
    'lumio.oak_log': { x: 29, y: 4, z: 4 },
    'lumio.oak_leaves': { x: 27, y: 6, z: 4 },
    'lumio.glass': { x: 3, y: 5, z: 7 },
    'lumio.blue_stained_glass': { x: 9, y: 5, z: 8 },
    'lumio.ice': { x: 24, y: 2, z: 12 },
    'lumio.glowstone': { x: 5, y: 4, z: 7 },
    'lumio.water': { x: 22, y: 2, z: 11 },
    'lumio.lava': { x: 28, y: 2, z: 11 },
    'lumio.oak_stairs': { x: 16, y: 3, z: 7 },
    'lumio.oak_slab': { x: 5, y: 3, z: 11 },
    'lumio.oak_door': { x: 5, y: 4, z: 10 },
    'lumio.oak_fence': { x: 15, y: 3, z: 9 },
    'lumio.glass_pane': { x: 14, y: 3, z: 3 },
    'lumio.iron_bars': { x: 17, y: 3, z: 3 },
    'lumio.torch': { x: 6, y: 3, z: 11 },
    'lumio.poppy': { x: 14, y: 3, z: 10 },
    'lumio.short_grass': { x: 15, y: 3, z: 11 },
    'lumio.oak_sapling': { x: 16, y: 3, z: 10 },
  };
  const corners = eaves
    .filter(({ values }) => values.SubShapeId !== 0)
    .map(({ x, z, values }) => ({ ...at(x, 7, z, 'lumio.oak_stairs'), direction: values.Direction, subShape: SUB_SHAPE_KIND[values.SubShapeId] }));
  const points = [
    {
      id: 'mesh.stone_wall_single_quad',
      verify: 'ADR-124 验证·网格：整块石墙 16×16 合成 1 个四边形',
      cells: [at(0, 0, 0, 'lumio.stone'), at(15, 15, 0, 'lumio.stone')],
      expect: '石墙占 x 0–15、y 0–15、z = 0 整面；北面（−z，z = 0 平面）外侧没有方块，出 1 个 16×16 四边形',
    },
    {
      id: 'cull.stone_wall_beside_lower_slab',
      verify: 'ADR-124 验证·剔面：石墙挨下半台阶，石墙朝台阶那一面仍然画',
      cells: [at(5, 3, 0, 'lumio.stone'), at(5, 3, 1, 'lumio.oak_slab')],
      expect: '(5,3,0) 的南面（+z）要画：下半台阶只盖住这一面的下半',
    },
    {
      id: 'cull.leaves_beside_leaves',
      verify: 'ADR-124 验证·剔面：树叶挨树叶的面不画、挨空气的面画',
      cells: [at(27, 6, 4, 'lumio.oak_leaves'), at(28, 6, 4, 'lumio.oak_leaves'), at(26, 6, 4, 'air')],
      expect: '(27,6,4) 与 (28,6,4) 之间两面都不画；(27,6,4) 的西面（朝空气）画',
    },
    {
      id: 'cull.water_beside_lava',
      verify: 'ADR-124 验证·剔面：水挨岩浆的面画',
      cells: [at(27, 2, 11, 'lumio.water'), at(28, 2, 11, 'lumio.lava')],
      expect: '水的东面与岩浆的西面都画（不同种液体）',
    },
    {
      id: 'cull.water_beside_glass',
      verify: 'ADR-124 验证·剔面：水挨玻璃的面画',
      cells: [at(20, 2, 11, 'lumio.water'), at(19, 2, 11, 'lumio.glass')],
      expect: '水的西面与玻璃的东面都画',
    },
    {
      id: 'connected.pane_and_bars_segment',
      verify: 'ADR-124 D2 连接件：玻璃板、铁栏杆彼此相连（不同种也连），并连上满面方块',
      cells: [at(13, 3, 3, 'lumio.dirt'), at(14, 3, 3, 'lumio.glass_pane'), at(15, 3, 3, 'lumio.glass_pane'),
        at(16, 3, 3, 'lumio.iron_bars'), at(17, 3, 3, 'lumio.iron_bars'), at(18, 3, 3, 'air')],
      expect: '(14..16,3,3) 连西、东两臂；(17,3,3) 只连西臂；四格都不连南北；BlockState 全为 0',
    },
    {
      id: 'connected.section_border_unresolved',
      verify: 'ADR-124 验证·连接件：邻 Section 缺块时物理回 Unresolved',
      cells: [at(15, 3, 3, 'lumio.glass_pane'), at(16, 3, 3, 'lumio.iron_bars')],
      expect: '(15,3,3) 在 Section (0,0,0)，东邻在 Section (1,0,0)；只有 (0,0,0) 在切面里时，对 (15,3,3) 的扫掠 / 重叠回 Unresolved 并带 Section (1,0,0)；网格按「不连」出东臂',
    },
    {
      id: 'connected.fence_toggle_full_block',
      verify: 'ADR-124 验证·连接件：栅栏旁放上 / 拿走整块，连接臂随之出现 / 消失，BlockState 字节不变',
      cells: [at(18, 3, 12, 'lumio.oak_fence'), at(19, 3, 12, 'air')],
      expect: '在 (19,3,12) 放一块满格 Solid（如 lumio.stone）后 (18,3,12) 出现东臂，拿走后消失；(18,3,12) 的 BlockId 两次读回相同',
    },
    {
      id: 'connected.fence_beside_full_block',
      verify: 'ADR-124 D2 连接件：邻格朝本格一面是满面就连；普通玻璃（Cutout）不算满面',
      cells: [at(18, 3, 13, 'lumio.oak_fence'), at(19, 3, 13, 'lumio.ore'), at(18, 3, 11, 'lumio.oak_fence'), at(19, 3, 11, 'lumio.glass')],
      expect: '(18,3,13) 有东臂（矿石是满面）；(18,3,11) 没有东臂（玻璃不是 absolute 满面）',
    },
    {
      id: 'shape.door_closed_blocks',
      verify: 'ADR-124 验证·形状与碰撞：门关着挡路',
      cells: [at(5, 4, 10, 'lumio.oak_door'), at(5, 5, 10, 'lumio.oak_door')],
      expect: '屋门 D2、Open = 0、RightHinge = 0，下格 Up = 0、上格 Up = 1；沿 z 穿门洞的扫掠被挡',
    },
    {
      id: 'shape.door_open_passable',
      verify: 'ADR-124 验证·形状与碰撞：门开着时门洞可通行、门板一侧仍挡',
      cells: [at(13, 3, 11, 'lumio.oak_door'), at(13, 4, 11, 'lumio.oak_door')],
      expect: '园门 D3、Open = 1、RightHinge = 0；门板在 z 13–16 一条（按契约变换），沿 x 从 z ≈ 11.5 穿过可通行，贴 z 15 的扫掠被挡',
    },
    {
      id: 'shape.stairs_walk_up',
      verify: 'ADR-124 验证·形状与碰撞：玩家能走上楼梯',
      cells: [at(16, 3, 7, 'lumio.oak_stairs'), at(17, 3, 7, 'lumio.oak_planks'), at(15, 3, 7, 'air')],
      expect: '楼梯 D1 直形（高的一半在东侧）；从 (15,3,7) 往东走：地面 y 3 → 台阶 3.5 → 4 → 木板顶 4',
    },
    {
      id: 'shape.slab_step',
      verify: 'ADR-124 验证·形状与碰撞：玩家能踩上台阶',
      cells: [at(5, 3, 11, 'lumio.oak_slab'), at(5, 3, 10, 'lumio.oak_planks')],
      expect: '门口下半台阶（SubShapeId = 0）：地面 y 3 → 台阶顶 3.5 → 屋内地板顶 4',
    },
    {
      id: 'shape.eaves_ring',
      verify: 'ADR-124 D2 楼梯转角存在 SubShapeId：屋檐一圈的直段、外转角与内转角',
      cells: corners,
      expect: '每格高起的那部分都朝向屋顶；外转角只高起朝屋角的四分之一，(7,7,6) 是内转角（高起四分之三）',
    },
    {
      id: 'collision.blocks',
      verify: 'ADR-124 验证·形状与碰撞：掩码 13 的扫掠会被栅栏、树叶、玻璃挡住',
      cells: [at(15, 3, 9, 'lumio.oak_fence'), at(26, 3, 6, 'lumio.oak_leaves'), at(19, 3, 11, 'lumio.glass'), at(14, 3, 3, 'lumio.glass_pane')],
      expect: '四格对掩码 13 的扫掠都是 Hit',
    },
    {
      id: 'collision.passes_through',
      verify: 'ADR-124 验证·形状与碰撞：会穿过花草（火把也不挡路）',
      cells: [at(14, 3, 10, 'lumio.poppy'), at(15, 3, 11, 'lumio.short_grass'), at(16, 3, 10, 'lumio.oak_sapling'), at(6, 3, 11, 'lumio.torch')],
      expect: '四格对掩码 13 的扫掠都是 Miss（形状表只有交叉面片、没有方盒）',
    },
    {
      id: 'light.torch_falloff',
      verify: 'ADR-124 验证·光照：火把周围块光按每格减 1 衰减',
      cells: [at(6, 3, 11, 'lumio.torch'), at(7, 3, 11, 'air'), at(8, 3, 11, 'air'), at(9, 3, 11, 'air'),
        at(10, 3, 11, 'air'), at(11, 3, 11, 'air'), at(12, 3, 11, 'air')],
      expect: '光源 ec8 = (14, 12, 8)；沿 +x 第 d 格块光 = (14−d, 12−d, 8−d)，各通道下限 0（墙上火把离得更远，不改变这几格的最大值）',
    },
    {
      id: 'light.wall_torch',
      verify: 'ADR-124 D5 已知限制：墙上的火把是地上火把按 F0 转过去的样子',
      cells: [at(4, 5, 11, 'lumio.torch'), at(4, 5, 10, 'lumio.oak_planks')],
      expect: '火把 Direction = F0（贴北墙），交叉面片水平伸出墙面；光源同样是 ec8',
    },
    {
      id: 'light.glowstone_neighbours',
      verify: 'ADR-124 验证·光照：萤石（全阻）周围的邻格被照亮',
      cells: [at(5, 4, 7, 'lumio.glowstone'), at(4, 4, 7, 'air'), at(6, 4, 7, 'air'), at(5, 5, 7, 'air'), at(5, 4, 6, 'air'), at(5, 4, 8, 'air')],
      expect: '萤石 fda = (15, 13, 10)；五个空气邻格块光 = (14, 12, 9)（每格减 1）',
    },
    {
      id: 'light.lava_source',
      verify: 'ADR-124 例子·光照：岩浆周围亮',
      cells: [at(28, 2, 11, 'lumio.lava'), at(28, 3, 11, 'air')],
      expect: '岩浆 f60 = (15, 6, 0)；正上方一格块光 = (14, 5, 0)',
    },
    {
      id: 'light.roof_blocks_skylight',
      verify: 'ADR-124 验证·光照：木板屋顶挡住正上方的天光，屋内天光只从门窗横向进来',
      cells: [at(4, 5, 8, 'air'), at(7, 5, 9, 'air'), at(5, 7, 8, 'lumio.oak_planks')],
      expect: '屋内两格天光 = 12、11（屋顶下列值为 0；天光和 MC 一样横向扩散，经门窗进屋每格减 1；不是 15 也不是 0）',
    },
    {
      id: 'light.leaves_keep_skylight',
      verify: 'ADR-124 验证·光照：透过树叶的天光不衰减',
      cells: [at(27, 5, 4, 'air'), at(27, 6, 4, 'lumio.oak_leaves'), at(22, 3, 5, 'air')],
      expect: '树叶正下方 (27,5,4) 与空地 (22,3,5) 天光都是 15',
    },
    {
      id: 'render.grass_block_sides',
      verify: 'ADR-124 验证·画面：草方块顶面绿、侧面带土',
      cells: [at(10, 2, 15, 'lumio.grass_block'), at(10, 1, 15, 'lumio.dirt')],
      expect: '地图南沿 z = 15 的草方块南面外侧没有方块，侧面可见；机位 grass_edge',
    },
    {
      id: 'render.stained_glass_shows_lake',
      verify: 'ADR-124 验证·画面：透过彩色玻璃能看见后面的湖面',
      cells: [at(9, 5, 8, 'lumio.blue_stained_glass'), at(22, 2, 11, 'lumio.water')],
      expect: '机位 through_stained_glass：从屋里朝东看，蓝玻璃后面是花园和湖面',
    },
  ];
  const cameras = [
    { id: 'overview', position: [16, 20, 30], lookAt: [16, 3, 8], covers: [...ACCEPTANCE_BLOCK_NAMES] },
    { id: 'stone_wall_north', position: [8, 8, -14], lookAt: [8, 8, 0], covers: ['lumio.stone'] },
    { id: 'house_front', position: [5.5, 6, 17], lookAt: [5.5, 5, 10], covers: ['lumio.oak_planks', 'lumio.oak_door', 'lumio.oak_slab', 'lumio.torch', 'lumio.oak_stairs', 'lumio.grass_block'] },
    { id: 'through_stained_glass', position: [6.5, 5.5, 8.5], lookAt: [24, 2.5, 11.5], covers: ['lumio.blue_stained_glass', 'lumio.glowstone', 'lumio.water'] },
    { id: 'west_window', position: [0.5, 5.5, 7.5], lookAt: [3.5, 5.5, 7.5], covers: ['lumio.glass', 'lumio.oak_planks'] },
    { id: 'lake_and_lava', position: [24, 8, 20], lookAt: [25, 2, 11], covers: ['lumio.water', 'lumio.lava', 'lumio.ice', 'lumio.glass'] },
    { id: 'garden', position: [15.5, 8, 19], lookAt: [15.5, 3, 11.5], covers: ['lumio.oak_fence', 'lumio.oak_door', 'lumio.poppy', 'lumio.short_grass', 'lumio.oak_sapling', 'lumio.ore'] },
    { id: 'tree', position: [22, 7, 1], lookAt: [29, 6, 4], covers: ['lumio.oak_log', 'lumio.oak_leaves'] },
    { id: 'connectors', position: [15.5, 6, 8], lookAt: [15.5, 3.5, 3], covers: ['lumio.glass_pane', 'lumio.iron_bars', 'lumio.dirt', 'lumio.oak_stairs'] },
    { id: 'roof_eaves', position: [12, 12, 14], lookAt: [6, 7, 7], covers: ['lumio.oak_stairs', 'lumio.oak_planks'] },
    { id: 'grass_edge', position: [3, 5, 22], lookAt: [3, 2.5, 14], covers: ['lumio.grass_block', 'lumio.dirt', 'lumio.ore', 'lumio.hard_wall'] },
  ];
  return {
    generatedBy: GENERATED_BY,
    map: 'acceptance-lakeside.cells.json',
    catalog: 'official-catalog.json',
    coordinates: 'x east, y up, z south (north = -z); cell (x, y, z) spans [x, x+1) x [y, y+1) x [z, z+1); camera positions are in cell units',
    bounds: MAP_BOUNDS,
    sections: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }],
    blocks,
    points,
    cameras,
  };
}

export function serializeCells(map) {
  const lines = map.cells.map(({ x, y, z, blockId }) => `    ${JSON.stringify({ x, y, z, blockId })}`);
  return `{\n  "generatedBy": ${JSON.stringify(GENERATED_BY)},\n  "catalog": "official-catalog.json",\n  "cells": [\n${lines.join(',\n')}\n  ]\n}\n`;
}

export function serializePoints(map) {
  return `${JSON.stringify(map.points, null, 2)}\n`;
}

export function writeAcceptanceMap({ repoRoot = ROOT, check = false } = {}) {
  const map = buildAcceptanceMap(buildOfficialCatalog(loadLayout(repoRoot)));
  const outputs = [[CELLS_RELATIVE, serializeCells(map)], [POINTS_RELATIVE, serializePoints(map)]];
  const stale = [];
  for (const [relative, text] of outputs) {
    const path = join(repoRoot, relative);
    if (check) {
      let committed = null;
      try { committed = readFileSync(path, 'utf8'); } catch { committed = null; }
      if (committed !== text) stale.push(relative);
    } else {
      writeFileSync(path, text);
    }
  }
  return { stale, cells: map.cells.length };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const check = process.argv.includes('--check');
  const result = writeAcceptanceMap({ check });
  if (result.stale.length > 0) {
    process.stderr.write(`stale: ${result.stale.join(', ')} - run node Tools/acceptance-map.mjs\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${check ? 'up to date' : 'wrote'} ${CELLS_RELATIVE} (${result.cells} cells), ${POINTS_RELATIVE}\n`);
  }
}

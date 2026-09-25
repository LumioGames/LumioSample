#!/usr/bin/env node

/**
 * Generator for Server/Assets/Maps/official-catalog.json - the game's official block catalog
 * (v2 envelope, ADR-124 D3 / D9; format = LumioGameEngine engine/wire/voxel-world-v1.json
 * blockCatalog + shapeTable, carried as engine/abi/native-abi.json voxel_catalog.json v2).
 *
 * The JSON is a generated file: never edit it by hand. Change this script, then
 *
 *   node Tools/official-catalog.mjs           # rewrite the JSON
 *   node Tools/official-catalog.mjs --check   # exit 1 if the committed JSON differs
 *   node --test Tools/official-catalog.test.mjs
 *
 * Minting (voxel.md M1a, blockCatalog.mintingProcedure): a new block is one more entry at the end of
 * MINTED_BLOCKS with blockType = current max + 1. Numbers and names are never reused, rewritten or
 * reordered - saves and snapshots reference them. The 745 legacy rows (256..1000, dense up to the
 * layout's ore type) keep their numbers and names; only lumio.stone / lumio.hard_wall / lumio.ore are
 * named, the rest are lumio.block_<N> placeholders.
 *
 * SHAPE_TABLE is the game's shape content (shapeTable): one entry per Model / Door / Connected row,
 * sub-shapes in 1/16-cell integer boxes (mesh + collision) and crossed planes (mesh only), written in
 * the contract's authoring pose. Directions are never extra sub-shapes; the contract transform turns
 * the authoring pose (a wall torch is the floor torch turned onto the wall).
 *
 * DS boots this file through server.json voxel_catalog; HostEntry passes it to Native unchanged.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LAYOUT_RELATIVE = 'Server/Assets/Maps/sample.layout.json';
export const CATALOG_RELATIVE = 'Server/Assets/Maps/official-catalog.json';
/** What server.json declares: relative to Server/Config/Startup, per ADR-115. */
export const CATALOG_DECLARED = '../../Assets/Maps/official-catalog.json';
export const FIRST_OFFICIAL_BLOCK_TYPE = 256;
export const CATALOG_VERSION = 2;
export const NO_LIGHT = '000';

const LEGACY_NAMED = Object.freeze({
  256: 'lumio.stone',
  258: 'lumio.hard_wall',
  1000: 'lumio.ore',
});

/**
 * ADR-124 C0 block list, in list order. blockType is written down (not recomputed) so that a later
 * layout change can never renumber a minted block; buildOfficialCatalog checks it is max + 1.
 */
export const MINTED_BLOCKS = Object.freeze([
  { blockType: 1001, name: 'lumio.dirt', materialClass: 'Solid', behaviorTemplate: 'FullCube', stateLayout: {}, lightEmission: NO_LIGHT },
  { blockType: 1002, name: 'lumio.grass_block', materialClass: 'Solid', behaviorTemplate: 'FullCube', stateLayout: {}, lightEmission: NO_LIGHT },
  { blockType: 1003, name: 'lumio.oak_planks', materialClass: 'Solid', behaviorTemplate: 'FullCube', stateLayout: {}, lightEmission: NO_LIGHT },
  { blockType: 1004, name: 'lumio.oak_log', materialClass: 'Solid', behaviorTemplate: 'FullCube', stateLayout: {}, lightEmission: NO_LIGHT },
  { blockType: 1005, name: 'lumio.oak_leaves', materialClass: 'Cutout', behaviorTemplate: 'FullCube', stateLayout: {}, lightEmission: NO_LIGHT },
  { blockType: 1006, name: 'lumio.glass', materialClass: 'Cutout', behaviorTemplate: 'FullCube', stateLayout: {}, lightEmission: NO_LIGHT },
  { blockType: 1007, name: 'lumio.blue_stained_glass', materialClass: 'Translucent', behaviorTemplate: 'FullCube', stateLayout: {}, lightEmission: NO_LIGHT },
  { blockType: 1008, name: 'lumio.ice', materialClass: 'Translucent', behaviorTemplate: 'FullCube', stateLayout: {}, lightEmission: NO_LIGHT },
  // Glowstone colour is C8's call: warm white, brighter than the torch (ec8).
  { blockType: 1009, name: 'lumio.glowstone', materialClass: 'Solid', behaviorTemplate: 'FullCube', stateLayout: {}, lightEmission: 'fda' },
  { blockType: 1010, name: 'lumio.water', materialClass: 'Liquid', behaviorTemplate: 'Liquid', stateLayout: { spreadDistance: 7 }, lightEmission: NO_LIGHT },
  { blockType: 1011, name: 'lumio.lava', materialClass: 'Liquid', behaviorTemplate: 'Liquid', stateLayout: { spreadDistance: 7 }, lightEmission: 'f60' },
  { blockType: 1012, name: 'lumio.oak_stairs', materialClass: 'Solid', behaviorTemplate: 'Model', stateLayout: { directions: 'D0D1D2D3U0U1U2U3', subShapeNum: 5, yawSplitNum: 1 }, lightEmission: NO_LIGHT },
  { blockType: 1013, name: 'lumio.oak_slab', materialClass: 'Solid', behaviorTemplate: 'Model', stateLayout: { subShapeNum: 3 }, lightEmission: NO_LIGHT },
  { blockType: 1014, name: 'lumio.oak_door', materialClass: 'Solid', behaviorTemplate: 'Door', stateLayout: { directions: 'D0D1D2D3' }, lightEmission: NO_LIGHT },
  { blockType: 1015, name: 'lumio.oak_fence', materialClass: 'Solid', behaviorTemplate: 'Connected', stateLayout: {}, lightEmission: NO_LIGHT },
  { blockType: 1016, name: 'lumio.glass_pane', materialClass: 'Cutout', behaviorTemplate: 'Connected', stateLayout: {}, lightEmission: NO_LIGHT },
  { blockType: 1017, name: 'lumio.iron_bars', materialClass: 'Cutout', behaviorTemplate: 'Connected', stateLayout: {}, lightEmission: NO_LIGHT },
  { blockType: 1018, name: 'lumio.torch', materialClass: 'Cutout', behaviorTemplate: 'Model', stateLayout: { directions: 'C1F0B0L0R0', subShapeNum: 1 }, lightEmission: 'ec8' },
  { blockType: 1019, name: 'lumio.poppy', materialClass: 'Cutout', behaviorTemplate: 'Model', stateLayout: { subShapeNum: 1 }, lightEmission: NO_LIGHT },
  { blockType: 1020, name: 'lumio.short_grass', materialClass: 'Cutout', behaviorTemplate: 'Model', stateLayout: { subShapeNum: 1 }, lightEmission: NO_LIGHT },
  { blockType: 1021, name: 'lumio.oak_sapling', materialClass: 'Cutout', behaviorTemplate: 'Model', stateLayout: { subShapeNum: 1 }, lightEmission: NO_LIGHT },
]);

const sub = (boxes, crosses = []) => ({ boxes, crosses });
/** Plants and the torch: two crossed planes; 12 wide on the diagonal so a 16-px sprite keeps ~1:1 texels. */
const PLANT_CROSS = [2, 0, 2, 14, 16, 14];
/** Glass pane and iron bars share MC's thin-panel geometry: 2/16 post, full-height arms. */
const THIN_PANEL = [
  sub([[7, 0, 7, 9, 16, 9]]),
  sub([[7, 0, 0, 9, 16, 7]]),
  sub([[9, 0, 7, 16, 16, 9]]),
  sub([[7, 0, 9, 9, 16, 16]]),
  sub([[0, 0, 7, 7, 16, 9]]),
];

/**
 * Authoring pose (voxel-world-v1 shapeTable.authoringPose): models stand on the floor facing north;
 * the door stands facing north with RightHinge = 0, geometry as the contract's door fixture
 * (open panel at x 0..3; main session ruling on the C1 review - fixture geometry wins over the text).
 * Connected arms are written in world directions: 0 post, 1 north, 2 east, 3 south, 4 west.
 */
export const SHAPE_TABLE = Object.freeze({
  // Straight, inner corner left, inner corner right, outer corner left, outer corner right
  // (MC shape order; "left" = west in the authoring pose). Lower slab + raised part on the north side.
  'lumio.oak_stairs': [
    sub([[0, 0, 0, 16, 8, 16], [0, 8, 0, 16, 16, 8]]),
    sub([[0, 0, 0, 16, 8, 16], [0, 8, 0, 16, 16, 8], [0, 8, 8, 8, 16, 16]]),
    sub([[0, 0, 0, 16, 8, 16], [0, 8, 0, 16, 16, 8], [8, 8, 8, 16, 16, 16]]),
    sub([[0, 0, 0, 16, 8, 16], [0, 8, 0, 8, 16, 8]]),
    sub([[0, 0, 0, 16, 8, 16], [8, 8, 0, 16, 16, 8]]),
  ],
  // Lower half, upper half, double.
  'lumio.oak_slab': [
    sub([[0, 0, 0, 16, 8, 16]]),
    sub([[0, 8, 0, 16, 16, 16]]),
    sub([[0, 0, 0, 16, 16, 16]]),
  ],
  // Closed: the whole panel; open: the strip on the hinge side, the doorway stays free.
  'lumio.oak_door': [
    sub([[0, 0, 13, 16, 16, 16]]),
    sub([[0, 0, 0, 3, 16, 16]]),
  ],
  // 4/16 post; each arm is two rails.
  'lumio.oak_fence': [
    sub([[6, 0, 6, 10, 16, 10]]),
    sub([[7, 12, 0, 9, 15, 6], [7, 6, 0, 9, 9, 6]]),
    sub([[10, 12, 7, 16, 15, 9], [10, 6, 7, 16, 9, 9]]),
    sub([[7, 12, 10, 9, 15, 16], [7, 6, 10, 9, 9, 16]]),
    sub([[0, 12, 7, 6, 15, 9], [0, 6, 7, 6, 9, 9]]),
  ],
  'lumio.glass_pane': THIN_PANEL,
  'lumio.iron_bars': THIN_PANEL,
  // Crossed planes only, no box: the torch never blocks (main session ruling 2026-09-25).
  'lumio.torch': [sub([], [PLANT_CROSS])],
  'lumio.poppy': [sub([], [PLANT_CROSS])],
  'lumio.short_grass': [sub([], [PLANT_CROSS])],
  'lumio.oak_sapling': [sub([], [PLANT_CROSS])],
});

const SHAPED_TEMPLATES = new Set(['Model', 'Door', 'Connected']);
const MATERIAL_CLASSES = new Set(['Solid', 'Liquid', 'Cutout', 'Translucent']);
const TEMPLATE_PARAMETERS = Object.freeze({
  FullCube: [],
  Liquid: ['spreadDistance'],
  Model: ['directions', 'subShapeNum', 'yawSplitNum'],
  Door: ['directions'],
  Connected: [],
});
/** Direction shorthands (voxel-world-v1 blockId.stateLayout.directions.shorthand). */
export const DIRECTION_SHORTHANDS = Object.freeze([
  'D0', 'D1', 'D2', 'D3', 'U0', 'U1', 'U2', 'U3', 'F0', 'F1', 'F2', 'F3', 'B0', 'B1', 'B2', 'B3',
  'L0', 'L1', 'L2', 'L3', 'R0', 'R1', 'R2', 'R3', 'C0', 'C1', 'C2',
]);

export function loadLayout(repoRoot = ROOT) {
  const path = join(repoRoot, LAYOUT_RELATIVE);
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function namedCatalogTypes(layout) {
  const floor = Number(layout.floorType);
  const wall = Number(layout.wallType);
  const ore = Number(layout.oreType);
  if (![floor, wall, ore].every((n) => Number.isInteger(n) && n >= FIRST_OFFICIAL_BLOCK_TYPE)) {
    throw new Error('layout floorType/wallType/oreType must be integers >= 256');
  }
  return { floor, wall, ore, last: Math.max(floor, wall, ore) };
}

function row({ blockType, name, materialClass, behaviorTemplate, stateLayout, lightEmission }) {
  // Field order is voxel-world-v1 blockCatalog.rowFieldOrder.
  return {
    blockType,
    name,
    materialClass,
    behaviorTemplate,
    assetRef: `asset://blocks/${name}`,
    stateLayout: structuredClone(stateLayout),
    lightEmission,
  };
}

/** A legacy row (256 .. layout max): FullCube Solid, no state, no light. */
export function catalogRow(blockType) {
  const name = LEGACY_NAMED[blockType] ?? `lumio.block_${blockType}`;
  return row({ blockType, name, materialClass: 'Solid', behaviorTemplate: 'FullCube', stateLayout: {}, lightEmission: NO_LIGHT });
}

export function buildOfficialCatalog(layout) {
  const { last } = namedCatalogTypes(layout);
  const rows = [];
  for (let blockType = FIRST_OFFICIAL_BLOCK_TYPE; blockType <= last; blockType += 1) {
    rows.push(catalogRow(blockType));
  }
  for (const block of MINTED_BLOCKS) {
    const expected = rows.at(-1).blockType + 1;
    if (block.blockType !== expected) {
      throw new Error(`${block.name} is minted as ${block.blockType}; the next free blockType is ${expected}`);
    }
    rows.push(row(block));
  }
  const shapeTable = {};
  for (const r of rows) {
    if (!SHAPED_TEMPLATES.has(r.behaviorTemplate)) continue;
    const entry = SHAPE_TABLE[r.name];
    if (!entry) throw new Error(`${r.name} (${r.behaviorTemplate}) has no SHAPE_TABLE entry`);
    shapeTable[r.name] = structuredClone(entry);
  }
  for (const name of Object.keys(SHAPE_TABLE)) {
    if (!(name in shapeTable)) throw new Error(`SHAPE_TABLE entry ${name} names no Model / Door / Connected row`);
  }
  const catalog = { version: CATALOG_VERSION, retiredNames: [], rows, shapeTable };
  const verdict = validateOfficialCatalog(catalog);
  if (verdict !== 'valid') throw new Error(`generated catalog is invalid: ${verdict}`);
  return catalog;
}

export function serializeOfficialCatalog(catalog) {
  return `${JSON.stringify(catalog)}\n`;
}

export function catalogCoversLayout(catalog, layout) {
  const { floor, wall, ore, last } = namedCatalogTypes(layout);
  if (catalog?.version !== CATALOG_VERSION || !Array.isArray(catalog.retiredNames) || !Array.isArray(catalog.rows)) {
    return false;
  }
  if (catalog.rows.length < last - FIRST_OFFICIAL_BLOCK_TYPE + 1) return false;
  for (let i = 0; i < catalog.rows.length; i += 1) {
    if (catalog.rows[i]?.blockType !== FIRST_OFFICIAL_BLOCK_TYPE + i) return false;
  }
  const byType = new Map(catalog.rows.map((r) => [r.blockType, r]));
  return byType.get(floor)?.name === LEGACY_NAMED[floor]
    && byType.get(wall)?.name === LEGACY_NAMED[wall]
    && byType.get(ore)?.name === LEGACY_NAMED[ore];
}

export function loadOfficialCatalog(repoRoot = ROOT) {
  return JSON.parse(readFileSync(join(repoRoot, CATALOG_RELATIVE), 'utf8'));
}

function bitsFor(count) {
  return count <= 1 ? 0 : Math.ceil(Math.log2(count));
}

export function directionList(stateLayout) {
  const text = stateLayout.directions;
  const list = [];
  for (let i = 0; i < text.length; i += 2) list.push(text.slice(i, i + 2));
  return list;
}

/**
 * BlockState fields of a row: template registration order, packed from bit 0
 * (voxel-world-v1 blockId.stateLayout.allocation). count = number of legal values.
 */
export function stateFields(catalogRow_) {
  const { behaviorTemplate: template, stateLayout: layout } = catalogRow_;
  const counts = [];
  if (template === 'Liquid') {
    counts.push(['HeightLevel', (layout.spreadDistance ?? 7) + 2]);
  } else if (template === 'Model') {
    if (layout.directions !== undefined) counts.push(['Direction', directionList(layout).length]);
    counts.push(['SubShapeId', layout.subShapeNum]);
    counts.push(['YawSplitIndex', layout.yawSplitNum ?? 1]);
  } else if (template === 'Door') {
    counts.push(['Direction', directionList(layout).length], ['Open', 2], ['RightHinge', 2], ['Up', 2]);
  }
  let offset = 0;
  return counts.map(([name, count]) => {
    const field = { name, offset, width: bitsFor(count), count };
    offset += field.width;
    return field;
  });
}

function isInt(n, min, max) {
  return Number.isInteger(n) && n >= min && n <= max;
}

function stateLayoutError(r) {
  const layout = r.stateLayout;
  if (typeof layout !== 'object' || layout === null || Array.isArray(layout)) return 'block_state_layout_invalid';
  const allowed = TEMPLATE_PARAMETERS[r.behaviorTemplate];
  if (Object.keys(layout).some((key) => !allowed.includes(key))) return 'block_state_layout_invalid';
  if (r.behaviorTemplate === 'Model' && layout.subShapeNum === undefined) return 'block_state_layout_invalid';
  if (r.behaviorTemplate === 'Door' && layout.directions === undefined) return 'block_state_layout_invalid';
  if (layout.directions !== undefined) {
    const text = layout.directions;
    if (typeof text !== 'string' || text.length === 0 || text.length % 2 !== 0) return 'block_state_direction_list_invalid';
    const list = directionList(layout);
    if (list.length > 27 || list.some((d) => !DIRECTION_SHORTHANDS.includes(d)) || new Set(list).size !== list.length) {
      return 'block_state_direction_list_invalid';
    }
    if (r.behaviorTemplate === 'Door' && text !== 'D0D1D2D3') return 'block_state_direction_list_invalid';
  }
  if (layout.spreadDistance !== undefined && !isInt(layout.spreadDistance, 0, 254)) return 'block_state_layout_invalid';
  if (layout.subShapeNum !== undefined && !isInt(layout.subShapeNum, 1, 256)) return 'block_state_layout_invalid';
  if (layout.yawSplitNum !== undefined && ![1, 2, 4].includes(layout.yawSplitNum)) return 'block_state_layout_invalid';
  const bits = stateFields(r).reduce((sum, field) => sum + field.width, 0);
  return bits > 8 ? 'block_state_layout_too_wide' : null;
}

function sixError(six) {
  if (!Array.isArray(six) || six.length !== 6 || !six.every((n) => isInt(n, 0, 16))) return true;
  return !(six[0] < six[3] && six[1] < six[4] && six[2] < six[5]);
}

/**
 * Mirror of the loader's validation order (voxel-world-v1 blockCatalog.validationOrder and
 * shapeTable.validationOrder) for content tests. Returns 'valid' or the first error code.
 * The engine's loader stays the authority; this only keeps the generator from shipping a bad file.
 */
export function validateOfficialCatalog(catalog) {
  if (typeof catalog?.version !== 'number' || catalog.version !== CATALOG_VERSION) return 'block_catalog_version_mismatch';
  if (!Array.isArray(catalog.rows) || catalog.rows.length === 0
      || !Array.isArray(catalog.retiredNames) || typeof catalog.shapeTable !== 'object' || catalog.shapeTable === null) {
    return 'InvalidArgument';
  }
  const fields = ['blockType', 'name', 'materialClass', 'behaviorTemplate', 'assetRef', 'stateLayout', 'lightEmission'];
  for (const r of catalog.rows) {
    if (fields.some((f) => r[f] === undefined || r[f] === null || (typeof r[f] === 'string' && r[f].trim() === ''))) {
      return 'block_catalog_row_incomplete';
    }
    if (typeof r.lightEmission !== 'string' || !/^[0-9a-f]{3}$/.test(r.lightEmission)) return 'block_light_emission_invalid';
    if (!MATERIAL_CLASSES.has(r.materialClass)) return 'unknown_material_class';
    if (!(r.behaviorTemplate in TEMPLATE_PARAMETERS)) return 'unknown_behavior_template';
    const layoutError = stateLayoutError(r);
    if (layoutError) return layoutError;
  }
  for (let i = 0; i < catalog.rows.length; i += 1) {
    if (catalog.rows[i].blockType !== FIRST_OFFICIAL_BLOCK_TYPE + i) return 'block_catalog_not_dense';
  }
  const names = catalog.rows.map((r) => r.name);
  if (new Set(names).size !== names.length || names.some((n) => catalog.retiredNames.includes(n))) {
    return 'block_catalog_name_reused';
  }
  const shaped = catalog.rows.filter((r) => SHAPED_TEMPLATES.has(r.behaviorTemplate));
  for (const r of shaped) {
    const entry = catalog.shapeTable[r.name];
    if (entry === undefined) return 'shape_table_entry_missing';
    if (!Array.isArray(entry)) return 'shape_table_geometry_invalid';
    for (const s of entry) {
      if (typeof s !== 'object' || s === null || Object.keys(s).length !== 2
          || !Array.isArray(s.boxes) || !Array.isArray(s.crosses)) {
        return 'shape_table_geometry_invalid';
      }
      if ([...s.boxes, ...s.crosses].some(sixError)) return 'shape_table_geometry_invalid';
    }
    const expected = r.behaviorTemplate === 'Model' ? r.stateLayout.subShapeNum : r.behaviorTemplate === 'Door' ? 2 : 5;
    if (entry.length !== expected) return 'shape_table_sub_shape_count_mismatch';
    if (r.behaviorTemplate === 'Connected' && entry[0].boxes.length === 0) return 'shape_table_connected_center_empty';
  }
  const shapedNames = new Set(shaped.map((r) => r.name));
  if (Object.keys(catalog.shapeTable).some((key) => !shapedNames.has(key))) return 'shape_table_entry_unknown_block';
  return 'valid';
}

export function writeOfficialCatalog({ repoRoot = ROOT, check = false } = {}) {
  const text = serializeOfficialCatalog(buildOfficialCatalog(loadLayout(repoRoot)));
  const path = join(repoRoot, CATALOG_RELATIVE);
  if (check) {
    let committed = null;
    try { committed = readFileSync(path, 'utf8'); } catch { committed = null; }
    return { path, upToDate: committed === text };
  }
  writeFileSync(path, text);
  return { path, upToDate: true };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const check = process.argv.includes('--check');
  const result = writeOfficialCatalog({ check });
  if (check && !result.upToDate) {
    process.stderr.write(`${CATALOG_RELATIVE} is stale: run node Tools/official-catalog.mjs\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(`${check ? 'up to date' : 'wrote'} ${CATALOG_RELATIVE}\n`);
  }
}

/**
 * OfficialCatalog JSON for Server/Assets/Maps/sample.voxel. Dense from FIRST_OFFICIAL
 * (256) through the highest capture type (1000). HostEntry boots this as
 * voxelCatalogBase64; DS never invents the rows.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LAYOUT_RELATIVE = 'Server/Assets/Maps/sample.layout.json';
export const CATALOG_RELATIVE = 'Server/Assets/Maps/official-catalog.json';
/** What server.json declares: relative to Server/Config/Startup, per ADR-115. */
export const CATALOG_DECLARED = '../../Assets/Maps/official-catalog.json';
export const FIRST_OFFICIAL_BLOCK_TYPE = 256;

const NAMED = Object.freeze({
  256: { name: 'lumio.stone', materialClass: 'Solid' },
  258: { name: 'lumio.hard_wall', materialClass: 'Solid' },
  1000: { name: 'lumio.ore', materialClass: 'Solid' },
});

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

export function catalogRow(blockType) {
  const named = NAMED[blockType];
  return {
    blockType,
    name: named?.name ?? `lumio.block_${blockType}`,
    materialClass: named?.materialClass ?? 'Solid',
    behaviorTemplate: 'FullCube',
    assetRef: `asset://blocks/${named?.name ?? `lumio.block_${blockType}`}`,
    stateLayout: [],
  };
}

export function buildOfficialCatalog(layout) {
  const { last } = namedCatalogTypes(layout);
  const rows = [];
  for (let blockType = FIRST_OFFICIAL_BLOCK_TYPE; blockType <= last; blockType += 1) {
    rows.push(catalogRow(blockType));
  }
  return { version: 1, retiredNames: [], rows };
}

export function serializeOfficialCatalog(catalog) {
  return `${JSON.stringify(catalog)}\n`;
}

export function catalogCoversLayout(catalog, layout) {
  const { floor, wall, ore, last } = namedCatalogTypes(layout);
  if (catalog?.version !== 1 || !Array.isArray(catalog.retiredNames) || !Array.isArray(catalog.rows)) {
    return false;
  }
  if (catalog.rows.length !== last - FIRST_OFFICIAL_BLOCK_TYPE + 1) return false;
  for (let i = 0; i < catalog.rows.length; i += 1) {
    const expected = FIRST_OFFICIAL_BLOCK_TYPE + i;
    if (catalog.rows[i]?.blockType !== expected) return false;
  }
  const byType = new Map(catalog.rows.map((row) => [row.blockType, row]));
  return byType.get(floor)?.name === NAMED[floor]?.name
    && byType.get(wall)?.name === NAMED[wall]?.name
    && byType.get(ore)?.name === NAMED[ore]?.name;
}

export function loadOfficialCatalog(repoRoot = ROOT) {
  return JSON.parse(readFileSync(join(repoRoot, CATALOG_RELATIVE), 'utf8'));
}

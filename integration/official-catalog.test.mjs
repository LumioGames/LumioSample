import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  CATALOG_RELATIVE,
  FIRST_OFFICIAL_BLOCK_TYPE,
  buildOfficialCatalog,
  catalogCoversLayout,
  loadLayout,
  loadOfficialCatalog,
  serializeOfficialCatalog,
} from './official-catalog.mjs';
import { loadCommittedServerJson } from './server-profile.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('committed official catalog is dense through layout ore type 1000', () => {
  const layout = loadLayout(ROOT);
  const catalog = loadOfficialCatalog(ROOT);
  assert.equal(layout.floorType, 256);
  assert.equal(layout.wallType, 258);
  assert.equal(layout.oreType, 1000);
  assert.equal(catalog.version, 1);
  assert.equal(catalog.rows[0].blockType, FIRST_OFFICIAL_BLOCK_TYPE);
  assert.equal(catalog.rows.at(-1).blockType, 1000);
  assert.equal(catalog.rows.length, 1000 - FIRST_OFFICIAL_BLOCK_TYPE + 1);
  assert.equal(catalogCoversLayout(catalog, layout), true);
  const rebuilt = buildOfficialCatalog(layout);
  assert.equal(serializeOfficialCatalog(rebuilt), readFileSync(new URL('../maps/official-catalog.json', import.meta.url), 'utf8'));
  const stone = catalog.rows.find((row) => row.blockType === 256);
  const wall = catalog.rows.find((row) => row.blockType === 258);
  const ore = catalog.rows.find((row) => row.blockType === 1000);
  assert.equal(stone.name, 'lumio.stone');
  assert.equal(wall.name, 'lumio.hard_wall');
  assert.equal(ore.name, 'lumio.ore');
});

test('committed server.json names maps/official-catalog.json', () => {
  const config = loadCommittedServerJson();
  assert.equal(config.voxel_catalog, CATALOG_RELATIVE);
});

test('a catalog that skips types is not dense', () => {
  const layout = { floorType: 256, wallType: 258, oreType: 1000 };
  const sparse = {
    version: 1,
    retiredNames: [],
    rows: [
      { blockType: 256, name: 'lumio.stone' },
      { blockType: 258, name: 'lumio.hard_wall' },
      { blockType: 1000, name: 'lumio.ore' },
    ],
  };
  assert.equal(catalogCoversLayout(sparse, layout), false);
  assert.equal(catalogCoversLayout(buildOfficialCatalog(layout), layout), true);
});

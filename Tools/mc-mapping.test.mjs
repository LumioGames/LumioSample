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

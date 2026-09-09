import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertWorld, worldsMatch } from './world-assert.mjs';

const fixture = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'world-assert', 'expected.json'), 'utf8'));

test('matching cells and ore count pass', () => {
  assert.equal(worldsMatch(fixture, fixture), true);
  assert.deepEqual(assertWorld(fixture, fixture), []);
});

test('consistent-but-wrong worlds fail even when hashes could match', () => {
  const wrong = {
    cells: [
      { x: 0, y: 0, z: 0, block: 'stone' },
      { x: 1, y: 0, z: 0, block: 'stone' },
      { x: 2, y: 0, z: 0, block: 'air' },
    ],
    oreCount: 2,
  };
  const failures = assertWorld(wrong, fixture);
  assert.ok(failures.some((item) => item.check === 'world:cell'));
});

test('empty actual world is a failure', () => {
  const failures = assertWorld({ cells: [], oreCount: 0 }, fixture);
  assert.ok(failures.some((item) => item.check === 'world:cells'));
});

test('ore count mismatch fails independently of cells', () => {
  const failures = assertWorld({ ...fixture, oreCount: 99 }, fixture);
  assert.ok(failures.some((item) => item.check === 'world:ore'));
});

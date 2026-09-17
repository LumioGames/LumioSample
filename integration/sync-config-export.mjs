#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportCsharpReaders, resolveConfigRoot } from './sync-config-readers.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const checkOnly = process.argv.includes('--check');
const exports = [];

function files(directory, prefix = '') {
  return readdirSync(join(directory, prefix), { withFileTypes: true }).flatMap(entry => {
    const relative = join(prefix, entry.name);
    return entry.isDirectory() ? files(directory, relative) : [relative];
  }).sort();
}

try {
  const configRoot = resolveConfigRoot({ repoRoot: root });
  // The compiler hashes every file under --out, so both runs require fresh trees.
  for (let run = 0; run < 2; run++) exports.push(exportCsharpReaders({ configRoot }));
  for (const kind of ['out', 'csharpOut']) {
    const names = files(exports[0][kind]);
    assert.deepEqual(names, files(exports[1][kind]), `${kind}: file sets differ`);
    for (const name of names) {
      assert.deepEqual(readFileSync(join(exports[0][kind], name)), readFileSync(join(exports[1][kind], name)),
        `${kind}/${name}: clean exports differ`);
    }
    console.log(`${kind}: two clean exports are byte-identical (${names.length} files)`);
  }
  for (const name of files(exports[0].out)) {
    const bytes = readFileSync(join(exports[0].out, name));
    const destination = join(root, 'config', name);
    if (!checkOnly) {
      mkdirSync(dirname(destination), { recursive: true });
      writeFileSync(destination, bytes);
    }
    assert.deepEqual(readFileSync(destination), bytes, `${name}: committed export differs`);
    console.log(`${checkOnly ? 'verified' : 'synced'} config/${name}`);
  }
  console.log(`OK: root manifest included; compiler=${configRoot}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const exported of exports) rmSync(exported.scratch, { recursive: true, force: true });
}

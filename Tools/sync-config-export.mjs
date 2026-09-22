#!/usr/bin/env node

/**
 * Sync the committed per-end table exports from LumioConfig.
 *
 *   node Tools/sync-config-export.mjs
 *   node Tools/sync-config-export.mjs --check
 *
 * ADR-115 / `split-export/1`: one compile writes `C` to Client/Config/Tables and
 * `S`+`V` to Server/Config/Tables. The single-root `config/` export is retired
 * in this workspace. Determinism is proved by exporting twice into fresh
 * directories and comparing bytes before anything is written into the tree.
 */

import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exportCsharpReaders, resolveConfigRoot, tableRoot } from './sync-config-readers.mjs';

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
  // The compiler hashes every file under each end root, so both runs require fresh trees.
  for (let run = 0; run < 2; run++) exports.push(exportCsharpReaders({ configRoot }));
  for (const kind of ['clientOut', 'serverOut', 'csharpOut']) {
    const names = files(exports[0][kind]);
    assert.ok(names.length > 0, `${kind}: export wrote no files`);
    assert.deepEqual(names, files(exports[1][kind]), `${kind}: file sets differ`);
    for (const name of names) {
      assert.deepEqual(readFileSync(join(exports[0][kind], name)), readFileSync(join(exports[1][kind], name)),
        `${kind}/${name}: clean exports differ`);
    }
    console.log(`${kind}: two clean exports are byte-identical (${names.length} files)`);
  }

  // The client end must never carry a server-only projection.
  for (const name of files(exports[0].clientOut)) {
    assert.ok(!name.startsWith('server') && !name.startsWith('voxel') && name !== 'origins.json',
      `client export must not contain ${name}`);
  }

  for (const side of ['client', 'server']) {
    const exported = exports[0][`${side}Out`];
    const destinationRoot = tableRoot(root, side);
    const names = files(exported);
    for (const name of names) {
      const bytes = readFileSync(join(exported, name));
      const destination = join(destinationRoot, name);
      if (!checkOnly) {
        mkdirSync(dirname(destination), { recursive: true });
        writeFileSync(destination, bytes);
      }
      assert.deepEqual(readFileSync(destination), bytes, `${side}/${name}: committed export differs`);
    }
    // A table whose columns stop being visible on this end must not linger as a
    // stale committed file; the compiler only removes paths it still owns.
    const committed = files(destinationRoot);
    const stale = committed.filter(name => !names.includes(name));
    if (stale.length > 0) {
      if (checkOnly) assert.fail(`${side}: committed export carries files the compiler no longer writes: ${stale.join(', ')}`);
      for (const name of stale) unlinkSync(join(destinationRoot, name));
      console.log(`${side}: removed ${stale.length} stale export file(s): ${stale.join(', ')}`);
    }
    console.log(`${checkOnly ? 'verified' : 'synced'} ${side}: ${names.length} file(s) under ${destinationRoot.slice(root.length + 1)}`);
  }
  console.log(`OK: per-end manifests included; compiler=${configRoot}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  for (const exported of exports) rmSync(exported.scratch, { recursive: true, force: true });
}

#!/usr/bin/env node

/**
 * Sync the Sample typed Readers from LumioConfig `export --csharp-out`.
 *
 * Do not hand-edit src/Lumio.Sample.Gameplay/generated/config/**. Re-run:
 *
 *   node integration/sync-config-readers.mjs
 *   node integration/sync-config-readers.mjs --check
 *
 * `--check` re-exports and asserts the committed files are byte-identical
 * (git diff empty on those paths). Missing LumioConfig is a loud error.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const READER_FILES = Object.freeze([
  ['server', 'AttributesTable.cs'],
  ['server', 'MiningTable.cs'],
  ['server', 'MovementTable.cs'],
  ['server', 'MapTable.cs'],
  ['client', 'AttributesTable.cs'],
  ['client', 'MiningTable.cs'],
  ['client', 'MovementTable.cs'],
  ['client', 'MapTable.cs'],
]);

export function readerDest(repoRoot, side, name) {
  return join(repoRoot, 'src', 'Lumio.Sample.Gameplay', 'generated', 'config', side, name);
}

export function resolveConfigRoot({ env = process.env, repoRoot = ROOT } = {}) {
  const candidates = [
    env.LUMIO_CONFIG_ROOT,
    repoRoot ? resolve(repoRoot, '..', 'LumioConfig') : undefined,
  ].filter((value) => typeof value === 'string' && value.trim() !== '');
  for (const raw of candidates) {
    const root = resolve(raw);
    if (existsSync(join(root, 'tools', 'lumio_config.py'))) return root;
  }
  return null;
}

function pythonBin(env = process.env) {
  if (env.LUMIO_PYTHON) return env.LUMIO_PYTHON;
  if (env.PYTHON) return env.PYTHON;
  if (process.platform === 'win32') return 'py -3';
  for (const candidate of ['python3.13', 'python3.12', 'python3.11', 'python3']) {
    const probe = spawnSync(candidate, ['-c', 'import sys; raise SystemExit(0 if sys.version_info >= (3, 11) else 1)'], {
      encoding: 'utf8',
    });
    if (probe.status === 0) return candidate;
  }
  return 'python3';
}

export function exportCsharpReaders({ configRoot, sourceRoot = join(ROOT, 'config', 'source'), python = pythonBin(), env = process.env } = {}) {
  if (!configRoot) {
    throw new Error(
      'LumioConfig root was not found. Set LUMIO_CONFIG_ROOT or clone LumioConfig next to this repo, then re-run node integration/sync-config-readers.mjs.',
    );
  }
  const cli = join(configRoot, 'tools', 'lumio_config.py');
  const scratch = mkdtempSync(join(tmpdir(), 'lumio-sample-csharp-'));
  const out = join(scratch, 'export');
  const csharpOut = join(scratch, 'csharp');
  mkdirSync(out, { recursive: true });
  mkdirSync(csharpOut, { recursive: true });
  const pythonCommand = python === 'py -3' ? ['py', '-3'] : [python];
  const result = spawnSync(pythonCommand[0], [...pythonCommand.slice(1), cli, 'export', '--root', sourceRoot, '--out', out, '--csharp-out', csharpOut], {
    cwd: configRoot,
    encoding: 'utf8',
    env,
  });
  if (result.status !== 0) {
    rmSync(scratch, { recursive: true, force: true });
    throw new Error(
      `LumioConfig export --csharp-out failed (exit ${result.status}):\n${result.stdout || ''}\n${result.stderr || ''}`,
    );
  }
  return { scratch, csharpOut, stdout: result.stdout };
}

export function copyReaders(csharpOut, repoRoot) {
  const copied = [];
  for (const [side, name] of READER_FILES) {
    const source = join(csharpOut, side, name);
    const dest = readerDest(repoRoot, side, name);
    if (!existsSync(source)) {
      throw new Error(`LumioConfig export did not write ${side}/${name}`);
    }
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(source));
    copied.push({ side, name, dest });
  }
  return copied;
}

export function diffReaders(csharpOut, repoRoot) {
  const diffs = [];
  for (const [side, name] of READER_FILES) {
    const source = join(csharpOut, side, name);
    const dest = readerDest(repoRoot, side, name);
    if (!existsSync(source)) {
      diffs.push({ side, name, reason: 'missing-export' });
      continue;
    }
    if (!existsSync(dest)) {
      diffs.push({ side, name, reason: 'missing-committed' });
      continue;
    }
    const exported = readFileSync(source);
    const committed = readFileSync(dest);
    if (!exported.equals(committed)) {
      diffs.push({ side, name, reason: 'bytes-differ' });
    }
  }
  return diffs;
}

export function syncConfigReaders({
  repoRoot = ROOT,
  env = process.env,
  checkOnly = false,
} = {}) {
  const configRoot = resolveConfigRoot({ env, repoRoot });
  const exported = exportCsharpReaders({ configRoot, env });
  try {
    if (checkOnly) {
      const diffs = diffReaders(exported.csharpOut, repoRoot);
      if (diffs.length > 0) {
        const list = diffs.map((item) => `${item.side}/${item.name} (${item.reason})`).join(', ');
        throw new Error(`typed Readers drifted from LumioConfig export --csharp-out: ${list}`);
      }
      return { status: 'OK', checkOnly: true, files: READER_FILES.length, configRoot };
    }
    copyReaders(exported.csharpOut, repoRoot);
    const diffs = diffReaders(exported.csharpOut, repoRoot);
    if (diffs.length > 0) {
      throw new Error('copy left a non-empty diff against the export');
    }
    return { status: 'OK', checkOnly: false, files: READER_FILES.length, configRoot };
  } finally {
    rmSync(exported.scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const checkOnly = process.argv.includes('--check');
    const result = syncConfigReaders({ checkOnly });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}

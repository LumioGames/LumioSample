#!/usr/bin/env node

/**
 * R-00522 author-time one-shot. Invokes the engine's capture CLI as shipped in the
 * Engine/ release (`Engine/tools/capture-voxel.mjs`, ADR-123). Does not invent a
 * capture implementation. DS boot only restores
 * the committed snapshot; gameplay must not import this module (voxel write
 * is R-00469).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocked } from './engine-tools.mjs';
import { engineDir } from './engine-release.mjs';
import { inspectBaseMap } from './server-profile.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LAYOUT_RELATIVE = 'Server/Assets/Maps/sample.layout.json';

export function inspectPlaceholderMap(repoRoot = ROOT) {
  const map = inspectBaseMap(repoRoot);
  return {
    path: map.path,
    placeholder: map.placeholder,
    restorable: map.restorable,
    blocked: map.blocked,
    sha256: map.sha256,
    missingCommand: map.missingCommand,
  };
}

export function resolveCaptureCli({ repoRoot = ROOT } = {}) {
  const file = join(engineDir(repoRoot), 'tools', 'capture-voxel.mjs');
  return existsSync(file) ? file : null;
}

export function loadLayout(repoRoot = ROOT) {
  const path = join(repoRoot, LAYOUT_RELATIVE);
  if (!existsSync(path)) {
    throw new Error(`${LAYOUT_RELATIVE} is required (W×D / vein live in config, not in DS boot).`);
  }
  const layout = JSON.parse(readFileSync(path, 'utf8'));
  const map = JSON.parse(readFileSync(join(repoRoot, 'Server', 'Config', 'Tables', 'server', 'map.json'), 'utf8')).rows[0];
  layout.width = map.width;
  layout.depth = map.depth;
  const veinSide = Math.sqrt(layout.width * layout.depth * map.vein_ratio);
  if (!Number.isInteger(veinSide) || veinSide < 1) throw new Error('map.vein_ratio must describe a whole square vein');
  layout.vein.width = veinSide;
  layout.vein.depth = veinSide;
  if (!Number.isInteger(layout.width) || layout.width < 1) throw new Error('layout.width must be a positive integer');
  if (!Number.isInteger(layout.depth) || layout.depth < 1) throw new Error('layout.depth must be a positive integer');
  const vein = layout.vein;
  if (!vein || !Number.isInteger(vein.x) || !Number.isInteger(vein.z)
      || !Number.isInteger(vein.width) || !Number.isInteger(vein.depth)) {
    throw new Error('layout.vein must be { x, z, width, depth } integers');
  }
  return layout;
}

export function detectVoxelCaptureApi({ repoRoot = ROOT } = {}) {
  const cli = resolveCaptureCli({ repoRoot });
  return {
    writeCell: false,
    capture: Boolean(cli),
    restore: Boolean(cli),
    cli,
    reason: cli
      ? 'Engine capture CLI is present; this script is author-time only (DS restores, does not recompute).'
      : 'the Engine/ release ships no capture CLI (Engine/tools/capture-voxel.mjs).',
    missingCommand: cli ? null : 'Engine/tools/capture-voxel.mjs',
  };
}

export function captureArgs(layout, out) {
  return [
    '--width', String(layout.width),
    '--depth', String(layout.depth),
    '--vein', `${layout.vein.x},${layout.vein.z},${layout.vein.width},${layout.vein.depth}`,
    '--out', out,
    '--verify-restore',
  ];
}

export function runCapture({
  repoRoot = ROOT,
  env = process.env,
  spawn = spawnSync,
} = {}) {
  const api = detectVoxelCaptureApi({ repoRoot });
  if (!api.cli) {
    const map = inspectPlaceholderMap(repoRoot);
    throw blocked(
      `${map.path} cannot be recaptured here. ${api.reason} Missing command: ${api.missingCommand}.`,
    );
  }
  const layout = loadLayout(repoRoot);
  const out = join(repoRoot, 'Server', 'Assets', 'Maps', 'sample.voxel');
  const args = captureArgs(layout, out);
  const result = spawn(process.execPath, [api.cli, ...args], {
    encoding: 'utf8',
    env,
    cwd: dirname(api.cli),
  });
  if (result.status !== 0) {
    throw new Error(
      `Engine capture CLI failed (exit ${result.status}):\n${result.stdout || ''}\n${result.stderr || ''}`,
    );
  }
  const map = inspectPlaceholderMap(repoRoot);
  if (map.placeholder || !map.restorable) {
    throw blocked(`${map.path} is still not a restoreable VoxelEngine capture after CLI run.`);
  }
  return { status: 'PASS', map, api, stdout: result.stdout };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const result = runCapture();
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = error?.code === 'BLOCKED_ENV' || String(error?.message).startsWith('BLOCKED_ENV:') ? 2 : 1;
  }
}

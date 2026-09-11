#!/usr/bin/env node

/**
 * R-00522 one-shot base-map capture. The public SDK does not yet expose write-cell
 * + capture / restore, so this script refuses to treat maps/sample.voxel as usable.
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocked } from './engine-tools.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PLACEHOLDER_HEADER = 'LUMIO-VOXEL-SNAPSHOT-V1';

export function inspectPlaceholderMap(repoRoot = ROOT) {
  const path = join(repoRoot, 'maps', 'sample.voxel');
  const text = readFileSync(path, 'utf8');
  return {
    path: 'maps/sample.voxel',
    placeholder: text.includes(PLACEHOLDER_HEADER),
    restorable: false,
  };
}

export function detectVoxelCaptureApi() {
  return {
    writeCell: false,
    capture: true,
    restore: true,
    reason: 'VoxelFacade.Capture/Restore exist; Sample has not wired write-cell consume (R-00522).',
  };
}

export function runCapture() {
  const map = inspectPlaceholderMap();
  const api = detectVoxelCaptureApi();
  if (map.placeholder || !api.writeCell || !api.capture) {
    throw blocked(`${map.path} is a placeholder and ${api.reason}`);
  }
  return { status: 'PASS', map, api };
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

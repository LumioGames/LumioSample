#!/usr/bin/env node

/**
 * R-00522 one-shot base-map capture. VoxelFacade already has PrepareWrite /
 * Capture / Restore. Sample has not wired write-cell consume, and Engine has
 * no committed capture CLI, so this script refuses maps/sample.voxel as a
 * restorable base map instead of inventing mining rules or a fake snapshot.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocked } from './engine-tools.mjs';
import { inspectBaseMap } from './server-profile.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function inspectPlaceholderMap(repoRoot = ROOT) {
  const map = inspectBaseMap(repoRoot);
  return {
    path: map.path,
    placeholder: map.placeholder,
    restorable: false,
    blocked: map.blocked,
    sha256: map.sha256,
    missingCommand: map.missingCommand,
  };
}

export function detectVoxelCaptureApi() {
  return {
    writeCell: false,
    capture: true,
    restore: true,
    reason: 'VoxelFacade.Capture/Restore exist; Sample has not wired write-cell consume (R-00522).',
    missingCommand:
      'sibling LumioGameEngine has no committed capture CLI (VoxelFacade.PrepareWrite/Capture exist; Sample write-cell consume is not wired)',
  };
}

export function runCapture() {
  const map = inspectPlaceholderMap();
  const api = detectVoxelCaptureApi();
  if (map.placeholder || !api.writeCell || !api.capture) {
    throw blocked(
      `${map.path} is a placeholder and must not be treated as a base map. ${api.reason} Missing command: ${api.missingCommand}.`,
    );
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

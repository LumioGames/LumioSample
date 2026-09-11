/**
 * Frozen operator template for lumio-ds. Committed `server.json` is the
 * runnable profile operators and tests actually start. Local overlays
 * (`.run/server.local.json`, `LUMIO_DS_CONFIG`) stay gitignored and must
 * copy this public vocab rather than `runtime-only` / `process-crash`.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blocked } from './engine-tools.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HEX64 = /^[0-9a-f]{64}$/;
const PLACEHOLDER_HEADER = 'LUMIO-VOXEL-SNAPSHOT-V1';
const PLACEHOLDER_BLOCKED = 'BLOCKED: this is not a restoreable VoxelEngine capture';
const MISSING_CAPTURE_COMMAND =
  'sibling LumioGameEngine has no committed capture CLI (VoxelFacade.PrepareWrite/Capture exist; Sample write-cell consume is not wired)';

export const FROZEN_WORLD_PROFILE = 'runtime+voxel';
export const FROZEN_DURABILITY = 'snapshot_only';
export const FROZEN_BASE_MAP_ID = 'sample';
export const FROZEN_BASE_MAP_VERSION = '0.1.0-placeholder';
export const FROZEN_ENTRY_TYPE = 'Lumio.Server.EntityChat.HostEntry.HostEntry, Lumio.Server.EntityChat.HostEntry';
export const FROZEN_ENTRY_METHOD = 'LumioEntityChatEntry';

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function inspectBaseMap(repoRoot = ROOT) {
  const relative = 'maps/sample.voxel';
  const path = join(repoRoot, relative);
  if (!existsSync(path)) {
    return {
      path: relative,
      placeholder: true,
      restorable: false,
      blocked: true,
      sha256: null,
      missingCommand: MISSING_CAPTURE_COMMAND,
    };
  }
  const bytes = readFileSync(path);
  const text = bytes.toString('utf8');
  const placeholder = text.includes(PLACEHOLDER_HEADER)
    || text.includes(PLACEHOLDER_BLOCKED)
    || text.includes('do-not-restore: true');
  return {
    path: relative,
    placeholder,
    restorable: false,
    blocked: text.includes(PLACEHOLDER_BLOCKED),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    missingCommand: MISSING_CAPTURE_COMMAND,
  };
}

export function loadCommittedServerJson(repoRoot = ROOT) {
  const path = join(repoRoot, 'server.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function assertFrozenServerProfile(config, repoRoot = ROOT) {
  if (!config || typeof config !== 'object') throw new Error('server.json must parse as an object.');
  if (config.world_profile !== FROZEN_WORLD_PROFILE) {
    throw new Error(`server.json world_profile must be ${FROZEN_WORLD_PROFILE}, not ${config.world_profile}`);
  }
  if (config.durability !== FROZEN_DURABILITY) {
    throw new Error(`server.json durability must be ${FROZEN_DURABILITY} (persistence-container-v1), not ${config.durability}`);
  }
  if (config.durability === 'process-crash' || config.durability === 'power-loss') {
    throw new Error('server.json must not use retired durability process-crash / power-loss.');
  }
  for (const key of ['base_map_id', 'base_map_version', 'base_map_content_sha256']) {
    if (typeof config[key] !== 'string' || config[key].trim() === '') {
      throw new Error(`server.json ${key} is required`);
    }
  }
  if (!HEX64.test(config.base_map_content_sha256)) {
    throw new Error('server.json base_map_content_sha256 must be 64 lowercase hex');
  }
  if (config.clr?.entry_type !== FROZEN_ENTRY_TYPE) {
    throw new Error('server.json clr.entry_type must stay Lumio.Server.EntityChat.HostEntry.HostEntry');
  }
  if (config.clr?.entry_method !== FROZEN_ENTRY_METHOD) {
    throw new Error('server.json clr.entry_method must stay LumioEntityChatEntry');
  }
  const map = inspectBaseMap(repoRoot);
  if (config.base_map_id !== FROZEN_BASE_MAP_ID) {
    throw new Error(`server.json base_map_id must name ${FROZEN_BASE_MAP_ID}`);
  }
  if (config.base_map_version !== FROZEN_BASE_MAP_VERSION) {
    throw new Error(`server.json base_map_version must be ${FROZEN_BASE_MAP_VERSION} until a real capture exists`);
  }
  if (!map.sha256 || config.base_map_content_sha256 !== map.sha256) {
    throw new Error('server.json base_map_content_sha256 must match maps/sample.voxel bytes');
  }
  if (map.placeholder || !map.restorable) {
    throw blocked(
      `${map.path} is a placeholder (not a VoxelEngine capture); refuse it as a base map. Missing command: ${map.missingCommand}.`,
    );
  }
  return { config, map };
}

export function refusePlaceholderAsBaseMap(repoRoot = ROOT) {
  const config = loadCommittedServerJson(repoRoot);
  try {
    return assertFrozenServerProfile(config, repoRoot);
  } catch (error) {
    if (error?.code === 'BLOCKED_ENV') throw error;
    throw error;
  }
}

export function describeLocalOverlay(repoRoot = ROOT) {
  const localPath = join(repoRoot, '.run', 'server.local.json');
  return {
    committed: 'server.json',
    overlay: '.run/server.local.json',
    overlayExists: existsSync(localPath),
    note: 'Local overlay is gitignored. Copy world_profile/durability/base_map_* from committed server.json; do not keep runtime-only or process-crash.',
  };
}

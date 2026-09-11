/**
 * Operator-fillable DS config (R-00520 / S1).
 *
 * Committed `server.json` is a locally runnable template: allocation strings
 * and `admission_public_key_hex` are syntactic stand-ins so `lumio-ds
 * --check-config` is not refused for `replace-*` / `REPLACE_WITH_…`. They are
 * not Platform tickets. Real tickets still come from `loginAndLaunch`.
 *
 * Missing required values and leftover placeholder tokens fail loudly
 * (`MISSING_VALUE`), never as a placeholder `BLOCKED_ENV`.
 */

export const ALLOCATION_KEYS = Object.freeze([
  'serverAudience',
  'gameId',
  'gameReleaseId',
  'contractId',
  'roomId',
  'allocationId',
]);

export const PLACEHOLDER_PUBLIC_KEY = 'REPLACE_WITH_PLATFORM_32_BYTE_PUBLIC_KEY_HEX';
export const HEX64 = /^[0-9a-fA-F]{64}$/;

export class MissingValueError extends Error {
  constructor(message) {
    super(`missing required value: ${message}`);
    this.name = 'MissingValueError';
    this.code = 'MISSING_VALUE';
  }
}

function missing(message) {
  return new MissingValueError(message);
}

export function isPlaceholderToken(value) {
  const text = String(value ?? '').trim();
  if (text.length === 0) return false;
  if (text === PLACEHOLDER_PUBLIC_KEY) return true;
  if (text === '__unbound__') return true;
  return text.startsWith('replace-');
}

export function assertRunnableDsConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw missing('server.json must parse as an object');
  }
  const allocation = config.allocation;
  if (!allocation || typeof allocation !== 'object' || Array.isArray(allocation)) {
    throw missing('allocation is required');
  }
  for (const key of ALLOCATION_KEYS) {
    const raw = allocation[key];
    if (raw == null || String(raw).trim() === '') {
      throw missing(`allocation.${key}`);
    }
    const text = String(raw).trim();
    if (isPlaceholderToken(text)) {
      throw missing(
        `allocation.${key} is the placeholder token ${JSON.stringify(text)}; fill a local stand-in or gitignored .run/server.local.json from Platform`,
      );
    }
  }
  const hex = config.admission_public_key_hex;
  if (hex == null || String(hex).trim() === '') {
    throw missing('admission_public_key_hex');
  }
  const key = String(hex).trim();
  if (key === PLACEHOLDER_PUBLIC_KEY || isPlaceholderToken(key) || !HEX64.test(key)) {
    throw missing(
      'admission_public_key_hex must be 64 hex characters (32 bytes); REPLACE_WITH_PLATFORM_32_BYTE_PUBLIC_KEY_HEX is not accepted',
    );
  }
  return config;
}

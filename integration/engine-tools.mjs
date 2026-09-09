import { existsSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export class BlockedEnvError extends Error {
  constructor(message) {
    super(`BLOCKED_ENV: ${message}`);
    this.name = 'BlockedEnvError';
    this.code = 'BLOCKED_ENV';
  }
}

export function blocked(message) {
  return new BlockedEnvError(message);
}

export function candidateEngineRoots({ env = process.env, repoRoot } = {}) {
  const values = [
    env.LUMIO_ENGINE_ROOT,
    repoRoot ? resolve(repoRoot, '..', 'LumioGameEngine') : undefined,
  ].filter((value) => typeof value === 'string' && value.trim() !== '');
  return values.map((value) => resolve(value));
}

export function resolveProcessToolsPath({ env = process.env, repoRoot } = {}) {
  for (const root of candidateEngineRoots({ env, repoRoot })) {
    const file = join(root, 'eng', 'process-tools.mjs');
    if (existsSync(file)) return file;
  }
  return null;
}

export async function loadProcessTools({ env = process.env, repoRoot } = {}) {
  const file = resolveProcessToolsPath({ env, repoRoot });
  if (!file) {
    throw blocked('LUMIO_ENGINE_ROOT / sibling LumioGameEngine/eng/process-tools.mjs is missing.');
  }
  const module = await import(pathToFileURL(file).href);
  for (const name of ['command', 'startLogged', 'assertAlive', 'waitExit', 'forceCleanup']) {
    if (typeof module[name] !== 'function') {
      throw blocked(`process-tools.mjs is missing ${name}(); do not rewrite process management here.`);
    }
  }
  return module;
}

export function assertRelativePath(value, label) {
  const text = String(value ?? '');
  if (text.length === 0) throw new Error(`${label} is required.`);
  if (isAbsolute(text) || text.startsWith('~')) {
    throw new Error(`${label} must be a repository-relative path, not ${text}`);
  }
  if (text.includes('\\') && !text.includes('/')) {
    return text.replaceAll('\\', '/');
  }
  return text;
}

export function repoSibling(repoRoot, ...parts) {
  return resolve(dirname(resolve(repoRoot)), ...parts);
}

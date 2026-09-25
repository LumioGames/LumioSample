#!/usr/bin/env node

/**
 * Switch this game to another engine release (ADR-123 决策 6):
 *
 *   node Tools/update-engine.mjs <version>        e.g. 0.0.2  → tag v0.0.2
 *
 * 1. shallow-fetch tag v<version> of LumioEngineRelease;
 * 2. run *that* release's own tools/verify-release.mjs for this machine's <rid>;
 * 3. only then move the Engine/ submodule to it and stage the pointer (`git add Engine`).
 *
 * Any failure — the tag does not exist, the release does not verify, this platform is not in
 * it — leaves the submodule pointer and Engine/'s checkout exactly as they were. Committing the
 * staged pointer is the developer's step; the command prints it.
 *
 * The first pin (no Engine gitlink yet, `.gitmodules` only) goes through the same three steps:
 * the verified clone becomes the submodule.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertPlatform, ENGINE_DIR, ENGINE_URL, hostRid, readManifest, verifyRelease } from './engine-release.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export class UpdateError extends Error {
  constructor(message) {
    super(`ENGINE_UPDATE_FAILED: ${message}`);
    this.name = 'UpdateError';
    this.code = 'ENGINE_UPDATE_FAILED';
  }
}

function defaultGit(args, { cwd }) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function output(result) {
  return `${result?.stdout ?? ''}${result?.stderr ?? ''}${result?.error ? result.error.message : ''}`.trim();
}

/** The pointer as git records it: the gitlink in the index plus the submodule's checked-out HEAD. */
export function readPointer({ root = ROOT, git = defaultGit } = {}) {
  const index = git(['ls-files', '--stage', '--', ENGINE_DIR], { cwd: root });
  const line = String(index.stdout ?? '').trim();
  const gitlink = /^160000 ([0-9a-f]{40}) /.exec(line)?.[1] ?? null;
  const engine = join(root, ENGINE_DIR);
  let head = null;
  if (isOwnWorkTree(engine, git)) {
    const result = git(['rev-parse', 'HEAD'], { cwd: engine });
    if (result.status === 0) head = String(result.stdout).trim();
  }
  return { gitlink, head };
}

function isOwnWorkTree(dir, git) {
  if (!existsSync(join(dir, '.git'))) return false;
  const top = git(['rev-parse', '--show-toplevel'], { cwd: dir });
  if (top.status !== 0) return false;
  // Symlinked temp roots (macOS /var → /private/var) must not read as another tree.
  const canonical = (path) => { try { return realpathSync(path); } catch { return resolve(path); } };
  return canonical(String(top.stdout).trim()) === canonical(dir);
}

function submoduleUrl(root, git) {
  const result = git(['config', '-f', '.gitmodules', `submodule.${ENGINE_DIR}.url`], { cwd: root });
  const url = String(result.stdout ?? '').trim();
  return result.status === 0 && url ? url : ENGINE_URL;
}

/** Verify one checked-out release tree for this machine, with the tree's own verifier. */
function verifyTree(dir, rid, node) {
  const manifest = readManifest(dir);
  if (!manifest) throw new UpdateError(`${dir} has no manifest.json; it is not an engine release.`);
  try {
    assertPlatform(manifest, rid);
    verifyRelease({ root: dir, rid, node });
  } catch (error) {
    throw new UpdateError(error.message);
  }
  return manifest;
}

export function updateEngine({
  version, root = ROOT, rid = hostRid(), git = defaultGit, node, log = (line) => process.stdout.write(`${line}\n`),
} = {}) {
  if (!VERSION.test(String(version ?? ''))) {
    throw new UpdateError(`"${version}" is not a release version (expected X.Y.Z, tag vX.Y.Z).`);
  }
  const tag = `v${version}`;
  const engine = join(root, ENGINE_DIR);
  const url = submoduleUrl(root, git);
  const before = readPointer({ root, git });
  const run = (args, cwd, what) => {
    const result = git(args, { cwd });
    if (result.error || result.status !== 0) throw new UpdateError(`${what}: ${output(result) || `git ${args.join(' ')} exited ${result.status}`}`);
    return result;
  };

  // A gitlink whose submodule was never checked out: initialise it first (pointer unchanged).
  if (before.gitlink && !isOwnWorkTree(engine, git)) {
    run(['submodule', 'update', '--init', '--depth', '1', ENGINE_DIR], root, 'initialising Engine/');
  }

  if (isOwnWorkTree(engine, git)) {
    log(`fetching ${tag} from ${url}`);
    run(['fetch', '--depth', '1', 'origin', 'tag', tag, '--no-tags'], engine, `tag ${tag} is not in ${url}`);
    mkdirSync(join(root, '.run'), { recursive: true });
    const scratch = mkdtempSync(join(root, '.run', 'engine-verify-'));
    run(['worktree', 'add', '--detach', scratch, tag], engine, `checking out ${tag} for verification`);
    let manifest;
    try {
      manifest = verifyTree(scratch, rid, node);
    } finally {
      git(['worktree', 'remove', '--force', scratch], { cwd: engine });
      rmSync(scratch, { recursive: true, force: true });
    }
    if (manifest.version !== version) throw new UpdateError(`${tag} carries manifest version ${manifest.version}.`);
    run(['checkout', '--detach', tag], engine, `switching Engine/ to ${tag}`);
  } else {
    // First pin: no gitlink yet. Engine/ must not hold a tree git does not own (a pack-release
    // --from-main fill, say): replacing it silently would lose someone's work.
    if (existsSync(engine) && readdirSync(engine).length > 0) {
      throw new UpdateError(`${engine} is not empty and is not the submodule; move it away, then re-run.`);
    }
    mkdirSync(join(root, '.run'), { recursive: true });
    const scratch = mkdtempSync(join(root, '.run', 'engine-clone-'));
    const clone = join(scratch, 'Engine');
    log(`cloning ${tag} from ${url}`);
    try {
      run(['clone', '--depth', '1', '--branch', tag, url, clone], root, `tag ${tag} is not in ${url}`);
      const manifest = verifyTree(clone, rid, node);
      if (manifest.version !== version) throw new UpdateError(`${tag} carries manifest version ${manifest.version}.`);
      rmSync(engine, { recursive: true, force: true });
      renameSync(clone, engine);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    // Registers the existing clone as the submodule (url and path as .gitmodules states them)
    // and moves its .git into .git/modules like any `git submodule update --init` would.
    run(['submodule', 'add', '--force', url, ENGINE_DIR], root, 'registering Engine/ as a submodule');
    run(['submodule', 'absorbgitdirs', ENGINE_DIR], root, 'absorbing Engine/.git');
  }

  run(['add', ENGINE_DIR], root, 'staging the Engine/ pointer');
  const after = readPointer({ root, git });
  log(`Engine/ is now ${tag} (${after.gitlink}); verified for ${rid}.`);
  log(`Commit it: git commit -m "engine: ${tag}" -- .gitmodules ${ENGINE_DIR}`);
  return { tag, before, after };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || args[0].startsWith('-')) {
    process.stderr.write('Usage: node Tools/update-engine.mjs <version>   (e.g. 0.0.2 for tag v0.0.2)\n');
    process.exitCode = 1;
  } else {
    try {
      updateEngine({ version: args[0] });
    } catch (error) {
      process.stderr.write(`${error?.message ?? error}\nEngine/ pointer unchanged.\n`);
      process.exitCode = 1;
    }
  }
}

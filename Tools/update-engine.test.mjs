import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readPointer, updateEngine } from './update-engine.mjs';

const RID = 'linux-x64';

/** git with a fixed identity; file:// submodules are allowed only inside these fixtures. */
function git(args, { cwd }) {
  return spawnSync('git', ['-c', 'protocol.file.allow=always', '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' });
}

function must(args, cwd) {
  const result = git(args, { cwd });
  assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
  return String(result.stdout).trim();
}

/** A LumioEngineRelease stand-in: one commit + tag per release; `verifies:false` ships a verifier that rejects. */
function releaseRepo(releases) {
  const repo = mkdtempSync(join(tmpdir(), 'lumio-release-repo-'));
  must(['init', '-q'], repo);
  const tags = {};
  for (const { version, verifies = true, platforms = [RID] } of releases) {
    mkdirSync(join(repo, 'tools'), { recursive: true });
    writeFileSync(join(repo, 'manifest.json'), JSON.stringify({ formatVersion: 1, version, platforms, sources: {}, files: {} }));
    writeFileSync(join(repo, 'tools', 'verify-release.mjs'), verifies ? 'process.exit(0);\n' : 'console.error("sha256 mismatch"); process.exit(1);\n');
    must(['add', '-A'], repo);
    must(['commit', '-q', '-m', `release ${version}`], repo);
    must(['tag', `v${version}`], repo);
    tags[version] = must(['rev-parse', 'HEAD'], repo);
  }
  return { url: `file://${repo}`, tags };
}

/** A game repository whose .gitmodules registers Engine but has no gitlink yet (R-00779's state). */
function gameRepo(url) {
  const repo = mkdtempSync(join(tmpdir(), 'lumio-game-repo-'));
  must(['init', '-q'], repo);
  writeFileSync(join(repo, '.gitmodules'), `[submodule "Engine"]\n\tpath = Engine\n\turl = ${url}\n\tshallow = true\n`);
  must(['add', '.gitmodules'], repo);
  must(['commit', '-q', '-m', 'register Engine'], repo);
  return repo;
}

const quiet = () => {};

test('an unknown version leaves a never-pinned Engine/ unpinned and empty', () => {
  const release = releaseRepo([{ version: '0.0.1' }]);
  const repo = gameRepo(release.url);
  assert.throws(() => updateEngine({ version: '0.0.9', root: repo, rid: RID, git, log: quiet }), /ENGINE_UPDATE_FAILED: tag v0\.0\.9 is not in/);
  assert.deepEqual(readPointer({ root: repo, git }), { gitlink: null, head: null });
  assert.ok(!existsSync(join(repo, 'Engine')) || !existsSync(join(repo, 'Engine', 'manifest.json')));
});

test('the first pin, then switches: success moves the pointer, every failure leaves it exactly where it was', () => {
  const release = releaseRepo([{ version: '0.0.1' }, { version: '0.0.2', verifies: false }, { version: '0.0.3', platforms: ['win-x64'] }, { version: '0.0.4' }]);
  const repo = gameRepo(release.url);

  updateEngine({ version: '0.0.1', root: repo, rid: RID, git, log: quiet });
  const pinned = readPointer({ root: repo, git });
  assert.deepEqual(pinned, { gitlink: release.tags['0.0.1'], head: release.tags['0.0.1'] });
  assert.equal(must(['config', '-f', '.gitmodules', 'submodule.Engine.shallow'], repo), 'true');
  must(['commit', '-q', '-m', 'engine: v0.0.1'], repo);

  // Tag does not exist.
  assert.throws(() => updateEngine({ version: '0.0.9', root: repo, rid: RID, git, log: quiet }), /tag v0\.0\.9 is not in/);
  assert.deepEqual(readPointer({ root: repo, git }), pinned);
  // The new release's own verify-release rejects it.
  assert.throws(() => updateEngine({ version: '0.0.2', root: repo, rid: RID, git, log: quiet }), /sha256 mismatch/);
  assert.deepEqual(readPointer({ root: repo, git }), pinned);
  // The new release does not ship this platform.
  assert.throws(() => updateEngine({ version: '0.0.3', root: repo, rid: RID, git, log: quiet }), /this machine is linux-x64/);
  assert.deepEqual(readPointer({ root: repo, git }), pinned);
  // Not a version at all.
  assert.throws(() => updateEngine({ version: 'latest', root: repo, rid: RID, git, log: quiet }), /not a release version/);
  assert.deepEqual(readPointer({ root: repo, git }), pinned);

  const lines = [];
  updateEngine({ version: '0.0.4', root: repo, rid: RID, git, log: (line) => lines.push(line) });
  assert.deepEqual(readPointer({ root: repo, git }), { gitlink: release.tags['0.0.4'], head: release.tags['0.0.4'] });
  assert.ok(lines.some((line) => line.startsWith('Commit it: git commit')));
  // Staged, not committed: committing is the developer's step.
  assert.equal(must(['ls-tree', 'HEAD', 'Engine'], repo), `160000 commit ${release.tags['0.0.1']}\tEngine`);
});

test('a first pin refuses to replace an Engine/ tree git does not own', () => {
  const release = releaseRepo([{ version: '0.0.1' }]);
  const repo = gameRepo(release.url);
  mkdirSync(join(repo, 'Engine'));
  writeFileSync(join(repo, 'Engine', 'manifest.json'), '{"version":"0.0.1-main.abc","platforms":[]}');
  assert.throws(() => updateEngine({ version: '0.0.1', root: repo, rid: RID, git, log: quiet }), /is not empty and is not the submodule/);
  assert.ok(existsSync(join(repo, 'Engine', 'manifest.json')));
  assert.equal(readPointer({ root: repo, git }).gitlink, null);
});

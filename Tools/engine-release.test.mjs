import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  assertPlatform,
  ensureEngine,
  hostRid,
  nativeLibraryName,
  prepareEngine,
  readManifest,
  releaseLayout,
  resolveHostfxr,
  SUBMODULE_INIT_COMMAND,
  verifyRelease,
} from './engine-release.mjs';
import { runLauncher, startReleasePlatform } from './launcher.mjs';

function writeRelease(root, { version = '0.0.1', platforms = [hostRid()], verify = 'process.exit(0);' } = {}) {
  mkdirSync(join(root, 'tools'), { recursive: true });
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({ formatVersion: 1, version, platforms, sources: {}, files: {} }));
  if (verify != null) writeFileSync(join(root, 'tools', 'verify-release.mjs'), verify);
}

test('the host rid is spelled the way the release names platforms', () => {
  assert.equal(hostRid('win32', 'x64'), 'win-x64');
  assert.equal(hostRid('darwin', 'arm64'), 'osx-arm64');
  assert.equal(hostRid('linux', 'x64'), 'linux-x64');
  assert.equal(nativeLibraryName('win-x64'), 'lumio_engine_native.dll');
  assert.equal(nativeLibraryName('osx-arm64'), 'liblumio_engine_native.dylib');
  assert.equal(nativeLibraryName('linux-x64'), 'liblumio_engine_native.so');
});

test('the release layout is the ADR-123 tree and nothing outside Engine/', () => {
  const layout = releaseLayout('/g/Sample/Engine', 'linux-x64');
  assert.equal(layout.dsExe, '/g/Sample/Engine/server/linux-x64/lumio-ds');
  assert.equal(releaseLayout('/g/Sample/Engine', 'win-x64').dsExe, '/g/Sample/Engine/server/win-x64/lumio-ds.exe');
  assert.equal(layout.hostEntry, '/g/Sample/Engine/server/linux-x64/Application/Lumio.Server.HostEntry.dll');
  assert.equal(layout.engineNative, '/g/Sample/Engine/server/linux-x64/SDK/Native/linux-x64/liblumio_engine_native.so');
  assert.equal(layout.ecsAssembly, '/g/Sample/Engine/server/linux-x64/SDK/Managed/Lumio.GameRuntime.Ecs.dll');
  assert.equal(layout.botHost, '/g/Sample/Engine/bot/linux-x64/Lumio.Client.Bot.Host.dll');
  assert.equal(layout.processTools, '/g/Sample/Engine/tools/process-tools.mjs');
  assert.equal(layout.verifyRelease, '/g/Sample/Engine/tools/verify-release.mjs');
  assert.equal(layout.platformCompose, '/g/Sample/Engine/platform/docker-compose.yml');
  for (const value of Object.values(layout)) {
    if (typeof value === 'string' && value.startsWith('/')) assert.ok(value.startsWith('/g/Sample/Engine'), value);
  }
});

test('an empty Engine/ is initialised exactly once; filled by that one command it is used', () => {
  const repo = mkdtempSync(join(tmpdir(), 'lumio-engine-init-'));
  const calls = [];
  const result = ensureEngine({
    repoRoot: repo,
    git: (args, { cwd }) => {
      calls.push({ args, cwd });
      writeRelease(join(repo, 'Engine'));
      return { status: 0, stdout: '', stderr: '' };
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(`git ${calls[0].args.join(' ')}`, SUBMODULE_INIT_COMMAND);
  assert.equal(calls[0].cwd, repo);
  assert.equal(result.initialized, true);
  assert.equal(result.manifest.version, '0.0.1');
  // Already filled: no git at all.
  assert.equal(ensureEngine({ repoRoot: repo, git: () => { throw new Error('must not run git'); } }).initialized, false);
});

test('an Engine/ the one init cannot fill is BLOCKED_ENV carrying the exact command', () => {
  const repo = mkdtempSync(join(tmpdir(), 'lumio-engine-offline-'));
  let calls = 0;
  assert.throws(
    () => ensureEngine({ repoRoot: repo, git: () => { calls += 1; return { status: 128, stderr: 'Could not resolve host: github.com' }; } }),
    (error) => {
      assert.equal(error.code, 'BLOCKED_ENV');
      assert.ok(error.message.includes(SUBMODULE_INIT_COMMAND));
      assert.match(error.message, /Could not resolve host/);
      return true;
    },
  );
  assert.equal(calls, 1);
});

test('a platform the manifest does not list is BLOCKED_ENV naming it, never another platform', () => {
  const manifest = { version: '0.0.1', platforms: ['win-x64', 'linux-x64'] };
  assert.doesNotThrow(() => assertPlatform(manifest, 'linux-x64'));
  assert.throws(() => assertPlatform(manifest, 'osx-arm64'), (error) => {
    assert.equal(error.code, 'BLOCKED_ENV');
    assert.match(error.message, /this machine is osx-arm64/);
    assert.match(error.message, /\[win-x64, linux-x64\]/);
    return true;
  });
});

test('verify-release is the release\'s own script, called with --root and --rid; a rejection is a hard failure', () => {
  const root = mkdtempSync(join(tmpdir(), 'lumio-engine-verify-'));
  writeRelease(root, { verify: 'console.log(JSON.stringify(process.argv.slice(2)));' });
  assert.equal(verifyRelease({ root, rid: 'linux-x64' }), JSON.stringify(['--root', root, '--rid', 'linux-x64']));
  writeRelease(root, { verify: 'console.error("sdk_version_mismatch: nupkg 0.0.2 vs manifest 0.0.1"); process.exit(1);' });
  assert.throws(() => verifyRelease({ root, rid: 'linux-x64' }), (error) => {
    assert.equal(error.code, 'ENGINE_RELEASE_INVALID');
    assert.match(error.message, /sdk_version_mismatch/);
    return true;
  });
  writeRelease(root, { verify: null });
  const bare = mkdtempSync(join(tmpdir(), 'lumio-engine-noverify-'));
  writeFileSync(join(bare, 'manifest.json'), JSON.stringify({ version: '0.0.1', platforms: [] }));
  assert.throws(() => verifyRelease({ root: bare, rid: 'linux-x64' }), /verify-release\.mjs is missing/);
});

test('prepareEngine checks the platform before running verify-release', () => {
  const repo = mkdtempSync(join(tmpdir(), 'lumio-engine-prepare-'));
  writeRelease(join(repo, 'Engine'), { platforms: ['win-x64'], verify: 'process.exit(3);' });
  assert.throws(() => prepareEngine({ repoRoot: repo, rid: 'linux-x64' }), (error) => {
    assert.equal(error.code, 'BLOCKED_ENV');
    assert.match(error.message, /linux-x64/);
    return true;
  });
  writeRelease(join(repo, 'Engine'), { platforms: ['linux-x64'] });
  const prepared = prepareEngine({ repoRoot: repo, rid: 'linux-x64' });
  assert.equal(prepared.layout.rid, 'linux-x64');
  assert.equal(prepared.dir, join(repo, 'Engine'));
});

test('a manifest without version/platforms is an invalid release, not an empty one', () => {
  const root = mkdtempSync(join(tmpdir(), 'lumio-engine-manifest-'));
  assert.equal(readManifest(root), null);
  writeFileSync(join(root, 'manifest.json'), '{"formatVersion":1}');
  assert.throws(() => readManifest(root), /ENGINE_RELEASE_INVALID/);
});

test('hostfxr comes from this machine\'s dotnet install, highest host/fxr version first', () => {
  const root = mkdtempSync(join(tmpdir(), 'lumio-dotnet-'));
  for (const version of ['9.0.4', '10.0.0', '10.0.11']) {
    mkdirSync(join(root, 'host', 'fxr', version), { recursive: true });
    writeFileSync(join(root, 'host', 'fxr', version, 'libhostfxr.so'), '');
  }
  assert.equal(resolveHostfxr({ env: { DOTNET_ROOT: root, PATH: '' }, platform: 'linux' }), join(root, 'host', 'fxr', '10.0.11', 'libhostfxr.so'));
  assert.throws(() => resolveHostfxr({ env: { DOTNET_ROOT: join(root, 'none'), PATH: '' }, dotnet: 'no-such-dotnet', platform: 'linux' }), (error) => {
    assert.equal(error.code, 'BLOCKED_ENV');
    assert.match(error.message, /libhostfxr\.so/);
    return true;
  });
});

test('the launcher refuses a release without this platform at step 02 and starts nothing', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'lumio-launch-rid-'));
  writeRelease(join(repo, 'Engine'), { platforms: ['win-x64'] });
  const report = await runLauncher({
    root: repo,
    env: {},
    bots: 1,
    rid: 'linux-x64',
    git: () => { throw new Error('a filled Engine/ is not re-initialised'); },
    log() {},
    evidenceDir: join(repo, 'evidence'),
  });
  assert.equal(report.status, 'BLOCKED_ENV');
  for (const step of report.steps.slice(1)) {
    assert.equal(step.status, 'BLOCKED_ENV');
    assert.match(step.detail, /this machine is linux-x64/);
  }
});

test('the launcher fails (not BLOCKED_ENV) when verify-release rejects the tree', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'lumio-launch-verify-'));
  writeRelease(join(repo, 'Engine'), { verify: 'console.error("sha256 mismatch: server/x/lumio-ds"); process.exit(1);' });
  await assert.rejects(
    () => runLauncher({ root: repo, env: {}, bots: 1, log() {}, evidenceDir: join(repo, 'evidence') }),
    (error) => {
      assert.equal(error.code, 'ENGINE_RELEASE_INVALID');
      assert.match(error.message, /sha256 mismatch/);
      return true;
    },
  );
});

function fakeDocker(script) {
  const calls = [];
  const run = (command, args, options) => {
    calls.push({ command, args, env: options?.env });
    return script(args) ?? { status: 0, stdout: '', stderr: '' };
  };
  return { calls, run };
}

function platformFixture() {
  const repo = mkdtempSync(join(tmpdir(), 'lumio-platform-'));
  const layout = releaseLayout(join(repo, 'Engine'), 'linux-x64');
  mkdirSync(join(repo, 'Engine', 'platform'), { recursive: true });
  writeFileSync(layout.platformCompose, 'services: {}\n');
  mkdirSync(join(repo, 'Tools', 'compose', 'games'), { recursive: true });
  writeFileSync(join(repo, 'Tools', 'compose', 'platform.env'), '');
  writeFileSync(join(repo, 'Tools', 'compose', 'seed-games.sql'), '');
  return { repo, layout, manifest: { version: '0.0.1', platformImage: 'ghcr.io/lumiogames/lumio-platform:0.0.1@sha256:ab' } };
}

test('Platform runs from Engine/platform with the manifest image and this game\'s Tools/compose inputs', async () => {
  const { repo, layout, manifest } = platformFixture();
  const docker = fakeDocker((args) => (args.includes('wait') ? { status: 0, stdout: '0\n', stderr: '' } : undefined));
  const platform = await startReleasePlatform({
    layout, manifest, root: repo, run: docker.run, fetchFn: async () => ({ ok: true }), env: {},
  });
  assert.equal(platform.origin, 'http://127.0.0.1:8080');
  const up = docker.calls.find((call) => call.args.includes('up'));
  assert.deepEqual(up.args.slice(0, 5), ['compose', '-f', layout.platformCompose, '-p', 'lumio-sample-platform']);
  assert.equal(up.env.LUMIO_PLATFORM_IMAGE, manifest.platformImage);
  assert.equal(up.env.LUMIO_GAME_PLATFORM_DIR, join(repo, 'Tools', 'compose'));
  platform.stop();
  assert.ok(docker.calls.some((call) => call.args.includes('down') && call.args.includes('-v')));
});

test('no docker is BLOCKED_ENV before anything starts', async () => {
  const { repo, layout, manifest } = platformFixture();
  const docker = fakeDocker((args) => (args[1] === 'version' ? { status: null, error: new Error('spawn docker ENOENT') } : undefined));
  await assert.rejects(
    () => startReleasePlatform({ layout, manifest, root: repo, run: docker.run, fetchFn: async () => ({ ok: true }), env: {} }),
    (error) => {
      assert.equal(error.code, 'BLOCKED_ENV');
      assert.match(error.message, /docker compose is not available/);
      return true;
    },
  );
  assert.ok(!docker.calls.some((call) => call.args.includes('up')));
});

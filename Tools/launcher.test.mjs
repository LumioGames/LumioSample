import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadProcessTools, processToolsPath } from './engine-tools.mjs';
import { hostRid, releaseLayout } from './engine-release.mjs';
import {
  collectLaunchTickets,
  startReleasePlatform,
  choosePlatformHostPort,
  DEFAULT_SPECTATOR_LOGIN,
  injectSpectatorLaunch,
  normalizeSpectatorPageUrl,
  parseBotAdmit,
  parseLaunchArgs,
  planLaunchLogins,
  resolveBotVoxelConfig,
  runLauncher,
  startSpectatorHost,
} from './launcher.mjs';
import { DS_CLR_INPUTS } from './ds-config.mjs';
import {
  checkpointGenerations,
  formatStep,
  judgeCheckpoint,
  judgeRestore,
  judgeTourSteps,
  planBotLogins,
  RESTORE_SCENARIO,
  scenarioVerdict,
  parseBotResult,
  TOUR_ASSERTIONS,
  TOUR_CHAT_TEXT,
  TOUR_SCENARIO,
  TOUR_STEPS,
} from './tour-steps.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

function admitLine(account = 'Bot1') {
  return [
    `2026-09-08T00:00:00.0000000Z INF tick=1 world=0 lang=cs cat=Lumio.Client.Bot.Host.Connection`,
    `msg="session state changed ${account} Active Connecting established 1 1 True True True"`,
    `account=${account} state=Active previous=Connecting reason=established generation=1`,
    `handshakeBegin=1 baselineAck=True scopeActivated=True runtimeCommitted=True`,
  ].join(' ');
}

function rejectLine(account = 'Bot1') {
  return [
    `2026-09-08T00:00:00.0000000Z INF tick=0 world=0 lang=cs cat=Lumio.Client.Bot.Host.Connection`,
    `msg="session login requested ${account} ws://127.0.0.1:9110/session False"`,
    `account=${account} server=ws://127.0.0.1:9110/session accepted=False`,
  ].join(' ');
}

function faultLine(account = 'Bot1') {
  return [
    `2026-09-08T00:00:00.0000000Z ERR tick=2 world=0 lang=cs cat=Lumio.Client.Bot.Host.Connection`,
    `msg="session state changed ${account} Faulted Connecting session_faulted 1 0 False False False"`,
    `account=${account} state=Faulted previous=Connecting reason=session_faulted generation=1`,
  ].join(' ');
}

function session(name, ticket) {
  return {
    login: { loginName: name, accountId: `acct_${name}` },
    launch: { admissionCredential: ticket },
  };
}

function touch(root, name) {
  const path = join(root, name);
  writeFileSync(path, '');
  return path;
}

function processTools({ evidenceDir, botLogs = [] } = {}) {
  let starts = 0;
  const events = [];
  return {
    events,
    command() { return ''; },
    startLogged(_exe, args = [], { log } = {}) {
      starts += 1;
      events.push({ kind: 'start', at: Date.now(), starts, args: [...args], exe: _exe });
      if (starts === 1) {
        return {
          stdout: 'DS_READY {"pid":1,"endpoint":"ws://127.0.0.1:9110"}\n',
          child: { pid: 1, kill() {} },
          closed: false,
        };
      }
      const index = starts - 2;
      const text = botLogs[index] ?? '';
      if (log) writeFileSync(log, text);
      if (evidenceDir) {
        const botDir = join(evidenceDir, `bot-${index + 1}`);
        mkdirSync(botDir, { recursive: true });
        writeFileSync(join(botDir, '2026-09-08_000.log'), text);
      }
      return {
        stdout: text,
        child: { pid: 10 + index, kill() {} },
        closed: false,
      };
    },
    assertAlive() {},
    waitExit() { return Promise.resolve(); },
    forceCleanup() {
      events.push({ kind: 'cleanup', at: Date.now() });
      return Promise.resolve();
    },
  };
}

/** The game's own CLR input; the engine half comes from the (fake) Engine/ release. */
const CLR_FILES = {
  registry_assembly: 'Lumio.Sample.Gameplay.Server.dll',
};

/** Layout fields of the release a run reads; each becomes an empty file in the fake tree. */
const ENGINE_FILES = ['dsExe', 'hostEntry', 'hostEntryRuntimeConfig', 'replicationAssembly', 'ecsAssembly', 'engineNative', 'botHost'];

/**
 * An ADR-123 Engine/ tree for this machine's <rid>, already "verified": the shape runLauncher
 * gets back from prepareEngine. Files are empty; process-tools are injected per test.
 */
function fakeEngine(isolated, { rid = hostRid(), platformImage = 'ghcr.io/lumiogames/lumio-platform:0.0.1@sha256:00' } = {}) {
  const dir = join(isolated, 'Engine');
  const layout = releaseLayout(dir, rid);
  for (const key of ENGINE_FILES) {
    mkdirSync(resolve(layout[key], '..'), { recursive: true });
    writeFileSync(layout[key], '');
  }
  const manifest = { formatVersion: 1, version: '0.0.1', platforms: [rid], platformImage, sources: {}, files: {} };
  writeFileSync(join(dir, 'manifest.json'), `${JSON.stringify(manifest)}\n`);
  return { dir, manifest, rid, initialized: false, layout };
}

function runnableDsConfig() {
  return {
    clr: {
      ...CLR_FILES,
      kernel_config: { maxContexts: 64, maxHandles: 4096, maxNativeBytes: 67108864, maxJobsQueued: 256, maxJobsRunning: 4, maxCompletionItems: 1024, logMailboxCapacity: 8192 },
    },
    checkpoint_seconds: 30,
    logging: { dir: 'logs', min_level: 'info' },
    config_dir: '../Tables',
    allocation: {
      serverAudience: 'sample-local',
      gameId: 'sample',
      gameReleaseId: 'sample-local',
      contractId: 'sample-local',
      roomId: 'sample',
      allocationId: 'sample-local',
    },
    admission_public_key_hex: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  };
}

/** The committed budget plus its catalog, copied so an isolated root resolves them the same way. */
function voxelBudgetFiles(isolated) {
  const maps = join(isolated, 'Server', 'Assets', 'Maps');
  mkdirSync(maps, { recursive: true });
  writeFileSync(join(maps, 'official-catalog.json'), readFileSync(join(HERE, '..', 'Server', 'Assets', 'Maps', 'official-catalog.json')));
  writeFileSync(join(maps, 'bot-voxel-budget.json'), readFileSync(join(HERE, '..', 'Server', 'Assets', 'Maps', 'bot-voxel-budget.json')));
  return join(maps, 'bot-voxel-budget.json');
}

const SPECTATOR_INDEX = [
  '<!doctype html><html><head>',
  '<script type="importmap">{"imports":{}}</script>',
  '</head><body><script type="module" src="./main.js"></script></body></html>',
].join('\n');

/** A stand-in for the published spectator bundle (publish/wwwroot). */
function spectatorBundle(isolated) {
  const root = join(isolated, 'spectator-wwwroot');
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, 'index.html'), SPECTATOR_INDEX);
  writeFileSync(join(root, 'main.js'), 'export {};\n');
  return root;
}

function launchFiles(isolated) {
  const dsConfig = join(isolated, 'server.json');
  writeFileSync(dsConfig, `${JSON.stringify(runnableDsConfig())}\n`);
  // The run config resolves these against server.json's own directory, so they sit beside it.
  for (const name of Object.values(CLR_FILES)) touch(isolated, name);
  voxelBudgetFiles(isolated);
  return {
    engine: fakeEngine(isolated),
    hostfxr: touch(isolated, 'hostfxr.dll'),
    dsConfig,
    gameplay: touch(isolated, 'Lumio.Sample.Gameplay.dll'),
  };
}

const BLOCKED_TOUR_STEPS = ['05', '07', '08', '09', '10', '11', '12', '13', '14'];

function assertTourHonesty(report, lines = []) {
  for (const id of BLOCKED_TOUR_STEPS) {
    assert.equal(report.steps.find((step) => step.id === id).status, 'BLOCKED_ENV');
  }
  assert.notEqual(report.steps.find((step) => step.id === '05').status, 'PASS');
  assert.notEqual(report.steps.find((step) => step.id === '14').status, 'PASS');
  const joined = `${JSON.stringify(report)}\n${lines.join('\n')}`;
  assert.doesNotMatch(joined, /local-paint/);
  assert.doesNotMatch(joined, /SetLocalPose/);
  assert.doesNotMatch(joined, /step=0[5-9] status=PASS|step=1[0-4] status=PASS/);
}

test('tour steps are the fourteen sample.md steps with step=NN labels', () => {
  assert.equal(TOUR_STEPS.length, 14);
  assert.deepEqual(TOUR_STEPS.map((step) => step.id), [
    '01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12', '13', '14',
  ]);
  assert.equal(formatStep('07', 'BLOCKED_ENV', 'waiting'), 'step=07 status=BLOCKED_ENV waiting');
});

test('--bots N plans unique Bot namespace names without reuse', () => {
  assert.deepEqual(planBotLogins(3), ['Bot1', 'Bot2', 'Bot3']);
  assert.equal(new Set(planBotLogins(100)).size, 100);
  assert.throws(() => planBotLogins(0));
});

test('CLI parses --bots and --stagger-ms over environment', () => {
  const options = parseLaunchArgs(['--bots', '8', '--stagger-ms', '40'], { LUMIO_BOTS: '2', LUMIO_STAGGER_MS: '250' });
  assert.equal(options.bots, 8);
  assert.equal(options.staggerMs, 40);
});

test('CLI parses --fleet-per-process as an integer, not a leftover string', () => {
  // 回归:numeric 集合曾漏 fleetPerProcess,"20" 留成字符串被整数校验误拒(R-00588 打包压测)。
  assert.equal(parseLaunchArgs(['--fleet-per-process', '20'], {}).fleetPerProcess, 20);
  assert.equal(parseLaunchArgs(['--fleet-per-process', '1'], {}).fleetPerProcess, 1);
  assert.throws(() => parseLaunchArgs(['--fleet-per-process', 'x'], {}), /--fleet-per-process must be an integer/);
  assert.throws(() => parseLaunchArgs(['--fleet-per-process', '0'], {}), /--fleet-per-process must be an integer/);
});

test('CLI parses --gameplay and --duration-ms', () => {
  const options = parseLaunchArgs(['--gameplay', 'Lumio.Sample.Gameplay.dll', '--duration-ms', '80'], {});
  assert.equal(options.gameplay, 'Lumio.Sample.Gameplay.dll');
  assert.equal(options.durationMs, 80);
});

test('typed config export can be selected by environment or CLI', () => {
  assert.equal(parseLaunchArgs([], { LUMIO_CONFIG_DIR: 'export/env' }).configDir, 'export/env');
  assert.equal(parseLaunchArgs(['--config-dir', 'export/cli'], { LUMIO_CONFIG_DIR: 'export/env' }).configDir, 'export/cli');
});

test('CLI parses --spectator as a boolean flag without a value', () => {
  const options = parseLaunchArgs(['--bots', '100', '--spectator', '--duration-ms', '80'], {});
  assert.equal(options.bots, 100);
  assert.equal(options.spectator, true);
  assert.equal(options.durationMs, 80);
  assert.equal(options.spectatorLogin, DEFAULT_SPECTATOR_LOGIN);
});

test('CLI parses --spectator-url, --spectator-root and the static port', () => {
  const flagged = parseLaunchArgs(
    ['--spectator-url', 'http://127.0.0.1:8080/games/sample/'],
    {},
  );
  assert.equal(flagged.spectator, true);
  assert.equal(flagged.spectatorUrl, 'http://127.0.0.1:8080/games/sample/');
  const fromEnv = parseLaunchArgs(['--spectator'], {
    LUMIO_SPECTATOR_ROOT: 'out/wwwroot',
    LUMIO_SPECTATOR_STATIC_PORT: '9410',
    LUMIO_SPECTATOR_LOGIN: 'Spectator1',
  });
  assert.equal(fromEnv.spectator, true);
  assert.equal(fromEnv.spectatorRoot, 'out/wwwroot');
  assert.equal(fromEnv.spectatorStaticPort, '9410');
  assert.equal(fromEnv.spectatorLogin, 'Spectator1');
  assert.equal(parseLaunchArgs(['--spectator-root', 'cli/wwwroot'], { LUMIO_SPECTATOR_ROOT: 'env' }).spectatorRoot, 'cli/wwwroot');
  assert.throws(() => parseLaunchArgs(['--spectator-static-port', 'x'], {}), /--spectator-static-port/);
  assert.throws(() => parseLaunchArgs(['--spectator-origin', 'http://127.0.0.1:9090'], {}), /unknown option/);
  assert.throws(() => parseLaunchArgs(['--not-a-flag'], {}), /unknown option/);
});

test('default login names are ordinary without a bot-tool credential and Bot* with one (R-00785)', () => {
  // The engine release's Platform compose accepts no bot-tool credential, so a clean-machine run
  // with no LUMIO_BOT_TOOL_CREDENTIAL must not plan Bot* names (they are refused before login).
  assert.equal(parseLaunchArgs([], {}).loginPrefix, 'Player');
  assert.equal(parseLaunchArgs([], { LUMIO_BOT_TOOL_CREDENTIAL: 'abc_DEF-123' }).loginPrefix, 'Bot');
  assert.equal(parseLaunchArgs([], { LUMIO_LOGIN_PREFIX: 'Tour' }).loginPrefix, 'Tour');
  assert.equal(parseLaunchArgs(['--login-prefix', 'Tour'], {}).loginPrefix, 'Tour');
});

test('spectator login is appended after Bot1..BotN and does not collide', () => {
  assert.deepEqual(planLaunchLogins(3, { spectator: true }), ['Bot1', 'Bot2', 'Bot3', 'Spectator1']);
  const hundred = planLaunchLogins(100, { spectator: true });
  assert.equal(hundred.length, 101);
  assert.equal(hundred[99], 'Bot100');
  assert.equal(hundred[100], 'Spectator1');
  assert.equal(new Set(hundred).size, 101);
  assert.throws(
    () => planLaunchLogins(2, { spectator: true, spectatorLogin: 'Bot2' }),
    /collides/,
  );
});

test('an external spectator URL is printed without credentials', () => {
  assert.equal(
    normalizeSpectatorPageUrl('http://user:ticket-secret@127.0.0.1:8/games/sample?admission=ticket-secret#x'),
    'http://127.0.0.1:8/games/sample/',
  );
  assert.equal(normalizeSpectatorPageUrl('http://127.0.0.1:8080/'), 'http://127.0.0.1:8080/');
});

test('the launch is injected as window.__lumioLaunch in front of the first script', () => {
  const html = injectSpectatorLaunch(SPECTATOR_INDEX, {
    wsUrl: 'ws://127.0.0.1:9110/session',
    subprotocol: 'lumio.mvp.v0',
    admissionCredential: 'ticket-</script><b>',
    extra: 'dropped',
  });
  const injectAt = html.indexOf('window.__lumioLaunch');
  assert.ok(injectAt > 0);
  assert.ok(injectAt < html.indexOf('type="importmap"'));
  assert.ok(injectAt < html.indexOf('src="./main.js"'));
  assert.doesNotMatch(html, /ticket-<\/script>/);
  assert.doesNotMatch(html, /dropped/);
  const payload = html.slice(html.indexOf('= ', injectAt) + 2, html.indexOf(';</script>', injectAt));
  assert.deepEqual(JSON.parse(payload), {
    wsUrl: 'ws://127.0.0.1:9110/session',
    subprotocol: 'lumio.mvp.v0',
    admissionCredential: 'ticket-</script><b>',
  });
  assert.throws(() => injectSpectatorLaunch('<html></html>', { wsUrl: 'ws://x' }), /no <script>/);
});

test('the spectator host serves the bundle on loopback with the launch in index.html only', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-spec-host-'));
  const root = spectatorBundle(isolated);
  writeFileSync(join(isolated, 'outside.txt'), 'outside');
  const launch = { wsUrl: 'ws://127.0.0.1:9110/session', subprotocol: 'lumio.mvp.v0', admissionCredential: 'ticket-spec' };
  const { server, url } = await startSpectatorHost({ root, port: 0, launch });
  try {
    assert.match(url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
    assert.doesNotMatch(url, /ticket-spec/);
    for (const path of ['', 'index.html']) {
      const page = await fetch(new URL(path, url));
      assert.equal(page.status, 200);
      assert.equal(page.headers.get('cache-control'), 'no-store');
      assert.match(await page.text(), /window\.__lumioLaunch = \{"wsUrl":"ws:\/\/127\.0\.0\.1:9110\/session".*"admissionCredential":"ticket-spec"\}/);
    }
    const script = await fetch(new URL('main.js', url));
    assert.equal(script.status, 200);
    assert.match(script.headers.get('content-type'), /javascript/);
    assert.doesNotMatch(await script.text(), /ticket-spec/);
    assert.equal((await fetch(new URL('missing.js', url))).status, 404);
    assert.equal((await fetch(`${url}%2e%2e%2foutside.txt`)).status, 403);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolvePromise) => server.close(() => resolvePromise()));
  }
});

test('process-tools come from Engine/tools only and a missing one is BLOCKED_ENV, not a local helper', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-'));
  assert.equal(processToolsPath(join(isolated, 'Engine')), join(isolated, 'Engine', 'tools', 'process-tools.mjs'));
  await assert.rejects(() => loadProcessTools({ repoRoot: isolated }), (error) => {
    assert.equal(error.code, 'BLOCKED_ENV');
    assert.match(error.message, /Engine\/tools\/process-tools\.mjs is missing/);
    return true;
  });
  const tools = join(isolated, 'Engine', 'tools');
  mkdirSync(tools, { recursive: true });
  writeFileSync(join(tools, 'process-tools.mjs'), ['command', 'startLogged', 'assertAlive', 'waitExit', 'forceCleanup']
    .map((name) => `export function ${name}() {}`).join('\n'));
  const loaded = await loadProcessTools({ repoRoot: isolated });
  assert.equal(typeof loaded.forceCleanup, 'function');
});

test('an empty Engine/ is filled once with the submodule command, and still empty is BLOCKED_ENV on every step', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-root-'));
  writeFileSync(join(isolated, 'movement-placeholder'), '');
  const lines = [];
  const gitCalls = [];
  const report = await runLauncher({
    root: isolated,
    env: {},
    bots: 2,
    // No network in a test: the one init attempt fails the way an offline clone would.
    git: (args, { cwd }) => {
      gitCalls.push({ args, cwd });
      return { status: 128, stdout: '', stderr: 'fatal: unable to access github.com' };
    },
    log: (line) => lines.push(line),
    evidenceDir: join(isolated, 'evidence'),
  });
  assert.deepEqual(gitCalls, [{ args: ['submodule', 'update', '--init', '--depth', '1', 'Engine'], cwd: isolated }]);
  assert.equal(report.status, 'BLOCKED_ENV');
  assert.equal(report.steps.length, 14);
  assert.deepEqual(lines.filter((line) => !line.startsWith('step=')), ['Engine/ is empty; running: git submodule update --init --depth 1 Engine']);
  for (const step of report.steps.slice(1)) {
    assert.match(step.detail, /git submodule update --init --depth 1 Engine" did not fill it/);
  }
  assert.ok(report.steps.every((step) => step.status === 'BLOCKED_ENV'));
  assert.match(report.steps.find((step) => step.id === '01').detail, /typed Reader via M9 loader/);
});

test('step 01 is READY when both end manifests exist even without Platform', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-manifest-'));
  // split-export/1 writes one manifest per end; step 01 covers the whole export.
  for (const end of [['Server', 'Config', 'Tables'], ['Client', 'Config', 'Tables']]) {
    mkdirSync(join(isolated, ...end), { recursive: true });
    writeFileSync(join(isolated, ...end, 'manifest.json'), '{"revisionId":"test"}\n');
  }
  const report = await runLauncher({
    root: isolated,
    env: {},
    bots: 2,
    log() {},
    evidenceDir: join(isolated, 'evidence'),
  });
  assert.equal(report.steps.find((step) => step.id === '01').status, 'READY');
  assert.match(report.steps.find((step) => step.id === '01').detail, /typed Reader via M9 loader/);
  assert.equal(report.steps.find((step) => step.id === '02').status, 'BLOCKED_ENV');
  assert.equal(report.status, 'BLOCKED_ENV');
  for (const id of ['05', '07', '08', '09', '10', '11', '12', '13', '14']) {
    assert.equal(report.steps.find((step) => step.id === id).status, 'BLOCKED_ENV');
  }
});

test('injected tickets must stay unique per bot', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-tickets-'));
  const ticket = 'ticket-reuse';
  const session = {
    login: { loginName: 'Bot1', accountId: 'acct_00000000000000000000000000000001' },
    launch: { admissionCredential: ticket },
  };
  await assert.rejects(
    () => runLauncher({
      root: isolated,
      env: {},
      bots: 2,
      engine: fakeEngine(isolated),
      sessions: [session, session],
      processTools: {
        command() { return ''; },
        startLogged() { return { stdout: '', child: { pid: 1 } }; },
        assertAlive() {},
        waitExit() { return Promise.resolve(); },
        forceCleanup() { return Promise.resolve(); },
      },
      log() {},
      evidenceDir: join(isolated, 'evidence'),
    }),
    /unique/,
  );
});

test('started bots stay up for --duration-ms before forceCleanup', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-hold-'));
  const evidenceDir = join(isolated, 'evidence');
  const tools = processTools({ evidenceDir, botLogs: [admitLine('Bot1')] });
  const report = await runLauncher({
    root: isolated,
    env: {},
    bots: 1,
    staggerMs: 0,
    durationMs: 80,
    timeoutMs: 5_000,
    sessions: [session('Bot1', 'ticket-one')],
    ...launchFiles(isolated),
    processTools: tools,
    log() {},
    evidenceDir,
  });
  const firstStart = tools.events.find((event) => event.kind === 'start');
  const firstCleanup = tools.events.find((event) => event.kind === 'cleanup');
  assert.ok(firstStart);
  assert.ok(firstCleanup);
  assert.ok(firstCleanup.at - firstStart.at >= 70, `cleanup raced start by ${firstCleanup.at - firstStart.at}ms`);
  assert.equal(report.steps.find((step) => step.id === '04').status, 'PASS');
  assert.equal(report.admittedBots, 1);
  const botStart = tools.events.find((event) => event.kind === 'start' && event.args.includes('--gameplay'));
  // Bots are clients: they get the C export, never the DS's S+V tables.
  assert.equal(botStart.args[botStart.args.indexOf('--config-dir') + 1], join(isolated, 'Client', 'Config', 'Tables'));
  // No scenario assembly: step 04 is still proven, 05–14 name what is missing and nothing runs a scenario.
  for (const id of ['05', '06', '07', '08', '09', '10', '11', '12', '13', '14']) {
    const step = report.steps.find((entry) => entry.id === id);
    assert.equal(step.status, 'BLOCKED_ENV');
    assert.match(step.detail, /LUMIO_SCENARIO_DLL is not set/);
  }
  assert.ok(!botStart.args.includes('--scenario'));
});

test('a runtime+voxel DS with --voxel-config off blocks step 04 loudly (ADR-112 rev2 ix)', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-voxel-'));
  const evidenceDir = join(isolated, 'evidence');
  const tools = processTools({ evidenceDir, botLogs: [admitLine('Bot1')] });
  const files = launchFiles(isolated);
  const config = runnableDsConfig();
  config.world_profile = 'runtime+voxel';
  writeFileSync(files.dsConfig, JSON.stringify(config) + '\n');
  const report = await runLauncher({
    root: isolated,
    env: {},
    bots: 1,
    staggerMs: 0,
    durationMs: 80,
    timeoutMs: 5_000,
    // The committed budget is on by default (launchFiles copies it in); off is the only road to a
    // budget-less bot, so that is what the gate has to catch.
    voxelConfig: 'off',
    sessions: [session('Bot1', 'ticket-one')],
    ...files,
    processTools: tools,
    log() {},
    evidenceDir,
  });
  const step04 = report.steps.find((step) => step.id === '04');
  assert.equal(step04.status, 'BLOCKED_ENV');
  assert.match(step04.detail, /LUMIO_BOT_VOXEL_CONFIG/);
  assert.match(report.steps.find((step) => step.id === '07').detail, /waiting for a voxel-capable bot fleet/);
  assert.equal(report.status, 'BLOCKED_ENV');
  // No bot process may start: an entity-only fleet would session_fault on the first SectionFrame.
  assert.ok(!tools.events.some((event) => event.kind === 'start' && event.args.includes('--gameplay')));
});

test('admit wait keeps timers alive so Linux node --test cannot drop the timeout', () => {
  const text = readFileSync(new URL('launcher.mjs', import.meta.url), 'utf8');
  assert.match(text, /await sleepFn\(25, \{ keepAlive: true \}\)/);
  assert.match(text, /await sleep\(25, \{ keepAlive: true \}\)/);
});

test('parseBotAdmit requires Active+established and rejects ticket/fault', () => {
  assert.equal(parseBotAdmit(admitLine('Bot1')).admitted, true);
  assert.equal(parseBotAdmit('session login requested Bot1 ws://x True').admitted, false);
  assert.equal(parseBotAdmit(rejectLine('Bot1')).rejected, true);
  assert.equal(parseBotAdmit(rejectLine('Bot1')).admitted, false);
  assert.equal(parseBotAdmit(faultLine('Bot1')).faulted, true);
  assert.equal(parseBotAdmit('').admitted, false);
});

test('rejected ticket does not mark step 04 PASS', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-reject-'));
  const evidenceDir = join(isolated, 'evidence');
  const report = await runLauncher({
    root: isolated,
    env: {},
    bots: 1,
    staggerMs: 0,
    durationMs: 80,
    timeoutMs: 1_000,
    sessions: [session('Bot1', 'ticket-reject')],
    ...launchFiles(isolated),
    processTools: processTools({ evidenceDir, botLogs: [rejectLine('Bot1')] }),
    log() {},
    evidenceDir,
  });
  assert.notEqual(report.steps.find((step) => step.id === '04').status, 'PASS');
  assert.equal(report.steps.find((step) => step.id === '04').status, 'FAIL');
  assert.equal(report.admittedBots, 0);
  assert.equal(report.status, 'FAIL');
  assert.equal(report.steps.find((step) => step.id === '05').status, 'BLOCKED_ENV');
  assert.equal(report.steps.find((step) => step.id === '14').status, 'BLOCKED_ENV');
});

test('no welcome does not mark step 04 PASS', { timeout: 15_000 }, async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-nowelcome-'));
  const evidenceDir = join(isolated, 'evidence');
  const connecting = 'session state changed Bot1 Connecting None transport_connect 1 0 False False False';
  const report = await runLauncher({
    root: isolated,
    env: {},
    bots: 1,
    staggerMs: 0,
    durationMs: 0,
    timeoutMs: 1_000,
    sessions: [session('Bot1', 'ticket-silent')],
    ...launchFiles(isolated),
    processTools: processTools({ evidenceDir, botLogs: [connecting] }),
    log() {},
    evidenceDir,
  });
  assert.notEqual(report.steps.find((step) => step.id === '04').status, 'PASS');
  assert.equal(report.admittedBots, 0);
  assert.equal(report.steps.find((step) => step.id === '05').status, 'BLOCKED_ENV');
});

test('partial admit timeout does not mark step 04 PASS', { timeout: 15_000 }, async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-partial-'));
  const evidenceDir = join(isolated, 'evidence');
  const report = await runLauncher({
    root: isolated,
    env: {},
    bots: 2,
    staggerMs: 0,
    durationMs: 0,
    timeoutMs: 1_000,
    sessions: [session('Bot1', 'ticket-a'), session('Bot2', 'ticket-b')],
    ...launchFiles(isolated),
    processTools: processTools({ evidenceDir, botLogs: [admitLine('Bot1'), ''] }),
    log() {},
    evidenceDir,
  });
  assert.notEqual(report.steps.find((step) => step.id === '04').status, 'PASS');
  assert.equal(report.admittedBots, 1);
  assert.equal(report.requiredBots, 2);
  assert.equal(report.steps.find((step) => step.id === '05').status, 'BLOCKED_ENV');
  assert.equal(report.steps.find((step) => step.id === '14').status, 'BLOCKED_ENV');
});

test('launcher and helpers contain no retired Game harness paths', () => {
  const files = [
    'launcher.mjs',
    'stress-move.mjs',
    'engine-tools.mjs',
    'account-client.mjs',
    'tour-steps.mjs',
    'ds-config.mjs',
  ];
  for (const name of files) {
    const text = readFileSync(new URL(name, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /lumio-entity-chat-replay/);
    assert.doesNotMatch(text, /LumioServer\/account-server/);
    assert.doesNotMatch(text, /\/Users\//);
    assert.doesNotMatch(text, /\/home\//);
    // No machine's checkout, dotnet install or admission key may stand in for a missing variable.
    assert.doesNotMatch(text, /[A-Za-z]:[\\/](?:Work|Users|Program Files)/);
    assert.doesNotMatch(text, /\.dotnet[\\/]host[\\/]fxr/);
    assert.doesNotMatch(text, /9593f57065df3c73/);
  }
});

test('this test file does not keep formal-ds-smoke as the launcher', () => {
  assert.doesNotMatch(HERE, /formal-ds-smoke/);
});

test('missing env with --spectator stays BLOCKED_ENV and never fakes PASS', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-spec-env-'));
  const lines = [];
  const report = await runLauncher({
    root: isolated,
    env: {},
    bots: 100,
    spectator: true,
    log: (line) => lines.push(line),
    evidenceDir: join(isolated, 'evidence'),
  });
  assert.equal(report.status, 'BLOCKED_ENV');
  assert.equal(report.steps.length, 14);
  assert.ok(report.steps.every((step) => step.status === 'BLOCKED_ENV' || step.status === 'READY'));
  assert.equal(report.steps.find((step) => step.id === '02').status, 'BLOCKED_ENV');
  assertTourHonesty(report, lines);
});

test('100 bots + spectator mint 101 unique tickets and start 100 Bot.Host processes', { timeout: 30_000 }, async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-spec-100-'));
  const evidenceDir = join(isolated, 'evidence');
  const minted = [];
  const botLogs = Array.from({ length: 100 }, (_, index) => admitLine(`Bot${index + 1}`));
  const tools = processTools({ evidenceDir, botLogs });
  const lines = [];
  const report = await runLauncher({
    root: isolated,
    env: {},
    origin: 'http://127.0.0.1:1',
    bots: 100,
    spectator: true,
    spectatorRoot: spectatorBundle(isolated),
    staggerMs: 0,
    durationMs: 5_000,
    timeoutMs: 5_000,
    spectatorConnected: true,
    loginAndLaunch: async ({ loginName }) => {
      minted.push(loginName);
      return session(loginName, `ticket-${loginName}`);
    },
    ...launchFiles(isolated),
    processTools: tools,
    log: (line) => lines.push(line),
    evidenceDir,
  });

  assert.deepEqual(minted, planLaunchLogins(100, { spectator: true }));
  assert.equal(minted.length, 101);
  assert.equal(minted[100], 'Spectator1');
  const tickets = collectLaunchTickets(minted.map((name) => session(name, `ticket-${name}`)));
  assert.equal(tickets.length, 101);
  assert.equal(new Set(tickets).size, 101);
  assert.equal(report.loginAndLaunchCount, 101);
  assert.equal(report.requiredBots, 100);
  assert.equal(report.admittedBots, 100);
  assert.equal(report.botHostsStarted, 100);
  assert.equal(report.spectatorLogin, 'Spectator1');
  assert.equal(report.spectatorPage.status, 'HOSTED');
  assert.match(report.spectatorUrl, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  const starts = tools.events.filter((event) => event.kind === 'start');
  assert.equal(starts.length, 101, '1 lumio-ds + 100 Bot.Host');
  const botStarts = starts.slice(1);
  assert.equal(botStarts.length, 100);
  const startedArgs = botStarts.flatMap((event) => event.args);
  assert.ok(!startedArgs.includes('Spectator1'));
  assert.ok(!startedArgs.includes('ticket-Spectator1'));
  assert.ok(!startedArgs.some((value) => String(value).includes('ticket-Spectator1')));

  const urlLine = lines.find((line) => line.startsWith('spectator-url='));
  assert.equal(urlLine, `spectator-url=${report.spectatorUrl}`);
  assert.doesNotMatch(urlLine, /ticket-|admissionCredential|Spectator1-ticket/);
  for (const name of minted) {
    assert.doesNotMatch(urlLine, new RegExp(`ticket-${name}`));
  }

  assert.equal(report.steps.find((step) => step.id === '02').status, 'PASS');
  assert.match(report.steps.find((step) => step.id === '02').detail, /100 bot tickets \+ 1 spectator ticket/);
  assert.equal(report.steps.find((step) => step.id === '04').status, 'PASS');
  assert.match(report.steps.find((step) => step.id === '04').detail, /spectator ticket held without Bot.Host/);
  assert.equal(report.status, 'BLOCKED_ENV');
  assertTourHonesty(report, lines);
});

test('injected 100 bot + spectator tickets stay unique and still skip a 101st Bot.Host', { timeout: 30_000 }, async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-spec-inject-'));
  const evidenceDir = join(isolated, 'evidence');
  const sessions = [
    ...Array.from({ length: 100 }, (_, index) => session(`Bot${index + 1}`, `ticket-Bot${index + 1}`)),
    session('Spectator1', 'ticket-Spectator1'),
  ];
  assert.equal(collectLaunchTickets(sessions).length, 101);
  const botLogs = Array.from({ length: 100 }, (_, index) => admitLine(`Bot${index + 1}`));
  const tools = processTools({ evidenceDir, botLogs });
  const lines = [];
  const report = await runLauncher({
    root: isolated,
    env: {},
    bots: 100,
    spectator: true,
    spectatorUrl: 'http://127.0.0.1:8080/games/sample/',
    staggerMs: 0,
    durationMs: 5_000,
    timeoutMs: 5_000,
    spectatorConnected: true,
    sessions,
    ...launchFiles(isolated),
    processTools: tools,
    log: (line) => lines.push(line),
    evidenceDir,
  });
  assert.equal(report.loginAndLaunchCount, 101);
  assert.equal(report.botHostsStarted, 100);
  assert.equal(tools.events.filter((event) => event.kind === 'start').length, 101);
  assert.equal(report.spectatorPage.status, 'EXTERNAL');
  const urlLine = lines.find((line) => line.startsWith('spectator-url='));
  assert.equal(urlLine, 'spectator-url=http://127.0.0.1:8080/games/sample/');
  assert.doesNotMatch(urlLine, /ticket-Spectator1|admissionCredential/);
  assertTourHonesty(report, lines);
});

test('--spectator hold ends when the page reports connected without opening a browser', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-spec-hold-'));
  const evidenceDir = join(isolated, 'evidence');
  const tools = processTools({ evidenceDir, botLogs: [admitLine('Bot1')] });
  let resolveConnected;
  const spectatorConnected = new Promise((resolvePromise) => {
    resolveConnected = resolvePromise;
  });
  const hold = runLauncher({
    root: isolated,
    env: {},
    bots: 1,
    spectator: true,
    staggerMs: 0,
    durationMs: 5_000,
    timeoutMs: 5_000,
    spectatorConnected,
    sessions: [session('Bot1', 'ticket-bot'), session('Spectator1', 'ticket-spec')],
    ...launchFiles(isolated),
    processTools: tools,
    log() {},
    evidenceDir,
  });
  setTimeout(() => resolveConnected(), 40);
  const report = await hold;
  const firstStart = tools.events.find((event) => event.kind === 'start');
  const firstCleanup = tools.events.find((event) => event.kind === 'cleanup');
  assert.ok(firstCleanup.at - firstStart.at < 1_000, `hold ignored spectator connect (${firstCleanup.at - firstStart.at}ms)`);
  assert.ok(firstCleanup.at - firstStart.at >= 20);
  assert.equal(report.botHostsStarted, 1);
  assert.equal(report.loginAndLaunchCount, 2);
  // No published bundle under this root: the page is not served and nothing pretends it is.
  assert.equal(report.spectatorPage.status, 'BLOCKED_ENV');
  assert.equal(report.spectatorUrl, undefined);
  assertTourHonesty(report);
});

test('--spectator hold falls back to --duration-ms when the page never connects', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-spec-duration-'));
  const evidenceDir = join(isolated, 'evidence');
  const tools = processTools({ evidenceDir, botLogs: [admitLine('Bot1')] });
  const report = await runLauncher({
    root: isolated,
    env: {},
    bots: 1,
    spectator: true,
    staggerMs: 0,
    durationMs: 80,
    timeoutMs: 5_000,
    sessions: [session('Bot1', 'ticket-bot'), session('Spectator1', 'ticket-spec')],
    ...launchFiles(isolated),
    processTools: tools,
    log() {},
    evidenceDir,
  });
  const firstStart = tools.events.find((event) => event.kind === 'start');
  const firstCleanup = tools.events.find((event) => event.kind === 'cleanup');
  assert.ok(firstCleanup.at - firstStart.at >= 70, `duration hold raced start by ${firstCleanup.at - firstStart.at}ms`);
  assert.equal(report.botHostsStarted, 1);
  assert.equal(report.steps.find((step) => step.id === '05').status, 'BLOCKED_ENV');
});

test('launcher source does not green local-paint', () => {
  const text = readFileSync(new URL('launcher.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(text, /SetLocalPose/);
  assert.doesNotMatch(text, /local-paint/);
  assert.doesNotMatch(text, /BotStressMovement/);
});

test('root README names the launcher and does not keep formal-ds-smoke', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /Tools\/launcher\.mjs/);
  assert.doesNotMatch(readme, /formal-ds-smoke\.mjs/);
  assert.doesNotMatch(readme, /端到端启动器还没有/);
});

test('committed server.json and tour no longer claim runtime-only', () => {
  const server = readFileSync(new URL('../Server/Config/Startup/server.json', import.meta.url), 'utf8');
  const tour = readFileSync(new URL('../.spec/knowledge/features/sample-tour.md', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(server, /"world_profile": "runtime\+voxel"/);
  assert.match(server, /"durability": "snapshot_only"/);
  assert.doesNotMatch(server, /process-crash|power-loss|"runtime-only"/);
  assert.doesNotMatch(server, /replace-server-audience|REPLACE_WITH_PLATFORM_32_BYTE_PUBLIC_KEY_HEX/);
  assert.match(tour, /runtime\+voxel/);
  assert.doesNotMatch(tour, /仍是 `runtime-only`/);
  assert.match(readme, /runtime\+voxel/);
  assert.match(readme, /\.run\/server\.local\.json/);
});

test('a release without lumio-ds for this platform is BLOCKED_ENV naming the Engine/ path, not replace-* tokens', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-nodye-'));
  const evidenceDir = join(isolated, 'evidence');
  const engine = fakeEngine(isolated);
  rmSync(engine.layout.dsExe);
  const report = await runLauncher({
    root: isolated,
    env: {},
    bots: 1,
    staggerMs: 0,
    engine,
    sessions: [session('Bot1', 'ticket-nodye')],
    processTools: {
      command() { throw new Error('must not run lumio-ds'); },
      startLogged() { throw new Error('must not start lumio-ds'); },
      assertAlive() {},
      waitExit() { return Promise.resolve(); },
      forceCleanup() { return Promise.resolve(); },
    },
    log() {},
    evidenceDir,
  });
  const step03 = report.steps.find((step) => step.id === '03');
  assert.equal(step03.status, 'BLOCKED_ENV');
  assert.equal(step03.detail, `${engine.layout.dsExe} is missing from the Engine/ release.`);
  assert.doesNotMatch(step03.detail, /replace-|REPLACE_WITH_PLATFORM|missing required value/);
});

test('step 03 with the release lumio-ds boots on the committed template without replace-* tokens', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-dsconfig-'));
  const evidenceDir = join(isolated, 'evidence');
  const committed = JSON.parse(readFileSync(new URL('../Server/Config/Startup/server.json', import.meta.url), 'utf8'));
  // The template names only the game's assembly; put it where the template says, relative to itself.
  const startup = join(isolated, 'Server', 'Config', 'Startup');
  mkdirSync(startup, { recursive: true });
  writeFileSync(join(startup, 'server.json'), `${JSON.stringify(committed)}\n`);
  const registry = resolve(startup, committed.clr.registry_assembly);
  mkdirSync(resolve(registry, '..'), { recursive: true });
  writeFileSync(registry, '');
  voxelBudgetFiles(isolated);
  const engine = fakeEngine(isolated);
  const events = [];
  const report = await runLauncher({
    root: isolated,
    env: {},
    engine,
    hostfxr: touch(isolated, 'hostfxr.dll'),
    bots: 1,
    staggerMs: 0,
    durationMs: 0,
    timeoutMs: 1_000,
    sessions: [session('Bot1', 'ticket-ds')],
    dsConfig: join(startup, 'server.json'),
    processTools: {
      command() { return 'configuration_valid'; },
      startLogged(exe, args) {
        events.push({ exe, args });
        return {
          stdout: 'DS_READY {"pid":1,"endpoint":"ws://127.0.0.1:9110"}\n',
          child: { pid: 1, kill() {} },
          closed: false,
        };
      },
      assertAlive() {},
      waitExit() { return Promise.resolve(); },
      forceCleanup() { return Promise.resolve(); },
    },
    log() {},
    evidenceDir,
  });
  const step03 = report.steps.find((step) => step.id === '03');
  assert.equal(step03.status, 'PASS');
  assert.doesNotMatch(step03.detail, /replace-|REPLACE_WITH_PLATFORM/);
  // The DS that started is the release's, and its run config names the release's engine half.
  assert.equal(events[0].exe, engine.layout.dsExe);
  const clr = JSON.parse(readFileSync(events[0].args[1], 'utf8')).clr;
  assert.equal(clr.engine_native, engine.layout.engineNative);
  assert.equal(clr.assembly, engine.layout.hostEntry);
  assert.equal(clr.registry_assembly, registry);
  assert.deepEqual(report.engine, { version: '0.0.1', rid: engine.rid, dir: engine.dir });
});

test('unfilled sample tokens on the DS config are a loud missing-value FAIL, not BLOCKED_ENV', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-unfilled-'));
  const evidenceDir = join(isolated, 'evidence');
  const sample = JSON.parse(readFileSync(new URL('../Server/Config/Startup/server.sample.json', import.meta.url), 'utf8'));
  writeFileSync(join(isolated, 'server.json'), `${JSON.stringify(sample)}\n`);
  const report = await runLauncher({
    root: isolated,
    env: {},
    bots: 1,
    staggerMs: 0,
    durationMs: 0,
    timeoutMs: 1_000,
    sessions: [session('Bot1', 'ticket-unfilled')],
    engine: fakeEngine(isolated),
    hostfxr: touch(isolated, 'hostfxr.dll'),
    dsConfig: join(isolated, 'server.json'),
    processTools: {
      command() { return ''; },
      startLogged() { throw new Error('must not start DS on unfilled tokens'); },
      assertAlive() {},
      waitExit() { return Promise.resolve(); },
      forceCleanup() { return Promise.resolve(); },
    },
    log() {},
    evidenceDir,
  });
  assert.equal(report.steps.find((step) => step.id === '03').status, 'FAIL');
  assert.match(report.steps.find((step) => step.id === '03').detail, /missing required value/);
  assert.doesNotMatch(report.steps.find((step) => step.id === '03').detail, /BLOCKED_ENV/);
});

test('the committed Bot voxel budget states every field BotVoxelConfig has no default for', () => {
  const budget = JSON.parse(readFileSync(new URL('../Server/Assets/Maps/bot-voxel-budget.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    Object.keys(budget).sort(),
    ['catalogPath', 'prediction', 'receiptRetentionEntries', 'residentSectionBudget'],
  );
  // catalogPath resolves against the budget file's OWN directory, not the process cwd.
  assert.ok(existsSync(resolve(HERE, '..', 'Server', 'Assets', 'Maps', budget.catalogPath)));
  // Native refuses receiptRetentionEntries=0 (sdk-native voxel.rs NativeVoxelProvider::create),
  // so a zero here would pass the loader and then be rejected at world creation.
  assert.ok(budget.receiptRetentionEntries >= 1);
  // The sample map is 32x32x16 = 4 Sections (server.json voxel_baseline_region 0,0,0..1,0,1).
  assert.ok(budget.residentSectionBudget >= 4);
  assert.deepEqual(Object.keys(budget.prediction).sort(), [
    'bindingTextSlotBytes', 'maxBindingJournal', 'maxBindingTextEntries', 'maxBlockJournal',
    'maxOverlaySlots', 'maxRecords', 'maxValidationCellsPerSection', 'maxValidationSections',
    'totalRetainedPayloadCeiling',
  ]);
  const p = budget.prediction;
  // required_retained_bytes() refuses max_records=0 or a zero ceiling outright, then refuses the
  // session when the summed array layout exceeds the ceiling. The measured floor for these nine
  // values is 13424 bytes (lumio-voxel-world prediction::required_retained_bytes).
  assert.ok(p.maxRecords > 0);
  assert.ok(p.totalRetainedPayloadCeiling >= 13_424);
  // Overlay keys are one per distinct (cell, binding) pair across both journals; a smaller
  // budget would refuse a journal the other two limits allow.
  assert.ok(p.maxOverlaySlots >= p.maxBlockJournal + p.maxBindingJournal);
  // One text slot per retained binding write, and NetEntityId.ToHex() is 32 UTF-8 bytes.
  assert.ok(p.maxBindingTextEntries >= p.maxBindingJournal);
  assert.ok(p.bindingTextSlotBytes >= 32);
});

test('bots carry the committed voxel budget by default and --voxel-config off keeps entity-only', () => {
  assert.equal(parseLaunchArgs([], {}).voxelConfig, undefined);
  assert.equal(parseLaunchArgs([], { LUMIO_BOT_VOXEL_CONFIG: 'off' }).voxelConfig, 'off');
  assert.equal(
    parseLaunchArgs(['--voxel-config', 'off'], { LUMIO_BOT_VOXEL_CONFIG: 'maps/x.json' }).voxelConfig,
    'off',
  );

  const sampleRoot = resolve(HERE, '..');
  assert.equal(resolveBotVoxelConfig(undefined, sampleRoot), join(sampleRoot, 'Server', 'Assets', 'Maps', 'bot-voxel-budget.json'));
  for (const off of ['off', 'OFF', 'none', 'false', '0', '', '  ']) {
    assert.equal(resolveBotVoxelConfig(off, sampleRoot), null, `${JSON.stringify(off)} must be entity-only`);
  }
  // A budget the operator named but that is not there is a loud launcher refusal, never a silent
  // fall back to the entity-only bot that then faults on its first SectionFrame.
  assert.throws(() => resolveBotVoxelConfig('maps/not-here.json', sampleRoot), /--voxel-config/);
});

test('started bots receive --voxel-config, and off starts them without it', async () => {
  for (const [voxelConfig, expected] of [[undefined, true], ['off', false]]) {
    const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-voxel-'));
    const evidenceDir = join(isolated, 'evidence');
    const tools = processTools({ evidenceDir, botLogs: [admitLine('Bot1')] });
    const report = await runLauncher({
      root: isolated,
      env: {},
      bots: 1,
      staggerMs: 0,
      durationMs: 0,
      timeoutMs: 5_000,
      voxelConfig,
      sessions: [session('Bot1', 'ticket-one')],
      ...launchFiles(isolated),
      processTools: tools,
      log() {},
      evidenceDir,
    });
    const botStart = tools.events.find((event) => event.kind === 'start' && event.args.includes('--gameplay'));
    assert.equal(botStart.args.includes('--voxel-config'), expected);
    if (expected) {
      assert.equal(
        botStart.args[botStart.args.indexOf('--voxel-config') + 1],
        join(isolated, 'Server', 'Assets', 'Maps', 'bot-voxel-budget.json'),
      );
      assert.equal(report.botVoxelConfig, join(isolated, 'Server', 'Assets', 'Maps', 'bot-voxel-budget.json'));
    } else {
      assert.equal(report.botVoxelConfig, null);
    }
  }
});

// ---------------------------------------------------------------------------
// Steps 05–14: the tour bot's scenario and the restart, judged from artefacts.
// ---------------------------------------------------------------------------

const TOUR_DS_READY = 'DS_READY {"pid":1,"endpoint":"ws://127.0.0.1:9110","worldProfile":"runtime+voxel"}\n';
const LOG_PREFIX = '2026-09-23T00:00:00.0000000Z INF tick=40 world=1 lang=rs cat=ds';
const GREEN_BOOT_LOGS = [
  `${LOG_PREFIX} msg="empty store: first boot opens the world from the configured base map"`,
  '2026-09-23T00:00:01.0000000Z DBG tick=41 world=1 lang=rs cat=host.operation_result msg="observed" sequence=1 outcome=Succeeded/Applied/Accepted code=-',
  `${LOG_PREFIX} msg="0a1b2c3d4e5f60718293a4b5c6d7e8f9 says: ${TOUR_CHAT_TEXT}"`,
  // The gameplay's C# lines reach the DS logfmt sink with the separating tab escaped as a
  // literal `\t` (`SampleMiningComponent\tmining_stage`), so no `\b` can precede the names.
  `${LOG_PREFIX} msg="Lumio.Sample.Gameplay.SampleMiningComponent\\tmining_stage txn=t1 section=s:0:0:0 cell=12 bound=v1"`,
  `${LOG_PREFIX} msg="Lumio.Sample.Gameplay.SampleMiningComponent\\tmining_pre txn=t1 block=7 revision=3"`,
  `${LOG_PREFIX} msg="Lumio.Sample.Gameplay.SampleMiningComponent\\tmining_applied txn=t1 section=s:0:0:0 cell=12 vein=v1"`,
  `${LOG_PREFIX} msg="Lumio.Sample.Gameplay.SampleMiningComponent\\tmining_post txn=t1 block=0 revision=4 bound="`,
  `${LOG_PREFIX} msg="Lumio.Sample.Gameplay.SampleMiningComponent\\tmining_reward txn=t1 amount=4"`,
].join('\n');
const RESTORED_BOOT_LOGS = `${LOG_PREFIX} msg="recovered checkpoint outranks base_map_path; this boot restores the saved world"`;
const FRESH_BOOT_LOGS = `${LOG_PREFIX} msg="empty store: first boot opens the world from the configured base map"`;

/** Bot.Host result.ndjson as BotHostResidentLoop.FinishScenarios writes it. */
function resultLines({ passed = true, failed = '', run = true } = {}) {
  const lines = [JSON.stringify({ kind: 'assert', bot: 'bot-0', step: 900, passed, failed })];
  if (run) lines.push(JSON.stringify({ kind: 'run', bots: 1, ticks: 900, uplinks: 40, commandStreamSha256: 'ab', passed }));
  return `${lines.join('\n')}\n`;
}

function failedResult(...names) {
  return resultLines({ passed: false, failed: names.join(',') });
}

function argValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

/**
 * Process tools for a whole tour. Each DS boot reads the run config the launcher wrote and puts its
 * log lines in that config's logging.dir. Scenario bots "finish" at once. Once the tour bot has
 * started, every read of boot 1's stdout shows one more DS_CHECKPOINT, up to
 * `checkpointsAfterCompletion` — so "a save after completion" does not depend on timers.
 */
function tourTools({
  boots = [{ logs: GREEN_BOOT_LOGS }, { logs: RESTORED_BOOT_LOGS }],
  tourResult = resultLines(),
  verifyResult = resultLines(),
  tourAdmit = (account) => admitLine(account),
  checkpointsAfterCompletion = 2,
  dsDiesAtCompletion = false,
} = {}) {
  const events = [];
  let dsBoots = 0;
  let armed = false;
  return {
    events,
    command() { return 'configuration_valid'; },
    startLogged(exe, args = []) {
      events.push({ kind: 'start', exe, args: [...args], at: Date.now() });
      if (args[0] === '--config') {
        const boot = boots[dsBoots];
        dsBoots += 1;
        const bootIndex = dsBoots;
        const config = JSON.parse(readFileSync(args[1], 'utf8'));
        mkdirSync(config.logging.dir, { recursive: true });
        writeFileSync(join(config.logging.dir, 'lumio-ds-0.log'), `${boot.logs}\n`);
        let reads = 0;
        const state = { child: { pid: bootIndex, kill() {} }, closed: false, config, boot: bootIndex };
        Object.defineProperty(state, 'stdout', {
          get() {
            let text = TOUR_DS_READY;
            if (bootIndex !== 1) return text;
            // Generation 1 predates the tour bot's completion.
            text += 'DS_CHECKPOINT {"generation":1}\n';
            if (!armed) return text;
            reads += 1;
            if (dsDiesAtCompletion) state.closed = true;
            const extra = Math.min(reads - 1, checkpointsAfterCompletion);
            for (let generation = 2; generation < 2 + extra; generation += 1) text += `DS_CHECKPOINT {"generation":${generation}}\n`;
            return text;
          },
        });
        return state;
      }
      const logDir = argValue(args, '--log-dir');
      const account = argValue(args, '--account-from');
      const scenario = argValue(args, '--scenario-name');
      mkdirSync(logDir, { recursive: true });
      const bot = (pid, admit, result, closed) => {
        writeFileSync(join(logDir, '2026-09-23_000.log'), `${admit}\n`);
        if (result != null) writeFileSync(join(logDir, 'result.ndjson'), result);
        return { stdout: '', child: { pid, kill() {} }, closed };
      };
      const started = events[events.length - 1];
      if (scenario === TOUR_SCENARIO) {
        armed = true;
        started.pid = 50;
        return bot(50, tourAdmit(account), tourResult, true);
      }
      if (scenario === RESTORE_SCENARIO) {
        started.pid = 60;
        return bot(60, admitLine(account), verifyResult, true);
      }
      started.pid = 70 + events.length;
      return bot(started.pid, admitLine(account), null, false);
    },
    assertAlive(state) {
      if (state?.config && state.closed) throw new Error(`lumio-ds boot ${state.boot} exited`);
    },
    waitExit() { return Promise.resolve(); },
    forceCleanup(state) {
      events.push({ kind: 'cleanup', pid: state?.child?.pid, at: Date.now() });
      return Promise.resolve();
    },
  };
}

function tourFiles(isolated) {
  const files = launchFiles(isolated);
  const config = { ...runnableDsConfig(), world_profile: 'runtime+voxel' };
  writeFileSync(files.dsConfig, `${JSON.stringify(config)}\n`);
  for (const end of [['Server', 'Config', 'Tables'], ['Client', 'Config', 'Tables']]) {
    mkdirSync(join(isolated, ...end), { recursive: true });
    writeFileSync(join(isolated, ...end, 'manifest.json'), '{"revisionId":"test"}\n');
  }
  return { ...files, scenarioDll: touch(isolated, 'Lumio.Sample.Bots.dll') };
}

async function runTour(tools, overrides = {}) {
  const isolated = overrides.isolated ?? mkdtempSync(join(tmpdir(), 'lumio-tour-'));
  const evidenceDir = join(isolated, 'evidence');
  const logins = [];
  const lines = [];
  // `files` lets a test hand in a fixture it already edited; otherwise a green one is written.
  const { isolated: _unused, files = tourFiles(isolated), ...rest } = overrides;
  const report = await runLauncher({
    root: isolated,
    env: {},
    origin: 'http://127.0.0.1:1',
    bots: 1,
    staggerMs: 0,
    durationMs: 0,
    timeoutMs: 5_000,
    checkpointTimeoutMs: 300,
    loginAndLaunch: async ({ loginName, password }) => {
      logins.push({ loginName, password });
      return session(loginName, `ticket-${loginName}-${logins.length}`);
    },
    ...files,
    processTools: tools,
    log: (line) => lines.push(line),
    evidenceDir,
    ...rest,
  });
  const status = (id) => report.steps.find((step) => step.id === id)?.status;
  const detail = (id) => report.steps.find((step) => step.id === id)?.detail;
  return { report, logins, lines, evidenceDir, isolated, status, detail };
}

const BOT_EVIDENCED_STEPS = ['06', '07', '08', '09', '10', '12', '13'];

test('a green tour passes all fourteen steps: 05–13 from artefacts, 14 from a reboot on the same store', async () => {
  const tools = tourTools();
  const { report, logins, status, detail, evidenceDir } = await runTour(tools);
  assert.deepEqual(report.steps.map((step) => `${step.id}:${step.status}`), [
    '01:READY', '02:PASS', '03:PASS', '04:PASS', '05:PASS', '06:PASS', '07:PASS',
    '08:PASS', '09:PASS', '10:PASS', '11:PASS', '12:PASS', '13:PASS', '14:PASS',
  ]);
  assert.equal(report.status, 'PASS');
  assert.equal(report.tourLogin, 'Bot1');
  assert.match(detail('05'), /vein_seen_via_section held; bot scope active=true/);
  assert.match(detail('12'), /amounts=\[4\]/);
  assert.match(detail('14'), /gen 1→3; restore marker=true; verify assertions=passed/);
  assert.deepEqual(report.checkpoint, { atCompletion: 1, released: 3 });

  const starts = tools.events.filter((event) => event.kind === 'start');
  const [boot1, tourBot, boot2, verifyBot] = starts;
  assert.equal(argValue(tourBot.args, '--scenario-name'), TOUR_SCENARIO);
  assert.equal(argValue(tourBot.args, '--ticks'), '15000');
  assert.equal(argValue(verifyBot.args, '--scenario-name'), RESTORE_SCENARIO);
  assert.equal(argValue(verifyBot.args, '--account-from'), 'Bot1');
  assert.equal(argValue(verifyBot.args, '--admission-ticket'), 'ticket-Bot1-2');
  // Same account, same run-scoped password: the re-login after the restart can only work that way.
  assert.deepEqual(logins.map((login) => login.loginName), ['Bot1', 'Bot1']);
  assert.ok(logins[0].password && logins[0].password === logins[1].password);
  // Same store, separate log directories; the reboot starts only after boot 1 was stopped.
  const config1 = JSON.parse(readFileSync(argValue(boot1.args, '--config'), 'utf8'));
  const config2 = JSON.parse(readFileSync(argValue(boot2.args, '--config'), 'utf8'));
  assert.equal(config1.store_path, config2.store_path);
  assert.ok(config1.store_path.startsWith(evidenceDir));
  assert.notEqual(config1.logging.dir, config2.logging.dir);
  assert.equal(config1.logging.min_level, 'debug');
  const bootOneStopped = tools.events.findIndex((event) => event.kind === 'cleanup' && event.pid === 1);
  assert.ok(bootOneStopped >= 0 && bootOneStopped < tools.events.indexOf(boot2));
});

test('a missing, empty or truncated tour result.ndjson fails every bot-evidenced step (no vacuous pass)', async (t) => {
  for (const [label, tourResult] of [
    ['absent', null],
    ['empty', ''],
    ['assert record without the closing run record', resultLines({ run: false })],
  ]) {
    const { status, detail, lines } = await runTour(tourTools({ tourResult }));
    t.diagnostic(`${label}: ${lines.filter((line) => /^step=(0[5-9]|1[0-3]) /.test(line)).join(' | ')}`);
    for (const id of BOT_EVIDENCED_STEPS) {
      assert.equal(status(id), 'FAIL', `${label}: step ${id} passed without a result`);
      assert.match(detail(id), /no-result/);
    }
  }
});

test('a result.ndjson left by an earlier run in a reused evidence dir is not this run\'s evidence', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-tour-stale-'));
  mkdirSync(join(isolated, 'evidence', 'bot-1'), { recursive: true });
  writeFileSync(join(isolated, 'evidence', 'bot-1', 'result.ndjson'), resultLines());
  mkdirSync(join(isolated, 'evidence', 'ds-boot-2'), { recursive: true });
  writeFileSync(join(isolated, 'evidence', 'ds-boot-2', 'old.log'), `${RESTORED_BOOT_LOGS}\n`);
  const { status } = await runTour(tourTools({ tourResult: null, boots: [{ logs: GREEN_BOOT_LOGS }, { logs: FRESH_BOOT_LOGS }] }), { isolated });
  for (const id of BOT_EVIDENCED_STEPS) assert.equal(status(id), 'FAIL', `step ${id} read a stale result`);
  assert.equal(status('14'), 'FAIL');
});

test('step 14 fails when the reboot opens a fresh base map instead of the save', async (t) => {
  const { status, detail, lines } = await runTour(tourTools({
    boots: [{ logs: GREEN_BOOT_LOGS }, { logs: FRESH_BOOT_LOGS }],
    verifyResult: failedResult('veins==3(got 4)'),
  }));
  t.diagnostic(lines.find((line) => line.startsWith('step=14 ')));
  assert.equal(status('14'), 'FAIL');
  assert.match(detail('14'), /restore marker=false; reboot opened the fresh base map; verify assertions=failed: veins==3\(got 4\)/);
});

test('step 14 never stops the DS before a save that started after the tour bot finished', async () => {
  for (const [after, expected] of [[0, /no DS_CHECKPOINT after it/], [1, /only gen 2 \(may have started before completion\)/]]) {
    const tools = tourTools({ checkpointsAfterCompletion: after });
    const { status, detail } = await runTour(tools);
    assert.equal(status('14'), 'FAIL');
    assert.match(detail('14'), expected);
    assert.match(detail('14'), /DS stopped without a post-completion save/);
    // No reboot and no verification bot: a restore of an unsaved world proves nothing.
    const starts = tools.events.filter((event) => event.kind === 'start');
    assert.equal(starts.filter((event) => event.args[0] === '--config').length, 1);
    assert.ok(!starts.some((event) => argValue(event.args, '--scenario-name') === RESTORE_SCENARIO));
  }
});

test('lumio-ds exiting before the post-completion checkpoint is FAIL, not a restart', async () => {
  // It dies the moment the tour bot is done, having printed no save after that.
  const tools = tourTools({ dsDiesAtCompletion: true, checkpointsAfterCompletion: 0 });
  const { status, detail } = await runTour(tools);
  assert.equal(status('14'), 'FAIL');
  assert.match(detail('14'), /lumio-ds exited before it/);
  assert.equal(tools.events.filter((event) => event.kind === 'start' && event.args[0] === '--config').length, 1);
});

test('step 14 is BLOCKED_ENV without a Platform to re-admit the tour account', async () => {
  const { status, detail } = await runTour(tourTools(), {
    origin: undefined,
    sessions: [session('Bot1', 'ticket-one')],
  });
  assert.equal(status('13'), 'PASS');
  assert.equal(status('14'), 'BLOCKED_ENV');
  assert.match(detail('14'), /no Platform/);
});

test('a re-launch bound to another room than the restarted DS is FAIL', async () => {
  const bound = (roomId, ticket) => ({
    login: { loginName: 'Bot1', accountId: 'acct_Bot1' },
    launch: {
      admissionCredential: ticket,
      serverAudience: 'aud', gameId: 'sample', gameReleaseId: 'rel', contractId: 'c', roomId, allocationId: 'alloc',
    },
  });
  let calls = 0;
  const tools = tourTools();
  const { status, detail } = await runTour(tools, {
    loginAndLaunch: async () => {
      calls += 1;
      return calls === 1 ? bound('room-a', 'ticket-a') : bound('room-b', 'ticket-b');
    },
  });
  // The first launch's claims are what the run config carries.
  const boot1 = tools.events.find((event) => event.kind === 'start' && event.args[0] === '--config');
  assert.equal(JSON.parse(readFileSync(boot1.args[1], 'utf8')).allocation.roomId, 'room-a');
  assert.equal(status('14'), 'FAIL');
  assert.match(detail('14'), /bound to another roomId/);
});

test('fleet bots run beside the tour bot and are stopped before the DS restarts', async () => {
  const tools = tourTools();
  const { status, report } = await runTour(tools, { bots: 2, durationMs: 50 });
  assert.equal(report.status, 'PASS');
  assert.equal(status('04'), 'PASS');
  const starts = tools.events.filter((event) => event.kind === 'start');
  const fleet = starts.find((event) => argValue(event.args, '--account-from') === 'Bot2');
  assert.ok(!fleet.args.includes('--scenario'), 'bot 2 is a resident fleet bot');
  const boot2 = starts.filter((event) => event.args[0] === '--config')[1];
  const fleetStopped = tools.events.findIndex((event) => event.kind === 'cleanup' && event.pid === fleet.pid);
  assert.ok(fleetStopped >= 0 && fleetStopped < tools.events.indexOf(boot2));
});

test('without LUMIO_SCENARIO_DLL bots still prove step 04 and 05–14 are BLOCKED_ENV by name', async () => {
  const tools = tourTools();
  const { status, detail, report } = await runTour(tools, { scenarioDll: undefined, durationMs: 20 });
  assert.equal(status('04'), 'PASS');
  for (const id of ['05', '06', '07', '08', '09', '10', '11', '12', '13', '14']) {
    assert.equal(status(id), 'BLOCKED_ENV');
    assert.match(detail(id), /LUMIO_SCENARIO_DLL is not set/);
  }
  assert.equal(report.status, 'BLOCKED_ENV');
  assert.ok(!tools.events.some((event) => event.kind === 'start' && event.args.includes('--scenario')));
});

test('every CLR input the DS needs is BLOCKED_ENV by field when missing, with no fallback path', async () => {
  const engineField = {
    engine_native: 'engineNative',
    assembly: 'hostEntry',
    runtime_config: 'hostEntryRuntimeConfig',
    replication_assembly: 'replicationAssembly',
    ecs_assembly: 'ecsAssembly',
  };
  for (const input of DS_CLR_INPUTS) {
    const isolated = mkdtempSync(join(tmpdir(), 'lumio-tour-clr-'));
    const files = tourFiles(isolated);
    if (input.source === 'engine') rmSync(files.engine.layout[engineField[input.field]]);
    if (input.source === 'dotnet') files.hostfxr = join(isolated, 'no-dotnet', 'hostfxr.dll');
    if (input.source === 'game') {
      const config = JSON.parse(readFileSync(files.dsConfig, 'utf8'));
      config.clr.registry_assembly = 'missing/Lumio.Sample.Gameplay.dll';
      writeFileSync(files.dsConfig, `${JSON.stringify(config)}\n`);
    }
    const tools = tourTools();
    const { status, detail } = await runTour(tools, { isolated, files });
    assert.equal(status('03'), 'BLOCKED_ENV', input.field);
    assert.match(detail('03'), new RegExp(`^DS config clr\\.${input.field} is not a file`));
    assert.ok(!tools.events.some((event) => event.kind === 'start'), `${input.field}: nothing may start`);
  }
});

test('the engine half of clr is the release for this platform, whatever the template says', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-tour-release-'));
  const files = tourFiles(isolated);
  const config = JSON.parse(readFileSync(files.dsConfig, 'utf8'));
  for (const field of ['engine_native', 'hostfxr', 'assembly', 'runtime_config', 'replication_assembly', 'ecs_assembly']) {
    config.clr[field] = `not-here/${field}`;
  }
  writeFileSync(files.dsConfig, `${JSON.stringify(config)}\n`);
  const tools = tourTools();
  const { status } = await runTour(tools, { isolated, files });
  assert.equal(status('03'), 'PASS');
  const boot1 = tools.events.find((event) => event.kind === 'start' && event.args[0] === '--config');
  assert.equal(boot1.exe, files.engine.layout.dsExe);
  const clr = JSON.parse(readFileSync(boot1.args[1], 'utf8')).clr;
  const { layout } = files.engine;
  assert.equal(clr.hostfxr, files.hostfxr);
  assert.equal(clr.assembly, layout.hostEntry);
  assert.equal(clr.runtime_config, layout.hostEntryRuntimeConfig);
  assert.equal(clr.engine_native, layout.engineNative);
  assert.equal(clr.replication_assembly, layout.replicationAssembly);
  assert.equal(clr.ecs_assembly, layout.ecsAssembly);
  assert.equal(clr.registry_assembly, join(isolated, CLR_FILES.registry_assembly));
  // Bots are the release's Bot.Host with the release's native.
  const bot = tools.events.find((event) => event.kind === 'start' && event.args.includes('--gameplay'));
  assert.equal(bot.args[0], layout.botHost);
  assert.equal(bot.args[bot.args.indexOf('--engine-native') + 1], layout.engineNative);
});

test('judgeTourSteps passes 05–13 on green artefacts', () => {
  const steps = judgeTourSteps({
    dsStdout: TOUR_DS_READY,
    dsLogs: GREEN_BOOT_LOGS,
    botAdmit: parseBotAdmit(admitLine('Bot1')),
    botResult: resultLines(),
  });
  assert.deepEqual(steps.map((step) => step.id), ['05', '06', '07', '08', '09', '10', '11', '12', '13']);
  for (const step of steps) assert.equal(step.status, 'PASS', `${step.id}: ${step.detail}`);
  // The in-memory stdout is a tail; DS_READY parsed at boot still speaks for step 05 once it scrolled out.
  const scrolled = { dsLogs: GREEN_BOOT_LOGS, botAdmit: parseBotAdmit(admitLine('Bot1')), botResult: resultLines(), dsStdout: '' };
  assert.equal(judgeTourSteps({ ...scrolled, dsReady: { worldProfile: 'runtime+voxel' } })[0].status, 'PASS');
  assert.equal(judgeTourSteps(scrolled)[0].status, 'FAIL');
});

test('each of steps 05–13 fails on exactly its own missing evidence', () => {
  const without = (marker) => GREEN_BOOT_LOGS.split('\n').filter((line) => !line.includes(marker)).join('\n');
  const green = {
    dsStdout: TOUR_DS_READY,
    dsLogs: GREEN_BOOT_LOGS,
    botAdmit: { admitted: true, scopeActivated: true },
    botResult: resultLines(),
  };
  const cases = [
    ['base map boot line', { dsLogs: without('empty store') }, ['05']],
    ['vein never reached the census (no Section delivery)', { botResult: failedResult('vein_seen_via_section') }, ['05', '13']],
    ['bot scope never activated', { botAdmit: { admitted: true, scopeActivated: false } }, ['05']],
    ['runtime-only DS', { dsStdout: TOUR_DS_READY.replace('runtime+voxel', 'runtime-only') }, ['05']],
    ['boot 1 restored an old checkpoint', { dsLogs: `${GREEN_BOOT_LOGS}\n${RESTORED_BOOT_LOGS}` }, ['05']],
    ['not admitted', { botAdmit: { admitted: false, scopeActivated: true } }, ['06']],
    ['self_bound failed', { botResult: failedResult('self_bound') }, ['06', '13']],
    ['no applied op on the DS', { dsLogs: without('outcome=Succeeded/Applied') }, ['07']],
    ['move_activated failed', { botResult: failedResult('move_activated') }, ['07', '13']],
    ['activation refused', { botResult: failedResult('activation_accepted:sink closed') }, ['07', '13']],
    ['nothing uplinked', { botResult: failedResult('bot_uplinked') }, ['07', '13']],
    ['no tour chat on the DS', { dsLogs: without('says:').concat('\nmsg="beef says: hello from Bot2"') }, ['08']],
    ['chat_activated failed', { botResult: failedResult('chat_activated') }, ['08', '13']],
    ['no mining_stage', { dsLogs: without('mining_stage') }, ['09']],
    ['no mining_pre', { dsLogs: without('mining_pre') }, ['09']],
    ['mine_activated failed', { botResult: failedResult('mine_activated') }, ['09', '13']],
    ['no mining_applied', { dsLogs: without('mining_applied') }, ['10']],
    ['vein survived', { botResult: failedResult('vein_dug_through') }, ['10', '13']],
    ['cell not air', { dsLogs: GREEN_BOOT_LOGS.replace('block=0 revision=4', 'block=7 revision=4') }, ['11']],
    ['no reward', { dsLogs: without('mining_reward') }, ['12']],
    ['zero reward', { dsLogs: GREEN_BOOT_LOGS.replace('amount=4', 'amount=0') }, ['12']],
    ['drop never reached the client', { botResult: failedResult('pickup_activated') }, ['12', '13']],
    ['drop not collected', { botResult: failedResult('drop_collected') }, ['13']],
  ];
  for (const [label, change, expected] of cases) {
    const failing = judgeTourSteps({ ...green, ...change })
      .filter((step) => step.status === 'FAIL')
      .map((step) => step.id);
    assert.deepEqual(failing, expected, label);
  }
});

test('scenarioVerdict needs one well-formed assert record closed by an agreeing run record', () => {
  const verdict = (text) => scenarioVerdict(parseBotResult(text));
  assert.equal(verdict(resultLines()).present, true);
  assert.equal(verdict(resultLines()).passed, true);
  assert.deepEqual(verdict(failedResult('a', 'b(got 4)')).failed, ['a', 'b(got 4)']);
  for (const [label, text] of [
    ['empty', ''],
    ['garbage', 'not json\n'],
    ['no run record', resultLines({ run: false })],
    ['two assert records', `${resultLines({ run: false })}${resultLines()}`],
    ['passed but lists a failure', `${JSON.stringify({ kind: 'assert', passed: true, failed: 'x' })}\n${JSON.stringify({ kind: 'run', bots: 1, passed: true })}\n`],
    ['run disagrees', `${JSON.stringify({ kind: 'assert', passed: true, failed: '' })}\n${JSON.stringify({ kind: 'run', bots: 1, passed: false })}\n`],
    ['no failed field', `${JSON.stringify({ kind: 'assert', passed: true })}\n${JSON.stringify({ kind: 'run', bots: 1, passed: true })}\n`],
  ]) {
    assert.equal(verdict(text).present, false, label);
  }
});

test('checkpoint generations must rise strictly, and only a save started after completion releases the stop', () => {
  assert.deepEqual(checkpointGenerations('x\nDS_CHECKPOINT {"generation":4}\nDS_CHECKPOINT {bad}\nDS_CHECKPOINT {"generation":5}\n'), [4, 5]);
  assert.equal(judgeCheckpoint([], []).ok, false);
  assert.equal(judgeCheckpoint([14], [14]).ok, false);
  // The first save printed after completion may have been running already.
  assert.equal(judgeCheckpoint([14], [14, 15]).ok, false);
  assert.deepEqual(judgeCheckpoint([14], [14, 15, 16]), { ok: true, generation: 16, detail: 'gen 14→16' });
  assert.equal(judgeCheckpoint([], [1, 2]).generation, 2);
  const broken = judgeCheckpoint([3], [3, 2, 4, 5]);
  assert.equal(broken.ok, false);
  assert.equal(broken.broken, true);
  assert.match(broken.detail, /not strictly increasing/);
});

test('judgeRestore needs the saved checkpoint, the restore marker and a passing verification bot', () => {
  const saved = { ok: true, generation: 16, detail: 'gen 14→16' };
  const green = { checkpoint: saved, bootLogs: RESTORED_BOOT_LOGS, verifyResult: resultLines() };
  assert.equal(judgeRestore(green).status, 'PASS');
  for (const [label, change] of [
    ['fresh base map, four veins', { bootLogs: FRESH_BOOT_LOGS, verifyResult: failedResult('veins==3(got 4)') }],
    ['marker but the world is wrong', { verifyResult: failedResult('oreDrops==0(got 1)') }],
    ['no marker', { bootLogs: '' }],
    ['no verification result', { verifyResult: '' }],
    ['no post-completion checkpoint', { checkpoint: { ok: false, detail: 'gen 14 at completion; no DS_CHECKPOINT after it' } }],
  ]) {
    assert.equal(judgeRestore({ ...green, ...change }).status, 'FAIL', label);
  }
});

test('every assertion name a step relies on is a sink.That in the scenario source, and the chat line matches', () => {
  const mining = readFileSync(new URL('../Client/Bots/SampleMiningScenario.cs', import.meta.url), 'utf8');
  const restore = readFileSync(new URL('../Client/Bots/SampleRestoreVerifyScenario.cs', import.meta.url), 'utf8');
  for (const name of new Set(Object.values(TOUR_ASSERTIONS).flat())) {
    assert.match(mining, new RegExp(`sink\\.That\\([^;]*"${name}[":]`), `${name} is not asserted by SampleMiningScenario`);
  }
  assert.ok(mining.includes(`"${TOUR_CHAT_TEXT}"`), 'the chat line step 08 looks for is not the one the scenario sends');
  assert.match(mining, /namespace Lumio\.Sample\.Bots;[\s\S]*class SampleMiningScenario\b/);
  assert.match(restore, /namespace Lumio\.Sample\.Bots;[\s\S]*class SampleRestoreVerifyScenario\b/);
  assert.equal(TOUR_SCENARIO, 'Lumio.Sample.Bots.SampleMiningScenario');
  assert.equal(RESTORE_SCENARIO, 'Lumio.Sample.Bots.SampleRestoreVerifyScenario');
});

test('parseBotAdmit reports scopeActivated only on the Active+established line that says so', () => {
  assert.equal(parseBotAdmit(admitLine('Bot1')).scopeActivated, true);
  assert.equal(parseBotAdmit(admitLine('Bot1').replace('scopeActivated=True', 'scopeActivated=False').replace('True True True', 'True False True')).scopeActivated, false);
  assert.equal(parseBotAdmit('').scopeActivated, false);
});

test('CLI parses the tour flags and refuses bad values', () => {
  const options = parseLaunchArgs(
    ['--scenario-dll', 'Bots.dll', '--tour-ticks', '900', '--checkpoint-seconds', '15', '--login-prefix', 'Tour'],
    {},
  );
  assert.equal(options.scenarioDll, 'Bots.dll');
  assert.equal(options.tourTicks, 900);
  assert.equal(options.checkpointSeconds, 15);
  assert.equal(options.loginPrefix, 'Tour');
  const fromEnv = parseLaunchArgs([], { LUMIO_SCENARIO_DLL: 'env.dll', LUMIO_CHECKPOINT_SECONDS: '20', LUMIO_LOGIN_PREFIX: 'Acct' });
  assert.equal(fromEnv.scenarioDll, 'env.dll');
  assert.equal(fromEnv.checkpointSeconds, 20);
  assert.equal(fromEnv.tourTicks, 15000);
  assert.equal(parseLaunchArgs([], {}).checkpointSeconds, undefined);
  assert.throws(() => parseLaunchArgs(['--checkpoint-seconds', '0'], {}), /checkpoint-seconds/);
  assert.throws(() => parseLaunchArgs(['--tour-ticks', '-1'], {}), /tour-ticks/);
  assert.throws(() => parseLaunchArgs(['--login-prefix', '9x'], {}), /login-prefix/);
  assert.deepEqual(planLaunchLogins(2, { loginPrefix: 'Tour' }), ['Tour1', 'Tour2']);
});

test('the fourteen steps have one driver: tour-run.mjs is gone and nothing points at it', () => {
  assert.equal(existsSync(new URL('tour-run.mjs', import.meta.url)), false);
  const root = resolve(HERE, '..');
  const texts = [
    join(root, 'README.md'),
    join(root, '.spec', 'knowledge', 'features', 'sample-tour.md'),
    join(root, 'Tools', 'README.md'),
    ...readdirSync(HERE).filter((name) => name.endsWith('.mjs')).map((name) => join(HERE, name)),
  ];
  for (const path of texts) {
    if (path.endsWith('launcher.test.mjs')) continue;
    assert.doesNotMatch(readFileSync(path, 'utf8'), /tour-run/, path);
  }
});

test('Platform host port: LUMIO_PLATFORM_HOST_PORT wins, else 8080 when free, else an ephemeral port', async () => {
  const never = async () => { throw new Error('must not probe'); };
  assert.equal(await choosePlatformHostPort({ env: { LUMIO_PLATFORM_HOST_PORT: '18080' }, isFree: never, pickFree: never }), 18080);
  await assert.rejects(
    choosePlatformHostPort({ env: { LUMIO_PLATFORM_HOST_PORT: 'eighty' }, isFree: never, pickFree: never }),
    /BLOCKED_ENV: LUMIO_PLATFORM_HOST_PORT=eighty is not a TCP port/,
  );
  const probed = [];
  assert.equal(await choosePlatformHostPort({ env: {}, isFree: async (p) => { probed.push(p); return true; }, pickFree: never }), 8080);
  assert.deepEqual(probed, [8080]);
  assert.equal(await choosePlatformHostPort({ env: {}, isFree: async () => false, pickFree: async () => 41234 }), 41234);
});

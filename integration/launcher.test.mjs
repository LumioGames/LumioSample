import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { candidateEngineRoots, resolveProcessToolsPath } from './engine-tools.mjs';
import {
  collectLaunchTickets,
  DEFAULT_SPECTATOR_LOGIN,
  parseBotAdmit,
  parseLaunchArgs,
  planLaunchLogins,
  resolveSpectatorPageUrl,
  runLauncher,
} from './launcher.mjs';
import { formatStep, planBotLogins, TOUR_STEPS } from './tour-steps.mjs';

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

function runnableDsConfig() {
  return {
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

function launchFiles(isolated) {
  const dsConfig = join(isolated, 'server.json');
  writeFileSync(dsConfig, `${JSON.stringify(runnableDsConfig())}\n`);
  return {
    dsExe: touch(isolated, 'lumio-ds'),
    dsConfig,
    botDll: touch(isolated, 'Lumio.Client.Bot.Host.dll'),
    gameplay: touch(isolated, 'Lumio.Sample.Gameplay.dll'),
    engineNative: touch(isolated, 'lumio.dll'),
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

test('CLI parses --gameplay and --duration-ms', () => {
  const options = parseLaunchArgs(['--gameplay', 'Lumio.Sample.Gameplay.dll', '--duration-ms', '80'], {});
  assert.equal(options.gameplay, 'Lumio.Sample.Gameplay.dll');
  assert.equal(options.durationMs, 80);
});

test('CLI parses --spectator as a boolean flag without a value', () => {
  const options = parseLaunchArgs(['--bots', '100', '--spectator', '--duration-ms', '80'], {});
  assert.equal(options.bots, 100);
  assert.equal(options.spectator, true);
  assert.equal(options.durationMs, 80);
  assert.equal(options.spectatorLogin, DEFAULT_SPECTATOR_LOGIN);
});

test('CLI parses --spectator-url and LUMIO_SPECTATOR_ORIGIN', () => {
  const flagged = parseLaunchArgs(
    ['--spectator-url', 'http://127.0.0.1:8765/modules/web/spectator/'],
    {},
  );
  assert.equal(flagged.spectator, true);
  assert.equal(flagged.spectatorUrl, 'http://127.0.0.1:8765/modules/web/spectator/');
  const fromEnv = parseLaunchArgs(['--spectator'], {
    LUMIO_SPECTATOR_ORIGIN: 'http://127.0.0.1:9090',
    LUMIO_SPECTATOR_LOGIN: 'Spectator1',
  });
  assert.equal(fromEnv.spectator, true);
  assert.equal(fromEnv.spectatorOrigin, 'http://127.0.0.1:9090');
  assert.equal(fromEnv.spectatorLogin, 'Spectator1');
  assert.throws(() => parseLaunchArgs(['--not-a-flag'], {}), /unknown option/);
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

test('default spectator URL is origin + /modules/web/spectator/ without credentials', () => {
  assert.equal(
    resolveSpectatorPageUrl({}),
    'http://127.0.0.1/modules/web/spectator/',
  );
  assert.equal(
    resolveSpectatorPageUrl({ env: { LUMIO_SPECTATOR_ORIGIN: 'http://127.0.0.1:8080' } }),
    'http://127.0.0.1:8080/modules/web/spectator/',
  );
  assert.equal(
    resolveSpectatorPageUrl({ spectatorStaticPort: '9410' }),
    'http://127.0.0.1:9410/modules/web/spectator/',
  );
  assert.equal(
    resolveSpectatorPageUrl({ spectatorUrl: 'http://user:ticket-secret@127.0.0.1:8/modules/web/spectator?admission=ticket-secret' }),
    'http://127.0.0.1:8/modules/web/spectator/',
  );
});

test('process-tools resolution is Engine-root only and does not invent a helper', () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-'));
  assert.equal(resolveProcessToolsPath({ env: {}, repoRoot: isolated }), null);
  const roots = candidateEngineRoots({ env: { LUMIO_ENGINE_ROOT: '/opt/engine' }, repoRoot: isolated });
  assert.ok(roots.some((root) => root.endsWith('engine') || root.includes('engine')));
});

test('launcher prints every step and exits BLOCKED_ENV without a live Platform', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-root-'));
  writeFileSync(join(isolated, 'movement-placeholder'), '');
  const lines = [];
  const report = await runLauncher({
    root: isolated,
    env: {},
    bots: 2,
    log: (line) => lines.push(line),
    evidenceDir: join(isolated, 'evidence'),
  });
  assert.equal(report.status, 'BLOCKED_ENV');
  assert.equal(report.steps.length, 14);
  assert.ok(lines.every((line) => line.startsWith('step=')));
  assert.ok(report.steps.every((step) => step.status === 'BLOCKED_ENV'));
  assert.match(report.steps.find((step) => step.id === '01').detail, /typed Reader via M9 loader/);
});

test('step 01 is READY when config/manifest.json exists even without Platform', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-manifest-'));
  mkdirSync(join(isolated, 'config'), { recursive: true });
  writeFileSync(join(isolated, 'config', 'manifest.json'), '{"revisionId":"test"}\n');
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
  assert.equal(report.steps.find((step) => step.id === '05').status, 'BLOCKED_ENV');
  assert.equal(report.steps.find((step) => step.id === '07').detail, 'MoveAbility is in-tree; live Activate waits Client R-00534 AC10.');
  assert.match(report.steps.find((step) => step.id === '05').detail, /placeholder and must not be treated as a base map/);
  assert.match(report.steps.find((step) => step.id === '05').detail, /Missing command/);
  assert.doesNotMatch(report.steps.find((step) => step.id === '05').detail, /does not exist|not public/);
  assert.equal(report.steps.find((step) => step.id === '14').status, 'BLOCKED_ENV');
  assert.match(report.steps.find((step) => step.id === '14').detail, /runtime\+voxel/);
  assert.doesNotMatch(report.steps.find((step) => step.id === '14').detail, /runtime-only/);
  for (const id of ['05', '07', '08', '09', '10', '11', '12', '13', '14']) {
    assert.equal(report.steps.find((step) => step.id === id).status, 'BLOCKED_ENV');
  }
});

test('live bots against the committed Sample tree mark step 05 READY for a restorable capture', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-map-'));
  const evidenceDir = join(isolated, 'evidence');
  const sampleRoot = resolve(HERE, '..');
  const tools = processTools({ evidenceDir, botLogs: [admitLine('Bot1')] });
  const report = await runLauncher({
    root: sampleRoot,
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
  assert.equal(report.steps.find((step) => step.id === '05').status, 'READY');
  assert.match(report.steps.find((step) => step.id === '05').detail, /restores only/);
  assert.doesNotMatch(report.steps.find((step) => step.id === '05').detail, /placeholder/);
  assert.equal(report.steps.find((step) => step.id === '14').status, 'BLOCKED_ENV');
  assert.match(report.steps.find((step) => step.id === '14').detail, /restoreable capture/);
  for (const id of ['07', '08', '09', '10', '11', '12', '13', '14']) {
    assert.equal(report.steps.find((step) => step.id === id).status, 'BLOCKED_ENV');
  }
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
  ];
  for (const name of files) {
    const text = readFileSync(new URL(name, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /lumio-entity-chat-replay/);
    assert.doesNotMatch(text, /LumioServer\/account-server/);
    assert.doesNotMatch(text, /\/Users\//);
    assert.doesNotMatch(text, /\/home\//);
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
    env: { LUMIO_SPECTATOR_ORIGIN: 'http://127.0.0.1:8080' },
    origin: 'http://127.0.0.1:1',
    bots: 100,
    spectator: true,
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
  assert.equal(report.spectatorUrl, 'http://127.0.0.1:8080/modules/web/spectator/');

  const starts = tools.events.filter((event) => event.kind === 'start');
  assert.equal(starts.length, 101, '1 lumio-ds + 100 Bot.Host');
  const botStarts = starts.slice(1);
  assert.equal(botStarts.length, 100);
  const startedArgs = botStarts.flatMap((event) => event.args);
  assert.ok(!startedArgs.includes('Spectator1'));
  assert.ok(!startedArgs.includes('ticket-Spectator1'));
  assert.ok(!startedArgs.some((value) => String(value).includes('ticket-Spectator1')));

  const urlLine = lines.find((line) => line.startsWith('spectator-url='));
  assert.equal(urlLine, 'spectator-url=http://127.0.0.1:8080/modules/web/spectator/');
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
    spectatorUrl: 'http://127.0.0.1:8080/modules/web/spectator/',
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
  const urlLine = lines.find((line) => line.startsWith('spectator-url='));
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
  assert.match(readme, /integration\/launcher\.mjs/);
  assert.doesNotMatch(readme, /formal-ds-smoke\.mjs/);
  assert.doesNotMatch(readme, /端到端启动器还没有/);
});

test('committed server.json and tour no longer claim runtime-only', () => {
  const server = readFileSync(new URL('../server.json', import.meta.url), 'utf8');
  const tour = readFileSync(new URL('../docs/tour.md', import.meta.url), 'utf8');
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

test('without LUMIO_DS_EXE step 03 is BLOCKED_ENV for the binary, not replace-* tokens', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-nodye-'));
  const evidenceDir = join(isolated, 'evidence');
  const report = await runLauncher({
    root: isolated,
    env: {},
    bots: 1,
    staggerMs: 0,
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
  assert.equal(report.steps.find((step) => step.id === '03').status, 'BLOCKED_ENV');
  assert.match(report.steps.find((step) => step.id === '03').detail, /LUMIO_DS_EXE/);
  assert.doesNotMatch(report.steps.find((step) => step.id === '03').detail, /replace-/);
  assert.doesNotMatch(report.steps.find((step) => step.id === '03').detail, /REPLACE_WITH_PLATFORM/);
  assert.doesNotMatch(report.steps.find((step) => step.id === '03').detail, /missing required value/);
});

test('step 03 with a live DS exe does not fail on replace-* tokens', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-dsconfig-'));
  const evidenceDir = join(isolated, 'evidence');
  const committed = JSON.parse(readFileSync(new URL('../server.json', import.meta.url), 'utf8'));
  writeFileSync(join(isolated, 'server.json'), `${JSON.stringify(committed)}\n`);
  const report = await runLauncher({
    root: isolated,
    env: {},
    bots: 1,
    staggerMs: 0,
    durationMs: 0,
    timeoutMs: 1_000,
    sessions: [session('Bot1', 'ticket-ds')],
    dsExe: touch(isolated, 'lumio-ds'),
    dsConfig: join(isolated, 'server.json'),
    processTools: {
      command() { return 'configuration_valid'; },
      startLogged() {
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
  assert.equal(report.steps.find((step) => step.id === '03').status, 'PASS');
  assert.doesNotMatch(report.steps.find((step) => step.id === '03').detail, /replace-/);
  assert.doesNotMatch(report.steps.find((step) => step.id === '03').detail, /REPLACE_WITH_PLATFORM/);
});

test('unfilled sample tokens on the DS config are a loud missing-value FAIL, not BLOCKED_ENV', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-launch-unfilled-'));
  const evidenceDir = join(isolated, 'evidence');
  const sample = JSON.parse(readFileSync(new URL('../server.sample.json', import.meta.url), 'utf8'));
  writeFileSync(join(isolated, 'server.json'), `${JSON.stringify(sample)}\n`);
  const report = await runLauncher({
    root: isolated,
    env: {},
    bots: 1,
    staggerMs: 0,
    durationMs: 0,
    timeoutMs: 1_000,
    sessions: [session('Bot1', 'ticket-unfilled')],
    dsExe: touch(isolated, 'lumio-ds'),
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

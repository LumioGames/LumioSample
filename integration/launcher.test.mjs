import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { candidateEngineRoots, resolveProcessToolsPath } from './engine-tools.mjs';
import { parseBotAdmit, parseLaunchArgs, runLauncher } from './launcher.mjs';
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
    startLogged(_exe, _args, { log } = {}) {
      starts += 1;
      events.push({ kind: 'start', at: Date.now(), starts });
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

function launchFiles(isolated) {
  return {
    dsExe: touch(isolated, 'lumio-ds'),
    dsConfig: touch(isolated, 'server.json'),
    botDll: touch(isolated, 'Lumio.Client.Bot.Host.dll'),
    gameplay: touch(isolated, 'Lumio.Sample.Gameplay.dll'),
    engineNative: touch(isolated, 'lumio.dll'),
  };
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
  assert.match(report.steps.find((step) => step.id === '05').detail, /consume is not wired/);
  assert.doesNotMatch(report.steps.find((step) => step.id === '05').detail, /does not exist|not public/);
  assert.equal(report.steps.find((step) => step.id === '14').status, 'BLOCKED_ENV');
  for (const id of ['05', '07', '08', '09', '10', '11', '12', '13', '14']) {
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

test('root README names the launcher and does not keep formal-ds-smoke', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  assert.match(readme, /integration\/launcher\.mjs/);
  assert.doesNotMatch(readme, /formal-ds-smoke\.mjs/);
  assert.doesNotMatch(readme, /端到端启动器还没有/);
});

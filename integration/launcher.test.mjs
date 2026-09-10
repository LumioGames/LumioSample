import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { candidateEngineRoots, resolveProcessToolsPath } from './engine-tools.mjs';
import { parseLaunchArgs, runLauncher } from './launcher.mjs';
import { formatStep, planBotLogins, TOUR_STEPS } from './tour-steps.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

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

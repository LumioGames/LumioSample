import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBotArgs, buildServerArgs, parseDsReadyLine, redactArgs, resolveDsEndpoint } from './ds-ready.mjs';

test('server invocation is the production lumio-ds config entrypoint', () => {
  assert.deepEqual(buildServerArgs('server.json'), ['--config', 'server.json']);
});

test('Bot.Host invocation carries server, ticket, native SDK, log directory and gameplay', () => {
  const args = buildBotArgs({
    botDll: 'Lumio.Client.Bot.Host.dll',
    endpoint: 'ws://127.0.0.1:9110/',
    admissionTicket: 'ticket_123',
    engineNative: 'lumio.dll',
    logDir: 'logs/bot',
    accountFrom: 'Bot1',
    accountTo: 'Bot1',
    gameplay: 'Lumio.Sample.Gameplay.dll',
  });
  assert.deepEqual(args.slice(1, 7), ['--server', 'ws://127.0.0.1:9110/', '--admission-ticket', 'ticket_123', '--engine-native', 'lumio.dll']);
  assert.ok(args.includes('--log-dir'));
  const gameplayAt = args.indexOf('--gameplay');
  assert.ok(gameplayAt >= 0);
  assert.equal(args[gameplayAt + 1], 'Lumio.Sample.Gameplay.dll');
  assert.ok(!args.includes('test-harness'));
});

test('Bot.Host invocation refuses to omit --gameplay', () => {
  assert.throws(
    () => buildBotArgs({
      botDll: 'Lumio.Client.Bot.Host.dll',
      endpoint: 'ws://127.0.0.1:9110/',
      admissionTicket: 'ticket_123',
      engineNative: 'lumio.dll',
      logDir: 'logs/bot',
      accountFrom: 'Bot1',
    }),
    /--gameplay/,
  );
});

test('DS_READY parses production readiness payload and derives port', () => {
  const ready = parseDsReadyLine('DS_READY {"pid":42,"endpoint":"ws://127.0.0.1:9110","roomId":"sample","tickRate":20}');
  assert.equal(ready.pid, 42);
  assert.equal(ready.port, 9110);
  assert.equal(ready.roomId, 'sample');
  assert.equal(parseDsReadyLine('server started'), null);
});

test('DS_READY rejects malformed, non-network, or credential-bearing endpoints', () => {
  assert.throws(() => parseDsReadyLine('DS_READY {"pid":42,"endpoint":"not-a-url"}'));
  assert.throws(() => parseDsReadyLine('DS_READY {"pid":42,"endpoint":"http://127.0.0.1:9110"}'));
  assert.throws(() => parseDsReadyLine('DS_READY {"pid":42,"endpoint":"ws://127.0.0.1:9110/?ticket=secret"}'));
});

test('formal endpoint stays loopback and matches DS_READY', () => {
  const ready = parseDsReadyLine('DS_READY {"pid":42,"endpoint":"ws://127.0.0.1:9110"}');
  assert.equal(resolveDsEndpoint(ready), 'ws://127.0.0.1:9110/');
  assert.throws(() => resolveDsEndpoint(ready, 'ws://127.0.0.1:9111/'));
  assert.throws(() => resolveDsEndpoint(ready, 'wss://game.example:9110/'));
});

test('redact hides the admission ticket', () => {
  assert.deepEqual(redactArgs(['--admission-ticket', 'secret'], 'secret'), ['--admission-ticket', '<redacted>']);
});

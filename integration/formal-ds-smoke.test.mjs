import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBotArgs, buildServerArgs, parseCliArgs, parseDsReadyLine, redactArgs, resolveDsEndpoint } from './formal-ds-smoke.mjs';

test('formal server invocation is the production lumio-ds config entrypoint', () => {
  assert.deepEqual(buildServerArgs('C:/evidence/server.json'), ['--config', 'C:/evidence/server.json']);
});

test('formal Bot.Host invocation carries server, ticket, native SDK and log directory', () => {
  const args = buildBotArgs({ botDll: 'C:/client/Lumio.Client.Bot.Host.dll', endpoint: 'ws://127.0.0.1:9110/', admissionTicket: 'ticket_123', engineNative: 'C:/sdk/lumio.dll', logDir: 'C:/evidence/bot', accountFrom: 'Bot01', accountTo: 'Bot01' });
  assert.deepEqual(args.slice(1, 7), ['--server', 'ws://127.0.0.1:9110/', '--admission-ticket', 'ticket_123', '--engine-native', 'C:/sdk/lumio.dll']);
  assert.ok(args.includes('--log-dir')); assert.ok(!args.includes('test-harness'));
});

test('DS_READY parses production readiness payload and derives port', () => {
  const ready = parseDsReadyLine('DS_READY {"pid":42,"endpoint":"ws://127.0.0.1:9110","roomId":"sample","tickRate":20}');
  assert.equal(ready.pid, 42); assert.equal(ready.port, 9110); assert.equal(ready.roomId, 'sample'); assert.equal(parseDsReadyLine('server started'), null);
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

test('CLI overrides environment and redacts admission ticket', () => {
  const options = parseCliArgs(['--ds-exe', 'C:/lumio-ds.exe', '--timeout-ms', '5000'], { LUMIO_DS_EXE: 'from-env', LUMIO_FORMAL_TIMEOUT_MS: '1000' });
  assert.equal(options.dsExe, 'C:/lumio-ds.exe'); assert.equal(options.timeoutMs, 5000);
  assert.deepEqual(redactArgs(['--admission-ticket', 'secret'], 'secret'), ['--admission-ticket', '<redacted>']);
});

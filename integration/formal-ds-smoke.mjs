#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const READY_PREFIX = 'DS_READY ';
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_ACCOUNT = 'Bot01';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export class BlockedEnvError extends Error {
  constructor(message) { super(`BLOCKED_ENV: ${message}`); this.name = 'BlockedEnvError'; this.code = 'BLOCKED_ENV'; }
}
class UsageError extends Error { constructor(message) { super(message); this.code = 'USAGE'; } }
const blocked = message => new BlockedEnvError(message);

function requiredFile(path, label) {
  if (!path) throw blocked(`${label} is not set.`);
  if (!existsSync(path) || !statSync(path).isFile()) throw blocked(`${label} does not point to a file: ${path}`);
  return realpathSync(path);
}
function requiredValue(value, label) {
  if (value == null || String(value).trim() === '') throw blocked(`${label} is not set.`);
  return String(value).trim();
}
function validateTicket(ticket) {
  const value = requiredValue(ticket, 'LUMIO_ADMISSION_TICKET');
  if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length > 16_384) {
    throw blocked('LUMIO_ADMISSION_TICKET must be a base64url value no longer than 16384 characters.');
  }
  return value;
}
function validateDsName(path) {
  if (basename(path).toLowerCase().replace(/\.exe$/, '') !== 'lumio-ds') {
    throw blocked(`LUMIO_DS_EXE must name the production lumio-ds executable: ${path}`);
  }
}

/** Parse one production DS readiness line. Non-readiness lines return null. */
export function parseDsReadyLine(line) {
  if (typeof line !== 'string' || !line.startsWith(READY_PREFIX)) return null;
  let value;
  try { value = JSON.parse(line.slice(READY_PREFIX.length)); }
  catch (error) { throw new Error(`DS_READY contains invalid JSON: ${error.message}`); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('DS_READY payload must be a JSON object.');
  if (!Number.isInteger(value.pid) || value.pid < 1) throw new Error('DS_READY must include a positive integer pid.');
  if (typeof value.endpoint !== 'string') throw new Error('DS_READY must include an endpoint URL.');
  let endpoint;
  try { endpoint = new URL(value.endpoint); }
  catch (error) { throw new Error(`DS_READY endpoint is invalid: ${error.message}`); }
  if (!['ws:', 'wss:'].includes(endpoint.protocol)) throw new Error('DS_READY endpoint must use ws:// or wss://.');
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('DS_READY endpoint must not contain credentials or routing hints.');
  const port = Number(endpoint.port || (endpoint.protocol === 'wss:' ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('DS_READY endpoint must include a valid port.');
  return { ...value, endpoint: endpoint.href, port };
}

export const buildServerArgs = configPath => ['--config', configPath];

export function buildBotArgs({ botDll, endpoint, admissionTicket, engineNative, logDir, accountFrom = DEFAULT_ACCOUNT, accountTo = accountFrom }) {
  return [botDll, '--server', endpoint, '--admission-ticket', admissionTicket, '--engine-native', engineNative,
    '--log-dir', logDir, '--account-from', accountFrom, '--account-to', accountTo];
}

export const redactArgs = (args, secret) => args.map(value => secret && value === secret ? '<redacted>' : value);

export function resolveDsEndpoint(ready, configuredEndpoint = undefined) {
  if (!ready || typeof ready !== 'object') throw new TypeError('DS_READY result is required.');
  let endpoint;
  try { endpoint = new URL(configuredEndpoint ?? ready.endpoint); }
  catch (error) { throw new Error(`DS endpoint is invalid: ${error.message}`); }
  if (!['ws:', 'wss:'].includes(endpoint.protocol)) throw new Error('DS endpoint must use ws:// or wss://.');
  if (!LOOPBACK_HOSTS.has(endpoint.hostname)) throw new Error('Formal smoke only accepts a loopback DS endpoint.');
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('DS endpoint must not contain credentials or routing hints.');
  const port = Number(endpoint.port || (endpoint.protocol === 'wss:' ? 443 : 80));
  if (port !== ready.port) throw new Error(`DS endpoint port ${port} does not match DS_READY port ${ready.port}.`);
  return endpoint.href;
}

function commandLine(executable, args, secret) { return `$ ${JSON.stringify([executable, ...redactArgs(args, secret)])}\n`; }
function startLogged(executable, args, { cwd, logPath, secret } = {}) {
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, commandLine(executable, args, secret));
  const child = spawn(executable, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const state = { child, stdout: '', closed: false, code: null, signal: null, error: null };
  child.stdin.on('error', () => {});
  child.stdout.on('data', bytes => { state.stdout = (state.stdout + bytes.toString()).slice(-1_048_576); appendFileSync(logPath, bytes); });
  child.stderr.on('data', bytes => appendFileSync(logPath, bytes));
  child.on('error', error => { state.error = error; });
  state.done = new Promise(resolvePromise => child.once('close', (code, signal) => {
    Object.assign(state, { closed: true, code, signal }); resolvePromise(state);
  }));
  return state;
}
function assertAlive(state) {
  if (state.error) throw state.error;
  if (state.closed) throw new Error(`Process ${state.child.pid} exited before proof completed: code=${state.code}, signal=${state.signal}`);
}
function waitFor(predicate, label, timeoutMs, guard = () => {}) {
  const started = Date.now();
  return new Promise((resolvePromise, reject) => {
    const poll = () => {
      try {
        guard(); const value = predicate();
        if (value) return resolvePromise(value);
        if (Date.now() - started >= timeoutMs) return reject(new Error(`Timed out waiting for ${label}.`));
        const timer = setTimeout(poll, 25); timer.unref?.();
      } catch (error) { reject(error); }
    };
    poll();
  });
}
function findReady(stdout) {
  for (const line of stdout.split(/\r?\n/)) { const value = parseDsReadyLine(line); if (value) return value; }
  return null;
}
function readNdjson(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
}
async function stopProcess(state, label) {
  if (!state || state.closed) return state;
  state.child.kill('SIGINT');
  let result = await Promise.race([state.done, new Promise(resolvePromise => setTimeout(() => resolvePromise(null), 5_000))]);
  if (result === null && !state.closed) {
    state.child.kill('SIGTERM');
    result = await Promise.race([state.done, new Promise(resolvePromise => setTimeout(resolvePromise, 2_000))]);
  }
  if (!state.closed) throw new Error(`${label} did not exit after shutdown was requested.`);
  return result;
}
async function forceCleanup(state) {
  if (!state || state.closed) return;
  state.child.kill('SIGKILL');
  await Promise.race([state.done, new Promise(resolvePromise => setTimeout(resolvePromise, 5_000))]);
}
function checkCommand(executable) {
  const result = spawnSync(executable, ['--version'], { stdio: 'ignore', windowsHide: true });
  if (result.error || result.status !== 0) throw blocked(`${executable} is unavailable.`);
}
const sha256File = path => createHash('sha256').update(readFileSync(path)).digest('hex');
function sanitizeMessage(message, secret) { const text = String(message ?? ''); return secret ? text.replaceAll(secret, '<redacted>') : text; }

export function parseCliArgs(argv = process.argv.slice(2), environment = process.env) {
  const options = {
    dsExe: environment.LUMIO_DS_EXE, dsConfig: environment.LUMIO_DS_CONFIG, botDll: environment.LUMIO_BOT_DLL,
    engineNative: environment.LUMIO_ENGINE_NATIVE, admissionTicket: environment.LUMIO_ADMISSION_TICKET,
    endpoint: environment.LUMIO_DS_ENDPOINT, accountFrom: environment.LUMIO_BOT_ACCOUNT_FROM || environment.LUMIO_FORMAL_LOGIN || DEFAULT_ACCOUNT,
    accountTo: environment.LUMIO_BOT_ACCOUNT_TO || environment.LUMIO_FORMAL_LOGIN, dotnet: environment.LUMIO_DOTNET || 'dotnet',
    evidenceDir: environment.LUMIO_FORMAL_EVIDENCE_DIR, timeoutMs: Number(environment.LUMIO_FORMAL_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
  };
  const names = { 'ds-exe': 'dsExe', 'ds-config': 'dsConfig', 'bot-dll': 'botDll', 'engine-native': 'engineNative',
    'admission-ticket': 'admissionTicket', endpoint: 'endpoint', 'account-from': 'accountFrom', 'account-to': 'accountTo',
    dotnet: 'dotnet', 'evidence-dir': 'evidenceDir', 'timeout-ms': 'timeoutMs' };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    const key = flag.startsWith('--') ? flag.slice(2) : '';
    if (!Object.hasOwn(names, key)) throw new UsageError(`unknown option: ${flag}`);
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new UsageError(`${flag} requires a value`);
    const value = argv[++index]; options[names[key]] = key === 'timeout-ms' ? Number(value) : value;
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000) throw new UsageError('--timeout-ms must be an integer of at least 1000.');
  if (!options.accountTo) options.accountTo = options.accountFrom;
  return options;
}
function usage() {
  return ['Usage: node integration/formal-ds-smoke.mjs [options]', '', 'Runs a production lumio-ds + Lumio.Client.Bot.Host loopback smoke.',
    'Required environment: LUMIO_DS_EXE, LUMIO_DS_CONFIG, LUMIO_BOT_DLL,', '  LUMIO_ENGINE_NATIVE, LUMIO_ADMISSION_TICKET.',
    'Optional: LUMIO_DS_ENDPOINT, LUMIO_BOT_ACCOUNT_FROM, LUMIO_BOT_ACCOUNT_TO,', '  LUMIO_DOTNET, LUMIO_FORMAL_EVIDENCE_DIR, LUMIO_FORMAL_TIMEOUT_MS.'].join('\n');
}

export async function runFormalSmoke(options = {}) {
  const root = realpathSync(options.root ?? ROOT);
  const parent = join(root, 'integration', 'logs'); mkdirSync(parent, { recursive: true });
  const evidence = options.evidenceDir ? resolve(options.evidenceDir) : mkdtempSync(join(parent, 'formal-ds-'));
  mkdirSync(evidence, { recursive: true });
  const reportPath = join(evidence, 'verification.json');
  const report = { version: 1, status: 'RUNNING', scope: 'production-ds-client-loopback', evidence };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  let ds; let bot; let ticket = '';
  try {
    const dsExe = requiredFile(options.dsExe, 'LUMIO_DS_EXE'); validateDsName(dsExe);
    const dsConfig = requiredFile(options.dsConfig, 'LUMIO_DS_CONFIG');
    const botDll = requiredFile(options.botDll, 'LUMIO_BOT_DLL');
    const engineNative = requiredFile(options.engineNative, 'LUMIO_ENGINE_NATIVE');
    ticket = validateTicket(options.admissionTicket);
    const dotnet = requiredValue(options.dotnet || 'dotnet', 'LUMIO_DOTNET'); checkCommand(dotnet);
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000) throw new UsageError('timeoutMs must be an integer of at least 1000.');
    const cwd = dirname(dsExe); const dsArgs = buildServerArgs(dsConfig);
    const check = spawnSync(dsExe, [...dsArgs, '--check-config'], { cwd, encoding: 'utf8', windowsHide: true });
    writeFileSync(join(evidence, 'lumio-ds.check-config.log'), `${commandLine(dsExe, [...dsArgs, '--check-config'])}${check.stdout ?? ''}${check.stderr ?? ''}`);
    if (check.error) throw check.error; if (check.status !== 0) throw new Error(`lumio-ds --check-config exited ${check.status ?? check.signal}.`);
    ds = startLogged(dsExe, dsArgs, { cwd, logPath: join(evidence, 'lumio-ds.log') });
    const ready = await waitFor(() => findReady(ds.stdout), 'lumio-ds DS_READY', timeoutMs, () => assertAlive(ds));
    if (ready.pid !== ds.child.pid) throw new Error(`DS_READY pid ${ready.pid} does not match lumio-ds pid ${ds.child.pid}.`);
    const endpoint = resolveDsEndpoint(ready, options.endpoint);
    const botLogDir = join(evidence, 'bot'); mkdirSync(botLogDir, { recursive: true });
    const accountFrom = requiredValue(options.accountFrom || DEFAULT_ACCOUNT, 'LUMIO_BOT_ACCOUNT_FROM');
    const accountTo = requiredValue(options.accountTo || accountFrom, 'LUMIO_BOT_ACCOUNT_TO');
    bot = startLogged(dotnet, buildBotArgs({ botDll, endpoint, admissionTicket: ticket, engineNative, logDir: botLogDir, accountFrom, accountTo }),
      { cwd: dirname(botDll), logPath: join(evidence, 'bot-host.log'), secret: ticket });
    const tracePath = join(botLogDir, 'bot-host.ndjson');
    const input = await waitFor(() => readNdjson(tracePath).find(row => row.kind === 'chat.input'), 'Bot.Host chat.input', timeoutMs,
      () => { assertAlive(ds); assertAlive(bot); });
    report.dsReady = { pid: ready.pid, endpoint, port: ready.port, roomId: ready.roomId, gameReleaseId: ready.gameReleaseId, tickRate: ready.tickRate };
    report.client = { pid: bot.child.pid, accountFrom, accountTo, input: { kind: input.kind, mappingId: input.mappingId, sequence: input.sequence, accountId: input.accountId, tick: input.tick } };
    report.artifacts = { dsExecutableSha256: sha256File(dsExe), dsConfigSha256: sha256File(dsConfig), botAssemblySha256: sha256File(botDll), engineNativeSha256: sha256File(engineNative) };
    report.evidenceFiles = { dsLog: join(evidence, 'lumio-ds.log'), checkConfigLog: join(evidence, 'lumio-ds.check-config.log'), botLog: join(evidence, 'bot-host.log'), botTrace: tracePath };
    writeFileSync(join(botLogDir, 'release.flag'), 'release\n');
    await stopProcess(bot, 'Bot.Host'); await stopProcess(ds, 'lumio-ds');
    if (bot.code !== 0) throw new Error(`Bot.Host exited ${bot.code ?? bot.signal} after release.`);
    if (ds.code !== 0) throw new Error(`lumio-ds exited ${ds.code ?? ds.signal} after release.`);
    report.status = 'PASS'; return report;
  } catch (error) {
    report.status = error?.code === 'BLOCKED_ENV' || String(error?.message).startsWith('BLOCKED_ENV:') ? 'BLOCKED_ENV' : 'FAIL';
    report.error = sanitizeMessage(error?.message ?? error, ticket); throw error;
  } finally {
    await forceCleanup(bot); await forceCleanup(ds); writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`VERIFICATION_STATUS=${report.status}\nEVIDENCE_PATH=${evidence}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseCliArgs();
    if (options.help) process.stdout.write(`${usage()}\n`); else await runFormalSmoke(options);
  } catch (error) {
    if (error?.code === 'USAGE') process.stderr.write(`${error.message}\n${usage()}\n`);
    else process.stderr.write(`${sanitizeMessage(error?.message ?? error, process.env.LUMIO_ADMISSION_TICKET ?? '')}\n`);
    process.exitCode = error?.code === 'BLOCKED_ENV' || String(error?.message).startsWith('BLOCKED_ENV:') ? 2 : 1;
  }
}

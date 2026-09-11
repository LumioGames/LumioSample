#!/usr/bin/env node

/**
 * S-3 one-command launcher (R-00520).
 *
 * Real topology: Platform compose + lumio-ds + N C# Bot.Host processes, staggered
 * admit, unique launch tickets. Internal-only while the Platform image is private.
 * Missing process-tools / Platform / DS / Bot.Host is BLOCKED_ENV (exit 2), not a pass.
 * Bot.Host production mode requires --gameplay (Client FoundationHostCommand).
 * Live children stay up for the acceptance window (--duration-ms, else --timeout-ms)
 * before forceCleanup. forceCleanup is never treated as proof.
 */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginAndLaunch } from './account-client.mjs';
import { buildBotArgs, buildServerArgs, findDsReady, redactArgs, resolveDsEndpoint } from './ds-ready.mjs';
import { blocked, loadProcessTools } from './engine-tools.mjs';
import { inspectBaseMap } from './server-profile.mjs';
import { formatStep, planBotLogins, TOUR_STEPS } from './tour-steps.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_STAGGER_MS = 250;
const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_ACCOUNT = 'Bot1';

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = 'UsageError';
    this.code = 'USAGE';
  }
}

function requiredValue(value, label) {
  if (value == null || String(value).trim() === '') throw blocked(`${label} is not set.`);
  return String(value).trim();
}

function requiredFile(path, label) {
  const value = requiredValue(path, label);
  if (!existsSync(value)) throw blocked(`${label} does not point to a file: ${value}`);
  return resolve(value);
}

export function parseLaunchArgs(argv = process.argv.slice(2), environment = process.env) {
  const options = {
    bots: Number(environment.LUMIO_BOTS || 2),
    staggerMs: Number(environment.LUMIO_STAGGER_MS || DEFAULT_STAGGER_MS),
    durationMs: Number(environment.LUMIO_DURATION_MS || 0),
    origin: environment.LUMIO_PLATFORM_ORIGIN,
    slug: environment.LUMIO_GAME_SLUG || 'sample',
    composeFile: environment.LUMIO_PLATFORM_COMPOSE,
    dsExe: environment.LUMIO_DS_EXE,
    dsConfig: environment.LUMIO_DS_CONFIG || 'server.json',
    botDll: environment.LUMIO_BOT_DLL,
    gameplay: environment.LUMIO_GAMEPLAY,
    engineNative: environment.LUMIO_ENGINE_NATIVE,
    endpoint: environment.LUMIO_DS_ENDPOINT,
    dotnet: environment.LUMIO_DOTNET || 'dotnet',
    timeoutMs: Number(environment.LUMIO_LAUNCH_TIMEOUT_MS || DEFAULT_TIMEOUT_MS),
    evidenceDir: environment.LUMIO_LAUNCH_EVIDENCE_DIR,
  };
  const names = {
    bots: 'bots',
    'stagger-ms': 'staggerMs',
    'duration-ms': 'durationMs',
    origin: 'origin',
    slug: 'slug',
    compose: 'composeFile',
    'ds-exe': 'dsExe',
    'ds-config': 'dsConfig',
    'bot-dll': 'botDll',
    gameplay: 'gameplay',
    'engine-native': 'engineNative',
    endpoint: 'endpoint',
    dotnet: 'dotnet',
    'timeout-ms': 'timeoutMs',
    'evidence-dir': 'evidenceDir',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--help' || flag === '-h') return { help: true };
    if (!flag.startsWith('--')) throw new UsageError(`unknown option: ${flag}`);
    const key = names[flag.slice(2)];
    if (!key) throw new UsageError(`unknown option: ${flag}`);
    if (index + 1 >= argv.length || argv[index + 1].startsWith('--')) throw new UsageError(`${flag} requires a value`);
    const value = argv[++index];
    options[key] = key === 'bots' || key.endsWith('Ms') ? Number(value) : value;
  }
  if (!Number.isInteger(options.bots) || options.bots < 1) throw new UsageError('--bots must be a positive integer.');
  if (!Number.isInteger(options.staggerMs) || options.staggerMs < 0) throw new UsageError('--stagger-ms must be a non-negative integer.');
  if (!Number.isInteger(options.durationMs) || options.durationMs < 0) throw new UsageError('--duration-ms must be a non-negative integer.');
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1_000) throw new UsageError('--timeout-ms must be an integer of at least 1000.');
  return options;
}

export function collectLaunchTickets(sessions) {
  const tickets = sessions.map((session) => session.launch.admissionCredential);
  const unique = new Set(tickets);
  if (unique.size !== tickets.length) {
    throw new Error('launch tickets must be unique per bot; reuse is forbidden.');
  }
  return tickets;
}

const LOG_EXTENSIONS = new Set(['.log', '.ndjson', '.jsonl']);

function listLogFiles(root, result = []) {
  if (!root || !existsSync(root)) return result;
  const info = statSync(root);
  if (info.isFile()) {
    if (LOG_EXTENSIONS.has(extname(root).toLowerCase())) result.push(root);
    return result;
  }
  if (!info.isDirectory()) return result;
  for (const name of readdirSync(root).sort()) {
    listLogFiles(join(root, name), result);
  }
  return result;
}

function readTextIfPresent(path) {
  if (!path || !existsSync(path)) return '';
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

export function collectBotEvidenceText({ evidenceDir, index, child } = {}) {
  const chunks = [];
  if (child?.stdout) chunks.push(String(child.stdout));
  if (evidenceDir && Number.isInteger(index) && index >= 0) {
    chunks.push(readTextIfPresent(join(evidenceDir, `bot-${index + 1}.log`)));
    for (const file of listLogFiles(join(evidenceDir, `bot-${index + 1}`))) {
      chunks.push(readTextIfPresent(file));
    }
  }
  return chunks.join('\n');
}

/**
 * Client Bot.Host (ADR-081) writes one lifecycle line per transition:
 * `session state changed {account} {state} {previous} {reason} …`
 * Active + reason established is the admit receipt. Process start is not.
 */
export function parseBotAdmit(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let admitted = false;
  let rejected = false;
  let faulted = false;
  for (const line of lines) {
    if (!line) continue;
    if (line.includes('session login requested')) {
      if (/\baccepted=(False|false)\b/.test(line) || /\sFalse\s*$/.test(line) || /\sFalse\s/.test(line)) {
        rejected = true;
      }
    }
    if (line.includes('session state changed')) {
      const active = /\bstate=Active\b/.test(line) || /\sActive\s/.test(line);
      const established = /\breason=established\b/.test(line) || /\bestablished\b/.test(line);
      if (active && established) admitted = true;
      if (/\bstate=Faulted\b/.test(line) || /\bsession_faulted\b/.test(line)) faulted = true;
    }
  }
  return { admitted, rejected, faulted };
}

export function inspectBotAdmit(source) {
  return parseBotAdmit(typeof source === 'string' ? source : collectBotEvidenceText(source ?? {}));
}

export function countAdmittedBots(bots, { evidenceDir, children = [] } = {}) {
  let admitted = 0;
  const details = [];
  for (let index = 0; index < bots; index += 1) {
    const parsed = inspectBotAdmit({ evidenceDir, index, child: children[index] });
    details.push(parsed);
    if (parsed.admitted && !parsed.rejected && !parsed.faulted) admitted += 1;
  }
  return { admitted, details };
}

async function waitBotsAdmitted({
  bots,
  evidenceDir,
  botChildren,
  liveChildren,
  timeoutMs,
  tools,
  sleepFn,
}) {
  const waitMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();
  let latest = countAdmittedBots(bots, { evidenceDir, children: botChildren });
  while (Date.now() - started < waitMs) {
    for (const child of liveChildren) tools.assertAlive(child);
    latest = countAdmittedBots(bots, { evidenceDir, children: botChildren });
    if (latest.details.some((item) => item.rejected || item.faulted)) return latest;
    if (latest.admitted === bots) return latest;
    // keepAlive: node --test on Linux drops unref'd timers and reports
    // "Promise resolution is still pending but the event loop has already resolved".
    await sleepFn(25, { keepAlive: true });
  }
  return latest;
}

function reportStatusFromSteps(steps) {
  if (steps.some((step) => step.status === 'FAIL')) return 'FAIL';
  if (steps.some((step) => step.status === 'BLOCKED_ENV')) return 'BLOCKED_ENV';
  return 'PASS';
}

async function sleep(ms, { keepAlive = true } = {}) {
  if (ms <= 0) return;
  await new Promise((resolvePromise) => {
    const timer = setTimeout(resolvePromise, ms);
    if (!keepAlive) timer.unref?.();
  });
}

function defaultGameplayPath(root) {
  return join(root, 'src', 'Lumio.Sample.Gameplay', 'bin', 'Debug', 'net10.0', 'Lumio.Sample.Gameplay.dll');
}

async function waitForAcceptance(options, tools, children) {
  if (!children.length) return;
  // Resident Bot.Host does not exit. Hold the configured window so
  // record('04','PASS') is not immediately followed by SIGKILL.
  const holdMs = (Number.isInteger(options.durationMs) && options.durationMs > 0)
    ? options.durationMs
    : (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const started = Date.now();
  while (Date.now() - started < holdMs) {
    for (const child of children) tools.assertAlive(child);
    await sleep(25, { keepAlive: true });
  }
}

function printStep(log, id, status, detail) {
  const line = formatStep(id, status, detail);
  log(line);
  return line;
}

function usage() {
  return [
    'Usage: node integration/launcher.mjs --bots N [--stagger-ms 250] [--origin url]',
    'Internal-only first stage: Platform image is built from a private compose file.',
    'Required for a live run: LUMIO_PLATFORM_ORIGIN, LUMIO_DS_EXE, LUMIO_BOT_DLL,',
    '  LUMIO_GAMEPLAY, LUMIO_ENGINE_NATIVE, LUMIO_BOT_TOOL_CREDENTIAL, sibling process-tools.mjs.',
    'Missing prerequisites exit 2 with VERIFICATION_STATUS=BLOCKED_ENV.',
  ].join('\n');
}

export async function runLauncher(options = {}) {
  const root = resolve(options.root ?? ROOT);
  const log = options.log ?? ((line) => process.stdout.write(`${line}\n`));
  const env = options.env ?? process.env;
  const parent = join(root, 'integration', 'logs');
  mkdirSync(parent, { recursive: true });
  const evidence = options.evidenceDir ? resolve(options.evidenceDir) : mkdtempSync(join(parent, 'launch-'));
  mkdirSync(evidence, { recursive: true });
  const reportPath = join(evidence, 'verification.json');
  const report = {
    version: 1,
    status: 'RUNNING',
    scope: 'sample-launcher',
    internalOnly: true,
    evidence,
    steps: [],
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const record = (id, status, detail) => {
    const line = printStep(log, id, status, detail);
    report.steps.push({ id, status, detail: detail || '', line });
    return line;
  };

  let tools;
  const children = [];
  try {
    const logins = planBotLogins(options.bots ?? 2);
    record(
      '01',
      existsSync(join(root, 'config', 'manifest.json')) ? 'READY' : 'BLOCKED_ENV',
      'LumioConfig export + typed Reader via M9 loader',
    );

    try {
      tools = options.processTools ?? await loadProcessTools({ env, repoRoot: root });
    } catch (error) {
      if (error?.code !== 'BLOCKED_ENV') throw error;
      for (const step of TOUR_STEPS.slice(1)) record(step.id, 'BLOCKED_ENV', error.message);
      report.status = reportStatusFromSteps(report.steps);
      report.error = error.message;
      return report;
    }

    let sessions = options.sessions;
    if (!sessions) {
      if (!options.origin) {
        record('02', 'BLOCKED_ENV', 'LUMIO_PLATFORM_ORIGIN is not set (Platform image is not public).');
      } else {
        sessions = [];
        for (const [index, loginName] of logins.entries()) {
          if (index > 0) await sleep(options.staggerMs ?? DEFAULT_STAGGER_MS);
          const session = await (options.loginAndLaunch ?? loginAndLaunch)({
            origin: options.origin,
            loginName,
            slug: options.slug,
            env,
            log: (line) => log(line),
          });
          sessions.push(session);
        }
        collectLaunchTickets(sessions);
        record('02', 'PASS', `${sessions.length} unique launch tickets`);
      }
    } else {
      collectLaunchTickets(sessions);
      record('02', 'PASS', `${sessions.length} unique launch tickets`);
    }

    if (!options.dsExe || !existsSync(options.dsExe)) {
      record('03', 'BLOCKED_ENV', 'LUMIO_DS_EXE is not set or is not a file.');
      for (const step of TOUR_STEPS.slice(3)) record(step.id, 'BLOCKED_ENV', 'waiting for lumio-ds');
      report.status = reportStatusFromSteps(report.steps);
      return report;
    }

    const dsExe = requiredFile(options.dsExe, 'LUMIO_DS_EXE');
    const dsConfig = requiredFile(options.dsConfig ?? join(root, 'server.json'), 'LUMIO_DS_CONFIG');
    const dsArgs = buildServerArgs(dsConfig);
    const check = tools.command(dsExe, [...dsArgs, '--check-config'], { cwd: dirname(dsExe), log: join(evidence, 'lumio-ds.check-config.log') });
    log(`lumio-ds --check-config\n${check ?? ''}`);
    const ds = tools.startLogged(dsExe, dsArgs, { cwd: dirname(dsExe), log: join(evidence, 'lumio-ds.log') });
    children.push(ds);
    const started = Date.now();
    let ready = findDsReady(ds.stdout);
    while (!ready && Date.now() - started < (options.timeoutMs ?? DEFAULT_TIMEOUT_MS)) {
      tools.assertAlive(ds);
      await sleep(25, { keepAlive: true });
      ready = findDsReady(ds.stdout);
    }
    if (!ready) throw new Error('Timed out waiting for lumio-ds DS_READY. See integration/logs.');
    const endpoint = resolveDsEndpoint(ready, options.endpoint);
    record('03', 'PASS', `endpoint=${endpoint}`);

    if (!options.botDll || !existsSync(options.botDll)) {
      record('04', 'BLOCKED_ENV', 'LUMIO_BOT_DLL is not set (Client Bot.Host / R-00534).');
      for (const step of TOUR_STEPS.slice(4)) record(step.id, 'BLOCKED_ENV', 'waiting for Bot.Host Activate');
      report.status = reportStatusFromSteps(report.steps);
      return report;
    }

    const gameplayCandidate = options.gameplay || defaultGameplayPath(root);
    if (!existsSync(gameplayCandidate)) {
      record('04', 'BLOCKED_ENV', 'LUMIO_GAMEPLAY is not set (Client Bot.Host requires --gameplay).');
      for (const step of TOUR_STEPS.slice(4)) record(step.id, 'BLOCKED_ENV', 'waiting for Bot.Host Activate');
      report.status = reportStatusFromSteps(report.steps);
      return report;
    }

    if (!sessions) throw blocked('no launch tickets; cannot admit bots.');
    const engineNative = requiredFile(options.engineNative, 'LUMIO_ENGINE_NATIVE');
    const gameplay = requiredFile(gameplayCandidate, 'LUMIO_GAMEPLAY');
    const dotnet = requiredValue(options.dotnet || 'dotnet', 'LUMIO_DOTNET');
    const botChildren = [];
    for (const [index, session] of sessions.entries()) {
      if (index > 0) await sleep(options.staggerMs ?? DEFAULT_STAGGER_MS);
      const botLogDir = join(evidence, `bot-${index + 1}`);
      mkdirSync(botLogDir, { recursive: true });
      const args = buildBotArgs({
        botDll: requiredFile(options.botDll, 'LUMIO_BOT_DLL'),
        endpoint,
        admissionTicket: session.launch.admissionCredential,
        engineNative,
        logDir: botLogDir,
        accountFrom: session.login.loginName,
        accountTo: session.login.loginName,
        gameplay,
      });
      log(`$ ${JSON.stringify([dotnet, ...redactArgs(args, session.launch.admissionCredential)])}`);
      const bot = tools.startLogged(dotnet, args, {
        cwd: dirname(options.botDll),
        log: join(evidence, `bot-${index + 1}.log`),
      });
      botChildren.push(bot);
      children.push(bot);
    }
    const admit = await waitBotsAdmitted({
      bots: sessions.length,
      evidenceDir: evidence,
      botChildren,
      liveChildren: children,
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      tools,
      sleepFn: sleep,
    });
    report.requiredBots = sessions.length;
    report.admittedBots = admit.admitted;
    if (admit.admitted !== sessions.length) {
      record('04', 'FAIL', `${admit.admitted} of ${sessions.length} bots admitted (reject/no welcome/timeout)`);
    } else {
      record('04', 'PASS', `${admit.admitted} bots admitted with unique tickets`);
    }
    const map = inspectBaseMap(root);
    record(
      '05',
      'BLOCKED_ENV',
      map.placeholder
        ? `${map.path} is a placeholder and must not be treated as a base map; Sample write-cell consume is not wired (R-00522). Missing command: ${map.missingCommand}.`
        : `${map.path} loaded`,
    );
    record('06', 'READY', 'PlayerEntity is declared; live spawn is the DS admit path.');
    record('07', 'BLOCKED_ENV', 'MoveAbility is in-tree; live Activate waits Client R-00534 AC10.');
    record('08', 'BLOCKED_ENV', 'ChatComponent is in-tree; live chat waits Bot.Host.');
    record('09', 'BLOCKED_ENV', 'MineAbility is in-tree; mine admit R-00468 is an engine gap.');
    record('10', 'BLOCKED_ENV', 'VeinReserveComponent decrements in-process; voxel bind is R-00469.');
    record('11', 'BLOCKED_ENV', 'MineAbility.TryRequestAirWrite is false until voxel batch write exists.');
    record('12', 'BLOCKED_ENV', 'OreDropEntity is declared; structure-commit R-00462 is an engine gap.');
    record('13', 'BLOCKED_ENV', 'PickupOreEffect is declared; Effect settlement on DS waits R-00480.');
    record('14', 'BLOCKED_ENV', 'save/restore waits a restoreable VoxelEngine capture; committed server.json is runtime+voxel + snapshot_only, but maps/sample.voxel is still a placeholder.');
    report.status = reportStatusFromSteps(report.steps);
    // Hold until the acceptance window ends, then let finally forceCleanup.
    if (admit.admitted === sessions.length) {
      await waitForAcceptance(options, tools, children);
    }
    return report;
  } catch (error) {
    report.status = error?.code === 'BLOCKED_ENV' || String(error?.message).startsWith('BLOCKED_ENV:')
      ? 'BLOCKED_ENV'
      : 'FAIL';
    report.error = String(error?.message ?? error);
    if (report.status === 'FAIL') {
      log(`DS/Bot failure: ${report.error}`);
      log(`evidence=${evidence}`);
    }
    throw error;
  } finally {
    if (tools) {
      for (const child of children.reverse()) {
        await tools.forceCleanup(child);
      }
    }
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`VERIFICATION_STATUS=${report.status}\nEVIDENCE_PATH=${evidence}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const options = parseLaunchArgs();
    if (options.help) process.stdout.write(`${usage()}\n`);
    else {
      const report = await runLauncher(options);
      process.exitCode = report.status === 'PASS' ? 0 : report.status === 'BLOCKED_ENV' ? 2 : 1;
    }
  } catch (error) {
    if (error?.code === 'USAGE') {
      process.stderr.write(`${error.message}\n${usage()}\n`);
      process.exitCode = 1;
    } else {
      process.stderr.write(`${error?.message ?? error}\n`);
      process.exitCode = error?.code === 'BLOCKED_ENV' || String(error?.message).startsWith('BLOCKED_ENV:') ? 2 : 1;
    }
  }
}

export { DEFAULT_ACCOUNT, TOUR_STEPS, formatStep, planBotLogins, usage };

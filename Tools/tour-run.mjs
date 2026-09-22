#!/usr/bin/env node

/**
 * Fourteen-step tour driver (Phase 1 live acceptance).
 *
 * One voxel-owning resident bot (Client PR #128 route: --server + --scenario-name +
 * --voxel-config) walks sample.md steps 05–13 against a real lumio-ds on 9111, then the
 * driver checkpoints, stops the DS, reboots it on the same store and re-admits the same
 * account under SampleRestoreVerifyScenario for step 14. Every step verdict comes from
 * artifacts (DS logs, bot result.ndjson, DS_READY/DS_CHECKPOINT stdout) — never from
 * process liveness alone.
 *
 * Recorded environment deviations (same family as the 2026-09-21 acceptance):
 *  - DS listens on 9111 (9110 is held by a long-lived T1 demo process; red line).
 *  - The bot account is an ordinary-namespace fixed name (the compose platform's bot-tool
 *    public key is all zeros, so Bot* namespace names cannot register).
 *  - The DS is stopped by kill AFTER a periodic DS_CHECKPOINT that postdates bot
 *    completion; Windows offers no cross-process Ctrl+C, and the checkpoint (not the
 *    kill) is the persistence artifact under judgment. A kill before any checkpoint is
 *    FAIL, never pass.
 *
 * Usage: node Tools/tour-run.mjs [--run <name>] [--hold-open] (env overrides below)
 * Env: LUMIO_DS_EXE, LUMIO_BOT_DLL, LUMIO_GAMEPLAY_DIR (Release/net10.0), LUMIO_GAMEPLAY_CLIENT
 *      (Release/net10.0-client dll), LUMIO_SCENARIO_DLL, LUMIO_ENGINE_NATIVE, LUMIO_PLATFORM_ORIGIN,
 *      LUMIO_BOT_LOGIN (default AcctTour01), LUMIO_TOUR_PORT (default 9111)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginAndLaunch } from './account-client.mjs';
import { buildBotArgs, buildServerArgs, findDsReady, resolveDsEndpoint } from './ds-ready.mjs';
import { assertRunnableDsConfig, writeKernelConfigForRun } from './ds-config.mjs';
import { loadProcessTools } from './engine-tools.mjs';
import { formatStep } from './tour-steps.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const RUN = process.env.LUMIO_TOUR_RUN || `tour-${new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)}`;
const EVIDENCE = join(ROOT, '.run', `${RUN}-evidence`);
const DS_LOG_DIR = join(ROOT, '.run', `${RUN}-ds-logs`);
const STORE = join(ROOT, '.run', `state-${RUN}`);
const RUN_CONFIG = join(ROOT, '.run', `server.${RUN}.json`);
// ADR-115: startup config is data under the server end; tables are exported per end.
const DS_CONFIG_TEMPLATE = join(ROOT, 'Server', 'Config', 'Startup', 'server.json');
const SERVER_TABLES = join(ROOT, 'Server', 'Config', 'Tables');
const CLIENT_TABLES = join(ROOT, 'Client', 'Config', 'Tables');

const ORIGIN = process.env.LUMIO_PLATFORM_ORIGIN || 'http://127.0.0.1:8080';
// One fresh account per run: login-or-register with a one-shot password cannot re-enter an
// account an earlier run created, and the tour re-admits the same login after the restart.
const LOGIN = process.env.LUMIO_BOT_LOGIN || `AcctTour${RUN.replace(/[^0-9A-Za-z]/g, '')}`;
const PORT = Number(process.env.LUMIO_TOUR_PORT || 9111);
const DS_EXE = process.env.LUMIO_DS_EXE || 'C:/Work/LumioGames/LumioServer/target-accept/debug/lumio-ds.exe';
const BOT_DLL = process.env.LUMIO_BOT_DLL || 'C:/Work/LumioGames/LumioClient/Tools/BotRunner/bin/Debug/net10.0/Lumio.Client.Bot.Host.dll';
const HOSTENTRY_DIR = 'C:/Work/LumioGames/LumioServer/Application/HostEntry/src/Lumio.Server.HostEntry/bin/Release/net10.0';
const GAMEPLAY_SERVER_DIR = process.env.LUMIO_GAMEPLAY_DIR
  || 'C:/Work/LumioGames/LumioSample/Gameplay/bin/Release/net10.0';
const GAMEPLAY_CLIENT = process.env.LUMIO_GAMEPLAY_CLIENT
  || 'C:/Work/LumioGames/LumioSample/Gameplay/bin/Release/net10.0-client/Lumio.Sample.Gameplay.dll';
const SCENARIO_DLL = process.env.LUMIO_SCENARIO_DLL || 'C:/Work/LumioGames/LumioSample/Client/Bots/bin/Release/net10.0/Lumio.Sample.Bots.dll';
const ENGINE_NATIVE = process.env.LUMIO_ENGINE_NATIVE
  || 'C:/Work/LumioGames/LumioGameEngine/.run/fbbabe6103e55be2a1715a0bd06b9fa0/win-x64/run-8IAPFC/lumio_engine_native.dll';
const VOXEL_CONFIG = join(ROOT, '.run', 'demo-voxel-bot.json');
const MINING_SCENARIO = 'Lumio.Sample.Bots.SampleMiningScenario';
const RESTORE_SCENARIO = 'Lumio.Sample.Bots.SampleRestoreVerifyScenario';
const BOT_TICKS = Number(process.env.LUMIO_TOUR_TICKS || 15000);
const VERIFY_TICKS = 6000;
const CHECKPOINT_SECONDS = Number(process.env.LUMIO_TOUR_CHECKPOINT_SECONDS || 15);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function stepVerdictsFromBotResult(text) {
  const lines = String(text ?? '').split(/\r?\n/).filter(Boolean);
  let assertLine = null;
  let runLine = null;
  for (const line of lines) {
    try {
      const value = JSON.parse(line);
      if (value.kind === 'assert') assertLine = value;
      if (value.kind === 'run') runLine = value;
    } catch { /* not json */ }
  }
  return { assertLine, runLine };
}

function readLogDir(dir) {
  const chunks = [];
  const visit = path => {
    if (!existsSync(path)) return;
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      if (name.endsWith('.log') || name.endsWith('.ndjson')) chunks.push(String(readFileSync(child, 'utf8')));
    }
  };
  visit(dir);
  return chunks.join('\n');
}

function count(pattern, text) {
  const matches = String(text ?? '').match(pattern);
  return matches ? matches.length : 0;
}

function buildRunConfig(launch) {
  const base = JSON.parse(readFileSync(DS_CONFIG_TEMPLATE, 'utf8'));
  // The committed allocation/key block is a LOCAL stand-in; a platform-issued ticket carries the
  // real audience/room/allocation claims and is signed by the compose platform's key. The DS
  // validates both, so a run config cloned from the template must take the real values from the
  // launch response + environment, or every connection dies pre-admission with nothing logged.
  const admissionKey = process.env.LUMIO_PLATFORM_ADMISSION_KEY
    || '9593f57065df3c7303d67a27a458cd4ec8c55de7c5e6c6153b80c5a32ef19cd7';
  const config = {
    ...base,
    allocation: {
      serverAudience: launch.serverAudience,
      gameId: launch.gameId,
      gameReleaseId: launch.gameReleaseId,
      contractId: launch.contractId,
      roomId: launch.roomId,
      allocationId: launch.allocationId,
    },
    admission_public_key_hex: admissionKey,
    clr: {
      ...base.clr,
      engine_native: ENGINE_NATIVE.replaceAll('\\', '/'),
      hostfxr: 'C:/Users/g923/.dotnet/host/fxr/10.0.11/hostfxr.dll',
      runtime_config: `${HOSTENTRY_DIR}/Lumio.Server.HostEntry.runtimeconfig.json`,
      assembly: `${HOSTENTRY_DIR}/Lumio.Server.HostEntry.dll`,
      entry_type: 'Lumio.Server.HostEntry.HostEntry, Lumio.Server.HostEntry',
      entry_method: 'LumioHostEntry',
      replication_assembly: `${GAMEPLAY_SERVER_DIR}/Lumio.GameRuntime.Replication.dll`,
      ecs_assembly: `${GAMEPLAY_SERVER_DIR}/Lumio.GameRuntime.Ecs.dll`,
      registry_assembly: `${GAMEPLAY_SERVER_DIR}/Lumio.Sample.Gameplay.dll`,
      tick_rate_hz: 20,
      kernel_config: {
        maxContexts: 64,
        maxHandles: 16384,
        maxNativeBytes: 268435456,
        maxJobsQueued: 2048,
        maxJobsRunning: 8,
        maxCompletionItems: 16384,
        logMailboxCapacity: 8192,
      },
    },
    store_path: STORE.replaceAll('\\', '/'),
    config_dir: `${GAMEPLAY_SERVER_DIR}/config`,
    // Relative to RUN_CONFIG in .run/, not to the template's Server/Config/Startup/.
    voxel_catalog: '../Server/Assets/Maps/official-catalog.json',
    base_map_path: '../Server/Assets/Maps/sample.voxel',
    checkpoint_seconds: CHECKPOINT_SECONDS,
    logging: { ...base.logging, dir: DS_LOG_DIR.replaceAll('\\', '/'), min_level: 'debug' },
    transport: { ...base.transport, listen_port: PORT },
    host: {
      ...base.host,
      ingress_queue_per_connection: 512,
      max_pending_wire_inputs: 8192,
      max_inputs_per_tick: 256,
    },
  };
  return config;
}

async function startDs(tools, configPath, logFile) {
  // A previous run's DS may still hold the port for a few seconds after its kill;
  // failing to bind is an environment collision, not a verdict.
  const net = await import('node:net');
  const waitPortFree = async () => {
    for (let i = 0; i < 60; i++) {
      const busy = await new Promise(resolve => {
        const probe = net.createConnection({ host: '127.0.0.1', port: PORT });
        probe.once('connect', () => { probe.destroy(); resolve(true); });
        probe.once('error', () => resolve(false));
      });
      if (!busy) return;
      await sleep(1000);
    }
    throw new Error(`port ${PORT} still occupied after 60s`);
  };
  await waitPortFree();
  const dsArgs = buildServerArgs(configPath);
  const ds = tools.startLogged(DS_EXE, dsArgs, { cwd: dirname(DS_EXE), log: logFile });
  const started = Date.now();
  let ready = findDsReady(ds.stdout);
  while (!ready && Date.now() - started < 120_000) {
    tools.assertAlive(ds);
    await sleep(200);
    ready = findDsReady(ds.stdout);
  }
  if (!ready) throw new Error(`DS_READY not observed within 120s (see ${logFile})`);
  return { ds, ready, endpoint: resolveDsEndpoint(ready) };
}

async function runScenarioBot(tools, endpoint, ticket, kernelConfigPath, scenarioName, ticks, label) {
  const botLogDir = join(EVIDENCE, label);
  mkdirSync(botLogDir, { recursive: true });
  const args = buildBotArgs({
    botDll: BOT_DLL,
    endpoint,
    admissionTicket: ticket,
    engineNative: ENGINE_NATIVE,
    kernelConfig: kernelConfigPath,
    // The bot is a client: it loads the C projection, not the DS's S+V tree (split-export/1).
    configDir: CLIENT_TABLES,
    logDir: botLogDir,
    accountFrom: LOGIN,
    accountTo: LOGIN,
    gameplay: GAMEPLAY_CLIENT,
    voxelConfig: VOXEL_CONFIG,
    scenarioDll: SCENARIO_DLL,
    scenarioName,
    ticks,
  });
  const bot = tools.startLogged('dotnet', args, { cwd: dirname(BOT_DLL), log: join(EVIDENCE, `${label}.log`) });
  const deadline = Date.now() + ticks * 20 + 60_000;
  while (Date.now() < deadline) {
    let alive = true;
    try { tools.assertAlive(bot); } catch { alive = false; }
    if (!alive) break;
    await sleep(500);
  }
  let alive = true;
  try { tools.assertAlive(bot); } catch { alive = false; }
  const resultPath = join(botLogDir, 'result.ndjson');
  const result = existsSync(resultPath) ? String(readFileSync(resultPath, 'utf8')) : '';
  if (alive) {
    try { bot.child.kill(); } catch { /* already gone */ }
  }
  return { verdicts: stepVerdictsFromBotResult(result), stdout: String(bot.stdout ?? ''), result };
}

async function main() {
  // Any early exit (mint failure, DS refusal, bot crash) must still kill the DS this run
  // started, or the next run's port-wait trips over a zombie holding 9111.
  const liveChildren = [];
  try {
    await runTour(liveChildren);
  } finally {
    for (const child of liveChildren.reverse()) {
      try { child.kill(); } catch { /* already gone */ }
    }
  }
}

async function runTour(liveChildren) {
  mkdirSync(EVIDENCE, { recursive: true });
  mkdirSync(DS_LOG_DIR, { recursive: true });
  const report = {
    version: 1,
    scope: 'sample-tour-run',
    run: RUN,
    evidence: EVIDENCE,
    startedAt: new Date().toISOString(),
    deviations: [
      `DS on ${PORT} (9110 held by T1 demo, red line)`,
      `ordinary-namespace bot account ${LOGIN} (compose bot-tool key all zeros)`,
      'DS stopped by kill after a post-completion periodic checkpoint; the checkpoint is the persistence artifact',
      'bot is the resident route with --voxel-config (ADR-112 rev2 ix client shape)',
    ],
    steps: [],
  };
  const reportPath = join(EVIDENCE, 'verification.json');
  const write = () => writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const record = (id, status, detail) => {
    process.stdout.write(`${formatStep(id, status, detail)}\n`);
    report.steps.push({ id, status, detail, line: formatStep(id, status, detail) });
    write();
  };

  // One explicit password for the whole tour: run 2 re-logs the SAME account after the
  // restart, and the account client's one-shot generated password is per call.
  const env = {
    ...process.env,
    LUMIO_ENGINE_ROOT: 'C:/Work/LumioGames/LumioGameEngine',
    LUMIO_ACCOUNT_PASSWORD: randomBytes(24).toString('base64url'),
  };
  const tools = await loadProcessTools({ env, repoRoot: ROOT });

  // 01 compiled config export: split-export/1 writes one manifest per end.
  record('01', existsSync(join(SERVER_TABLES, 'manifest.json')) && existsSync(join(CLIENT_TABLES, 'manifest.json')) ? 'READY' : 'BLOCKED_ENV',
    'Server/Config/Tables/manifest.json + Client/Config/Tables/manifest.json');

  // ---------- Run 1: mine through, pick up, checkpoint ----------
  // Ticket first: the run config carries the platform-issued allocation claims.
  const session = await loginAndLaunch({ origin: ORIGIN, loginName: LOGIN, slug: 'sample', env, log: line => process.stdout.write(`${line}\n`) });
  const ticket = session.launch.admissionCredential;
  record('02', ticket ? 'PASS' : 'FAIL', `launch ticket for ${LOGIN} (redacted)`);

  const config = buildRunConfig(session.launch);
  assertRunnableDsConfig(config);
  writeFileSync(RUN_CONFIG, `${JSON.stringify(config, null, 2)}\n`);

  const kernelConfigPath = writeKernelConfigForRun(RUN_CONFIG, join(EVIDENCE, 'kernel-config.json'));
  const { ds, endpoint } = await startDs(tools, RUN_CONFIG, join(EVIDENCE, 'lumio-ds.log'));
  liveChildren.push(ds.child);
  record('03', 'PASS', `endpoint=${endpoint} (fresh store ${STORE})`);
  let dsStdout = () => String(ds.stdout ?? '');

  const bot = await runScenarioBot(tools, endpoint, ticket, kernelConfigPath, MINING_SCENARIO, BOT_TICKS, 'bot-1');
  const dsText1 = () => `${dsStdout()}\n${readLogDir(DS_LOG_DIR)}`;
  const text1 = dsText1();

  const admitted = /session state changed[^\n]*Active/.test(String(readLogDir(join(EVIDENCE, 'bot-1')))) || /host\.admit[^\n]*admitted/.test(text1);
  record('04', admitted ? 'PASS' : 'FAIL', `bot admitted (${bot.verdicts.assertLine ? 'result present' : 'no result'})`);

  // A5 has two halves: the DS restored the base map into a voxel world and shipped the first
  // full SectionFrame delivery to this bot's connection (staged + wrote markers), and the bot's
  // own session went Active over that baseline (scope activated, runtime committed).
  const wroteMatch = text1.match(/admission baseline: wrote (\d+) SectionFrame/);
  const sectionsWritten = wroteMatch ? Number(wroteMatch[1]) : 0;
  const scopeActive = /state=Active/.test(String(readLogDir(join(EVIDENCE, 'bot-1'))));
  const voxelBoot = /runtime\+voxel/.test(dsStdout()) && /opens the world from the configured base map/.test(text1);
  record('05', voxelBoot && sectionsWritten > 0 && scopeActive ? 'PASS' : 'FAIL',
    `base map boot=${voxelBoot}; SectionFrames written=${sectionsWritten}; bot scope Active=${scopeActive}`);

  const selfBound = bot.verdicts.assertLine?.passed === true || !/self_bound/.test(bot.result);
  record('06', selfBound && admitted ? 'PASS' : 'FAIL', `self bound=${selfBound}`);

  const moved = /move_activated/.test(bot.result) === false && /"failed":"[^"]*move_activated/.test(bot.result) === false;
  const appliedOps = count(/outcome=Succeeded\/Applied/g, text1);
  record('07', moved && appliedOps > 0 ? 'PASS' : 'FAIL', `bot move order ok=${moved}; applied ops=${appliedOps}`);

  const chatDs = count(/says:/g, readLogDir(DS_LOG_DIR));
  record('08', chatDs > 0 && !/"failed":"[^"]*chat_activated/.test(bot.result) ? 'PASS' : 'FAIL',
    `chat on DS=${chatDs}; bot chat accepted=${!/"failed":"[^"]*chat_activated/.test(bot.result)}`);

  const stage = count(/mining_stage/g, text1);
  const pre = count(/mining_pre/g, text1);
  record('09', stage >= 1 && pre >= 1 ? 'PASS' : 'FAIL', `mining_stage=${stage} mining_pre=${pre}`);

  const applied = count(/mining_applied/g, text1);
  const veinGone = /vein_dug_through/.test(bot.result) === false;
  record('10', applied >= 1 && veinGone ? 'PASS' : 'FAIL',
    `mining_applied=${applied}; vein left census=${veinGone}`);

  const postAir = /mining_post[^\n]*block=0[^\n]*bound=?/.test(text1) || /mining_post[^\n]*block=0/.test(text1);
  record('11', postAir ? 'PASS' : 'FAIL', `mining_post block=0 observed=${postAir}`);

  const reward = /mining_reward[^\n]*amount=4/.test(text1);
  const dropCollected = /drop_collected/.test(bot.result) === false;
  record('12', reward && dropCollected ? 'PASS' : 'FAIL', `reward amount=4=${reward}; drop_collected=${dropCollected}`);

  const pickupOk = /pickup_activated/.test(bot.result) === false && bot.verdicts.assertLine?.passed === true;
  record('13', pickupOk ? 'PASS' : 'FAIL',
    `bot assertions ${bot.verdicts.assertLine?.passed === true ? 'passed' : `failed: ${bot.verdicts.assertLine?.failed ?? 'no-result'}`}`);

  // Wait for a periodic checkpoint that STRICTLY postdates bot completion: compare
  // generations, not presence — a checkpoint printed before the pickup already satisfies a
  // plain regex and would restore a pre-dig world (observed live: a pre-dig generation was
  // restored, showed 4 veins, and the verify assertion correctly refused it).
  const maxGeneration = text => {
    let max = -1;
    for (const match of String(text ?? '').matchAll(/DS_CHECKPOINT \{"generation":(\d+)\}/g)) {
      max = Math.max(max, Number(match[1]));
    }
    return max;
  };
  const generationAtCompletion = maxGeneration(dsStdout());
  const checkpointDeadline = Date.now() + (CHECKPOINT_SECONDS + 60) * 1000;
  let checkpointed = false;
  while (Date.now() < checkpointDeadline) {
    try { tools.assertAlive(ds); } catch { break; }
    await sleep(1000);
    if (maxGeneration(dsStdout()) > generationAtCompletion) { checkpointed = true; break; }
  }
  const postCompletionGeneration = maxGeneration(dsStdout());
  if (!checkpointed) record('14', 'FAIL', 'no DS_CHECKPOINT observed after bot completion');
  try { ds.child.kill(); } catch { /* already gone */ }
  await sleep(3000);

  // ---------- Run 2: reboot on the same store, verify the world ----------
  if (checkpointed) {
    const second = await startDs(tools, RUN_CONFIG, join(EVIDENCE, 'lumio-ds-restart.log'));
    liveChildren.push(second.ds.child);
    // The restore marker lands in the post-office log file, not stdout; give the boot a
    // moment, then read both. The verify bot below is the real verdict either way.
    await sleep(5000);
    const restoreEvidence = `${String(second.ds.stdout ?? '')}\n${readLogDir(DS_LOG_DIR)}`;
    const restored = /recovered checkpoint outranks base_map_path/.test(restoreEvidence);
    const session2 = await loginAndLaunch({ origin: ORIGIN, loginName: LOGIN, slug: 'sample', env, log: () => {} });
    const verify = await runScenarioBot(tools, second.endpoint, session2.launch.admissionCredential,
      kernelConfigPath, RESTORE_SCENARIO, VERIFY_TICKS, 'bot-verify');
    const restoredWorld = verify.verdicts.assertLine?.passed === true;
    record('14', restored && restoredWorld ? 'PASS' : 'FAIL',
      `restore marker=${restored}; checkpoint gen ${generationAtCompletion}→${postCompletionGeneration}; verify assertions=${verify.verdicts.assertLine
        ? (restoredWorld ? 'passed' : `failed: ${verify.verdicts.assertLine.failed}`) : 'no-result'}`);
    try { second.ds.child.kill(); } catch { /* already gone */ }
    await sleep(2000);
  }

  report.status = report.steps.some(s => s.status === 'FAIL') ? 'FAIL'
    : report.steps.some(s => s.status === 'BLOCKED_ENV') ? 'BLOCKED_ENV' : 'PASS';
  report.finishedAt = new Date().toISOString();
  write();
  process.stdout.write(`VERIFICATION_STATUS=${report.status}\nEVIDENCE_PATH=${EVIDENCE}\n`);
  process.exitCode = report.status === 'PASS' ? 0 : report.status === 'BLOCKED_ENV' ? 2 : 1;
}

main().catch(error => {
  process.stderr.write(`${error?.stack ?? error}\n`);
  process.exitCode = 1;
});

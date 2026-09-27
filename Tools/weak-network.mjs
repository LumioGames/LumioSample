#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { parseLaunchArgs, runLauncher } from './launcher.mjs';
import { loadProcessTools } from './engine-tools.mjs';
import { prepareEngine } from './engine-release.mjs';
import { collectRepoShas, percentile } from './stress-move.mjs';
import { PROFILES, analyzeProfile, completeTickDurations, csv, cutPacketCounts, parseCsv, selectCutConnections, summarizeNagle } from './weak-network-analysis.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const METRIC_FIELDS = ['metric', 'account', 'generation', 'unix_ms', 'sequence', 'applied_sequence', 'authority_tick', 'state', 'value'];

function readMetrics(directory) {
  return existsSync(directory) ? readdirSync(directory).filter((name) => /^metrics-\d+\.csv$/.test(name))
    .flatMap((name) => parseCsv(readFileSync(join(directory, name), 'utf8')).map((row) => ({ ...row, pid: Number(name.match(/\d+/)[0]) }))) : [];
}

function command(program, args) { return execFileSync(program, args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); }
function network(action, port, ...args) { return command('sudo', ['-n', 'bash', join(ROOT, 'Tools/weak-network-netem.sh'), action, String(port), ...args.map(String)]); }
function latestStates(rows) { return new Map(rows.filter((r) => r.metric === 'session.state').map((r) => [r.account, r.state])); }

export async function runWeakNetwork({ profile = 'A', output = join(ROOT, '.tmp/weak-network', profile) } = {}) {
  if (process.platform !== 'linux') throw new Error('This measurement requires Linux tc/netem and iptables.');
  if (!PROFILES[profile]) throw new Error(`Unknown profile ${profile}.`);
  output = resolve(output);
  if (existsSync(join(output, 'run.json'))) throw new Error(`Refusing to overwrite prior measurement: ${output}`);
  mkdirSync(output, { recursive: true });
  const raw = join(output, 'raw'); mkdirSync(raw, { recursive: true });
  const metrics = join(raw, 'metrics'); mkdirSync(metrics, { recursive: true });
  const privateLogs = join(output, 'private'); mkdirSync(privateLogs, { recursive: true });
  const hold = join(privateLogs, 'hold-input'); writeFileSync(hold, 'hold\n');
  const release = prepareEngine({ repoRoot: ROOT, rid: 'linux-x64' });
  const originalTools = await loadProcessTools({ engineRoot: release.dir });
  const audit = join(raw, 'nagle.csv');
  writeFileSync(audit, 'unix_ms,pid,fd,phase,local_port,remote_port,tcp_nodelay\n');
  const shim = join(output, 'nagle-audit.so');
  command('gcc', ['-shared', '-fPIC', '-O2', '-Wall', '-Wextra', '-Werror', '-o', shim, join(ROOT, 'Tools/weak-network-nagle.c'), '-ldl']);
  const childEnv = { ...process.env, LUMIO_WEAKNET_METRICS_DIR: metrics,
    LUMIO_TICK_SAMPLE_DIR: join(raw, 'tick'), LUMIO_BOT_HOLD_INPUT: hold,
    LUMIO_BOT_ADMIT_STAGGER_MS: '250', LD_PRELOAD: shim, LUMIO_WEAKNET_NAGLE_PATH: audit };
  const tools = { ...originalTools,
    command: (exe, args, options) => originalTools.command(exe, args, { ...options, env: childEnv }),
    startLogged: (exe, args, options) => {
      const child = originalTools.startLogged(exe, args, { ...options, env: childEnv });
      // process-tools' command preamble includes the ticket argument; measurement evidence never retains it.
      writeFileSync(options.log, `$ ${basename(exe)} (arguments omitted)\n`);
      return child;
    },
  };
  let port = 0, shaped = false, dropped = [];
  const run = { profile, network: PROFILES[profile], bots: 100, requiredDurationSeconds: 180,
    shas: collectRepoShas(ROOT), engineVersion: release.manifest.version, status: 'RUNNING',
    githubRun: process.env.GITHUB_RUN_ID ?? null, githubAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null };
  writeFileSync(join(raw, 'environment.txt'), `${command('uname', ['-a'])}${command('dotnet', ['--info'])}\n${command('tc', ['-V'])}\n`);
  copyFileSync(join(release.dir, 'manifest.json'), join(raw, 'engine-manifest.json'));
  try {
    const launch = await runLauncher({ ...parseLaunchArgs([], childEnv), root: ROOT, engine: release, processTools: tools,
      bots: 100, fleetPerProcess: 1, staggerMs: 250, timeoutMs: 240_000,
      evidenceDir: privateLogs, scenarioDll: join(ROOT, 'Client/Bots/bin/Debug/net10.0/Lumio.Sample.Bots.dll'),
      residentScenarioName: 'Lumio.Sample.Bots.WeakNetworkMoveScenario', env: childEnv,
      onFleetReady: async ({ endpoint, ds, bots }) => {
        const target = new URL(endpoint);
        if (target.hostname !== '127.0.0.1') throw new Error(`Only an explicit IPv4 loopback DS may be impaired: ${endpoint}`);
        port = Number(target.port); run.dsPort = port; run.dsPid = ds.child.pid;
        const deadline = Date.now() + 120_000;
        let states;
        do {
          states = latestStates(readMetrics(metrics));
          if (states.size === 100 && [...states.values()].every((state) => state === 'Active')) break;
          tools.assertAlive(ds);
          for (const bot of bots) tools.assertAlive(bot);
          if (Date.now() >= deadline) throw new Error(`Only ${[...states.values()].filter((s) => s === 'Active').length}/100 Active Meter observations; missing Meter is not a pass.`);
          await sleep(1000);
        } while (true);
        run.accounts = [...states.keys()].sort();
        const { delay, jitter, loss } = PROFILES[profile];
        // Mark ownership before mutation, so a partial setup also reaches cleanup.
        shaped = true; network('apply', port, delay, jitter, loss);
        writeFileSync(join(raw, 'netem-start.txt'), network('inspect', port));
        run.startMs = Date.now(); run.endMs = run.startMs + 180_000;
        rmSync(hold);
        writeFileSync(join(raw, 'memory.csv'), 'unix_ms,rss_bytes,send_queue_bytes,host_available_bytes,host_load1\n');
        let restored = false;
        while (Date.now() < run.endMs) {
          tools.assertAlive(ds);
          const now = Date.now();
          if (profile === 'cutover' && !run.cutover && now - run.startMs >= 60_000) {
            const accountByPid = Object.fromEntries(readMetrics(metrics).filter((r) => r.metric === 'session.state').map((r) => [r.pid, r.account]));
            const connections = selectCutConnections(command('ss', ['-Htnp', 'state', 'established']), bots.slice(0, 10).map((b) => b.child.pid), accountByPid, port);
            run.cutover = { connections, droppedMs: Date.now(), restoredMs: null };
            dropped = connections; network('drop', port, ...connections.map((c) => c.client_port));
            run.cutover.allDroppedMs = Date.now();
            writeFileSync(join(raw, 'cutover-drop.txt'), network('inspect', port));
          }
          if (run.cutover && !restored && now - run.cutover.allDroppedMs >= 5000) {
            const counters = network('counters', port);
            writeFileSync(join(raw, 'cutover-counters.txt'), counters);
            run.cutover.droppedPackets = cutPacketCounts(counters, dropped);
            network('restore', port, ...dropped.map((c) => c.client_port));
            dropped = []; restored = true; run.cutover.restoredMs = Date.now();
            writeFileSync(join(raw, 'cutover-restore.txt'), network('inspect', port));
            if (run.cutover.droppedPackets.some((c) => c.to_server === 0 || c.to_bot === 0))
              throw new Error('All ten cut connections must have actual dropped packets in both directions.');
          }
          const rss = /^VmRSS:\s+(\d+)\s+kB/m.exec(readFileSync(`/proc/${ds.child.pid}/status`, 'utf8'));
          if (!rss) throw new Error('The running DS has no readable VmRSS sample.');
          const sockets = command('ss', ['-Htn', 'state', 'established', `( sport = :${port} )`]);
          const queued = sockets.split('\n').filter(Boolean).reduce((sum, line) => sum + Number(line.trim().split(/\s+/)[1]), 0);
          const available = /^MemAvailable:\s+(\d+)\s+kB/m.exec(readFileSync('/proc/meminfo', 'utf8'));
          const load1 = Number(readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
          appendFileSync(join(raw, 'memory.csv'), `${now},${Number(rss[1]) * 1024},${queued},${available ? Number(available[1]) * 1024 : ''},${load1}\n`);
          await sleep(run.cutover && !restored ? 100 : 1000);
        }
        writeFileSync(hold, 'hold\n');
        run.actualEndMs = Date.now();
        // Let late cumulative confirmations arrive. Unconfirmed sends remain in the denominator.
        await sleep(10_000);
        writeFileSync(join(raw, 'netem-end.txt'), network('inspect', port));
        // The existing sampler flushes its final partial batch on orderly world shutdown.
        // SIGKILL would silently omit up to sixty seconds of tick samples.
        ds.child.kill('SIGTERM');
        const stopped = await Promise.race([ds.done, sleep(30_000, null, { ref: false })]);
        if (!stopped || stopped.code !== 0) throw new Error('DS did not shut down cleanly and flush its tick samples.');
        run.dsShutdown = 'SIGTERM, exit 0';
      },
    });
    run.launchStatus = launch.status;
    if (launch.status !== 'MEASURED') throw new Error(`Launcher did not complete the measurement window: ${launch.status}`);
    const rows = readMetrics(metrics);
    const analysis = analyzeProfile({ ...run, rows, startMs: run.startMs, endMs: run.endMs });
    run.status = analysis.status;
    analysis.nagle = summarizeNagle(parseCsv(readFileSync(audit, 'utf8')), port);
    if (analysis.nagle.server.sockets < 100 || analysis.nagle.bot.sockets < 100) {
      run.status = 'INCOMPLETE'; analysis.status = 'INCOMPLETE';
    }
    const phases = existsSync(join(raw, 'tick')) ? readdirSync(join(raw, 'tick')).filter((name) => name.startsWith('tick-phase-samples.'))
      .flatMap((name) => parseCsv(readFileSync(join(raw, 'tick', name), 'utf8'))) : [];
    const observedTicks = rows.filter((r) => r.metric === 'server.update' && r.authority_tick !== '' && +r.unix_ms >= run.startMs && +r.unix_ms <= run.endMs).map((r) => Number(r.authority_tick));
    const minTick = observedTicks.reduce((min, tick) => Math.min(min, tick), Infinity);
    const maxTick = observedTicks.reduce((max, tick) => Math.max(max, tick), -Infinity);
    const ticks = completeTickDurations(phases, minTick, maxTick);
    analysis.server = { tickP99Ms: percentile([...ticks.values()], 99), tickSamples: ticks.size, minTick, maxTick,
      clock: 'native-core-clock_now', memory: 'raw/memory.csv' };
    if (ticks.size === 0 || ![...ticks.values()].some((ms) => ms > 0)) { run.status = 'INCOMPLETE'; analysis.status = 'INCOMPLETE'; }
    writeFileSync(join(raw, 'timing.csv'), csv([...ticks].map(([tick, frame_ms]) => ({ tick, frame_ms, clock: 'native-core-clock_now' })), ['tick', 'frame_ms', 'clock']));
    writeFileSync(join(raw, 'input-confirmations.csv'), csv(rows.filter((r) => r.metric === 'input.confirmed'), METRIC_FIELDS));
    writeFileSync(join(raw, 'per-bot.csv'), csv(analysis.perBot, Object.keys(analysis.perBot[0])));
    writeFileSync(join(raw, 'activity.csv'), csv(analysis.activity, Object.keys(analysis.activity[0])));
    writeFileSync(join(raw, 'stalls.csv'), csv(analysis.stalls, ['account', 'from_ms', 'to_ms', 'gap_ms', 'stalled_ms', 'right_censored']));
    if (run.cutover) writeFileSync(join(raw, 'recovery.csv'), csv(analysis.recovery, ['account', 'pid', 'client_port', 'ds_port', 'remained_active', 'recovered_before_restore', 'active_ms', 'first_update_ms', 'reconnected_within_10s', 'update_within_10s']));
    writeFileSync(join(output, 'summary.json'), `${JSON.stringify(analysis, null, 2)}\n`);
    return run;
  } catch (error) {
    run.status = 'INCOMPLETE'; run.error = error.message;
    throw error;
  } finally {
    if (dropped.length) { try { network('restore', port, ...dropped.map((c) => c.client_port)); } catch (error) { run.cleanupError = error.message; } }
    if (shaped) { try { network('remove', port); } catch (error) { run.cleanupError = error.message; } }
    writeFileSync(join(output, 'run.json'), `${JSON.stringify(run, null, 2)}\n`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const profile = process.argv[2] ?? 'A';
  try {
    const result = await runWeakNetwork({ profile, output: process.argv[3] });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.status !== 'MEASURED') process.exitCode = 1;
  } catch (error) { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; }
}

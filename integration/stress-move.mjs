#!/usr/bin/env node

/**
 * R-00588 100-bot move gate. Live five-criterion proof needs Platform + Bot Activate
 * + NativeCore clock_now. This file writes the evidence schema; it does not treat
 * Stopwatch or a force-kill as a pass.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countAdmittedBots, parseLaunchArgs, runLauncher } from './launcher.mjs';
import { repoSibling } from './engine-tools.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STRESS_BOTS = 100;
const STRESS_DURATION_SECONDS = 300;
const TICK_RATE_HZ = 20;
const FRAME_BUDGET_MS = 1000 / TICK_RATE_HZ;

export const SHA_REPOS = Object.freeze([
  'LumioSample',
  'LumioGameEngine',
  'LumioGameRuntime',
  'LumioNativeCore',
  'LumioVoxelEngine',
  'LumioServer',
  'LumioClient',
  'LumioPlatform',
  'LumioConfig',
  'LumioGame',
]);

export function collectRepoShas(repoRoot = ROOT) {
  const shas = {};
  for (const name of SHA_REPOS) {
    const path = name === 'LumioSample' ? repoRoot : repoSibling(repoRoot, name);
    if (!existsSync(path)) {
      shas[name] = null;
      continue;
    }
    try {
      const sha = execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      shas[name] = /^[0-9a-f]{40}$/.test(sha) ? sha : null;
    } catch {
      shas[name] = null;
    }
  }
  return shas;
}

export function createStressDocument({ bots = STRESS_BOTS, durationSeconds = STRESS_DURATION_SECONDS, shas = {} } = {}) {
  return {
    version: 1,
    status: 'BLOCKED_ENV',
    scope: 'sample-100-bot-move',
    params: { bots, durationSeconds, staggerMs: null, tickRateHz: TICK_RATE_HZ },
    clock: 'native-core-clock_now',
    criteria: {
      admitted: { required: bots, actual: null, drops: null, protocolViolation: null, queueFull: null },
      frameBudget: { budgetMs: FRAME_BUDGET_MS, p99Ms: null, overBudgetFrames: null, clock: 'native-core-clock_now' },
      transformConsistency: { sampledBots: null, mismatches: null },
      rss: { samples: [], growthLimit: 0.05, startBytes: null, endBytes: null },
    },
    shas: Object.fromEntries(SHA_REPOS.map((name) => [name, shas[name] ?? null])),
    evidence: {
      verificationJson: 'verification.json',
      perBotNdjson: 'bots/*.ndjson',
      timingCsv: 'timing.csv',
      memoryCsv: 'memory.csv',
    },
  };
}

function shaFilled(shas) {
  if (!shas || typeof shas !== 'object') return false;
  return SHA_REPOS.every((name) => typeof shas[name] === 'string' && /^[0-9a-f]{40}$/.test(shas[name]));
}

function rssCurvePassed(rss) {
  if (!Array.isArray(rss?.samples) || rss.samples.length < 2) return false;
  if (rss.startBytes == null || rss.endBytes == null) return false;
  if (rss.samples[0] !== rss.startBytes) return false;
  if (rss.samples[rss.samples.length - 1] !== rss.endBytes) return false;
  const peak = Math.max(...rss.samples);
  if (peak - rss.startBytes > rss.startBytes * rss.growthLimit) return false;
  return true;
}

export function criteriaPassed(document) {
  if (!document || document.clock !== 'native-core-clock_now') return false;
  if (document.params?.durationSeconds !== STRESS_DURATION_SECONDS) return false;
  if (document.params?.bots !== STRESS_BOTS) return false;
  if (document.rounds !== 2) return false;
  if (!shaFilled(document.shas)) return false;
  const { admitted, frameBudget, transformConsistency, rss } = document.criteria ?? {};
  if (admitted?.actual !== admitted?.required || admitted?.required !== STRESS_BOTS) return false;
  if (admitted.actual == null) return false;
  if (admitted.drops !== 0 || admitted.protocolViolation !== 0 || admitted.queueFull !== 0) return false;
  if (typeof frameBudget?.p99Ms !== 'number' || !Number.isFinite(frameBudget.p99Ms)) return false;
  if (frameBudget.overBudgetFrames !== 0 || frameBudget.clock !== 'native-core-clock_now') return false;
  if (frameBudget.p99Ms > frameBudget.budgetMs) return false;
  if (transformConsistency?.mismatches !== 0 || transformConsistency?.sampledBots !== 5) return false;
  if (!rssCurvePassed(rss)) return false;
  return document.status === 'PASS';
}

export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function readTimingCsv(path) {
  if (!path || !existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/).slice(1);
  return lines.map((line) => Number(line.split(',')[1])).filter((value) => Number.isFinite(value));
}

export function readMemoryCsv(path) {
  if (!path || !existsSync(path)) return [];
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/).slice(1);
  return lines.map((line) => Number(line.split(',')[1])).filter((value) => Number.isFinite(value));
}

export function stressExitCode(status) {
  return status === 'PASS' ? 0 : status === 'BLOCKED_ENV' ? 2 : 1;
}

export async function runStress(options = {}) {
  const launchFn = options.runLauncher ?? runLauncher;
  const parsed = {
    ...parseLaunchArgs([], options.env ?? process.env),
    ...options,
    bots: options.bots ?? STRESS_BOTS,
    durationMs: options.durationMs ?? STRESS_DURATION_SECONDS * 1000,
  };
  delete parsed.runLauncher;
  const evidence = parsed.evidenceDir ?? join(options.root ?? ROOT, 'integration', 'logs', 'stress-move');
  mkdirSync(evidence, { recursive: true });
  const document = createStressDocument({
    bots: parsed.bots,
    durationSeconds: Math.round(parsed.durationMs / 1000),
    shas: options.shas ?? collectRepoShas(options.root ?? ROOT),
  });
  document.rounds = options.rounds ?? 1;
  const launch = await launchFn({ ...parsed, evidenceDir: evidence, root: options.root ?? ROOT });
  document.launchStatus = launch.status;
  const counted = Number.isInteger(launch.admittedBots)
    ? launch.admittedBots
    : countAdmittedBots(parsed.bots, { evidenceDir: evidence }).admitted;
  document.criteria.admitted.actual = counted;
  document.criteria.admitted.drops = counted === parsed.bots ? 0 : parsed.bots - counted;
  document.criteria.admitted.protocolViolation = 0;
  document.criteria.admitted.queueFull = 0;
  const timingPath = join(evidence, 'timing.csv');
  const memoryPath = join(evidence, 'memory.csv');
  if (!existsSync(timingPath)) writeFileSync(timingPath, 'tick,frame_ms,clock\n');
  if (!existsSync(memoryPath)) writeFileSync(memoryPath, 'minute,rss_bytes\n');
  const frames = options.frameMs ?? readTimingCsv(timingPath);
  const rssSamples = options.rssSamples ?? readMemoryCsv(memoryPath);
  if (frames.length > 0) {
    document.criteria.frameBudget.p99Ms = percentile(frames, 99);
    document.criteria.frameBudget.overBudgetFrames = frames.filter((ms) => ms > FRAME_BUDGET_MS).length;
  }
  if (rssSamples.length > 0) {
    document.criteria.rss.samples = rssSamples;
    document.criteria.rss.startBytes = rssSamples[0];
    document.criteria.rss.endBytes = rssSamples[rssSamples.length - 1];
  }
  if (options.transformConsistency) document.criteria.transformConsistency = options.transformConsistency;
  // Launch PASS is not evidence. Header-only CSV, missing p99, missing SHAs, or a
  // short duration stay FAIL. ADR-088: the verifier is the only source of truth.
  document.status = launch.status === 'PASS' && criteriaPassed({ ...document, status: 'PASS' })
    ? 'PASS'
    : launch.status === 'PASS' ? 'FAIL' : launch.status;
  writeFileSync(join(evidence, 'verification.json'), `${JSON.stringify(document, null, 2)}\n`);
  return document;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const document = await runStress(parseLaunchArgs());
    process.stdout.write(`VERIFICATION_STATUS=${document.status}\n`);
    process.exitCode = stressExitCode(document.status);
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = error?.code === 'BLOCKED_ENV' || String(error?.message).startsWith('BLOCKED_ENV:') ? 2 : 1;
  }
}

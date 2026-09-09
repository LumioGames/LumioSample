#!/usr/bin/env node

/**
 * R-00588 100-bot move gate. Live five-criterion proof needs Platform + Bot Activate
 * + NativeCore clock_now. This file writes the evidence schema; it does not treat
 * Stopwatch or a force-kill as a pass.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLaunchArgs, runLauncher } from './launcher.mjs';

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

export function criteriaPassed(document) {
  if (!document || document.clock !== 'native-core-clock_now') return false;
  const { admitted, frameBudget, transformConsistency, rss } = document.criteria ?? {};
  if (admitted?.actual !== admitted?.required || admitted?.required !== STRESS_BOTS) return false;
  if (admitted.drops !== 0 || admitted.protocolViolation !== 0 || admitted.queueFull !== 0) return false;
  if (frameBudget?.overBudgetFrames !== 0 || frameBudget?.clock !== 'native-core-clock_now') return false;
  if (transformConsistency?.mismatches !== 0 || !transformConsistency?.sampledBots) return false;
  if (!Array.isArray(rss?.samples) || rss.samples.length < 2) return false;
  if (rss.startBytes == null || rss.endBytes == null) return false;
  if (rss.endBytes - rss.startBytes > rss.startBytes * rss.growthLimit) return false;
  return document.status === 'PASS';
}

export async function runStress(options = {}) {
  const parsed = {
    ...parseLaunchArgs([], options.env ?? process.env),
    ...options,
    bots: options.bots ?? STRESS_BOTS,
    durationMs: options.durationMs ?? STRESS_DURATION_SECONDS * 1000,
  };
  const evidence = parsed.evidenceDir ?? join(options.root ?? ROOT, 'integration', 'logs', 'stress-move');
  mkdirSync(evidence, { recursive: true });
  const document = createStressDocument({
    bots: parsed.bots,
    durationSeconds: Math.round(parsed.durationMs / 1000),
    shas: options.shas,
  });
  const launch = await runLauncher({ ...parsed, evidenceDir: evidence, root: options.root ?? ROOT });
  document.launchStatus = launch.status;
  document.status = launch.status === 'PASS' && criteriaPassed({ ...document, status: 'PASS' }) ? 'PASS' : launch.status;
  writeFileSync(join(evidence, 'verification.json'), `${JSON.stringify(document, null, 2)}\n`);
  writeFileSync(join(evidence, 'timing.csv'), 'tick,frame_ms,clock\n');
  writeFileSync(join(evidence, 'memory.csv'), 'minute,rss_bytes\n');
  return document;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const document = await runStress(parseLaunchArgs());
    process.stdout.write(`VERIFICATION_STATUS=${document.status}\n`);
    process.exitCode = document.status === 'PASS' ? 0 : document.status === 'BLOCKED_ENV' ? 2 : 1;
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = error?.code === 'BLOCKED_ENV' || String(error?.message).startsWith('BLOCKED_ENV:') ? 2 : 1;
  }
}

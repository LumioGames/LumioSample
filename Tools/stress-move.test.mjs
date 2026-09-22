import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { SHA_REPOS, collectRepoShas, createStressDocument, criteriaPassed, runStress, stressExitCode } from './stress-move.mjs';

const SAMPLE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function filledShas() {
  return Object.fromEntries(SHA_REPOS.map((name, index) => [name, 'a'.repeat(39) + String(index)]));
}

function passingCriteria(document) {
  document.status = 'PASS';
  document.rounds = 2;
  document.shas = filledShas();
  document.params.durationSeconds = 300;
  document.criteria.admitted = { required: 100, actual: 100, drops: 0, protocolViolation: 0, queueFull: 0 };
  document.criteria.frameBudget = { budgetMs: 50, p99Ms: 10, overBudgetFrames: 0, clock: 'native-core-clock_now' };
  document.criteria.transformConsistency = { sampledBots: 5, mismatches: 0 };
  document.criteria.rss = { samples: [100, 101, 102], growthLimit: 0.05, startBytes: 100, endBytes: 102 };
  return document;
}

test('stress evidence schema names ten repos and the NativeCore clock', () => {
  const document = createStressDocument();
  assert.equal(document.params.bots, 100);
  assert.equal(document.params.durationSeconds, 300);
  assert.equal(document.clock, 'native-core-clock_now');
  assert.equal(document.criteria.frameBudget.budgetMs, 50);
  assert.equal(SHA_REPOS.length, 10);
  assert.equal(Object.keys(document.shas).length, 10);
  assert.equal(criteriaPassed(document), false);
});

test('criteriaPassed rejects Stopwatch-shaped evidence and unused tickets', () => {
  const document = createStressDocument();
  document.status = 'PASS';
  document.clock = 'stopwatch';
  document.criteria.admitted = { required: 100, actual: 100, drops: 0, protocolViolation: 0, queueFull: 0 };
  document.criteria.frameBudget = { budgetMs: 50, p99Ms: 10, overBudgetFrames: 0, clock: 'stopwatch' };
  document.criteria.transformConsistency = { sampledBots: 10, mismatches: 0 };
  document.criteria.rss = { samples: [1, 1], growthLimit: 0.05, startBytes: 100, endBytes: 100 };
  assert.equal(criteriaPassed(document), false);
});

test('live stress without Platform stays BLOCKED_ENV', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-stress-'));
  const document = await runStress({
    root: isolated,
    env: {},
    evidenceDir: join(isolated, 'evidence'),
    log() {},
  });
  assert.equal(document.status, 'BLOCKED_ENV');
  assert.equal(criteriaPassed(document), false);
});

test('criteriaPassed rejects short duration, missing p99, missing SHA, and one round', () => {
  const short = passingCriteria(createStressDocument());
  short.params.durationSeconds = 1;
  assert.equal(criteriaPassed(short), false);

  const noP99 = passingCriteria(createStressDocument());
  noP99.criteria.frameBudget.p99Ms = null;
  assert.equal(criteriaPassed(noP99), false);

  const noSha = passingCriteria(createStressDocument());
  noSha.shas.LumioSample = null;
  assert.equal(criteriaPassed(noSha), false);

  const oneRound = passingCriteria(createStressDocument());
  oneRound.rounds = 1;
  assert.equal(criteriaPassed(oneRound), false);

  const oneBot = passingCriteria(createStressDocument());
  oneBot.criteria.transformConsistency.sampledBots = 1;
  assert.equal(criteriaPassed(oneBot), false);

  const headerOnly = passingCriteria(createStressDocument());
  headerOnly.criteria.rss.samples = [];
  assert.equal(criteriaPassed(headerOnly), false);

  const mismatch = passingCriteria(createStressDocument());
  mismatch.criteria.admitted.actual = 99;
  assert.equal(criteriaPassed(mismatch), false);

  assert.equal(criteriaPassed(passingCriteria(createStressDocument())), true);
});

test('collectRepoShas skips missing siblings without dumping git fatal', () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-sha-root-'));
  const shas = collectRepoShas(isolated);
  assert.equal(Object.keys(shas).length, 10);
  for (const name of SHA_REPOS) {
    assert.equal(shas[name], null);
  }
});

test('collectRepoShas records LumioSample HEAD from a real checkout', () => {
  const shas = collectRepoShas(SAMPLE_ROOT);
  assert.match(shas.LumioSample, /^[0-9a-f]{40}$/);
});

test('runStress does not PASS when launcher is PASS but criteria stay null', async () => {
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-stress-'));
  const document = await runStress({
    root: isolated,
    env: {},
    evidenceDir: join(isolated, 'evidence'),
    log() {},
    async runLauncher() {
      return { status: 'PASS', admittedBots: 0 };
    },
  });
  assert.equal(document.launchStatus, 'PASS');
  assert.equal(document.criteria.admitted.actual, 0);
  assert.notEqual(document.status, 'PASS');
  assert.equal(criteriaPassed(document), false);
  assert.notEqual(stressExitCode(document.status), 0);
});

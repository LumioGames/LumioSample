import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SHA_REPOS, createStressDocument, criteriaPassed, runStress } from './stress-move.mjs';

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

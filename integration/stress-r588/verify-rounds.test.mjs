import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  classifyViolations, minuteResample, roundAdmissionEvidence, roundFailures, roundsDocumentPassed,
  rssGrowthVerdict, steadyRssWindow,
} from './verify-rounds.mjs';

const PROTOCOL_LINE = 'level=WARN target=host.connection_close msg="closed conn=conn-x account=acct-y reason=protocol_violation trigger=peer_reset code=1008"';
const QUEUE_LINE = 'level=ERROR target=net msg="inbound_queue_full depth=1024"';

function makeRound(dir) {
  return {
    dir,
    stress: { criteria: { admitted: { required: 100, actual: 100 } }, launchStatus: 'PASS' },
    admission: roundAdmissionEvidence(dir),
    fleet: { botsWithMoves: 99, spanSeconds: 290, fleetPassed: 99 },
    tick: { error: 'test: tick evidence intentionally absent' },
    observers: { error: 'test: observers intentionally absent' },
    rss: {},
  };
}

const line = (text) => ({ path: 'fixture/x.log', line: text });

test('classifyViolations counts queue_full and protocol_violation lines separately (the v0.0.2 defect: both were violations.length)', () => {
  const violations = [
    line('level=WARN target=host.connection_close msg="closed conn=conn-a account=acct-b reason=protocol_violation trigger=peer_reset last_inbound=pong code=1008"'),
    line('level=WARN target=host.connection_close msg="closed conn=conn-c reason=protocol_violation code=1008"'),
    line('level=WARN target=host.connection_close msg="closed conn=conn-d reason=protocol_violation code=1008"'),
    line('level=ERROR target=net msg="inbound_queue_full depth=1024"'),
    line('level=ERROR target=net msg="outbound_queue_full depth=512"'),
  ];
  assert.deepEqual(classifyViolations(violations), { protocolViolation: 3, queueFull: 2 });
});

test('classifyViolations positive/negative for the v0.0.2 shape: 48 protocol lines, zero queue lines', () => {
  const violations = Array.from({ length: 48 }, () =>
    line('target=host.connection_close msg="closed reason=protocol_violation trigger=peer_reset last_inbound=pong close_frame=failed observer_id=5 code=1008"'));
  assert.deepEqual(classifyViolations(violations), { protocolViolation: 48, queueFull: 0 });
  // 反例:一行 queue_full 都没有时 queueFull 必须是 0,绝不能再跟着总行数走。
  assert.notEqual(classifyViolations(violations).queueFull, violations.length);
});

test('classifyViolations negative case: no violation lines at all', () => {
  assert.deepEqual(classifyViolations([]), { protocolViolation: 0, queueFull: 0 });
  assert.deepEqual(classifyViolations([line('level=INFO target=host.admit msg="pending"'), line('level=INFO unrelated')]),
    { protocolViolation: 0, queueFull: 0 });
});

test('classifyViolations counts a line carrying both classes into both, and accepts raw strings', () => {
  const mixed = ['reason=protocol_violation after inbound_queue_full'];
  assert.deepEqual(classifyViolations(mixed), { protocolViolation: 1, queueFull: 1 });
});

test('steadyRssWindow anchors at the observer firstTick and minuteResample takes one sample per minute', () => {
  // 20 Hz:每 1200 tick 一分钟。准入期 tick 0-1200 涨到 130,稳态窗 tick 1200 起。
  const memory = [];
  for (let tick = 0; tick <= 7200; tick += 100) {
    memory.push([tick, tick < 1200 ? 100 + Math.round(tick / 40) : 100 + (tick % 300)]);
  }
  const window = steadyRssWindow(memory, 1200);
  assert.equal(window.basis, 'observer-first-tick');
  assert.equal(window.fromTick, 1200);
  const samples = minuteResample(memory, window);
  assert.equal(samples.length, 6); // 5 分钟窗口,每分钟一个样本
  assert.equal(samples[0][0], 1200);
  assert.equal(samples[samples.length - 1][0], 7200);
});

test('steadyRssWindow without observers (fleet never fully admitted) has no basis', () => {
  const window = steadyRssWindow([[0, 1], [100, 1]], null);
  assert.equal(window.basis, null);
  assert.deepEqual(minuteResample([[0, 1], [100, 1]], window), []);
});

test('rssGrowthVerdict applies the AC5 formula end - start <= 5% of start', () => {
  const pass = rssGrowthVerdict([[0, 100], [1200, 102], [2400, 104], [3600, 101], [4800, 103], [6000, 102]]);
  assert.equal(pass.pass, true);
  assert.ok(Math.abs(pass.endGrowthRatio - 0.02) < 1e-9);
  const fail = rssGrowthVerdict([[0, 100], [1200, 104], [2400, 106], [3600, 107], [4800, 108], [6000, 108]]);
  assert.equal(fail.pass, false); // +8% 净增长
  assert.equal(rssGrowthVerdict([[0, 100]]).pass, false); // 样本不足 = 没测到,不放行
});

test('rssGrowthVerdict keeps the peak as evidence, not as the verdict (the two readings of AC5)', () => {
  // 先涨后跌:峰值 +8%、末值 +2%。原文括号「末值 − 首值 ≤ 首值 5%」下 PASS;
  // 「无单调增长」若按峰值读则会 FAIL——两个数字都留在证据里,口径张力上报 TD。
  const verdict = rssGrowthVerdict([[0, 100], [1200, 108], [2400, 106], [3600, 104], [4800, 102], [6000, 102]]);
  assert.equal(verdict.pass, true);
  assert.ok(Math.abs(verdict.peakGrowthRatio - 0.08) < 1e-9);
  assert.ok(Math.abs(verdict.endGrowthRatio - 0.02) < 1e-9);
});

test('roundsDocumentPassed gates on the AC5 basis field the document actually carries', () => {
  const sha = 'a'.repeat(40);
  const base = () => ({
    status: 'PASS',
    rounds: 2,
    clock: 'native-core-clock_now',
    params: { bots: 100, durationSeconds: 300 },
    shas: { r1: sha, r2: sha },
    criteria: {
      admitted: { required: 100, actual: 100, drops: 0, protocolViolation: 0, queueFull: 0 },
      frameBudget: { budgetMs: 50, p99Ms: 9.3, overBudgetFrames: 0, clock: 'native-core-clock_now' },
      transformConsistency: { sampledBots: 5, mismatches: 0 },
      rss: {
        samples: [100, 101, 102, 101, 102, 101], growthLimit: 0.05, startBytes: 100, endBytes: 101,
        basis: 'observer-first-tick',
      },
    },
  });
  assert.equal(roundsDocumentPassed(base()), true, 'steady window + end-growth within 5% passes');
  const noWindow = base();
  noWindow.criteria.rss = { samples: [], growthLimit: 0.05, startBytes: null, endBytes: null, basis: null };
  assert.equal(roundsDocumentPassed(noWindow), false, 'no steady window (fleet never fully admitted) can never pass');
  const netGrowth = base();
  netGrowth.criteria.rss.samples = [100, 104, 106, 107, 108, 108];
  netGrowth.criteria.rss.endBytes = 108;
  assert.equal(roundsDocumentPassed(netGrowth), false, 'end - start > 5% fails the AC5 formula');
  const shortWindow = base();
  shortWindow.criteria.rss.samples = [100, 101];
  assert.equal(roundsDocumentPassed(shortWindow), false, 'fewer than five minute samples is not an established window');
  const miscategorized = base();
  miscategorized.criteria.admitted.queueFull = 48;
  assert.equal(roundsDocumentPassed(miscategorized), false, 'any queueFull line fails admission');
});

test('P1: an excerpt-only round (no raw DS logs in a cloned repo) counts violations from ds-admission-close-excerpt.log', () => {
  const round = mkdtempSync(join(tmpdir(), 'lumio-r588-excerpt-only-'));
  mkdirSync(join(round, 'launcher'), { recursive: true });
  writeFileSync(join(round, 'ds-admission-close-excerpt.log'), [
    '# R-00588 DS admission/close excerpt (auto-generated by run-round.mjs)',
    '# generatedAt: 2026-09-28T00:00:00.000Z',
    PROTOCOL_LINE,
    PROTOCOL_LINE,
    QUEUE_LINE,
    'level=WARN target=host.expire msg="deferred code=runtime_query_pending due_ms=326864"',
  ].join('\n'));
  const admission = roundAdmissionEvidence(round);
  assert.equal(admission.violationSources.length, 1);
  assert.equal(admission.excerptUsed, true);
  assert.equal(admission.rawDsPresent, false);
  assert.deepEqual(admission.violationClasses, { protocolViolation: 2, queueFull: 1 });
  // 摘录头部注释(# 行)即使带上违规词也不计入——但上面头部并无违规词,再显式验证一条。
  const round2 = mkdtempSync(join(tmpdir(), 'lumio-r588-excerpt-hdr-'));
  mkdirSync(join(round2, 'launcher'), { recursive: true });
  writeFileSync(join(round2, 'ds-admission-close-excerpt.log'), `# header mentions queue_full in a comment\n${PROTOCOL_LINE}\n`);
  assert.deepEqual(roundAdmissionEvidence(round2).violationClasses, { protocolViolation: 1, queueFull: 0 });
});

test('P1: a round with no admissible violation source at all FAILs — absence of logs is not absence of violations', () => {
  const round = mkdtempSync(join(tmpdir(), 'lumio-r588-nosource-'));
  mkdirSync(join(round, 'launcher'), { recursive: true });
  const admission = roundAdmissionEvidence(round);
  assert.equal(admission.violationSources.length, 0);
  assert.equal(admission.violations.length, 0);
  const failures = roundFailures('round-1', { ...makeRound(round), admission });
  assert.ok(failures.some((failure) => failure.includes('no admissible violation source') && failure.includes('absence of logs is not absence of violations')),
    `expected the fail-closed failure, got: ${failures.join(' | ')}`);
});

test('P1: when the raw DS log and the excerpt are both present the excerpt is skipped — no double counting', () => {
  const round = mkdtempSync(join(tmpdir(), 'lumio-r588-both-sources-'));
  mkdirSync(join(round, 'launcher'), { recursive: true });
  writeFileSync(join(round, 'launcher', 'lumio-ds.log'), `${PROTOCOL_LINE}\n${PROTOCOL_LINE}\n`);
  writeFileSync(join(round, 'ds-admission-close-excerpt.log'), `${PROTOCOL_LINE}\n${PROTOCOL_LINE}\n`);
  const admission = roundAdmissionEvidence(round);
  assert.equal(admission.rawDsPresent, true);
  assert.equal(admission.excerptUsed, false);
  assert.equal(admission.violationClasses.protocolViolation, 2, 'the excerpt copy of the same lines must not add to the count');
  // 有源在场时不触发 fail-closed。
  const failures = roundFailures('round-1', makeRound(round));
  assert.ok(!failures.some((failure) => failure.includes('no admissible violation source')));
});

test('P1: a launcher-direct log alone is an admissible source (no fail-closed, excerpt unnecessary)', () => {
  const round = mkdtempSync(join(tmpdir(), 'lumio-r588-direct-log-'));
  mkdirSync(join(round, 'launcher'), { recursive: true });
  writeFileSync(join(round, 'launcher', 'anything.log'), `${QUEUE_LINE}\n`);
  const admission = roundAdmissionEvidence(round);
  assert.equal(admission.violationSources.length, 1);
  assert.deepEqual(admission.violationClasses, { protocolViolation: 0, queueFull: 1 });
  const failures = roundFailures('round-1', makeRound(round));
  assert.ok(!failures.some((failure) => failure.includes('no admissible violation source')));
});

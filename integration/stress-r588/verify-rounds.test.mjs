import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyViolations, minuteResample, roundsDocumentPassed, rssGrowthVerdict, steadyRssWindow } from './verify-rounds.mjs';

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

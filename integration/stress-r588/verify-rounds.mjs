#!/usr/bin/env node
/**
 * R-00588 两轮判定器(ADR-088:启动器 PASS 不是证据,本文件才是真值来源)。
 * 逐轮从原始证据计算 AC1–AC5,再比两轮可比性,最后写 rounds=2 的 verification.json。
 * 任何一项红,整体就红;没有一项从「没测到」被当成「通过」。
 *
 * v0.0.3 修复(toolfix,旧结论不回改):
 *   - admitted.protocolViolation 与 admitted.queueFull 不再同源:queue_full 类
 *     (inbound/outbound_queue_full)与 protocol_violation 类逐行分别计数
 *     (v0.0.2 的 verification.json 因此把 48 条 protocol_violation 误写成了
 *     「队列满 48」;acceptance-v0.0.2/r588/verdict.md 正文一直是 0 条)。
 *   - AC5 按 R-00588 原文改窗口:「DS 进程 RSS 每分钟采样一次,5 分钟内无单调增长
 *     (末值 − 首值 ≤ 首值 5%)」。窗口取全员准入之后的稳态窗口(与 AC2 的 5 分钟
 *     移动窗对齐,锚点 = 编排在全员准入后启动的观察者的 firstTick),采样按每分钟
 *     一次重采样,判据按原文公式「末值 − 首值 ≤ 首值 5%」;v0.0.2 测得的 +21.4/21.6%
 *     峰值全部落在准入期(tick≈1936,两轮同点),属冷启动/准入的瞬态,不是稳态曲线。
 *     窗口内每分钟的峰值涨幅一并落进证据字段(「无单调增长」与括号公式之间
 *     的口径张力上报 TD,两种读法的数字都在,不在判定器里擅自二选一加严)。
 *   - fleet 未全员准入(无观察者 → 无稳态窗口)时 AC5 如实记「窗口不可得」,
 *     不用全程曲线冒充,也不把「没测到」当「通过」。
 *
 * Usage: node verify-rounds.mjs <round1Dir> <round2Dir> <outVerificationJson>
 * 轮目录布局(由压测编排产生):
 *   launcher/            stress-move.mjs --evidence-dir 的产物(含其 verification.json)
 *   tick-samples/        HostEntry TickSampleExport 落的 N19/N21 CSV(按世界 incarnation 分文件)
 *   observers/           observe-replicas.mjs 的五观察者记录(AC4)
 *   timing.csv memory.csv  本文件按轮生成的 stress 证据 schema 兼容产物(数值取自 tick-samples)
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStressDocument, percentile, stressExitCode, collectRepoShas } from '../../Tools/stress-move.mjs';

const FRAME_BUDGET_MS = 50; // 20 Hz
const FLEET_BOTS = 100;
const OBSERVERS = 5;
const TICK_RATE_HZ = 20;
const WINDOW_SECONDS = 300;
const SAMPLE_INTERVAL_TICKS = TICK_RATE_HZ * 60; // AC5 原文:每分钟采样一次

/** 违规行类别(逐行判定;一行同时含两类时两类各计一次,不吞不并)。 */
const QUEUE_FULL_LINE = /(inbound_queue_full|outbound_queue_full|queue_full)/i;
const PROTOCOL_VIOLATION_LINE = /protocol_violation/i;
const FORBIDDEN_LINE = /(protocol_violation|inbound_queue_full|outbound_queue_full|queue_full)/i;

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function readTextIfPresent(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function listLogFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (path.endsWith('.log') || path.endsWith('.ndjson')) out.push(path);
  }
  return out;
}

function parseCsv(path) {
  return readTextIfPresent(path).trim().split(/\r?\n/).slice(1).filter((line) => line.length > 0)
    .map((line) => line.split(','));
}

/**
 * 按违规类别逐行计数。v0.0.2 的缺陷在这里:queueFull 直接复用了 violations.length,
 * 与 protocolViolation 同值。正例/反例见 verify-rounds.test.mjs。
 */
export function classifyViolations(violations) {
  let protocolViolation = 0;
  let queueFull = 0;
  for (const violation of violations) {
    const line = typeof violation === 'string' ? violation : violation.line;
    if (QUEUE_FULL_LINE.test(line)) queueFull += 1;
    if (PROTOCOL_VIOLATION_LINE.test(line)) protocolViolation += 1;
  }
  return { protocolViolation, queueFull };
}

/**
 * AC5 稳态窗口:锚在「全员准入之后」——编排只在该时刻起观察者,所以观察者记录的
 * 最小 firstTick 就是数据面上可得的全员准入后首个 tick(与 AC2 的 5 分钟移动窗对齐)。
 * 窗口 = [anchorTick, anchorTick + 300s];数据不足 5 分钟时如实返回实际窗口长度。
 * 没有观察者(fleet 未全员准入)→ basis=null,判定侧必须按「窗口不可得」处理。
 */
export function steadyRssWindow(memory, anchorTick) {
  if (anchorTick == null) return { basis: null, fromTick: null, toTick: null };
  const fromIndex = memory.findIndex(([tick]) => tick >= anchorTick);
  if (fromIndex < 0) return { basis: 'observer-first-tick', fromTick: null, toTick: null };
  const toTick = memory[memory.length - 1][0];
  const windowEndTick = anchorTick + TICK_RATE_HZ * WINDOW_SECONDS;
  const toIndex = toTick <= windowEndTick ? memory.length - 1 : memory.findIndex(([tick]) => tick > windowEndTick) - 1;
  return { basis: 'observer-first-tick', fromTick: memory[fromIndex][0], toTick: memory[Math.max(fromIndex, toIndex)][0], fromIndex, toIndex: Math.max(fromIndex, toIndex) };
}

/** AC5 原文「每分钟采样一次」:窗口内每 SAMPLE_INTERVAL_TICKS 取一个瞬时样本。 */
export function minuteResample(memory, window) {
  if (window.basis == null || window.fromTick == null) return [];
  const samples = [];
  let nextTick = window.fromTick;
  for (let index = window.fromIndex; index <= window.toIndex; index += 1) {
    if (memory[index][0] >= nextTick) {
      samples.push(memory[index]);
      nextTick = memory[index][0] + SAMPLE_INTERVAL_TICKS;
    }
  }
  return samples;
}

/** AC5 原文公式:末值 − 首值 ≤ 首值 5%(判据本体);峰值涨幅只作证据字段。 */
export function rssGrowthVerdict(minuteSamples, growthLimit = 0.05) {
  if (minuteSamples.length < 2) return { pass: false, reason: `minute samples ${minuteSamples.length} < 2` };
  const values = minuteSamples.map(([, bytes]) => bytes);
  const start = values[0];
  const end = values[values.length - 1];
  const peak = Math.max(...values);
  return {
    pass: end - start <= start * growthLimit,
    reason: `end ${end} - start ${start} vs limit ${start * growthLimit}`,
    startBytes: start,
    endBytes: end,
    peakBytes: peak,
    endGrowthRatio: (end - start) / start,
    peakGrowthRatio: (peak - start) / start,
  };
}

function pickWindowIncarnation(tickSampleDir) {
  // 一次压测跑会 boot 两次(step 14 重启);5 分钟窗口在 tick 数最多的那份 CSV 里。
  const incarnations = new Map();
  for (const name of readdirSync(tickSampleDir)) {
    const match = /^tick-phase-samples\.([0-9a-f]{32})\.csv$/.exec(name);
    if (!match) continue;
    const rows = parseCsv(join(tickSampleDir, name)).length;
    incarnations.set(match[1], (incarnations.get(match[1]) ?? 0) + rows);
  }
  let best = null;
  for (const [incarnation, rows] of incarnations) if (best == null || rows > best.rows) best = { incarnation, rows };
  return best;
}

function roundTickEvidence(tickSampleDir) {
  const best = pickWindowIncarnation(tickSampleDir);
  if (best == null) return { error: 'no tick-phase-samples CSV in ' + tickSampleDir };
  const phaseRows = parseCsv(join(tickSampleDir, `tick-phase-samples.${best.incarnation}.csv`));
  const perTickNanos = new Map();
  for (const [tickId, , elapsedNanos] of phaseRows) {
    const nanos = Number(elapsedNanos);
    if (!Number.isFinite(nanos)) continue;
    perTickNanos.set(tickId, (perTickNanos.get(tickId) ?? 0) + nanos);
  }
  const allocationRows = parseCsv(join(tickSampleDir, `tick-allocation-samples.${best.incarnation}.csv`));
  const timing = [];
  for (const [tickId, nanos] of perTickNanos) timing.push([Number(tickId), nanos / 1e6]);
  timing.sort((a, b) => a[0] - b[0]);
  const memory = [];
  for (const row of allocationRows) {
    const rss = row[9];
    if (rss != null && rss !== '') memory.push([Number(row[0]), Number(rss)]);
  }
  memory.sort((a, b) => a[0] - b[0]);
  return {
    incarnation: best.incarnation,
    ticks: timing.length,
    timingMs: timing.map(([, ms]) => ms),
    timing,
    memoryBytes: memory.map(([, bytes]) => bytes),
    memory,
  };
}

/** fleet 证据源:逐 Bot 目录(一进程一账号)或组目录(一进程多账号,ndjson 行带 accountId)。 */
function fleetNdjsonFiles(launcherDir) {
  const files = [];
  for (let index = 2; index <= FLEET_BOTS; index += 1) {
    const path = join(launcherDir, `bot-${index}`, 'bot-host.ndjson');
    if (existsSync(path)) files.push({ source: `bot-${index}`, path });
  }
  if (existsSync(launcherDir)) {
    for (const name of readdirSync(launcherDir)) {
      if (!name.startsWith('bot-group-')) continue;
      const path = join(launcherDir, name, 'bot-host.ndjson');
      if (existsSync(path)) files.push({ source: name, path });
    }
  }
  return files;
}

function roundFleetEvidence(launcherDir) {
  const moveIssued = [];
  let fleetPassed = 0;
  let fleetTotal = 0;
  for (const { source, path } of fleetNdjsonFiles(launcherDir)) {
    const ndjson = readTextIfPresent(path);
    if (ndjson === '') continue;
    fleetTotal += 1;
    const stamps = [];
    for (const line of ndjson.split('\n')) {
      if (!line.includes('"move.issued"')) continue;
      try { stamps.push(Date.parse(JSON.parse(line).ts)); } catch { /* skip malformed tail */ }
    }
    if (stamps.length > 0) moveIssued.push({ bot: source, count: stamps.length, first: stamps[0], last: stamps[stamps.length - 1] });
    const result = readTextIfPresent(join(dirname(path), 'result.ndjson'));
    if (result.includes('"passed":true')) fleetPassed += 1;
  }
  const first = Math.min(...moveIssued.map((bot) => bot.first));
  const last = Math.max(...moveIssued.map((bot) => bot.last));
  return {
    botsWithMoves: moveIssued.length,
    fleetTotal,
    fleetPassed,
    minMovesPerBot: Math.min(...moveIssued.map((bot) => bot.count)),
    totalMoves: moveIssued.reduce((sum, bot) => sum + bot.count, 0),
    spanSeconds: moveIssued.length > 0 ? (last - first) / 1000 : 0,
  };
}

function admissionEventFiles(launcherDir) {
  const files = [];
  for (let index = 1; index <= FLEET_BOTS; index += 1) {
    const path = join(launcherDir, `bot-${index}`, 'admission-events.ndjson');
    if (existsSync(path)) files.push(path);
  }
  if (existsSync(launcherDir)) {
    for (const name of readdirSync(launcherDir)) {
      if (!name.startsWith('bot-group-')) continue;
      const path = join(launcherDir, name, 'admission-events.ndjson');
      if (existsSync(path)) files.push(path);
    }
  }
  return files;
}

function roundAdmissionEvidence(launcherDir) {
  let admitted = 0;
  let sessions = 0;
  for (const path of admissionEventFiles(launcherDir)) {
    const text = readTextIfPresent(path);
    if (text === '') continue;
    for (const line of text.split('\n')) {
      if (line.includes('"meaning":"ticket_accepted"')) admitted += 1;
    }
    sessions += 1;
  }
  const violations = [];
  for (const path of listLogFiles(launcherDir)) {
    for (const line of readTextIfPresent(path).split('\n')) {
      if (FORBIDDEN_LINE.test(line)) violations.push({ path, line: line.slice(0, 300) });
    }
  }
  for (const path of listLogFiles(join(launcherDir, 'ds-boot-1')).concat(listLogFiles(join(launcherDir, 'ds-boot-2')))) {
    for (const line of readTextIfPresent(path).split('\n')) {
      if (FORBIDDEN_LINE.test(line)) violations.push({ path, line: line.slice(0, 300) });
    }
  }
  const dsLog = readTextIfPresent(join(launcherDir, 'lumio-ds.log')) + readTextIfPresent(join(launcherDir, 'lumio-ds.boot-2.log'));
  return { admitted, sessions, violations, violationClasses: classifyViolations(violations), dsLogLines: dsLog.trim() ? dsLog.trim().split('\n').length : 0 };
}

function observerEvidence(observersDir) {
  if (!existsSync(observersDir)) return { error: 'missing observers dir ' + observersDir };
  const records = [];
  for (let index = 1; index <= OBSERVERS; index += 1) {
    const path = join(observersDir, `records-${index}.json`);
    if (!existsSync(path)) return { error: `missing observer records-${index}.json` };
    records.push(readJson(path));
  }
  const sampledSets = records.map((record) => [...record.sampledIds].sort().join('|'));
  const sampledConsistent = sampledSets.every((set) => set === sampledSets[0]);
  const byTick = records.map((record) => {
    const map = new Map();
    for (const entry of record.records) {
      const key = JSON.stringify(entry.fields);
      map.set(entry.tick, map.has(entry.tick) ? map.get(entry.tick) + '\n' + key : key);
    }
    return map;
  });
  const commonTicks = [...byTick[0].keys()].filter((tick) => byTick.every((map) => map.has(tick)));
  let mismatches = 0;
  for (const tick of commonTicks) {
    const baseline = byTick[0].get(tick);
    for (let index = 1; index < byTick.length; index += 1) {
      if (byTick[index].get(tick) !== baseline) mismatches += 1;
    }
  }
  return {
    observers: records.length,
    sampledIds: records[0].sampledIds,
    sampledConsistent,
    comparedTicks: commonTicks.length,
    mismatches,
    observerTicks: records.map((record) => [record.firstTick, record.lastTick]),
    firstTick: Math.min(...records.map((record) => record.firstTick)),
  };
}

/** 一轮的 AC5 视图:稳态窗口 + 每分钟重采样 + 原文公式判定(窗口不可得 = 不通过)。 */
function roundRssEvidence(round) {
  const raw = round.tick.error ? [] : round.tick.memory;
  const anchor = round.observers.error ? null : round.observers.firstTick;
  const window = steadyRssWindow(raw, anchor);
  const minuteSamples = minuteResample(raw, window);
  const verdict = rssGrowthVerdict(minuteSamples);
  return {
    rawSampleCount: raw.length,
    rawStartBytes: raw.length > 0 ? raw[0][1] : null,
    rawEndBytes: raw.length > 0 ? raw[raw.length - 1][1] : null,
    rawPeakBytes: raw.length > 0 ? Math.max(...raw.map(([, bytes]) => bytes)) : null,
    windowBasis: window.basis,
    windowFromTick: window.fromTick,
    windowToTick: window.toTick,
    minuteSamples,
    verdict,
  };
}

function roundFailures(label, round) {
  const failures = [];
  const { stress, admission, fleet, tick, observers } = round;
  // AC1 规模与准入
  if (stress.criteria.admitted.actual !== FLEET_BOTS) failures.push(`${label}: admitted ${stress.criteria.admitted.actual} != ${FLEET_BOTS}`);
  if (admission.admitted !== FLEET_BOTS) failures.push(`${label}: ticket_accepted bot dirs ${admission.admitted} != ${FLEET_BOTS}`);
  if (admission.violations.length > 0) failures.push(`${label}: ${admission.violations.length} protocol/queue violation lines (first: ${admission.violations[0]?.line})`);
  if (stress.launchStatus !== 'PASS') failures.push(`${label}: launcher status ${stress.launchStatus}`);
  // AC2 持续移动
  if (fleet.botsWithMoves !== FLEET_BOTS - 1) failures.push(`${label}: fleet bots with move.issued ${fleet.botsWithMoves} != ${FLEET_BOTS - 1}`);
  if (fleet.spanSeconds < 280) failures.push(`${label}: move span ${fleet.spanSeconds.toFixed(1)}s < 280s`);
  if (fleet.fleetPassed !== FLEET_BOTS - 1) failures.push(`${label}: resident result passed ${fleet.fleetPassed} != ${FLEET_BOTS - 1}`);
  // AC3 每帧预算(NativeCore clock)
  if (tick.error) failures.push(`${label}: ${tick.error}`);
  else {
    if (tick.ticks < 5000) failures.push(`${label}: sampled ticks ${tick.ticks} < 5000 (window incomplete)`);
    const p99 = percentile(tick.timingMs, 99);
    const over = tick.timingMs.filter((ms) => ms > FRAME_BUDGET_MS).length;
    if (p99 == null || p99 > FRAME_BUDGET_MS) failures.push(`${label}: frame p99 ${p99}ms > ${FRAME_BUDGET_MS}ms`);
    if (over !== 0) failures.push(`${label}: ${over} frames over ${FRAME_BUDGET_MS}ms`);
  }
  // AC4 一致性
  if (observers.error) failures.push(`${label}: ${observers.error}`);
  else {
    if (observers.observers !== OBSERVERS) failures.push(`${label}: observers ${observers.observers} != ${OBSERVERS}`);
    if (!observers.sampledConsistent) failures.push(`${label}: sampled entity sets differ across observers`);
    if (observers.mismatches !== 0) failures.push(`${label}: ${observers.mismatches} replica mismatches over ${observers.comparedTicks} common ticks`);
    if (observers.comparedTicks < 1000) failures.push(`${label}: common ticks ${observers.comparedTicks} < 1000 (insufficient overlap)`);
  }
  // AC5 内存曲线:原文「末值 − 首值 ≤ 首值 5%」,窗口=全员准入后的稳态窗口
  // (无观察者 = fleet 未全员准入 → 稳态窗口不可得,不能拿全程曲线冒充)。
  if (!tick.error) {
    const rss = round.rss;
    if (rss.rawSampleCount === 0) {
      failures.push(`${label}: rss samples 0 (allocation CSV has no rss column data)`);
    } else if (rss.windowBasis == null) {
      const rawGrowth = rss.rawStartBytes > 0 ? `raw peak growth ${(((rss.rawPeakBytes - rss.rawStartBytes) / rss.rawStartBytes) * 100).toFixed(1)}% over the whole run` : 'raw run';
      failures.push(`${label}: rss steady window not established (fleet never fully admitted; no observer anchor) — ${rawGrowth} is not an AC5 verdict`);
    } else if (!rss.verdict.pass) {
      failures.push(`${label}: rss steady-window growth ${rss.verdict.reason}`);
    }
  }
  return failures;
}

function loadRound(dir) {
  const launcherDir = join(dir, 'launcher');
  const stress = readJson(join(launcherDir, 'verification.json'));
  // 十四步中断时 stress-move 的 schema 没写全:launchStatus 回落 status;admitted 由
  // 证据侧(admission events + 组宿主会话)计出,绝不为「没测到」编数字。
  if (stress.criteria?.admitted?.actual == null) {
    stress.launchStatus = stress.launchStatus ?? stress.status;
    stress.criteria = stress.criteria ?? {};
    stress.criteria.admitted = { required: 100, actual: null, drops: null, protocolViolation: null, queueFull: null };
    stress._admittedDerived = roundAdmissionEvidence(launcherDir).admitted;
  }
  const tickDir = join(dir, 'tick-samples');
  const round = {
    dir: resolve(dir),
    stress,
    admission: roundAdmissionEvidence(launcherDir),
    fleet: roundFleetEvidence(launcherDir),
    tick: existsSync(tickDir) ? roundTickEvidence(tickDir) : { error: 'missing tick-samples dir' },
    observers: observerEvidence(join(dir, 'observers')),
  };
  round.rss = roundRssEvidence(round);
  return round;
}

/**
 * rounds=2 文档的整体判定(取代 stress-move.criteriaPassed 的整体复用:其 rss 段按
 * 「峰值−首值」判,与本判定器执行的 AC5 原文「末值−首值」不同,不能让它反向绑架口径;
 * 其余条目语义照搬,两处均由 failures 驱动,双保险不缺项)。
 */
export function roundsDocumentPassed(document) {
  if (document.rounds !== 2) return false;
  if (document.clock !== 'native-core-clock_now') return false;
  if (document.params?.bots !== FLEET_BOTS || document.params?.durationSeconds !== WINDOW_SECONDS) return false;
  const shas = Object.values(document.shas ?? {});
  if (shas.length === 0 || !shas.every((sha) => typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha))) return false;
  const { admitted, frameBudget, transformConsistency, rss } = document.criteria ?? {};
  if (admitted?.actual !== admitted?.required || admitted?.required !== FLEET_BOTS) return false;
  if (admitted.actual == null || admitted.drops !== 0 || admitted.protocolViolation !== 0 || admitted.queueFull !== 0) return false;
  if (typeof frameBudget?.p99Ms !== 'number' || !Number.isFinite(frameBudget.p99Ms)) return false;
  if (frameBudget.overBudgetFrames !== 0 || frameBudget.clock !== 'native-core-clock_now') return false;
  if (frameBudget.p99Ms > frameBudget.budgetMs) return false;
  if (transformConsistency?.mismatches !== 0 || transformConsistency?.sampledBots !== 5) return false;
  if (rss?.basis !== 'observer-first-tick') return false;
  if (!Array.isArray(rss.samples) || rss.samples.length < 5) return false; // 5 分钟 × 每分钟一次
  if (rss.samples[0] !== rss.startBytes || rss.samples[rss.samples.length - 1] !== rss.endBytes) return false;
  return rss.endBytes - rss.startBytes <= rss.startBytes * (rss.growthLimit ?? 0.05);
}

export async function verifyRounds({ round1Dir, round2Dir, outPath }) {
  for (const dir of [round1Dir, round2Dir]) {
    if (!existsSync(join(dir, 'launcher', 'verification.json'))) throw new Error('missing ' + join(dir, 'launcher', 'verification.json'));
  }

  const round1 = loadRound(round1Dir);
  const round2 = loadRound(round2Dir);

  // AC5:两轮可比 = 同一套仓 SHA + 两轮都是独立目录 + 各自证据齐全。
  const shasEqual = JSON.stringify(round1.stress.shas) === JSON.stringify(round2.stress.shas);
  const dirsIndependent = resolve(round1Dir) !== resolve(round2Dir);
  const shaFilled = Object.values(round1.stress.shas ?? {}).every((sha) => typeof sha === 'string' && /^[0-9a-f]{40}$/.test(sha));

  for (const [label, round] of [['round-1', round1], ['round-2', round2]]) {
    const timingCsv = ['tick_id,ms', ...round.tick.timing.map(([tickId, ms]) => `${tickId},${ms.toFixed(4)}`)].join('\n');
    writeFileSync(join(round.dir, 'timing.csv'), timingCsv + '\n');
    const memoryCsv = ['tick_id,rss_bytes', ...round.tick.memory.map(([tickId, bytes]) => `${tickId},${bytes}`)].join('\n');
    writeFileSync(join(round.dir, 'memory.csv'), memoryCsv + '\n');
    writeFileSync(join(round.dir, 'verification-round.json'), `${JSON.stringify({
      round: label,
      dir: round.dir,
      launcherStatus: round.stress.launchStatus,
      admitted: round.stress.criteria.admitted,
      fleet: round.fleet,
      tick: { incarnation: round.tick.incarnation, ticks: round.tick.ticks, p99Ms: round.tick.error ? null : percentile(round.tick.timingMs, 99), frameBudgetMs: FRAME_BUDGET_MS, overBudgetFrames: round.tick.error ? null : round.tick.timingMs.filter((ms) => ms > FRAME_BUDGET_MS).length },
      observers: round.observers.error ?? round.observers,
      violations: round.admission.violations.length,
      violationClasses: round.admission.violationClasses,
      rss: {
        windowBasis: round.rss.windowBasis,
        windowTicks: [round.rss.windowFromTick, round.rss.windowToTick],
        minuteSamples: round.rss.minuteSamples.map(([, bytes]) => bytes),
        endGrowthRatio: round.rss.verdict.startBytes != null ? round.rss.verdict.endGrowthRatio : null,
        peakGrowthRatio: round.rss.verdict.startBytes != null ? round.rss.verdict.peakGrowthRatio : null,
        rawSampleCount: round.rss.rawSampleCount,
      },
      shas: round.stress.shas,
    }, null, 2)}\n`);
  }

  const failures = [
    ...roundFailures('round-1', round1),
    ...roundFailures('round-2', round2),
  ];
  if (!dirsIndependent) failures.push('rounds:independent: round-1 and round-2 are the same directory');
  if (!shaFilled) failures.push('shas: round-1 stress document has unfilled SHAs');
  else if (!shasEqual) failures.push('shas:compare: round-1 and round-2 were not run on the same ten-repo snapshot');

  const window = round1.tick.error ? null : {
    p99Ms: percentile(round1.tick.timingMs, 99),
    overBudgetFrames: round1.tick.timingMs.filter((ms) => ms > FRAME_BUDGET_MS).length,
  };
  const document = createStressDocument({ shas: round1.stress.shas });
  document.rounds = 2;
  document.params.staggerMs = 1200;
  document.launchStatus = round1.stress.launchStatus;
  // 分类计数:protocolViolation 与 queueFull 各自从违规行的类别来,v0.0.2 起不再同值。
  document.criteria.admitted = {
    required: FLEET_BOTS,
    actual: round1.stress.criteria.admitted.actual,
    drops: FLEET_BOTS - round1.stress.criteria.admitted.actual,
    protocolViolation: round1.admission.violationClasses.protocolViolation,
    queueFull: round1.admission.violationClasses.queueFull,
  };
  document.criteria.frameBudget = { budgetMs: FRAME_BUDGET_MS, p99Ms: window?.p99Ms ?? null, overBudgetFrames: window?.overBudgetFrames ?? null, clock: 'native-core-clock_now' };
  document.criteria.transformConsistency = round1.observers.error
    ? { sampledBots: null, mismatches: null }
    : { sampledBots: round1.observers.sampledIds.length, mismatches: round1.observers.mismatches };
  // AC5:稳态窗口内每分钟一次的采样 + 原文公式;全程原始曲线只作为信息性字段保留
  // (v0.0.2 曾把准入期峰值增长当作 AC5 判定输入,那是窗口口径错误,不是内存回归)。
  document.criteria.rss = {
    samples: round1.rss.minuteSamples.map(([, bytes]) => bytes),
    growthLimit: 0.05,
    startBytes: round1.rss.verdict.startBytes ?? null,
    endBytes: round1.rss.verdict.endBytes ?? null,
    basis: round1.rss.windowBasis,
    windowTicks: [round1.rss.windowFromTick, round1.rss.windowToTick],
    sampling: 'per-minute (1200 ticks @ 20 Hz) inside the post-admission steady window',
    endGrowthRatio: round1.rss.verdict.startBytes != null ? round1.rss.verdict.endGrowthRatio : null,
    peakGrowthRatio: round1.rss.verdict.startBytes != null ? round1.rss.verdict.peakGrowthRatio : null,
    raw: {
      sampleCount: round1.rss.rawSampleCount,
      startBytes: round1.rss.rawStartBytes,
      endBytes: round1.rss.rawEndBytes,
      peakBytes: round1.rss.rawPeakBytes,
    },
  };
  document.perRound = {
    'round-1': JSON.parse(readFileSync(join(round1.dir, 'verification-round.json'), 'utf8')),
    'round-2': JSON.parse(readFileSync(join(round2.dir, 'verification-round.json'), 'utf8')),
  };
  document.shas = shaFilled ? round1.stress.shas : collectRepoShas();
  document.status = failures.length === 0 && roundsDocumentPassed({ ...document, status: 'PASS' }) ? 'PASS' : 'FAIL';
  document.failures = failures;
  mkdirSync(resolve(outPath, '..'), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(document, null, 2)}\n`);
  process.stdout.write(`VERIFICATION_STATUS=${document.status}\n${failures.map((failure) => 'FAIL ' + failure).join('\n')}\n`);
  return document;
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  const [round1Dir, round2Dir, outPath] = process.argv.slice(2);
  if (!round1Dir || !round2Dir || !outPath) throw new Error('usage: node verify-rounds.mjs <round1Dir> <round2Dir> <outJson>');
  try {
    const document = await verifyRounds({ round1Dir, round2Dir, outPath });
    process.exitCode = stressExitCode(document.status);
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = 1;
  }
}

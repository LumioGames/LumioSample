#!/usr/bin/env node
/**
 * R-00588 AC4 的观察者侧:五条独立只读连接,对固定抽样的 5 个玩家实体按 tick 记录
 * 字段增量流,供 verify-rounds.mjs 做跨观察者一致性比对(0 差异才 PASS)。
 *
 * 为什么是「增量流比对」而不是终态比对:100 个 Bot 在持续移动,终态随 tick 变化;
 * 同一 tick 同一实体的字段值在任何观察者眼里都必须字节一致,这是复制确定性的
 * 直接证据。AOI 视差(两个观察者站位不同、各自可见的实体集不同)不构成差异,
 * 比对时只取五方同 tick 都在场的实体(见 verify-rounds.mjs)。
 *
 * Usage:
 *   node observe-replicas.mjs --origin http://127.0.0.1:8080 --slug sample \
 *     --out-dir <roundDir>/observers --prefix AcctObs<ts> --hold-seconds 330
 * 凭据只进 WS 子协议,不落盘、不进日志(与 verify-2 探针同一约定)。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { loginAndLaunch } from '../../Tools/account-client.mjs';

function parseArgs(argv) {
  const options = { origin: 'http://127.0.0.1:8080', slug: 'sample', count: 5, holdSeconds: 330, staggerMs: 1200, sampleIndices: [19, 39, 59, 79, 99] };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (key === 'origin') options.origin = value;
    else if (key === 'slug') options.slug = value;
    else if (key === 'out-dir') options.outDir = resolve(value);
    else if (key === 'prefix') options.prefix = value;
    else if (key === 'hold-seconds') options.holdSeconds = Number(value);
    else if (key === 'stagger-ms') options.staggerMs = Number(value);
    else if (key === 'sample-indices') options.sampleIndices = String(value).split(',').map(Number);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!options.outDir) throw new Error('--out-dir is required');
  if (!options.prefix) throw new Error('--prefix is required (timestamped, unique per round)');
  return options;
}

class ReplicaObserver {
  constructor(index, account) {
    this.index = index;
    this.account = account;
    this.ws = null;
    this.playerIds = new Set();
    this.sampledIds = null;
    this.firstTick = null;
    this.lastTick = null;
    this.records = []; // {tick, fields: [[netEntityId, componentId, fieldId, value], ...]}
    this.closedCode = null;
    this.messages = 0;
    this.worldChanges = 0;
  }

  async connect(session, env, log) {
    this.ws = new WebSocket(session.launch.wsUrl, ['lumio.mvp.v0', `lumio-admission.${session.launch.admissionCredential}`]);
    this.ws.addEventListener('message', (event) => this.onMessage(event));
    this.ws.addEventListener('close', (event) => { this.closedCode = event.code; });
    await new Promise((resolveOpen, rejectOpen) => {
      this.ws.addEventListener('open', resolveOpen);
      this.ws.addEventListener('error', rejectOpen, { once: true });
    });
    log(`observer-${this.index} ${this.account} connected ${session.launch.wsUrl}`);
  }

  onMessage(event) {
    this.messages += 1;
    if (typeof event.data !== 'string') return;
    let change;
    try { change = JSON.parse(event.data); } catch { return; }
    if (change.messageType !== 'WorldChange') return;
    this.worldChanges += 1;
    const tick = Number(change.tick);
    if (!Number.isFinite(tick)) return;
    if (this.firstTick == null) this.firstTick = tick;
    this.lastTick = tick;
    for (const created of change.creates ?? []) {
      if (created.entityType === 'player') this.playerIds.add(created.netEntityId);
    }
    // 抽样集合在看到满编(>=100)玩家后一次性钉死,五方各自按同一规则(排序+分位)取。
    if (this.sampledIds == null && this.playerIds.size >= 100) {
      const sorted = [...this.playerIds].sort();
      this.sampledIds = new Set(options.sampleIndices.map((at) => sorted[at]).filter((id) => id != null));
    }
    if (this.sampledIds == null) return;
    const fields = [];
    // WorldChange.fields 是扁平整列:{componentId, fieldId, netEntityId, reason, value}。
    // reason(sync/create 等)是发送侧语境,不属于复制值,比对只用 componentId/fieldId/value。
    for (const field of change.fields ?? []) {
      const id = field.netEntityId;
      if (id != null && this.sampledIds.has(id)) fields.push([id, field.componentId, field.fieldId, String(field.value)]);
    }
    for (const created of change.creates ?? []) {
      if (this.sampledIds.has(created.netEntityId)) {
        for (const field of created.fields ?? []) fields.push([created.netEntityId, field.componentId, field.fieldId, String(field.value)]);
      }
    }
    if (fields.length > 0) fields.sort((a, b) => (a[0] + a[1] + a[2] < b[0] + b[1] + b[2] ? -1 : 1));
    this.records.push({ tick, fields });
  }

  writeEvidence(outDir) {
    const digestLines = this.records.map((record) => {
      const digest = createHash('sha256').update(JSON.stringify(record.fields)).digest('hex').slice(0, 16);
      return `{"tick":${record.tick},"fields":${record.fields.length},"digest":"${digest}"}`;
    });
    writeFileSync(join(outDir, `digest-${this.index}.ndjson`), `${digestLines.join('\n')}\n`);
    // fields 全量留在原始流里(下面这个文件),digest 行只是快速扫读用。
    writeFileSync(join(outDir, `records-${this.index}.json`), JSON.stringify({
      account: this.account,
      playerCount: this.playerIds.size,
      sampledIds: this.sampledIds == null ? [] : [...this.sampledIds],
      firstTick: this.firstTick,
      lastTick: this.lastTick,
      messages: this.messages,
      worldChanges: this.worldChanges,
      closedCode: this.closedCode,
      records: this.records,
    }));
  }
}

const options = parseArgs(process.argv.slice(2));
mkdirSync(options.outDir, { recursive: true });
const env = { ...process.env, LUMIO_ENGINE_ROOT: process.env.LUMIO_ENGINE_ROOT ?? 'C:/Work/LumioGames/LumioGameEngine' };
const observers = [];
const startedAt = Date.now();
for (let i = 0; i < options.count; i += 1) {
  if (i > 0) await sleep(options.staggerMs);
  const account = `${options.prefix}${i + 1}`;
  const session = await loginAndLaunch({ origin: options.origin, loginName: account, slug: options.slug, env, log: () => {} });
  const observer = new ReplicaObserver(i + 1, account);
  await observer.connect(session, env, (line) => process.stdout.write(`${line}\n`));
  observers.push(observer);
}
process.stdout.write(`all ${observers.length} observers connected, holding ${options.holdSeconds}s\n`);
const holdUntil = Date.now() + options.holdSeconds * 1000;
while (Date.now() < holdUntil && observers.some((observer) => observer.closedCode == null)) {
  await sleep(1000);
}
for (const observer of observers) {
  try { observer.ws?.close(); } catch { /* already closed */ }
  observer.writeEvidence(options.outDir);
  process.stdout.write(`observer-${observer.index} ${observer.account} ticks ${observer.firstTick}..${observer.lastTick} worldChanges=${observer.worldChanges} close=${observer.closedCode}\n`);
}
writeFileSync(join(options.outDir, 'observers.json'), `${JSON.stringify({
  startedAt, finishedAt: Date.now(), count: observers.length,
  accounts: observers.map((observer) => observer.account),
  holdSeconds: options.holdSeconds, sampleIndices: options.sampleIndices,
}, null, 2)}\n`);
process.exit(0);

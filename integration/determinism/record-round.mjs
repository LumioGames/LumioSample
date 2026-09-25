#!/usr/bin/env node
/**
 * 判据 7 的轮次录制器:一条只读观察连接,把整场 tour 的 WorldChange 流逐 tick 落成
 * 结构化 ndjson(供 derive-rounds.mjs 派生 events.ndjson / world.json)。
 *
 * 两轮必须用同一账号(登录名进 Bot 游走种子,ADR wave B:MixSeed(accountId)),同底图、
 * 独立新进程、独立初始数据;本录制器账号同样两轮一致,使观察视角本身可复现。
 *
 * Usage:
 *   node record-round.mjs --origin http://127.0.0.1:8080 --slug sample \
 *     --account AcctDet1 --out <roundDir>/observer-raw.ndjson --base-map-sha <hex>
 * 连接期对 not_serving(1013)按 ADR-120 退避重连——房间由启动器异步起,录制的开场
 * 允许落在 DS 就绪之前,但一旦入场就不再重连(重连即丢流,直接失败)。
 */
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loginAndLaunch } from '../../Tools/account-client.mjs';

function parseArgs(argv) {
  const options = { origin: 'http://127.0.0.1:8080', slug: 'sample', retrySeconds: 240, holdAfterCloseMs: 0 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    const value = argv[i + 1];
    if (key === 'origin') options.origin = value;
    else if (key === 'slug') options.slug = value;
    else if (key === 'account') options.account = value;
    else if (key === 'out') options.out = resolve(value);
    else if (key === 'base-map-sha') options.baseMapSha = value;
    else if (key === 'retry-seconds') options.retrySeconds = Number(value);
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!options.account || !options.out || !options.baseMapSha) {
    throw new Error('--account, --out and --base-map-sha are required');
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const env = { ...process.env, LUMIO_ENGINE_ROOT: process.env.LUMIO_ENGINE_ROOT ?? 'C:/Work/LumioGames/LumioGameEngine' };

appendFileSync(options.out, `${JSON.stringify({ kind: 'recorder.start', account: options.account, baseMapSha256: options.baseMapSha })}\n`);

// 登录一次、凭据复用:重试时再走一次 login 会给已存在的账号新生成一次性密码,
// 第二次就 password does not match。凭据只进子协议,不落盘。
const session = await loginAndLaunch({ origin: options.origin, loginName: options.account, slug: options.slug, env, log: () => {} });
const connectDeadline = Date.now() + options.retrySeconds * 1000;
let worldChanges = 0;

// 统一重连循环:未收到任何世界数据之前的 close 1013(not_serving,启动器在
// --check-config 阶段会让端口短暂可连但拒绝准入)、拒连 error、1006,都是「再试」;
// 只有收到过世界数据之后的关闭才算录制完成(正常关服 close 1000)。
for (;;) {
  const ws = new WebSocket(session.launch.wsUrl, ['lumio.mvp.v0', `lumio-admission.${session.launch.admissionCredential}`]);
  const opened = await new Promise((resolveOpen) => {
    // 拒连路径在 undici/浏览器实现里可能只给 error 不给 close,两边都算「未开门」。
    ws.addEventListener('open', () => resolveOpen('open'));
    ws.addEventListener('close', (event) => resolveOpen(`close:${event.code}`));
    ws.addEventListener('error', () => resolveOpen('error'));
    setTimeout(() => resolveOpen('attempt-timeout'), 15000).unref?.();
  });
  if (opened !== 'open') {
    appendFileSync(options.out, `${JSON.stringify({ kind: 'recorder.retry', phase: opened })}\n`);
    if (Date.now() > connectDeadline) throw new Error(`recorder could not connect before DS ready within ${options.retrySeconds}s`);
    await new Promise((r) => setTimeout(r, 2000));
    continue;
  }
  const closed = await new Promise((resolveClosed) => {
    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      let change;
      try { change = JSON.parse(event.data); } catch { return; }
      if (change.messageType !== 'WorldChange') return;
      worldChanges += 1;
      const fields = (change.fields ?? []).map((field) => [field.netEntityId, field.componentId, field.fieldId, String(field.value)]);
      const creates = (change.creates ?? []).map((created) => [created.netEntityId, created.entityType, ...created.fields.map((field) => [field.componentId, field.fieldId, String(field.value)])]);
      const destroys = (change.destroys ?? []).map((destroyed) => destroyed.netEntityId ?? destroyed);
      const rpcs = (change.rpcs ?? []).map((rpc) => JSON.stringify(rpc));
      appendFileSync(options.out, `${JSON.stringify({ kind: 'world', tick: change.tick, fields, creates, destroys, rpcs, sectionGroupSent: change.sectionGroup?.sent?.length ?? 0 })}\n`);
    });
    ws.addEventListener('close', (event) => resolveClosed(event.code));
    ws.addEventListener('error', () => { /* close follows;若不 follow 由编排方超时 */ });
  });
  if (worldChanges > 0 || closed === 1000) {
    writeFileSync(options.out.replace(/observer-raw\.ndjson$/, '') + '/recorder-done.json', `${JSON.stringify({ worldChanges, closeCode: closed })}\n`);
    process.stdout.write(`recorder done: worldChanges=${worldChanges} close=${closed}\n`);
    // 不显式 process.exit:让事件循环自然排空,避开 win 上带活动句柄强退的 libuv 断言。
    break;
  }
  appendFileSync(options.out, `${JSON.stringify({ kind: 'recorder.retry', phase: `close:${closed}` })}\n`);
  if (Date.now() > connectDeadline) throw new Error(`recorder connection kept closing before any world data within ${options.retrySeconds}s`);
  await new Promise((r) => setTimeout(r, 2000));
}

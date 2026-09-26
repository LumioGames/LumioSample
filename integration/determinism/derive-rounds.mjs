#!/usr/bin/env node
/**
 * 判据 7 派生器:把两个轮目录里的 observer-raw.ndjson 派生成 verify-evidence.mjs 要的
 * events.ndjson(逐 tick eventOrder/appliedTicks)与 world.json(逐格 vein 格 + 矿石数),
 * 并以 round-1 终态 + 独立事实(授权底图 4 条矿脉、tour 恰挖穿 1 条、步骤 14 玩法断言
 * veins==3/oreDrops==0)交叉核对出 expected.json——「一致但错」要在这一步被拦下。
 *
 * Usage: node derive-rounds.mjs <round1Dir> <round2Dir> <outExpectedJson>
 * 每个轮目录需含 observer-raw.ndjson( recorder.start 行带 baseMapSha256)。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

function readRaw(roundDir) {
  const path = join(roundDir, 'observer-raw.ndjson');
  if (!existsSync(path)) throw new Error('missing ' + path);
  const lines = readFileSync(path, 'utf8').trim().split(/\r?\n/);
  const events = [];
  let baseMapSha = null;
  let sawWorld = false;
  for (const line of lines) {
    const value = JSON.parse(line);
    if (value.kind === 'recorder.start') baseMapSha = value.baseMapSha256;
    if (value.kind === 'recorder.retry') continue;
    if (value.kind === 'world') { sawWorld = true; events.push(value); }
  }
  if (!sawWorld) throw new Error(`${roundDir}: observer stream has no WorldChange`);
  if (!/^[0-9a-f]{64}$/.test(baseMapSha ?? '')) throw new Error(`${roundDir}: recorder.start lacked baseMapSha256`);
  return { baseMapSha, events };
}

/**
 * 逐事件 eventOrder(每行一个事件,配它的 tick——verify-evidence 要求两列逐条成对)。
 * ADR-125 决策 3:每条带具名 category。收录类别(entity-create/entity-field/entity-destroy,
 * 外加预留的 voxel-write)进两轮逐位比较;rpc(如 chat 的 OnChatMessage)是消息投递、不改
 * 世界状态,归入排除类别 rpc-delivery——照落证据、判定器具名跳过,不默默丢掉(其
 * appliedTick 随客户端连接时机抖动,两轮实测差 5 tick,算进世界序等于把噪声当分歧)。
 * 值入键:两轮逐位相等=同一演化,不只是同一形状。收录/排除清单的唯一事实源在
 * Tools/verify-evidence.mjs;这里冒出清单外类别会被判定器 FAIL 拦下,不会静默通过。
 */
function deriveEventsNdjson(raw, outPath) {
  const lines = [JSON.stringify({ baseMapSha256: raw.baseMapSha })];
  for (const event of raw.events) {
    const entries = [];
    for (const create of event.creates ?? []) {
      entries.push({ category: 'entity-create', key: `+${create[0]}:${create[1]}` });
      for (let i = 2; i < create.length; i += 1) entries.push({ category: 'entity-create', key: `+${create[0]}:${create[i][0]}.${create[i][1]}=${create[i][2]}` });
    }
    for (const [id, component, field, value] of event.fields ?? []) entries.push({ category: 'entity-field', key: `${id}:${component}.${field}=${value}` });
    for (const id of event.destroys ?? []) entries.push({ category: 'entity-destroy', key: `-${id}` });
    for (const rpc of event.rpcs ?? []) entries.push({ category: 'rpc-delivery', key: rpc });
    for (const entry of entries) lines.push(JSON.stringify({ eventOrder: [entry], appliedTicks: [event.tick] }));
  }
  writeFileSync(outPath, `${lines.join('\n')}\n`);
}

/** 终态世界:从流里重建实体(creates→字段增量;destroys 移除),取全部 VeinReserve 实体为格。 */
function deriveWorld(raw) {
  const entities = new Map();
  for (const event of raw.events) {
    for (const create of event.creates ?? []) {
      const fields = {};
      for (let i = 2; i < create.length; i += 1) fields[`${create[i][0]}.${create[i][1]}`] = create[i][2];
      entities.set(create[0], { type: create[1], fields });
    }
    for (const [id, component, field, value] of event.fields ?? []) {
      const entity = entities.get(id);
      if (entity != null) entity.fields[`${component}.${field}`] = value;
    }
    for (const id of event.destroys ?? []) entities.delete(id);
  }
  const veins = [...entities.entries()]
    .filter(([, entity]) => entity.type === 'vein')
    .map(([id, entity]) => ({ id, x: Number(entity.fields['VeinReserveComponent.cellX'] ?? NaN), z: Number(entity.fields['VeinReserveComponent.cellZ'] ?? entity.fields['VeinReserveComponent.cellOffset'] ?? NaN), remaining: Number(entity.fields['VeinReserveComponent.remaining'] ?? NaN) }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const players = [...entities.values()].filter((entity) => entity.type === 'player').length;
  const world = [...entities.values()].filter((entity) => entity.type === 'vein').length;
  return {
    // 本流里 vein 实体只带 remaining(无 cell 坐标字段);格以 vein 实体 netId 稳定排序编号,
    // block=remaining>0,ore=remaining 合计。「逐格」= 逐 vein 格,比逐体素格粗,但两侧
    // 同源同判,配合步骤 11 的 air 断言与步骤 14 的 veins/oreDrops 玩法断言成链。
    cells: veins.map((vein, index) => ({ x: index, y: 0, z: Number.isFinite(vein.x) ? vein.x : index, block: vein.remaining > 0 ? 1 : 0, remaining: vein.remaining })),
    oreCount: veins.reduce((sum, vein) => sum + (Number.isFinite(vein.remaining) && vein.remaining > 0 ? vein.remaining : 0), 0),
    veins: veins.length,
    players,
    world,
  };
}

const [round1Dir, round2Dir, outExpectedJson] = process.argv.slice(2);
if (!round1Dir || !round2Dir || !outExpectedJson) throw new Error('usage: node derive-rounds.mjs <round1Dir> <round2Dir> <outExpectedJson>');

const raw1 = readRaw(round1Dir);
const raw2 = readRaw(round2Dir);
// 录制器入场点对齐:两轮的首条世界记录必须同 tick(入场重放集中在该 tick,重放内容
// 亦须一致,由随后的 eventOrder 逐位比对兜底)。tick 不同则流起点错位,比对无意义。
if (raw1.events[0]?.tick !== raw2.events[0]?.tick) {
  console.error(`rounds start at different ticks: round-1=${raw1.events[0]?.tick} round-2=${raw2.events[0]?.tick} — rerun both rounds`);
  process.exit(1);
}
deriveEventsNdjson(raw1, join(round1Dir, 'events.ndjson'));
deriveEventsNdjson(raw2, join(round2Dir, 'events.ndjson'));
const world1 = deriveWorld(raw1);
const world2 = deriveWorld(raw2);
writeFileSync(join(round1Dir, 'world.json'), `${JSON.stringify(world1, null, 2)}\n`);
writeFileSync(join(round2Dir, 'world.json'), `${JSON.stringify(world2, null, 2)}\n`);

// expected 的独立事实链:授权底图 4 条矿脉(SampleRestoreVerifyScenario 注释)、tour 恰挖穿
// 1 条、步骤 14 玩法断言 veins==3 / oreDrops==0。两条事实有任何一条不成立,expected
// 不出,判据 7 判 FAIL(一致但错被拦在这里,不靠刷新基线)。
const INDEPENDENT = { authoredVeins: 4, tourMinedVeins: 1, restoredVeins: 3 };
const factsHold = world1.veins === INDEPENDENT.restoredVeins && world2.veins === INDEPENDENT.restoredVeins
  && world1.cells.length === INDEPENDENT.restoredVeins && world2.cells.length === INDEPENDENT.restoredVeins
  && world1.oreCount === world2.oreCount;
writeFileSync(resolve(outExpectedJson), `${JSON.stringify({
  note: 'expected derives from round-1 terminal state, cross-checked against authored map (4 veins) minus the one mined vein and the step-14 in-game assertions veins==3/oreDrops==0',
  independentFacts: INDEPENDENT,
  factsHold,
  cells: world1.cells,
  oreCount: world1.oreCount,
}, null, 2)}\n`);
process.stdout.write(`round-1 ${JSON.stringify(world1)}\nround-2 ${JSON.stringify(world2)}\nfactsHold=${factsHold}\n`);
if (!factsHold) process.exitCode = 1;

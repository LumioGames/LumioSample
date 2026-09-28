#!/usr/bin/env node
/**
 * R-00588 单轮压测编排（v0.0.2 验收起进仓；上一轮是未进仓的 .run/stress-round.mjs）。
 *
 * 一轮 = 全新 Platform 库（compose down -v → up，独立初始数据）→ Tools/stress-move.mjs
 * （驱动 Tools/launcher.mjs：100 Bot 错峰 1200 ms 准入、5 宿主 × 20 账号打包
 * --fleet-per-process 20、300 s 移动窗口、全程十四步含 step 14 冷重启）→ fleet 全员准入后
 * integration/stress-r588/observe-replicas.mjs 起五观察者（AC4，经 Platform wsUrl 直连 DS）→
 * 压测结束 compose down -v。判定不属于这里：只认 verify-rounds.mjs。
 *
 * 调用的仓内工具：
 *   Tools/stress-move.mjs            100 Bot 移动压测 + 十四步（其内部再调 Tools/launcher.mjs）
 *   Tools/launcher.mjs               经 stress-move 驱动；DS 由它从 Engine/ 起
 *   integration/stress-r588/observe-replicas.mjs  五观察者逐帧记录
 *   HostEntry TickSampleExport       经 LUMIO_TICK_SAMPLE_DIR 落 tick-phase/allocation-samples CSV
 *
 * Usage: node integration/stress-r588/run-round.mjs <roundDir> [loginPrefix]
 *   环境变量（可选）：LUMIO_BOT_ADMIT_STAGGER_MS（默认 1200，组内准入错峰）
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENGINE = join(ROOT, 'Engine');
const COMPOSE = join(ENGINE, 'platform', 'docker-compose.yml');
const PROJECT = 'lumio-sample-platform';
const ORIGIN = 'http://127.0.0.1:8080';
const SCENARIO_DLL = join(ROOT, 'Client', 'Bots', 'bin', 'Debug', 'net10.0', 'Lumio.Sample.Bots.dll');
const FLEET_PER_PROCESS = 20;
const BOTS = 100;
const STAGGER_MS = 1200;
const WINDOW_MS = 300000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const roundDir = resolve(process.argv[2]);
if (!roundDir) throw new Error('usage: node run-round.mjs <roundDir> [loginPrefix]');
// 前缀绝不能以数字结尾：Bot.Host 把 --account-from/--account-to 当「前缀+整数区间」解析
// （尾随数字会被当成区间起点，两轮若带时间戳会把全部 Bot 折叠进同一个账号名）。
const prefix = process.argv[3] ?? 'AcctWq';
mkdirSync(join(roundDir, 'tick-samples'), { recursive: true });
mkdirSync(join(roundDir, 'observers'), { recursive: true });

function sh(file, args, env = process.env) {
  const result = spawnSync(file, args, { encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

const composeEnv = () => ({
  ...process.env,
  LUMIO_PLATFORM_IMAGE: String(JSON.parse(readFileSync(join(ENGINE, 'manifest.json'), 'utf8')).platformImage ?? ''),
  LUMIO_GAME_PLATFORM_DIR: join(ROOT, 'Tools', 'compose'),
});

function compose(args) {
  const result = sh('docker', ['compose', '-f', COMPOSE, '-p', PROJECT, ...args], composeEnv());
  writeFileSync(join(roundDir, `platform-${args[0]}.log`), result.output);
  return result;
}

/** 覆盖模板：绝对路径化 + 固定监听 9110（Platform 分配的 wsUrl 指这里，观察者经它入场）。 */
function writeDsOverlay() {
  const templatePath = join(ROOT, 'Server', 'Config', 'Startup', 'server.json');
  const template = JSON.parse(readFileSync(templatePath, 'utf8'));
  const base = dirname(templatePath);
  const absolute = (value) => (typeof value === 'string' && value !== '' ? resolve(base, value) : value);
  template.clr = { ...template.clr };
  template.clr.registry_assembly = absolute(template.clr.registry_assembly);
  template.config_dir = absolute(template.config_dir);
  template.voxel_catalog = absolute(template.voxel_catalog);
  template.base_map_path = absolute(template.base_map_path);
  template.transport = { ...template.transport, listen_port: 9110 };
  const path = join(roundDir, 'server.overlay.json');
  writeFileSync(path, `${JSON.stringify(template, null, 2)}\n`);
  return path;
}

async function platformUp() {
  compose(['down', '-v', '--remove-orphans']);
  const up = compose(['up', '-d']);
  if (up.status !== 0) throw new Error(`docker compose up failed: ${up.output.split('\n').slice(-3).join(' | ')}`);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${ORIGIN}/healthz`);
      if (response.ok) return;
    } catch { /* not yet */ }
    await sleep(1000);
  }
  throw new Error('Platform /healthz did not come up within 120s');
}

async function admittedCount() {
  let admitted = 0;
  for (let index = 1; index <= BOTS; index += 1) {
    const path = join(roundDir, 'launcher', `bot-${index}`, 'admission-events.ndjson');
    if (existsSync(path) && readFileSync(path, 'utf8').includes('"meaning":"ticket_accepted"')) admitted += 1;
  }
  return admitted;
}

await platformUp();
const env = {
  ...process.env,
  LUMIO_ACCOUNT_PASSWORD: 'LumioStressRound-v002',
  // R-00588：组内准入错峰（LumioClient#159）；25ms 默认在 20 账号/进程下会触发 DS 并发准入失败。
  LUMIO_BOT_ADMIT_STAGGER_MS: process.env.LUMIO_BOT_ADMIT_STAGGER_MS ?? '1200',
  // HostEntry 故障详情出口：tick 异常的完整类型+消息落这里（DS 日志只留 runtime_failure）。
  LUMIO_HOSTENTRY_FAULT_LOG: join(roundDir, 'hostentry-fault.log'),
  LUMIO_DS_CONFIG: writeDsOverlay(),
  LUMIO_SCENARIO_DLL: SCENARIO_DLL,
  LUMIO_TICK_SAMPLE_DIR: join(roundDir, 'tick-samples'),
};
const args = [
  'Tools/stress-move.mjs',
  '--origin', ORIGIN,
  '--bots', String(BOTS),
  '--stagger-ms', String(STAGGER_MS),
  '--timeout-ms', '900000',
  '--fleet-per-process', String(FLEET_PER_PROCESS),
  '--duration-ms', String(WINDOW_MS),
  '--login-prefix', prefix,
  '--evidence-dir', join(roundDir, 'launcher'),
];
console.log('$ node', args.join(' '));
const stress = spawn(process.execPath, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
const logTo = (stream, file) => {
  const chunks = [];
  stream.on('data', (bytes) => { chunks.push(bytes); process.stdout.write(bytes); });
  stream.on('end', () => writeFileSync(join(roundDir, file), Buffer.concat(chunks)));
};
logTo(stress.stdout, 'stress-move.out');
logTo(stress.stderr, 'stress-move.err');

// 等 fleet 全员准入（上限 10 分钟：100×1.2s 出票 + spawn + 握手 + tour 排队），再起观察者。
const deadline = Date.now() + 10 * 60 * 1000;
while (Date.now() < deadline && await admittedCount() < BOTS) {
  await sleep(5000);
}
const admitted = await admittedCount();
console.log(`admitted=${admitted}; starting observers`);
if (admitted === BOTS) {
  const observers = spawn(process.execPath, ['integration/stress-r588/observe-replicas.mjs',
    '--origin', ORIGIN,
    '--out-dir', join(roundDir, 'observers'),
    '--prefix', 'AcctObsR',
    '--hold-seconds', '300'], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });
  await new Promise((resolveExit) => observers.on('exit', resolveExit));
} else {
  console.error('fleet never fully admitted; skipping observers (round will FAIL verification honestly)');
}

const code = await new Promise((resolveExit) => stress.on('exit', resolveExit));
console.log(`stress-move exit=${code}`);
compose(['down', '-v', '--remove-orphans']);
process.exitCode = code;

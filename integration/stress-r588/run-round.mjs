#!/usr/bin/env node
/**
 * R-00588 单轮压测编排（v0.0.2 验收起进仓；上一轮是未进仓的 .run/stress-round.mjs）。
 *
 * 一轮 = Platform 账号库（见 ADR-133）→ Tools/stress-move.mjs（驱动 Tools/launcher.mjs：
 * 100 Bot 错峰 1200 ms 准入、5 宿主 × 20 账号打包 --fleet-per-process 20、300 s 移动窗口、
 * 全程十四步含 step 14 冷重启）→ fleet 全员准入后 integration/stress-r588/observe-replicas.mjs
 * 起五观察者（AC4，经 Platform wsUrl 直连 DS）→ 压测结束摘录 DS 准入/关闭日志 →
 * 按编排模式收 Platform。判定不属于这里：只认 verify-rounds.mjs。
 *
 * ADR-133（补充 ADR-125）：两轮必须**共用同一个 Platform（账号库）**，每轮用**全新存档 +
 * 全新 DS 进程**。玩家颜色由 Platform accountId 派生——换新 Platform 库时同一登录名会拿到
 * 不同 accountId，两轮的账号↔颜色↔实体身份必然对不上，两轮可比性随之失效。全新存档与
 * 全新 DS 进程无需额外编排：launcher 每次跑都用 mkdtemp 新 ds-store 并从 Engine/ 重新起
 * lumio-ds。因此两轮的推荐跑法（同一 loginPrefix，账号库跨轮延续）：
 *
 *   node integration/stress-r588/run-round.mjs round-1 AcctWq --keep-platform
 *   node integration/stress-r588/run-round.mjs round-2 AcctWq --reuse-platform
 *
 * 单轮独立跑（全新库、跑完即收）仍是默认行为。--reuse-platform 只认「已在跑的库」，
 * 绝不 down -v 后重建（重建即换库，违背 ADR-133，直接报错）。
 *
 * 调用的仓内工具：
 *   Tools/stress-move.mjs            100 Bot 移动压测 + 十四步（其内部再调 Tools/launcher.mjs）
 *   Tools/launcher.mjs               经 stress-move 驱动；DS 由它从 Engine/ 起
 *   integration/stress-r588/observe-replicas.mjs  五观察者逐帧记录
 *   HostEntry TickSampleExport       经 LUMIO_TICK_SAMPLE_DIR 落 tick-phase/allocation-samples CSV
 *
 * Usage: node integration/stress-r588/run-round.mjs <roundDir> [loginPrefix] [--keep-platform|--reuse-platform]
 *   环境变量（可选）：LUMIO_BOT_ADMIT_STAGGER_MS（默认 1200，组内准入错峰）
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
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

const argv = process.argv.slice(2);
const isEntry = resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url));
const roundDir = argv.find((arg) => !arg.startsWith('--')) ?? null;
const keepPlatform = argv.includes('--keep-platform');
const reusePlatform = argv.includes('--reuse-platform');
const prefixArg = argv[argv.indexOf(roundDir) + 1];
// 前缀绝不能以数字结尾：Bot.Host 把 --account-from/--account-to 当「前缀+整数区间」解析
// （尾随数字会被当成区间起点，两轮若带时间戳会把全部 Bot 折叠进同一个账号名）。
const prefix = prefixArg && !prefixArg.startsWith('--') ? prefixArg : 'AcctWq';

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

async function platformHealthy() {
  try {
    const response = await fetch(`${ORIGIN}/healthz`);
    return response.ok;
  } catch {
    return false;
  }
}

async function platformUp() {
  if (reusePlatform) {
    // ADR-133：第二轮只复用第一轮留下的账号库；库不在跑是编排错误（先跑 round-1
    // --keep-platform），这里绝不「顺手重建」——重建即换库，accountId 全变。
    if (await platformHealthy()) return;
    throw new Error('ADR-133 --reuse-platform: Platform is not running; run round-1 with --keep-platform first (a fresh compose would mint new accountIds and break the two-round comparability)');
  }
  compose(['down', '-v', '--remove-orphans']);
  const up = compose(['up', '-d']);
  if (up.status !== 0) throw new Error(`docker compose up failed: ${up.output.split('\n').slice(-3).join(' | ')}`);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    if (await platformHealthy()) return;
    await sleep(1000);
  }
  throw new Error('Platform /healthz did not come up within 120s');
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

/** 准入/关闭相关的 DS 日志行（host.admit / host.expire / host.connection_close）。 */
export const DS_ADMISSION_CLOSE_LINE = /target=host\.(admit|expire|connection_close)\b/;

/** 脱敏：id 类字段短哈希化（同一原始 id 跨行仍可对齐），凭证类字段整段剔除。 */
export function redactDsLogLine(line) {
  const idHash = (kind, value) => `${kind}-r${createHash('sha256').update(`${kind}:${value}`).digest('hex').slice(0, 8)}`;
  return line
    .replace(/\b(conn|account|observer_id|player|session|ticket_id)=([^\s"\\]+)/g, (_all, kind, value) => `${kind}=${idHash(kind, value)}`)
    .replace(/\b(ticket|token|password|credential|secret|authorization|admission_key|key)=("([^"]*)"|[^\s"\\]+)/gi, '<redacted>');
}

/**
 * 每轮自动落 DS 准入/关闭摘录（补 v0.0.2 的缺口：verdict.md 引用了
 * round-N/ds-admission-close-excerpt.log，但该文件从未入仓，48 条关闭行
 * 因此无法在仓内逐行复核）。摘录源：DS stdout（lumio-ds*.log）与 post-office
 * 日志目录（ds-boot-N/*.log，launcher 的 logging.dir）。
 */
export function writeDsAdmissionCloseExcerpt(roundDirPath) {
  const launcherDir = join(roundDirPath, 'launcher');
  const sources = [
    join(launcherDir, 'lumio-ds.log'),
    join(launcherDir, 'lumio-ds.boot-2.log'),
  ];
  for (const boot of ['ds-boot-1', 'ds-boot-2']) {
    const dir = join(launcherDir, boot);
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir).sort()) {
      if (name.endsWith('.log')) sources.push(join(dir, name));
    }
  }
  const header = [
    '# R-00588 DS admission/close excerpt (auto-generated by run-round.mjs)',
    `# round: ${resolve(roundDirPath)}`,
    `# generatedAt: ${new Date().toISOString()}`,
    '# sources: candidate files listed below; lines matched /target=host.(admit|expire|connection_close)/',
    '# redaction: id-like fields short-hashed (stable per original id); credential-like fields removed',
  ];
  const perSource = [];
  const lines = [];
  for (const path of sources) {
    if (!existsSync(path)) continue;
    let matched = 0;
    for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
      if (!DS_ADMISSION_CLOSE_LINE.test(line)) continue;
      matched += 1;
      lines.push(redactDsLogLine(line));
    }
    perSource.push(`${path}: ${matched} matched line(s)`);
  }
  const out = join(roundDirPath, 'ds-admission-close-excerpt.log');
  writeFileSync(out, `${[...header, ...perSource.map((entry) => `# ${entry}`), '', ...lines].join('\n')}\n`);
  return { out, matched: lines.length, sources: perSource.length };
}

async function admittedCount() {
  let admitted = 0;
  for (let index = 1; index <= BOTS; index += 1) {
    const path = join(roundDir, 'launcher', `bot-${index}`, 'admission-events.ndjson');
    if (existsSync(path) && readFileSync(path, 'utf8').includes('"meaning":"ticket_accepted"')) admitted += 1;
  }
  return admitted;
}

async function main() {
  if (!roundDir) throw new Error('usage: node run-round.mjs <roundDir> [loginPrefix] [--keep-platform|--reuse-platform]');
  if (keepPlatform && reusePlatform) throw new Error('--keep-platform (round 1) and --reuse-platform (round 2) are mutually exclusive');
  mkdirSync(join(roundDir, 'tick-samples'), { recursive: true });
  mkdirSync(join(roundDir, 'observers'), { recursive: true });
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
  const excerpt = writeDsAdmissionCloseExcerpt(roundDir);
  console.log(`ds-admission-close-excerpt: ${excerpt.matched} line(s) from ${excerpt.sources} source file(s) -> ${excerpt.out}`);
  if (keepPlatform) {
    // ADR-133：第一轮跑完保留 Platform，第二轮 --reuse-platform 接着用同一账号库。
    console.log('keeping Platform up for the next round (ADR-133: shared account store across the two rounds)');
  } else {
    compose(['down', '-v', '--remove-orphans']);
  }
  process.exitCode = code;
}

if (isEntry) await main();

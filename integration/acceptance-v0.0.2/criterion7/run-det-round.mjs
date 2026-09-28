#!/usr/bin/env node
/**
 * 判据 7 编排（v0.0.2 验收）：两轮独立新进程 + 独立初始数据（每轮全新 Platform 库、
 * 全新运行目录、全新存档），同账号、同底图；record-round.mjs 录流 → derive-rounds.mjs
 * 派生 → Tools/verify-evidence.mjs 判定（真值来源），结果落本目录，不碰旧的
 * integration/determinism/det-verify/。
 *
 * Usage:
 *   node run-det-round.mjs all <outDir> <account>     # 两轮 + 判定，一条命令
 *   node run-det-round.mjs round <roundDir> <account> # 单轮（编排细节可复跑）
 *   node run-det-round.mjs verify <outDir>            # 对 <outDir>/round-{1,2} 判定
 *
 * 单轮流程：compose 起新库 Platform（engine 发布物 compose + Tools/compose 输入，与本机
 * docker→WSL 转发 shim 兼容）→ 起 record-round 观察者（同账号 <account>Obs）→ 启动器
 * `--bots 1 --login-prefix <account>` 跑十四步（tour bot = 唯一 bot，游走种子=账号名）→
 * 启动器退出 DS 关闭、观察者随之收流 → compose down -v 删库。
 */
import { spawn, spawnSync } from 'node:child_process';
import { loginAndLaunch } from '../../../Tools/account-client.mjs';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const ENGINE = join(ROOT, 'Engine');
const COMPOSE = join(ENGINE, 'platform', 'docker-compose.yml');
const PROJECT = 'lumio-sample-platform';
const ACCOUNT_PASSWORD = 'LumioAcceptance-v002-c7';
const DS_PORT = 9110;
const BASE_MAP = join(ROOT, 'Server', 'Assets', 'Maps', 'sample.voxel');
const SCENARIO_DLL = join(ROOT, 'Client', 'Bots', 'bin', 'Debug', 'net10.0', 'Lumio.Sample.Bots.dll');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sh(file, args, opts = {}) {
  return spawnSync(file, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
}

const composeEnv = () => ({
  ...process.env,
  LUMIO_PLATFORM_IMAGE: String(JSON.parse(readFileSync(join(ENGINE, 'manifest.json'), 'utf8')).platformImage ?? ''),
  LUMIO_GAME_PLATFORM_DIR: join(ROOT, 'Tools', 'compose'),
});

function compose(args) {
  const result = sh('docker', ['compose', '-f', COMPOSE, '-p', PROJECT, ...args], { env: composeEnv(), cwd: ROOT });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

async function platformUp(roundDir) {
  compose(['down', '-v', '--remove-orphans']); // 上一轮的库必须删掉：独立初始数据
  const up = compose(['up', '-d']);
  writeFileSync(join(roundDir, 'platform-up.log'), up.output);
  if (up.status !== 0) throw new Error(`docker compose up failed: ${up.output.split('\n').slice(-3).join(' | ')}`);
  const deadline = Date.now() + 120000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch('http://127.0.0.1:8080/healthz');
      if (response.ok) return;
    } catch { /* not yet */ }
    await sleep(1000);
  }
  throw new Error('Platform /healthz did not come up within 120s');
}

/** 覆盖模板：绝对路径化（相对路径按提交模板目录解析）+ 固定监听口，供启动器派生 per-run 配置。 */
function writeDsOverlay(roundDir) {
  const templatePath = join(ROOT, 'Server', 'Config', 'Startup', 'server.json');
  const template = JSON.parse(readFileSync(templatePath, 'utf8'));
  const base = dirname(templatePath);
  const absolute = (value) => (typeof value === 'string' && value !== '' ? resolve(base, value) : value);
  template.clr = { ...template.clr };
  template.clr.registry_assembly = absolute(template.clr.registry_assembly);
  template.config_dir = absolute(template.config_dir);
  template.voxel_catalog = absolute(template.voxel_catalog);
  template.base_map_path = absolute(template.base_map_path);
  template.transport = { ...template.transport, listen_port: DS_PORT };
  const path = join(roundDir, 'server.overlay.json');
  writeFileSync(path, `${JSON.stringify(template, null, 2)}\n`);
  return path;
}

// 一对两轮共用一个 Platform（对末 down -v）：IdentityComponent.colorHue 由 Platform 的
// accountId 经 StableAccountHue 派生，全新 Platform 库会给同一登录名发不同 acct id，两轮
// eventOrder 必在 hue 一位上分叉（ADR-125 逐位比较包含它）；仓内已提交的通过先例同为
// 两轮共用 Platform。世界独立性由启动器每轮自己的全新存档保证。
async function runRound(roundDir, account, platformAlreadyUp = false) {
  mkdirSync(roundDir, { recursive: true });
  rmSync(join(roundDir, 'observer-raw.ndjson'), { force: true });
    if (!platformAlreadyUp) await platformUp(roundDir);
  const baseMapSha = createHash('sha256').update(readFileSync(BASE_MAP)).digest('hex');
  const overlay = writeDsOverlay(roundDir);
  const env = {
    ...process.env,
    LUMIO_ACCOUNT_PASSWORD: ACCOUNT_PASSWORD,
    LUMIO_DS_CONFIG: overlay,
    LUMIO_SCENARIO_DLL: SCENARIO_DLL,
  };

  // 入场对齐（derive-rounds 要求两轮首条世界记录同 tick）：启动器打到 step=03（DS_READY）
  // 的那一刻才放观察者——它随即 login+connect，两轮都落在「世界开后 ~1s」的窄窗里，
  // 抖动从重试周期的 ±2s 压到网络本地的 ±百毫秒。
  const launcher = spawn(process.execPath, ['Tools/launcher.mjs',
    '--origin', 'http://127.0.0.1:8080', '--bots', '1', '--login-prefix', account,
    '--evidence-dir', join(roundDir, 'launcher')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let launcherSawStep03 = false;
  const launcherLines = [];
  launcher.stdout.on('data', (bytes) => {
    const text = bytes.toString('utf8');
    launcherLines.push(text);
    process.stdout.write(text);
    if (!launcherSawStep03 && text.includes('step=03')) launcherSawStep03 = true;
  });
  launcher.stderr.on('data', (bytes) => process.stdout.write(bytes.toString('utf8')));
  while (!launcherSawStep03) {
    const exited = launcher.exitCode !== null;
    if (exited) break;
    await sleep(100);
  }
  const recorder = spawn(process.execPath, ['integration/determinism/record-round.mjs',
    '--origin', 'http://127.0.0.1:8080', '--account', `${account}Obs`,
    '--out', join(roundDir, 'observer-raw.ndjson'), '--base-map-sha', baseMapSha,
    '--retry-seconds', '300'], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });
  const tourCode = await new Promise((resolveExit) => launcher.on('exit', resolveExit));
  const recorderCode = await Promise.race([
    new Promise((resolveExit) => recorder.on('exit', resolveExit)),
    new Promise((r) => setTimeout(() => r('timeout'), 120000)),
  ]);
  if (recorderCode === 'timeout') recorder.kill();

  const launcherReport = join(roundDir, 'launcher', 'verification.json');
  const stepsOk = existsSync(launcherReport)
    && JSON.parse(readFileSync(launcherReport, 'utf8')).status === 'PASS';
  // record-round 收完流写 recorder-done.json 后不显式 process.exit（注释：让事件循环自然
  // 排空）；Windows 上残留句柄会让进程挂着——判据看 done 标记与 worldChanges，不看进程码。
  const doneMarker = existsSync(join(roundDir, 'recorder-done.json'))
    ? JSON.parse(readFileSync(join(roundDir, 'recorder-done.json'), 'utf8')) : null;
  const recorderOk = Boolean(doneMarker && doneMarker.worldChanges > 0);
  console.log(`round ${roundDir.split(/[\\/]/).pop()}: tour exit=${tourCode} recorder=${recorderOk ? `worldChanges=${doneMarker.worldChanges} close=${doneMarker.closeCode}` : 'INCOMPLETE'} launcher14=${stepsOk ? 'PASS' : 'FAIL'}`);
  return tourCode === 0 && recorderOk && stepsOk;
}

function verify(outDir) {
  const round1 = join(outDir, 'round-1');
  const round2 = join(outDir, 'round-2');
  for (const dir of [round1, round2]) {
    if (!existsSync(join(dir, 'observer-raw.ndjson'))) throw new Error(`missing ${dir}/observer-raw.ndjson`);
  }
  const verifyDir = join(outDir, 'verify');
  rmSync(verifyDir, { recursive: true, force: true });
  mkdirSync(join(verifyDir, 'round-1'), { recursive: true });
  mkdirSync(join(verifyDir, 'round-2'), { recursive: true });
  cpSync(join(round1, 'observer-raw.ndjson'), join(verifyDir, 'round-1', 'observer-raw.ndjson'));
  cpSync(join(round2, 'observer-raw.ndjson'), join(verifyDir, 'round-2', 'observer-raw.ndjson'));
  const derive = sh(process.execPath, ['integration/determinism/derive-rounds.mjs',
    join(verifyDir, 'round-1'), join(verifyDir, 'round-2'), join(verifyDir, 'expected.json')], { cwd: ROOT });
  writeFileSync(join(verifyDir, 'derive-rounds.out'), `${derive.stdout ?? ''}${derive.stderr ?? ''}`);
  process.stdout.write(`${derive.stdout ?? ''}${derive.stderr ?? ''}`);
  if (derive.status !== 0) return false; // 入场 tick 不齐等：整对重跑，由 all 的重试环决定
  const verdict = sh(process.execPath, ['Tools/verify-evidence.mjs', '--dir', verifyDir], { cwd: ROOT });
  writeFileSync(join(verifyDir, 'verify-evidence.out'), `${verdict.stdout ?? ''}${verdict.stderr ?? ''}`);
  process.stdout.write(`${verdict.stdout ?? ''}${verdict.stderr ?? ''}`);
  return verdict.status === 0;
}

const [mode, outDir, account] = process.argv.slice(2);
if (mode === 'round') {
  process.exit((await runRound(resolve(outDir), account)) ? 0 : 1);
} else if (mode === 'verify') {
  process.exit(verify(resolve(outDir)) ? 0 : 1);
} else if (mode === 'all') {
  const dir = resolve(outDir);
  mkdirSync(dir, { recursive: true });
  // derive-rounds 的入场对齐契约：两轮首条世界记录必须同 tick。入场时刻相对 DS 开世界
  // 有 ±秒级抖动，一对不齐就整对重跑（derive 工具自己的建议），最多三对。
  const maxPairs = Number(process.env.C7_MAX_PAIRS ?? 3);
  for (let pair = 1; pair <= maxPairs; pair += 1) {
    await platformUp(dir);
    // 预热注册：首轮要为两个账号走 register（比纯登录多 ~2-4 tick 的入场偏移，
    // 两轮 eventOrder 的首 tick 就永远对不齐）。先各登一次把账号建好，两轮等条件。
    const warmEnv = { ...process.env, LUMIO_ACCOUNT_PASSWORD: ACCOUNT_PASSWORD };
    await loginAndLaunch({ origin: 'http://127.0.0.1:8080', loginName: account, slug: 'sample', env: warmEnv, log: () => {} });
    await loginAndLaunch({ origin: 'http://127.0.0.1:8080', loginName: account + 'Obs', slug: 'sample', env: warmEnv, log: () => {} });
    const round1 = await runRound(join(dir, 'round-1'), account, true);
    const round2 = await runRound(join(dir, 'round-2'), account, true);
    compose(['down', '-v', '--remove-orphans']);
    if (!round1 || !round2) {
      console.error('a round failed; not verifying');
      process.exit(1);
    }
    if (verify(dir)) process.exit(0);
    console.error(`pair ${pair} did not verify; ${pair < maxPairs ? 'rerunning both rounds' : 'giving up'}`);
  }
  process.exit(1);
} else {
  console.error('usage: node run-det-round.mjs all <outDir> <account> | round <roundDir> <account> | verify <outDir>');
  process.exit(2);
}

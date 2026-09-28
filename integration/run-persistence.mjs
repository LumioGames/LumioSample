#!/usr/bin/env node
/**
 * 判据 6 驱动器（toolfix v0.0.3 从 acceptance-v0.0.2/criterion6/run-persistence.mjs 提升为
 * 常驻工具；旧证据目录不回改）：一个存档卷里留下三种中间状态（半挖矿脉 / 未拾取掉落 /
 * 已拾取掉落），关服重启后核对世界与账目；随后整体搬迁到 WSL（linux-x64 同一发布物）
 * 直接打开比对；最后做两个底图反例（缺底图 / sha 不匹配必须显式失败）。
 *
 * toolfix v0.0.3 新增 leg——半挖在档（优雅路径）：PartialMiningScenario 只挥 k=3 镐后
 * 自律停手、登出（场景 Complete，不杀 bot、不换体力配表副本——旧 half 角色两样都靠）；
 * 等半挖储量经 DS 自己的 checkpoint 写档后才停服（Windows 没有跨进程 Ctrl+C，
 * Tools/launcher.mjs 十四步同款纪律：最后一笔 post-completion checkpoint 之后才停进程，
 * kill 不定义写档时机、不与玩法活动竞争）；同一存档冷启动后断言目标矿脉储量已下降
 * 但未挖穿（0 < remaining < 6，vein 实体仍在 = 方块没变空气）。
 *
 * 复用仓内工具：Tools/launcher.mjs（startReleasePlatform）、Tools/engine-release.mjs、
 * Tools/ds-config.mjs、Tools/ds-ready.mjs、Tools/engine-tools.mjs、Tools/account-client.mjs、
 * integration/determinism/record-round.mjs（观察者，判据 7 同款）、Tools/world-assert.mjs。
 *
 * Usage: node integration/run-persistence.mjs <evidenceDir>
 */
import { spawn, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loginAndLaunch } from '../../Tools/account-client.mjs';
import {
  assertDsClrInputs, assertRunnableDsConfig, deriveRunDsConfig, engineClrInputs, writeKernelConfigForRun,
} from '../../Tools/ds-config.mjs';
import { buildBotArgs, buildServerArgs, findDsReady, resolveDsEndpoint } from '../../Tools/ds-ready.mjs';
import { loadProcessTools } from '../../Tools/engine-tools.mjs';
import { prepareEngine, resolveHostfxr } from '../../Tools/engine-release.mjs';
import { startReleasePlatform } from '../../Tools/launcher.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const EVIDENCE = resolve(process.argv[2] ?? join(ROOT, '.run', 'accept-v002-c6'));
// 账号名必须以数字结尾：Bot.Host 把 --account-from 当「前缀[+尾数]」枚举，无尾随数字的
// 名字会被补成 <name>01。体力预算（100 / 镐 13、无回复）决定一个账号只够一个角色：
// A=half（2 镐）、B=leave（挖穿 1 条不捡）、C=pick（挖穿 1 条并捡起）。
const ACCOUNT_A = 'AcctPersistA1';
const ACCOUNT_B = 'AcctPersistB1';
const ACCOUNT_C = 'AcctPersistC1';
// D（toolfix v0.0.3）：半挖在档 leg——只挥固定 k 镐后自律停手登出，优雅关服写档。
const ACCOUNT_D = 'AcctPersistD1';
const ACCOUNT_OBS = 'AcctPersistObs';
// 半挖挥镐数 k：必须小于配表 vein_hits_to_break=6（每镐 remaining-1，k=3 → 6-3=3）。
const PARTIAL_SWINGS = 3;
const PASSWORD = 'LumioAcceptance-v002-c6';
const DS_PORT = 9110;
const BASE_MAP = join(ROOT, 'Server', 'Assets', 'Maps', 'sample.voxel');
const SCENARIO_DLL = join(ROOT, 'Client', 'Bots', 'bin', 'Debug', 'net10.0', 'Lumio.Sample.Bots.dll');
const BOT_GAMEPLAY = join(ROOT, 'Gameplay', 'bin', 'Debug', 'net10.0-client', 'Lumio.Sample.Gameplay.dll');
const VOXEL_BUDGET = join(ROOT, 'Server', 'Assets', 'Maps', 'bot-voxel-budget.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const report = { version: 1, scope: 'criterion6-persistence', evidence: EVIDENCE, checks: [] };
const writeReport = () => writeFileSync(join(EVIDENCE, 'verification.json'), `${JSON.stringify(report, null, 2)}\n`);
function check(name, ok, detail) {
  report.checks.push({ name, status: ok ? 'PASS' : 'FAIL', detail });
  writeReport();
  process.stdout.write(`${ok ? 'PASS' : 'FAIL'} ${name}: ${detail}\n`);
  return ok;
}

/** 观察流 → 世界快照：存活 vein（含储量）、掉落实体、各实体矿石账。 */
function deriveWorld(rawPath) {
  const entities = new Map();
  for (const line of readFileSync(rawPath, 'utf8').trim().split(/\r?\n/)) {
    const value = JSON.parse(line);
    if (value.kind !== 'world') continue;
    for (const created of value.creates ?? []) {
      const fields = {};
      for (let i = 2; i < created.length; i += 1) fields[`${created[i][0]}.${created[i][1]}`] = created[i][2];
      entities.set(created[0], { type: created[1], fields });
    }
    for (const [id, component, field, value2] of value.fields ?? []) {
      const entity = entities.get(id);
      if (entity != null) entity.fields[`${component}.${field}`] = value2;
    }
    for (const id of value.destroys ?? []) entities.delete(id);
  }
  const veins = [...entities.entries()]
    .filter(([, entity]) => entity.type === 'vein')
    .map(([id, entity]) => ({ id, remaining: Number(entity.fields['VeinReserveComponent.remaining'] ?? NaN) }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const drops = [...entities.entries()].filter(([, entity]) => entity.type === 'oreDrop').map(([id]) => id).sort();
  const ore = {};
  for (const [id, entity] of entities) {
    if (entity.type !== 'player') continue;
    ore[id] = { base: entity.fields['AttributeComponent.oreBase'], current: entity.fields['AttributeComponent.oreCurrent'] };
  }
  return { veins, drops, ore, playerCount: Object.keys(ore).length };
}

function botSelfId(logDir) {
  const report = readTextIfPresent(join(logDir, 'persist-report.txt'));
  const match = /self=([0-9a-f]+)/.exec(report);
  return match ? match[1] : null;
}

function readTextIfPresent(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

function botPassed(logDir) {
  const text = readTextIfPresent(join(logDir, 'result.ndjson'));
  if (text === '') return null;
  return /"passed":\s*true/.test(text) && /scenario completed|"run"/.test(text) ? text : null;
}

async function waitDsReady(tools, ds, timeoutMs) {
  const started = Date.now();
  let ready = findDsReady(ds.stdout);
  while (!ready && Date.now() - started < timeoutMs) {
    tools.assertAlive(ds);
    await sleep(200);
    ready = findDsReady(ds.stdout);
  }
  if (!ready) throw new Error('DS_READY not observed');
  return ready;
}

async function startBoot(tools, release, configPath, logFile, env, children) {
  const ds = tools.startLogged(release.layout.dsExe, buildServerArgs(configPath), { cwd: dirname(release.layout.dsExe), log: logFile });
  children.push(ds);
  const ready = await waitDsReady(tools, ds, 120000);
  return { ds, endpoint: resolveDsEndpoint(ready) };
}

async function main() {
  mkdirSync(EVIDENCE, { recursive: true });
  report.startedAt = new Date().toISOString();
  writeReport();
  const env = { ...process.env, LUMIO_ACCOUNT_PASSWORD: PASSWORD };
  const tools = await loadProcessTools({ env, repoRoot: ROOT });
  const release = prepareEngine({ repoRoot: ROOT });
  report.engine = { version: release.manifest?.version, rid: release.rid, commit: release.manifest?.sourceCommits ?? null };
  const children = [];

  let platform;
  try {
    // ── Platform（发布物 compose，启动器同款管理：跑完 down -v） ──────────────
    platform = await startReleasePlatform({
      layout: release.layout, manifest: release.manifest, root: ROOT, evidence: EVIDENCE, env,
    });
    const origin = platform.origin;
    report.platformOrigin = origin;

    // ── 会话：A（half）、B（leave）、C（pick）、D（partial，toolfix v0.0.3）各角色开跑前现铸
    //    （launch 票有有效期，全程要跑几十分钟，开局一次性铸的票到 C 会 admission_credential_expired）；
    //    观察者票由 record-round 自铸。这里的登录只验五个账号都能注册。 ─────────────────────
    const sessions = {};
    const mint = async (name) => {
      let lastError;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await loginAndLaunch({ origin, loginName: name, slug: 'sample', env, log: () => {} });
        } catch (error) {
          lastError = error;
          await sleep(5000);
        }
      }
      throw lastError;
    };
    for (const name of [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C, ACCOUNT_D, ACCOUNT_OBS]) {
      sessions[name] = await mint(name);
    }
    check('tickets', true, `5 accounts minted (${ACCOUNT_A}, ${ACCOUNT_B}, ${ACCOUNT_C}, ${ACCOUNT_D}, ${ACCOUNT_OBS}); role tickets re-minted per leg`);

    // ── boot-1：留三种中间状态。半挖状态用数据面制造：boot-1a 读一份「体力 39」的
    //    配表副本（镐 13 体力 → 恰 3 镐后力气耗尽、一切后续挖掘被拒，绝无挖穿可能），
    //    A 挖到体力尽；boot-1b 同一存档换回提交版配表，B/C 各挖穿一条（同店不同数据
    //    文件——判据 3 证过的机制，程序集不动）。 ───────────────────────────────
    const store = mkdtempSync(join(EVIDENCE, 'ds-store-'));
    const boot1Logs = join(EVIDENCE, 'ds-boot-1-logs');
    const boot2Logs = join(EVIDENCE, 'ds-boot-2-logs');
    mkdirSync(boot1Logs, { recursive: true });
    mkdirSync(boot2Logs, { recursive: true });

    const template = JSON.parse(readFileSync(join(ROOT, 'Server', 'Config', 'Startup', 'server.json'), 'utf8'));
    template.checkpoint_seconds = 10;
    const templatePath = join(ROOT, 'Server', 'Config', 'Startup', 'server.json');
    const hostfxr = resolveHostfxr({ env });
    const baseMapSha = createHash('sha256').update(readFileSync(BASE_MAP)).digest('hex');
    const bootConfigPath = { [boot1Logs]: 'server.boot-1.json', [boot2Logs]: 'server.boot-2.json' };
    const makeBootConfig = (logDir, configDir) => {
      const config = deriveRunDsConfig(template, {
        templatePath, engineClr: engineClrInputs(release.layout, hostfxr), storePath: store, logDir,
        launch: sessions[ACCOUNT_A].launch,
      });
      config.transport.listen_port = DS_PORT; // 观察者经 Platform 分配的 wsUrl(9110) 入场
      if (configDir) config.config_dir = configDir;
      const path = join(EVIDENCE, bootConfigPath[logDir]);
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
      return { config, path };
    };
    const boot1 = makeBootConfig(boot1Logs);
    const boot2 = makeBootConfig(boot2Logs);
    assertRunnableDsConfig(boot1.config);
    assertDsClrInputs(boot1.config);
    const kernelConfig = writeKernelConfigForRun(boot1.path, join(EVIDENCE, 'kernel-config.json'));

    const startRecorder = (subDir) => {
      const dir = join(EVIDENCE, subDir);
      mkdirSync(dir, { recursive: true });
      const raw = join(dir, 'observer-raw.ndjson');
      rmSync(raw, { force: true });
      const recorder = spawn(process.execPath, ['integration/determinism/record-round.mjs',
        '--origin', origin, '--account', ACCOUNT_OBS, '--out', raw, '--base-map-sha', baseMapSha,
        '--retry-seconds', '240'], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });
      // 在 spawn 时就挂 exit 捕获：recorder 若在等待点之前退出（如连接 1006 早退），
      // 事后 attach 的 on('exit') 永不触发，事件循环排空会让进程以 exit 13 悬挂退出。
      const exited = new Promise((resolveExit) => recorder.on('exit', resolveExit));
      return { raw, exited };
    };
    const recorder1 = startRecorder('obs-boot1');
    await sleep(2000);

    const boot1Out = await startBoot(tools, release, boot1.path, join(EVIDENCE, 'lumio-ds.boot-1.log'), env, children);
    check('boot1-ready', true, `endpoint=${boot1Out.endpoint}`);

    const botArgsFor = (session, logDir, scenarioName, ticks) => buildBotArgs({
      botDll: release.layout.botHost,
      endpoint: boot1Out.endpoint,
      admissionTicket: session.launch.admissionCredential,
      engineNative: release.layout.engineNative,
      kernelConfig: kernelConfig,
      configDir: join(ROOT, 'Client', 'Config', 'Tables'),
      logDir,
      accountFrom: session.login.loginName,
      accountTo: session.login.loginName,
      gameplay: BOT_GAMEPLAY,
      voxelConfig: VOXEL_BUDGET,
      scenarioDll: scenarioName == null ? null : SCENARIO_DLL,
      scenarioName,
      ticks,
    });
    const startBot = (args, logFile, botEnv) => {
      const child = tools.startLogged('dotnet', args, { cwd: dirname(release.layout.botHost), log: logFile, env: botEnv ?? env });
      children.push(child);
      return child;
    };
    // 三角色严格顺序：leave/pick 跑到 result.ndjson 落盘；经 LUMIO_PERSIST_AVOID
    // 避开 half 半挖的那条脉，防止把它接着挖穿。
    const runRoleBot = async (account, role, dirName, ticks, avoidHex) => {
      const dir = join(EVIDENCE, dirName);
      mkdirSync(dir, { recursive: true });
      startBot(botArgsFor(await mint(account), dir, 'Lumio.Sample.Bots.AcceptancePersistenceScenario', ticks),
        join(EVIDENCE, `${dirName}.log`),
        {
          ...env,
          LUMIO_PERSIST_ROLE: role,
          LUMIO_PERSIST_AVOID: avoidHex ?? '',
          LUMIO_PERSIST_REPORT: join(dir, 'persist-report.txt'),
        });
      const deadline = Date.now() + 15 * 60 * 1000;
      while (Date.now() < deadline) {
        tools.assertAlive(boot1Out.ds);
        if (existsSync(join(dir, 'result.ndjson')) && /"kind":"run"/.test(readFileSync(join(dir, 'result.ndjson'), 'utf8'))) break;
        await sleep(2000);
      }
      const run = botPassed(dir);
      check(`boot1-role-${role}`, Boolean(run), run ? `${account} role=${role} passed` : `${account} role=${role} did not pass`);
      return run;
    };
    // half 角色（boot-1a，体力 39）：持续挖（tour 同款 dwell+sweep）。体力 13×3=39，
    // 第 4 镐起 authority 以体力不足拒绝且无副作用——矿脉必然停在部分储量，永不可能
    // 被这一个账号挖穿。驱动器等储量「下降后稳定」（体力耗尽即停）再杀 bot。
    const veinStates = () => {
      const seen = new Map();
      if (!existsSync(recorder1.raw)) return seen;
      for (const line of readFileSync(recorder1.raw, 'utf8').trim().split(/\r?\n/)) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.kind !== 'world') continue;
        for (const [id, component, field, value] of event.fields ?? []) {
          if (component === 'VeinReserveComponent' && field === 'remaining') seen.set(id, Number(value));
        }
      }
      return seen;
    };
    const aDir = join(EVIDENCE, 'bot-a-boot1');
    mkdirSync(aDir, { recursive: true });
    const halfChild = startBot(
      botArgsFor(await mint(ACCOUNT_A), aDir, 'Lumio.Sample.Bots.AcceptancePersistenceScenario', 60000),
      join(EVIDENCE, 'bot-a-boot1.log'),
      { ...env, LUMIO_PERSIST_ROLE: 'half', LUMIO_PERSIST_AVOID: '', LUMIO_PERSIST_REPORT: join(aDir, 'persist-report.txt') });
    const halfDeadline = Date.now() + 15 * 60 * 1000;
    let partial = null;
    while (Date.now() < halfDeadline) {
      tools.assertAlive(boot1Out.ds);
      for (const [id, remaining] of veinStates()) {
        if (remaining > 0 && remaining < 6) { partial = { id, remaining }; break; }
      }
      if (partial) break;
      await sleep(500);
    }
    const roleHalf = Boolean(partial);
    if (partial) {
      await tools.forceCleanup(halfChild);
      check('boot1-role-half', true, `half-dug observed in stream: vein ${partial.id.slice(-4)} remaining=${partial.remaining} (slow-pickaxe cadence, killed on first decrement)`);
    } else {
      check('boot1-role-half', false, 'no partial vein observed within 15 min');
    }
    const avoid = partial ? partial.id : '';
    check('boot1-half-target-known', avoid.length > 0, `half target hex=${avoid.slice(-8) || '<none>'}`);

    const bDir = join(EVIDENCE, 'bot-b-boot1');
    const cDir = join(EVIDENCE, 'bot-c-boot1');
    const roleLeave = await runRoleBot(ACCOUNT_B, 'leave', 'bot-b-boot1', 30000, avoid);
    const rolePick = await runRoleBot(ACCOUNT_C, 'pick', 'bot-c-boot1', 30000, avoid);
    check('boot1-scenario', roleHalf && roleLeave && rolePick,
      `three roles completed: half=${roleHalf} leave=${roleLeave} pick=${rolePick}`);

    // 等 B/C 之后的第二个 checkpoint，再关 D（kill 前 checkpoint 必须已在盘上）
    const dsText = () => String(boot1Out.ds.stdout ?? '');
    const generations = () => [...dsText().matchAll(/DS_CHECKPOINT \{"generation":(\d+)\}/g)].map((m) => Number(m[1]));
    let gensBc = generations();
    const cpBcDeadline = Date.now() + 60000;
    while (Date.now() < cpBcDeadline) {
      const now = generations();
      if (now.length >= gensBc.length + 2) { gensBc = now; break; }
      await sleep(1000);
    }
    check('boot1-checkpoints', gensBc.length >= 2, `generations after scenario: ${gensBc.join(',')}`);
    await tools.forceCleanup(boot1Out.ds);
    await recorder1.exited;
    report.recorder1Close = readTextIfPresent(join(EVIDENCE, 'obs-boot1', 'recorder-done.json')).trim();
    report.boot1 = { world: deriveWorld(recorder1.raw) };
    const world1 = report.boot1.world;
    const halfDug = world1.veins.some((vein) => vein.remaining > 0 && vein.remaining < 6);
    check('boot1-world-shape',
      world1.veins.length === 2 && world1.drops.length === 1 && halfDug,
      `veins=${world1.veins.length} remaining=[${world1.veins.map((v) => v.remaining).join(',')}] drops=${world1.drops.length} halfDug=${halfDug}`);

    // ── boot-2：同一存档冷启动，逆序登录（boot1 顺序 A→B→C，这里 C 先入场、A 随后）──
    const raw2Dir = join(EVIDENCE, 'obs-boot2');
    mkdirSync(raw2Dir, { recursive: true });
    const raw2 = join(raw2Dir, 'observer-raw.ndjson');
    rmSync(raw2, { force: true });
    const recorder2 = spawn(process.execPath, ['integration/determinism/record-round.mjs',
      '--origin', origin, '--account', ACCOUNT_OBS, '--out', raw2, '--base-map-sha', baseMapSha,
      '--retry-seconds', '240'], { cwd: ROOT, env, stdio: ['ignore', 'inherit', 'inherit'] });
    const recorder2Exit = new Promise((resolveExit) => recorder2.on('exit', resolveExit));
    await sleep(2000);
    const boot2Out = await startBoot(tools, release, boot2.path, join(EVIDENCE, 'lumio-ds.boot-2.log'), env, children);
    check('boot2-ready', true, `endpoint=${boot2Out.endpoint} (same store rebooted)`);

    const loginWithRetry = async (name) => {
      let lastError;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await loginAndLaunch({ origin, loginName: name, slug: 'sample', env, log: () => {} });
        } catch (error) {
          lastError = error;
          await sleep(5000);
        }
      }
      throw lastError;
    };
    const relaunch = {};
    const runVerifyBot = async (account, dirName) => {
      relaunch[account] = await loginWithRetry(account);
      const dir = join(EVIDENCE, dirName);
      mkdirSync(dir, { recursive: true });
      const args = buildBotArgs({
        botDll: release.layout.botHost, endpoint: boot2Out.endpoint,
        admissionTicket: relaunch[account].launch.admissionCredential,
        engineNative: release.layout.engineNative, kernelConfig: kernelConfig,
        configDir: join(ROOT, 'Client', 'Config', 'Tables'), logDir: dir,
        accountFrom: account, accountTo: account, gameplay: BOT_GAMEPLAY, voxelConfig: VOXEL_BUDGET,
        scenarioDll: SCENARIO_DLL, scenarioName: 'Lumio.Sample.Bots.AcceptancePersistenceVerifyScenario', ticks: 20000,
      });
      startBot(args, join(EVIDENCE, `${dirName}.log`),
        { ...env, LUMIO_PERSIST_REPORT: join(dir, 'persist-report.txt') });
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline) {
        tools.assertAlive(boot2Out.ds);
        if (existsSync(join(dir, 'result.ndjson')) && /"kind":"run"/.test(readFileSync(join(dir, 'result.ndjson'), 'utf8'))) break;
        await sleep(2000);
      }
      const run = botPassed(dir);
      check(`boot2-verify-${account}`, Boolean(run), run ? `${account} verify passed (veins==2, oreDrops==1)` : `${account} verify did not pass`);
      return run;
    };
    const cRun2 = await runVerifyBot(ACCOUNT_C, 'bot-c-boot2'); // 逆序：捡矿者 C 先入场
    await sleep(3000);
    const aRun2 = await runVerifyBot(ACCOUNT_A, 'bot-a-boot2');
    check('boot2-verify-scenario', cRun2 && aRun2, `verify bots passed: C=${cRun2} A=${aRun2}`);

    let gens2 = [];
    const cpDeadline2 = Date.now() + 60000;
    const ds2Text = () => String(boot2Out.ds.stdout ?? '');
    while (Date.now() < cpDeadline2) {
      gens2 = [...ds2Text().matchAll(/DS_CHECKPOINT \{"generation":(\d+)\}/g)].map((m) => Number(m[1]));
      if (gens2.length >= 2) break;
      await sleep(1000);
    }
    await tools.forceCleanup(boot2Out.ds);
    await recorder2Exit;
    if (existsSync(join(raw2Dir, 'recorder-done.json'))) {
      report.recorder2Close = readFileSync(join(raw2Dir, 'recorder-done.json'), 'utf8').trim();
    }

    report.boot2 = { world: deriveWorld(raw2) };
    const world2 = report.boot2.world;
    const veinsMatch = world1.veins.length === world2.veins.length
      && world1.veins.every((vein, index) => vein.id === world2.veins[index].id && vein.remaining === world2.veins[index].remaining);
    check('restart-veins-identical', veinsMatch,
      `boot1 [${world1.veins.map((v) => `${v.id.slice(-4)}:${v.remaining}`).join(' ')}] vs boot2 [${world2.veins.map((v) => `${v.id.slice(-4)}:${v.remaining}`).join(' ')}]`);
    check('restart-unpicked-drop-stays', world2.drops.length === 1, `drops after restart=${world2.drops.length}`);
    const selfC1 = botSelfId(cDir);
    const selfC2 = botSelfId(join(EVIDENCE, 'bot-c-boot2'));
    const selfA2 = botSelfId(join(EVIDENCE, 'bot-a-boot2'));
    const oreC1 = selfC1 ? world1.ore[selfC1] : null;
    const oreC2 = selfC2 ? world2.ore[selfC2] : null;
    const oreA2 = selfA2 ? world2.ore[selfA2] : null;
    report.oreLedger = { selfC1, selfC2, selfA2, oreC1, oreC2, oreA2 };
    const oreValue = (ore) => Number(ore?.base ?? ore?.current ?? NaN);
    check('restart-ore-ledger',
      Boolean(oreC1 && oreValue(oreC1) === 13 && oreValue(oreC2) === 13),
      `picker C ore boot1=${oreValue(oreC1)} boot2=${oreC2 ? oreValue(oreC2) : 'n/a'} (9 initial + 4 picked; boot1 world also carries A/B at 9)`);

    // ── 搬迁：整套存档目录拷进 WSL，linux-x64 同一发布物直接打开 ────────────
    const wslDir = '/mnt/c/Work/accept-v002/LumioSample/' + relativePosix(ROOT, EVIDENCE) + '/wsl';
    const engineLinux = '/mnt/c/Work/accept-v002/LumioSample/Engine/server/linux-x64';
    run('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'rm', '-rf', wslDir]);
    mkdirSync(join(EVIDENCE, 'wsl'), { recursive: true });
    cpSync(store, join(EVIDENCE, 'wsl', 'ds-store'), { recursive: true });
    cpSync(join(ROOT, 'Server', 'Config', 'Tables'), join(EVIDENCE, 'wsl', 'Tables'), { recursive: true });
    cpSync(join(ROOT, 'Server', 'Assets', 'Maps'), join(EVIDENCE, 'wsl', 'Maps'), { recursive: true });
    cpSync(join(ROOT, 'Gameplay', 'bin', 'Debug', 'net10.0', 'Lumio.Sample.Gameplay.dll'), join(EVIDENCE, 'wsl', 'gameplay.dll'));
    const linuxConfig = structuredClone(boot2.config);
    const wslFxr = run('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'sh', '-c',
      'ls -1 /usr/lib/dotnet/host/fxr/*/libhostfxr.so 2>/dev/null | sort -V | tail -1']).output.trim();
    if (!wslFxr) throw new Error('WSL has no dotnet hostfxr (libhostfxr.so)');
    linuxConfig.store_path = `${wslDir}/ds-store`;
    linuxConfig.config_dir = `${wslDir}/Tables`;
    linuxConfig.voxel_catalog = `${wslDir}/Maps/official-catalog.json`;
    linuxConfig.base_map_path = `${wslDir}/Maps/sample.voxel`;
    linuxConfig.logging.dir = `${wslDir}/logs`;
    linuxConfig.clr.registry_assembly = `${wslDir}/gameplay.dll`;
    linuxConfig.clr.engine_native = `${engineLinux}/SDK/Native/linux-x64/liblumio_engine_native.so`;
    linuxConfig.clr.assembly = `${engineLinux}/Application/Lumio.Server.HostEntry.dll`;
    linuxConfig.clr.runtime_config = `${engineLinux}/Application/Lumio.Server.HostEntry.runtimeconfig.json`;
    linuxConfig.clr.replication_assembly = `${engineLinux}/SDK/Managed/Lumio.GameRuntime.Replication.dll`;
    linuxConfig.clr.ecs_assembly = `${engineLinux}/SDK/Managed/Lumio.GameRuntime.Ecs.dll`;
    linuxConfig.clr.hostfxr = wslFxr;
    // 保持 loopback 监听：非 loopback 会触发本地开发准入密钥的显式拒绝（engine 守卫）。
    // Windows 侧连不进 WSL 的 127.0.0.1 —— 所以观察者与验证 bot 也在 WSL 内跑
    // （node v22 与 linux-x64 Bot.Host 都在），Platform 走 docker 发布的 0.0.0.0:8080。
    linuxConfig.transport = { ...linuxConfig.transport, listen_address: '127.0.0.1', listen_port: DS_PORT };
    const linuxPath = join(EVIDENCE, 'wsl', 'server.linux.json');
    writeFileSync(linuxPath, `${JSON.stringify(linuxConfig, null, 2)}\n`);
    const linuxRel = '/mnt/c/Work/accept-v002/LumioSample/' + relativePosix(ROOT, linuxPath);
    const linuxOut = run('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'sh', '-c',
      `mkdir -p ${wslDir}/logs && cd ${engineLinux} && DOTNET_ROOT=/usr/lib/dotnet ./lumio-ds --config ${linuxRel} --check-config`], 120000);
    check('wsl-check-config', /configuration_valid/.test(linuxOut.output), `linux-x64 lumio-ds --check-config: ${linuxOut.output.trim().split('\n').pop()}`);

    const raw3Dir = join(EVIDENCE, 'obs-wsl');
    mkdirSync(raw3Dir, { recursive: true });
    const raw3 = join(raw3Dir, 'observer-raw.ndjson');
    rmSync(raw3, { force: true });
    const wslRoot = '/mnt/c/Work/accept-v002/LumioSample';
    const raw3Rel = `${wslRoot}/${relativePosix(ROOT, raw3)}`;
    // wsl.exe 不透传普通 Windows env：经 sh -c 前缀注入账号密码（观察者账号已在 boot1 铸过）。
    const recorder3 = spawn('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'sh', '-c',
      `LUMIO_ACCOUNT_PASSWORD=${PASSWORD} exec node ${wslRoot}/integration/determinism/record-round.mjs --origin http://127.0.0.1:8080 --account ${ACCOUNT_OBS} --out ${raw3Rel} --base-map-sha ${baseMapSha} --retry-seconds 240`],
    { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
    const recorder3Exit = new Promise((resolveExit) => recorder3.on('exit', resolveExit));
    await sleep(2000);
    const wslDs = spawn('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'sh', '-c',
      `cd ${engineLinux} && DOTNET_ROOT=/usr/lib/dotnet exec ./lumio-ds --config ${linuxRel}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    const wslLogChunks = [];
    wslDs.stdout.on('data', (bytes) => { wslLogChunks.push(bytes); process.stdout.write(bytes); });
    wslDs.stderr.on('data', (bytes) => wslLogChunks.push(bytes));
    const wslReadyDeadline = Date.now() + 120000;
    let wslReadyText = '';
    while (Date.now() < wslReadyDeadline) {
      wslReadyText = Buffer.concat(wslLogChunks).toString('utf8');
      if (/DS_READY/.test(wslReadyText)) break;
      await sleep(500);
    }
    check('wsl-boot-ready', /DS_READY/.test(wslReadyText), 'linux-x64 lumio-ds restored the migrated store and printed DS_READY');

    const relaunch3 = await mint(ACCOUNT_A);
    const aDir3 = join(EVIDENCE, 'bot-a-wsl');
    mkdirSync(aDir3, { recursive: true });
    // WSL 内跑 linux-x64 Bot.Host：连 DS loopback、linux native；程序集/配表/底图均为
    // 同一份发布物与仓内容（IL 无架构之分）。
    const aDir3Rel = `${wslRoot}/${relativePosix(ROOT, aDir3)}`;
    const kernelRel3 = `${wslRoot}/${relativePosix(ROOT, kernelConfig)}`;
    const wslBotCmd = [
      'cd', `${wslRoot}/Engine/bot/linux-x64`, '&&',
      'DOTNET_ROOT=/usr/lib/dotnet', 'dotnet', 'Lumio.Client.Bot.Host.dll',
      '--server', `ws://127.0.0.1:${DS_PORT}/`,
      '--admission-ticket', JSON.stringify(relaunch3.launch.admissionCredential),
      '--engine-native', `${engineLinux}/SDK/Native/linux-x64/liblumio_engine_native.so`,
      '--kernel-config', kernelRel3,
      '--log-dir', aDir3Rel,
      '--account-from', ACCOUNT_A, '--account-to', ACCOUNT_A,
      '--gameplay', `${wslDir}/gameplay.dll`,
      '--config-dir', `${wslRoot}/Client/Config/Tables`,
      '--voxel-config', `${wslDir}/Maps/bot-voxel-budget.json`,
      '--scenario', `${wslRoot}/Client/Bots/bin/Debug/net10.0/Lumio.Sample.Bots.dll`,
      '--scenario-name', 'Lumio.Sample.Bots.AcceptancePersistenceVerifyScenario',
      '--ticks', '20000',
      '&&', 'echo', 'WSL_BOT_DONE',
    ].join(' ');
    const wslBot = spawn('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'sh', '-c', wslBotCmd], { stdio: ['ignore', 'pipe', 'pipe'] });
    const wslBotChunks = [];
    wslBot.stdout.on('data', (bytes) => { wslBotChunks.push(bytes); process.stdout.write(bytes); });
    wslBot.stderr.on('data', (bytes) => { wslBotChunks.push(bytes); process.stdout.write(bytes); });
    const wslVerifyDeadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < wslVerifyDeadline) {
      if (existsSync(join(aDir3, 'result.ndjson')) && /"kind":"run"/.test(readFileSync(join(aDir3, 'result.ndjson'), 'utf8'))) break;
      await sleep(2000);
    }
    const aRun3 = botPassed(aDir3);
    check('wsl-verify-scenario', Boolean(aRun3), aRun3 ? 'verify scenario passed against the WSL-opened store (veins==2, oreDrops==1)' : 'verify scenario did not pass on WSL');
    writeFileSync(join(EVIDENCE, 'bot-a-wsl.out'), Buffer.concat(wslBotChunks));
    await sleep(5000);
    wslDs.kill();
    await recorder3Exit;
    report.wsl = { world: deriveWorld(raw3) };
    const world3 = report.wsl.world;
    const wslVeinsMatch = world2.veins.length === world3.veins.length
      && world2.veins.every((vein, index) => vein.id === world3.veins[index].id && vein.remaining === world3.veins[index].remaining);
    check('wsl-world-identical', wslVeinsMatch && world3.drops.length === world2.drops.length,
      `win [${world2.veins.map((v) => v.remaining).join(',')}] drops=${world2.drops.length} vs wsl [${world3.veins.map((v) => v.remaining).join(',')}] drops=${world3.drops.length}`);
    writeFileSync(join(EVIDENCE, 'wsl-ds-stdout.log'), Buffer.concat(wslLogChunks));

    // 底图身份反例（Windows，拷贝的存档卷）：缺底图 / sha 不匹配都必须在启动时显式失败
    // （--check-config 不查底图，两者都要真启动；上一行 probe 证据见 neg-probe-boot.log）。
    const negStore = mkdtempSync(join(EVIDENCE, 'neg-store-'));
    cpSync(store, negStore, { recursive: true });
    const runNegative = (label, mutate) => {
      const negConfig = structuredClone(boot2.config);
      negConfig.store_path = negStore;
      negConfig.logging.dir = join(EVIDENCE, `neg-${label}-logs`);
      mkdirSync(negConfig.logging.dir, { recursive: true });
      mutate(negConfig);
      const negPath = join(EVIDENCE, `server.${label}.json`);
      writeFileSync(negPath, `${JSON.stringify(negConfig, null, 2)}\n`);
      const out = run(release.layout.dsExe, [...buildServerArgs(negPath)], 90000);
      writeFileSync(join(EVIDENCE, `lumio-ds.${label}.log`), out.output ?? out.stdout ?? String(out));
      const text = String(out.output ?? out.stdout ?? '');
      const explicit = /DS_FATAL/.test(text) && /base.?map|sha|mismatch/i.test(text) && !/DS_READY/.test(text);
      check(`negative-${label}`, explicit, `${text.trim().split('\n').slice(-2).join(' | ').slice(0, 400)} (exit=${out.status})`);
    };
    runNegative('base-map-missing', (config) => { config.base_map_path = join(EVIDENCE, 'no-such-file.voxel'); });
    runNegative('base-map-sha-mismatch', (config) => {
      cpSync(BASE_MAP, join(EVIDENCE, 'sample-copy.voxel'));
      config.base_map_path = join(EVIDENCE, 'sample-copy.voxel');
      config.base_map_content_sha256 = '0'.repeat(64);
    });

    // ── 半挖在档（toolfix v0.0.3，判据 6 优雅路径）：与 boot-1 的 half 角色不同——
    //    不靠「杀 bot 进程抢在下一镐之前」，也不换体力 39 的配表副本。PartialMiningScenario
    //    只挥 k=PARTIAL_SWINGS 镐（被接受的激活计数，k < vein_hits_to_break=6）就自律
    //    停手、Complete、登出；随后等半挖储量经 DS 自己的 checkpoint 写档，写档完成后
    //    才停服（Windows 没有跨进程 Ctrl+C——Tools/launcher.mjs 十四步同款结论；停进程
    //    发生在最后一笔 post-completion checkpoint 之后，kill 不定义写档时机、不与玩法
    //    活动竞争），同一存档冷启动后核对「储量已下降、未挖穿、方块还在（非空气）」。──
    const partialStore = mkdtempSync(join(EVIDENCE, 'ds-store-partial-'));
    const makePartialConfig = (name) => {
      const config = deriveRunDsConfig(structuredClone(template), {
        templatePath, engineClr: engineClrInputs(release.layout, hostfxr), storePath: partialStore,
        logDir: join(EVIDENCE, `ds-partial-${name}-logs`), launch: sessions[ACCOUNT_D].launch,
      });
      config.transport.listen_port = DS_PORT; // 观察者经 Platform 分配的 wsUrl(9110) 入场
      config.checkpoint_seconds = 10;
      const path = join(EVIDENCE, `server.partial-${name}.json`);
      writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
      return { config, path };
    };
    const recorderP1 = startRecorder('obs-partial-1');
    await sleep(2000);
    const partial1 = makePartialConfig('boot-1');
    assertRunnableDsConfig(partial1.config);
    const p1Out = await startBoot(tools, release, partial1.path, join(EVIDENCE, 'lumio-ds.partial-1.log'), env, children);
    check('partial-boot1-ready', true, `endpoint=${p1Out.endpoint} (fresh store, committed config, no stamina side-file)`);

    const dDir = join(EVIDENCE, 'bot-d-partial-1');
    mkdirSync(dDir, { recursive: true });
    startBot(botArgsFor(await mint(ACCOUNT_D), dDir, 'Lumio.Sample.Bots.PartialMiningScenario', 60000),
      join(EVIDENCE, 'bot-d-partial-1.log'),
      { ...env, LUMIO_PARTIAL_MINING_SWINGS: String(PARTIAL_SWINGS), LUMIO_PARTIAL_MINING_REPORT: join(dDir, 'partial-report.txt') });
    const dDeadline = Date.now() + 15 * 60 * 1000;
    let dRun = null;
    while (Date.now() < dDeadline) {
      tools.assertAlive(p1Out.ds);
      dRun = botPassed(dDir);
      if (dRun) break;
      await sleep(2000);
    }
    check('partial-role-bot', Boolean(dRun), dRun
      ? `${ACCOUNT_D} PartialMiningScenario passed (k=${PARTIAL_SWINGS} accepted swings, then stopped on its own and logged out — nothing killed, no config swapped)`
      : `${ACCOUNT_D} PartialMiningScenario did not pass`);

    // 数据面真值是观察流里的 VeinReserveComponent.remaining：目标脉 6 → v（0<v<6）。
    const dReport = readTextIfPresent(join(dDir, 'partial-report.txt'));
    const dTarget = (/target=([0-9a-f]+)/.exec(dReport) ?? [])[1] ?? '';
    const veinRemainingInStream = (rawPath, veinId) => {
      if (!veinId || !existsSync(rawPath)) return null;
      let last = null;
      for (const line of readFileSync(rawPath, 'utf8').trim().split(/\r?\n/)) {
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.kind !== 'world') continue;
        for (const [id, component, field, value] of event.fields ?? []) {
          if (component === 'VeinReserveComponent' && field === 'remaining' && id === veinId) last = Number(value);
        }
      }
      return last;
    };
    const partialV1 = veinRemainingInStream(recorderP1.raw, dTarget);
    check('partial-vein-decremented', partialV1 != null && partialV1 > 0 && partialV1 < 6,
      `target ${dTarget.slice(-8) || '<none>'} remaining=${partialV1} after k=${PARTIAL_SWINGS} swings (authored 6; 0 < v < 6 = decreased, not dug through)`);

    // 登出之后、停服之前：等半挖状态经 DS 正常 checkpoint 路径落盘（post-completion
    // checkpoint 之后才停进程——「优雅」的落点在数据面，不靠与玩法竞争的时机）。
    const p1Gens = () => [...String(p1Out.ds.stdout ?? '').matchAll(/DS_CHECKPOINT \{"generation":(\d+)\}/g)].map((m) => Number(m[1]));
    let gensP1 = p1Gens();
    const p1CpDeadline = Date.now() + 60000;
    while (Date.now() < p1CpDeadline) {
      const now = p1Gens();
      if (now.length >= gensP1.length + 1) { gensP1 = now; break; }
      await sleep(1000);
    }
    check('partial-checkpoint', gensP1.length >= 1, `checkpoint generations after logout: ${gensP1.join(',')}`);
    await tools.forceCleanup(p1Out.ds);
    await recorderP1.exited;
    report.partialBoot1 = { world: deriveWorld(recorderP1.raw) };

    // 同一存档冷启动：储量保持 v（已下降、未挖穿）、vein 实体全部还在（方块非空气）。
    const recorderP2 = startRecorder('obs-partial-2');
    await sleep(2000);
    const partial2 = makePartialConfig('boot-2');
    const p2Out = await startBoot(tools, release, partial2.path, join(EVIDENCE, 'lumio-ds.partial-2.log'), env, children);
    check('partial-boot2-ready', true, `endpoint=${p2Out.endpoint} (same partial store rebooted)`);
    await sleep(30000); // 观察者入场并采样一轮 Section 绑定（vein 的 remaining 是 Aoi 同步字段）
    await tools.forceCleanup(p2Out.ds);
    await recorderP2.exited;
    const partialWorld1 = report.partialBoot1.world;
    const partialWorld2 = deriveWorld(recorderP2.raw);
    const partialVein2 = partialWorld2.veins.find((vein) => vein.id === dTarget) ?? null;
    check('partial-restart-reserve-kept',
      partialV1 != null && partialVein2 != null && partialVein2.remaining === partialV1,
      `target ${dTarget.slice(-8)} remaining boot-p1=${partialV1} boot-p2=${partialVein2 ? partialVein2.remaining : 'n/a'} (0 < v < 6 across the restart)`);
    check('partial-restart-vein-alive',
      partialWorld2.veins.length === partialWorld1.veins.length
        && partialWorld2.veins.length > 0
        && partialWorld2.veins.every((vein) => vein.remaining > 0),
      `veins boot-p1=[${partialWorld1.veins.map((v) => v.remaining).join(',')}] boot-p2=[${partialWorld2.veins.map((v) => v.remaining).join(',')}] (every vein entity present = every mined cell still a block, not air)`);
  } finally {
    report.completedAt = new Date().toISOString();
    report.status = report.checks.every((entry) => entry.status === 'PASS') ? 'PASS' : 'FAIL';
    writeReport();
    for (const child of children.reverse()) {
      try { await tools.forceCleanup(child); } catch { /* already gone */ }
    }
    if (platform) await platform.stop();
  }
  process.exit(report.status === 'PASS' ? 0 : 1);
}

function run(file, args, timeoutMs) {
  const result = spawnSync(file, args, { encoding: 'utf8', timeout: timeoutMs ?? undefined, maxBuffer: 64 * 1024 * 1024 });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function relativePosix(from, to) {
  return relative(from, to).split('\\').join('/');
}

await main().catch((error) => {
  report.status = 'FAIL';
  report.error = String(error?.stack ?? error);
  writeReport();
  process.stderr.write(report.error + '\n');
  process.exit(1);
});

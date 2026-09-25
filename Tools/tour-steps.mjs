import { findDsReady } from './ds-ready.mjs';
import { FROZEN_WORLD_PROFILE } from './server-profile.mjs';

export const TOUR_STEPS = Object.freeze([
  { id: '01', key: 'compile-config', title: '编译配表' },
  { id: '02', key: 'account-login', title: '注册登录' },
  { id: '03', key: 'start-ds', title: '起 DS' },
  { id: '04', key: 'admit-room', title: '进房间' },
  { id: '05', key: 'load-basemap', title: '加载底图' },
  { id: '06', key: 'spawn-player', title: '玩家入场' },
  { id: '07', key: 'move', title: '跑动' },
  { id: '08', key: 'chat', title: '聊天' },
  { id: '09', key: 'mine', title: '挖掘' },
  { id: '10', key: 'vein-reserve', title: '矿脉储量 -1' },
  { id: '11', key: 'cell-to-air', title: '方块变空气' },
  { id: '12', key: 'ore-drop', title: '掉出矿石' },
  { id: '13', key: 'pickup', title: '拾取' },
  { id: '14', key: 'save-restore', title: '存档重启' },
]);

export function formatStep(id, status, detail = '') {
  const suffix = detail ? ` ${detail}` : '';
  return `step=${id} status=${status}${suffix}`;
}

export const DEFAULT_LOGIN_PREFIX = 'Bot';

/**
 * Ordinary (non-Bot-namespace) login names. The engine release's local Platform compose accepts no
 * bot-tool credential (all-zero bot tool key, R-00780), and Bot* names need one, so a run without
 * LUMIO_BOT_TOOL_CREDENTIAL registers ordinary accounts under this prefix (R-00785).
 */
export const ORDINARY_LOGIN_PREFIX = 'Player';

export function planBotLogins(bots, prefix = DEFAULT_LOGIN_PREFIX) {
  if (!Number.isInteger(bots) || bots < 1) {
    const error = new Error('--bots must be a positive integer.');
    error.code = 'USAGE';
    throw error;
  }
  return Array.from({ length: bots }, (_, index) => `${prefix}${index + 1}`);
}

// ---------------------------------------------------------------------------
// Steps 05–14 are judged from artifacts only: lumio-ds stdout (DS_READY / DS_CHECKPOINT), the DS
// post-office log directory, the tour bot's lifecycle log and its result.ndjson. Process liveness
// is never a verdict. Every function below is pure so each step has a unit test.
// ---------------------------------------------------------------------------

/** Bot.Host `--scenario-name` for steps 05–13 and for step 14's re-admission. */
export const TOUR_SCENARIO = 'Lumio.Sample.Bots.SampleMiningScenario';
export const RESTORE_SCENARIO = 'Lumio.Sample.Bots.SampleRestoreVerifyScenario';

/** The one chat line SampleMiningScenario sends (Client/Bots/SampleMiningScenario.cs); step 08 finds it on the DS. */
export const TOUR_CHAT_TEXT = 'sample tour: hello from the mining bot';

/**
 * Which SampleMiningScenario assertion speaks for which step. A test pins every name to a
 * `sink.That(…, "<name>")` in the scenario source, so a rename cannot turn a step vacuous.
 */
export const TOUR_ASSERTIONS = Object.freeze({
  // A vein is a block entity (ADR-119): it reaches a client only through a delivered Section's
  // binding table. That assertion is the step-05 proof the voxel Section channel carried content
  // to the tour bot — the retired `admission baseline: wrote N SectionFrame` host line
  // (R-00733 removed the fixed-region first send) no longer exists to be counted.
  '05': Object.freeze(['vein_seen_via_section']),
  '06': Object.freeze(['self_bound']),
  '07': Object.freeze(['move_activated', 'activation_accepted', 'bot_uplinked']),
  '08': Object.freeze(['chat_activated']),
  '09': Object.freeze(['mine_activated']),
  '10': Object.freeze(['vein_dug_through']),
  // PickupOrders > 0 only after the plan found an oreDrop in the replicated census: the drop reached the client.
  '12': Object.freeze(['pickup_activated']),
  '13': Object.freeze(['pickup_activated', 'drop_collected']),
});

/** Bot.Host result.ndjson: one `{kind:"assert"}` per bot, then one `{kind:"run"}` (BotHostResidentLoop.FinishScenarios). */
export function parseBotResult(text) {
  const asserts = [];
  let run = null;
  let unparsable = 0;
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value;
    try { value = JSON.parse(line); } catch { unparsable += 1; continue; }
    if (value?.kind === 'assert') asserts.push(value);
    else if (value?.kind === 'run') run = value;
  }
  return { asserts, run, unparsable };
}

/**
 * Whether the scenario's Assert() demonstrably ran. `BotAssertionSink` records only FAILED names, so
 * "this name is not in the failed list" means something only when the assert record exists, is
 * well-formed and agrees with the closing run record. Anything else — no file, an empty file, a
 * file cut off before the run record — is `present:false`, and every step reading it FAILs.
 */
export function scenarioVerdict(result) {
  const asserts = result?.asserts ?? [];
  const run = result?.run ?? null;
  const absent = (reason) => ({ present: false, passed: false, failed: [], reason });
  if (asserts.length === 0) return absent('no assert record in result.ndjson');
  if (asserts.length !== 1) return absent(`expected one assert record, found ${asserts.length}`);
  if (!run) return absent('no run record in result.ndjson (the scenario never finished)');
  const [record] = asserts;
  if (typeof record.passed !== 'boolean' || typeof record.failed !== 'string') {
    return absent('assert record has no boolean passed / string failed');
  }
  const failed = record.failed.split(',').map((name) => name.trim()).filter(Boolean);
  if (record.passed !== (failed.length === 0)) return absent('assert record contradicts itself (passed vs failed list)');
  if (run.passed !== record.passed || run.bots !== asserts.length) return absent('run record disagrees with the assert record');
  return { present: true, passed: record.passed, failed, reason: '' };
}

/** A named assertion held: the Assert() ran and did not list it. Failed names may carry `:reason` or `(got …)`. */
export function assertionHeld(verdict, name) {
  if (!verdict?.present) return false;
  return !verdict.failed.some((entry) => entry === name || entry.startsWith(`${name}:`) || entry.startsWith(`${name}(`));
}

function describeAssertions(verdict, names) {
  if (!verdict.present) return `no-result (${verdict.reason})`;
  const missing = names.filter((name) => !assertionHeld(verdict, name));
  return missing.length === 0 ? `${names.join('+')} held` : `failed: ${missing.join(',')}`;
}

function count(pattern, text) {
  const matches = String(text ?? '').match(pattern);
  return matches ? matches.length : 0;
}

function safeDsReady(stdout) {
  try { return findDsReady(stdout); } catch { return null; }
}

const BASE_MAP_BOOT = /empty store: first boot opens the world from the configured base map/;
const CHECKPOINT_RESTORE = /recovered checkpoint outranks base_map_path/;

/**
 * Steps 05–13 from one tour run. `dsReady` is the DS_READY object parsed at boot (the stdout kept
 * in memory is only a tail); `botAdmit` is the launcher's `parseBotAdmit` over the tour bot's own
 * logs; `botResult` is that bot's result.ndjson text. Every step needs positive evidence on each
 * side it names: a missing result file is FAIL, never "no failure reported".
 */
export function judgeTourSteps({ dsReady = null, dsStdout = '', dsLogs = '', botAdmit = {}, botResult = '' } = {}) {
  const ds = `${dsStdout}\n${dsLogs}`;
  const verdict = scenarioVerdict(parseBotResult(botResult));
  const held = (id) => TOUR_ASSERTIONS[id].every((name) => assertionHeld(verdict, name));
  const bot = (id) => describeAssertions(verdict, TOUR_ASSERTIONS[id]);
  const step = (id, pass, detail) => ({ id, status: pass ? 'PASS' : 'FAIL', detail });

  const ready = dsReady ?? safeDsReady(dsStdout);
  const worldProfile = ready?.worldProfile ?? null;
  const baseMapBoot = BASE_MAP_BOOT.test(ds);
  const restoredInstead = CHECKPOINT_RESTORE.test(ds);
  const scopeActive = botAdmit.scopeActivated === true;

  // The gameplay's C# log lines travel through the DS logfmt sink, which escapes the separating
  // tab as a literal `\t` — `SampleMiningComponent\tmining_stage` — so no `\b` can precede these
  // names. The `name txn=` shape is unique to the event itself; match it without a boundary.
  const appliedOps = count(/outcome=Succeeded\/Applied/g, ds);
  const chatOnDs = ds.includes(`says: ${TOUR_CHAT_TEXT}`);
  const staged = count(/mining_stage txn=/g, ds);
  const pre = count(/mining_pre txn=/g, ds);
  const applied = count(/mining_applied txn=/g, ds);
  const air = count(/mining_post txn=\S+ block=0\b/g, ds);
  const rewards = [...ds.matchAll(/mining_reward txn=\S+ amount=(\d+)/g)].map((match) => Number(match[1]));
  const rewarded = rewards.filter((amount) => amount > 0);

  return [
    step('05', worldProfile === FROZEN_WORLD_PROFILE && baseMapBoot && !restoredInstead && held('05') && scopeActive,
      `worldProfile=${worldProfile ?? 'no-DS_READY'}; base map boot=${baseMapBoot}${restoredInstead ? ' (store already held a checkpoint)' : ''}; ${bot('05')}; bot scope active=${scopeActive}`),
    step('06', botAdmit.admitted === true && held('06'),
      `admitted=${botAdmit.admitted === true}; ${bot('06')}`),
    step('07', held('07') && appliedOps > 0,
      `${bot('07')}; DS applied ops=${appliedOps}`),
    step('08', held('08') && chatOnDs,
      `${bot('08')}; DS says line=${chatOnDs}`),
    step('09', held('09') && staged > 0 && pre > 0,
      `${bot('09')}; mining_stage=${staged} mining_pre=${pre}`),
    step('10', held('10') && applied > 0,
      `${bot('10')}; mining_applied=${applied}`),
    step('11', air > 0,
      `mining_post block=0 lines=${air}`),
    step('12', held('12') && rewarded.length > 0,
      `mining_reward amounts=[${rewards.join(',')}]; ${bot('12')}`),
    step('13', held('13') && verdict.present && verdict.passed,
      `${bot('13')}; scenario ${verdict.present ? (verdict.passed ? 'passed' : `failed: ${verdict.failed.join(',')}`) : 'no-result'}`),
  ];
}

/** Every `DS_CHECKPOINT {"generation":N}` in print order (lumio-ds prints one per finished save). */
export function checkpointGenerations(text) {
  const generations = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^DS_CHECKPOINT (\{.*\})\s*$/.exec(line);
    if (!match) continue;
    try {
      const value = JSON.parse(match[1]);
      if (Number.isInteger(value?.generation)) generations.push(value.generation);
    } catch { /* not a checkpoint line */ }
  }
  return generations;
}

/**
 * The checkpoint step 14 may stop the DS on. Generations must rise strictly. A DS_CHECKPOINT is
 * printed when a save FINISHES and saves never overlap (lumio-ds main loop), so the first one printed
 * after the tour bot finished may be a save that was already running — its snapshot can predate
 * the pickup. The second one started after the first was printed, i.e. after completion.
 */
export function judgeCheckpoint(atCompletion = [], now = []) {
  for (let index = 1; index < now.length; index += 1) {
    if (now[index] <= now[index - 1]) {
      return { ok: false, broken: true, generation: null, detail: `generations not strictly increasing: ${now.join(',')}` };
    }
  }
  const floor = atCompletion.length ? Math.max(...atCompletion) : null;
  const newer = now.filter((generation) => floor == null || generation > floor);
  const from = floor ?? 'none';
  if (newer.length < 2) {
    return {
      ok: false,
      generation: null,
      detail: `gen ${from} at completion; ${newer.length === 0 ? 'no DS_CHECKPOINT' : `only gen ${newer[0]} (may have started before completion)`} after it`,
    };
  }
  return { ok: true, generation: newer[1], detail: `gen ${from}→${newer[1]}` };
}

/**
 * Step 14: the reboot on the same store restored the checkpoint (marker, and not a fresh base map),
 * and a real client re-admitted into it saw the played world (SampleRestoreVerifyScenario).
 */
export function judgeRestore({ checkpoint, bootStdout = '', bootLogs = '', verifyResult = '' } = {}) {
  const text = `${bootStdout}\n${bootLogs}`;
  const restored = CHECKPOINT_RESTORE.test(text);
  const freshBaseMap = BASE_MAP_BOOT.test(text);
  const verdict = scenarioVerdict(parseBotResult(verifyResult));
  const verify = verdict.present
    ? (verdict.passed ? 'passed' : `failed: ${verdict.failed.join(',')}`)
    : `no-result (${verdict.reason})`;
  const pass = checkpoint?.ok === true && restored && !freshBaseMap && verdict.present && verdict.passed;
  return {
    id: '14',
    status: pass ? 'PASS' : 'FAIL',
    detail: `checkpoint ${checkpoint?.detail ?? 'none'}; restore marker=${restored}${freshBaseMap ? '; reboot opened the fresh base map' : ''}; verify assertions=${verify}`,
  };
}

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SPECTATOR_ROOT, planLaunchLogins } from './launcher.mjs';
import { TOUR_STEPS } from './tour-steps.mjs';
import {
  collectLiveBotEvidenceText,
  countAdmittedBotHosts,
  waitForBotAdmissions,
  CDP_CANVAS_STATS_EXPRESSION,
  CDP_SPECTATOR_SNAPSHOT_EXPRESSION,
  CdpSession,
  buildCdpLaunchInjection,
  collectCdpSpectatorObservation,
  compareCdpSpectatorSnapshots,
  normalizeSnapshot,
  compiledNativeLoaderAbi,
  createSpectatorDocument,
  countBotHostProcesses,
  dsEndpointAuthorityMatches,
  DS_CADENCE_LAG_MARKER,
  DS_CADENCE_LAG_SETTLE_MS,
  DS_TIMER_OWNER_MARKER,
  dsCadenceLagEvidence,
  dsConsumerAbiAgreement,
  dsTimerOwnerAbi,
  GAMEPLAY_CLIENT_MARKER,
  gameplayRegistrySideAgreement,
  baseMapCaptureAgreement,
  SPECTATOR_WASM_CONNECTION_STATE_MARKER,
  SPECTATOR_WASM_APPLY_ERROR_MARKER,
  spectatorBundleRoot,
  spectatorDotnetImport,
  spectatorWasmAgreement,
  buildChildEnv,
  nativeAbiAgreement,
  parseLoopbackWsEndpoint,
  runLiveTopology,
  redactCdpEvidence,
  selectCdpPageTarget,
  missingLiveReason,
  mintTickets,
  preflightLiveTopology,
  probeMoved,
  probePlatformHealth,
  parseSpectatorCliArgs,
  runSpectator100,
  SHA_REPOS,
  spectator100ExitCode,
  STRESS_PREFIX_ENV,
  TICKET_PREFIX,
  uniqueTicketReport,
  validateBrowserEvidence,
  WAVE_B_STAGGER_MS,
  WAVE_B_MOVE_SETTLE_MS,
} from './spectator-100.mjs';

const SAMPLE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const KERNEL_CONFIG = Object.freeze({ maxContexts: 64, maxHandles: 4096, maxNativeBytes: 67108864, maxJobsQueued: 256, maxJobsRunning: 4, maxCompletionItems: 1024, logMailboxCapacity: 8192 });

const GAMEPLAY_CSPROJ = resolve(SAMPLE_ROOT, 'Gameplay', 'Lumio.Sample.Gameplay.csproj');
const REPLICA_CSPROJ = resolve(SAMPLE_ROOT, '..', 'LumioClient', 'Client', 'Gameplay', 'ECS', 'src', 'Lumio.Client.Gameplay.ECS.csproj');

test('hermetic spectator-100 is BLOCKED_ENV when live env is missing', async () => {
  const evidence = mkdtempSync(join(tmpdir(), 'lumio-spectator-100-'));
  const document = await runSpectator100({
    root: SAMPLE_ROOT,
    env: {},
    evidenceDir: evidence,
    log() {},
  });
  assert.equal(document.status, 'BLOCKED_ENV');
  assert.match(String(document.error), /BLOCKED_ENV:/);
  assert.equal(spectator100ExitCode(document.status), 2);
  assert.equal(missingLiveReason({}), 'LUMIO_PLATFORM_ORIGIN is not set');
  const verification = JSON.parse(readFileSync(join(evidence, 'verification.json'), 'utf8'));
  assert.equal(verification.status, 'BLOCKED_ENV');
  assert.equal(JSON.stringify(verification).includes('admissionCredential'), false);
});

test('plan is 100 bots + two spectators and steps 05-14 stay BLOCKED_ENV in launcher copy', () => {
  const planned = planLaunchLogins(100, { spectator: true });
  // The legacy launcher helper still plans one spectator.  Wave B's own
  // document is the fixed 102-ticket topology.
  const waveB = createSpectatorDocument().plannedLogins;
  assert.equal(planned.length, 101);
  assert.equal(planned[0], 'Bot1');
  assert.equal(planned[99], 'Bot100');
  assert.equal(planned[100], 'Spectator1');
  assert.equal(waveB.length, 102);
  assert.deepEqual(waveB.slice(0, 100), planned.slice(0, 100));
  assert.deepEqual(waveB.slice(100), ['Spectator1', 'Spectator2']);
  const later = TOUR_STEPS.filter((step) => Number(step.id) >= 5).map((step) => step.id);
  assert.deepEqual(later, ['05', '06', '07', '08', '09', '10', '11', '12', '13', '14']);
});

test('spectator URL never carries credentials', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'lumio-spectator-url-secret-'));
  try {
    let observed;
    await runSpectator100({
      root: SAMPLE_ROOT,
      env: { LIVE_BOTS: '0', LUMIO_WAVE_B_LIVE: '1' },
      evidenceDir,
      shas: {},
      missingReason: '',
      authorizeLive: true,
      attachLive: true,
      spectatorUrl: 'http://user:ticket-secret@127.0.0.1:4173/?admission=ticket-secret',
      liveRun: ({ document }) => {
        observed = document.spectatorUrl;
        return { status: 'BLOCKED_ENV', error: 'planning-only test' };
      },
    });
    assert.equal(observed, 'http://127.0.0.1:4173/');
    assert.doesNotMatch(observed, /ticket-secret|admission=/);
  } finally {
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});

test('spectator bundle root is the launcher default publish output, overridable like the launcher', () => {
  assert.equal(spectatorBundleRoot({ root: SAMPLE_ROOT }), resolve(SAMPLE_ROOT, DEFAULT_SPECTATOR_ROOT));
  assert.equal(
    spectatorBundleRoot({ root: SAMPLE_ROOT, env: { LUMIO_SPECTATOR_ROOT: 'out/wwwroot' } }),
    resolve(SAMPLE_ROOT, 'out', 'wwwroot'),
  );
  assert.equal(
    spectatorBundleRoot({ root: SAMPLE_ROOT, spectatorRoot: 'cli/wwwroot', env: { LUMIO_SPECTATOR_ROOT: 'out/wwwroot' } }),
    resolve(SAMPLE_ROOT, 'cli', 'wwwroot'),
  );
  assert.doesNotMatch(spectatorBundleRoot({ root: SAMPLE_ROOT }), /LumioClient/);
});

test('parseSpectatorCliArgs forwards --spectator-root / LUMIO_SPECTATOR_ROOT through the launcher parser', () => {
  const fromFlag = parseSpectatorCliArgs(['--bots', '100', '--spectator-root', 'cli/wwwroot'], {});
  assert.equal(fromFlag.spectatorRoot, 'cli/wwwroot');
  const fromEnv = parseSpectatorCliArgs(['--bots', '100'], { LUMIO_SPECTATOR_ROOT: 'env/wwwroot' });
  assert.equal(fromEnv.spectatorRoot, 'env/wwwroot');
});

test('runSpectator100 leaves the planning URL unset until an explicit URL or origin is supplied', async () => {
  const baseEnv = { LIVE_BOTS: '0', LUMIO_WAVE_B_LIVE: '1' };
  const runPlanning = async (extra = {}) => {
    const evidenceDir = mkdtempSync(join(tmpdir(), 'lumio-spectator-url-'));
    let observedDocument;
    try {
      const document = await runSpectator100({
        root: SAMPLE_ROOT,
        env: baseEnv,
        evidenceDir,
        shas: {},
        // Bypass artifact checks: this test only inspects planning state, and
        // the injected live callback does not create any process.
        missingReason: '',
        authorizeLive: true,
        attachLive: true,
        liveRun: ({ document: value }) => {
          observedDocument = value;
          return { status: 'BLOCKED_ENV', error: 'planning-only test' };
        },
        ...extra,
      });
      return { document, observedDocument };
    } finally {
      rmSync(evidenceDir, { recursive: true, force: true });
    }
  };

  const implicit = await runPlanning({ spectatorStaticPort: '9412' });
  assert.equal(implicit.observedDocument.spectatorUrl, null);
  assert.equal(implicit.document.spectatorUrl, null);

  const explicitUrl = await runPlanning({
    spectatorUrl: 'http://127.0.0.1:9413/spectator',
  });
  assert.equal(explicitUrl.observedDocument.spectatorUrl, 'http://127.0.0.1:9413/spectator/');

  // An origin names a server hosting the publish output at its root.
  const explicitOrigin = await runPlanning({
    spectatorOrigin: 'http://127.0.0.1:9414',
  });
  assert.equal(explicitOrigin.observedDocument.spectatorUrl, 'http://127.0.0.1:9414/');

  const explicitOriginPort = await runPlanning({
    spectatorOrigin: 'http://127.0.0.1',
    spectatorStaticPort: '9416',
  });
  assert.equal(explicitOriginPort.observedDocument.spectatorUrl, 'http://127.0.0.1:9416/');

  const explicitEnvUrl = await runPlanning({
    env: { ...baseEnv, LUMIO_SPECTATOR_URL: 'http://127.0.0.1:9415/spectator' },
  });
  assert.equal(explicitEnvUrl.observedDocument.spectatorUrl, 'http://127.0.0.1:9415/spectator/');
});

test('uniqueTicketReport rejects reused admission credentials', () => {
  const unique = uniqueTicketReport([
    { loginName: 'Bot1', launch: { admissionCredential: 'alpha' } },
    { loginName: 'Spectator1', launch: { admissionCredential: 'beta' } },
  ]);
  assert.equal(unique.unique, true);
  const reused = uniqueTicketReport([
    { loginName: 'Bot1', launch: { admissionCredential: 'same' } },
    { loginName: 'Spectator1', launch: { admissionCredential: 'same' } },
  ]);
  assert.equal(reused.unique, false);
});

test('waitForBotAdmissions does not fail-fast on a retryable session_faulted', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'lumio-bot-retry-wait-'));
  try {
    const retryDir = join(evidenceDir, 'bot-1-retry1');
    mkdirSync(retryDir, { recursive: true });
    const logPath = join(retryDir, '2026-09-15_000.log');
    writeFileSync(logPath, 'session state changed stressbot00 Faulted Negotiating session_faulted state=Faulted reason=session_faulted\n');
    const child = {
      stdout: '',
      args: ['Bot.Host.dll', '--log-dir', retryDir],
      closed: false,
    };
    const waiting = waitForBotAdmissions({
      botChildren: [child],
      evidenceDir,
      expected: 1,
      timeoutMs: 400,
      pollMs: 40,
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    writeFileSync(logPath, [
      'session login requested stressbot00 ws://127.0.0.1:9110/sample True accepted=True',
      'session state changed stressbot00 Active Negotiating established 1 1 False True True account=stressbot00 state=Active previous=Negotiating reason=established',
      '',
    ].join('\n'));
    const latest = await waiting;
    // A classified session_faulted is retryable, not a rejected fail-fast.
    // Returning with faulted=1 lets the Wave B retry loop replace the child
    // instead of waiting out the remaining overall timeout.
    assert.equal(latest.rejected, 0);
    assert.ok(latest.admitted === 1 || latest.faulted === 1);
  } finally {
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});

test('waitForBotAdmissions returns once every slot is classified so retries are not held', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'lumio-bot-classified-wait-'));
  try {
    const admittedDir = join(evidenceDir, 'bot-1');
    const faultedDir = join(evidenceDir, 'bot-2');
    mkdirSync(admittedDir, { recursive: true });
    mkdirSync(faultedDir, { recursive: true });
    writeFileSync(join(admittedDir, '2026-09-15_000.log'), [
      'session login requested stressbot00 ws://127.0.0.1:9110/sample True accepted=True',
      'session state changed stressbot00 Active Negotiating established 1 1 False True True account=stressbot00 state=Active previous=Negotiating reason=established',
      '',
    ].join('\n'));
    writeFileSync(join(faultedDir, '2026-09-15_000.log'), [
      'session login requested stressbot01 ws://127.0.0.1:9110/sample True accepted=True',
      'session state changed stressbot01 Faulted Negotiating session_faulted 1 1 False False False state=Faulted previous=Negotiating reason=session_faulted',
      '',
    ].join('\n'));
    const started = Date.now();
    const latest = await waitForBotAdmissions({
      botChildren: [
        { stdout: '', args: ['Bot.Host.dll', '--log-dir', admittedDir], closed: false },
        { stdout: '', args: ['Bot.Host.dll', '--log-dir', faultedDir], closed: false },
      ],
      evidenceDir,
      expected: 2,
      timeoutMs: 5_000,
      pollMs: 40,
    });
    assert.ok(Date.now() - started < 1_000, 'classified slots must not wait out timeoutMs');
    assert.equal(latest.admitted, 1);
    assert.equal(latest.faulted, 1);
    assert.equal(latest.rejected, 0);
  } finally {
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});

test('Wave B holds Bot.Host chat/MoveAbility until every slot is classified', () => {
  const source = readFileSync(join(SAMPLE_ROOT, 'Tools', 'spectator-100.mjs'), 'utf8');
  assert.match(source, /writeFileSync\(holdInputPath/);
  assert.match(source, /childEnv\.LUMIO_BOT_HOLD_INPUT = holdInputPath/);
  assert.match(source, /unlinkSync\(holdInputPath\)/);
  assert.match(source, /BOT_HOLD_INPUT_FLAG/);
  assert.match(source, /WAVE_B_MOVE_SETTLE_MS/);
  assert.match(source, /botMoveSettleMs/);
  assert.equal(WAVE_B_MOVE_SETTLE_MS, 3000);
});

test('Wave B defaults stagger to 100ms unless --stagger-ms or LUMIO_STAGGER_MS is set', () => {
  const parsed = parseSpectatorCliArgs(['--bots', '100', '--authorize-live'], {});
  assert.equal(parsed.staggerMs, WAVE_B_STAGGER_MS);
  assert.equal(WAVE_B_STAGGER_MS, 100);
  const explicit = parseSpectatorCliArgs(['--bots', '100', '--authorize-live', '--stagger-ms', '250'], {});
  assert.equal(explicit.staggerMs, 250);
  const fromEnv = parseSpectatorCliArgs(['--bots', '100', '--authorize-live'], { LUMIO_STAGGER_MS: '40' });
  assert.equal(fromEnv.staggerMs, 40);
});

test('waitForBotAdmissions keeps waiting while a slot is still unclassified', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'lumio-bot-unclassified-wait-'));
  try {
    const admittedDir = join(evidenceDir, 'bot-1');
    const pendingDir = join(evidenceDir, 'bot-2');
    mkdirSync(admittedDir, { recursive: true });
    mkdirSync(pendingDir, { recursive: true });
    writeFileSync(join(admittedDir, '2026-09-15_000.log'), [
      'session login requested stressbot00 ws://127.0.0.1:9110/sample True accepted=True',
      'session state changed stressbot00 Active Negotiating established 1 1 False True True account=stressbot00 state=Active previous=Negotiating reason=established',
      '',
    ].join('\n'));
    writeFileSync(join(pendingDir, '2026-09-15_000.log'), 'bot host starting\n');
    const pendingPath = join(pendingDir, '2026-09-15_000.log');
    const childPending = { stdout: '', args: ['Bot.Host.dll', '--log-dir', pendingDir], closed: false };
    const waiting = waitForBotAdmissions({
      botChildren: [
        { stdout: '', args: ['Bot.Host.dll', '--log-dir', admittedDir], closed: false },
        childPending,
      ],
      evidenceDir,
      expected: 2,
      timeoutMs: 800,
      pollMs: 40,
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    writeFileSync(pendingPath, [
      'session login requested stressbot01 ws://127.0.0.1:9110/sample True accepted=True',
      'session state changed stressbot01 Active Negotiating established 1 1 False True True account=stressbot01 state=Active previous=Negotiating reason=established',
      '',
    ].join('\n'));
    const latest = await waiting;
    assert.equal(latest.admitted, 2);
    assert.equal(latest.faulted, 0);
    assert.equal(latest.rejected, 0);
  } finally {
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});

test('Wave B admit parser uses the current --log-dir, not a replaced bot-N fault', () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'lumio-bot-retry-evidence-'));
  try {
    const originalDir = join(evidenceDir, 'bot-1');
    const retryDir = join(evidenceDir, 'bot-1-retry1');
    mkdirSync(originalDir, { recursive: true });
    mkdirSync(retryDir, { recursive: true });
    writeFileSync(join(originalDir, '2026-09-15_000.log'), [
      'session login requested stressbot00 ws://127.0.0.1:9110/sample True accepted=True',
      'session state changed stressbot00 Faulted Negotiating session_faulted 1 1 False False False state=Faulted previous=Negotiating reason=session_faulted',
      '',
    ].join('\n'));
    writeFileSync(join(retryDir, '2026-09-15_000.log'), [
      'session login requested stressbot00 ws://127.0.0.1:9110/sample True accepted=True',
      'session state changed stressbot00 Active Negotiating established 1 1 False True True account=stressbot00 state=Active previous=Negotiating reason=established',
      '',
    ].join('\n'));
    writeFileSync(join(evidenceDir, 'bot-1.log'), `$ overwritten-by-retry --log-dir ${retryDir}\n`);
    const original = {
      stdout: `$ ["dotnet","Bot.Host","--log-dir","${originalDir}"]\n`,
      args: ['Bot.Host.dll', '--log-dir', originalDir],
    };
    const retry = {
      stdout: `$ ["dotnet","Bot.Host","--log-dir","${retryDir}"]\n`,
      args: ['Bot.Host.dll', '--log-dir', retryDir],
    };
    const condemned = countAdmittedBotHosts([original], { evidenceDir });
    assert.equal(condemned.admitted, 0);
    assert.equal(condemned.faulted, 1);
    const recovered = countAdmittedBotHosts([retry], { evidenceDir });
    assert.equal(recovered.admitted, 1, collectLiveBotEvidenceText({ evidenceDir, index: 0, child: retry }));
    assert.equal(recovered.faulted, 0);
    assert.equal(recovered.rejected, 0);
    assert.doesNotMatch(collectLiveBotEvidenceText({ evidenceDir, index: 0, child: retry }), /session_faulted/);
  } finally {
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});

test('probeMoved requires >=100 ids and >=90 movers across 5s', () => {
  const t0 = { positions: Array.from({ length: 100 }, (_, i) => ({ id: `id-${i}`, x: 0, z: 0 })) };
  const t5fail = { positions: t0.positions.map((row) => ({ ...row })) };
  assert.equal(probeMoved(t0, t5fail).ok, false);
  const t5 = {
    positions: t0.positions.map((row, i) => ({ id: row.id, x: i < 90 ? 1 : 0, z: 0 })),
  };
  const result = probeMoved(t0, t5);
  assert.equal(result.idCount, 100);
  assert.equal(result.moved, 90);
  assert.equal(result.ok, true);
});

test('DS endpoint authority comparison accepts allocator route paths and rejects foreign authorities', () => {
  // The Platform issuer adds the `/sample` allocator route to ticket URLs.
  assert.equal(dsEndpointAuthorityMatches('ws://127.0.0.1:9110', 'ws://127.0.0.1:9110/sample'), true);
  assert.equal(dsEndpointAuthorityMatches('ws://127.0.0.1:9110', 'ws://127.0.0.1:9110'), true);
  // A different host, port, or protocol is a different DS.
  assert.equal(dsEndpointAuthorityMatches('ws://127.0.0.1:9110', 'ws://localhost:9110/sample'), false);
  assert.equal(dsEndpointAuthorityMatches('ws://127.0.0.1:9110', 'ws://127.0.0.1:9111/sample'), false);
  assert.equal(dsEndpointAuthorityMatches('ws://127.0.0.1:9110', 'wss://127.0.0.1:9110/sample'), false);
  assert.equal(dsEndpointAuthorityMatches('ws://127.0.0.1:9110', 'ws://10.0.0.5:9110/sample'), false);
  // Credentials, query, and hash are rejected by the parse before comparison.
  assert.equal(dsEndpointAuthorityMatches('ws://127.0.0.1:9110', 'ws://user:secret@127.0.0.1:9110/sample'), false);
  assert.equal(dsEndpointAuthorityMatches('ws://127.0.0.1:9110', 'ws://127.0.0.1:9110/sample?admission=x'), false);
  assert.equal(dsEndpointAuthorityMatches('ws://127.0.0.1:9110', 'ws://127.0.0.1:9110/sample#fragment'), false);
  // DS_READY itself stays root-only: a routed DS endpoint is invalid, not equal.
  assert.equal(dsEndpointAuthorityMatches('ws://127.0.0.1:9110/sample', 'ws://127.0.0.1:9110/sample'), false);
  assert.equal(parseLoopbackWsEndpoint('ws://127.0.0.1:9110/sample', { allowPath: false }), null);
  assert.equal(parseLoopbackWsEndpoint('ws://127.0.0.1:9110/sample').port, 9110);
});

function browserEvidenceRow(overrides = {}) {
  const positions0 = Array.from({ length: 100 }, (_, index) => ({
    id: `id-${index}`,
    x: index,
    z: 0,
    ...(index === 0 ? { self: true } : {}),
  }));
  const base = {
    index: 1,
    headed: true,
    cdpPort: 9222,
    target: { id: 'spectator-page-1', type: 'page', title: 'Spectator', url: 'http://127.0.0.1:4173/' },
    url: 'http://127.0.0.1:4173/',
    runtimeReady: true,
    t0: { status: 'connected', botCount: 100, roomId: 'room-sample-1', positions: positions0 },
    t5: {
      status: 'connected',
      botCount: 100,
      roomId: 'room-sample-1',
      positions: positions0.map((row) => ({ ...row, x: row.x + 1 })),
    },
    canvas: { width: 640, height: 480, painted: 5000, colorPixels: 4200, hueBuckets: 6 },
    screenshot: 'browser-1-t5.png',
    screenshotValid: true,
    screenshotBytes: 4096,
    launch: {
      wsUrl: 'ws://127.0.0.1:9110/sample',
      subprotocol: 'lumio.mvp.v0',
      serverAudience: 'game-fleet-local',
      gameId: 'sample',
      gameReleaseId: 'sample-0.1.0',
      contractId: 'lumio.gameplay-envelope.v1',
      roomId: 'room-sample-1',
      allocationId: 'alloc-sample-1',
    },
  };
  return { ...base, ...overrides, launch: { ...base.launch, ...(overrides.launch ?? {}) } };
}

test('browser evidence gate accepts ticket endpoints carrying the allocator route', () => {
  const expectations = {
    spectatorUrl: 'http://127.0.0.1:4173/',
    expectedRoomId: 'room-sample-1',
    expectedDsEndpoint: 'ws://127.0.0.1:9110',
  };
  const pair = (overrides = {}) => [
    browserEvidenceRow(overrides),
    browserEvidenceRow({
      index: 2,
      cdpPort: 9223,
      target: { id: 'spectator-page-2', type: 'page', title: 'Spectator', url: expectations.spectatorUrl },
      screenshot: 'browser-2-t5.png',
      ...overrides,
    }),
  ];
  assert.deepEqual(validateBrowserEvidence(pair(), expectations).errors, []);
  for (const wsUrl of [
    'ws://127.0.0.1:9111/sample',
    'ws://localhost:9110/sample',
    'wss://127.0.0.1:9110/sample',
  ]) {
    const gate = validateBrowserEvidence(pair({ launch: { wsUrl } }), expectations);
    assert.equal(gate.ok, false, wsUrl);
    assert.ok(gate.errors.some((error) => error.includes('launch endpoint does not match DS_READY')), wsUrl);
  }
  // A non-loopback ticket endpoint is invalid outright, not merely mismatched.
  const nonLoopback = validateBrowserEvidence(pair({ launch: { wsUrl: 'ws://10.0.0.5:9110/sample' } }), expectations);
  assert.equal(nonLoopback.ok, false);
  assert.ok(nonLoopback.errors.some((error) => error.includes('launch endpoint is invalid')));
});

test('missing Bot.Host / DS files stay BLOCKED_ENV and never fake PASS', () => {
  // ADR-123: the engine half is Engine/ only. Empty, the reason is the command that fills it;
  // a release without this platform's lumio-ds names that path. No variable is consulted.
  const isolated = mkdtempSync(join(tmpdir(), 'lumio-spectator-engine-'));
  const env = { LUMIO_PLATFORM_ORIGIN: 'http://127.0.0.1:8080', LUMIO_DS_EXE: '/opt/lumio-ds' };
  assert.equal(missingLiveReason(env, { root: isolated }), 'Engine/ is empty; run: git submodule update --init --depth 1 Engine');
  mkdirSync(join(isolated, 'Engine'), { recursive: true });
  writeFileSync(join(isolated, 'Engine', 'manifest.json'), JSON.stringify({ formatVersion: 1, version: '0.0.1', platforms: [] }));
  assert.match(missingLiveReason(env, { root: isolated }), /Engine\/server\/[a-z]+-[a-z0-9]+\/lumio-ds(\.exe)? is missing from the Engine\/ release$/);
  rmSync(isolated, { recursive: true, force: true });
  assert.equal(existsSync(join(SAMPLE_ROOT, 'Tools', 'spectator-100.mjs')), true);
});

test('POSIX process census recognizes Bot.Host command rows without counting launcher arguments', () => {
  const psOutput = [
    // Linux `ps -eo pid=,comm=,args=` emits the PID and comm prefix before args.
    ' 4201 dotnet         dotnet /opt/lumio/Lumio.Client.Bot.Host.dll --server ws://127.0.0.1:9110',
    // Native hosts may expose a bare executable name in `comm` and args.
    ' 4202 Bot.Host       /opt/lumio/Bot.Host --server ws://127.0.0.1:9110',
    // A quoted assembly path is still the dotnet application token.
    ' 4203 dotnet         dotnet "/opt/lumio/Lumio.Client.Bot.Host.dll" --server ws://127.0.0.1:9110',
    // The acceptance runner carries --bot-dll, but is not itself a Bot.Host.
    ' 4204 node           node Tools/spectator-100.mjs --bot-dll /opt/lumio/Lumio.Client.Bot.Host.dll',
    // An unrelated process mentioning the assembly as an argument is not a host.
    ' 4205 worker         worker --input /tmp/Lumio.Client.Bot.Host.dll',
  ].join('\n');

  assert.equal(countBotHostProcesses(psOutput), 3);
  assert.equal(countBotHostProcesses({ processes: psOutput.split('\n') }), 3);
});

test('CDP target selection is strict and never accepts an unrelated page', () => {
  const targets = [
    { id: 'other', type: 'page', title: 'New Tab', url: 'chrome://newtab/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/other' },
    { id: 'spectator-a', type: 'page', title: 'Spectator A', url: 'http://127.0.0.1:4173/boot-a.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/a' },
  ];
  assert.equal(selectCdpPageTarget(targets, { targetUrl: 'http://127.0.0.1:4173/boot-a.html' }).id, 'spectator-a');
  assert.throws(
    () => selectCdpPageTarget(targets, { targetTitle: 'missing' }),
    /expected exactly one spectator CDP page/,
  );
  assert.throws(
    () => selectCdpPageTarget(targets),
    /expected exactly one spectator CDP page/,
    'an arbitrary first page is not spectator evidence',
  );
});

test('CdpSession registers the pending request before send and dispatches events', async () => {
  class FakeSocket {
    readyState = 1;
    sent = [];
    listeners = new Map();

    addEventListener(type, listener) {
      const list = this.listeners.get(type) ?? [];
      list.push(listener);
      this.listeners.set(type, list);
    }

    removeEventListener(type, listener) {
      this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener));
    }

    send(payload) {
      const request = JSON.parse(payload);
      this.sent.push(request);
      // Deliberately answer synchronously: a listener installed after send races.
      for (const listener of this.listeners.get('message') ?? []) {
        listener({ data: JSON.stringify({ id: request.id, result: { method: request.method } }) });
      }
    }

    close() {
      this.readyState = 3;
    }
  }

  const socket = new FakeSocket();
  const session = new CdpSession(socket, { timeoutMs: 100 });
  const events = [];
  const remove = session.on('Runtime.consoleAPICalled', (event) => events.push(event.type));
  assert.deepEqual(await session.call('Runtime.enable'), { method: 'Runtime.enable' });
  for (const listener of socket.listeners.get('message') ?? []) {
    listener({ data: JSON.stringify({ method: 'Runtime.consoleAPICalled', params: { type: 'log' } }) });
  }
  assert.deepEqual(events, ['log']);
  remove();
  session.close();
  assert.equal(socket.readyState, 3);
});

test('CDP launch injection and evidence redaction keep tickets out of persisted data', () => {
  const credential = 'secret-ticket-for-cdp-test';
  const source = buildCdpLaunchInjection({
    wsUrl: 'ws://127.0.0.1:9110/sample',
    subprotocol: 'lumio.mvp.v0',
    admissionCredential: credential,
  });
  assert.match(source, /__lumioLaunch/);
  assert.match(source, new RegExp(credential));
  const evidence = redactCdpEvidence({
    url: `http://127.0.0.1:4173/index.html?admission=${credential}`,
    launch: { admissionCredential: credential },
    console: [`socket ${credential}`],
  }, [credential]);
  assert.equal(JSON.stringify(evidence).includes(credential), false);
  assert.equal(evidence.launch.admissionCredential, '[REDACTED]');
});

test('CDP snapshot comparison requires authoritative movement of the self point', () => {
  const t0 = {
    status: 'connected',
    botCount: 100,
    selfId: 'self',
    positions: [
      { id: 'self', x: 1, z: 1 },
      ...Array.from({ length: 99 }, (_, index) => ({ id: `bot-${index}`, x: index, z: index })),
    ],
  };
  const noSelfMove = { ...t0, positions: t0.positions.map((row) => ({ ...row, x: row.x + (row.id === 'self' ? 0 : 1) })) };
  assert.equal(compareCdpSpectatorSnapshots(t0, noSelfMove).ok, false);
  const moved = { ...t0, positions: t0.positions.map((row) => ({ ...row, x: row.x + 1 })) };
  const report = compareCdpSpectatorSnapshots(t0, moved, { requiredMoved: 1 });
  assert.equal(report.selfMoved, true);
  assert.equal(report.ok, true);
});

test('normalizeSnapshot keeps replica apply lastError for Wave B FAIL attribution', () => {
  const snapshot = normalizeSnapshot({
    status: 'failed',
    botCount: 0,
    positions: [],
    updatedAtMs: 1,
    lastError: 'authority_apply_failed:Rejected:FullSnapshot',
    lastFrameType: 'WorldChange',
  });
  assert.equal(snapshot.status, 'failed');
  assert.equal(snapshot.lastError, 'authority_apply_failed:Rejected:FullSnapshot');
  assert.equal(snapshot.lastFrameType, 'WorldChange');
});

test('collectCdpSpectatorObservation injects in memory and writes secret-free snapshot plus PNG', async () => {
  const evidenceDir = mkdtempSync(join(tmpdir(), 'lumio-cdp-observation-'));
  const credential = 'secret-ticket-observation';
  const positions0 = [
    { id: 'self', x: 1, z: 1 },
    ...Array.from({ length: 99 }, (_, index) => ({ id: `bot-${index}`, x: index % 10, z: Math.floor(index / 10) })),
  ];
  const positions5 = positions0.map((row) => ({ ...row, x: row.x + 1 }));
  const snapshots = [
    { status: 'connected', botCount: 100, selfId: 'self', updatedAtMs: 1, positions: positions0 },
    { status: 'connected', botCount: 100, selfId: 'self', updatedAtMs: 2, positions: positions5 },
  ];
  class FakeSocket {
    readyState = 1;
    listeners = new Map();
    sent = [];
    addEventListener(type, listener) { const list = this.listeners.get(type) ?? []; list.push(listener); this.listeners.set(type, list); }
    removeEventListener(type, listener) { this.listeners.set(type, (this.listeners.get(type) ?? []).filter((item) => item !== listener)); }
    send(payload) {
      const request = JSON.parse(payload);
      this.sent.push(request);
      let result = {};
      if (request.method === 'Runtime.evaluate') {
        const expression = String(request.params?.expression ?? '');
        if (expression.includes('window.__lumioSpectator')) result = { result: { value: snapshots.shift() ?? snapshots.at(-1) } };
        else result = { result: { value: { width: 640, height: 480, painted: 10, colorPixels: 9, hueBuckets: 3, spanX: 20, spanY: 20 } } };
      } else if (request.method === 'Page.addScriptToEvaluateOnNewDocument') {
        result = { identifier: 'injection-1' };
      } else if (request.method === 'Page.captureScreenshot') {
        result = { data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' };
      }
      for (const listener of this.listeners.get('message') ?? []) {
        listener({ data: JSON.stringify({ id: request.id, result }) });
      }
    }
    close() { this.readyState = 3; }
  }
  const socket = new FakeSocket();
  const screenshotPath = join(evidenceDir, 'spectator-a.png');
  const evidencePath = join(evidenceDir, 'spectator-a.json');
  try {
    const observation = await collectCdpSpectatorObservation({
      port: 9222,
      label: 'A',
      targetUrl: 'http://127.0.0.1:4173/boot-a.html',
      pageUrl: 'http://127.0.0.1:4173/index.html',
      launch: { wsUrl: 'ws://127.0.0.1:9110/sample', subprotocol: 'lumio.mvp.v0', admissionCredential: credential },
      fetchImpl: async () => ({ json: async () => [{ id: 'a', type: 'page', title: 'A', url: 'http://127.0.0.1:4173/boot-a.html', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/a' }] }),
      WebSocketImpl: class { constructor() { return socket; } },
      probeWindowMs: 0,
      pollMs: 0,
      readyTimeoutMs: 500,
      screenshotPath,
      evidencePath,
    });
    assert.equal(observation.ok, true);
    assert.equal(observation.movement.selfMoved, true);
    assert.equal(existsSync(screenshotPath), true);
    const persisted = readFileSync(evidencePath, 'utf8');
    assert.equal(persisted.includes(credential), false);
    assert.ok(socket.sent.some((request) => request.method === 'Page.addScriptToEvaluateOnNewDocument'));
    assert.ok(socket.sent.some((request) => request.method === 'Page.removeScriptToEvaluateOnNewDocument'));
  } finally {
    rmSync(evidenceDir, { recursive: true, force: true });
  }
});

function fakeShas() {
  return Object.fromEntries(SHA_REPOS.map((name) => [name, 'a'.repeat(40)]));
}

function idleReservedPorts(ports) {
  const busy = new Set(ports);
  return {
    processCensus: async () => [],
    portInUse: async (port) => busy.has(Number(port)),
    collectRepoShas: async () => fakeShas(),
  };
}

test('preflight reuses a healthy Platform on 8080 without --start-platform', async () => {
  const result = await preflightLiveTopology({
    env: { LIVE_BOTS: '0', LUMIO_PLATFORM_ORIGIN: 'http://127.0.0.1:8080' },
    options: {
      ...idleReservedPorts([8080]),
      origin: 'http://127.0.0.1:8080',
      spectatorUrl: 'http://127.0.0.1:4173/',
      fetchImpl: async () => ({ ok: true, status: 200 }),
    },
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.platformAlreadyRunning, true);
  assert.deepEqual(result.busyPorts, []);
});

test('preflight still blocks a reserved 8080 that is not a healthy Platform', async () => {
  const result = await preflightLiveTopology({
    env: { LIVE_BOTS: '0', LUMIO_PLATFORM_ORIGIN: 'http://127.0.0.1:8080' },
    options: {
      ...idleReservedPorts([8080]),
      origin: 'http://127.0.0.1:8080',
      spectatorUrl: 'http://127.0.0.1:4173/',
      fetchImpl: async () => { throw new Error('ECONNREFUSED'); },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.status, 'BLOCKED_ENV');
  assert.match(String(result.reason), /reserved port\(s\): 8080/);
});

test('preflight does not treat a healthy origin as free when --start-platform needs the port', async () => {
  const result = await preflightLiveTopology({
    env: { LIVE_BOTS: '0', LUMIO_PLATFORM_ORIGIN: 'http://127.0.0.1:8080' },
    options: {
      ...idleReservedPorts([8080]),
      origin: 'http://127.0.0.1:8080',
      startPlatform: true,
      spectatorUrl: 'http://127.0.0.1:4173/',
      fetchImpl: async () => ({ ok: true, status: 200 }),
    },
  });
  assert.equal(result.ok, false);
  assert.match(String(result.reason), /reserved port\(s\): 8080/);
});

test('probePlatformHealth reports a one-shot /healthz without waiting the live timeout', async () => {
  const probe = await probePlatformHealth('http://127.0.0.1:8080', {
    fetchImpl: async () => ({ ok: true, status: 200 }),
  });
  assert.equal(probe.ok, true);
  assert.equal(probe.status, 200);
  assert.equal(probe.healthUrl, 'http://127.0.0.1:8080/healthz');
});

const MATCHING_ABI = '3b62124b6f819b69164304fd4b0583d2f6acfdfa0364c64d06d68a2985d33663';
const STALE_ABI = 'a3248c1dd9e5e8a444a2f1b26ea87cd128d4195ceaec40c9eb01b615519a27f7';

function writeUtf16Dll(path, abiHash) {
  writeFileSync(path, Buffer.from(`AbiConstants.DefinitionSha256\0${abiHash}\0`, 'utf16le'));
}

function writeNativePair(dir, { abiHash = MATCHING_ABI, payload = 'native-image' } = {}) {
  mkdirSync(dir, { recursive: true });
  const nativePath = join(dir, 'lumio_engine_native.dll');
  writeFileSync(nativePath, payload);
  const binarySha256 = createHash('sha256').update(Buffer.from(payload)).digest('hex');
  writeFileSync(join(dir, 'build-info.json'), `${JSON.stringify({
    buildId: 'testhostbuildid0000000000000001',
    abiHash,
    binarySha256,
  })}\n`);
  return { nativePath, binarySha256 };
}

const SPECTATOR_WASM_OK = `prefix ${SPECTATOR_WASM_CONNECTION_STATE_MARKER} ${SPECTATOR_WASM_APPLY_ERROR_MARKER} suffix`;

/**
 * A publish-shaped spectator bundle: index.html with the SDK-filled import map,
 * `_framework/dotnet.<fingerprint>.js` (never a plain dotnet.js) and the host
 * assembly `Lumio.Sample.Client.Spectator.<fingerprint>.wasm`.
 */
function writeSpectatorBundle(bundle, {
  wasmName = 'Lumio.Sample.Client.Spectator.test.wasm',
  wasmContent = SPECTATOR_WASM_OK,
  importMap = { imports: { './_framework/dotnet.js': './_framework/dotnet.abc123.js' } },
  dotnetName = 'dotnet.abc123.js',
  extraFramework = {},
} = {}) {
  const framework = join(bundle, '_framework');
  mkdirSync(framework, { recursive: true });
  const mapText = importMap == null ? '' : JSON.stringify(importMap);
  writeFileSync(join(bundle, 'index.html'), `<!doctype html><html><head><script type="importmap">${mapText}</script></head><body><script type="module" src="main.js"></script></body></html>`);
  if (dotnetName) writeFileSync(join(framework, dotnetName), 'export{gt as default,ft as dotnet,mt as exit};');
  if (wasmName) writeFileSync(join(framework, wasmName), wasmContent);
  for (const [name, content] of Object.entries(extraFramework)) writeFileSync(join(framework, name), content);
  return bundle;
}

test('compiledNativeLoaderAbi reads the UTF-16 DefinitionSha256 from the shipped assembly layout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-native-loader-abi-'));
  const loader = join(dir, 'Lumio.Engine.NativeLoader.dll');
  try {
    writeUtf16Dll(loader, MATCHING_ABI);
    assert.equal(compiledNativeLoaderAbi(loader), MATCHING_ABI);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nativeAbiAgreement accepts a sidecar whose ABI and binary hash match NativeLoader', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-native-abi-ok-'));
  try {
    const { nativePath, binarySha256 } = writeNativePair(dir);
    const gameplay = join(dir, 'Lumio.Sample.Gameplay.dll');
    writeFileSync(gameplay, 'gameplay');
    writeUtf16Dll(join(dir, 'Lumio.Engine.NativeLoader.dll'), MATCHING_ABI);
    const agreement = nativeAbiAgreement({ engineNative: nativePath, gameplay });
    assert.equal(agreement.ok, true, agreement.reason);
    assert.equal(agreement.sidecarAbi, MATCHING_ABI);
    assert.equal(agreement.compiledAbi, MATCHING_ABI);
    assert.equal(agreement.binarySha256, binarySha256);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nativeAbiAgreement refuses a stale native sidecar before DS boot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-native-abi-stale-'));
  try {
    const { nativePath } = writeNativePair(dir, { abiHash: STALE_ABI });
    const gameplay = join(dir, 'Lumio.Sample.Gameplay.dll');
    writeFileSync(gameplay, 'gameplay');
    writeUtf16Dll(join(dir, 'Lumio.Engine.NativeLoader.dll'), MATCHING_ABI);
    const agreement = nativeAbiAgreement({ engineNative: nativePath, gameplay });
    assert.equal(agreement.ok, false);
    assert.match(String(agreement.reason), /tick_binding_unavailable/);
    assert.equal(agreement.sidecarAbi, STALE_ABI);
    assert.equal(agreement.compiledAbi, MATCHING_ABI);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('nativeAbiAgreement refuses a sidecar whose binary hash does not match the image', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-native-abi-hash-'));
  try {
    const { nativePath } = writeNativePair(dir);
    writeFileSync(nativePath, 'tampered-native-image');
    const gameplay = join(dir, 'Lumio.Sample.Gameplay.dll');
    writeFileSync(gameplay, 'gameplay');
    writeUtf16Dll(join(dir, 'Lumio.Engine.NativeLoader.dll'), MATCHING_ABI);
    const agreement = nativeAbiAgreement({ engineNative: nativePath, gameplay });
    assert.equal(agreement.ok, false);
    assert.match(String(agreement.reason), /does not match sidecar/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dsTimerOwnerAbi accepts a lumio-ds image that carries timer_manager_owner', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-ds-timer-ok-'));
  try {
    const dsExe = join(dir, 'lumio-ds.exe');
    writeFileSync(dsExe, `prefix ${DS_TIMER_OWNER_MARKER} suffix`);
    const agreement = dsTimerOwnerAbi(dsExe);
    assert.equal(agreement.ok, true, agreement.reason);
    assert.equal(agreement.marker, DS_TIMER_OWNER_MARKER);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dsTimerOwnerAbi refuses a pre-timer-v2 lumio-ds before DS boot', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-ds-timer-stale-'));
  try {
    const dsExe = join(dir, 'lumio-ds.exe');
    writeFileSync(dsExe, 'timer_register_scope BLOCKED: timer_register_scope status');
    const agreement = dsTimerOwnerAbi(dsExe);
    assert.equal(agreement.ok, false);
    assert.match(String(agreement.reason), /timer_manager_owner/);
    assert.match(String(agreement.reason), /timer_register_scope status 7/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dsConsumerAbiAgreement refuses a lumio-ds compiled against a different Engine ABI identity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-ds-consumer-stale-'));
  try {
    const dsExe = join(dir, 'lumio-ds.exe');
    writeFileSync(dsExe, `prefix ${DS_TIMER_OWNER_MARKER} ${STALE_ABI} suffix`);
    const agreement = dsConsumerAbiAgreement({ dsExe, sidecarAbi: MATCHING_ABI });
    assert.equal(agreement.ok, false);
    assert.match(String(agreement.reason), /sdk_version_mismatch/);
    assert.equal(agreement.sidecarAbi, MATCHING_ABI);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('dsConsumerAbiAgreement accepts a lumio-ds that embeds the sidecar ABI', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-ds-consumer-ok-'));
  try {
    const dsExe = join(dir, 'lumio-ds.exe');
    writeFileSync(dsExe, `prefix ${DS_TIMER_OWNER_MARKER} ${MATCHING_ABI} suffix`);
    const agreement = dsConsumerAbiAgreement({ dsExe, sidecarAbi: MATCHING_ABI });
    assert.equal(agreement.ok, true, agreement.reason);
    assert.equal(agreement.sidecarAbi, MATCHING_ABI);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLiveTopology refuses a lumio-ds compiled against a detached Engine ABI before minting tickets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-ds-consumer-live-'));
  const evidence = mkdtempSync(join(tmpdir(), 'lumio-ds-consumer-evidence-'));
  try {
    const { nativePath } = writeNativePair(dir);
    const gameplay = join(dir, 'Lumio.Sample.Gameplay.dll');
    writeFileSync(gameplay, 'gameplay');
    writeUtf16Dll(join(dir, 'Lumio.Engine.NativeLoader.dll'), MATCHING_ABI);
    const botDll = join(dir, 'Lumio.Client.Bot.Host.dll');
    writeFileSync(botDll, 'bot');
    const dsExe = join(dir, 'lumio-ds.exe');
    writeFileSync(dsExe, `stale-consumer ${DS_TIMER_OWNER_MARKER} ${STALE_ABI}`);
    const dsConfig = join(dir, 'server.json');
    writeFileSync(dsConfig, JSON.stringify({
      clr: { kernel_config: KERNEL_CONFIG },
      allocation: {
        serverAudience: 'game-fleet-local',
        gameId: 'sample',
        gameReleaseId: 'sample-0.1.0',
        contractId: 'lumio.gameplay-envelope.v1',
        roomId: 'room-sample-1',
        allocationId: 'alloc-sample-1',
      },
      admission_public_key_hex: '9593f57065df3c7303d67a27a458cd4ec8c55de7c5e6c6153b80c5a32ef19cd7',
    }));
    let mintCalled = false;
    const result = await runLiveTopology({
      root: SAMPLE_ROOT,
      evidence,
      document: createSpectatorDocument(),
      env: {
        LIVE_BOTS: '0',
        LUMIO_WAVE_B_LIVE: '1',
        LUMIO_PLATFORM_ORIGIN: 'http://127.0.0.1:8080',
      },
      options: {
        authorizeLive: true,
        attachLive: true,
        origin: 'http://127.0.0.1:8080',
        dsExe,
        dsConfig,
        botDll,
        gameplay,
        engineNative: nativePath,
        chrome: join(dir, 'chrome.exe'),
        mintTickets: async () => {
          mintCalled = true;
          throw new Error('tickets must not be minted when lumio-ds ABI identity disagrees');
        },
      },
    });
    assert.equal(result.status, 'FAIL', result.error);
    assert.match(String(result.error), /sdk_version_mismatch/);
    assert.equal(mintCalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(evidence, { recursive: true, force: true });
  }
});

test('runLiveTopology refuses a pre-timer-v2 lumio-ds before minting tickets or starting DS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-ds-timer-live-'));
  const evidence = mkdtempSync(join(tmpdir(), 'lumio-ds-timer-evidence-'));
  try {
    const { nativePath } = writeNativePair(dir);
    const gameplay = join(dir, 'Lumio.Sample.Gameplay.dll');
    writeFileSync(gameplay, 'gameplay');
    writeUtf16Dll(join(dir, 'Lumio.Engine.NativeLoader.dll'), MATCHING_ABI);
    const botDll = join(dir, 'Lumio.Client.Bot.Host.dll');
    writeFileSync(botDll, 'bot');
    const dsExe = join(dir, 'lumio-ds.exe');
    writeFileSync(dsExe, 'stale-four-arg-timer_register_scope');
    const dsConfig = join(dir, 'server.json');
    writeFileSync(dsConfig, JSON.stringify({
      clr: { kernel_config: KERNEL_CONFIG },
      allocation: {
        serverAudience: 'game-fleet-local',
        gameId: 'sample',
        gameReleaseId: 'sample-0.1.0',
        contractId: 'lumio.gameplay-envelope.v1',
        roomId: 'room-sample-1',
        allocationId: 'alloc-sample-1',
      },
      admission_public_key_hex: '9593f57065df3c7303d67a27a458cd4ec8c55de7c5e6c6153b80c5a32ef19cd7',
    }));
    let mintCalled = false;
    const result = await runLiveTopology({
      root: SAMPLE_ROOT,
      evidence,
      document: createSpectatorDocument(),
      env: {
        LIVE_BOTS: '0',
        LUMIO_WAVE_B_LIVE: '1',
        LUMIO_PLATFORM_ORIGIN: 'http://127.0.0.1:8080',
      },
      options: {
        authorizeLive: true,
        attachLive: true,
        origin: 'http://127.0.0.1:8080',
        dsExe,
        dsConfig,
        botDll,
        gameplay,
        engineNative: nativePath,
        chrome: join(dir, 'chrome.exe'),
        mintTickets: async () => {
          mintCalled = true;
          throw new Error('tickets must not be minted when lumio-ds is pre-timer-v2');
        },
      },
    });
    assert.equal(result.status, 'FAIL', result.error);
    assert.match(String(result.error), /timer_manager_owner/);
    assert.equal(mintCalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(evidence, { recursive: true, force: true });
  }
});

test('client LumioEcsSide OutputPath is isolated from the default server output', () => {
  const csproj = join(SAMPLE_ROOT, 'Gameplay', 'Lumio.Sample.Gameplay.csproj');
  const queryOutputPath = (extraArgs) => {
    const stdout = execFileSync(
      'dotnet',
      ['msbuild', csproj, '-nologo', '-getProperty:OutputPath', '-p:Configuration=Debug', ...extraArgs],
      { encoding: 'utf8' },
    );
    return resolve(String(stdout).trim());
  };
  const serverOutput = queryOutputPath([]);
  const clientOutput = queryOutputPath(['-p:LumioEcsSide=client']);
  assert.notEqual(clientOutput, serverOutput);
  assert.match(clientOutput.replaceAll('\\', '/'), /\/net10\.0-client\/?$/);
  assert.doesNotMatch(serverOutput.replaceAll('\\', '/'), /net10\.0-client/);
});

test('gameplayRegistrySideAgreement accepts a client compile that embeds MiningSparkEntity', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-gameplay-client-ok-'));
  try {
    const gameplay = join(dir, 'Lumio.Sample.Gameplay.dll');
    writeFileSync(gameplay, Buffer.from(`prefix\0${GAMEPLAY_CLIENT_MARKER}\0suffix`, 'utf16le'));
    const agreement = gameplayRegistrySideAgreement(gameplay);
    assert.equal(agreement.ok, true, agreement.reason);
    assert.equal(agreement.side, 'client');
    assert.equal(agreement.marker, GAMEPLAY_CLIENT_MARKER);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gameplayRegistrySideAgreement refuses a server compile before Bot.Host starts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-gameplay-server-'));
  try {
    const gameplay = join(dir, 'Lumio.Sample.Gameplay.dll');
    writeFileSync(gameplay, Buffer.from('server-side GeneratedRegistry without local FX types', 'utf16le'));
    const agreement = gameplayRegistrySideAgreement(gameplay);
    assert.equal(agreement.ok, false);
    assert.match(String(agreement.reason), /LumioEcsSide=client/);
    assert.match(String(agreement.reason), new RegExp(GAMEPLAY_CLIENT_MARKER));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('baseMapCaptureAgreement accepts committed maps/sample.voxel against server.json SHA', () => {
  const dsConfig = join(SAMPLE_ROOT, 'Server', 'Config', 'Startup', 'server.json');
  const agreement = baseMapCaptureAgreement({ root: SAMPLE_ROOT, dsConfig, env: {} });
  assert.equal(agreement.ok, true, agreement.reason);
  assert.match(String(agreement.sha256), /^[0-9a-f]{64}$/);
  const declared = JSON.parse(readFileSync(dsConfig, 'utf8')).base_map_content_sha256;
  assert.equal(agreement.sha256, declared);
});

test('baseMapCaptureAgreement refuses a SHA that does not match the capture bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-basemap-sha-'));
  try {
    const mapPath = join(dir, 'sample.voxel');
    writeFileSync(mapPath, '{"configHash":"x"} LUMIOSNP1');
    const agreement = baseMapCaptureAgreement({
      root: dir,
      env: {
        LUMIO_BASE_MAP_PATH: mapPath,
        LUMIO_BASE_MAP_SHA256: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      },
    });
    assert.equal(agreement.ok, false);
    assert.match(String(agreement.reason), /does not match/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('buildChildEnv leaves the capture to the config path and only injects the env fallback', () => {
  // server.json names base_map_path; the 2026-09-22 HostEntry guard rejects
  // voxelSnapshotBase64 + LUMIO_BASE_MAP_PATH together, so the env must stay unset.
  const withConfigPath = buildChildEnv({
    env: {},
    root: SAMPLE_ROOT,
    dsConfig: join(SAMPLE_ROOT, 'Server', 'Config', 'Startup', 'server.json'),
  });
  assert.equal(withConfigPath.LUMIO_BASE_MAP_PATH, undefined);
  assert.equal(
    withConfigPath.LUMIO_BASE_MAP_SHA256,
    JSON.parse(readFileSync(join(SAMPLE_ROOT, 'Server', 'Config', 'Startup', 'server.json'), 'utf8')).base_map_content_sha256,
  );

  // Without a config path the env fallback carries the capture for HostEntry.
  const dir = mkdtempSync(join(tmpdir(), 'lumio-childenv-'));
  try {
    const bare = JSON.parse(readFileSync(join(SAMPLE_ROOT, 'Server', 'Config', 'Startup', 'server.json'), 'utf8'));
    delete bare.base_map_path;
    const configPath = join(dir, 'server.json');
    writeFileSync(configPath, JSON.stringify(bare));
    const fallback = buildChildEnv({ env: {}, root: SAMPLE_ROOT, dsConfig: configPath });
    assert.equal(fallback.LUMIO_BASE_MAP_PATH, join(SAMPLE_ROOT, 'Server', 'Assets', 'Maps', 'sample.voxel'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLiveTopology refuses a missing first-boot voxel capture before minting tickets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-basemap-live-'));
  const evidence = mkdtempSync(join(tmpdir(), 'lumio-basemap-evidence-'));
  try {
    const { nativePath } = writeNativePair(dir);
    const gameplay = join(dir, 'Lumio.Sample.Gameplay.dll');
    writeFileSync(gameplay, Buffer.from(`prefix\0${GAMEPLAY_CLIENT_MARKER}\0suffix`, 'utf16le'));
    writeUtf16Dll(join(dir, 'Lumio.Engine.NativeLoader.dll'), MATCHING_ABI);
    const botDll = join(dir, 'Lumio.Client.Bot.Host.dll');
    writeFileSync(botDll, 'bot');
    const dsExe = join(dir, 'lumio-ds.exe');
    writeFileSync(dsExe, `ok-consumer ${DS_TIMER_OWNER_MARKER} ${MATCHING_ABI}`);
    const dsConfig = join(dir, 'server.json');
    writeFileSync(dsConfig, JSON.stringify({
      clr: { kernel_config: KERNEL_CONFIG },
      allocation: {
        serverAudience: 'game-fleet-local',
        gameId: 'sample',
        gameReleaseId: 'sample-0.1.0',
        contractId: 'lumio.gameplay-envelope.v1',
        roomId: 'room-sample-1',
        allocationId: 'alloc-sample-1',
      },
      admission_public_key_hex: '9593f57065df3c7303d67a27a458cd4ec8c55de7c5e6c6153b80c5a32ef19cd7',
      base_map_content_sha256: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    }));
    let mintCalled = false;
    const result = await runLiveTopology({
      root: SAMPLE_ROOT,
      evidence,
      document: createSpectatorDocument(),
      env: {
        LIVE_BOTS: '0',
        LUMIO_WAVE_B_LIVE: '1',
        LUMIO_PLATFORM_ORIGIN: 'http://127.0.0.1:8080',
        LUMIO_BASE_MAP_PATH: join(dir, 'missing.voxel'),
      },
      options: {
        authorizeLive: true,
        attachLive: true,
        origin: 'http://127.0.0.1:8080',
        dsExe,
        dsConfig,
        botDll,
        gameplay,
        engineNative: nativePath,
        chrome: join(dir, 'chrome.exe'),
        mintTickets: async () => {
          mintCalled = true;
          throw new Error('tickets must not be minted when the first-boot capture is missing');
        },
      },
    });
    assert.equal(result.status, 'FAIL', result.error);
    assert.match(String(result.error), /first-boot voxel capture is not a file/);
    assert.equal(mintCalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(evidence, { recursive: true, force: true });
  }
});

test('runLiveTopology refuses a server gameplay assembly before minting tickets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-gameplay-side-live-'));
  const evidence = mkdtempSync(join(tmpdir(), 'lumio-gameplay-side-evidence-'));
  try {
    const { nativePath } = writeNativePair(dir);
    const gameplay = join(dir, 'Lumio.Sample.Gameplay.dll');
    writeFileSync(gameplay, Buffer.from('server-side GeneratedRegistry', 'utf16le'));
    writeUtf16Dll(join(dir, 'Lumio.Engine.NativeLoader.dll'), MATCHING_ABI);
    const botDll = join(dir, 'Lumio.Client.Bot.Host.dll');
    writeFileSync(botDll, 'bot');
    const dsExe = join(dir, 'lumio-ds.exe');
    writeFileSync(dsExe, `ok-consumer ${DS_TIMER_OWNER_MARKER} ${MATCHING_ABI}`);
    const dsConfig = join(dir, 'server.json');
    writeFileSync(dsConfig, JSON.stringify({
      clr: { kernel_config: KERNEL_CONFIG },
      allocation: {
        serverAudience: 'game-fleet-local',
        gameId: 'sample',
        gameReleaseId: 'sample-0.1.0',
        contractId: 'lumio.gameplay-envelope.v1',
        roomId: 'room-sample-1',
        allocationId: 'alloc-sample-1',
      },
      admission_public_key_hex: '9593f57065df3c7303d67a27a458cd4ec8c55de7c5e6c6153b80c5a32ef19cd7',
    }));
    let mintCalled = false;
    const result = await runLiveTopology({
      root: SAMPLE_ROOT,
      evidence,
      document: createSpectatorDocument(),
      env: {
        LIVE_BOTS: '0',
        LUMIO_WAVE_B_LIVE: '1',
        LUMIO_PLATFORM_ORIGIN: 'http://127.0.0.1:8080',
      },
      options: {
        authorizeLive: true,
        attachLive: true,
        origin: 'http://127.0.0.1:8080',
        dsExe,
        dsConfig,
        botDll,
        gameplay,
        engineNative: nativePath,
        chrome: join(dir, 'chrome.exe'),
        mintTickets: async () => {
          mintCalled = true;
          throw new Error('tickets must not be minted when gameplay is server-side');
        },
      },
    });
    assert.equal(result.status, 'FAIL', result.error);
    assert.match(String(result.error), /LumioEcsSide=client/);
    assert.equal(mintCalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(evidence, { recursive: true, force: true });
  }
});

test('spectatorWasmAgreement accepts a Spectator wasm that exports ConnectionState', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-spectator-wasm-ok-'));
  try {
    writeSpectatorBundle(dir, { wasmContent: `prefix ${SPECTATOR_WASM_CONNECTION_STATE_MARKER} ${SPECTATOR_WASM_APPLY_ERROR_MARKER} suffix` });
    const agreement = spectatorWasmAgreement({ pageRoot: dir });
    assert.equal(agreement.ok, true, agreement.reason);
    assert.equal(agreement.marker, SPECTATOR_WASM_CONNECTION_STATE_MARKER);
    assert.equal(agreement.applyErrorMarker, SPECTATOR_WASM_APPLY_ERROR_MARKER);
    assert.match(String(agreement.wasm).replaceAll('\\', '/'), /Lumio\.Sample\.Client\.Spectator\.test\.wasm$/);
    assert.match(String(agreement.dotnet).replaceAll('\\', '/'), /_framework\/dotnet\.abc123\.js$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spectatorWasmAgreement refuses a pre-replica-host Spectator wasm missing ConnectionState', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-spectator-wasm-stale-'));
  try {
    writeSpectatorBundle(dir, { wasmName: 'Lumio.Sample.Client.Spectator.stale.wasm', wasmContent: 'DumpPositions IssueSelfMove TakeOutbound WorldInstanceId' });
    const agreement = spectatorWasmAgreement({ pageRoot: dir });
    assert.equal(agreement.ok, false);
    assert.match(String(agreement.reason), /ConnectionState/);
    assert.match(String(agreement.reason), /admission pose/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spectatorWasmAgreement refuses an r18 Spectator wasm missing LastApplyError', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-spectator-wasm-no-apply-error-'));
  try {
    writeSpectatorBundle(dir, { wasmName: 'Lumio.Sample.Client.Spectator.r18.wasm', wasmContent: `prefix ${SPECTATOR_WASM_CONNECTION_STATE_MARKER} suffix` });
    const agreement = spectatorWasmAgreement({ pageRoot: dir });
    assert.equal(agreement.ok, false);
    assert.match(String(agreement.reason), /LastApplyError/);
    assert.match(String(agreement.reason), /unattributed/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spectatorWasmAgreement refuses a _framework without the Sample host wasm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-spectator-wasm-none-'));
  try {
    // The pre-R-00710 LumioClient host name is not the Sample page's host.
    writeSpectatorBundle(dir, { wasmName: 'Lumio.Client.Spectator.old.wasm' });
    const agreement = spectatorWasmAgreement({ pageRoot: dir });
    assert.equal(agreement.ok, false);
    assert.match(String(agreement.reason), /no Lumio\.Sample\.Client\.Spectator\*\.wasm/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spectatorWasmAgreement resolves ./_framework/dotnet.js only through the published import map', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-spectator-dotnet-'));
  try {
    // Source index.html: the SDK has not filled the import map yet.
    writeSpectatorBundle(join(dir, 'source'), { importMap: null });
    const source = spectatorWasmAgreement({ pageRoot: join(dir, 'source') });
    assert.equal(source.ok, false);
    assert.match(String(source.reason), /empty import map/);
    assert.match(String(source.reason), /dotnet\.js fails closed/);

    // A map that does not cover the stable specifier.
    writeSpectatorBundle(join(dir, 'unmapped'), { importMap: { imports: { './other.js': './_framework/dotnet.abc123.js' } } });
    assert.match(String(spectatorWasmAgreement({ pageRoot: join(dir, 'unmapped') }).reason), /does not map \.\/_framework\/dotnet\.js/);

    // The mapped fingerprinted runtime is not in this bundle.
    writeSpectatorBundle(join(dir, 'dangling'), { dotnetName: null });
    assert.match(String(spectatorWasmAgreement({ pageRoot: join(dir, 'dangling') }).reason), /not a file under/);

    // A plain dotnet.js beside an empty map is not what main.js resolves through.
    writeSpectatorBundle(join(dir, 'plain'), { importMap: null, dotnetName: 'dotnet.js' });
    assert.equal(spectatorWasmAgreement({ pageRoot: join(dir, 'plain') }).ok, false);

    writeSpectatorBundle(join(dir, 'published'));
    const published = spectatorDotnetImport(join(dir, 'published'));
    assert.equal(published.ok, true, published.reason);
    assert.equal(published.dotnet, join(dir, 'published', '_framework', 'dotnet.abc123.js'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('browser gameplay compile is netstandard2.1 so NativeLoader cannot unify into spectator wasm', () => {
  const csproj = readFileSync(GAMEPLAY_CSPROJ, 'utf8');
  assert.match(csproj, /LumioBrowserReplica.*true.*netstandard2\.1/s);
  assert.match(csproj, /LumioBrowserReplica.*!=.*true.*net10\.0/s);
});

test('browser replica compile pins Runtime to netstandard2.1 so NativeLoader cannot unify into spectator wasm', () => {
  assert.equal(existsSync(REPLICA_CSPROJ), true, REPLICA_CSPROJ);
  const csproj = readFileSync(REPLICA_CSPROJ, 'utf8');
  assert.match(csproj, /LumioBrowserReplica.*==.*true[\s\S]*TargetFramework=netstandard2\.1/);
  assert.match(csproj, /Lumio\.GameRuntime\.Simulation\.csproj[\s\S]*SetTargetFramework Condition="'\$\(LumioBrowserReplica\)' == 'true'"/);
});

test('spectator wasm host references built ns2.1 Replica/Gameplay DLLs instead of a net10.0 ProjectReference graph', () => {
  // R-00710: the host that publishes the page Wave B serves is this repository's.
  const host = resolve(SAMPLE_ROOT, 'Client', 'UI', 'Spectator', 'host', 'Lumio.Sample.Client.Spectator.csproj');
  assert.equal(existsSync(host), true, host);
  const csproj = readFileSync(host, 'utf8');
  assert.match(csproj, /_SpectatorReplicaDll.*Lumio\.Client\.Gameplay\.ECS\.dll/);
  assert.match(csproj, /_SpectatorGameplayDll.*Lumio\.Sample\.Gameplay\.dll/);
  assert.match(csproj, /RequireBrowserReplicaAssemblies/);
  assert.match(csproj, /ForbidNativeLoaderInBrowserPublish/);
  assert.doesNotMatch(csproj, /ProjectReference Include=.*Lumio\.GameRuntime\.Simulation/);
});

test('spectatorWasmAgreement accepts Hfsm wasm without NativeLoader', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-spectator-wasm-hfsm-ok-'));
  try {
    writeSpectatorBundle(dir, { extraFramework: { 'Lumio.Engine.NativeLoader.Hfsm.ok.wasm': 'hfsm' } });
    const agreement = spectatorWasmAgreement({ pageRoot: dir });
    assert.equal(agreement.ok, true, agreement.reason);
    assert.equal(agreement.nativeLoader, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('spectatorWasmAgreement refuses a browser _framework that still publishes NativeLoader', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-spectator-wasm-nativeloader-'));
  try {
    writeSpectatorBundle(dir, { extraFramework: { 'Lumio.Engine.NativeLoader.deadbeef.wasm': 'NativeLibrary' } });
    const agreement = spectatorWasmAgreement({ pageRoot: dir });
    assert.equal(agreement.ok, false);
    assert.match(String(agreement.reason), /NativeLoader/);
    assert.match(String(agreement.reason), /dump stub empty/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLiveTopology refuses a stale spectator wasm before minting tickets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-spectator-wasm-live-'));
  const evidence = mkdtempSync(join(tmpdir(), 'lumio-spectator-wasm-evidence-'));
  try {
    const { nativePath } = writeNativePair(dir);
    const gameplay = join(dir, 'Lumio.Sample.Gameplay.dll');
    writeFileSync(gameplay, Buffer.from(`prefix\0${GAMEPLAY_CLIENT_MARKER}\0suffix`, 'utf16le'));
    writeUtf16Dll(join(dir, 'Lumio.Engine.NativeLoader.dll'), MATCHING_ABI);
    const botDll = join(dir, 'Lumio.Client.Bot.Host.dll');
    writeFileSync(botDll, 'bot');
    const dsExe = join(dir, 'lumio-ds.exe');
    writeFileSync(dsExe, `ok-consumer ${DS_TIMER_OWNER_MARKER} ${MATCHING_ABI}`);
    const dsConfig = join(dir, 'server.json');
    writeFileSync(dsConfig, JSON.stringify({
      clr: { kernel_config: KERNEL_CONFIG },
      allocation: {
        serverAudience: 'game-fleet-local',
        gameId: 'sample',
        gameReleaseId: 'sample-0.1.0',
        contractId: 'lumio.gameplay-envelope.v1',
        roomId: 'room-sample-1',
        allocationId: 'alloc-sample-1',
      },
      admission_public_key_hex: '9593f57065df3c7303d67a27a458cd4ec8c55de7c5e6c6153b80c5a32ef19cd7',
    }));
    const spectatorRoot = writeSpectatorBundle(join(dir, 'wwwroot'), {
      wasmName: 'Lumio.Sample.Client.Spectator.stale.wasm',
      wasmContent: 'DumpPositions IssueSelfMove TakeOutbound',
    });
    let mintCalled = false;
    const result = await runLiveTopology({
      root: SAMPLE_ROOT,
      evidence,
      document: createSpectatorDocument(),
      env: {
        LIVE_BOTS: '0',
        LUMIO_WAVE_B_LIVE: '1',
        LUMIO_PLATFORM_ORIGIN: 'http://127.0.0.1:8080',
      },
      options: {
        authorizeLive: true,
        attachLive: true,
        origin: 'http://127.0.0.1:8080',
        dsExe,
        dsConfig,
        botDll,
        gameplay,
        engineNative: nativePath,
        chrome: join(dir, 'chrome.exe'),
        spectatorRoot,
        mintTickets: async () => {
          mintCalled = true;
          throw new Error('tickets must not be minted when spectator wasm is stale');
        },
      },
    });
    assert.equal(result.status, 'FAIL', result.error);
    assert.match(String(result.error), /ConnectionState/);
    assert.equal(mintCalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(evidence, { recursive: true, force: true });
  }
});

test('runLiveTopology refuses NativeLoader in spectator _framework before minting tickets', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-spectator-nativeloader-live-'));
  const evidence = mkdtempSync(join(tmpdir(), 'lumio-spectator-nativeloader-evidence-'));
  try {
    const { nativePath } = writeNativePair(dir);
    const gameplay = join(dir, 'Lumio.Sample.Gameplay.dll');
    writeFileSync(gameplay, Buffer.from(`prefix\0${GAMEPLAY_CLIENT_MARKER}\0suffix`, 'utf16le'));
    writeUtf16Dll(join(dir, 'Lumio.Engine.NativeLoader.dll'), MATCHING_ABI);
    const botDll = join(dir, 'Lumio.Client.Bot.Host.dll');
    writeFileSync(botDll, 'bot');
    const dsExe = join(dir, 'lumio-ds.exe');
    writeFileSync(dsExe, `ok-consumer ${DS_TIMER_OWNER_MARKER} ${MATCHING_ABI}`);
    const dsConfig = join(dir, 'server.json');
    writeFileSync(dsConfig, JSON.stringify({
      clr: { kernel_config: KERNEL_CONFIG },
      allocation: {
        serverAudience: 'game-fleet-local',
        gameId: 'sample',
        gameReleaseId: 'sample-0.1.0',
        contractId: 'lumio.gameplay-envelope.v1',
        roomId: 'room-sample-1',
        allocationId: 'alloc-sample-1',
      },
      admission_public_key_hex: '9593f57065df3c7303d67a27a458cd4ec8c55de7c5e6c6153b80c5a32ef19cd7',
    }));
    const spectatorRoot = writeSpectatorBundle(join(dir, 'wwwroot'), {
      extraFramework: { 'Lumio.Engine.NativeLoader.deadbeef.wasm': 'NativeLibrary' },
    });
    let mintCalled = false;
    const result = await runLiveTopology({
      root: SAMPLE_ROOT,
      evidence,
      document: createSpectatorDocument(),
      env: {
        LIVE_BOTS: '0',
        LUMIO_WAVE_B_LIVE: '1',
        LUMIO_PLATFORM_ORIGIN: 'http://127.0.0.1:8080',
      },
      options: {
        authorizeLive: true,
        attachLive: true,
        origin: 'http://127.0.0.1:8080',
        dsExe,
        dsConfig,
        botDll,
        gameplay,
        engineNative: nativePath,
        chrome: join(dir, 'chrome.exe'),
        spectatorRoot,
        mintTickets: async () => {
          mintCalled = true;
          throw new Error('tickets must not be minted when NativeLoader is in spectator _framework');
        },
      },
    });
    assert.equal(result.status, 'FAIL', result.error);
    assert.match(String(result.error), /NativeLoader/);
    assert.equal(mintCalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(evidence, { recursive: true, force: true });
  }
});

test('runLiveTopology refuses a stale native sidecar before minting tickets or starting DS', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-native-abi-live-'));
  const evidence = mkdtempSync(join(tmpdir(), 'lumio-native-abi-evidence-'));
  try {
    const { nativePath } = writeNativePair(dir, { abiHash: STALE_ABI });
    const gameplay = join(dir, 'Lumio.Sample.Gameplay.dll');
    writeFileSync(gameplay, 'gameplay');
    writeUtf16Dll(join(dir, 'Lumio.Engine.NativeLoader.dll'), MATCHING_ABI);
    const botDll = join(dir, 'Lumio.Client.Bot.Host.dll');
    writeFileSync(botDll, 'bot');
    const dsExe = join(dir, 'lumio-ds.exe');
    writeFileSync(dsExe, 'ds');
    const dsConfig = join(dir, 'server.json');
    writeFileSync(dsConfig, JSON.stringify({
      clr: { kernel_config: KERNEL_CONFIG },
      allocation: {
        serverAudience: 'game-fleet-local',
        gameId: 'sample',
        gameReleaseId: 'sample-0.1.0',
        contractId: 'lumio.gameplay-envelope.v1',
        roomId: 'room-sample-1',
        allocationId: 'alloc-sample-1',
      },
      admission_public_key_hex: '9593f57065df3c7303d67a27a458cd4ec8c55de7c5e6c6153b80c5a32ef19cd7',
    }));
    let mintCalled = false;
    const result = await runLiveTopology({
      root: SAMPLE_ROOT,
      evidence,
      document: createSpectatorDocument(),
      env: {
        LIVE_BOTS: '0',
        LUMIO_WAVE_B_LIVE: '1',
        LUMIO_PLATFORM_ORIGIN: 'http://127.0.0.1:8080',
      },
      options: {
        authorizeLive: true,
        attachLive: true,
        origin: 'http://127.0.0.1:8080',
        dsExe,
        dsConfig,
        botDll,
        gameplay,
        engineNative: nativePath,
        chrome: join(dir, 'chrome.exe'),
        mintTickets: async () => {
          mintCalled = true;
          throw new Error('tickets must not be minted when native ABI disagrees');
        },
      },
    });
    assert.equal(result.status, 'FAIL', result.error);
    assert.match(String(result.error), /tick_binding_unavailable|does not match NativeLoader compiled ABI/);
    assert.equal(mintCalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(evidence, { recursive: true, force: true });
  }
});

const CADENCE_LAG_LINE = 'ts=2026-09-15T05:00:00.000000Z level=WARN tick=0 world=0 lang=rs target=host.drop msg="cadence_lag world=- conn=-" generation=0 bytes=0 dropped=12 suppressed=0';
const CADENCE_LAG_RUNTIME_LINE = 'ts=2026-09-15T05:00:01.000000Z level=WARN tick=4102 world=sample lang=rs target=host.drop msg="cadence_lag world=sample conn=conn-1" generation=0 bytes=0 dropped=12 suppressed=0';

function stressTicketManifest() {
  const expiry = Math.floor(Date.now() / 1000) + 3600;
  const accounts = Array.from({ length: 102 }, (_, index) => {
    const loginName = `stressbot${String(index).padStart(3, '0')}`;
    return {
      index,
      loginName,
      accountId: `acct-${loginName}`,
      accountAuthCredential: `acct-secret-${index}`,
      launch: {
        wsUrl: 'ws://127.0.0.1:9110/sample',
        subprotocol: 'lumio.mvp.v0',
        admissionCredential: `ticket-secret-${index}`,
        admissionExpiresAt: expiry,
        serverAudience: 'game-fleet-local',
        gameId: 'sample',
        gameReleaseId: 'sample-0.1.0',
        contractId: 'lumio.gameplay-envelope.v1',
        roomId: 'room-sample-1',
        allocationId: 'alloc-sample-1',
      },
    };
  });
  return {
    version: 1,
    kind: 'lumio.stress-tickets.v1',
    count: 102,
    platformOrigin: 'http://127.0.0.1:8080',
    game: 'sample',
    accounts,
  };
}

function liveTopologyHarness({ dir, nativePath, dsStdout = 'DS_READY {"pid":1,"endpoint":"ws://127.0.0.1:9110"}\n', loggingDir } = {}) {
  const gameplay = join(dir, 'Lumio.Sample.Gameplay.dll');
  writeFileSync(gameplay, Buffer.from(`prefix\0${GAMEPLAY_CLIENT_MARKER}\0suffix`, 'utf16le'));
  writeUtf16Dll(join(dir, 'Lumio.Engine.NativeLoader.dll'), MATCHING_ABI);
  const botDll = join(dir, 'Lumio.Client.Bot.Host.dll');
  writeFileSync(botDll, 'bot');
  const dsExe = join(dir, 'lumio-ds.exe');
  writeFileSync(dsExe, `ok-consumer ${DS_TIMER_OWNER_MARKER} ${MATCHING_ABI}`);
  const dsConfig = join(dir, 'server.json');
  const config = {
    clr: { kernel_config: KERNEL_CONFIG },
    allocation: {
      serverAudience: 'game-fleet-local',
      gameId: 'sample',
      gameReleaseId: 'sample-0.1.0',
      contractId: 'lumio.gameplay-envelope.v1',
      roomId: 'room-sample-1',
      allocationId: 'alloc-sample-1',
    },
    admission_public_key_hex: '9593f57065df3c7303d67a27a458cd4ec8c55de7c5e6c6153b80c5a32ef19cd7',
  };
  if (loggingDir) config.logging = { dir: loggingDir };
  writeFileSync(dsConfig, JSON.stringify(config));
  writeFileSync(join(dir, 'chrome.exe'), 'chrome');
  const spectatorRoot = writeSpectatorBundle(join(dir, 'wwwroot'));
  const voxelConfig = join(dir, 'bot-voxel.json');
  writeFileSync(voxelConfig, '{}');
  const started = [];
  return {
    gameplay,
    botDll,
    dsExe,
    dsConfig,
    chrome: join(dir, 'chrome.exe'),
    nativePath,
    options: {
      authorizeLive: true,
      attachLive: true,
      origin: 'http://127.0.0.1:8080',
      dsExe,
      dsConfig,
      botDll,
      gameplay,
      engineNative: nativePath,
      chrome: join(dir, 'chrome.exe'),
      voxelConfig,
      spectatorRoot,
      spectatorUrl: 'http://127.0.0.1:4173/',
      ticketManifest: stressTicketManifest(),
      writeTicketManifest: false,
      processCensus: async () => [],
      portInUse: async (port) => Number(port) === 8080,
      collectRepoShas: async () => fakeShas(),
      fetchImpl: async () => ({ ok: true, status: 200 }),
      waitForListener: async () => ({ ok: true, status: 200 }),
      processTools: {
        command() { return 'configuration_valid'; },
        startLogged(exe, args = []) {
          started.push({ exe, args: [...args] });
          const isDs = String(exe).toLowerCase().includes('lumio-ds');
          return {
            stdout: isDs ? dsStdout : '',
            child: { pid: isDs ? 11 : 100 + started.length, kill() {} },
            closed: false,
          };
        },
        assertAlive() {},
        waitExit() { return Promise.resolve(); },
        forceCleanup() { return Promise.resolve(); },
      },
    },
    started,
  };
}

test('dsCadenceLagEvidence counts every host.drop cadence_lag line (ADR-118: no boot/runtime split)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-cadence-lag-parse-'));
  try {
    const logPath = join(dir, 'lumio-ds.log');
    writeFileSync(logPath, [
      // ADR-118: cadence is only ever accounted inside "服务中" (from DS_READY
      // onward), so every host.drop cadence_lag line the gate sees is real.
      'ts=t2 level=WARN tick=4102 world=sample lang=rs target=host.drop msg="cadence_lag world=sample conn=conn-1" generation=0 bytes=0 dropped=2 suppressed=0',
      'ts=t3 level=INFO tick=1 world=0 lang=rs target=host.admit msg="admitted" dropped=99',
    ].join('\n'));
    const evidence = dsCadenceLagEvidence(logPath, '');
    assert.equal(evidence.dropped, 2);
    assert.equal(evidence.marker, DS_CADENCE_LAG_MARKER);
    assert.equal(dsCadenceLagEvidence(join(dir, 'missing.log'), 'no lag here').dropped, 0);
    const loggingDir = join(dir, 'ds-logs');
    mkdirSync(loggingDir, { recursive: true });
    writeFileSync(join(loggingDir, '2026-09-15_000.log'), CADENCE_LAG_LINE);
    const fromDir = dsCadenceLagEvidence(join(dir, 'empty-capture.log'), '', [loggingDir]);
    assert.equal(fromDir.dropped, 12, 'must read host.drop cadence_lag from DS logging.dir');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runLiveTopology refuses Bot.Host spawn when lumio-ds already cadence-lags', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-cadence-lag-live-'));
  const evidence = mkdtempSync(join(tmpdir(), 'lumio-cadence-lag-evidence-'));
  try {
    const { nativePath } = writeNativePair(dir);
    const loggingDir = join(dir, 'ds-logs');
    mkdirSync(loggingDir, { recursive: true });
    writeFileSync(join(loggingDir, '2026-09-15_000.log'), `${CADENCE_LAG_RUNTIME_LINE}\n`);
    const harness = liveTopologyHarness({
      dir,
      nativePath,
      loggingDir,
      dsStdout: 'DS_READY {"pid":11,"endpoint":"ws://127.0.0.1:9110"}\n',
    });
    let lagWrittenAfterReady = false;
    const originalStart = harness.options.processTools.startLogged;
    harness.options.processTools.startLogged = (exe, args = []) => {
      const child = originalStart(exe, args);
      if (String(exe).toLowerCase().includes('lumio-ds')) {
        setTimeout(() => {
          lagWrittenAfterReady = true;
          writeFileSync(join(loggingDir, '2026-09-15_000.log'), `${CADENCE_LAG_RUNTIME_LINE}\n`);
        }, 5);
      }
      return child;
    };
    const result = await runLiveTopology({
      root: SAMPLE_ROOT,
      evidence,
      document: createSpectatorDocument(),
      env: {
        LIVE_BOTS: '0',
        LUMIO_WAVE_B_LIVE: '1',
        LUMIO_PLATFORM_ORIGIN: 'http://127.0.0.1:8080',
      },
      options: {
        ...harness.options,
        dsCadenceLagSettleMs: 40,
      },
    });
    assert.equal(lagWrittenAfterReady, true, 'settle window must outlast the delayed logging.dir cadence_lag write');
    assert.equal(DS_CADENCE_LAG_SETTLE_MS, 1000);
    assert.equal(result.status, 'FAIL', result.error);
    assert.match(String(result.error), /dropped 12 cadence frames before Bot.Host spawn/);
    assert.match(String(result.error), /cadence_lag/);
    assert.equal(harness.started.filter((item) => String(item.exe).toLowerCase().includes('bot.host')).length, 0);
    assert.equal(harness.started.some((item) => item.args.includes(harness.botDll)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(evidence, { recursive: true, force: true });
  }
});

// Stand-in for the sibling LumioPlatform/eng/stress-tickets.mjs: records argv, mints nothing.
function writeRecordingIssuer(base) {
  const eng = join(base, 'LumioPlatform', 'eng');
  mkdirSync(eng, { recursive: true });
  const log = join(eng, 'argv.jsonl');
  writeFileSync(join(eng, 'stress-tickets.mjs'), [
    "import { appendFileSync } from 'node:fs';",
    `appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    'process.exit(3);',
  ].join('\n'));
  return () => (existsSync(log)
    ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : []);
}

const prefixArg = (argv) => argv[argv.indexOf('--prefix') + 1];

test('mintTickets signs with one prefix whether the issuer is the real script or injected', async () => {
  const base = mkdtempSync(join(tmpdir(), 'lumio-stress-prefix-'));
  try {
    const root = join(base, 'LumioSample');
    mkdirSync(root, { recursive: true });
    const issuerCalls = writeRecordingIssuer(base);
    const sources = [
      { name: STRESS_PREFIX_ENV, env: { [STRESS_PREFIX_ENV]: 'night7' }, options: { stressPrefix: 'opt5' }, expected: 'night7' },
      { name: 'options.stressPrefix', env: {}, options: { stressPrefix: 'opt5' }, expected: 'opt5' },
      { name: 'default', env: {}, options: {}, expected: TICKET_PREFIX },
    ];
    for (const [index, source] of sources.entries()) {
      const env = { LUMIO_PLATFORM_ORIGIN: 'http://127.0.0.1:8080', ...source.env };
      await assert.rejects(
        mintTickets({ env, root, options: { ...source.options }, evidence: join(base, `real-${index}`) }),
        /stress-tickets exited 3/,
      );
      let injected;
      await assert.rejects(
        mintTickets({
          env,
          root,
          evidence: join(base, `injected-${index}`),
          options: {
            ...source.options,
            mintTickets: async (request) => {
              injected = request.prefix;
              throw new Error('issuer recorded');
            },
          },
        }),
        /issuer recorded/,
      );
      assert.equal(prefixArg(issuerCalls()[index]), source.expected, `real issuer --prefix (${source.name})`);
      assert.equal(injected, source.expected, `injected issuer prefix (${source.name})`);
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('runLiveTopology signs a bot retry ticket with the first round prefix', async () => {
  const base = mkdtempSync(join(tmpdir(), 'lumio-retry-prefix-'));
  try {
    const root = join(base, 'LumioSample');
    const dir = join(base, 'artifacts');
    const { nativePath } = writeNativePair(dir);
    const harness = liveTopologyHarness({ dir, nativePath });
    // A sandbox root so the retry reaches the recording issuer, not the real sibling Platform.
    const maps = join(root, 'Server', 'Assets', 'Maps');
    mkdirSync(maps, { recursive: true });
    writeFileSync(join(maps, 'sample.voxel'), 'LUMIOSNP1 test capture');
    const issuerCalls = writeRecordingIssuer(base);
    const { ticketManifest, ...options } = harness.options;
    const firstRound = [];
    const result = await runLiveTopology({
      root,
      evidence: join(base, 'evidence'),
      document: createSpectatorDocument(),
      env: {
        LIVE_BOTS: '0',
        LUMIO_WAVE_B_LIVE: '1',
        LUMIO_PLATFORM_ORIGIN: 'http://127.0.0.1:8080',
        [STRESS_PREFIX_ENV]: 'night7',
      },
      options: {
        ...options,
        staggerMs: 0,
        dsCadenceLagSettleMs: 0,
        mintTickets: async (request) => {
          firstRound.push(request.prefix);
          return ticketManifest;
        },
        // No bot writes admission evidence, so bot-1 is the first slot the runner re-tickets.
        waitForAdmissions: async () => ({ admitted: 99, rejected: 0, faulted: 1 }),
      },
    });
    assert.equal(result.status, 'FAIL', result.error);
    assert.match(String(result.error), /bot-1 retry ticket minting failed/);
    assert.deepEqual(firstRound, ['night7']);
    const retries = issuerCalls();
    assert.equal(retries.length, 1);
    assert.equal(prefixArg(retries[0]), 'night7');
    assert.equal(retries[0][retries[0].indexOf('--count') + 1], '1');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

function voxelGateArtifacts(dir) {
  const { nativePath } = writeNativePair(dir);
  const gameplay = join(dir, 'Lumio.Sample.Gameplay.dll');
  writeFileSync(gameplay, 'gameplay');
  writeUtf16Dll(join(dir, 'Lumio.Engine.NativeLoader.dll'), MATCHING_ABI);
  const botDll = join(dir, 'Lumio.Client.Bot.Host.dll');
  writeFileSync(botDll, 'bot');
  const dsExe = join(dir, 'lumio-ds.exe');
  // Detached Engine ABI: once past the voxel budget gate, runLiveTopology stops at
  // sdk_version_mismatch before minting tickets or starting any process.
  writeFileSync(dsExe, `stale-consumer ${DS_TIMER_OWNER_MARKER} ${STALE_ABI}`);
  const budget = join(dir, 'bot-voxel-budget.json');
  writeFileSync(budget, '{}');
  const writeDsConfig = (name, worldProfile) => {
    const path = join(dir, name);
    writeFileSync(path, JSON.stringify({
      world_profile: worldProfile,
      clr: { kernel_config: KERNEL_CONFIG },
      allocation: {
        serverAudience: 'game-fleet-local',
        gameId: 'sample',
        gameReleaseId: 'sample-0.1.0',
        contractId: 'lumio.gameplay-envelope.v1',
        roomId: 'room-sample-1',
        allocationId: 'alloc-sample-1',
      },
      admission_public_key_hex: '9593f57065df3c7303d67a27a458cd4ec8c55de7c5e6c6153b80c5a32ef19cd7',
    }));
    return path;
  };
  return { nativePath, gameplay, botDll, dsExe, budget, writeDsConfig };
}

test('missingLiveReason and runLiveTopology give one bot voxel budget verdict, decided by world_profile', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-voxel-gate-'));
  try {
    const { nativePath, gameplay, botDll, dsExe, budget, writeDsConfig } = voxelGateArtifacts(dir);
    const cases = [
      { worldProfile: 'runtime-only', voxelConfig: undefined, blocked: false },
      { worldProfile: 'runtime+voxel', voxelConfig: undefined, blocked: true },
      { worldProfile: 'runtime+voxel', voxelConfig: budget, blocked: false },
    ];
    for (const [index, item] of cases.entries()) {
      const label = `world_profile=${item.worldProfile}, budget ${item.voxelConfig ? 'set' : 'unset'}`;
      const dsConfig = writeDsConfig(`server-${index}.json`, item.worldProfile);
      const preGate = missingLiveReason({
        LUMIO_PLATFORM_ORIGIN: 'http://127.0.0.1:8080',
        LUMIO_DS_CONFIG: dsConfig,
        LUMIO_GAMEPLAY: gameplay,
        ...(item.voxelConfig ? { LUMIO_BOT_VOXEL_CONFIG: item.voxelConfig } : {}),
        LIVE_BOTS: '0',
      }, { overrides: { dsExe, botDll, engineNative: nativePath } });
      let mintCalled = false;
      const live = await runLiveTopology({
        root: SAMPLE_ROOT,
        evidence: join(dir, `evidence-${index}`),
        document: createSpectatorDocument(),
        env: { LIVE_BOTS: '0', LUMIO_WAVE_B_LIVE: '1', LUMIO_PLATFORM_ORIGIN: 'http://127.0.0.1:8080' },
        options: {
          authorizeLive: true,
          attachLive: true,
          origin: 'http://127.0.0.1:8080',
          dsExe,
          dsConfig,
          botDll,
          gameplay,
          engineNative: nativePath,
          voxelConfig: item.voxelConfig,
          chrome: join(dir, 'chrome.exe'),
          mintTickets: async () => {
            mintCalled = true;
            throw new Error('a gate test mints no tickets');
          },
        },
      });
      assert.equal(mintCalled, false, label);
      if (item.blocked) {
        assert.match(String(preGate), /^LUMIO_BOT_VOXEL_CONFIG .*world_profile=runtime\+voxel/, label);
        assert.equal(live.status, 'BLOCKED_ENV', label);
        assert.equal(live.error, `BLOCKED_ENV: ${preGate}`, label);
      } else {
        assert.equal(preGate, null, label);
        assert.equal(live.status, 'FAIL', label);
        assert.match(String(live.error), /sdk_version_mismatch/, label);
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runSpectator100 pre-gate judges the voxel budget runLiveTopology would use', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'lumio-voxel-pregate-'));
  try {
    const { nativePath, gameplay, botDll, dsExe, budget, writeDsConfig } = voxelGateArtifacts(dir);
    const dsConfig = writeDsConfig('server.json', 'runtime+voxel');
    const run = (extra) => runSpectator100({
      root: SAMPLE_ROOT,
      env: { LIVE_BOTS: '0', LUMIO_WAVE_B_LIVE: '1' },
      evidenceDir: join(dir, `evidence-${extra.voxelConfig ? 'budget' : 'none'}`),
      shas: {},
      origin: 'http://127.0.0.1:8080',
      dsExe,
      dsConfig,
      botDll,
      gameplay,
      engineNative: nativePath,
      authorizeLive: true,
      attachLive: true,
      liveRun: () => ({ status: 'BLOCKED_ENV', error: 'reached the live runner' }),
      ...extra,
    });
    // --voxel-config arrives as options.voxelConfig, which runLiveTopology reads first.
    assert.equal((await run({ voxelConfig: budget })).error, 'reached the live runner');
    assert.match(String((await run({})).error), /^BLOCKED_ENV: LUMIO_BOT_VOXEL_CONFIG /);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

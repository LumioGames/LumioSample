import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { planLaunchLogins, resolveSpectatorPageUrl } from './launcher.mjs';
import { TOUR_STEPS } from './tour-steps.mjs';
import {
  CDP_CANVAS_STATS_EXPRESSION,
  CDP_SPECTATOR_SNAPSHOT_EXPRESSION,
  CdpSession,
  buildCdpLaunchInjection,
  collectCdpSpectatorObservation,
  compareCdpSpectatorSnapshots,
  createSpectatorDocument,
  countBotHostProcesses,
  dsEndpointAuthorityMatches,
  parseLoopbackWsEndpoint,
  redactCdpEvidence,
  selectCdpPageTarget,
  missingLiveReason,
  probeMoved,
  runSpectator100,
  spectator100ExitCode,
  uniqueTicketReport,
  validateBrowserEvidence,
} from './spectator-100.mjs';

const SAMPLE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

test('spectator URL never carries credentials', () => {
  const url = resolveSpectatorPageUrl({
    spectatorUrl: 'http://user:ticket-secret@127.0.0.1:4173/modules/web/spectator/?admission=ticket-secret',
  });
  assert.equal(url, 'http://127.0.0.1:4173/modules/web/spectator/');
  assert.doesNotMatch(url, /ticket-secret|admission=/);
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
    spectatorUrl: 'http://127.0.0.1:9413/modules/web/spectator',
  });
  assert.equal(explicitUrl.observedDocument.spectatorUrl, 'http://127.0.0.1:9413/modules/web/spectator/');

  const explicitOrigin = await runPlanning({
    spectatorOrigin: 'http://127.0.0.1:9414',
  });
  assert.equal(explicitOrigin.observedDocument.spectatorUrl, 'http://127.0.0.1:9414/modules/web/spectator/');

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
    target: { id: 'spectator-page-1', type: 'page', title: 'Spectator', url: 'http://127.0.0.1:4173/modules/web/spectator/' },
    url: 'http://127.0.0.1:4173/modules/web/spectator/',
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
    spectatorUrl: 'http://127.0.0.1:4173/modules/web/spectator/',
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
  assert.equal(
    missingLiveReason({ LUMIO_PLATFORM_ORIGIN: 'http://127.0.0.1:8080' }),
    'LUMIO_DS_EXE is not set or is not a file',
  );
  assert.equal(existsSync(join(SAMPLE_ROOT, 'integration', 'spectator-100.mjs')), true);
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
    ' 4204 node           node integration/spectator-100.mjs --bot-dll /opt/lumio/Lumio.Client.Bot.Host.dll',
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

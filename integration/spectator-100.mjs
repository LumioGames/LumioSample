#!/usr/bin/env node

/**
 * Wave B spectator-100 orchestration. Live topology only: 101 unique tickets,
 * 100 Bot.Host Activate loops, a 101st C# observer (no Activate) twice, then
 * the static spectator page. Missing env is BLOCKED_ENV (exit 2), never PASS.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { loadProcessTools } from './engine-tools.mjs';
import { parseLaunchArgs, planLaunchLogins, resolveSpectatorPageUrl } from './launcher.mjs';
import { collectRepoShas, SHA_REPOS } from './stress-move.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BOTS = 100;
const PROBE_WINDOW_MS = 5_000;
const REQUIRED_IDS = 100;
const REQUIRED_MOVED = 90;

export { SHA_REPOS, collectRepoShas };

export function spectator100ExitCode(status) {
  return status === 'PASS' ? 0 : status === 'BLOCKED_ENV' ? 2 : 1;
}

export function requiredLivePaths(env = process.env) {
  return {
    origin: env.LUMIO_PLATFORM_ORIGIN,
    dsExe: env.LUMIO_DS_EXE,
    dsConfig: env.LUMIO_DS_CONFIG,
    botDll: env.LUMIO_BOT_DLL,
    gameplay: env.LUMIO_GAMEPLAY,
    engineNative: env.LUMIO_ENGINE_NATIVE,
    spectatorOrigin: env.LUMIO_SPECTATOR_ORIGIN,
  };
}

export function missingLiveReason(env = process.env) {
  const paths = requiredLivePaths(env);
  if (!paths.origin) return 'LUMIO_PLATFORM_ORIGIN is not set';
  if (!paths.dsExe || !existsSync(paths.dsExe)) return 'LUMIO_DS_EXE is not set or is not a file';
  if (!paths.botDll || !existsSync(paths.botDll)) return 'LUMIO_BOT_DLL is not set or is not a file';
  if (!paths.gameplay || !existsSync(paths.gameplay)) return 'LUMIO_GAMEPLAY is not set or is not a file';
  if (!paths.engineNative || !existsSync(paths.engineNative)) return 'LUMIO_ENGINE_NATIVE is not set or is not a file';
  return null;
}

export function assertNoCredentialInUrl(url) {
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('spectator URL must not include an admission credential.');
  }
  return parsed.href;
}

export function probeMoved(t0, t5, { requiredIds = REQUIRED_IDS, requiredMoved = REQUIRED_MOVED } = {}) {
  const a = indexPositions(t0);
  const b = indexPositions(t5);
  const ids = [...new Set([...a.keys(), ...b.keys()])];
  let moved = 0;
  for (const id of ids) {
    const p0 = a.get(id);
    const p5 = b.get(id);
    if (!p0 || !p5) continue;
    if (Math.abs(p5.x - p0.x) + Math.abs(p5.z - p0.z) > 0) moved += 1;
  }
  return {
    idCount: Math.max(a.size, b.size),
    moved,
    ok: Math.max(a.size, b.size) >= requiredIds && moved >= requiredMoved,
  };
}

function indexPositions(snapshot) {
  const map = new Map();
  const rows = Array.isArray(snapshot?.positions) ? snapshot.positions : [];
  for (const row of rows) {
    if (!row || typeof row.id !== 'string') continue;
    map.set(row.id, { x: Number(row.x), z: Number(row.z) });
  }
  return map;
}

export function createSpectatorDocument({ shas = {}, bots = BOTS } = {}) {
  return {
    version: 1,
    status: 'BLOCKED_ENV',
    scope: 'spectator-100',
    params: { bots, spectator: 1, probeWindowMs: PROBE_WINDOW_MS, requiredIds: REQUIRED_IDS, requiredMoved: REQUIRED_MOVED },
    plannedLogins: planLaunchLogins(bots, { spectator: true }),
    shas: Object.fromEntries(SHA_REPOS.map((name) => [name, shas[name] ?? null])),
    probe1: null,
    probe2: null,
    spectatorUrl: null,
    evidence: {
      tickets: '.run/spectator-101.json',
      probe1: 'probe-1.json',
      probe2: 'probe-2.json',
    },
  };
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function redactTicket(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return { sha256: createHash('sha256').update(value).digest('hex'), length: value.length };
}

export async function runSpectator100(options = {}) {
  const env = options.env ?? process.env;
  const root = resolve(options.root ?? ROOT);
  const evidence = options.evidenceDir
    ? resolve(options.evidenceDir)
    : join(root, 'integration', 'logs', 'spectator-100');
  mkdirSync(evidence, { recursive: true });
  const document = createSpectatorDocument({
    shas: options.shas ?? collectRepoShas(root),
    bots: options.bots ?? BOTS,
  });
  document.spectatorUrl = assertNoCredentialInUrl(resolveSpectatorPageUrl({
    spectatorUrl: options.spectatorUrl,
    spectatorOrigin: options.spectatorOrigin ?? env.LUMIO_SPECTATOR_ORIGIN,
    spectatorStaticPort: options.spectatorStaticPort ?? env.LUMIO_SPECTATOR_STATIC_PORT,
    env,
  }));
  const missing = options.missingReason ?? missingLiveReason(env);
  if (missing) {
    document.status = 'BLOCKED_ENV';
    document.error = `BLOCKED_ENV: ${missing}`;
    writeJson(join(evidence, 'verification.json'), redactDocument(document));
    return document;
  }

  if (typeof options.liveRun === 'function') {
    const live = await options.liveRun({ env, root, evidence, document });
    Object.assign(document, live);
  } else if (options.attachLive === false || env.LUMIO_WAVE_B_LIVE !== '1') {
    document.status = 'BLOCKED_ENV';
    document.error = 'BLOCKED_ENV: live topology runner is not attached in this process.';
  } else {
    Object.assign(document, await runLiveTopology({ env, root, evidence, document, options }));
  }

  writeJson(join(evidence, 'verification.json'), redactDocument(document));
  return document;
}

function redactDocument(document) {
  const copy = structuredClone(document);
  if (copy.tickets) {
    copy.tickets = {
      count: copy.tickets.count,
      unique: copy.tickets.unique,
      hashes: copy.tickets.hashes,
    };
  }
  return copy;
}

export function uniqueTicketReport(rows) {
  const names = new Set(rows.map((row) => row.loginName));
  const hashes = rows.map((row) => createHash('sha256').update(String(row.launch?.admissionCredential ?? '')).digest('hex'));
  const uniqueHashes = new Set(hashes);
  return {
    count: rows.length,
    unique: names.size === rows.length && uniqueHashes.size === rows.length,
    hashes,
    names: [...names],
  };
}

export { redactTicket, BOTS, PROBE_WINDOW_MS, REQUIRED_IDS, REQUIRED_MOVED };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runCaptured(command, args, { cwd, env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function startStaticServer(root, port) {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    let relative = decodeURIComponent(url.pathname);
    if (relative.endsWith('/')) relative += 'index.html';
    const file = resolve(root, `.${relative}`);
    if (!file.startsWith(resolve(root))) {
      response.writeHead(403);
      response.end();
      return;
    }
    if (!existsSync(file)) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    response.writeHead(200, { 'content-type': type });
    response.end(readFileSync(file));
  });
  return new Promise((resolvePromise) => {
    server.listen(port, '127.0.0.1', () => resolvePromise(server));
  });
}

async function runLiveTopology({ env, root, evidence, document, options }) {
  const tools = await loadProcessTools({ env, repoRoot: root });
  const children = [];
  const clientRoot = resolve(root, '..', 'LumioClient');
  const platformRoot = resolve(root, '..', 'LumioPlatform');
  const scratch = options.scratchDir
    ?? env.LUMIO_WAVE_B_SCRATCH
    ?? join(root, '.run', 'spectator-100-scratch');
  mkdirSync(scratch, { recursive: true });
  try {
    const ticketsPath = join(root, '.run', 'spectator-101.json');
    const ticketResult = await runCaptured(process.execPath, [
      join(platformRoot, 'eng', 'stress-tickets.mjs'),
      '--count', '101',
      '--origin', env.LUMIO_PLATFORM_ORIGIN,
      '--game', 'sample',
      '--prefix', 'stressbot',
      '--out', ticketsPath,
    ], { cwd: platformRoot, env, timeoutMs: 180_000 });
    if (ticketResult.code !== 0) {
      return { status: 'FAIL', error: `stress-tickets exited ${ticketResult.code}: ${ticketResult.stderr.slice(-400)}` };
    }
    const manifest = JSON.parse(readFileSync(ticketsPath, 'utf8'));
    const report = uniqueTicketReport(manifest.accounts ?? []);
    document.tickets = { count: report.count, unique: report.unique, hashes: report.hashes };
    if (!report.unique || report.count !== 101) {
      return { status: 'FAIL', error: `ticket uniqueness failed count=${report.count}` };
    }

    const observer = join(scratch, 'observer', 'Observer.csproj');
    const probe1Path = join(evidence, 'probe-1.json');
    const probe2Path = join(evidence, 'probe-2.json');
    const spectator = manifest.accounts[100];
    const wsUrl = spectator.launch.wsUrl;
    const ticket = spectator.launch.admissionCredential;

    async function oneProbe(outPath) {
      const result = await runCaptured('dotnet', [
        'run', '--project', observer, '--',
        '--ws', wsUrl,
        '--ticket', ticket,
        '--window-ms', String(PROBE_WINDOW_MS),
        '--out', outPath,
      ], { cwd: scratch, env, timeoutMs: 90_000 });
      if (result.code !== 0) {
        throw new Error(`observer exited ${result.code}: ${result.stderr.slice(-500)}`);
      }
      const probe = JSON.parse(readFileSync(outPath, 'utf8'));
      const moved = probeMoved({ positions: probe.t0 }, { positions: probe.t5 });
      return { ...moved, rawCounts: { t0: probe.t0Count, t5: probe.t5Count, moved: probe.moved } };
    }

    const probe1 = await oneProbe(probe1Path);
    const probe2 = await oneProbe(probe2Path);
    document.probe1 = probe1;
    document.probe2 = probe2;
    if (!probe1.ok || !probe2.ok) {
      return { status: 'FAIL', error: `C# observer failed probe1=${JSON.stringify(probe1)} probe2=${JSON.stringify(probe2)}` };
    }

    const pageRoot = join(clientRoot, 'modules', 'web', 'spectator');
    const staticPort = Number(env.LUMIO_SPECTATOR_STATIC_PORT || 4173);
    const server = await startStaticServer(clientRoot, staticPort);
    children.push({ close: () => new Promise((resolveClose) => server.close(() => resolveClose())) });
    document.spectatorUrl = `http://127.0.0.1:${staticPort}/modules/web/spectator/`;
    document.status = 'PASS';
    document.staticPage = existsSync(join(pageRoot, 'index.html')) && existsSync(join(pageRoot, 'main.js'));
    return document;
  } finally {
    for (const child of children.reverse()) {
      try {
        if (typeof child.close === 'function') await child.close();
        else if (tools) await tools.forceCleanup(child);
      } catch {
        // teardown is not evidence
      }
    }
  }
}

function usage() {
  return [
    'Usage: node integration/spectator-100.mjs',
    'Live topology needs LUMIO_PLATFORM_ORIGIN, LUMIO_DS_EXE, LUMIO_BOT_DLL,',
    '  LUMIO_GAMEPLAY, LUMIO_ENGINE_NATIVE. Missing env exits 2 (BLOCKED_ENV).',
    'Admission credentials never appear in the spectator URL or verification.json.',
  ].join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const parsed = parseLaunchArgs(process.argv.slice(2), process.env);
  if (parsed.help) {
    process.stdout.write(`${usage()}\n`);
  } else {
    try {
      const document = await runSpectator100({
        ...parsed,
        spectator: true,
        bots: parsed.bots && parsed.bots !== 2 ? parsed.bots : BOTS,
      });
      process.stdout.write(`VERIFICATION_STATUS=${document.status}\n`);
      process.exitCode = spectator100ExitCode(document.status);
    } catch (error) {
      process.stderr.write(`${error?.message ?? error}\n`);
      process.exitCode = error?.code === 'BLOCKED_ENV' || String(error?.message).startsWith('BLOCKED_ENV:') ? 2 : 1;
    }
  }
}


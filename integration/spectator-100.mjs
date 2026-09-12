#!/usr/bin/env node

/**
 * Wave B browser acceptance runner.
 *
 * The acceptance shape is deliberately fixed: one DS room, 100 Bot.Host
 * processes and two independent spectator tickets/windows (102 tickets total).
 * This module is inert unless a caller explicitly attaches the live runner;
 * importing it, or invoking it with an incomplete environment, never starts a
 * process or a browser. Credentials are kept in memory and are redacted from
 * every persisted report and log.
 */

import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildBotArgs,
  buildServerArgs,
  findDsReady,
  redactArgs,
  resolveDsEndpoint,
} from './ds-ready.mjs';
import { assertRunnableDsConfig } from './ds-config.mjs';
import { blocked, loadProcessTools } from './engine-tools.mjs';
import {
  collectBotEvidenceText,
  countAdmittedBots,
  inspectBotAdmit,
  parseBotAdmit,
  parseLaunchArgs,
  resolveSpectatorPageUrl,
} from './launcher.mjs';
import { collectRepoShas, SHA_REPOS } from './stress-move.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const BOTS = 100;
export const SPECTATORS = 2;
export const TOTAL_TICKETS = BOTS + SPECTATORS;
export const PROBE_WINDOW_MS = 5_000;
export const REQUIRED_IDS = 100;
export const REQUIRED_MOVED = 90;
export const DEFAULT_CDP_PORTS = Object.freeze([9222, 9223]);
export const TICKET_MANIFEST_NAME = 'spectator-102.json';
export const TICKET_PREFIX = 'stressbot';
export const TICKET_START_INDEX = 0;
export const REQUIRED_PREFLIGHT_PORTS = Object.freeze([9110, 8080, 4173, 9222, 9223]);
export const LIVE_ENV_FLAG = 'LUMIO_WAVE_B_LIVE';
export const LIVE_AUTH_FLAG = 'authorizeLive';
export const CDP_SPECTATOR_SNAPSHOT_EXPRESSION = 'window.__lumioSpectator ?? null';
export const CDP_CANVAS_STATS_EXPRESSION = `(() => {
  const canvas = document.getElementById("field");
  if (!canvas || typeof canvas.getContext !== "function") return { width: 0, height: 0, painted: 0, colorPixels: 0, hueBuckets: 0, spanX: 0, spanY: 0 };
  const ctx = canvas.getContext("2d");
  if (!ctx || typeof ctx.getImageData !== "function") return { width: canvas.width, height: canvas.height, painted: 0, colorPixels: 0, hueBuckets: 0, spanX: 0, spanY: 0 };
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  let painted = 0; let colorPixels = 0;
  const buckets = [0, 0, 0, 0, 0, 0, 0, 0];
  let minX = canvas.width; let maxX = -1; let minY = canvas.height; let maxY = -1;
  for (let i = 0; i < image.length; i += 4) {
    const r = image[i]; const g = image[i + 1]; const b = image[i + 2]; const a = image[i + 3];
    if (!a || (r < 35 && g < 35 && b < 35)) continue;
    painted += 1;
    // Dots are painted hsla(hue, 85%, 55%, 0.75): a chromatic pixel proves a
    // replicated per-entity color survived the alpha blend with the dark plane.
    const max = Math.max(r, g, b); const min = Math.min(r, g, b);
    const chroma = max - min;
    if (max > 40 && chroma > 40) {
      colorPixels += 1;
      let h;
      if (max === r) h = ((g - b) / chroma + 6) % 6;
      else if (max === g) h = (b - r) / chroma + 2;
      else h = (r - g) / chroma + 4;
      const bucket = Math.floor((h * 60) / 45) % 8;
      buckets[bucket] += 1;
    }
    const pixel = i / 4; const x = pixel % canvas.width; const y = Math.floor(pixel / canvas.width);
    minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
  }
  const hueBuckets = buckets.filter((count) => count > 20).length;
  return { width: canvas.width, height: canvas.height, painted, colorPixels, hueBuckets,
    spanX: maxX >= 0 ? maxX - minX : 0, spanY: maxY >= 0 ? maxY - minY : 0 };
})()`;

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_STATIC_PORT = 4173;
const DEFAULT_DS_PORT = 9110;
const BOT_NAME_PATTERN = /^Bot[0-9]+$/;
const SPECTATOR_NAME_PATTERN = /^Spectator[0-9]+$/;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
const LAUNCH_CONTEXT_FIELDS = Object.freeze([
  'serverAudience',
  'gameId',
  'gameReleaseId',
  'contractId',
  'roomId',
  'allocationId',
]);
const SECRET_KEYS = new Set([
  'password',
  'accountauthcredential',
  'admissioncredential',
  'bottoolcredential',
  'ticket',
  'credential',
  'authorization',
  'headers',
]);

function isSecretKey(key) {
  return SECRET_KEYS.has(String(key).toLowerCase());
}

function isFilePath(value) {
  if (!value) return false;
  try { return statSync(String(value)).isFile(); } catch { return false; }
}

export { SHA_REPOS, collectRepoShas };

export function spectator100ExitCode(status) {
  return status === 'PASS' ? 0 : status === 'BLOCKED_ENV' ? 2 : 1;
}

/** Throw instead of silently changing the requested topology. */
export function assertAcceptanceCounts({ bots = BOTS, spectators = SPECTATORS } = {}) {
  if (bots !== BOTS) {
    const error = new Error(`spectator-100 requires exactly ${BOTS} Bot.Host processes (received ${bots}).`);
    error.code = 'USAGE';
    throw error;
  }
  if (spectators !== SPECTATORS) {
    const error = new Error(`spectator-100 requires exactly ${SPECTATORS} spectator windows (received ${spectators}).`);
    error.code = 'USAGE';
    throw error;
  }
  return { bots: BOTS, spectators: SPECTATORS, tickets: TOTAL_TICKETS };
}

export function planSpectatorLogins(bots = BOTS, spectators = SPECTATORS) {
  assertAcceptanceCounts({ bots, spectators });
  const botLogins = Array.from({ length: BOTS }, (_, index) => `Bot${index + 1}`);
  const spectatorLogins = Array.from({ length: SPECTATORS }, (_, index) => `Spectator${index + 1}`);
  return [...botLogins, ...spectatorLogins];
}

export function requiredLivePaths(env = process.env) {
  return {
    origin: env.LUMIO_PLATFORM_ORIGIN,
    composeFile: env.LUMIO_PLATFORM_COMPOSE,
    dsExe: env.LUMIO_DS_EXE,
    dsConfig: env.LUMIO_DS_CONFIG,
    botDll: env.LUMIO_BOT_DLL,
    gameplay: env.LUMIO_GAMEPLAY,
    engineNative: env.LUMIO_ENGINE_NATIVE,
    engineNativePath: env.LUMIO_ENGINE_NATIVE_PATH,
    configDir: env.LUMIO_CONFIG_DIR,
    chrome: env.LUMIO_CHROME || env.CHROME_PATH,
    spectatorOrigin: env.LUMIO_SPECTATOR_ORIGIN,
    liveBots: env.LIVE_BOTS,
  };
}

/** Return the first missing prerequisite without starting anything. */
export function missingLiveReason(env = process.env, { requireCompose = false } = {}) {
  const paths = requiredLivePaths(env);
  if (!paths.origin) return 'LUMIO_PLATFORM_ORIGIN is not set';
  if (!paths.dsExe || !isFilePath(paths.dsExe)) return 'LUMIO_DS_EXE is not set or is not a file';
  if (!paths.botDll || !isFilePath(paths.botDll)) return 'LUMIO_BOT_DLL is not set or is not a file';
  if (!paths.gameplay || !isFilePath(paths.gameplay)) return 'LUMIO_GAMEPLAY is not set or is not a file';
  const native = paths.engineNative || paths.engineNativePath;
  if (!native || !isFilePath(native)) return 'LUMIO_ENGINE_NATIVE is not set or is not a file';
  if (requireCompose && (!paths.composeFile || !isFilePath(paths.composeFile))) {
    return 'LUMIO_PLATFORM_COMPOSE is not set or is not a file';
  }
  if (String(paths.liveBots ?? '') !== '0') return 'LIVE_BOTS must be exactly 0 before starting the acceptance topology';
  return null;
}

/**
 * Live execution has two independent gates.  The environment marker describes
 * the operator's prepared test profile; the in-process boolean is the explicit
 * action which authorizes this runner to create processes.  Neither one alone
 * is sufficient.
 */
export function liveAuthorization({ env = process.env, options = {} } = {}) {
  const reasons = [];
  if (options.authorizeLive !== true) reasons.push('authorizeLive must be explicitly true');
  if (options.attachLive !== true) reasons.push('attachLive must be explicitly true');
  if (String(env?.[LIVE_ENV_FLAG] ?? '') !== '1') reasons.push(`${LIVE_ENV_FLAG}=1 is required`);
  if (String(env?.LIVE_BOTS ?? '') !== '0') reasons.push('LIVE_BOTS=0 is required');
  return { ok: reasons.length === 0, reasons };
}

function assertLiveAuthorization({ env, options } = {}) {
  const gate = liveAuthorization({ env, options });
  if (!gate.ok) throw blocked(gate.reasons.join('; '));
  return gate;
}

export function assertNoCredentialInUrl(value) {
  let parsed;
  try {
    parsed = new URL(String(value ?? ''));
  } catch {
    throw new Error('spectator URL must be a valid HTTP(S) URL with a hostname.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('spectator URL must be a valid HTTP(S) URL with a hostname.');
  }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('spectator URL must not include credentials, query parameters, or fragments.');
  }
  return parsed.href;
}

/**
 * Parse a loopback WebSocket endpoint for authority comparison. Returns null
 * when the value is not a valid ws(s) URL on a loopback host without
 * credentials, query, or fragment. `allowPath: false` additionally demands a
 * root endpoint — the shape DS_READY is allowed to announce.
 */
export function parseLoopbackWsEndpoint(value, { allowPath = true } = {}) {
  let parsed;
  try {
    parsed = new URL(String(value ?? ''));
  } catch {
    return null;
  }
  if (!['ws:', 'wss:'].includes(parsed.protocol)) return null;
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return null;
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return null;
  if (!allowPath && parsed.pathname !== '/' && parsed.pathname !== '') return null;
  const port = Number(parsed.port || (parsed.protocol === 'wss:' ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { protocol: parsed.protocol, hostname: parsed.hostname, port };
}

/**
 * The one DS endpoint comparison shared by every live gate. A Platform-issued
 * ticket URL may carry an allocator route path (for example `/sample`), but its
 * authority — protocol, hostname, and effective port — must equal the DS_READY
 * authority exactly. Credentials, query, hash, non-loopback hosts, and
 * different ports never survive the parse, and a DS_READY side that itself
 * carries a path is rejected rather than compared.
 */
export function dsEndpointAuthorityMatches(dsEndpoint, ticketEndpoint) {
  const ds = parseLoopbackWsEndpoint(dsEndpoint, { allowPath: false });
  const ticket = parseLoopbackWsEndpoint(ticketEndpoint, { allowPath: true });
  return Boolean(
    ds && ticket
    && ds.protocol === ticket.protocol
    && ds.hostname === ticket.hostname
    && ds.port === ticket.port,
  );
}

function firstNonBlank(...values) {
  for (const value of values) {
    if (value == null) continue;
    const text = String(value).trim();
    if (text !== '') return text;
  }
  return null;
}

/**
 * Resolve only operator-supplied spectator settings. The launcher helper has
 * a useful default URL, but that default is a planning convenience; using it
 * here would make the live runner believe an externally managed page exists
 * and skip the static server it owns.
 */
function resolveExplicitSpectatorUrl({ options = {}, env = {}, document } = {}) {
  const spectatorUrl = firstNonBlank(
    options.spectatorUrl,
    env.LUMIO_SPECTATOR_URL,
    document?.spectatorUrl,
  );
  const spectatorOrigin = firstNonBlank(
    options.spectatorOrigin,
    env.LUMIO_SPECTATOR_ORIGIN,
  );
  if (spectatorUrl == null && spectatorOrigin == null) return null;
  return resolveSpectatorPageUrl({
    spectatorUrl,
    spectatorOrigin,
    spectatorStaticPort: firstNonBlank(
      options.spectatorStaticPort,
      env.LUMIO_SPECTATOR_STATIC_PORT,
    ),
    env,
  });
}

function assertLoopbackPageUrl(value) {
  const href = assertNoCredentialInUrl(value);
  const parsed = new URL(href);
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) {
    throw new Error('spectator page URL must target a loopback host before credentials are injected');
  }
  return href;
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function indexPositions(snapshot) {
  const map = new Map();
  const rows = Array.isArray(snapshot?.positions) ? snapshot.positions : [];
  for (const row of rows) {
    if (!row || (typeof row.id !== 'string' && typeof row.id !== 'number')
        || String(row.id).trim() === '' || !finiteNumber(Number(row.x)) || !finiteNumber(Number(row.z))) continue;
    map.set(String(row.id), { x: Number(row.x), z: Number(row.z), self: row.self === true });
  }
  return map;
}

export function probeMoved(t0, t5, { requiredIds = REQUIRED_IDS, requiredMoved = REQUIRED_MOVED } = {}) {
  const a = indexPositions(t0);
  const b = indexPositions(t5);
  let moved = 0;
  for (const [id, p0] of a) {
    const p5 = b.get(id);
    if (p5 && Math.abs(p5.x - p0.x) + Math.abs(p5.z - p0.z) > 0) moved += 1;
  }
  return {
    idCount: Math.max(a.size, b.size),
    commonIds: [...a.keys()].filter((id) => b.has(id)).length,
    moved,
    ok: Math.max(a.size, b.size) >= requiredIds && moved >= requiredMoved,
  };
}

function redactScalar(value, secrets = []) {
  if (typeof value !== 'string') return value;
  let output = value;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) output = output.split(secret).join('<redacted>');
  }
  // Persisted diagnostics occasionally contain a complete endpoint rather
  // than a structured URL field. Strip routing material from a scalar URL so
  // an unrecognised credential cannot survive in query, fragment, or userinfo.
  try {
    if (/^(?:https?|wss?):\/\//i.test(output.trim())) {
      const parsed = new URL(output.trim());
      parsed.username = '';
      parsed.password = '';
      parsed.search = '';
      parsed.hash = '';
      output = parsed.href;
    }
  } catch { /* ordinary log text */ }
  return output;
}

/** Deeply redact credentials and known secret-bearing fields for persisted evidence. */
export function redactEvidence(value, secrets = []) {
  if (Array.isArray(value)) return value.map((item) => redactEvidence(item, secrets));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSecretKey(key)) {
        const normalizedKey = String(key).toLowerCase();
        if (normalizedKey === 'ticket' && item && typeof item === 'object') output[key] = redactEvidence(item, secrets);
        else if (typeof item === 'string' && item.length > 0) output[key] = redactTicket(item);
        else if (normalizedKey === 'headers') output[key] = '<redacted>';
        else output[key] = null;
      } else {
        output[key] = redactEvidence(item, secrets);
      }
    }
    return output;
  }
  return redactScalar(value, secrets);
}

function writeJson(path, value, secrets = []) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(redactEvidence(value, secrets), null, 2)}\n`);
}

export function redactTicket(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  return {
    sha256: createHash('sha256').update(value, 'utf8').digest('hex'),
    length: value.length,
  };
}

function rowTicket(row) {
  return row?.launch?.admissionCredential ?? row?.admissionCredential;
}

function rowAccountCredential(row) {
  return row?.accountAuthCredential ?? row?.accountAuth?.credential ?? null;
}

function identityText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return '';
}

function distinctValues(values) {
  return values.length > 0 && values.every((value) => value !== '') && new Set(values).size === values.length;
}

/** Validate all identities required by the ticket contract. */
export function uniqueTicketReport(rows, { bots = BOTS, spectators = SPECTATORS } = {}) {
  const list = Array.isArray(rows) ? rows : [];
  const accountIds = list.map((row) => identityText(row?.accountId));
  const names = list.map((row) => identityText(row?.loginName));
  const accountCredentials = list.map((row) => rowAccountCredential(row));
  const tickets = list.map((row) => rowTicket(row));
  const hashes = tickets.map((ticket) => (typeof ticket === 'string' && ticket.length > 0
    ? createHash('sha256').update(ticket, 'utf8').digest('hex')
    : null));
  const accountCredentialHashes = accountCredentials.map((credential) => (
    typeof credential === 'string' && credential.length > 0
      ? createHash('sha256').update(credential, 'utf8').digest('hex')
      : null
  ));
  // Small unit fixtures historically carried only login names and launch
  // tickets.  Keep that useful shape, while requiring account credentials for
  // the complete issuer manifest (validated below).
  const accountIdsPresent = list.length > 0 && list.every((row) => identityText(row?.accountId) !== '');
  // Lightweight callers may omit accountId entirely; strict manifest
  // validation enforces presence separately.  Treat an all-absent set as
  // neutral here, while still rejecting mixed/duplicate IDs.
  const accountIdsUnique = list.length === 0
    || accountIds.every((value) => value === '')
    || distinctValues(accountIds);
  const loginNamesUnique = list.length === 0 || distinctValues(names);
  const ticketHashesUnique = hashes.every(Boolean) && new Set(hashes).size === hashes.length;
  const accountCredentialsPresent = accountCredentials.every((value) => typeof value === 'string' && value.length > 0);
  const accountCredentialsUnique = accountCredentials.every((value) => value == null || value === '')
    || (accountCredentialHashes.every(Boolean) && new Set(accountCredentialHashes).size === accountCredentialHashes.length);
  const expectedCount = bots + spectators;
  const unique = accountIdsUnique && loginNamesUnique && ticketHashesUnique && accountCredentialsUnique;
  return {
    count: list.length,
    expectedCount,
    accountIds,
    names,
    hashes,
    accountCredentials: accountCredentialHashes,
    accountIdsUnique,
    accountIdsPresent,
    loginNamesUnique,
    ticketHashesUnique,
    accountCredentialsPresent,
    accountCredentialsUnique,
    // `unique` describes the identity invariant independent of topology size;
    // `valid` additionally requires the fixed 102-row acceptance shape.
    unique,
    valid: list.length === expectedCount && unique,
  };
}

function partitionMarker(row) {
  for (const key of ['partition', 'role', 'kind', 'accountType', 'type']) {
    if (row?.[key] != null && String(row[key]).trim() !== '') return String(row[key]).trim().toLowerCase();
  }
  const name = identityText(row?.loginName);
  if (SPECTATOR_NAME_PATTERN.test(name) || /(?:spectator|observer|viewer)/i.test(name)) return 'spectator';
  if (BOT_NAME_PATTERN.test(name) || /bot/i.test(name)) return 'bot';
  return null;
}

function isBotPartition(marker) {
  return marker == null || /^(?:bot|bots|stressbot|stress-bot|client|player|load|load-test)$/.test(marker);
}

function isSpectatorPartition(marker) {
  return marker != null && /^(?:spectator|spectators|observer|observers|viewer|viewers)$/.test(marker);
}

function validateLaunchBinding(
  launch,
  index,
  errors,
  { strict = false, nowEpochSeconds = Math.floor(Date.now() / 1000) } = {},
) {
  if (!launch || typeof launch !== 'object' || Array.isArray(launch)) {
    errors.push(`accounts[${index}].launch must be an object`);
    return;
  }
  const required = ['wsUrl', 'subprotocol', 'admissionCredential'];
  if (strict) required.push(...LAUNCH_CONTEXT_FIELDS);
  for (const key of required) {
    if (typeof launch[key] !== 'string' || launch[key].trim() === '') {
      errors.push(`accounts[${index}].launch.${key} is required`);
    }
  }
  if (typeof launch.subprotocol === 'string' && launch.subprotocol !== 'lumio.mvp.v0') {
    errors.push(`accounts[${index}].launch.subprotocol must be lumio.mvp.v0`);
  }
  if (typeof launch.wsUrl === 'string' && launch.wsUrl.trim() !== '') {
    try {
      const endpoint = new URL(launch.wsUrl);
      if (!['ws:', 'wss:'].includes(endpoint.protocol)) errors.push(`accounts[${index}].launch.wsUrl must use ws:// or wss://`);
      if (!LOOPBACK_HOSTS.has(endpoint.hostname)) errors.push(`accounts[${index}].launch.wsUrl must target a loopback host`);
      if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
        errors.push(`accounts[${index}].launch.wsUrl must not contain userinfo, query, or fragment`);
      }
      const port = Number(endpoint.port || (endpoint.protocol === 'wss:' ? 443 : 80));
      if (!Number.isInteger(port) || port < 1 || port > 65_535) errors.push(`accounts[${index}].launch.wsUrl has an invalid port`);
    } catch {
      errors.push(`accounts[${index}].launch.wsUrl is not a valid URL`);
    }
  }
  const expiryValue = launch.admissionExpiresAt;
  const expiryText = typeof expiryValue === 'string' ? expiryValue.trim() : '';
  const expiryMissing = expiryValue == null || (typeof expiryValue === 'string' && expiryText === '');
  if (expiryMissing) {
    if (strict) errors.push(`accounts[${index}].launch.admissionExpiresAt is required`);
  } else {
    // The issuer serializes this field as a JSON number.  Accept a decimal
    // string from older adapters, but reject booleans and other coercible
    // values that could accidentally turn into a valid epoch.
    const expiry = typeof expiryValue === 'number'
      ? expiryValue
      : (/^\d+$/.test(expiryText) ? Number(expiryText) : NaN);
    if (!Number.isSafeInteger(expiry) || expiry <= 0) {
      errors.push(`accounts[${index}].launch.admissionExpiresAt must be a positive epoch value`);
    } else if (strict && expiry <= nowEpochSeconds) {
      errors.push(`accounts[${index}].launch.admissionExpiresAt is expired`);
    }
  }
}

/** Validate a ticket manifest without returning credentials in the result. */
export function validateTicketManifest(
  manifest,
  { bots = BOTS, spectators = SPECTATORS, strict, nowEpochSeconds = Math.floor(Date.now() / 1000) } = {},
) {
  assertAcceptanceCounts({ bots, spectators });
  const rows = Array.isArray(manifest) ? manifest : manifest?.accounts;
  const strictShape = strict ?? (Array.isArray(rows) && rows.length === TOTAL_TICKETS);
  const report = uniqueTicketReport(rows, { bots, spectators });
  const errors = [];
  if (!Array.isArray(rows)) errors.push('manifest.accounts must be an array');
  if (report.count !== TOTAL_TICKETS) errors.push(`expected ${TOTAL_TICKETS} accounts, received ${report.count}`);
  if (strictShape && (!report.accountIdsPresent || !report.accountIdsUnique)) errors.push('accountId values must be present and unique');
  if (!report.loginNamesUnique) errors.push('loginName values must be present and unique');
  if (!report.ticketHashesUnique) errors.push('admissionCredential values must be present and unique');
  if (strictShape && (!report.accountCredentialsPresent || !report.accountCredentialsUnique)) {
    errors.push('accountAuthCredential values must be present and unique');
  }
  if (strictShape && !Array.isArray(manifest)) {
    if (manifest?.version !== 1) errors.push('manifest.version must be 1');
    if (manifest?.kind !== 'lumio.stress-tickets.v1') errors.push('manifest.kind must be lumio.stress-tickets.v1');
    if (manifest?.count !== rows?.length) errors.push('manifest.count must equal accounts.length');
  }
  for (const [index, row] of (rows ?? []).entries()) {
    if (!row || typeof row !== 'object') {
      errors.push(`accounts[${index}] must be an object`);
      continue;
    }
    if (strictShape && (!Number.isInteger(row.index) || row.index !== index)) {
      errors.push(`accounts[${index}].index must equal ${index}`);
    }
    if (identityText(row.loginName) === '') errors.push(`accounts[${index}].loginName is required`);
    validateLaunchBinding(row.launch, index, errors, { strict: strictShape, nowEpochSeconds });
    const marker = partitionMarker(row);
    if (index < BOTS && !isBotPartition(marker)) errors.push(`accounts[${index}] is not in the bot partition`);
    if (index >= BOTS && !isSpectatorPartition(marker)) {
      // Stress-ticket manifests use a neutral stressbot prefix for all rows;
      // the fixed row boundary is their partition marker.  Named spectator
      // rows may use an explicit role or the conventional login prefix.
      const name = identityText(row.loginName);
      if (strictShape && !/^stressbot/i.test(name) && !SPECTATOR_NAME_PATTERN.test(name)) {
        errors.push(`accounts[${index}] is not in the spectator partition`);
      }
    }
  }
  if (strictShape && Array.isArray(rows)) {
    const wsUrls = rows.map((row) => row?.launch?.wsUrl).filter((value) => typeof value === 'string' && value.trim() !== '');
    if (wsUrls.length > 1 && new Set(wsUrls).size !== 1) errors.push('accounts must target one DS endpoint');
    const roomIds = rows.map((row) => row?.launch?.roomId).filter((value) => typeof value === 'string' && value.trim() !== '');
    if (roomIds.length > 1 && new Set(roomIds).size !== 1) errors.push('accounts must target one DS room');
  }
  return {
    ok: errors.length === 0,
    errors,
    count: report.count,
    unique: report.unique,
    hashes: report.hashes,
    accountCredentials: report.accountCredentials,
    names: report.names,
    accountIds: report.accountIds,
    // Keep the useful partition shape for callers, but never return raw
    // account/admission credentials through a validation report.
    botRows: (rows ?? []).slice(0, BOTS).map((row) => redactEvidence(row)),
    spectatorRows: (rows ?? []).slice(BOTS, TOTAL_TICKETS).map((row) => redactEvidence(row)),
  };
}

function validateTicketEnvelope(manifest, { origin, game } = {}) {
  const errors = [];
  if (Array.isArray(manifest)) return errors;
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    errors.push('ticket issuer must return an object manifest');
    return errors;
  }
  if (manifest.kind !== 'lumio.stress-tickets.v1') errors.push('ticket manifest kind is not lumio.stress-tickets.v1');
  if (manifest.version !== 1) errors.push('ticket manifest version is not 1');
  if (manifest.count !== TOTAL_TICKETS) errors.push(`ticket manifest count must be ${TOTAL_TICKETS}`);
  if (origin != null && manifest.platformOrigin !== origin) errors.push('ticket manifest platformOrigin does not match the configured Platform origin');
  if (game != null && manifest.game !== game) errors.push('ticket manifest game does not match the requested game');
  return errors;
}

export function createSpectatorDocument({ shas = {}, bots = BOTS, spectators = SPECTATORS } = {}) {
  assertAcceptanceCounts({ bots, spectators });
  return {
    version: 2,
    status: 'BLOCKED_ENV',
    scope: 'spectator-100',
    params: {
      bots: BOTS,
      spectators: SPECTATORS,
      tickets: TOTAL_TICKETS,
      probeWindowMs: PROBE_WINDOW_MS,
      requiredIds: REQUIRED_IDS,
      requiredMoved: REQUIRED_MOVED,
    },
    plannedLogins: planSpectatorLogins(),
    shas: Object.fromEntries(SHA_REPOS.map((name) => [name, shas[name] ?? null])),
    tickets: null,
    processes: {
      liveBotsGuard: 'LIVE_BOTS=0',
      preflightBotHosts: null,
      botHostsStarted: null,
      botHostsAfterStart: null,
      platformStarted: false,
      platformReady: false,
      platformAlreadyRunning: false,
      dsReady: null,
    },
    spectators: [null, null],
    sharedFrame: null,
    browser: [null, null],
    spectatorUrl: null,
    evidence: {
      tickets: `.run/${TICKET_MANIFEST_NAME}`,
      browser1: 'browser-1.json',
      browser2: 'browser-2.json',
      screenshots: ['browser-1-t5.png', 'browser-2-t5.png'],
    },
  };
}

function normalizeManifest(value) {
  if (Array.isArray(value)) return { accounts: value, count: value.length };
  return value;
}

function commandResult(command, args, { cwd, env, timeoutMs = 120_000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      resolvePromise({ code, signal, stdout, stderr });
    });
  });
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, Math.max(0, ms)));
}

function secretValuesFromManifest(manifest) {
  const secrets = [];
  for (const row of manifest?.accounts ?? []) {
    for (const value of [rowAccountCredential(row), row?.launch?.admissionCredential]) {
      if (typeof value === 'string' && value.length > 0) secrets.push(value);
    }
  }
  if (typeof manifest?.password === 'string') secrets.push(manifest.password);
  return secrets;
}

export async function mintTickets({ env = process.env, root = ROOT, options = {}, evidence = join(root, '.run'), document = {} } = {}) {
  const ticketsPath = resolve(options.ticketPath ?? join(root, '.run', TICKET_MANIFEST_NAME));
  assertTicketPathSafe(root, ticketsPath);
  const existedBefore = existsSync(ticketsPath);
  const origin = String(env?.LUMIO_PLATFORM_ORIGIN ?? '').replace(/\/$/, '');
  const game = options.slug ?? 'sample';
  const retainManifest = options.keepTicketManifest === true || options.retainTicketManifest === true;
  const commandLogPath = join(evidence, 'tickets-command.log');
  const commandSecrets = [env?.LUMIO_STRESS_PASSWORD, options.password].filter((value) => typeof value === 'string' && value.length > 0);
  let manifest;
  let commandOutput = '';
  let sourceWasArray = false;
  const writeCommandLog = (extraSecrets = []) => {
    mkdirSync(dirname(commandLogPath), { recursive: true });
    const secrets = [...commandSecrets, ...extraSecrets].filter((value, index, values) => values.indexOf(value) === index);
    writeFileSync(commandLogPath, redactScalar(commandOutput, secrets));
  };
  const removeOnFailure = () => {
    if (!existedBefore && !retainManifest) {
      try { unlinkSync(ticketsPath); } catch { /* no manifest or already removed */ }
    }
  };

  try {
    if (options.ticketManifest != null) {
      sourceWasArray = Array.isArray(options.ticketManifest);
      manifest = normalizeManifest(options.ticketManifest);
      // A custom issuer used by an integration harness may return an in-memory
      // manifest. Materialize it only under the gitignored run path so Bot.Host
      // can resolve tickets by account name.
      if (options.writeTicketManifest !== false) {
        mkdirSync(dirname(ticketsPath), { recursive: true });
        writeFileSync(ticketsPath, `${JSON.stringify(manifest, null, 2)}\n`);
      }
    } else if (typeof options.mintTickets === 'function') {
      const issued = await options.mintTickets({
        // These values are fixed by the Wave B acceptance contract.  Pass them
        // to test issuers as well so a harness cannot accidentally mint a smaller
        // topology and have the runner silently accept it.
        count: TOTAL_TICKETS,
        start: TICKET_START_INDEX,
        prefix: TICKET_PREFIX,
        bots: BOTS,
        spectators: SPECTATORS,
        origin,
        game,
        password: options.password ?? env?.LUMIO_STRESS_PASSWORD,
        out: ticketsPath,
      });
      sourceWasArray = Array.isArray(issued);
      manifest = normalizeManifest(issued);
      // Permit an issuer to write the manifest itself and return no value.
      if (manifest == null && existsSync(ticketsPath)) {
        const written = JSON.parse(readFileSync(ticketsPath, 'utf8'));
        sourceWasArray = Array.isArray(written);
        manifest = normalizeManifest(written);
      } else if (!existsSync(ticketsPath) && manifest != null && options.writeTicketManifest !== false) {
        mkdirSync(dirname(ticketsPath), { recursive: true });
        writeFileSync(ticketsPath, `${JSON.stringify(manifest, null, 2)}\n`);
      }
    } else {
      const platformRoot = resolve(root, '..', 'LumioPlatform');
      const script = join(platformRoot, 'eng', 'stress-tickets.mjs');
      if (!existsSync(script)) throw blocked(`ticket issuer is missing: ${script}`);
      const issuerEnv = {
        ...env,
        ...(typeof options.password === 'string' && options.password.length > 0
          ? { LUMIO_STRESS_PASSWORD: options.password }
          : {}),
      };
      const result = await commandResult(process.execPath, [
        script,
        '--count', String(TOTAL_TICKETS),
        '--start', String(TICKET_START_INDEX),
        '--origin', origin,
        '--game', game,
        '--prefix', TICKET_PREFIX,
        '--out', ticketsPath,
      ], {
        cwd: platformRoot,
        // Keep the shared account password out of argv; the issuer accepts it
        // through LUMIO_STRESS_PASSWORD and command logs are scrubbed below.
        env: issuerEnv,
        timeoutMs: options.ticketTimeoutMs ?? 180_000,
      });
      commandOutput = `${result.stdout}\n${result.stderr}`;
      if (result.code !== 0) {
        throw new Error(`stress-tickets exited ${result.code}: ${redactScalar(result.stderr, commandSecrets).slice(-400)}`);
      }
      if (!existsSync(ticketsPath)) throw new Error(`stress-tickets did not write ${ticketsPath}`);
      manifest = normalizeManifest(JSON.parse(readFileSync(ticketsPath, 'utf8')));
    }

    // A raw array is a supported in-memory test issuer shape; production
    // issuers must provide the versioned envelope.
    const envelopeErrors = sourceWasArray ? [] : validateTicketEnvelope(manifest, { origin, game });
    const validationInput = sourceWasArray ? manifest?.accounts : manifest;
    const validation = validateTicketManifest(validationInput, { strict: true });
    const errors = [...envelopeErrors, ...validation.errors];
    const secrets = secretValuesFromManifest(manifest);
    writeCommandLog(secrets);
    document.tickets = {
      count: validation.count,
      unique: validation.unique,
      hashes: validation.hashes,
      names: validation.names,
      accountIds: validation.accountIds,
      accountCredentials: validation.accountCredentials,
      manifest: relative(root, ticketsPath).replaceAll('\\', '/'),
    };
    if (document.evidence && typeof document.evidence === 'object') {
      document.evidence.tickets = relative(root, ticketsPath).replaceAll('\\', '/');
    }
    if (errors.length > 0) throw new Error(`ticket manifest validation failed: ${errors.join('; ')}`);
    return {
      manifest,
      validation,
      ticketsPath,
      secrets,
      removeManifest: !existedBefore && !retainManifest,
    };
  } catch (error) {
    // Persist only a scrubbed failure stream, including spawn/timeout errors;
    // this also ensures the evidence directory exists on the error path.
    commandOutput = [commandOutput, error?.message ?? String(error)].filter(Boolean).join('\n');
    let failureSecrets = secretValuesFromManifest(manifest);
    if (failureSecrets.length === 0 && existsSync(ticketsPath)) {
      try { failureSecrets = secretValuesFromManifest(normalizeManifest(JSON.parse(readFileSync(ticketsPath, 'utf8')))); } catch { /* malformed output is still removed below */ }
    }
    writeCommandLog(failureSecrets);
    removeOnFailure();
    throw error;
  }
}

function parseCensusRows(value) {
  if (Number.isInteger(value?.botHosts)) return Array.from({ length: Math.max(0, value.botHosts) }, () => ({ name: 'Bot.Host' }));
  if (Number.isInteger(value)) return Array.from({ length: Math.max(0, value) }, () => ({ name: 'Bot.Host' }));
  if (Array.isArray(value)) return value;
  if (value && Array.isArray(value.processes)) return value.processes;
  if (typeof value === 'string') return value.split(/\r?\n/).filter(Boolean);
  return [];
}

function censusTokens(commandLine) {
  return String(commandLine ?? '').match(/"[^"]*"|'[^']*'|[^\s]+/g)
    ?.map((token) => token.replace(/^['"]|['"]$/g, '').replace(/[;,]$/, '')) ?? [];
}

function isBotHostToken(value) {
  return /(?:^|[\\/])(?:Lumio\.Client\.)?Bot\.Host(?:\.dll|\.exe)?$/i.test(String(value ?? ''));
}

function isDotnetToken(value) {
  return /(?:^|[\\/])dotnet(?:\.exe)?$/i.test(String(value ?? ''));
}

function commandNamesBotHost(commandLine) {
  const text = String(commandLine ?? '');
  // The runner itself carries the Bot.Host assembly as the value of
  // --bot-dll. That option is not a Bot.Host invocation.
  if (/--bot-dll(?:=|\s)/i.test(text)) return false;
  let tokens = censusTokens(text);
  // `ps -eo pid=,comm=,args=` prefixes the command with its numeric PID.
  // Remove that metadata so a native Linux `Bot.Host` in the `comm` field is
  // recognized as the executable rather than treated as an argument.
  if (tokens.length > 0 && /^\d+$/.test(tokens[0])) tokens = tokens.slice(1);
  return tokens.some((token, index) => {
    if (!isBotHostToken(token)) return false;
    // A native Bot.Host executable is the first command token; a dotnet host
    // names the assembly immediately after the dotnet command (allowing the
    // pid/comm prefix emitted by `ps`).
    return index === 0 || isDotnetToken(tokens[index - 1]) || isDotnetToken(tokens[index - 2]);
  });
}

export function countBotHostProcesses(value) {
  return parseCensusRows(value).filter((row) => {
    if (typeof row === 'string') {
      return commandNamesBotHost(row);
    }
    // Win32_Process uses PascalCase (`Name`, `CommandLine`, `ExecutablePath`)
    // while ps and test doubles commonly use camelCase. Treat field names
    // case-insensitively so the Windows census does not silently report zero.
    const fields = Object.fromEntries(Object.entries(row ?? {}).map(([key, item]) => [key.toLowerCase(), item]));
    const executable = `${fields.name ?? ''} ${fields.imagename ?? ''} ${fields.path ?? ''} ${fields.executablepath ?? ''}`;
    if (/(?:^|[\s"'\\/])(?:Lumio\.Client\.)?Bot\.Host(?:\.dll|\.exe)?(?=$|[\s"'\\/])/i.test(executable)) return true;
    const commandLine = String(fields.commandline ?? fields.cmdline ?? '');
    return commandNamesBotHost(commandLine);
  }).length;
}

async function defaultProcessCensus() {
  if (process.platform === 'win32') {
    const result = await commandResult('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress',
    ], { timeoutMs: 15_000 });
    if (result.code !== 0) throw new Error(`process census failed: ${result.stderr}`);
    if (!result.stdout.trim()) return [];
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const result = await commandResult('ps', ['-eo', 'pid=,comm=,args='], { timeoutMs: 15_000 });
  if (result.code !== 0) throw new Error(`process census failed: ${result.stderr}`);
  return parseCensusRows(result.stdout);
}

export async function processCensus(options = {}) {
  if (typeof options.processCensus === 'function') return options.processCensus();
  return defaultProcessCensus();
}

async function checkHttpListener(origin, options = {}) {
  if (typeof options.waitForListener === 'function') return options.waitForListener(origin, options);
  let parsed;
  try { parsed = new URL(String(origin)); } catch { throw new Error(`listener origin is invalid: ${origin}`); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new Error('Platform origin must be an HTTP(S) origin without credentials, query, or fragment');
  }
  const healthPath = String(options.platformHealthPath ?? '/healthz');
  const healthUrl = new URL(healthPath, parsed).href;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(2_000)
        : undefined;
      const response = await (options.fetchImpl ?? globalThis.fetch)(healthUrl, signal ? { signal } : undefined);
      const status = Number(response?.status ?? 0);
      if (response && ((response.ok === true) || (status >= 200 && status < 300))) return { ok: true, status };
      lastError = new Error(`HTTP ${status || 'unknown'}`);
    } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new Error(`listener ${healthUrl} did not become reachable${lastError ? `: ${lastError.message}` : ''}`);
}

function buildChildEnv({ env = process.env, root = ROOT, dsConfig, engineNative } = {}) {
  const output = {};
  for (const [key, value] of Object.entries({ ...process.env, ...(env ?? {}) })) {
    if (value != null) output[key] = String(value);
  }
  const configuredConfigDir = output.LUMIO_CONFIG_DIR;
  if (configuredConfigDir) output.LUMIO_CONFIG_DIR = resolve(configuredConfigDir);
  else if (dsConfig && existsSync(dsConfig)) {
    try {
      const config = JSON.parse(readFileSync(dsConfig, 'utf8'));
      if (typeof config.config_dir === 'string' && config.config_dir.trim() !== '') {
        output.LUMIO_CONFIG_DIR = resolve(dirname(dsConfig), config.config_dir);
      }
    } catch { /* config validation reports the useful error later */ }
  }
  if (!output.LUMIO_CONFIG_DIR) output.LUMIO_CONFIG_DIR = resolve(root, 'config');
  const native = engineNative ?? output.LUMIO_ENGINE_NATIVE ?? output.LUMIO_ENGINE_NATIVE_PATH;
  if (native) {
    output.LUMIO_ENGINE_NATIVE = resolve(String(native));
    output.LUMIO_ENGINE_NATIVE_PATH = resolve(String(native));
  }
  return output;
}

export { buildChildEnv };

async function defaultPortInUse(port, { host = '127.0.0.1', timeoutMs = 150 } = {}) {
  return new Promise((resolvePromise) => {
    let settled = false;
    const socket = createConnection({ host, port });
    const finish = (value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolvePromise(value);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.setTimeout(timeoutMs, () => finish(false));
  });
}

export async function portInUse(port, options = {}) {
  if (typeof options.portInUse === 'function') return Boolean(await options.portInUse(port, options));
  return defaultPortInUse(port, options);
}

function shaSnapshotEqual(expected, actual) {
  if (!expected || typeof expected !== 'object') return true;
  return SHA_REPOS.every((name) => expected[name] == null || expected[name] === actual?.[name]);
}

export async function preflightLiveTopology({ env = process.env, options = {}, root = ROOT, expectedShas } = {}) {
  // Re-read the guard immediately before any side effect.  A caller may have
  // changed its environment while resolving credentials or waiting on a port.
  if (String(env.LIVE_BOTS ?? '') !== '0') return { ok: false, status: 'BLOCKED_ENV', reason: 'LIVE_BOTS must be exactly 0 before startup' };
  const rolePorts = [];
  const normalizedCdp = normalizeCdpPorts(options.cdpPorts);
  if (!normalizedCdp.ok) {
    return { ok: false, status: 'BLOCKED_ENV', reason: normalizedCdp.error, busyPorts: [] };
  }
  const cdpPorts = normalizedCdp.ports;
  const staticRequested = options.spectatorUrl == null;
  const staticPort = staticRequested ? safePort(options.spectatorStaticPort, DEFAULT_STATIC_PORT) : 0;
  const originValue = options.origin ?? env.LUMIO_PLATFORM_ORIGIN;
  const originPort = urlPort(originValue, ['http:', 'https:']);
  if (originValue == null || String(originValue).trim() === '' || originPort == null) {
    return { ok: false, status: 'BLOCKED_ENV', reason: 'Platform origin is invalid' };
  }
  try {
    const origin = new URL(String(originValue));
    if (origin.username || origin.password || origin.search || origin.hash || !origin.hostname) {
      return { ok: false, status: 'BLOCKED_ENV', reason: 'Platform origin is invalid' };
    }
  } catch {
    return { ok: false, status: 'BLOCKED_ENV', reason: 'Platform origin is invalid' };
  }
  const endpointValue = options.endpoint ?? env.LUMIO_DS_ENDPOINT;
  const endpointPort = urlPort(endpointValue, ['ws:', 'wss:']);
  const configuredDsPort = dsConfigListenPort(options.dsConfig);
  const dsRolePort = endpointPort ?? configuredDsPort ?? DEFAULT_DS_PORT;
  if (endpointValue != null && String(endpointValue).trim() !== '' && endpointPort == null) {
    return { ok: false, status: 'BLOCKED_ENV', reason: 'configured DS endpoint is invalid' };
  }
  for (const [index, port] of cdpPorts.entries()) {
    if (port) rolePorts.push({ role: `CDP spectator ${index + 1}`, port });
  }
  if (staticPort) rolePorts.push({ role: 'spectator static server', port: staticPort });
  if (originPort) rolePorts.push({ role: 'Platform HTTP origin', port: originPort });
  if (dsRolePort) rolePorts.push({ role: 'DS WebSocket endpoint', port: dsRolePort });
  const roleCollisions = [];
  for (let index = 0; index < rolePorts.length; index += 1) {
    for (let other = index + 1; other < rolePorts.length; other += 1) {
      if (rolePorts[index].port === rolePorts[other].port) {
        roleCollisions.push(`${rolePorts[index].role} and ${rolePorts[other].role} both use ${rolePorts[index].port}`);
      }
    }
  }
  if (roleCollisions.length > 0) {
    return { ok: false, status: 'BLOCKED_ENV', reason: `preflight found conflicting role ports: ${roleCollisions.join(', ')}`, busyPorts: [] };
  }
  let rows;
  try { rows = await processCensus(options); } catch (error) {
    return { ok: false, status: 'BLOCKED_ENV', reason: `process census failed: ${error.message}` };
  }
  const botHosts = countBotHostProcesses(rows);
  if (botHosts !== 0) return { ok: false, status: 'BLOCKED_ENV', reason: `preflight found ${botHosts} existing Bot.Host process(es)`, botHosts };

  // Keep the fixed reserved set, then add caller-selected CDP/static ports.
  // A custom port must receive the same collision check as the defaults; it is
  // otherwise possible to discover the conflict only after Chrome has started.
  const configuredBase = new Set(REQUIRED_PREFLIGHT_PORTS);
  // Replace defaults when the caller selected a different role port.  Keeping
  // the fixed defaults for unspecified roles preserves the no-collision guard
  // while avoiding a false block from an unrelated service on a custom port.
  if (originPort && originPort !== 8080) { configuredBase.delete(8080); configuredBase.add(originPort); }
  if (endpointPort && endpointPort !== DEFAULT_DS_PORT) { configuredBase.delete(DEFAULT_DS_PORT); configuredBase.add(endpointPort); }
  if (staticPort && staticPort !== DEFAULT_STATIC_PORT) { configuredBase.delete(DEFAULT_STATIC_PORT); configuredBase.add(staticPort); }
  if (!staticRequested) configuredBase.delete(DEFAULT_STATIC_PORT);
  if (Array.isArray(options.cdpPorts)) {
    configuredBase.delete(DEFAULT_CDP_PORTS[0]);
    configuredBase.delete(DEFAULT_CDP_PORTS[1]);
    for (const port of cdpPorts) configuredBase.add(port);
  }
  for (const value of Array.isArray(options.preflightPorts) ? options.preflightPorts : []) configuredBase.add(value);
  const configured = [...new Set([
    ...configuredBase,
    ...cdpPorts,
    staticPort,
    originPort,
    endpointPort,
  ].map(Number).filter((port) => Number.isInteger(port) && port > 0 && port < 65_536))];
  const busy = [];
  const allowedBusy = new Set((Array.isArray(options.allowBusyPorts) ? options.allowBusyPorts : []).map(Number));
  if (options.platformAlreadyRunning === true) allowedBusy.add(originPort ?? 8080);
  for (const value of configured) {
    const port = safePort(value, 0);
    if (!port) continue;
    if (await portInUse(port, { ...options, host: options.portHost ?? '127.0.0.1' }) && !allowedBusy.has(port)) busy.push(port);
  }
  if (busy.length > 0) {
    return { ok: false, status: 'BLOCKED_ENV', reason: `preflight found listeners on reserved port(s): ${busy.join(', ')}`, botHosts, busyPorts: busy };
  }

  const collect = options.collectRepoShas ?? collectRepoShas;
  let currentShas = {};
  try { currentShas = await collect(root); } catch (error) {
    return { ok: false, status: 'BLOCKED_ENV', reason: `repository SHA collection failed: ${error.message}`, botHosts };
  }
  const expected = expectedShas ?? options.expectedShas;
  if (expected && !shaSnapshotEqual(expected, currentShas)) {
    return { ok: false, status: 'BLOCKED_ENV', reason: 'repository SHA changed between planning and startup', botHosts, shas: currentShas };
  }
  if (String(env.LIVE_BOTS ?? '') !== '0') return { ok: false, status: 'BLOCKED_ENV', reason: 'LIVE_BOTS changed before startup', botHosts };
  return { ok: true, status: 'READY', botHosts: 0, busyPorts: [], shas: currentShas, cdpPorts };
}

function safePort(value, fallback) {
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : fallback;
}

function normalizeCdpPorts(value) {
  if (value == null) return { ok: true, ports: [...DEFAULT_CDP_PORTS] };
  if (!Array.isArray(value) || value.length !== SPECTATORS) {
    return { ok: false, error: `cdpPorts must contain exactly ${SPECTATORS} ports` };
  }
  const ports = value.map((item) => safePort(item, 0));
  if (ports.some((port) => !port)) {
    return { ok: false, error: 'cdpPorts must contain valid TCP ports' };
  }
  if (new Set(ports).size !== ports.length) {
    return { ok: false, error: 'cdpPorts must contain distinct ports' };
  }
  return { ok: true, ports };
}

function urlPort(value, protocols = []) {
  if (value == null || String(value).trim() === '') return null;
  try {
    const parsed = new URL(String(value));
    if (protocols.length > 0 && !protocols.includes(parsed.protocol)) return null;
    const fallback = ['https:', 'wss:'].includes(parsed.protocol) ? 443 : 80;
    return safePort(parsed.port || fallback, 0) || null;
  } catch {
    return null;
  }
}

function dsConfigListenPort(configPath) {
  if (!configPath || !isFilePath(configPath)) return null;
  try {
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    const raw = config?.transport?.listen_port ?? config?.transport?.listenPort
      ?? config?.network?.listen_port ?? config?.network?.port;
    return safePort(raw, 0) || null;
  } catch {
    return null;
  }
}

function reserveFreePort(host = '127.0.0.1') {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, host, () => {
      const port = server.address().port;
      server.close((error) => error ? reject(error) : resolvePromise(port));
    });
  });
}

export function startStaticServer(root, port) {
  const absoluteRoot = resolve(root);
  const server = createServer((request, response) => {
    try {
      const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
      let pathname = decodeURIComponent(requestUrl.pathname);
      if (pathname.endsWith('/')) pathname += 'index.html';
      const file = resolve(absoluteRoot, `.${pathname}`);
      if (file !== absoluteRoot && !file.startsWith(`${absoluteRoot}\\`) && !file.startsWith(`${absoluteRoot}/`)) {
        response.writeHead(403); response.end(); return;
      }
      if (!existsSync(file)) { response.writeHead(404); response.end('not found'); return; }
      response.writeHead(200, { 'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream' });
      response.end(readFileSync(file));
    } catch {
      response.writeHead(400); response.end('bad request');
    }
  });
  return new Promise((resolvePromise, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolvePromise(server));
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
};

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function isPngBuffer(value) {
  if (!Buffer.isBuffer(value) || value.length < PNG_SIGNATURE.length + 12) return false;
  if (!value.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) return false;
  let offset = PNG_SIGNATURE.length;
  let hasHeader = false;
  let hasEnd = false;
  while (offset + 12 <= value.length) {
    const length = value.readUInt32BE(offset);
    const chunkEnd = offset + 12 + length;
    if (chunkEnd > value.length) return false;
    const type = value.toString('ascii', offset + 4, offset + 8);
    if (!hasHeader) {
      if (type !== 'IHDR' || length !== 13) return false;
      const width = value.readUInt32BE(offset + 8);
      const height = value.readUInt32BE(offset + 12);
      if (width < 1 || height < 1) return false;
      hasHeader = true;
    }
    if (type === 'IEND') {
      if (length !== 0) return false;
      hasEnd = true;
      break;
    }
    offset = chunkEnd;
  }
  return hasHeader && hasEnd;
}

export function findChromePath(env = process.env) {
  const explicit = env.LUMIO_CHROME || env.CHROME_PATH;
  if (explicit && isFilePath(explicit)) return resolve(explicit);
  const candidates = process.platform === 'win32'
    ? [
      join(env.PROGRAMFILES ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(env.PROGRAMFILES ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ]
    : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  return candidates.find((candidate) => candidate && isFilePath(candidate)) ?? null;
}

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.socketListeners = [];
    if (typeof socket.addEventListener === 'function') {
      const message = (event) => this.onMessage(event?.data ?? event);
      const close = () => this.rejectAll(new Error('CDP socket closed'));
      const error = (event) => this.rejectAll(event instanceof Error ? event : new Error('CDP socket failed'));
      socket.addEventListener('message', message);
      socket.addEventListener('close', close);
      socket.addEventListener('error', error);
      this.socketListeners.push(['message', message], ['close', close], ['error', error]);
    } else if (typeof socket.on === 'function') {
      const message = (data) => this.onMessage(data);
      const close = () => this.rejectAll(new Error('CDP socket closed'));
      const error = (error) => this.rejectAll(error instanceof Error ? error : new Error('CDP socket failed'));
      socket.on('message', message);
      socket.on('close', close);
      socket.on('error', error);
      this.socketListeners.push(['message', message], ['close', close], ['error', error]);
    }
  }

  on(method, callback) {
    const list = this.listeners.get(method) ?? [];
    list.push(callback);
    this.listeners.set(method, list);
    return () => {
      const current = this.listeners.get(method) ?? [];
      this.listeners.set(method, current.filter((item) => item !== callback));
    };
  }

  onMessage(raw) {
    let value;
    try {
      let text;
      if (typeof raw === 'string') text = raw;
      else if (Buffer.isBuffer(raw)) text = raw.toString('utf8');
      else if (ArrayBuffer.isView(raw)) text = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
      else if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString('utf8');
      else if (raw && raw.data != null) return this.onMessage(raw.data);
      else return;
      value = JSON.parse(text);
    } catch { return; }
    // A browser can close a socket while a partial/non-JSON frame is being
    // delivered.  Ignore malformed values rather than dereferencing `id`
    // and taking down the entire acceptance runner from an event callback.
    if (!value || typeof value !== 'object') return;
    if (value.id != null && this.pending.has(value.id)) {
      const pending = this.pending.get(value.id);
      this.pending.delete(value.id);
      if (value.error) pending.reject(new Error(value.error.message ?? 'CDP command failed'));
      else pending.resolve(value.result ?? {});
      return;
    }
    for (const callback of this.listeners.get(value.method) ?? []) {
      try { callback(value.params ?? {}); } catch { /* event observers are best effort */ }
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolvePromise, reject) => {
      this.pending.set(id, { resolve: resolvePromise, reject });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch (error) { this.pending.delete(id); reject(error); }
    });
  }

  close() {
    try { this.socket.close?.(); } catch { /* already closed */ }
    for (const [event, listener] of this.socketListeners.splice(0)) {
      try {
        if (typeof this.socket.removeEventListener === 'function') this.socket.removeEventListener(event, listener);
        else if (typeof this.socket.removeListener === 'function') this.socket.removeListener(event, listener);
        else if (typeof this.socket.off === 'function') this.socket.off(event, listener);
      } catch { /* best effort */ }
    }
    this.rejectAll(new Error('CDP connection closed'));
  }
}

export function createCdpClient(socket) {
  return new CdpConnection(socket);
}

/** Small, dependency-free CDP client used by both live Chrome and hermetic tests. */
export class CdpSession extends CdpConnection {
  constructor(socket, { timeoutMs = 15_000 } = {}) {
    super(socket);
    this.timeoutMs = timeoutMs;
    this._messageHandler = null;
  }

  call(method, params = {}, { timeoutMs = this.timeoutMs } = {}) {
    const requestId = this.nextId;
    const request = super.send(method, params);
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return request;
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        // Remove the pending request as well as the timer.  A late response
        // must not retain a resolver forever when a browser hangs mid-probe.
        this.pending.delete(requestId);
        reject(new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
    return Promise.race([request, timeout]).finally(() => clearTimeout(timer));
  }
}

/** Select exactly the page opened by this runner; never guess from the first target. */
export function selectCdpPageTarget(targets, { targetId, targetUrl, targetTitle } = {}) {
  // Treat an empty selector as absent, but retain numeric IDs such as 0.  A
  // blank value otherwise matches targets whose metadata is also missing and
  // can accidentally select an unrelated tab.
  const selector = {
    targetId: normalizeCdpSelector(targetId),
    targetUrl: normalizeCdpSelector(targetUrl),
    targetTitle: normalizeCdpSelector(targetTitle),
  };
  const pages = (Array.isArray(targets) ? targets : []).filter((target) => target?.type === 'page');
  // A CDP port can be shared with arbitrary tabs.  Without an identity
  // selector there is no defensible way to call one of those tabs the
  // spectator, even when it happens to be the only page currently listed.
  if (selector.targetId == null && selector.targetUrl == null && selector.targetTitle == null) {
    throw new Error('expected exactly one spectator CDP page: target identity is required (targetId, targetUrl, or targetTitle)');
  }
  const filtered = pages.filter((target) => {
    if (selector.targetId != null && String(target.id ?? '') !== String(selector.targetId)) return false;
    if (selector.targetUrl != null && String(target.url ?? '') !== String(selector.targetUrl)) return false;
    if (selector.targetTitle != null && String(target.title ?? '') !== String(selector.targetTitle)) return false;
    return true;
  });
  if (filtered.length !== 1) {
    throw new Error(`expected exactly one spectator CDP page, found ${filtered.length}`);
  }
  if (!validCdpWebSocketUrl(filtered[0].webSocketDebuggerUrl)) {
    throw new Error('spectator CDP page has an invalid webSocketDebuggerUrl');
  }
  return filtered[0];
}

/** Build the pre-navigation script. The caller sends it over CDP and never logs it. */
export function buildCdpLaunchInjection(launch) {
  if (!launch || typeof launch !== 'object') throw new TypeError('launch result required');
  return `window.__lumioLaunch = ${JSON.stringify({
    wsUrl: launch.wsUrl,
    subprotocol: launch.subprotocol,
    admissionCredential: launch.admissionCredential,
  })};`;
}

/** Redact a CDP record using a visible marker, preserving its shape for review. */
export function redactCdpEvidence(value, secrets = []) {
  if (Array.isArray(value)) return value.map((item) => redactCdpEvidence(item, secrets));
  if (value && typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value)) {
      if (isSecretKey(key) || key === 'launch' && item && typeof item === 'object') {
        if (key === 'launch' && item && typeof item === 'object') {
          output[key] = redactCdpEvidence(item, secrets);
        } else {
          output[key] = '[REDACTED]';
        }
      } else {
        output[key] = redactCdpEvidence(item, secrets);
      }
    }
    return output;
  }
  if (typeof value !== 'string') return value;
  let output = value;
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) output = output.split(secret).join('[REDACTED]');
  }
  try {
    if (/^(?:https?|wss?):\/\//i.test(output)) {
      const url = new URL(output);
      url.username = '';
      url.password = '';
      url.search = '';
      url.hash = '';
      output = url.href;
    }
  } catch { /* ordinary text */ }
  return output;
}

async function waitForJson(url, { timeoutMs = 15_000, fetchImpl = globalThis.fetch } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const remaining = Math.max(1, deadline - Date.now());
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(Math.min(remaining, 2_000))
        : undefined;
      const response = await promiseWithTimeout(
        Promise.resolve().then(() => fetchImpl(url, signal ? { signal } : undefined)),
        remaining,
        `HTTP ${url}`,
      );
      // Keep the helper injectable for hermetic tests and small fetch shims;
      // native Response objects expose `ok`, while test doubles often return
      // the parsed value or only a `json()` method.
      if (Array.isArray(response)) return response;
      if (response && typeof response.json === 'function') {
        const status = Number(response.status ?? 0);
        if (response.ok === false || (status >= 400 && status <= 599)) {
          lastError = new Error(`HTTP ${status || 'error'}`);
        } else {
          return promiseWithTimeout(
            Promise.resolve().then(() => response.json()),
            Math.max(1, deadline - Date.now()),
            `HTTP ${url} JSON`,
          );
        }
      } else if (response && typeof response === 'object') {
        return response;
      } else {
        lastError = new Error('invalid JSON response');
      }
    } catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new Error(`CDP endpoint ${url} did not respond${lastError ? `: ${lastError.message}` : ''}`);
}

function cdpWebSocketFactory(url) {
  if (typeof WebSocket !== 'function') throw blocked('WebSocket is unavailable for CDP; install a Node runtime with global WebSocket.');
  return new WebSocket(url);
}

async function waitForCdpSocketOpen(socket, timeoutMs, label) {
  if (!socket) throw new Error(`CDP ${label} socket is missing`);
  if (socket.readyState === 1) return;
  const hasEventTarget = typeof socket.addEventListener === 'function';
  const hasEmitter = typeof socket.once === 'function' || typeof socket.on === 'function';
  if (!hasEventTarget && !hasEmitter) {
    throw new Error(`CDP ${label} socket does not expose an open event`);
  }
  await new Promise((resolvePromise, reject) => {
    let settled = false;
    let timer;
    const remove = (event, listener) => {
      try {
        if (hasEventTarget && typeof socket.removeEventListener === 'function') {
          socket.removeEventListener(event, listener);
        } else if (typeof socket.removeListener === 'function') {
          socket.removeListener(event, listener);
        } else if (typeof socket.off === 'function') {
          socket.off(event, listener);
        }
      } catch { /* best effort */ }
    };
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      remove('open', open);
      remove('error', onError);
      if (error) {
        try { socket.close?.(); } catch { /* best effort */ }
        reject(error);
      } else {
        resolvePromise();
      }
    };
    const duration = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : DEFAULT_TIMEOUT_MS;
    const open = () => finish();
    const onError = (event) => finish(event instanceof Error ? event : new Error(`CDP ${label} socket failed`));
    timer = setTimeout(() => finish(new Error(`CDP ${label} socket did not open`)), duration);
    try {
      if (hasEventTarget) {
        socket.addEventListener('open', open, { once: true });
        socket.addEventListener('error', onError, { once: true });
      } else if (typeof socket.once === 'function') {
        socket.once('open', open);
        socket.once('error', onError);
      } else {
        socket.on('open', open);
        socket.on('error', onError);
      }
    } catch (error) {
      finish(error);
      return;
    }
    // Close the check/add-listener race for adapters which become OPEN while
    // the handlers are being registered but do not replay the open event.
    if (socket.readyState === 1) finish();
  });
}

function effectiveCdpTimeout(options = {}) {
  const value = Number(options.cdpTimeoutMs ?? options.browserTimeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

async function connectChromeCdp(port, options = {}) {
  const cdpTimeoutMs = effectiveCdpTimeout(options);
  if (typeof options.connectCdp === 'function') {
    const pending = Promise.resolve().then(() => options.connectCdp(port, options));
    try {
      const connected = await promiseWithTimeout(pending, cdpTimeoutMs, 'connect');
      try {
        return normalizeConnectedCdp(connected, options);
      } catch (error) {
        await closeCdpResource(connected, cdpTimeoutMs);
        throw error;
      }
    } catch (error) {
      // A timed-out adapter may still resolve later.  Attach a cleanup handler
      // now so a late socket/client cannot survive the failed observation.
      pending.then((connected) => closeCdpResource(connected, cdpTimeoutMs), () => {});
      throw error;
    }
  }
  const version = await waitForJson(`http://127.0.0.1:${port}/json/version`, {
    ...options,
    timeoutMs: cdpTimeoutMs,
  });
  const deadline = Date.now() + cdpTimeoutMs;
  let target;
  let lastTargetError;
  // Chrome can publish the debugging endpoint before its initial navigation
  // appears in /json/list.  Poll the list while retaining strict identity
  // matching; never fall back to the browser-level websocket or first tab.
  do {
    try {
      const targets = await waitForJson(`http://127.0.0.1:${port}/json/list`, {
        ...options,
        timeoutMs: Math.max(1, Math.min(1_000, deadline - Date.now())),
      });
      target = selectCdpPageTarget(targets, {
        targetId: options.targetId,
        targetUrl: options.targetUrl,
        targetTitle: options.targetTitle,
      });
      break;
    } catch (error) {
      lastTargetError = error;
      if (Date.now() >= deadline) throw error;
      await sleep(50);
    }
  } while (!target && Date.now() < deadline);
  if (!target) throw lastTargetError ?? new Error(`Chrome CDP has no spectator page target on port ${port}`);
  if (!target?.webSocketDebuggerUrl) throw new Error(`Chrome CDP has no page target on port ${port}`);
  const socket = (options.websocketFactory ?? cdpWebSocketFactory)(target.webSocketDebuggerUrl);
  await waitForCdpSocketOpen(socket, cdpTimeoutMs, 'browser');
  return {
    client: new CdpSession(socket, { timeoutMs: cdpTimeoutMs }),
    target: {
      id: target.id ?? null,
      type: target.type ?? 'page',
      title: target.title ?? null,
      url: target.url ?? null,
    },
    version: { Browser: version.Browser ?? null },
  };
}

async function closeCdpResource(value, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const resource = value?.client ?? value?.session ?? value;
  if (!resource) return;
  const close = typeof resource.close === 'function'
    ? () => resource.close()
    : (typeof resource.disconnect === 'function' ? () => resource.disconnect() : null);
  if (!close) return;
  await promiseWithTimeout(Promise.resolve().then(close), timeoutMs, 'close').catch(() => {});
}

/** Normalize the small seam used by hermetic adapters and process hosts. */
function normalizeConnectedCdp(value, options = {}) {
  const client = value?.client ?? value?.session ?? value;
  if (!client || (typeof client.send !== 'function' && typeof client.call !== 'function')) {
    throw new TypeError('connectCdp must return a CDP client or { client, target }');
  }
  const targetWasSupplied = Boolean(value && typeof value === 'object' && (
    Object.prototype.hasOwnProperty.call(value, 'target')
    || Object.prototype.hasOwnProperty.call(value, 'targetInfo')
  ));
  const rawTarget = value?.target ?? value?.targetInfo;
  if (targetWasSupplied && (!rawTarget || typeof rawTarget !== 'object' || Array.isArray(rawTarget))) {
    throw new Error('connectCdp target metadata must be an object');
  }
  // `/json/list` calls the identity `id`, while CDP Target.TargetInfo calls it
  // `targetId`.  Accept both adapter shapes but emit one canonical evidence
  // record so uniqueness checks remain reliable.
  const suppliedTarget = rawTarget ? {
    id: rawTarget.id ?? rawTarget.targetId,
    type: rawTarget.type ?? rawTarget.targetType,
    title: rawTarget.title,
    url: rawTarget.url,
  } : {};
  const selector = {
    targetId: normalizeCdpSelector(options.targetId),
    targetUrl: normalizeCdpSelector(options.targetUrl),
    targetTitle: normalizeCdpSelector(options.targetTitle),
  };
  if (selector.targetId == null && selector.targetUrl == null && selector.targetTitle == null) {
    throw new Error('connectCdp requires target identity (targetId, targetUrl, or targetTitle)');
  }
  if (suppliedTarget.type != null && suppliedTarget.type !== 'page') {
    throw new Error('connectCdp target must be a page');
  }
  const suppliedIdentity = ['id', 'url', 'title'].some((field) => (
    suppliedTarget[field] != null && String(suppliedTarget[field]).trim() !== ''
  ));
  if (targetWasSupplied && !suppliedIdentity) {
    throw new Error('connectCdp target identity is missing');
  }
  for (const [key, field] of [['targetId', 'id'], ['targetUrl', 'url'], ['targetTitle', 'title']]) {
    const expected = selector[key];
    if (expected == null) continue;
    if (targetWasSupplied && suppliedTarget[field] == null) {
      throw new Error(`connectCdp target ${field} is missing for requested identity`);
    }
    if (suppliedTarget[field] == null) continue;
    if (String(suppliedTarget[field]) !== String(expected)) {
      throw new Error(`connectCdp target ${field} does not match requested identity`);
    }
  }
  return {
    client,
    target: {
      id: suppliedTarget.id ?? selector.targetId ?? null,
      type: suppliedTarget.type ?? 'page',
      title: suppliedTarget.title ?? selector.targetTitle ?? null,
      url: suppliedTarget.url ?? selector.targetUrl ?? null,
    },
    version: value?.version ?? null,
  };
}

function launchExpression(launch) {
  // JSON.stringify is the only place where the ticket enters a CDP payload;
  // this expression is never written to a log or URL.
  return `window.__lumioLaunch = ${JSON.stringify({
    wsUrl: launch.wsUrl,
    subprotocol: launch.subprotocol,
    admissionCredential: launch.admissionCredential,
  })};`;
}

function normalizeSnapshot(value) {
  const source = value?.value ?? value?.result?.value ?? value;
  if (!source || typeof source !== 'object') return null;
  const positions = Array.isArray(source.positions)
    ? source.positions.filter((row) => row && (typeof row.id === 'string' || typeof row.id === 'number')
      && String(row.id).trim() !== '' && finiteNumber(Number(row.x)) && finiteNumber(Number(row.z)))
      .map((row) => ({ id: String(row.id), x: Number(row.x), z: Number(row.z), ...(row.self === true ? { self: true } : {}) }))
    : [];
  const snapshot = {
    status: typeof source.status === 'string' ? source.status : null,
    botCount: Number.isInteger(source.botCount) ? source.botCount : positions.length,
    positions,
    updatedAtMs: finiteNumber(Number(source.updatedAtMs)) ? Number(source.updatedAtMs) : null,
  };
  for (const key of ['worldId', 'roomId', 'worldFrame', 'entityFrame', 'frameId', 'instanceId', 'selfId']) {
    if (typeof source[key] === 'string' || typeof source[key] === 'number') snapshot[key] = source[key];
    else if (source[key] && typeof source[key] === 'object') {
      try { snapshot[key] = JSON.stringify(source[key]); } catch { /* ignore malformed metadata */ }
    }
  }
  return snapshot;
}

/** Compare two authoritative page snapshots, including the red self point. */
export function compareCdpSpectatorSnapshots(t0, t5, { requiredIds = REQUIRED_IDS, requiredMoved = REQUIRED_MOVED } = {}) {
  const first = normalizeSnapshot(t0) ?? { positions: [], botCount: 0 };
  const second = normalizeSnapshot(t5) ?? { positions: [], botCount: 0 };
  const movement = probeMoved(first, second, { requiredIds, requiredMoved });
  const firstIds = indexPositions(first);
  const secondIds = indexPositions(second);
  const selfId = first.selfId ?? second.selfId
    ?? [...firstIds.entries()].find(([, row]) => row.self)?.[0]
    ?? [...secondIds.entries()].find(([, row]) => row.self)?.[0]
    ?? null;
  const normalizedSelfId = selfId == null ? null : String(selfId);
  const p0 = normalizedSelfId != null ? firstIds.get(normalizedSelfId) : null;
  const p5 = normalizedSelfId != null ? secondIds.get(normalizedSelfId) : null;
  const selfMoved = Boolean(p0 && p5 && Math.abs(p5.x - p0.x) + Math.abs(p5.z - p0.z) > 0);
  const idCount = Math.max(first.botCount ?? 0, second.botCount ?? 0, movement.idCount);
  return {
    ok: idCount >= requiredIds && movement.moved >= requiredMoved && selfMoved,
    idCount,
    moved: movement.moved,
    commonIds: movement.commonIds,
    selfId: normalizedSelfId,
    selfPresent: Boolean(p0 && p5),
    selfMoved,
  };
}

/** Parse lifecycle evidence with the same Active+established semantics as the launcher. */
export function parseAdmittedText(text) {
  return parseBotAdmit(text);
}

function admissionDetails(botChildren, evidenceDir) {
  const count = botChildren.length;
  // Reuse the launcher parser, which also walks nested --log-dir files emitted
  // by FoundationHostCommand.  Keeping one parser avoids a false admit when a
  // process first reaches Active and later enters Faulted/session_faulted.
  const result = countAdmittedBots(count, { evidenceDir, children: botChildren });
  return result.details ?? botChildren.map((child) => inspectBotAdmit(child?.stdout ?? ''));
}

export function countAdmittedBotHosts(botChildren = [], { evidenceDir } = {}) {
  const details = admissionDetails(botChildren, evidenceDir);
  const admitted = details.filter((item) => item?.admitted === true && !item.rejected && !item.faulted).length;
  const rejected = details.filter((item) => item?.rejected === true).length;
  const faulted = details.filter((item) => item?.faulted === true).length;
  return { admitted, rejected, faulted, details };
}

export async function waitForBotAdmissions({
  botChildren = [],
  evidenceDir,
  expected = BOTS,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  tools,
  pollMs = 100,
  evidenceTick,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = countAdmittedBotHosts(botChildren, { evidenceDir });
  while (Date.now() < deadline) {
    for (const child of botChildren) {
      if (child?.closed === true) throw new Error('Bot.Host exited before the admission evidence gate completed');
      await tools?.assertAlive?.(child);
    }
    latest = countAdmittedBotHosts(botChildren, { evidenceDir });
    if (latest.rejected > 0 || latest.faulted > 0) return latest;
    if (latest.admitted >= expected) {
      // One final liveness/evidence tick prevents a transient Active line from
      // being reported as a durable admission.
      for (const child of botChildren) await tools?.assertAlive?.(child);
      if (typeof evidenceTick === 'function') await evidenceTick(latest);
      else await sleep(Math.min(Math.max(1, pollMs), 25));
      latest = countAdmittedBotHosts(botChildren, { evidenceDir });
      return latest;
    }
    await sleep(pollMs);
  }
  return latest;
}

function cdpResultValue(result) {
  return result?.result?.value ?? result?.value ?? null;
}

function promiseWithTimeout(value, timeoutMs, label) {
  const promise = Promise.resolve(value);
  if (!Number.isFinite(Number(timeoutMs)) || Number(timeoutMs) <= 0) return promise;
  const duration = Number(timeoutMs);
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`CDP ${label} timed out after ${duration}ms`)), duration);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function validCdpWebSocketUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const parsed = new URL(value);
    if (!['ws:', 'wss:'].includes(parsed.protocol) || !parsed.hostname
        || !LOOPBACK_HOSTS.has(parsed.hostname)
        || parsed.username || parsed.password || parsed.search || parsed.hash) return false;
    const port = Number(parsed.port || (parsed.protocol === 'wss:' ? 443 : 80));
    return Number.isInteger(port) && port > 0 && port < 65_536;
  } catch {
    return false;
  }
}

function normalizeCdpSelector(value) {
  if (typeof value === 'string') return value.trim() === '' ? null : value;
  return value == null ? null : value;
}

async function cdpCall(session, method, params = {}, timeoutMs) {
  const effectiveTimeout = timeoutMs ?? session?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (typeof session?.call === 'function') {
    return promiseWithTimeout(
      Promise.resolve().then(() => session.call(method, params, { timeoutMs: effectiveTimeout })),
      effectiveTimeout,
      method,
    );
  }
  if (typeof session?.send === 'function') {
    return promiseWithTimeout(
      Promise.resolve().then(() => session.send(method, params)),
      effectiveTimeout,
      method,
    );
  }
  throw new TypeError('CDP session must provide call() or send()');
}

/**
 * Observe one headed spectator target. This is exported so tests can provide a
 * fake CDP socket while the live runner uses the exact same sequence.
 */
export async function collectCdpSpectatorObservation({
  port,
  label = 'spectator',
  targetId,
  targetUrl,
  targetTitle,
  pageUrl,
  launch,
  fetchImpl = globalThis.fetch,
  WebSocketImpl = globalThis.WebSocket,
  probeWindowMs = PROBE_WINDOW_MS,
  pollMs = 100,
  readyTimeoutMs = DEFAULT_TIMEOUT_MS,
  screenshotPath,
  evidencePath,
  options = {},
} = {}) {
  if (!launch || typeof launch !== 'object') throw new TypeError('launch result required');
    const safePageUrl = assertLoopbackPageUrl(pageUrl ?? targetUrl);
  const targetDeadline = Date.now() + readyTimeoutMs;
  let target;
  let lastTargetError;
  do {
    try {
      const remaining = Math.max(1, targetDeadline - Date.now());
      const signal = typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
        ? AbortSignal.timeout(Math.min(remaining, 2_000))
        : undefined;
      const listResponse = await promiseWithTimeout(
        Promise.resolve().then(() => fetchImpl(`http://127.0.0.1:${port}/json/list`, signal ? { signal } : undefined)),
        remaining,
        `${label} target list`,
      );
      if (listResponse?.ok === false || (Number(listResponse?.status ?? 0) >= 400 && Number(listResponse?.status ?? 0) <= 599)) {
        throw new Error(`HTTP ${listResponse.status}`);
      }
      const targets = typeof listResponse?.json === 'function'
        ? await promiseWithTimeout(listResponse.json(), Math.max(1, targetDeadline - Date.now()), `${label} target JSON`)
        : listResponse;
      target = selectCdpPageTarget(targets, {
        targetId,
        targetTitle,
        // A direct observer call commonly knows only the navigation URL.  It
        // is still a strict identity selector; the arbitrary-first-page case
        // remains rejected when neither URL nor another selector is present.
        targetUrl: targetUrl ?? ((targetId == null && targetTitle == null) ? pageUrl : undefined),
      });
      break;
    } catch (error) {
      lastTargetError = error;
      if (Date.now() >= targetDeadline) throw error;
      await sleep(Math.min(pollMs || 50, Math.max(1, targetDeadline - Date.now())));
    }
  } while (!target && Date.now() < targetDeadline);
  if (!target) throw lastTargetError ?? new Error(`Chrome CDP has no spectator page target on port ${port}`);
  if (typeof WebSocketImpl !== 'function') throw blocked('WebSocket is unavailable for Chrome CDP');
  const socket = new WebSocketImpl(target.webSocketDebuggerUrl);
  await waitForCdpSocketOpen(socket, readyTimeoutMs, label);
  const session = new CdpSession(socket, { timeoutMs: readyTimeoutMs });
  const secrets = [launch.admissionCredential].filter(Boolean);
  const consoleEvents = [];
  for (const method of ['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded']) {
    session.on(method, (params) => {
      try { consoleEvents.push(redactScalar(JSON.stringify(params), secrets)); } catch { /* ignore malformed adapter events */ }
    });
  }
  let injectionId = null;
  const output = {
    label,
    port,
    target: { id: target.id ?? null, title: target.title ?? null, url: target.url ?? null, type: target.type ?? null },
    headed: true,
    url: safePageUrl,
    runtimeReady: false,
    t0: null,
    t5: null,
    movement: null,
    canvas: null,
    screenshot: screenshotPath ?? null,
    console: [],
  };
  try {
    await cdpCall(session, 'Runtime.enable');
    await cdpCall(session, 'Page.enable');
    await cdpCall(session, 'Log.enable').catch(() => {});
    const injection = await cdpCall(session, 'Page.addScriptToEvaluateOnNewDocument', {
      source: buildCdpLaunchInjection(launch),
    });
    injectionId = injection?.identifier ?? null;
    await cdpCall(session, 'Page.navigate', { url: safePageUrl });
    // A live browser must remain attached for the whole probe; a closed
    // process/socket cannot be turned into movement evidence.
    await options?.assertAlive?.();
    const deadline = Date.now() + readyTimeoutMs;
    let t0;
    do {
      await options?.assertAlive?.();
      const raw = await cdpCall(session, 'Runtime.evaluate', {
        expression: CDP_SPECTATOR_SNAPSHOT_EXPRESSION,
        returnByValue: true,
        awaitPromise: true,
      });
      t0 = normalizeSnapshot(cdpResultValue(raw));
      if (t0 && t0.botCount >= REQUIRED_IDS && t0.positions.length >= REQUIRED_IDS) break;
      if (Date.now() >= deadline) break;
      await sleep(pollMs);
    } while (Date.now() < deadline);
    if (!t0 || t0.botCount < REQUIRED_IDS || t0.positions.length < REQUIRED_IDS) {
      throw new Error(`${label} did not expose ${REQUIRED_IDS} entities before timeout`);
    }
    output.runtimeReady = ['wasm-ready', 'connected'].includes(t0.status);
    output.t0 = t0;
    if (probeWindowMs > 0) await sleep(probeWindowMs);
    await options?.assertAlive?.();
    const rawT5 = await cdpCall(session, 'Runtime.evaluate', {
      expression: CDP_SPECTATOR_SNAPSHOT_EXPRESSION,
      returnByValue: true,
      awaitPromise: true,
    });
    output.t5 = normalizeSnapshot(cdpResultValue(rawT5));
    const rawCanvas = await cdpCall(session, 'Runtime.evaluate', {
      expression: CDP_CANVAS_STATS_EXPRESSION,
      returnByValue: true,
      awaitPromise: true,
    }).catch(() => null);
    output.canvas = cdpResultValue(rawCanvas);
    output.movement = compareCdpSpectatorSnapshots(output.t0, output.t5);
    output.console = consoleEvents.slice(-200);
    if (screenshotPath) {
      const screenshot = await cdpCall(session, 'Page.captureScreenshot', { format: 'png' }).catch(() => null);
      if (screenshot?.data) {
        mkdirSync(dirname(screenshotPath), { recursive: true });
        const bytes = Buffer.from(screenshot.data, 'base64');
        writeFileSync(screenshotPath, bytes);
        output.screenshotBytes = bytes.length;
        output.screenshotValid = isPngBuffer(bytes);
      }
    }
    const canvasOk = output.canvas
      && [output.canvas.width, output.canvas.height, output.canvas.painted,
        output.canvas.colorPixels]
        .every((value) => Number.isFinite(Number(value)) && Number(value) > 0)
      && Number(output.canvas.hueBuckets) >= 2;
    const t5Ok = output.t5
      && ['wasm-ready', 'connected'].includes(output.t5.status)
      && output.t5.botCount >= REQUIRED_IDS
      && output.t5.positions.length >= REQUIRED_IDS;
    const screenshotOk = !screenshotPath || (existsSync(screenshotPath) && output.screenshotValid === true);
    output.ok = output.runtimeReady && t5Ok && output.movement.ok && canvasOk && screenshotOk;
    if (evidencePath) {
      mkdirSync(dirname(evidencePath), { recursive: true });
      writeFileSync(evidencePath, `${JSON.stringify(redactCdpEvidence(output, secrets), null, 2)}\n`);
    }
    return output;
  } finally {
    // Remove the hook and clear the current document independently.  Either
    // operation may fail during a torn-down page, but neither should prevent
    // the other cleanup attempt or mask the observation result.
    if (injectionId != null) {
      await cdpCall(session, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: injectionId }).catch(() => {});
    }
    await cdpCall(session, 'Runtime.evaluate', {
      expression: 'delete window.__lumioLaunch',
      returnByValue: true,
    }).catch(() => {});
    session.close();
  }
}

async function evaluate(cdp, expression, timeoutMs) {
  const result = await cdpCall(cdp, 'Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  }, timeoutMs);
  return cdpResultValue(result);
}

function snapshotReady(snapshot) {
  return snapshot && snapshot.botCount >= REQUIRED_IDS && snapshot.positions.length >= REQUIRED_IDS;
}

async function waitForSnapshot(cdp, {
  timeoutMs = DEFAULT_TIMEOUT_MS,
  cdpTimeoutMs,
  runtimeStatuses = ['wasm-ready', 'connected'],
  pollMs = 100,
  assertAlive,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let latest = null;
  while (Date.now() < deadline) {
    await assertAlive?.();
    const remaining = Math.max(1, deadline - Date.now());
    const commandTimeout = Math.max(1, Math.min(
      Number(cdpTimeoutMs ?? timeoutMs) || timeoutMs,
      remaining,
    ));
    latest = normalizeSnapshot(await evaluate(
      cdp,
      'window.__lumioSpectator ?? null',
      commandTimeout,
    ).catch(() => null));
    await assertAlive?.();
    const runtime = await evaluate(
      cdp,
      '({ status: window.__lumioSpectator?.status ?? null, hasRuntime: Boolean(window.__lumioExports || window.__lumioSpectator) })',
      Math.max(1, Math.min(Number(cdpTimeoutMs ?? timeoutMs) || timeoutMs, Math.max(1, deadline - Date.now()))),
    ).catch(() => null);
    if (snapshotReady(latest) && runtime?.hasRuntime && (!runtimeStatuses.length || runtimeStatuses.includes(latest.status))) return latest;
    await sleep(Math.min(Math.max(0, pollMs), Math.max(0, deadline - Date.now())));
  }
  throw new Error(`spectator page did not expose ${REQUIRED_IDS} entities before timeout (last=${JSON.stringify(latest)})`);
}

function selfMovement(t0, t5) {
  const a = indexPositions(t0);
  const b = indexPositions(t5);
  const selfId = t0?.selfId ?? t5?.selfId
    ?? [...a.entries()].find(([, row]) => row.self)?.[0]
    ?? [...b.entries()].find(([, row]) => row.self)?.[0];
  const normalizedSelfId = selfId == null ? null : String(selfId);
  let p0 = normalizedSelfId != null ? a.get(normalizedSelfId) : null;
  let p5 = normalizedSelfId != null ? b.get(normalizedSelfId) : null;
  if (!p0 || !p5) {
    const id = [...a.entries()].find(([, row]) => row.self)?.[0];
    p0 = id ? a.get(id) : null;
    p5 = id ? b.get(id) : null;
  }
  return {
    selfId: normalizedSelfId,
    present: Boolean(p0 && p5),
    moved: Boolean(p0 && p5 && Math.abs(p5.x - p0.x) + Math.abs(p5.z - p0.z) > 0),
  };
}

function frameKey(snapshot) {
  if (!snapshot) return null;
  // Frame counters are expected to advance between t0 and t5.  Use only
  // stable world/room identity here; treating a tick number as identity would
  // reject a healthy spectator simply because it continued receiving deltas.
  const frameFields = ['worldId', 'roomId', 'instanceId', 'allocationId', 'gameId']
    .filter((key) => snapshot[key] != null)
    .map((key) => `${key}:${snapshot[key]}`);
  if (frameFields.length > 0) return frameFields.join('|');
  const ids = indexPositions(snapshot);
  return ids.size >= REQUIRED_IDS ? `entities:${[...ids.keys()].sort().join(',')}` : null;
}

export function validateBrowserEvidence(browserRows, {
  requiredIds = REQUIRED_IDS,
  requiredMoved = REQUIRED_MOVED,
  evidenceDir,
  spectatorUrl,
  expectedRoomId,
  expectedDsEndpoint,
  requireLaunchContext = spectatorUrl != null || expectedRoomId != null || expectedDsEndpoint != null,
  requireScreenshotFile = evidenceDir != null,
} = {}) {
  const rows = Array.isArray(browserRows) ? browserRows : [];
  const errors = [];
  if (rows.length !== SPECTATORS) errors.push(`expected ${SPECTATORS} spectator browser sessions, received ${rows.length}`);
  const frames = [];
  const rooms = [];
  const cdpPorts = [];
  const targetIds = [];
  let expectedUrl = null;
  if (spectatorUrl != null) {
    try { expectedUrl = requireLaunchContext ? assertLoopbackPageUrl(spectatorUrl) : assertNoCredentialInUrl(spectatorUrl); }
    catch { errors.push('spectator URL expectation is invalid'); }
  }
  let expectedEndpoint = null;
  if (expectedDsEndpoint != null) {
    try { expectedEndpoint = new URL(String(expectedDsEndpoint)).href; }
    catch { errors.push('DS endpoint expectation is invalid'); }
  }
  for (const [index, row] of rows.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      errors.push(`browser ${index + 1} evidence is not an object`);
      frames.push(null);
      rooms.push(null);
      continue;
    }
    const t0 = row?.t0;
    const t5 = row?.t5;
    const movement = probeMoved(t0, t5, { requiredIds, requiredMoved });
    const self = selfMovement(t0, t5);
    const t0Status = typeof t0?.status === 'string' ? t0.status : null;
    const t5Status = typeof t5?.status === 'string' ? t5.status : null;
    const t0Connected = ['wasm-ready', 'connected'].includes(t0Status);
    const t5Connected = ['wasm-ready', 'connected'].includes(t5Status);
    const runtimeReady = t0Connected && row?.runtimeReady === true;
    const botCount = Math.max(Number(t0?.botCount ?? 0), Number(t5?.botCount ?? 0));
    const positionCount = Math.max(
      Array.isArray(t0?.positions) ? t0.positions.length : 0,
      Array.isArray(t5?.positions) ? t5.positions.length : 0,
    );
    const frame0 = frameKey(t0);
    const frame5 = frameKey(t5);
    const frame = frame0 ?? frame5;
    frames.push(frame);
    // Room identity comes from roomId/launch context only: worldId is the
    // world *instance* id used as the frame key, not a room name.
    const room = t0?.roomId ?? t0?.instanceId ?? t5?.roomId ?? t5?.instanceId
      ?? row?.launch?.roomId ?? null;
    rooms.push(room == null ? null : String(room));
    if (row && typeof row === 'object') {
      row.movement = movement;
      row.selfMovement = self;
      row.botCount = botCount;
      row.frame = frame;
    }
    if (row?.headed !== true) errors.push(`browser ${index + 1} was not launched headed`);
    if (row?.target?.type !== 'page') errors.push(`browser ${index + 1} CDP target is not a page`);
    if (row?.cdpPort != null) {
      const port = Number(row.cdpPort);
      if (!Number.isInteger(port) || port < 1 || port > 65_535) errors.push(`browser ${index + 1} CDP port is invalid`);
      else cdpPorts.push(port);
    } else if (requireLaunchContext) {
      errors.push(`browser ${index + 1} CDP port evidence is missing`);
    }
    if (row?.target?.id != null && String(row.target.id).trim() !== '') targetIds.push(String(row.target.id));
    else if (requireLaunchContext) errors.push(`browser ${index + 1} CDP target identity is missing`);
    if (typeof row.url !== 'string') {
      errors.push(`browser ${index + 1} spectator URL evidence is missing`);
    } else {
      try {
        const rowUrl = requireLaunchContext ? assertLoopbackPageUrl(row.url) : assertNoCredentialInUrl(row.url);
        if (expectedUrl != null && rowUrl !== expectedUrl) errors.push(`browser ${index + 1} URL does not match spectator URL`);
      } catch {
        errors.push(`browser ${index + 1} spectator URL evidence is invalid`);
      }
    }
    if (expectedUrl != null) {
      if (row?.target?.url == null) {
        if (requireLaunchContext) errors.push(`browser ${index + 1} target URL evidence is missing`);
      } else {
        try {
          if ((requireLaunchContext ? assertLoopbackPageUrl(row.target.url) : assertNoCredentialInUrl(row.target.url)) !== expectedUrl) errors.push(`browser ${index + 1} target URL does not match spectator URL`);
        } catch {
          errors.push(`browser ${index + 1} target URL evidence is invalid`);
        }
      }
    } else if (row?.target?.url != null && typeof row.url === 'string') {
      try {
        if (assertNoCredentialInUrl(row.target.url) !== assertNoCredentialInUrl(row.url)) {
          errors.push(`browser ${index + 1} target URL does not match recorded URL`);
        }
      } catch { /* the row URL check above reports the useful error */ }
    }
    const launch = row?.launch;
    if (requireLaunchContext) {
      if (!launch || typeof launch !== 'object' || Array.isArray(launch)) {
        errors.push(`browser ${index + 1} launch context is missing`);
      } else {
        for (const field of ['wsUrl', 'subprotocol', ...LAUNCH_CONTEXT_FIELDS]) {
          if (typeof launch[field] !== 'string' || launch[field].trim() === '') {
            errors.push(`browser ${index + 1} launch.${field} is missing`);
          }
        }
        if (typeof launch.subprotocol === 'string' && launch.subprotocol !== 'lumio.mvp.v0') {
          errors.push(`browser ${index + 1} launch subprotocol is invalid`);
        }
        if (typeof launch.wsUrl === 'string' && launch.wsUrl.trim() !== '') {
          // The launch binding is the Platform ticket URL, so the allocator
          // route (`/sample`) is legal here; compare DS authority, not href.
          if (parseLoopbackWsEndpoint(launch.wsUrl) == null) {
            errors.push(`browser ${index + 1} launch endpoint is invalid`);
          } else if (expectedEndpoint != null && !dsEndpointAuthorityMatches(expectedEndpoint, launch.wsUrl)) {
            errors.push(`browser ${index + 1} launch endpoint does not match DS_READY`);
          }
        }
        if (expectedRoomId != null && String(launch.roomId) !== String(expectedRoomId)) {
          errors.push(`browser ${index + 1} launch room does not match expected room`);
        }
      }
    }
    if (!runtimeReady) errors.push(`browser ${index + 1} runtime was not ready`);
    if (!Number.isFinite(botCount) || botCount < requiredIds || positionCount < requiredIds) {
      errors.push(`browser ${index + 1} exposed ${Math.max(Number.isFinite(botCount) ? botCount : 0, positionCount)} entities`);
    }
    if (!t5 || !t5Connected) {
      errors.push(`browser ${index + 1} was not connected at t5`);
    }
    if (t5 && (Number(t5.botCount ?? 0) < requiredIds || !Array.isArray(t5.positions) || t5.positions.length < requiredIds)) {
      errors.push(`browser ${index + 1} lost entities at t5`);
    }
    if (!movement.ok) errors.push(`browser ${index + 1} movement gate failed (${movement.moved} movers)`);
    if (!self.present || !self.moved) errors.push(`browser ${index + 1} self-dot did not move`);
    if (frame0 != null && frame5 != null && frame0 !== frame5) errors.push(`browser ${index + 1} changed entity/world frame during the probe`);
    const canvas = row?.canvas;
    if (!canvas || ![canvas.width, canvas.height, canvas.painted].every((value) => Number.isFinite(Number(value)) && Number(value) > 0)) {
      errors.push(`browser ${index + 1} canvas is blank or unavailable`);
    } else if (!(Number.isFinite(Number(canvas.colorPixels)) && Number(canvas.colorPixels) > 0)) {
      errors.push(`browser ${index + 1} canvas is missing the replicated per-entity color evidence`);
    } else if (!(Number.isFinite(Number(canvas.hueBuckets)) && Number(canvas.hueBuckets) >= 2)) {
      errors.push(`browser ${index + 1} canvas shows a single hue; expected distinct replicated per-entity colors`);
    }
    if (!row?.screenshot) {
      errors.push(`browser ${index + 1} screenshot evidence is missing`);
    } else if (row.screenshotValid !== true || !Number.isFinite(Number(row.screenshotBytes)) || Number(row.screenshotBytes) <= 0) {
      errors.push(`browser ${index + 1} screenshot evidence is invalid`);
    } else if (requireScreenshotFile) {
      const base = resolve(String(evidenceDir));
      const relativePath = String(row.screenshot);
      const candidate = resolve(base, relativePath);
      if (isAbsolute(relativePath) || !pathWithin(base, candidate) || !isFilePath(candidate)) {
        errors.push(`browser ${index + 1} screenshot path is outside evidence or missing`);
      } else {
        try {
          const bytes = readFileSync(candidate);
          if (!isPngBuffer(bytes) || bytes.length !== Number(row.screenshotBytes)) {
            errors.push(`browser ${index + 1} screenshot file is not valid PNG evidence`);
          }
        } catch {
          errors.push(`browser ${index + 1} screenshot file is unreadable`);
        }
      }
    }
    if (expectedRoomId != null) {
      const rowRoom = room == null ? null : String(room);
      if (rowRoom == null || rowRoom !== String(expectedRoomId)) {
        errors.push(`browser ${index + 1} room does not match expected room`);
      }
    }
  }
  if (requireLaunchContext) {
    if (cdpPorts.length !== rows.length || new Set(cdpPorts).size !== cdpPorts.length) errors.push('spectator CDP ports are missing or not unique');
    if (targetIds.length !== rows.length || new Set(targetIds).size !== targetIds.length) errors.push('spectator CDP target identities are missing or not unique');
  }
  const sharedFrame = frames.length === SPECTATORS && frames[0] != null && frames.every((frame) => frame === frames[0]);
  if (!sharedFrame) errors.push('spectator windows do not share an entity/world frame');
  const knownRooms = rooms.filter((room) => room != null);
  if (knownRooms.length > 1 && new Set(knownRooms).size !== 1) errors.push('spectator windows do not share a room');
  return {
    ok: errors.length === 0,
    errors,
    sharedFrame,
    frame: sharedFrame ? frames[0] : null,
    rows,
  };
}

export function chromeArgs({ port, profileDir, url }) {
  return [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    '--new-window',
    url,
  ];
}

export async function collectBrowserEvidence({ launch, url, index, port, profileDir, evidence, options = {} }) {
  const evidenceRoot = resolve(evidence ?? join(process.cwd(), '.run'));
  mkdirSync(evidenceRoot, { recursive: true });
  if (!profileDir) throw new TypeError('profileDir is required');
  const secrets = [launch?.admissionCredential].filter(Boolean);
  const launchErrors = [];
  validateLaunchBinding(launch, index, launchErrors, { strict: false });
  if (launchErrors.length > 0) throw new Error(`invalid spectator launch binding: ${launchErrors.join('; ')}`);
  const row = {
    index,
    headed: true,
    cdpPort: port,
    target: null,
    url: assertLoopbackPageUrl(url),
    profile: relative(evidenceRoot, profileDir).replaceAll('\\', '/'),
    runtimeReady: false,
    t0: null,
    t5: null,
    canvas: null,
    screenshot: null,
    console: [],
    launch: launch ? {
      wsUrl: launch.wsUrl,
      subprotocol: launch.subprotocol,
      serverAudience: launch.serverAudience ?? null,
      gameId: launch.gameId ?? null,
      gameReleaseId: launch.gameReleaseId ?? null,
      contractId: launch.contractId ?? null,
      roomId: launch.roomId ?? null,
      allocationId: launch.allocationId ?? null,
    } : null,
  };
  let cdp;
  let injectionId = null;
  const consoleEvents = [];
  const removeListeners = [];
  const cdpTimeoutMs = effectiveCdpTimeout(options);
  try {
    const connected = await connectChromeCdp(port, {
      ...options,
      targetId: options.targetId,
      targetTitle: options.targetTitle,
      targetUrl: options.targetUrl ?? (
        options.targetId == null && options.targetTitle == null ? url : undefined
      ),
    });
    cdp = connected.client;
    row.target = connected.target;
    for (const method of ['Runtime.consoleAPICalled', 'Runtime.exceptionThrown', 'Log.entryAdded']) {
      if (typeof cdp.on !== 'function') continue;
      const handler = (params) => {
        try {
          const text = JSON.stringify(params);
          consoleEvents.push(redactScalar(text, secrets));
        } catch { /* an adapter event must not abort the probe */ }
      };
      try {
        const subscription = cdp.on(method, handler);
        if (typeof subscription === 'function') removeListeners.push(subscription);
        else if (typeof cdp.off === 'function') removeListeners.push(() => cdp.off(method, handler));
        else if (typeof cdp.removeListener === 'function') removeListeners.push(() => cdp.removeListener(method, handler));
      } catch { /* console capture is optional adapter functionality */ }
    }
    await cdpCall(cdp, 'Runtime.enable', {}, cdpTimeoutMs);
    await cdpCall(cdp, 'Page.enable', {}, cdpTimeoutMs);
    await cdpCall(cdp, 'Log.enable', {}, cdpTimeoutMs).catch(() => {});
    const injection = await cdpCall(cdp, 'Page.addScriptToEvaluateOnNewDocument', {
      source: launchExpression(launch),
    }, cdpTimeoutMs);
    injectionId = injection?.identifier ?? null;
    await cdpCall(cdp, 'Page.navigate', { url: row.url }, cdpTimeoutMs);
    const t0 = await waitForSnapshot(cdp, {
      timeoutMs: options.browserTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      cdpTimeoutMs,
      pollMs: options.pollMs ?? 100,
      assertAlive: options.assertAlive,
    });
    row.runtimeReady = ['wasm-ready', 'connected'].includes(t0.status);
    row.t0 = t0;
    await options.assertAlive?.();
    await sleep(options.probeWindowMs ?? PROBE_WINDOW_MS);
    await options.assertAlive?.();
    row.t5 = normalizeSnapshot(await evaluate(cdp, 'window.__lumioSpectator ?? null', cdpTimeoutMs));
    row.canvas = await evaluate(cdp, CDP_CANVAS_STATS_EXPRESSION, cdpTimeoutMs).catch(() => null);
    const image = await cdpCall(cdp, 'Page.captureScreenshot', { format: 'png' }, cdpTimeoutMs).catch(() => null);
    if (image?.data) {
      const path = join(evidenceRoot, `browser-${index}-t5.png`);
      const bytes = Buffer.from(image.data, 'base64');
      writeFileSync(path, bytes);
      row.screenshot = relative(evidenceRoot, path).replaceAll('\\', '/');
      row.screenshotBytes = bytes.length;
      row.screenshotValid = isPngBuffer(bytes);
    }
    row.console = consoleEvents.slice(-200);
    // Persist the same derived fields used by the final browser gate.  This
    // keeps the per-window JSON independently reviewable after the runner
    // has torn down CDP.
    row.movement = probeMoved(row.t0, row.t5);
    row.selfMovement = selfMovement(row.t0, row.t5);
    row.botCount = Math.max(Number(row.t0?.botCount ?? 0), Number(row.t5?.botCount ?? 0));
    row.frame = frameKey(row.t0) ?? frameKey(row.t5);
    writeJson(join(evidenceRoot, `browser-${index}.json`), row, secrets);
    return row;
  } finally {
    if (cdp) {
      // Remove the pre-navigation hook before closing the session.  This is
      // required on both successful and failed probes so a reused Chrome
      // profile cannot carry an admission credential into another page.
      if (injectionId != null) {
        await cdpCall(cdp, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: injectionId }, cdpTimeoutMs).catch(() => {});
      }
      await evaluate(cdp, 'delete window.__lumioLaunch', cdpTimeoutMs).catch(() => {});
      for (const remove of removeListeners) {
        try { remove(); } catch { /* best effort */ }
      }
      const close = typeof cdp.close === 'function'
        ? () => cdp.close()
        : (typeof cdp.disconnect === 'function' ? () => cdp.disconnect() : null);
      if (close) {
        await promiseWithTimeout(Promise.resolve().then(close), cdpTimeoutMs, 'close').catch(() => {});
      }
    }
  }
}

async function startChromeSession({ chrome, port, profileDir, url, evidence, tools, options }) {
  mkdirSync(profileDir, { recursive: true });
  const args = chromeArgs({ port, profileDir, url });
  const logPath = join(evidence, `chrome-${port}.log`);
  let started;
  try {
    started = typeof options.startChrome === 'function'
      ? await options.startChrome({ chrome, args, port, profileDir, url, logPath })
      : await tools.startLogged(chrome, args, { cwd: dirname(chrome), env: options.env ?? process.env, log: logPath });
  } catch (error) {
    // Adapters sometimes attach a child after spawning and then throw while
    // wiring its log stream.  Reap that child even though no normal return
    // value reached the topology cleanup stack.
    const leaked = error?.state ?? error?.child ?? error?.process;
    if (leaked) {
      try {
        const candidate = leaked?.state ?? leaked;
        const entry = isProcessState(candidate)
          ? { state: candidate, cleanupWithTools: true }
          : { state: syntheticProcessState(candidate?.child ?? candidate), cleanupWithTools: false };
        await cleanupProcessState(entry, tools);
      } catch { /* preserve the original startup error */ }
    }
    throw error;
  }
  const candidate = started?.state ?? started;
  const child = candidate && Object.prototype.hasOwnProperty.call(candidate, 'child')
    ? candidate.child
    : candidate;
  if (!child) return { child: null, state: null, cleanupWithTools: false, raw: started, args: redactArgs(args), port, profileDir };

  // process-tools returns a state object. Custom test adapters often return a
  // bare ChildProcess, so wrap that shape before liveness and teardown use it.
  if (isProcessState(candidate)) {
    return { child, state: candidate, cleanupWithTools: true, raw: started, args: redactArgs(args), port, profileDir };
  }
  const state = syntheticProcessState(child);
  return { child, state, cleanupWithTools: false, raw: started, args: redactArgs(args), port, profileDir };
}

function isProcessState(value) {
  return Boolean(value && typeof value === 'object' && value.child && (
    Object.prototype.hasOwnProperty.call(value, 'closed')
    || Object.prototype.hasOwnProperty.call(value, 'done')
    || Object.prototype.hasOwnProperty.call(value, 'stdout')
    || Object.prototype.hasOwnProperty.call(value, 'code')
  ));
}

function syntheticProcessState(child) {
  const state = { child, stdout: '', closed: false, code: null, signal: null, error: null };
  if (child && typeof child.once === 'function') {
    state.done = new Promise((resolvePromise) => {
      child.once('close', (code, signal) => {
        Object.assign(state, { closed: true, code, signal });
        resolvePromise(state);
      });
    });
  } else {
    state.done = Promise.resolve(state);
  }
  return state;
}

async function cleanupProcessState(entry, tools) {
  const state = entry?.state ?? entry;
  if (!state) return;
  if (entry?.composePath) {
    const child = state.child ?? state;
    // Compose owns a service graph rather than just the attached CLI child.
    // Give the CLI a chance to stop cleanly, then explicitly remove the
    // project so containers and networks do not survive the acceptance run.
    if (state.closed !== true && typeof child.kill === 'function') {
      try { child.kill('SIGINT'); } catch { /* already exited */ }
      if (state.done && typeof state.done.then === 'function') {
        await Promise.race([
          Promise.resolve(state.done).catch(() => {}),
          sleep(entry.composeSignalTimeoutMs ?? 5_000),
        ]);
      }
    }
    try {
      await commandResult(entry.composeCommand ?? 'docker', [
        'compose', '--file', entry.composePath, 'down', '--remove-orphans',
      ], {
        cwd: entry.composeCwd,
        env: entry.composeEnv,
        timeoutMs: entry.composeTeardownTimeoutMs ?? 30_000,
      });
    } catch { /* teardown is best effort; continue to reap the CLI child */ }
    if (state.closed !== true && entry.cleanupWithTools !== false
        && isProcessState(state) && typeof tools?.forceCleanup === 'function') {
      try {
        await tools.forceCleanup(state);
        return;
      } catch { /* fall through to a direct kill/reap attempt */ }
    }
    if (state.closed !== true && typeof child.kill === 'function') {
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
    }
    if (state.done && typeof state.done.then === 'function' && typeof child.once === 'function') {
      await Promise.race([state.done, sleep(5_000)]).catch(() => {});
    }
    return;
  }
  if (entry?.cleanupWithTools !== false && isProcessState(state) && typeof tools?.forceCleanup === 'function') {
    await tools.forceCleanup(state);
    return;
  }
  const child = state.child ?? state;
  if (typeof child.kill !== 'function') return;
  if (state.closed !== true) {
    try { child.kill('SIGKILL'); } catch { /* already exited */ }
  }
  if (state.done && typeof state.done.then === 'function' && typeof child.once === 'function') {
    await Promise.race([state.done, sleep(5_000)]);
  }
}

function platformCommand(options, root) {
  if (Array.isArray(options.platformCommand) && options.platformCommand.length > 0) {
    return { command: options.platformCommand[0], args: options.platformCommand.slice(1), cwd: options.platformCwd ?? root };
  }
  // An environment variable describes where compose lives; it is not an
  // authorization to start a platform.  Starting it requires an explicit
  // compose path or --start-platform.
  const composeWasExplicit = options.composeFileExplicit === true;
  const compose = options.startPlatform === true
    ? (options.composeFile ?? options.env?.LUMIO_PLATFORM_COMPOSE)
    : (composeWasExplicit ? options.composeFile : undefined);
  if (!compose) return null;
  const composePath = resolve(String(compose));
  return {
    command: options.docker ?? 'docker',
    args: ['compose', '--file', composePath, 'up', '--remove-orphans'],
    cwd: dirname(composePath),
    composePath,
    composeCommand: options.docker ?? 'docker',
  };
}

function redactPersistedSecrets(root, secrets = []) {
  if (!root || !existsSync(root) || !Array.isArray(secrets) || secrets.length === 0) return;
  const textExtensions = new Set(['.log', '.json', '.jsonl', '.ndjson', '.txt', '.csv']);
  const visit = (path) => {
    let info;
    try { info = statSync(path); } catch { return; }
    if (info.isDirectory()) {
      let names = [];
      try { names = readdirSync(path); } catch { return; }
      for (const name of names) visit(join(path, name));
      return;
    }
    if (!textExtensions.has(extname(path).toLowerCase())) return;
    try {
      const before = readFileSync(path, 'utf8');
      const after = redactScalar(before, secrets);
      if (after !== before) writeFileSync(path, after);
    } catch { /* binary/partially-written evidence is left untouched */ }
  };
  visit(root);
}

function effectivePath(value, fallback = '') {
  const text = String(value ?? '').trim();
  return text ? resolve(text) : fallback;
}

export function assertTicketPathSafe(root, ticketPath) {
  const repository = resolve(root);
  const requested = String(ticketPath ?? '').trim();
  if (!requested || requested.includes('\0')) {
    throw blocked('ticket manifest path contains an invalid NUL character or is empty');
  }
  const candidate = resolve(requested);

  // Paths outside the checkout are useful for CI secret stores and are not
  // subject to this repository's ignore rules.  For paths inside the checkout,
  // require Git to report an ignore match before raw credentials are written.
  let gitRoot;
  try {
    const output = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: repository,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
    gitRoot = resolve(String(output).trim());
  } catch {
    // A caller may intentionally use a non-Git temporary root.  There is no
    // repository namespace to protect in that case.
    return candidate;
  }
  if (!pathWithin(gitRoot, candidate)) return candidate;

  try {
    execFileSync('git', ['check-ignore', '-q', '--', candidate], {
      cwd: gitRoot,
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch (error) {
    if (error?.status === 1) {
      throw blocked(`ticket manifest path must be gitignored when inside the repository: ${candidate}`);
    }
    throw blocked(`unable to verify ticket manifest path safety: ${candidate}`);
  }
  return candidate;
}

function pathWithin(base, candidate) {
  const rel = relative(base, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

/**
 * Optionally overlay a NativeLoader artifact for an older Bot.Host ABI.  The
 * normal path uses the caller's native sidecar unchanged; this helper is kept
 * opt-in because replacing assemblies while a DS is alive is unsafe.
 */
export function applyNativeLoaderOverlay(spec = {}) {
  if (!spec || spec.enabled !== true) return { applied: false, restore: async () => {} };
  const sourceValue = String(spec.sourceDir ?? '').trim();
  const targetValue = String(spec.targetDir ?? '').trim();
  if (!sourceValue || !targetValue) throw blocked('NativeLoader overlay sourceDir and targetDir are required');
  const sourceDir = resolve(sourceValue);
  const targetDir = resolve(targetValue);
  if (!existsSync(sourceDir) || !existsSync(targetDir)
      || !statSync(sourceDir).isDirectory() || !statSync(targetDir).isDirectory()) {
    throw blocked('NativeLoader overlay sourceDir and targetDir must be existing directories');
  }
  if (sourceDir.toLowerCase() === targetDir.toLowerCase()) {
    return { applied: false, restore: async () => {}, backupDir: null, files: [] };
  }
  const names = Array.isArray(spec.files) && spec.files.length > 0
    ? spec.files.map(String)
    : ['Lumio.Engine.NativeLoader.dll', 'Lumio.Engine.NativeLoader.deps.json', 'Lumio.Engine.NativeLoader.xml'];
  const backupDir = spec.backupDir ? resolve(spec.backupDir) : join(targetDir, `.lumio-native-overlay-${process.pid}-${Date.now()}`);
  if (!pathWithin(targetDir, backupDir) || backupDir.toLowerCase() === targetDir.toLowerCase()
      || pathWithin(sourceDir, backupDir)) {
    throw blocked('NativeLoader overlay backupDir must be a child of targetDir and outside sourceDir');
  }
  mkdirSync(backupDir, { recursive: true });
  const changed = [];
  try {
    for (const name of names) {
      if (!name || isAbsolute(name) || name.includes('\0')) {
        throw blocked(`overlay file name must be relative: ${name}`);
      }
      const source = resolve(sourceDir, name);
      const target = resolve(targetDir, name);
      if (!pathWithin(sourceDir, source) || source === sourceDir) throw new Error(`overlay source escapes sourceDir: ${name}`);
      if (!pathWithin(targetDir, target) || target === targetDir) throw new Error(`overlay target escapes targetDir: ${name}`);
      const backup = resolve(backupDir, name);
      if (!pathWithin(backupDir, backup) || pathWithin(backupDir, target)) {
        throw blocked(`overlay backup path is unsafe: ${name}`);
      }
      if (!existsSync(source)) continue;
      mkdirSync(dirname(backup), { recursive: true });
      mkdirSync(dirname(target), { recursive: true });
      if (existsSync(target)) {
        copyFileSync(target, backup);
        changed.push({ target, backup, hadTarget: true });
      } else {
        changed.push({ target, backup: null, hadTarget: false });
      }
      copyFileSync(source, target);
    }
  } catch (error) {
    for (const item of changed.reverse()) {
      try {
        if (item.hadTarget) copyFileSync(item.backup, item.target);
        else unlinkSync(item.target);
      } catch { /* best effort rollback */ }
    }
    rmSync(backupDir, { recursive: true, force: true });
    throw error;
  }
  let restored = false;
  const restore = async () => {
    if (restored) return;
    restored = true;
    for (const item of changed.reverse()) {
      if (item.hadTarget) copyFileSync(item.backup, item.target);
      else if (existsSync(item.target)) unlinkSync(item.target);
    }
    rmSync(backupDir, { recursive: true, force: true });
  };
  return { applied: changed.length > 0, restore, backupDir, files: changed.map((item) => item.target) };
}

export async function runLiveTopology({ env = process.env, root = ROOT, evidence, document, options = {} }) {
  // Authorization is checked before loading helpers or creating any scratch
  // directories.  A live-looking environment alone must never cause a side
  // effect when the caller has not explicitly opted in.
  const authorization = liveAuthorization({ env, options });
  if (!authorization.ok) {
    return { status: 'BLOCKED_ENV', error: `BLOCKED_ENV: ${authorization.reasons.join('; ')}` };
  }
  const tools = options.processTools ?? await loadProcessTools({ env, repoRoot: root });
  document ??= createSpectatorDocument();
  document.processes ??= {};
  evidence = resolve(evidence ?? join(root, '.run', 'spectator-100-live'));
  mkdirSync(evidence, { recursive: true });
  const effectiveOrigin = options.origin ?? env.LUMIO_PLATFORM_ORIGIN;
  const effectiveDsConfig = effectivePath(options.dsConfig ?? env.LUMIO_DS_CONFIG, resolve(root, 'server.json'));
  const effectiveNative = options.engineNative ?? env.LUMIO_ENGINE_NATIVE ?? env.LUMIO_ENGINE_NATIVE_PATH;
  const childEnv = buildChildEnv({
    env: { ...env, LUMIO_PLATFORM_ORIGIN: effectiveOrigin },
    root,
    dsConfig: effectiveDsConfig,
    engineNative: effectiveNative,
  });
  const children = [];
  const secrets = [];
  const cleanupPaths = [];
  const scratch = resolve(options.scratchDir ?? env.LUMIO_WAVE_B_SCRATCH ?? join(root, '.run', 'spectator-100-scratch'));
  let staticServer;
  let overlay;
  let platformSpec;
  // An explicit operator opt-in: a PASS may leave the DS, the Bot.Host
  // processes, the static server and both Chrome windows alive for manual
  // inspection. Teardown of a failed run is never suppressed.
  const holdRequested = options.holdLive === true;
  const track = async (factory, metadata = {}) => {
    const child = await factory();
    if (child) children.push({ state: child, cleanupWithTools: true, ...metadata });
    return child;
  };
  try {
    // Resolve every required artifact before starting Platform or DS.  This
    // keeps an incomplete operator environment side-effect free.
    const dsExe = effectivePath(options.dsExe ?? env.LUMIO_DS_EXE);
    const botDll = effectivePath(options.botDll ?? env.LUMIO_BOT_DLL);
    const gameplay = effectivePath(options.gameplay ?? env.LUMIO_GAMEPLAY);
    const engineNative = effectivePath(effectiveNative);
    if (!isFilePath(effectiveDsConfig)) return { status: 'BLOCKED_ENV', error: `BLOCKED_ENV: DS config is missing: ${effectiveDsConfig}` };
    if (!isFilePath(dsExe)) return { status: 'BLOCKED_ENV', error: 'BLOCKED_ENV: LUMIO_DS_EXE is not set or is not a file' };
    if (!isFilePath(botDll)) return { status: 'BLOCKED_ENV', error: 'BLOCKED_ENV: LUMIO_BOT_DLL is not set or is not a file' };
    if (!isFilePath(gameplay)) return { status: 'BLOCKED_ENV', error: 'BLOCKED_ENV: LUMIO_GAMEPLAY is not set or is not a file' };
    if (!isFilePath(engineNative)) return { status: 'BLOCKED_ENV', error: 'BLOCKED_ENV: LUMIO_ENGINE_NATIVE is not set or is not a file' };
    let dsConfigValue;
    try { dsConfigValue = JSON.parse(readFileSync(effectiveDsConfig, 'utf8')); } catch (error) {
      return { status: 'FAIL', error: `DS config is invalid JSON: ${error.message}` };
    }
    assertRunnableDsConfig(dsConfigValue);

    const pageRoot = resolve(options.clientRoot ?? resolve(root, '..', 'LumioClient'));
    // Resolve only an operator-provided URL/origin. When absent, the runner
    // owns the static server lifecycle and fills in its loopback URL below.
    const requestedSpectatorUrl = resolveExplicitSpectatorUrl({ options, env, document });
    const pageEntry = join(pageRoot, 'modules', 'web', 'spectator', 'index.html');
    if (!isFilePath(pageEntry) && !requestedSpectatorUrl) {
      return { status: 'BLOCKED_ENV', error: `BLOCKED_ENV: spectator page is missing: ${pageEntry}` };
    }
    const chrome = options.chrome ?? findChromePath(env);
    if (!chrome && typeof options.startChrome !== 'function') return { status: 'BLOCKED_ENV', error: 'BLOCKED_ENV: Chrome executable is not available' };
    const hasCustomPlatformCommand = Array.isArray(options.platformCommand) && options.platformCommand.length > 0;
    const composeRequested = options.startPlatform === true || options.composeFileExplicit === true;
    if (composeRequested && !hasCustomPlatformCommand) {
      const composeValue = options.composeFile ?? env.LUMIO_PLATFORM_COMPOSE;
      if (!composeValue) {
        return { status: 'BLOCKED_ENV', error: 'BLOCKED_ENV: --start-platform requires LUMIO_PLATFORM_COMPOSE or an explicit platform command' };
      }
      if (!isFilePath(composeValue)) {
        return { status: 'BLOCKED_ENV', error: `BLOCKED_ENV: Platform compose file is missing: ${resolve(String(composeValue))}` };
      }
    }

    const preflight = await preflightLiveTopology({
      env,
      options: {
        ...options,
        origin: effectiveOrigin,
        cdpPorts: options.cdpPorts ?? DEFAULT_CDP_PORTS,
        spectatorUrl: requestedSpectatorUrl,
        spectatorStaticPort: options.spectatorStaticPort ?? env.LUMIO_SPECTATOR_STATIC_PORT,
      },
      root,
      expectedShas: document?.shas,
    });
    document.processes.preflightBotHosts = preflight.botHosts ?? null;
    document.processes.preflightBusyPorts = preflight.busyPorts ?? [];
    document.processes.preflightShas = preflight.shas ?? null;
    if (!preflight.ok) return { status: preflight.status, error: `BLOCKED_ENV: ${preflight.reason}` };

    // Keep the operator's filesystem untouched until every prerequisite and
    // the no-existing-topology preflight have passed.
    mkdirSync(scratch, { recursive: true });

    // NativeLoader overlays are deliberately opt-in and are restored only
    // after all child processes have been reaped.
    if (options.nativeLoaderOverlay) {
      overlay = applyNativeLoaderOverlay({
        ...(options.nativeLoaderOverlay === true ? {} : options.nativeLoaderOverlay),
        enabled: true,
      });
    }

    platformSpec = platformCommand({ ...options, env }, root);
    if (platformSpec) {
      const platformChild = await track(() => tools.startLogged(platformSpec.command, platformSpec.args, {
        cwd: platformSpec.cwd,
        env: childEnv,
        log: join(evidence, 'platform.log'),
      }), platformSpec.composePath ? {
        composePath: platformSpec.composePath,
        composeCommand: platformSpec.composeCommand,
        composeCwd: platformSpec.cwd,
        composeEnv: childEnv,
        composeTeardownTimeoutMs: options.platformTeardownTimeoutMs ?? 30_000,
      } : {});
      document.processes.platformStarted = true;
      await tools.assertAlive?.(platformChild);
    } else if (options.platformAlreadyRunning !== true) {
      return { status: 'BLOCKED_ENV', error: 'BLOCKED_ENV: Platform must already be running; pass an explicit compose/startPlatform option to start it' };
    }
    document.processes.platformAlreadyRunning = platformSpec == null;
    await checkHttpListener(effectiveOrigin, {
      ...options,
      timeoutMs: options.platformTimeoutMs ?? options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });
    document.processes.platformReady = true;

    const minted = await mintTickets({ env: childEnv, root, options, evidence, document });
    secrets.push(...minted.secrets);
    if (minted.removeManifest) cleanupPaths.push(minted.ticketsPath);
    const rows = minted.manifest.accounts;
    const botRows = rows.slice(0, BOTS);
    const spectatorRows = rows.slice(BOTS, TOTAL_TICKETS);
    document.ticketLogins = rows.map((row) => row.loginName);
    document.spectators = spectatorRows.map((row) => ({
      loginName: row.loginName,
      accountId: row.accountId,
      roomId: row.launch.roomId ?? null,
      ticket: redactTicket(row.launch.admissionCredential),
    }));
    // Every bot and spectator ticket must resolve to the same DS room.  A
    // spectator-only check could hide a split topology until after the bots
    // had already been admitted.
    const roomIds = rows.map((row) => row.launch.roomId).filter((value) => value != null).map(String);
    const wsUrls = rows.map((row) => row.launch.wsUrl).filter(Boolean);
    if (roomIds.length > 1 && new Set(roomIds).size !== 1) return { status: 'FAIL', error: 'ticket manifest describes more than one room' };
    if (wsUrls.length > 1 && new Set(wsUrls).size !== 1) return { status: 'FAIL', error: 'ticket manifest describes more than one DS endpoint' };
    document.roomId = roomIds[0] ?? null;

    const dsArgs = buildServerArgs(effectiveDsConfig);
    if (typeof tools.command === 'function') {
      await tools.command(dsExe, [...dsArgs, '--check-config'], {
        cwd: dirname(dsExe), env: childEnv, log: join(evidence, 'lumio-ds.check-config.log'),
      });
    }
    const ds = await track(() => tools.startLogged(dsExe, dsArgs, {
      cwd: dirname(dsExe), env: childEnv, log: join(evidence, 'lumio-ds.log'),
    }));
    const dsDeadline = Date.now() + (options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    let ready = findDsReady(ds?.stdout);
    while (!ready && Date.now() < dsDeadline) {
      await tools.assertAlive?.(ds);
      await sleep(25);
      ready = findDsReady(ds?.stdout);
    }
    if (!ready) return { status: 'FAIL', error: 'lumio-ds did not emit DS_READY' };
    const endpoint = resolveDsEndpoint(ready, options.endpoint ?? env.LUMIO_DS_ENDPOINT);
    if (ready.roomId != null && document.roomId != null
        && String(ready.roomId) !== String(document.roomId)) {
      return { status: 'FAIL', error: 'DS_READY room does not match ticket manifest' };
    }
    if (wsUrls.length > 0) {
      // Ticket URLs carry the Platform allocator route (`/sample`); only the
      // authority — protocol, hostname, effective port — has to equal DS_READY.
      if (wsUrls.some((value) => !dsEndpointAuthorityMatches(endpoint, value))) {
        return { status: 'FAIL', error: 'ticket manifest endpoint does not match DS_READY' };
      }
    }
    document.processes.dsReady = {
      pid: ready.pid,
      endpoint,
      ...(ready.roomId != null ? { roomId: String(ready.roomId) } : {}),
    };
    // Bots and spectators both dial the Platform-issued ticket URL, allocator
    // route included; DS_READY's root endpoint only proves which listener that
    // URL must point at. All rows share one wsUrl string (validated above).
    const ticketWsUrl = wsUrls[0] ?? endpoint;

    const spawnBotChild = async (index, ticketsPath, dirSuffix = '') => {
      const row = botRows[index];
      // Retries spawn into their own log dir: the parser treats any fault line
      // in a bot's nested log as fatal, and the replaced attempt's history
      // must not condemn its replacement.
      const logDir = join(evidence, `bot-${index + 1}${dirSuffix}`);
      mkdirSync(logDir, { recursive: true });
      const args = buildBotArgs({
        botDll,
        endpoint: ticketWsUrl,
        // FoundationHostCommand.LoadManifestTickets resolves credentials by
        // account name.  The raw ticket never appears on argv.
        admissionTicket: ticketsPath,
        engineNative,
        logDir,
        accountFrom: row.loginName,
        accountTo: row.loginName,
        gameplay,
      });
      return track(() => tools.startLogged(options.dotnet ?? env.LUMIO_DOTNET ?? 'dotnet', args, {
        cwd: dirname(botDll), env: childEnv, log: join(evidence, `bot-${index + 1}.log`),
      }));
    };

    const botChildren = [];
    for (let index = 0; index < botRows.length; index += 1) {
      if (index > 0) await sleep(options.staggerMs ?? 250);
      if (String(env.LIVE_BOTS ?? '') !== '0') return { status: 'BLOCKED_ENV', error: 'BLOCKED_ENV: LIVE_BOTS changed while starting Bot.Host processes' };
      botChildren.push(await spawnBotChild(index, minted.ticketsPath));
    }
    document.processes.botHostsStarted = botChildren.length;
    if (botChildren.length !== BOTS) return { status: 'FAIL', error: `started ${botChildren.length} Bot.Host processes; expected ${BOTS}` };

    // A live socket occasionally drops around the first wander Activate, and
    // the one-use admission ticket dies with it. The only honest repair is to
    // replace that bot with a fresh ticket for the same account: the retry is
    // still a real Bot.Host process holding a real unique ticket, and the
    // round count is recorded in the evidence document.
    const retryRounds = Number.isInteger(options.botRetryRounds) ? options.botRetryRounds : 2;
    document.processes.botRetryRounds = 0;
    let lastReport = { admitted: 0, rejected: 0, faulted: 0 };
    const platformRoot = resolve(root, '..', 'LumioPlatform');
    const issuerScript = join(platformRoot, 'eng', 'stress-tickets.mjs');
    for (let round = 0; ; round += 1) {
      let admission;
      try {
        admission = typeof options.waitForAdmissions === 'function'
          ? await options.waitForAdmissions({ botChildren, evidenceDir: evidence, expected: BOTS, tools })
          : await waitForBotAdmissions({
            botChildren,
            evidenceDir: evidence,
            expected: BOTS,
            timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            tools,
            pollMs: options.pollMs ?? 100,
            evidenceTick: options.evidenceTick,
          });
      } catch (error) {
        // An exited child is repaired below like any other fault; only the
        // final round escalates the original error.
        if (round >= retryRounds) throw error;
      }
      const observedAdmission = countAdmittedBotHosts(botChildren, { evidenceDir: evidence });
      lastReport = {
        admitted: Math.min(Number(admission?.admitted ?? 0), observedAdmission.admitted),
        rejected: Math.max(Number(admission?.rejected ?? 0), observedAdmission.rejected),
        faulted: Math.max(Number(admission?.faulted ?? 0), observedAdmission.faulted),
      };
      if (lastReport.admitted === BOTS && lastReport.rejected === 0 && lastReport.faulted === 0) break;
      if (round >= retryRounds) {
        document.processes.admittedBots = lastReport.admitted;
        document.processes.rejectedBots = lastReport.rejected;
        document.processes.faultedBots = lastReport.faulted;
        return { status: 'FAIL', error: `Bot.Host admission gate failed: ${lastReport.admitted}/${BOTS} admitted` };
      }
      const details = observedAdmission.details ?? [];
      const broken = [];
      for (let i = 0; i < botChildren.length; i += 1) {
        const item = details[i];
        const closed = botChildren[i]?.closed === true;
        if (closed || (item && (item.rejected === true || item.faulted === true))) broken.push(i);
      }
      if (broken.length === 0) continue;
      document.processes.botRetryRounds = round + 1;
      for (const index of broken) {
        const retryPath = join(evidence, `bot-${index + 1}-retry${round + 1}.json`);
        const issuer = await commandResult(process.execPath, [
          issuerScript,
          '--count', '1',
          '--start', String(TICKET_START_INDEX + index),
          '--origin', String(effectiveOrigin ?? ''),
          '--game', String(options.slug ?? 'sample'),
          '--prefix', TICKET_PREFIX,
          '--out', retryPath,
        ], {
          cwd: platformRoot,
          env: childEnv,
          timeoutMs: options.ticketTimeoutMs ?? 180_000,
        });
        if (issuer.code !== 0 || !existsSync(retryPath)) {
          return { status: 'FAIL', error: `bot-${index + 1} retry ticket minting failed` };
        }
        const retryManifest = JSON.parse(readFileSync(retryPath, 'utf8'));
        const retryRow = retryManifest.accounts?.[0] ?? retryManifest[0];
        const retryCredential = retryRow?.launch?.admissionCredential;
        // The issuer pads names to the width of the batch's largest index, so a
        // one-ticket retry for stressbot033 mints "stressbot33". Bot.Host's
        // manifest loader resolves the D2/D3 aliases, so compare the normalized
        // prefix+number instead of the literal string.
        const accountIdentity = (name) => {
          const match = String(name ?? '').match(/^(.*?)(\d+)$/);
          return match ? `${match[1]}#${Number(match[2])}` : String(name ?? '');
        };
        if (typeof retryCredential !== 'string' || retryCredential.length === 0
            || accountIdentity(retryRow.loginName) !== accountIdentity(botRows[index].loginName)) {
          return { status: 'FAIL', error: `bot-${index + 1} retry ticket does not match its account` };
        }
        secrets.push(retryCredential);
        cleanupPaths.push(retryPath);
        const oldChild = botChildren[index];
        if (oldChild && oldChild.closed !== true && typeof tools.forceCleanup === 'function') {
          try { await tools.forceCleanup(oldChild); } catch { /* already gone */ }
        }
        botChildren[index] = await spawnBotChild(index, retryPath, `-retry${round + 1}`);
      }
    }
    document.processes.admittedBots = lastReport.admitted;
    document.processes.rejectedBots = lastReport.rejected;
    document.processes.faultedBots = lastReport.faulted;
    // A second census is part of the evidence, and every child must still be
    // alive after the final admission tick.
    for (const child of botChildren) await tools.assertAlive?.(child);
    const afterRows = await processCensus(options);
    const afterCount = countBotHostProcesses(afterRows);
    document.processes.botHostsAfterStart = afterCount;
    if (afterCount !== BOTS) return { status: 'FAIL', error: `process census found ${afterCount} Bot.Host processes; expected ${BOTS}` };

    const staticPort = safePort(options.spectatorStaticPort ?? env.LUMIO_SPECTATOR_STATIC_PORT, DEFAULT_STATIC_PORT);
    if (requestedSpectatorUrl) {
      document.spectatorUrl = assertLoopbackPageUrl(requestedSpectatorUrl);
    } else {
      staticServer = await startStaticServer(pageRoot, staticPort);
      document.spectatorUrl = assertLoopbackPageUrl(`http://127.0.0.1:${staticPort}/modules/web/spectator/`);
    }
    const ports = preflight.cdpPorts ?? normalizeCdpPorts(options.cdpPorts).ports;
    const sessions = spectatorRows.map((row, index) => ({
      row, index: index + 1, port: ports[index], profileDir: join(scratch, `chrome-${index + 1}`),
    }));
    const chromeChildren = [];
    // Start sequentially so a failure in spectator 2 cannot orphan spectator 1.
    for (const session of sessions) {
      const started = await startChromeSession({
        chrome, port: session.port, profileDir: session.profileDir, url: document.spectatorUrl,
        evidence, tools, options: { ...options, env: childEnv },
      });
      if (started.state) children.push({ state: started.state, cleanupWithTools: started.cleanupWithTools });
      chromeChildren.push({ ...session, started });
    }
    // Observe both windows over the same wall-clock interval so the two
    // snapshots describe one shared DS frame rather than two sequential runs.
    const settledBrowser = await Promise.allSettled(chromeChildren.map((session) => collectBrowserEvidence({
        launch: session.row.launch,
        url: document.spectatorUrl,
        index: session.index,
        port: session.port,
        profileDir: session.profileDir,
        evidence,
        options: {
          ...options,
          env: childEnv,
          assertAlive: () => tools.assertAlive?.(session.started.state),
        },
      })));
    const browserRows = settledBrowser.map((result, index) => {
      if (result.status === 'fulfilled') return result.value;
      return {
        index: index + 1,
        headed: true,
        runtimeReady: false,
        t0: null,
        t5: null,
        canvas: null,
        screenshot: null,
        error: redactScalar(result.reason?.message ?? String(result.reason), secrets),
      };
    });
    document.browser = browserRows;
    const browserFailures = settledBrowser
      .filter((result) => result.status === 'rejected')
      .map((result) => redactScalar(result.reason?.message ?? String(result.reason), secrets));
    if (browserFailures.length > 0) {
      return { status: 'FAIL', error: `browser observation failed: ${browserFailures.join('; ')}` };
    }
    const browserGate = validateBrowserEvidence(browserRows, {
      evidenceDir: evidence,
      spectatorUrl: document.spectatorUrl,
      expectedRoomId: document.roomId,
      expectedDsEndpoint: endpoint,
    });
    document.sharedFrame = browserGate.frame;
    if (!browserGate.ok) return { status: 'FAIL', error: `browser evidence gate failed: ${browserGate.errors.join('; ')}` };

    document.status = 'PASS';
    return document;
  } catch (error) {
    if (error?.code === 'BLOCKED_ENV' || String(error?.message).startsWith('BLOCKED_ENV:')) {
      return { status: 'BLOCKED_ENV', error: String(error.message ?? error) };
    }
    return { status: 'FAIL', error: String(error?.message ?? error) };
  } finally {
    // The hold applies only to a passing run, so the acceptance evidence is
    // complete before anything is intentionally left running.
    const holdingLive = holdRequested && document?.status === 'PASS';
    if (holdingLive) {
      document.holdLive = true;
      document.hold = {
        spectatorUrl: document.spectatorUrl ?? null,
        cdpPorts: [...(options.cdpPorts ?? DEFAULT_CDP_PORTS)],
        dsPid: document.processes?.dsReady?.pid ?? null,
        botHosts: document.processes?.botHostsAfterStart ?? null,
      };
    }
    if (!holdingLive) {
      if (staticServer) await new Promise((resolvePromise) => staticServer.close(() => resolvePromise())).catch(() => {});
      for (const child of children.reverse()) {
        try { await cleanupProcessState(child, tools); } catch { /* teardown is not evidence */ }
      }
      try { await overlay?.restore?.(); } catch { /* restore is best effort after child teardown */ }
      for (const path of cleanupPaths) {
        try { unlinkSync(path); } catch { /* already removed */ }
      }
    }
    redactPersistedSecrets(evidence, secrets);
  }
}

function redactedDocument(document, secrets = []) {
  const copy = structuredClone(document);
  if (copy.tickets) {
    copy.tickets = {
      count: copy.tickets.count,
      unique: copy.tickets.unique,
      hashes: copy.tickets.hashes,
      names: copy.tickets.names,
      accountIds: copy.tickets.accountIds,
      accountCredentials: copy.tickets.accountCredentials,
      manifest: copy.tickets.manifest,
    };
  }
  return redactEvidence(copy, secrets);
}

export function validateLiveDocument(document, { evidenceDir, root } = {}) {
  const errors = [];
  if (document?.status !== 'PASS') errors.push('verification status is not PASS');
  const params = document?.params ?? {};
  if (params.bots !== BOTS || params.spectators !== SPECTATORS || params.tickets !== TOTAL_TICKETS) {
    errors.push('fixed spectator-100 topology evidence is missing');
  }
  if (document?.tickets?.count !== TOTAL_TICKETS || document?.tickets?.unique !== true) {
    errors.push(`ticket gate failed (${document?.tickets?.count ?? 0}/${TOTAL_TICKETS})`);
  }
  const planned = Array.isArray(document?.plannedLogins) ? document.plannedLogins : [];
  if (planned.length !== TOTAL_TICKETS || new Set(planned).size !== TOTAL_TICKETS
      || planned.some((name, index) => name !== (index < BOTS ? `Bot${index + 1}` : `Spectator${index - BOTS + 1}`))) {
    errors.push('planned login evidence is missing or not the fixed topology');
  }
  const ticketHashes = document?.tickets?.hashes;
  if (!Array.isArray(ticketHashes) || ticketHashes.length !== TOTAL_TICKETS
      || ticketHashes.some((hash) => !/^[0-9a-f]{64}$/i.test(String(hash)))
      || new Set(ticketHashes).size !== TOTAL_TICKETS) {
    errors.push('ticket hash evidence is missing or not unique');
  }
  const ticketNames = document?.tickets?.names;
  if (!Array.isArray(ticketNames) || ticketNames.length !== TOTAL_TICKETS
      || !distinctValues(ticketNames.map(identityText))) {
    errors.push('ticket login evidence is missing or not unique');
  }
  const ticketAccountIds = document?.tickets?.accountIds;
  if (!Array.isArray(ticketAccountIds) || ticketAccountIds.length !== TOTAL_TICKETS
      || !distinctValues(ticketAccountIds.map(identityText))) {
    errors.push('ticket account identity evidence is missing or not unique');
  }
  const accountCredentialHashes = document?.tickets?.accountCredentials;
  if (!Array.isArray(accountCredentialHashes) || accountCredentialHashes.length !== TOTAL_TICKETS
      || accountCredentialHashes.some((hash) => !/^[0-9a-f]{64}$/i.test(String(hash)))
      || new Set(accountCredentialHashes).size !== TOTAL_TICKETS) {
    errors.push('account credential hash evidence is missing or not unique');
  }
  const manifestPath = document?.tickets?.manifest ?? document?.evidence?.tickets;
  if (typeof manifestPath !== 'string' || manifestPath.trim() === '' || isAbsolute(manifestPath)) {
    errors.push('ticket manifest evidence path is missing or unsafe');
  } else if (root && !pathWithin(resolve(root), resolve(resolve(root), manifestPath))) {
    errors.push('ticket manifest evidence path is outside the repository');
  }
  const processes = document?.processes ?? {};
  if (processes.liveBotsGuard !== 'LIVE_BOTS=0') errors.push('LIVE_BOTS guard evidence is missing');
  if (processes.preflightBotHosts !== 0) errors.push('preflight Bot.Host census evidence is missing or non-zero');
  if (!Array.isArray(processes.preflightBusyPorts) || processes.preflightBusyPorts.length !== 0) {
    errors.push('preflight port evidence is missing or reports busy ports');
  }
  const preflightShas = processes.preflightShas;
  const documentShas = document?.shas ?? {};
  if (!preflightShas || typeof preflightShas !== 'object'
      || SHA_REPOS.some((name) => preflightShas[name] !== documentShas[name])) {
    errors.push('preflight repository SHA evidence does not match the document');
  }
  if (processes.botHostsStarted !== BOTS) errors.push(`Bot.Host start gate failed (${processes.botHostsStarted ?? 0}/${BOTS})`);
  if (processes.botHostsAfterStart !== BOTS) errors.push(`Bot.Host census gate failed (${processes.botHostsAfterStart ?? 0}/${BOTS})`);
  if (processes.admittedBots !== BOTS) errors.push(`Bot.Host admission gate failed (${processes.admittedBots ?? 0}/${BOTS})`);
  if (processes.rejectedBots !== 0) errors.push(`Bot.Host rejection gate failed (${processes.rejectedBots ?? 0})`);
  if (processes.faultedBots !== 0) errors.push(`Bot.Host fault gate failed (${processes.faultedBots ?? 0})`);
  if (typeof processes.platformStarted !== 'boolean') errors.push('Platform startup evidence is missing');
  if (processes.platformReady !== true) errors.push('Platform readiness evidence is missing');
  if (processes.platformStarted === false && processes.platformAlreadyRunning !== true) {
    errors.push('Platform existing-process evidence is missing');
  }
  const ready = processes.dsReady;
  let readyEndpoint = null;
  if (!ready || typeof ready !== 'object' || !Number.isInteger(ready.pid) || ready.pid < 1) {
    errors.push('DS_READY evidence is missing');
  } else {
    try {
      const parsed = new URL(String(ready.endpoint));
      if (!['ws:', 'wss:'].includes(parsed.protocol) || !LOOPBACK_HOSTS.has(parsed.hostname)
          || parsed.username || parsed.password || parsed.search || parsed.hash) {
        errors.push('DS_READY endpoint evidence is invalid');
      } else {
        readyEndpoint = parsed.href;
      }
    } catch {
      errors.push('DS_READY endpoint evidence is invalid');
    }
  }
  const spectatorRows = Array.isArray(document?.spectators) ? document.spectators : [];
  if (spectatorRows.length !== SPECTATORS) errors.push(`spectator ticket evidence is incomplete (${spectatorRows.length}/${SPECTATORS})`);
  const spectatorNames = spectatorRows.map((row) => identityText(row?.loginName));
  if (!distinctValues(spectatorNames)) errors.push('spectator login evidence is not unique');
  const spectatorAccountIds = spectatorRows.map((row) => identityText(row?.accountId));
  if (!distinctValues(spectatorAccountIds)) errors.push('spectator account identity evidence is missing or not unique');
  const spectatorTicketHashes = spectatorRows.map((row) => row?.ticket?.sha256 ?? row?.ticketHash ?? null);
  if (spectatorTicketHashes.length !== SPECTATORS
      || spectatorTicketHashes.some((hash) => !/^[0-9a-f]{64}$/i.test(String(hash)))
      || new Set(spectatorTicketHashes).size !== SPECTATORS) {
    errors.push('spectator ticket hash evidence is missing or not unique');
  }
  const spectatorRooms = spectatorRows.map((row) => identityText(row?.roomId)).filter(Boolean);
  if (spectatorRooms.length !== spectatorRows.length || spectatorRooms.length === 0
      || new Set(spectatorRooms).size !== 1) {
    errors.push('spectator room evidence is missing or split');
  }
  if (document?.roomId == null || String(document.roomId).trim() === ''
      || (spectatorRooms.length > 0 && spectatorRooms.some((room) => room !== String(document.roomId)))) {
    errors.push('document room identity does not match spectator evidence');
  }
  if (readyEndpoint) {
    const browserEndpoints = (document?.browser ?? document?.browsers ?? [])
      .flatMap((row) => [row?.launch?.wsUrl])
      .filter((value) => typeof value === 'string' && value.trim() !== '');
    if (browserEndpoints.length > 0
        && browserEndpoints.some((value) => !dsEndpointAuthorityMatches(readyEndpoint, value))) {
      errors.push('browser launch endpoint does not match DS_READY');
    }
  }
  if (ready?.roomId != null && document?.roomId != null
      && String(ready.roomId) !== String(document.roomId)) {
    errors.push('DS_READY room identity does not match ticket evidence');
  }
  try {
    assertNoCredentialInUrl(document?.spectatorUrl);
  } catch {
    errors.push('spectator URL evidence is invalid');
  }
  const shas = document?.shas ?? {};
  for (const name of SHA_REPOS) {
    if (!/^[0-9a-f]{40}$/i.test(String(shas[name] ?? ''))) errors.push(`missing repository SHA for ${name}`);
  }
  const browser = validateBrowserEvidence(document?.browser ?? document?.browsers ?? [], {
    evidenceDir,
    spectatorUrl: document?.spectatorUrl,
    expectedRoomId: document?.roomId,
    expectedDsEndpoint: readyEndpoint,
  });
  if (!browser.ok) errors.push(...browser.errors);
  // The shared-frame value is part of the acceptance claim, not optional
  // decoration.  A document that omits it could otherwise pass while the two
  // browser rows describe different world snapshots.
  if (document?.sharedFrame == null || document.sharedFrame !== browser.frame) {
    errors.push('document sharedFrame is missing or does not match browser evidence');
  }
  return { ok: errors.length === 0, errors, browser };
}

export async function runSpectator100(options = {}) {
  const env = options.env ?? process.env;
  const root = resolve(options.root ?? ROOT);
  let evidence;
  if (options.evidenceDir) {
    evidence = resolve(options.evidenceDir);
  } else {
    const evidenceRoot = join(root, '.run');
    mkdirSync(evidenceRoot, { recursive: true });
    evidence = resolve(mkdtempSync(join(evidenceRoot, 'spectator-100-')));
  }
  mkdirSync(evidence, { recursive: true });
  const counts = assertAcceptanceCounts({ bots: options.bots ?? BOTS, spectators: options.spectators ?? SPECTATORS });
  const collect = options.collectRepoShas ?? collectRepoShas;
  const initialShas = options.shas ?? await collect(root);
  const document = createSpectatorDocument({ shas: initialShas, ...counts });
  const explicitSpectatorUrl = resolveExplicitSpectatorUrl({ options, env });
  if (explicitSpectatorUrl != null) {
    document.spectatorUrl = assertNoCredentialInUrl(explicitSpectatorUrl);
  }

  const prerequisiteEnv = {
    ...env,
    LUMIO_PLATFORM_ORIGIN: options.origin ?? env.LUMIO_PLATFORM_ORIGIN,
    LUMIO_DS_EXE: options.dsExe ?? env.LUMIO_DS_EXE,
    LUMIO_DS_CONFIG: options.dsConfig ?? env.LUMIO_DS_CONFIG,
    LUMIO_BOT_DLL: options.botDll ?? env.LUMIO_BOT_DLL,
    LUMIO_GAMEPLAY: options.gameplay ?? env.LUMIO_GAMEPLAY,
    LUMIO_ENGINE_NATIVE: options.engineNative ?? env.LUMIO_ENGINE_NATIVE,
    LUMIO_ENGINE_NATIVE_PATH: options.engineNative ?? env.LUMIO_ENGINE_NATIVE_PATH,
    LUMIO_CHROME: options.chrome ?? env.LUMIO_CHROME,
  };
  const missing = options.missingReason ?? missingLiveReason(prerequisiteEnv);
  if (missing) {
    document.status = 'BLOCKED_ENV';
    document.error = `BLOCKED_ENV: ${missing}`;
    writeJson(join(evidence, 'verification.json'), redactedDocument(document));
    return document;
  }

  try {
    if (typeof options.liveRun === 'function') {
      assertLiveAuthorization({ env, options });
      const result = await options.liveRun({ env, root, evidence, document });
      Object.assign(document, result ?? {});
    } else if (options.attachLive === true) {
      assertLiveAuthorization({ env, options });
      Object.assign(document, await runLiveTopology({ env, root, evidence, document, options }));
    } else {
      document.status = 'BLOCKED_ENV';
      document.error = 'BLOCKED_ENV: live topology runner is not attached in this process.';
    }
    if (document.status === 'PASS') {
      const gate = validateLiveDocument(document, { evidenceDir: evidence, root });
      if (!gate.ok) {
        document.status = 'FAIL';
        document.error = `live evidence gate failed: ${gate.errors.join('; ')}`;
      }
    }
  } catch (error) {
    document.status = error?.code === 'BLOCKED_ENV' || String(error?.message).startsWith('BLOCKED_ENV:')
      ? 'BLOCKED_ENV'
      : 'FAIL';
    document.error = String(error?.message ?? error);
  }

  writeJson(join(evidence, 'verification.json'), redactedDocument(document, options.secrets ?? []));
  return document;
}

export function usage() {
  return [
    'Usage: node integration/spectator-100.mjs --bots 100 [--authorize-live] [--start-platform] [options]',
    `Fixed topology: ${BOTS} Bot.Host processes + ${SPECTATORS} headed Chrome spectators = ${TOTAL_TICKETS} tickets.`,
    '--bots 100 is mandatory; another bot count is rejected rather than resized silently.',
    '--authorize-live is required together with attachLive, LIVE_BOTS=0, and LUMIO_WAVE_B_LIVE=1.',
    '--start-platform opts into docker compose startup; without it Platform must already be running.',
    'Admission credentials are injected through CDP in memory and never enter URLs or verification.json.',
  ].join('\n');
}

/** Parse the Wave B-only flags without changing the legacy launcher parser. */
export function parseSpectatorCliArgs(argv = process.argv.slice(2), environment = process.env) {
  const forwarded = [];
  let authorizeLive = false;
  let startPlatform = false;
  let botsExplicit = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = String(argv[index]);
    if (flag === '--authorize-live') {
      authorizeLive = true;
      continue;
    }
    if (flag === '--start-platform') {
      startPlatform = true;
      continue;
    }
    if (flag === '--bots') botsExplicit = true;
    forwarded.push(argv[index]);
  }
  const parsed = parseLaunchArgs(forwarded, environment);
  if (parsed.help) return { ...parsed, authorizeLive, startPlatform, botsExplicit };
  if (!botsExplicit) {
    const error = new Error(`spectator-100 requires an explicit --bots ${BOTS}.`);
    error.code = 'USAGE';
    throw error;
  }
  if (parsed.bots !== BOTS) {
    const error = new Error(`spectator-100 requires exactly --bots ${BOTS} (received ${parsed.bots}).`);
    error.code = 'USAGE';
    throw error;
  }
  return {
    ...parsed,
    bots: BOTS,
    spectators: SPECTATORS,
    authorizeLive,
    // The CLI is the attached runner.  The separate authorization flag keeps
    // process creation opt-in even when a caller has supplied live paths.
    attachLive: true,
    startPlatform,
    // parseLaunchArgs populates composeFile from the environment.  Only a
    // command-line --compose or --start-platform should authorize startup.
    composeFileExplicit: startPlatform || forwarded.includes('--compose'),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    const parsed = parseSpectatorCliArgs(process.argv.slice(2), process.env);
    if (parsed.help) {
      process.stdout.write(`${usage()}\n`);
    } else {
      const document = await runSpectator100({
        ...parsed,
      });
      process.stdout.write(`VERIFICATION_STATUS=${document.status}\n`);
      process.exitCode = spectator100ExitCode(document.status);
    }
  } catch (error) {
    process.stderr.write(`${error?.message ?? error}\n`);
    process.exitCode = error?.code === 'BLOCKED_ENV' || String(error?.message).startsWith('BLOCKED_ENV:') ? 2 : 1;
  }
}

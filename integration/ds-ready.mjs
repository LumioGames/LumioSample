const READY_PREFIX = 'DS_READY ';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

export function parseDsReadyLine(line) {
  if (typeof line !== 'string' || !line.startsWith(READY_PREFIX)) return null;
  let value;
  try { value = JSON.parse(line.slice(READY_PREFIX.length)); }
  catch (error) { throw new Error(`DS_READY contains invalid JSON: ${error.message}`); }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('DS_READY payload must be a JSON object.');
  }
  if (!Number.isInteger(value.pid) || value.pid < 1) throw new Error('DS_READY must include a positive integer pid.');
  if (typeof value.endpoint !== 'string') throw new Error('DS_READY must include an endpoint URL.');
  let endpoint;
  try { endpoint = new URL(value.endpoint); }
  catch (error) { throw new Error(`DS_READY endpoint is invalid: ${error.message}`); }
  if (!['ws:', 'wss:'].includes(endpoint.protocol)) throw new Error('DS_READY endpoint must use ws:// or wss://.');
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('DS_READY endpoint must not contain credentials or routing hints.');
  }
  const port = Number(endpoint.port || (endpoint.protocol === 'wss:' ? 443 : 80));
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('DS_READY endpoint must include a valid port.');
  return { ...value, endpoint: endpoint.href, port };
}

export function findDsReady(stdout) {
  for (const line of String(stdout ?? '').split(/\r?\n/)) {
    const value = parseDsReadyLine(line);
    if (value) return value;
  }
  return null;
}

export function resolveDsEndpoint(ready, configuredEndpoint = undefined) {
  if (!ready || typeof ready !== 'object') throw new TypeError('DS_READY result is required.');
  let endpoint;
  try { endpoint = new URL(configuredEndpoint ?? ready.endpoint); }
  catch (error) { throw new Error(`DS endpoint is invalid: ${error.message}`); }
  if (!['ws:', 'wss:'].includes(endpoint.protocol)) throw new Error('DS endpoint must use ws:// or wss://.');
  if (!LOOPBACK_HOSTS.has(endpoint.hostname)) throw new Error('Launcher only accepts a loopback DS endpoint.');
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new Error('DS endpoint must not contain credentials or routing hints.');
  }
  const port = Number(endpoint.port || (endpoint.protocol === 'wss:' ? 443 : 80));
  if (port !== ready.port) throw new Error(`DS endpoint port ${port} does not match DS_READY port ${ready.port}.`);
  return endpoint.href;
}

export function buildServerArgs(configPath) {
  return ['--config', configPath];
}

export function buildBotArgs({ botDll, endpoint, admissionTicket, engineNative, logDir, accountFrom, accountTo }) {
  return [
    botDll,
    '--server', endpoint,
    '--admission-ticket', admissionTicket,
    '--engine-native', engineNative,
    '--log-dir', logDir,
    '--account-from', accountFrom,
    '--account-to', accountTo ?? accountFrom,
  ];
}

export function redactArgs(args, secret) {
  return args.map((value) => (secret && value === secret ? '<redacted>' : value));
}

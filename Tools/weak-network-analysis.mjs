import { percentile } from './stress-move.mjs';

export const PROFILES = Object.freeze({
  A: { delay: 0, jitter: 0, loss: 0 },
  B: { delay: 50, jitter: 10, loss: 1 },
  C: { delay: 100, jitter: 20, loss: 3 },
  D: { delay: 150, jitter: 30, loss: 5 },
  cutover: { delay: 0, jitter: 0, loss: 0 },
});

export function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { cell += '"'; i++; }
      else quoted = !quoted;
    } else if (!quoted && (c === ',' || c === '\n')) {
      row.push(cell.replace(/\r$/, '')); cell = '';
      if (c === '\n') { rows.push(row); row = []; }
    } else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  const header = rows.shift() ?? [];
  return rows.filter((values) => values.length === header.length)
    .map((values) => Object.fromEntries(header.map((key, i) => [key, values[i]])));
}

export function csv(rows, fields) {
  const escape = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`;
  return `${fields.join(',')}\n${rows.map((row) => fields.map((field) => escape(row[field])).join(',')).join('\n')}\n`;
}

export function distribution(values) {
  return { samples: values.length, p50: percentile(values, 50), p95: percentile(values, 95),
    p99: percentile(values, 99), max: values.length ? Math.max(...values) : null };
}

const key = (row) => `${row.account}/${row.generation}/${row.sequence}`;

export function analyzeProfile({ profile, rows, startMs, endMs, accounts, cutover = null }) {
  if (!PROFILES[profile] || !Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs - startMs < 180_000 || accounts.length !== 100 || new Set(accounts).size !== 100)
    throw new Error('A qualified profile requires 100 accounts and at least 180 seconds.');
  if (profile === 'cutover' && (!cutover || cutover.connections.length !== 10
      || new Set(cutover.connections.map((c) => c.account)).size !== 10
      || new Set(cutover.connections.map((c) => c.client_port)).size !== 10
      || !cutover.connections.every((c) => accounts.includes(c.account))
      || !Number.isFinite(cutover.allDroppedMs) || !Number.isFinite(cutover.restoredMs)
      || cutover.allDroppedMs < startMs || cutover.restoredMs > endMs
      || cutover.restoredMs - cutover.allDroppedMs < 5000))
    throw new Error('Cutover requires ten distinct measured connections dropped together for at least five seconds and restored inside the window.');
  const rtt = 2 * PROFILES[profile].delay;
  const sent = new Map(rows.filter((r) => r.metric === 'input.sent' && +r.unix_ms >= startMs && +r.unix_ms < endMs).map((r) => [key(r), r]));
  const confirmations = new Map();
  for (const row of rows) {
    if (row.metric !== 'input.confirmed' || !sent.has(key(row)) || confirmations.has(key(row))) continue;
    if (!Number.isFinite(+row.value) || +row.value < 0 || +row.unix_ms < +sent.get(key(row)).unix_ms || BigInt(row.applied_sequence) < BigInt(row.sequence))
      throw new Error('Invalid confirmation chronology or cumulative sequence.');
    confirmations.set(key(row), row);
  }
  const perBot = [], stalls = [], activity = [];
  for (const account of accounts) {
    const own = rows.filter((row) => row.account === account);
    const ownSent = [...sent.values()].filter((r) => r.account === account).map((r) => +r.unix_ms).sort((a, b) => a - b);
    const ownConfirmed = [...confirmations.values()].filter((r) => r.account === account);
    const rejected = own.filter((r) => r.metric === 'input.rejected' && +r.unix_ms >= startMs && +r.unix_ms < endMs).map((r) => +r.unix_ms);
    const states = own.filter((r) => r.metric === 'session.state').sort((a, b) => +a.unix_ms - +b.unix_ms);
    const updates = own.filter((r) => r.metric === 'server.update' && +r.unix_ms >= startMs && +r.unix_ms <= endMs)
      .map((r) => +r.unix_ms).sort((a, b) => a - b);
    const boundaries = [startMs, ...updates, endMs];
    let count = 0, totalMs = 0;
    for (let i = 1; i < boundaries.length; i++) {
      const gap = boundaries[i] - boundaries[i - 1];
      if (gap <= 250) continue;
      count++; totalMs += gap - 250;
      stalls.push({ account, from_ms: boundaries[i - 1], to_ms: boundaries[i], gap_ms: gap,
        stalled_ms: gap - 250, right_censored: i === boundaries.length - 1 });
    }
    const buckets = [];
    for (let from = startMs; from < endMs; from += 10_000) {
      const to = Math.min(from + 10_000, endMs);
      const inBucket = (time) => time >= from && time < to;
      let state = states.filter((r) => +r.unix_ms <= from).at(-1)?.state ?? 'unknown';
      let cursor = from, nonActiveMs = 0;
      for (const row of states.filter((r) => +r.unix_ms > from && +r.unix_ms < to)) {
        if (state !== 'Active') nonActiveMs += +row.unix_ms - cursor;
        cursor = +row.unix_ms; state = row.state;
      }
      if (state !== 'Active') nonActiveMs += to - cursor;
      const accepted = ownSent.filter(inBucket).length, denied = rejected.filter(inBucket).length;
      buckets.push({ account, from_ms: from, to_ms: to, sent: accepted, rejected: denied,
        confirmed: ownConfirmed.filter((r) => inBucket(+r.unix_ms)).length, updates: updates.filter(inBucket).length,
        non_active_ms: nonActiveMs, unexplained_silence: accepted + denied === 0 && nonActiveMs === 0 });
    }
    activity.push(...buckets);
    const botSent = ownSent.length;
    const delays = ownConfirmed.map((r) => +r.value);
    perBot.push({ account, sent: botSent, confirmed: delays.length, unconfirmed: botSent - delays.length,
      rejected: rejected.length, first_send_ms: ownSent[0] ?? null, last_send_ms: ownSent.at(-1) ?? null,
      send_span_ms: ownSent.length ? ownSent.at(-1) - ownSent[0] : 0,
      unexplained_silent_buckets: buckets.filter((b) => b.unexplained_silence).length,
      network_unavailable_ms: buckets.reduce((n, b) => n + b.non_active_ms, 0),
      updates: updates.length, stalls: count, stalls_per_minute: count / ((endMs - startMs) / 60_000),
      stalled_ms: totalMs,
      disconnects: own.filter((r) => r.metric === 'connection.closed' && +r.unix_ms >= startMs && +r.unix_ms < endMs).length,
      ...Object.fromEntries(Object.entries(distribution(delays)).map(([name, value]) => [`input_${name}`, value])) });
  }
  const delays = [...confirmations.values()].map((r) => +r.value);
  const recovery = (cutover?.connections ?? []).map((connection) => {
    const own = rows.filter((r) => r.account === connection.account).sort((a, b) => +a.unix_ms - +b.unix_ms);
    const states = own.filter((r) => r.metric === 'session.state');
    const atDrop = states.filter((r) => +r.unix_ms <= cutover.allDroppedMs).at(-1);
    const leftActive = states.find((r) => r.state !== 'Active' && +r.unix_ms > cutover.allDroppedMs && +r.unix_ms <= endMs);
    const remained = atDrop?.state === 'Active' && !leftActive;
    const active = remained ? atDrop : states.find((r) => r.state === 'Active' && leftActive && +r.unix_ms >= +leftActive.unix_ms && +r.unix_ms <= endMs);
    const update = own.find((r) => r.metric === 'server.update' && +r.unix_ms >= cutover.restoredMs);
    return { ...connection, remained_active: remained,
      active_ms: !remained && active ? Math.max(0, +active.unix_ms - cutover.restoredMs) : null,
      recovered_before_restore: !remained && !!active && +active.unix_ms < cutover.restoredMs,
      first_update_ms: update ? +update.unix_ms - cutover.restoredMs : null,
      reconnected_within_10s: !remained && !!active && +active.unix_ms - cutover.restoredMs <= 10_000,
      update_within_10s: !!update && +update.unix_ms - cutover.restoredMs <= 10_000 };
  });
  return { profile, startMs, endMs, durationSeconds: (endMs - startMs) / 1000, accounts: accounts.length,
    sent: sent.size, confirmed: confirmations.size, unconfirmed: sent.size - confirmations.size,
    input: distribution(delays), adjusted: distribution(delays.map((delay) => delay - rtt)), nominalInjectedRttMs: rtt,
    status: perBot.every((bot) => bot.sent > 0 && bot.confirmed > 0 && bot.updates > 0 && bot.unexplained_silent_buckets === 0) ? 'MEASURED' : 'INCOMPLETE',
    disconnects: perBot.reduce((n, bot) => n + bot.disconnects, 0), perBot, activity, stalls, recovery };
}

export function selectCutConnections(ss, processes, accountByPid, port) {
  const selected = processes.map((pid) => {
    const matches = ss.split('\n').filter((line) => line.includes(`pid=${pid},`))
      .map((line) => line.trim().split(/\s+/)).filter((fields) => fields[3] === `127.0.0.1:${port}`);
    if (matches.length !== 1 || !accountByPid[pid]) throw new Error(`Expected exactly one measured DS connection for pid ${pid}.`);
    const clientPort = Number(matches[0][2].split(':').at(-1));
    return { pid, account: accountByPid[pid], client_port: clientPort, ds_port: port };
  });
  if (selected.length !== 10 || new Set(selected.map((c) => c.client_port)).size !== 10)
    throw new Error('Cutover must target exactly ten distinct connections.');
  return selected;
}

export function cutPacketCounts(iptablesSave, connections) {
  return connections.map((connection) => {
    const count = (source, destination) => {
      const line = iptablesSave.split('\n').find((row) => row.includes('lumio-weaknet')
        && row.includes(`--sport ${source} `) && row.includes(`--dport ${destination} `));
      return Number(/^\[(\d+):\d+\]/.exec(line ?? '')?.[1] ?? 0);
    };
    return { account: connection.account, to_server: count(connection.client_port, connection.ds_port),
      to_bot: count(connection.ds_port, connection.client_port) };
  });
}

export function summarizeNagle(rows, port) {
  const sockets = new Map();
  for (const row of rows) {
    const endpoint = +row.local_port === port ? 'server' : +row.remote_port === port ? 'bot' : null;
    if (endpoint) sockets.set(`${row.pid}/${row.fd}`, { endpoint, enabled: row.tcp_nodelay === '1' });
  }
  return Object.fromEntries(['server', 'bot'].map((endpoint) => {
    const values = [...sockets.values()].filter((s) => s.endpoint === endpoint);
    return [endpoint, { sockets: values.length, tcpNoDelayTrue: values.filter((s) => s.enabled).length,
      tcpNoDelayFalse: values.filter((s) => !s.enabled).length }];
  }));
}

export function completeTickDurations(rows, minTick, maxTick) {
  const ticks = new Map();
  for (const row of rows) {
    const tick = Number(row.tick_id);
    if (tick < minTick || tick > maxTick || !Number.isFinite(tick)) continue;
    let phases = ticks.get(tick);
    if (!phases) { phases = new Map(); ticks.set(tick, phases); }
    const value = row.elapsed_nanos === '' ? NaN : Number(row.elapsed_nanos);
    phases.set(row.phase, phases.has(row.phase) ? NaN : value);
  }
  return new Map([...ticks].filter(([, phases]) => phases.size === 13 && [...phases.values()].every((ns) => Number.isFinite(ns) && ns >= 0))
    .map(([tick, phases]) => [tick, [...phases.values()].reduce((sum, ns) => sum + ns / 1e6, 0)]));
}

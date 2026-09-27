import assert from 'node:assert/strict';
import { test } from 'node:test';
import { analyzeProfile, completeTickDurations, csv, cutPacketCounts, parseCsv, selectCutConnections, summarizeNagle } from './weak-network-analysis.mjs';

const accounts = Array.from({ length: 100 }, (_, i) => `sample${i + 1}`);
const base = { profile: 'C', accounts, startMs: 1000, endMs: 181000 };
const event = (metric, unix_ms, extra = {}) => ({ metric, unix_ms, account: accounts[0], generation: '1', sequence: '1', ...extra });

test('only matching generation+input confirmations contribute, including late acks and loss denominator', () => {
  const result = analyzeProfile({ ...base, rows: [
    event('input.sent', 1200), event('input.sent', 180900, { sequence: '2' }),
    event('input.sent', 5000, { sequence: '3' }),
    event('input.confirmed', 2000, { applied_sequence: '1', value: 800 }),
    event('input.confirmed', 2010, { applied_sequence: '1', value: 810 }),
    event('input.confirmed', 181900, { sequence: '2', applied_sequence: '2', value: 1000 }),
    event('input.confirmed', 6000, { generation: '2', sequence: '3', applied_sequence: '3', value: 1 }),
  ] });
  assert.equal(result.sent, 3);
  assert.equal(result.confirmed, 2);
  assert.equal(result.unconfirmed, 1);
  assert.equal(result.input.p99, 1000);
  assert.equal(result.adjusted.p99, 800);
  assert.equal(result.status, 'INCOMPLETE');
});

test('a gap creates one stall and preserves the right-censored silence at the window end', () => {
  const result = analyzeProfile({ ...base, rows: [event('server.update', 1250), event('server.update', 2000)] });
  const stalls = result.stalls.filter((r) => r.account === accounts[0]);
  assert.deepEqual(stalls.map((r) => r.gap_ms), [750, 179000]);
  assert.equal(stalls[1].right_censored, true);
  assert.equal(result.perBot[0].stalls_per_minute, 2 / 3);
  assert.equal(result.perBot[0].stalled_ms, 179250);
});

test('stayed Active differs from a measured reconnect and recovery time starts at network restore', () => {
  const connections = accounts.slice(0, 10).map((account, i) => ({ account, client_port: 31000 + i }));
  const result = analyzeProfile({ ...base, profile: 'cutover', cutover: { allDroppedMs: 61000, restoredMs: 66000, connections }, rows: [
    event('session.state', 100, { state: 'Active' }),
    event('session.state', 100, { account: accounts[1], state: 'Active' }),
    event('session.state', 63000, { account: accounts[1], state: 'Reconnecting' }),
    event('session.state', 73500, { account: accounts[1], state: 'Active' }),
    event('server.update', 66200),
  ] });
  assert.equal(result.recovery[0].remained_active, true);
  assert.equal(result.recovery[0].active_ms, null);
  assert.equal(result.recovery[0].reconnected_within_10s, false);
  assert.equal(result.recovery[0].first_update_ms, 200);
  assert.equal(result.recovery[1].remained_active, false);
  assert.equal(result.recovery[1].active_ms, 7500);
});

test('cutover refuses missing or partial drop/restore evidence', () => {
  assert.throws(() => analyzeProfile({ ...base, profile: 'cutover', rows: [] }), /ten distinct/);
  assert.throws(() => analyzeProfile({ ...base, profile: 'cutover', rows: [],
    cutover: { allDroppedMs: 61000, restoredMs: 66000, connections: [{ account: accounts[0] }] } }), /ten distinct/);
});

test('a reconnect before restoration is distinguished from staying Active', () => {
  const connections = accounts.slice(0, 10).map((account, i) => ({ account, client_port: 31000 + i }));
  const result = analyzeProfile({ ...base, profile: 'cutover', cutover: { allDroppedMs: 61000, restoredMs: 66000, connections }, rows: [
    event('session.state', 100, { state: 'Active' }),
    event('session.state', 63000, { state: 'Reconnecting' }),
    event('session.state', 64000, { state: 'Active' }),
  ] });
  assert.equal(result.recovery[0].remained_active, false);
  assert.equal(result.recovery[0].active_ms, 0);
  assert.equal(result.recovery[0].recovered_before_restore, true);
});

test('a short run and a future/foreign cumulative confirmation are refused', () => {
  assert.throws(() => analyzeProfile({ ...base, endMs: 2000, rows: [] }), /180 seconds/);
  assert.throws(() => analyzeProfile({ ...base, rows: [event('input.sent', 1300), event('input.confirmed', 1400, { value: 100, applied_sequence: '0' })] }), /Invalid confirmation/);
});

test('activity buckets reject a silent Active bot while preserving real disconnected and rejected-send periods', () => {
  const rows = [event('session.state', 100, { state: 'Active' }), event('input.sent', 1200),
    event('input.confirmed', 1300, { value: 100, applied_sequence: '1' }), event('server.update', 1300)];
  const silent = analyzeProfile({ ...base, rows });
  assert.equal(silent.perBot[0].send_span_ms, 0);
  assert.equal(silent.perBot[0].unexplained_silent_buckets, 17);
  const disconnected = analyzeProfile({ ...base, rows: [...rows, event('session.state', 2000, { state: 'Reconnecting' })] });
  assert.equal(disconnected.perBot[0].unexplained_silent_buckets, 0);
  assert.equal(disconnected.perBot[0].network_unavailable_ms, 179000);
  const rejected = analyzeProfile({ ...base, rows: [...rows,
    ...Array.from({ length: 17 }, (_, i) => event('input.rejected', 12000 + i * 10000))] });
  assert.equal(rejected.perBot[0].unexplained_silent_buckets, 0);
  assert.equal(rejected.perBot[0].rejected, 17);
});

test('cutover selection requires ten exact DS tuples and refuses a PID with multiple DS sockets', () => {
  const processes = Array.from({ length: 10 }, (_, i) => i + 100);
  const mapping = Object.fromEntries(processes.map((pid) => [pid, `sample${pid}`]));
  const lines = processes.map((pid) => `0 0 127.0.0.1:${pid + 10000} 127.0.0.1:9110 users:(("dotnet",pid=${pid},fd=42))`);
  lines.push('0 0 127.0.0.1:55555 127.0.0.1:8080 users:(("dotnet",pid=100,fd=43))');
  assert.equal(selectCutConnections(lines.join('\n'), processes, mapping, 9110).length, 10);
  assert.throws(() => selectCutConnections([...lines, lines[0]].join('\n'), processes, mapping, 9110), /exactly one/);
});

test('CSV preserves empty values and escaped cells', () => {
  const rows = [{ a: 'hello,"world"', b: '', c: 42 }];
  assert.deepEqual(parseCsv(csv(rows, ['a', 'b', 'c'])), [{ ...rows[0], c: '42' }]);
});

test('cut counters prove dropped packets in both exact directions', () => {
  const connections = [{ account: 'sample1', client_port: 31000, ds_port: 9110 }];
  const evidence = '[12:600] -A OUTPUT --sport 31000 --dport 9110 -m comment --comment lumio-weaknet -j DROP\n[15:900] -A OUTPUT --sport 9110 --dport 31000 -m comment --comment lumio-weaknet -j DROP\n';
  assert.deepEqual(cutPacketCounts(evidence, connections), [{ account: 'sample1', to_server: 12, to_bot: 15 }]);
  assert.equal(cutPacketCounts('', connections)[0].to_server, 0);
});

test('tick p99 input excludes missing, duplicate and blank phase samples', () => {
  const complete = Array.from({ length: 13 }, (_, i) => ({ tick_id: '100', phase: String(i), elapsed_nanos: '1000000' }));
  assert.equal(completeTickDurations(complete, 100, 100).get(100), 13);
  assert.equal(completeTickDurations(complete.slice(1), 100, 100).size, 0);
  assert.equal(completeTickDurations([...complete, complete[0]], 100, 100).size, 0);
  assert.equal(completeTickDurations(complete.map((r, i) => i === 1 ? { ...r, elapsed_nanos: '' } : r), 100, 100).size, 0);
});

test('socket audit reads both endpoints and excludes Platform sockets', () => {
  const rows = parseCsv('unix_ms,pid,fd,phase,local_port,remote_port,tcp_nodelay\n1,1,10,accept,9110,31000,0\n1,2,11,connect,31000,9110,1\n2,1,10,setsockopt,9110,31000,1\n2,2,12,connect,31001,8080,0\n');
  assert.deepEqual(summarizeNagle(rows, 9110), {
    server: { sockets: 1, tcpNoDelayTrue: 1, tcpNoDelayFalse: 0 },
    bot: { sockets: 1, tcpNoDelayTrue: 1, tcpNoDelayFalse: 0 },
  });
});

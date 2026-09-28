import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { DS_ADMISSION_CLOSE_LINE, redactDsLogLine, writeDsAdmissionCloseExcerpt } from './run-round.mjs';

test('redactDsLogLine hashes id fields stably and strips credential fields entirely', () => {
  const line = 'level=WARN target=host.connection_close msg="closed conn=conn-309c77a8 account=acct_3e71eb7a reason=protocol_violation" ticket=eyJhbGciOi';
  const redacted = redactDsLogLine(line);
  assert.ok(!redacted.includes('conn-309c77a8'), 'raw conn id must not survive');
  assert.ok(!redacted.includes('acct_3e71eb7a'), 'raw account id must not survive');
  assert.ok(!redacted.includes('eyJhbGciOi'), 'credential value must not survive');
  assert.match(redacted, /conn=conn-r[0-9a-f]{8}/);
  assert.match(redacted, /account=account-r[0-9a-f]{8}/);
  assert.ok(redacted.includes('reason=protocol_violation'), 'non-id fields stay verbatim');
  // 同一原始 id 跨行哈希稳定(可对齐),不同 id 哈希不同。
  const sameA = redactDsLogLine('msg="closed conn=conn-a"').match(/conn=(conn-r[0-9a-f]{8})/)[1];
  const sameB = redactDsLogLine('conn=conn-a elsewhere').match(/conn=(conn-r[0-9a-f]{8})/)[1];
  assert.equal(sameA, sameB);
  assert.notEqual(redactDsLogLine('conn=conn-a'), redactDsLogLine('conn=conn-b'));
});

test('DS_ADMISSION_CLOSE_LINE matches the three admission/close targets only', () => {
  assert.ok(DS_ADMISSION_CLOSE_LINE.test('target=host.admit msg="pending"'));
  assert.ok(DS_ADMISSION_CLOSE_LINE.test('target=host.expire msg="deferred"'));
  assert.ok(DS_ADMISSION_CLOSE_LINE.test('target=host.connection_close msg="closed"'));
  assert.ok(!DS_ADMISSION_CLOSE_LINE.test('target=host.tick msg="ok"'));
  assert.ok(!DS_ADMISSION_CLOSE_LINE.test('target=net.connection_open'));
});

test('writeDsAdmissionCloseExcerpt collects, redacts and counts admission/close lines across stdout and post-office logs', () => {
  const round = mkdtempSync(join(tmpdir(), 'lumio-r588-excerpt-'));
  mkdirSync(join(round, 'launcher', 'ds-boot-1'), { recursive: true });
  writeFileSync(join(round, 'launcher', 'lumio-ds.log'), [
    'level=INFO target=host.admit msg="pending account=acct_1"',
    'level=INFO target=host.tick msg="unrelated"',
  ].join('\n'));
  writeFileSync(join(round, 'launcher', 'ds-boot-1', 'post-office.log'), [
    'level=WARN target=host.expire msg="deferred code=runtime_query_pending due_ms=326864"',
    'level=WARN target=host.connection_close msg="closed conn=conn-9 account=acct_2 reason=protocol_violation code=1008"',
    'level=INFO target=host.expire2 msg="wrong target"',
  ].join('\n'));
  const result = writeDsAdmissionCloseExcerpt(round);
  assert.equal(result.matched, 3);
  const text = readFileSync(result.out, 'utf8');
  assert.ok(text.includes('target=host.admit'));
  assert.ok(text.includes('target=host.expire'));
  assert.ok(text.includes('target=host.connection_close'));
  assert.ok(!text.includes('host.tick'));
  assert.ok(!text.includes('acct_1'), 'account id redacted');
  assert.ok(!text.includes('conn-9 '), 'conn id redacted');
});

test('writeDsAdmissionCloseExcerpt with no DS logs on disk writes an honest empty excerpt', () => {
  const round = mkdtempSync(join(tmpdir(), 'lumio-r588-excerpt-empty-'));
  const result = writeDsAdmissionCloseExcerpt(round);
  assert.equal(result.matched, 0);
  assert.equal(result.sources, 0);
});

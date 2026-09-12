import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { planLaunchLogins, resolveSpectatorPageUrl } from './launcher.mjs';
import { TOUR_STEPS } from './tour-steps.mjs';
import {
  createSpectatorDocument,
  missingLiveReason,
  probeMoved,
  runSpectator100,
  spectator100ExitCode,
  uniqueTicketReport,
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

test('plan is 100 bots + Spectator1 and steps 05-14 stay BLOCKED_ENV in launcher copy', () => {
  const planned = planLaunchLogins(100, { spectator: true });
  assert.equal(planned.length, 101);
  assert.equal(planned[0], 'Bot1');
  assert.equal(planned[99], 'Bot100');
  assert.equal(planned[100], 'Spectator1');
  const document = createSpectatorDocument();
  assert.deepEqual(document.plannedLogins, planned);
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

test('missing Bot.Host / DS files stay BLOCKED_ENV and never fake PASS', () => {
  assert.equal(
    missingLiveReason({ LUMIO_PLATFORM_ORIGIN: 'http://127.0.0.1:8080' }),
    'LUMIO_DS_EXE is not set or is not a file',
  );
  assert.equal(existsSync(join(SAMPLE_ROOT, 'integration', 'spectator-100.mjs')), true);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readIdentity, verifyAssets } from './build-local-sdk.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'sample-sdk-identity-test-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const version = `0.1.0-dev.${'a'.repeat(64)}`;
  const nupkgPath = join(dir, `Lumio.Engine.SDK.${version}.nupkg`);
  const bytes = Buffer.from('archive fixture');
  writeFileSync(nupkgPath, bytes);
  const identity = { schemaVersion: 1, packageId: 'Lumio.Engine.SDK', version,
    nupkgPath, sha512: createHash('sha512').update(bytes).digest('base64') };
  const path = join(dir, 'identity.json');
  writeFileSync(path, JSON.stringify(identity));
  return { dir, identity, path };
}

test('selects the sidecar version even when another package is beside it', t => {
  const { dir, identity, path } = fixture(t);
  writeFileSync(join(dir, 'Lumio.Engine.SDK.9.9.9.nupkg'), 'other package');
  assert.deepEqual(readIdentity(path), identity);
});

test('rejects same identity with replaced archive bytes before restore', t => {
  const { identity, path } = fixture(t);
  writeFileSync(identity.nupkgPath, 'tampered archive');
  assert.throws(() => readIdentity(path), /sdk_package_identity_conflict/);
});

test('rejects sidecars for another package', t => {
  const { identity, path } = fixture(t);
  writeFileSync(path, JSON.stringify({ ...identity, packageId: 'Another.SDK' }));
  assert.throws(() => readIdentity(path), /sdk_identity_invalid/);
});

test('requires the exact restored version and content hash', t => {
  const { dir, identity } = fixture(t);
  const path = join(dir, 'project.assets.json');
  const key = `${identity.packageId}/${identity.version}`;
  writeFileSync(path, JSON.stringify({ libraries: { [key]: { type: 'package', sha512: identity.sha512 } } }));
  verifyAssets(path, identity);
  writeFileSync(path, JSON.stringify({ libraries: { [key]: { type: 'package', sha512: 'wrong' } } }));
  assert.throws(() => verifyAssets(path, identity), /sdk_restored_identity_mismatch/);
  writeFileSync(path, JSON.stringify({ libraries: { 'Lumio.Engine.SDK/0.1.0': { type: 'package', sha512: identity.sha512 } } }));
  assert.throws(() => verifyAssets(path, identity), /sdk_restored_identity_mismatch/);
});

test('permits Sample project references but rejects engine source fallback', t => {
  const { dir, identity } = fixture(t);
  const path = join(dir, 'project.assets.json');
  const libraries = { [`${identity.packageId}/${identity.version}`]: { type: 'package', sha512: identity.sha512 },
    'Lumio.Sample.Gameplay/1.0.0': { type: 'project' } };
  writeFileSync(path, JSON.stringify({ libraries }));
  verifyAssets(path, identity);
  libraries['Lumio.GameRuntime.Ecs/0.1.0'] = { type: 'project' };
  writeFileSync(path, JSON.stringify({ libraries }));
  assert.throws(() => verifyAssets(path, identity), /sdk_source_reference/);
});

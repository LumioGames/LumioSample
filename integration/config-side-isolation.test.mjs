import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const project = 'src/Lumio.Sample.Gameplay/Lumio.Sample.Gameplay.csproj';
function evaluate(side, extra = []) {
  return JSON.parse(execFileSync('dotnet', ['msbuild', project,
    '-p:LumioSdkMode=nuget', `-p:LumioRuntimeRoot=${path.join(root, 'missing-runtime')}`,
    ...(side ? [`-p:LumioEcsSide=${side}`] : []), ...extra,
    '-getProperty:OutputPath,IntermediateOutputPath,LumioSdkMode', '-getItem:Compile,None'],
  { cwd: root, encoding: 'utf8' }));
}

for (const side of ['client', 'server', '']) {
  test(`${side || 'default server'} selects only its configuration projection`, () => {
    const result = evaluate(side);
    const selected = side || 'server';
    const readers = result.Items.Compile.map(x => x.Identity.replaceAll('\\', '/'))
      .filter(x => x.includes('generated/config/'));
    assert.equal(readers.length, 3);
    assert.ok(readers.every(x => x.startsWith(`generated/config/${selected}/`)), readers.join('\n'));
    const copies = result.Items.None.filter(x => x.CopyToOutputDirectory)
      .map(x => (x.Link || x.Identity).replaceAll('\\', '/'))
      .filter(x => x.startsWith('config/'));
    assert.ok(copies.includes('config/manifest.json'));
    assert.ok(copies.includes(`config/${selected}/manifest.json`));
    assert.ok(copies.every(x => x === 'config/manifest.json' || x.startsWith(`config/${selected}/`)), copies.join('\n'));
  });
}

test('side and configuration outputs are distinct and honor SDK artifacts isolation', () => {
  const client = evaluate('client').Properties;
  const server = evaluate('server').Properties;
  const release = evaluate('client', ['-p:Configuration=Release']).Properties;
  assert.notEqual(client.OutputPath, server.OutputPath);
  assert.notEqual(client.IntermediateOutputPath, server.IntermediateOutputPath);
  assert.match(client.OutputPath, /Debug/);
  assert.notEqual(client.OutputPath, release.OutputPath);
  const artifacts = path.join(root, 'artifacts', 'config-isolation');
  const isolated = evaluate('client', [`-p:ArtifactsPath=${artifacts}`]).Properties;
  assert.ok(path.resolve(isolated.OutputPath).startsWith(artifacts));
  assert.ok(path.resolve(isolated.IntermediateOutputPath).startsWith(artifacts));
});

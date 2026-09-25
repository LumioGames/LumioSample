import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  C0_BLOCKS,
  assetRefToPath,
  checkAlpha,
  checkBlockAssets,
  decodePng,
  parseSourcesTable,
  resolveSlots,
  validateDescription,
  validatePack,
} from './check-block-assets.mjs';
import { encodePng, renderTexture } from '../Client/Assets/Blocks/source/generate-textures.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const F = 'lumio.block-asset.v1';

// 以下七格期望照抄契约 block-asset-v1 faceResolution.vectors（LumioGameEngine af56fb1）的语义。
test('faceResolution: all / side / 具体面键的覆盖优先级', () => {
  const S = 'textures/stone.png';
  assert.deepEqual(resolveSlots({ format: F, faces: { all: S } }), [S, S, S, S, S, S, null]);
  assert.deepEqual(
    resolveSlots({ format: F, faces: { top: 'textures/g.png', bottom: 'textures/d.png', side: 'textures/s.png' } }),
    ['textures/d.png', 'textures/g.png', 'textures/s.png', 'textures/s.png', 'textures/s.png', 'textures/s.png', null],
  );
  assert.deepEqual(
    resolveSlots({ format: F, faces: { north: 'textures/n.png', all: 'textures/p.png' } }),
    ['textures/p.png', 'textures/p.png', 'textures/n.png', 'textures/p.png', 'textures/p.png', 'textures/p.png', null],
  );
  assert.deepEqual(
    resolveSlots({ format: F, faces: { all: 'textures/t.png', side: 'textures/s.png' } }),
    ['textures/t.png', 'textures/t.png', 'textures/s.png', 'textures/s.png', 'textures/s.png', 'textures/s.png', null],
  );
  assert.deepEqual(resolveSlots({ format: F, faces: {}, cross: 'textures/f.png' }), [null, null, null, null, null, null, 'textures/f.png']);
});

test('不合法的描述七格全是 null', () => {
  const nulls = Array(7).fill(null);
  assert.deepEqual(resolveSlots({ format: F, faces: { front: 'textures/x.png' } }), nulls);
  assert.deepEqual(resolveSlots({ faces: { all: 'textures/x.png' } }), nulls);
  assert.deepEqual(resolveSlots({ format: F, faces: { all: 3 } }), nulls);
  assert.ok(validateDescription({ format: F, faces: {}, layer: 1 }).length > 0, '不认的顶层键');
  assert.ok(validateDescription({ format: F, faces: { all: '../x.png' } }).length > 0, '路径不得含 ..');
  assert.ok(validateDescription({ format: F, faces: { all: '/x.png' } }).length > 0, '路径不得以 / 开头');
  assert.ok(validateDescription({ format: F, faces: { all: 'x.jpg' } }).length > 0, '只收 .png');
  assert.ok(validateDescription({ format: F, faces: {}, license: { spdx: 1 } }).length > 0);
  assert.deepEqual(validateDescription({ format: F, faces: {}, cross: 'textures/f.png', license: { spdx: 'CC0-1.0' } }), []);
});

test('assetRef 解析到 Blocks/<id>.json，不合语法返回 null', () => {
  assert.equal(assetRefToPath('asset://blocks/lumio.stone'), 'Blocks/lumio.stone.json');
  assert.equal(assetRefToPath('asset://blocks/Lumio.Stone'), null);
  assert.equal(assetRefToPath('asset://blocks/.hidden'), null);
  assert.equal(assetRefToPath('asset://blocks/a..b'), null);
  assert.equal(assetRefToPath('asset://items/lumio.stone'), null);
});

test('pack.json：textureSize 是 16 ~ 512 的 2 的幂', () => {
  const pack = (textureSize) => ({ format: 'lumio.block-asset-pack.v1', textureSize });
  assert.deepEqual(validatePack(pack(16)), []);
  assert.deepEqual(validatePack(pack(512)), []);
  for (const bad of [8, 24, 1024, '16']) assert.ok(validatePack(pack(bad)).length > 0, `应拒绝 ${bad}`);
});

test('PNG 编解码往返，透明度分类', () => {
  const rgba = new Uint8Array(4 * 4 * 4);
  for (let i = 0; i < 16; i++) rgba.set([i * 10, 20, 30, i % 2 ? 255 : 0], i * 4);
  const image = decodePng(encodePng(4, 4, rgba));
  assert.equal(image.width, 4);
  assert.deepEqual([...image.rgba], [...rgba]);
  assert.equal(checkAlpha('cutout', { transparent: 1, partial: 0, opaque: 3 }), null);
  assert.match(checkAlpha('cutout', { transparent: 1, partial: 1, opaque: 2 }), /半透/);
  assert.match(checkAlpha('cutout', { transparent: 0, partial: 0, opaque: 4 }), /全透明/);
  assert.match(checkAlpha('translucent', { transparent: 0, partial: 0, opaque: 4 }), /半透明/);
  assert.match(checkAlpha('opaque', { transparent: 1, partial: 0, opaque: 3 }), /不透明/);
});

test('SOURCES.md 表按表头取列', () => {
  const rows = parseSourcesTable('# x\n\n| 文件 | 来源 | 版本 | 许可 |\n|---|---|---|---|\n| textures/a.png | 自绘 | r1 | CC0-1.0 |\n\n| 别的 | 表 |\n|---|---|\n| b | c |\n');
  assert.equal(rows.size, 1);
  assert.equal(rows.get('textures/a.png')['许可'], 'CC0-1.0');
});

test('仓内材质包通过全部检查', () => {
  const { errors, summary, blocks } = checkBlockAssets(repoRoot);
  assert.deepEqual(errors, []);
  assert.equal(summary.blocks, C0_BLOCKS.length);
  assert.equal(summary.textureSize, 16);
  const grass = blocks.find((block) => block.name === 'lumio.grass_block').slots;
  assert.deepEqual(grass.slice(0, 3), ['textures/dirt.png', 'textures/grass_block_top.png', 'textures/grass_block_side.png']);
});

test('贴图生成是确定的：同一配方两次逐字节相同，且等于仓内导出物', () => {
  for (const name of ['stone', 'grass_block_side', 'oak_leaves', 'water', 'torch']) {
    const first = encodePng(16, 16, renderTexture(name).rgba);
    const second = encodePng(16, 16, renderTexture(name).rgba);
    assert.ok(first.equals(second), name);
    const onDisk = decodePng(readFileSync(join(repoRoot, 'Client/Assets/Blocks/textures', `${name}.png`)));
    assert.deepEqual([...onDisk.rgba], [...renderTexture(name).rgba], `${name}.png 与配方不一致，需重新运行生成脚本`);
  }
});

// 负例：复制一份材质包到临时目录，逐项弄坏，确认检查真的会失败。
function withBrokenCopy(breakIt) {
  const root = mkdtempSync(join(tmpdir(), 'block-assets-'));
  try {
    cpSync(join(repoRoot, 'Client/Assets/Blocks'), join(root, 'Client/Assets/Blocks'), { recursive: true });
    breakIt(join(root, 'Client/Assets/Blocks'));
    return checkBlockAssets(root).errors.join('\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('负例：缺 C0 方块描述', () => {
  const errors = withBrokenCopy((dir) => rmSync(join(dir, 'lumio.torch.json')));
  assert.match(errors, /lumio\.torch 没有素材描述/);
});

test('负例：引用的贴图不存在', () => {
  const errors = withBrokenCopy((dir) => rmSync(join(dir, 'textures/stone.png')));
  assert.match(errors, /textures\/stone\.png 不存在/);
});

test('负例：贴图边长不是 2 的幂 / 与 textureSize 不一致', () => {
  const rgba = new Uint8Array(24 * 24 * 4).fill(255);
  const errors = withBrokenCopy((dir) => writeFileSync(join(dir, 'textures/dirt.png'), encodePng(24, 24, rgba)));
  assert.match(errors, /边长 24 不是 2 的幂/);
  const rgba32 = new Uint8Array(32 * 32 * 4).fill(255);
  const errors32 = withBrokenCopy((dir) => writeFileSync(join(dir, 'textures/dirt.png'), encodePng(32, 32, rgba32)));
  assert.match(errors32, /不等于 pack\.json 的 textureSize 16/);
});

test('负例：镂空贴图出现半透明像素', () => {
  const texture = renderTexture('oak_leaves');
  texture.rgba[3] = 128;
  const errors = withBrokenCopy((dir) => writeFileSync(join(dir, 'textures/oak_leaves.png'), encodePng(16, 16, texture.rgba)));
  assert.match(errors, /镂空贴图只能有全透/);
});

test('负例：SOURCES.md 缺记录或许可不收', () => {
  const missing = withBrokenCopy((dir) => {
    const path = join(dir, 'SOURCES.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace(/^\| textures\/ice\.png .*$/m, ''));
  });
  assert.match(missing, /ice\.png: SOURCES\.md 里没有/);
  const sa = withBrokenCopy((dir) => {
    const path = join(dir, 'SOURCES.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace(/(\| textures\/ice\.png .*)CC0-1\.0/m, '$1CC-BY-SA-4.0'));
  });
  assert.match(sa, /许可「CC-BY-SA-4\.0」不收/);
  const ccby = withBrokenCopy((dir) => {
    const path = join(dir, 'SOURCES.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace(/(\| textures\/ice\.png .*)CC0-1\.0/m, '$1CC-BY-4.0'));
  });
  assert.match(ccby, /必须在 ATTRIBUTION\.md 里署名/);
});

test('负例：草方块三面不分', () => {
  const errors = withBrokenCopy((dir) =>
    writeFileSync(join(dir, 'lumio.grass_block.json'), JSON.stringify({ format: F, faces: { all: 'textures/grass_block_top.png' } })),
  );
  assert.match(errors, /顶、侧、底必须是三张不同的贴图/);
});

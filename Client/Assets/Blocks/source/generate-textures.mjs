/**
 * 「示例」方块材质包的源（R-00789，ADR-124 D9）。
 *
 * 用法（在仓根）：node Client/Assets/Blocks/source/generate-textures.mjs
 *   1. 按下面的程序化配方画出 textures/*.png（16×16，RGBA）；
 *   2. 读 Client/Assets/Blocks/lumio.*.json 素材描述，拼出 preview/blocks-preview.png。
 *
 * 为什么是程序化的：这套贴图全部由本文件从零画出，不引用、不描摹任何外部图片，
 * 作者以 CC0-1.0 放弃权利（见 ../LICENSE 与 ../SOURCES.md）。改贴图就改这里的配方、
 * 重新运行，不要直接改 PNG——导出物（textures/、preview/）是本文件的生成结果。
 *
 * 确定性：每张贴图用自己名字做种子的 mulberry32 伪随机数（不用 Math.random），
 * 同一版 Node 重跑两次逐字节相同。
 */

import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const SIZE = 16;

// ---------------------------------------------------------------------------------------------
// PNG 编码（RGBA8、无隔行、每行过滤类型 0）
// ---------------------------------------------------------------------------------------------

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, body) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(body.length, 0);
  head.write(type, 4, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), body])), 0);
  return Buffer.concat([head, body, crc]);
}

export function encodePng(width, height, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 位深
  header[9] = 6; // RGBA
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    Buffer.from(rgba.buffer, rgba.byteOffset + y * width * 4, width * 4).copy(raw, y * (width * 4 + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------------------------
// 画布与伪随机
// ---------------------------------------------------------------------------------------------

/** mulberry32：32 位状态的小型伪随机数，结果只取决于种子。 */
function prng(seedText) {
  let seed = 2166136261;
  for (const ch of seedText) seed = Math.imul(seed ^ ch.charCodeAt(0), 16777619) >>> 0;
  return () => {
    seed = (seed + 0x6d2b79f5) >>> 0;
    let t = seed;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Canvas {
  constructor(size = SIZE) {
    this.size = size;
    this.rgba = new Uint8Array(size * size * 4);
  }
  set(x, y, [r, g, b, a = 255]) {
    if (x < 0 || y < 0 || x >= this.size || y >= this.size) return;
    const i = (y * this.size + x) * 4;
    this.rgba[i] = clamp(r);
    this.rgba[i + 1] = clamp(g);
    this.rgba[i + 2] = clamp(b);
    this.rgba[i + 3] = clamp(a);
  }
  get(x, y) {
    const i = (y * this.size + x) * 4;
    return [...this.rgba.subarray(i, i + 4)];
  }
  fill(fn) {
    for (let y = 0; y < this.size; y++) for (let x = 0; x < this.size; x++) this.set(x, y, fn(x, y));
  }
}

const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
/** 把颜色整体提亮 / 压暗 d（RGB 三个通道同加），透明度不变。 */
const shade = ([r, g, b, a = 255], d) => [r + d, g + d, b + d, a];
/** 在 base 上加一点逐像素噪声，幅度 ±amount/2。 */
const noisy = (base, rand, amount) => shade(base, (rand() - 0.5) * amount);

// ---------------------------------------------------------------------------------------------
// 配方：每张贴图一个函数。颜色都是自带的（不做生物群系染色，ADR-124 非目标）。
// 透明约定：镂空贴图只用 alpha 0 / 255；半透明贴图用 0 < alpha < 255。
// ---------------------------------------------------------------------------------------------

const STONE = [128, 128, 128];
const DIRT = [134, 96, 67];
const GRASS = [96, 158, 54];
const PLANK = [168, 134, 82];
const BARK = [98, 74, 46];

function stoneBase(c, rand) {
  c.fill(() => noisy(STONE, rand, 26));
  // 几块深色斑，让石头不是纯噪声
  for (let n = 0; n < 7; n++) {
    const x0 = Math.floor(rand() * SIZE);
    const y0 = Math.floor(rand() * SIZE);
    const len = 2 + Math.floor(rand() * 3);
    for (let k = 0; k < len; k++) c.set((x0 + k) % SIZE, y0, noisy(shade(STONE, -22), rand, 8));
  }
}

const recipes = {
  stone(c, rand) {
    stoneBase(c, rand);
  },

  // 硬墙：深色砖墙，砖 8×4，行间错半块，灰浆线更暗
  hard_wall(c, rand) {
    const brick = [92, 94, 102];
    c.fill((x, y) => {
      const row = Math.floor(y / 4);
      const offset = row % 2 === 0 ? 0 : 4;
      if (y % 4 === 3 || (x + offset) % 8 === 7) return noisy([54, 55, 60], rand, 8);
      const top = y % 4 === 0 ? 12 : 0;
      return noisy(shade(brick, top), rand, 16);
    });
  },

  // 矿石：石头底上嵌几簇青色晶粒（Lumio 自己的「矿」，不对应任何现实矿种）
  ore(c, rand) {
    stoneBase(c, rand);
    const clusters = [
      [3, 3],
      [11, 4],
      [5, 11],
      [12, 12],
    ];
    for (const [cx, cy] of clusters) {
      const cells = [
        [0, 0, [170, 255, 240]],
        [1, 0, [70, 205, 195]],
        [0, 1, [70, 205, 195]],
        [1, 1, [30, 120, 115]],
        [-1, 0, [30, 120, 115]],
      ];
      for (const [dx, dy, color] of cells) {
        if (rand() < 0.85) c.set(cx + dx, cy + dy, color);
      }
    }
  },

  dirt(c, rand) {
    c.fill(() => {
      const r = rand();
      if (r < 0.1) return noisy([102, 72, 50], rand, 10);
      if (r < 0.15) return noisy([160, 120, 86], rand, 10);
      return noisy(DIRT, rand, 22);
    });
  },

  grass_block_top(c, rand) {
    c.fill(() => {
      const r = rand();
      if (r < 0.12) return noisy([72, 126, 42], rand, 10);
      if (r < 0.2) return noisy([124, 186, 72], rand, 10);
      return noisy(GRASS, rand, 20);
    });
  },

  // 草方块侧面：泥土底，上沿 3~5 行绿草，边缘参差
  grass_block_side(c, rand) {
    recipes.dirt(c, prng('grass_block_side/dirt'));
    for (let x = 0; x < SIZE; x++) {
      const depth = 3 + (rand() < 0.5 ? 1 : 0) + (rand() < 0.25 ? 1 : 0);
      for (let y = 0; y < depth; y++) c.set(x, y, noisy(y === 0 ? shade(GRASS, 12) : GRASS, rand, 18));
      if (rand() < 0.5) c.set(x, depth, noisy([72, 110, 44], rand, 10));
    }
  },

  // 木板：四条横板，每条 4 行，底行是暗缝，竖缝错开
  oak_planks(c, rand) {
    const joints = [5, 13, 1, 9];
    const rowTone = Array.from({ length: SIZE }, () => (rand() - 0.5) * 10);
    c.fill((x, y) => {
      const plank = Math.floor(y / 4);
      if (y % 4 === 3) return noisy([112, 86, 52], rand, 8);
      if (x === joints[plank]) return noisy([124, 96, 58], rand, 8);
      const grain = rand() < 0.08 ? -18 : 0;
      return noisy(shade(PLANK, rowTone[y] + grain), rand, 10);
    });
  },

  // 原木侧面：竖纹树皮
  oak_log(c, rand) {
    const columnTone = Array.from({ length: SIZE }, () => (rand() - 0.5) * 24);
    c.fill((x) => noisy(shade(BARK, columnTone[x]), rand, 12));
    for (let n = 0; n < 6; n++) {
      const x = Math.floor(rand() * SIZE);
      const y0 = Math.floor(rand() * SIZE);
      const len = 3 + Math.floor(rand() * 4);
      for (let k = 0; k < len; k++) c.set(x, (y0 + k) % SIZE, noisy(shade(BARK, -26), rand, 6));
    }
  },

  // 原木顶 / 底：一圈树皮，里面浅色年轮，中心深色髓心
  oak_log_top(c, rand) {
    c.fill((x, y) => {
      if (x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1) return noisy(BARK, rand, 14);
      const d = Math.hypot(x - 7.5, y - 7.5);
      if (d < 1) return noisy([128, 98, 58], rand, 6);
      const ring = Math.floor(d * 1.1) % 3 === 0;
      return noisy(ring ? [150, 116, 70] : [184, 150, 96], rand, 8);
    });
  },

  // 树叶（镂空）：绿叶上约四分之一像素全透
  oak_leaves(c, rand) {
    c.fill(() => {
      if (rand() < 0.24) return [0, 0, 0, 0];
      const r = rand();
      if (r < 0.15) return noisy([44, 98, 30], rand, 8);
      if (r < 0.25) return noisy([96, 164, 62], rand, 8);
      return noisy([62, 128, 42], rand, 16);
    });
  },

  // 普通玻璃（镂空）：一像素边框 + 两道高光，其余全透
  glass(c) {
    c.fill((x, y) => {
      const edge = x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1;
      if (edge) return (x + y) % 5 === 0 ? [168, 196, 208] : [206, 230, 238];
      if ((x - y === 0 && x >= 3 && x <= 6) || (x - y === 0 && x >= 8 && x <= 9)) return [236, 248, 252];
      if (x - y === 3 && x >= 9 && x <= 12) return [236, 248, 252];
      return [0, 0, 0, 0];
    });
  },

  // 彩色玻璃（蓝，半透明）
  blue_stained_glass(c, rand) {
    c.fill((x, y) => {
      const edge = x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1;
      if (edge) return [38, 64, 168, 210];
      if (x - y === 0 && x >= 3 && x <= 6) return [130, 168, 244, 160];
      return noisy([52, 92, 204, 120], rand, 8);
    });
  },

  // 冰（半透明）：浅蓝底，几道更白的裂纹
  ice(c, rand) {
    c.fill(() => noisy([150, 196, 242, 176], rand, 14));
    for (let n = 0; n < 3; n++) {
      let x = Math.floor(rand() * SIZE);
      let y = Math.floor(rand() * SIZE);
      for (let k = 0; k < 7; k++) {
        c.set(x, y, [214, 236, 255, 206]);
        x = (x + (rand() < 0.5 ? 1 : 0) + SIZE) % SIZE;
        y = (y + (rand() < 0.6 ? 1 : -1) + SIZE) % SIZE;
      }
    }
  },

  // 萤石：暖黄色晶块，2×2 一格随机明暗
  glowstone(c, rand) {
    const tones = [
      [150, 104, 50],
      [206, 152, 72],
      [240, 192, 96],
      [255, 232, 150],
    ];
    const cells = Array.from({ length: 64 }, () => tones[Math.floor(rand() * tones.length)]);
    c.fill((x, y) => noisy(cells[Math.floor(y / 2) * 8 + Math.floor(x / 2)], rand, 12));
  },

  // 水（半透明，静态）：蓝色，几段浅色水纹
  water(c, rand) {
    c.fill(() => noisy([48, 98, 204, 168], rand, 12));
    for (let n = 0; n < 6; n++) {
      const x0 = Math.floor(rand() * SIZE);
      const y = Math.floor(rand() * SIZE);
      for (let k = 0; k < 4; k++) c.set((x0 + k) % SIZE, y, [96, 150, 232, 184]);
    }
  },

  // 岩浆（不透明，静态）：橙红底、亮黄团块、暗色硬壳点
  lava(c, rand) {
    c.fill(() => noisy([214, 84, 22], rand, 20));
    for (let n = 0; n < 7; n++) {
      const cx = Math.floor(rand() * SIZE);
      const cy = Math.floor(rand() * SIZE);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const core = dx === 0 && dy === 0;
          if (core || rand() < 0.6) c.set((cx + dx + SIZE) % SIZE, (cy + dy + SIZE) % SIZE, core ? [255, 226, 96] : [255, 160, 44]);
        }
      }
    }
    for (let n = 0; n < 10; n++) c.set(Math.floor(rand() * SIZE), Math.floor(rand() * SIZE), [140, 40, 12]);
  },

  // 门：竖板门，一圈深色门框，中间一道横档。门上下两格用同一张（ADR-124 D5 已知限制），
  // 所以图案上下对称，叠起来仍像一扇门。
  oak_door(c, rand) {
    c.fill((x, y) => {
      if (x === 0 || y === 0 || x === SIZE - 1 || y === SIZE - 1) return noisy([104, 76, 44], rand, 8);
      if (y === 7 || y === 8) return noisy([126, 96, 58], rand, 8);
      if (x % 5 === 0) return noisy([118, 90, 54], rand, 6);
      return noisy(shade(PLANK, -6), rand, 12);
    });
  },

  // 铁栏杆（镂空）：四根竖杆，上下各一道横档
  iron_bars(c) {
    c.fill((x, y) => {
      const bar = x % 4 === 1 || x % 4 === 2;
      const band = y === 2 || y === 13;
      if (!bar && !band) return [0, 0, 0, 0];
      if (bar) return x % 4 === 1 ? [176, 178, 184] : [96, 98, 106];
      return [136, 138, 146];
    });
  },

  // 火把（交叉面片，镂空）：木柄 + 火苗
  torch(c) {
    c.fill(() => [0, 0, 0, 0]);
    for (let y = 6; y < SIZE; y++) {
      c.set(7, y, [150, 110, 62]);
      c.set(8, y, [112, 80, 44]);
    }
    const flame = [
      [7, 1, [255, 236, 150]],
      [8, 1, [255, 214, 100]],
      [6, 2, [240, 140, 40]],
      [7, 2, [255, 240, 170]],
      [8, 2, [255, 214, 100]],
      [9, 2, [240, 140, 40]],
      [6, 3, [255, 180, 60]],
      [7, 3, [255, 250, 210]],
      [8, 3, [255, 236, 150]],
      [9, 3, [255, 180, 60]],
      [6, 4, [230, 120, 30]],
      [7, 4, [255, 214, 100]],
      [8, 4, [255, 214, 100]],
      [9, 4, [230, 120, 30]],
      [7, 5, [210, 100, 30]],
      [8, 5, [210, 100, 30]],
    ];
    for (const [x, y, color] of flame) c.set(x, y, color);
  },

  // 花（交叉面片，镂空）：绿茎两片叶，顶上红花黑心
  poppy(c) {
    c.fill(() => [0, 0, 0, 0]);
    for (let y = 8; y < SIZE; y++) c.set(7, y, [62, 138, 46]);
    for (const [x, y] of [[8, 12], [9, 11], [6, 13], [5, 12]]) c.set(x, y, [82, 160, 56]);
    for (let y = 3; y <= 7; y++) {
      for (let x = 5; x <= 9; x++) {
        const corner = (x === 5 || x === 9) && (y === 3 || y === 7);
        if (corner) continue;
        c.set(x, y, (x + y) % 3 === 0 ? [236, 84, 72] : [204, 38, 40]);
      }
    }
    c.set(7, 5, [40, 30, 22]);
  },

  // 草丛（交叉面片，镂空）：几根长短不一的草叶
  short_grass(c, rand) {
    c.fill(() => [0, 0, 0, 0]);
    const tones = [
      [66, 128, 42],
      [88, 156, 54],
      [110, 180, 66],
    ];
    for (const x0 of [1, 3, 4, 6, 8, 9, 11, 13, 14]) {
      const height = 5 + Math.floor(rand() * 8);
      const lean = rand() < 0.5 ? -1 : 1;
      for (let k = 0; k < height; k++) {
        const x = x0 + (k > height / 2 ? lean : 0);
        c.set(x, SIZE - 1 - k, tones[Math.min(2, Math.floor((k / height) * 3))]);
      }
    }
  },

  // 树苗（交叉面片，镂空）：细茎 + 三团小叶
  oak_sapling(c, rand) {
    c.fill(() => [0, 0, 0, 0]);
    for (let y = 9; y < SIZE; y++) c.set(7, y, [112, 82, 48]);
    c.set(8, 11, [112, 82, 48]);
    for (const [cx, cy] of [[5, 7], [10, 6], [7, 3]]) {
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          if (dx * dx + dy * dy > 5) continue;
          c.set(cx + dx, cy + dy, noisy(rand() < 0.3 ? [90, 160, 58] : [58, 124, 40], rand, 10));
        }
      }
    }
  },
};

// ---------------------------------------------------------------------------------------------
// 预览图：每个 C0 方块一格，标方块名，画出它解析后的顶 / 侧 / 底 / 交叉面片
// ---------------------------------------------------------------------------------------------

// 5×7 点阵字，只有预览要用到的字符（小写、数字、少量符号）
const FONT = {
  a: ['.....', '.....', '.###.', '....#', '.####', '#...#', '.####'],
  b: ['#....', '#....', '#.##.', '##..#', '#...#', '#...#', '####.'],
  c: ['.....', '.....', '.###.', '#....', '#....', '#...#', '.###.'],
  d: ['....#', '....#', '.##.#', '#..##', '#...#', '#...#', '.####'],
  e: ['.....', '.....', '.###.', '#...#', '#####', '#....', '.###.'],
  f: ['..##.', '.#..#', '.#...', '###..', '.#...', '.#...', '.#...'],
  g: ['.....', '.####', '#...#', '#...#', '.####', '....#', '.###.'],
  h: ['#....', '#....', '#.##.', '##..#', '#...#', '#...#', '#...#'],
  i: ['..#..', '.....', '.##..', '..#..', '..#..', '..#..', '.###.'],
  j: ['...#.', '.....', '..##.', '...#.', '...#.', '#..#.', '.##..'],
  k: ['#....', '#....', '#..#.', '#.#..', '##...', '#.#..', '#..#.'],
  l: ['.##..', '..#..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  m: ['.....', '.....', '##.#.', '#.#.#', '#.#.#', '#...#', '#...#'],
  n: ['.....', '.....', '#.##.', '##..#', '#...#', '#...#', '#...#'],
  o: ['.....', '.....', '.###.', '#...#', '#...#', '#...#', '.###.'],
  p: ['.....', '.....', '####.', '#...#', '####.', '#....', '#....'],
  q: ['.....', '.....', '.##.#', '#..##', '.####', '....#', '....#'],
  r: ['.....', '.....', '#.##.', '##..#', '#....', '#....', '#....'],
  s: ['.....', '.....', '.###.', '#....', '.###.', '....#', '####.'],
  t: ['.#...', '.#...', '###..', '.#...', '.#...', '.#..#', '..##.'],
  u: ['.....', '.....', '#...#', '#...#', '#...#', '#..##', '.##.#'],
  v: ['.....', '.....', '#...#', '#...#', '#...#', '.#.#.', '..#..'],
  w: ['.....', '.....', '#...#', '#...#', '#.#.#', '#.#.#', '.#.#.'],
  x: ['.....', '.....', '#...#', '.#.#.', '..#..', '.#.#.', '#...#'],
  y: ['.....', '.....', '#...#', '#...#', '.####', '....#', '.###.'],
  z: ['.....', '.....', '#####', '...#.', '..#..', '.#...', '#####'],
  0: ['.###.', '#...#', '#..##', '#.#.#', '##..#', '#...#', '.###.'],
  1: ['..#..', '.##..', '..#..', '..#..', '..#..', '..#..', '.###.'],
  2: ['.###.', '#...#', '....#', '...#.', '..#..', '.#...', '#####'],
  3: ['####.', '....#', '....#', '.###.', '....#', '....#', '####.'],
  4: ['...#.', '..##.', '.#.#.', '#..#.', '#####', '...#.', '...#.'],
  5: ['#####', '#....', '####.', '....#', '....#', '#...#', '.###.'],
  6: ['..##.', '.#...', '#....', '####.', '#...#', '#...#', '.###.'],
  7: ['#####', '....#', '...#.', '..#..', '.#...', '.#...', '.#...'],
  8: ['.###.', '#...#', '#...#', '.###.', '#...#', '#...#', '.###.'],
  9: ['.###.', '#...#', '#...#', '.####', '....#', '...#.', '.##..'],
  '.': ['.....', '.....', '.....', '.....', '.....', '.##..', '.##..'],
  _: ['.....', '.....', '.....', '.....', '.....', '.....', '#####'],
  '-': ['.....', '.....', '.....', '.###.', '.....', '.....', '.....'],
  '/': ['....#', '...#.', '...#.', '..#..', '.#...', '.#...', '#....'],
  ':': ['.....', '.##..', '.##..', '.....', '.##..', '.##..', '.....'],
  ' ': ['.....', '.....', '.....', '.....', '.....', '.....', '.....'],
};

class Image {
  constructor(width, height, background) {
    this.width = width;
    this.height = height;
    this.rgba = new Uint8Array(width * height * 4);
    for (let i = 0; i < width * height; i++) this.rgba.set(background, i * 4);
  }
  /** 按 alpha 把颜色叠到当前像素上（预览图本身不透明）。 */
  blend(x, y, [r, g, b, a]) {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    const i = (y * this.width + x) * 4;
    const t = a / 255;
    this.rgba[i] = Math.round(r * t + this.rgba[i] * (1 - t));
    this.rgba[i + 1] = Math.round(g * t + this.rgba[i + 1] * (1 - t));
    this.rgba[i + 2] = Math.round(b * t + this.rgba[i + 2] * (1 - t));
    this.rgba[i + 3] = 255;
  }
  rect(x0, y0, w, h, color) {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.blend(x, y, color);
  }
  text(x0, y0, text, scale, color) {
    let x = x0;
    for (const ch of text.toLowerCase()) {
      const glyph = FONT[ch] ?? FONT[' '];
      glyph.forEach((row, gy) => {
        [...row].forEach((bit, gx) => {
          if (bit === '#') this.rect(x + gx * scale, y0 + gy * scale, scale, scale, color);
        });
      });
      x += 6 * scale;
    }
  }
  /** 把一张贴图放大 scale 倍画上去，底下先铺棋盘格，透明处看得出来。 */
  tile(x0, y0, texture, scale) {
    const side = texture.width * scale;
    for (let y = 0; y < side; y++) {
      for (let x = 0; x < side; x++) {
        const checker = (Math.floor(x / (2 * scale)) + Math.floor(y / (2 * scale))) % 2 === 0 ? 205 : 150;
        this.blend(x0 + x, y0 + y, [checker, checker, checker, 255]);
        const i = (Math.floor(y / scale) * texture.width + Math.floor(x / scale)) * 4;
        this.blend(x0 + x, y0 + y, [...texture.rgba.subarray(i, i + 4)]);
      }
    }
  }
}

/** 把七格归并成要展示的几张：六面同一张就只画一张 all。 */
function facesToShow(slots) {
  const [down, up, north, south, west, east, cross] = slots;
  const shown = [];
  const six = [down, up, north, south, west, east];
  if (six.every(Boolean) && six.every((path) => path === six[0])) shown.push(['all', down]);
  else {
    if (up) shown.push(['top', up]);
    if (north) shown.push(['side', north]);
    if (down) shown.push(['bottom', down]);
  }
  if (cross) shown.push(['cross', cross]);
  return shown;
}

async function writePreview(blocksDir) {
  // 预览按描述文件画，和客户端看到的是同一份解析（复用检查工具里的契约实现）
  const { C0_BLOCKS, decodePng, resolveSlots } = await import('../../../../Tools/check-block-assets.mjs');
  const scale = 4;
  const tileSide = SIZE * scale;
  const columns = 3;
  const cellWidth = 316;
  const cellHeight = 116;
  const margin = 16;
  const header = 40;
  const rows = Math.ceil(C0_BLOCKS.length / columns);
  const image = new Image(margin * 2 + columns * cellWidth, header + margin + rows * cellHeight, [34, 36, 42, 255]);
  image.text(margin, 14, 'lumio sample block pack - 16px - cc0-1.0 - client/assets/blocks', 2, [230, 232, 236, 255]);

  const textures = new Map();
  const load = (path) => {
    if (!textures.has(path)) textures.set(path, decodePng(readFileSync(join(blocksDir, path))));
    return textures.get(path);
  };

  C0_BLOCKS.forEach((block, index) => {
    const x0 = margin + (index % columns) * cellWidth;
    const y0 = header + Math.floor(index / columns) * cellHeight;
    const description = JSON.parse(readFileSync(join(blocksDir, `${block.name}.json`), 'utf8'));
    image.rect(x0, y0, cellWidth - 8, cellHeight - 8, [48, 51, 60, 255]);
    image.text(x0 + 6, y0 + 6, block.name, 2, [250, 250, 250, 255]);
    facesToShow(resolveSlots(description)).forEach(([label, path], k) => {
      const tx = x0 + 6 + k * (tileSide + 22);
      image.tile(tx, y0 + 26, load(path), scale);
      image.text(tx, y0 + 26 + tileSide + 4, label, 1, [190, 194, 204, 255]);
    });
  });

  const previewDir = join(blocksDir, 'preview');
  mkdirSync(previewDir, { recursive: true });
  writeFileSync(join(previewDir, 'blocks-preview.png'), encodePng(image.width, image.height, image.rgba));
}

// ---------------------------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------------------------

export function renderTexture(name) {
  const canvas = new Canvas();
  recipes[name](canvas, prng(name));
  return canvas;
}

export const TEXTURE_NAMES = Object.keys(recipes);

async function main() {
  const blocksDir = join(dirname(fileURLToPath(import.meta.url)), '..');
  const texturesDir = join(blocksDir, 'textures');
  mkdirSync(texturesDir, { recursive: true });
  for (const name of TEXTURE_NAMES) {
    const canvas = renderTexture(name);
    writeFileSync(join(texturesDir, `${name}.png`), encodePng(SIZE, SIZE, canvas.rgba));
  }
  await writePreview(blocksDir);
  const descriptions = readdirSync(blocksDir).filter((file) => file.startsWith('lumio.') && file.endsWith('.json'));
  console.log(`generate-textures: ${TEXTURE_NAMES.length} 张贴图、${descriptions.length} 份描述的预览已写出`);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

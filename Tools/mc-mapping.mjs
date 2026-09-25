#!/usr/bin/env node
// LumioSample 的 MC 导入映射表生成器（ADR-124 D10 第 3 条）。
//
// 映射表归游戏：规则就写在本文件里，生成物是 Server/Assets/Maps/mc-import/mc-mapping.json，
// 不手改。改规则 → 改这里 → `node Tools/mc-mapping.mjs` 重写生成物 → 重跑 assess 更新报告。
// `node --test Tools/mc-mapping.test.mjs` 守两件事：生成物与本脚本输出逐字节相同；
// 每一行的 `to` 都是官方目录里已有的方块或 `air`（本卡不新铸方块）。
//
// 表格式由 LumioVoxelEngine `crates/lumio-voxel-mc-import/README.md` 定义：
// mc（名字或名字数组）、when（属性子集）、to（我们的方块名或 air）、tier（exact / degraded /
// dropped）、fields（常量 BlockState 字段）、derive（由 MC 属性推字段）；note 只是说明，工具不读。

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
export const MAPPING_PATH = join(repoRoot, 'Server', 'Assets', 'Maps', 'mc-import', 'mc-mapping.json');

const M = (n) => `minecraft:${n}`;

const COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray', 'light_gray', 'cyan',
  'purple', 'blue', 'brown', 'green', 'red', 'black'];
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak'];
const NETHER_WOODS = ['crimson', 'warped'];
const ALL_WOODS = [...WOODS, 'bamboo', ...NETHER_WOODS];

const liquidLevels = { 0: 0 };
for (let i = 1; i < 8; i += 1) liquidLevels[String(i)] = i;
for (let i = 8; i < 16; i += 1) liquidLevels[String(i)] = 8;

const derive = {
  stairs: {
    Direction: {
      props: ['half', 'facing'],
      map: {
        'bottom,north': 'D0', 'bottom,east': 'D1', 'bottom,south': 'D2', 'bottom,west': 'D3',
        'top,north': 'U0', 'top,east': 'U1', 'top,south': 'U2', 'top,west': 'U3',
      },
    },
    SubShapeId: {
      props: ['shape'],
      map: { straight: 0, inner_left: 1, inner_right: 2, outer_left: 3, outer_right: 4 },
    },
  },
  slab: { SubShapeId: { props: ['type'], map: { bottom: 0, top: 1, double: 2 } } },
  door: {
    Direction: { props: ['facing'], map: { north: 'D0', east: 'D1', south: 'D2', west: 'D3' } },
    Open: { props: ['open'], map: { false: 0, true: 1 } },
    RightHinge: { props: ['hinge'], map: { left: 0, right: 1 } },
    Up: { props: ['half'], map: { lower: 0, upper: 1 } },
  },
  // MC 的 facing 是火苗朝向；火把挂在反方向的墙上。
  wall_torch: { Direction: { props: ['facing'], map: { south: 'F0', north: 'B0', east: 'L0', west: 'R0' } } },
  liquid: { HeightLevel: { props: ['level'], map: liquidLevels } },
};

const rules = [];
function rule(names, to, tier, { when, fields, derive: group, note } = {}) {
  const list = typeof names === 'string' ? [names] : names;
  const row = { mc: list.length > 1 ? list.map(M) : M(list[0]), to, tier };
  if (when) row.when = when;
  if (fields) row.fields = fields;
  if (group) row.derive = group;
  if (note) row.note = note;
  rules.push(row);
}

// ---- 空气
rule(['air', 'cave_air', 'void_air'], 'air', 'exact');

// ---- 石头一族
rule('stone', 'lumio.stone', 'exact');
rule([
  'granite', 'polished_granite', 'diorite', 'polished_diorite', 'andesite', 'polished_andesite',
  'deepslate', 'cobbled_deepslate', 'polished_deepslate', 'cobblestone', 'mossy_cobblestone', 'smooth_stone',
  'tuff', 'polished_tuff', 'calcite', 'dripstone_block', 'bedrock', 'sandstone', 'smooth_sandstone', 'cut_sandstone',
  'chiseled_sandstone', 'red_sandstone', 'smooth_red_sandstone', 'cut_red_sandstone', 'chiseled_red_sandstone',
  'terracotta', 'obsidian', 'crying_obsidian', 'netherrack', 'basalt', 'smooth_basalt', 'polished_basalt', 'blackstone',
  'polished_blackstone', 'gilded_blackstone', 'end_stone', 'magma_block', 'infested_stone', 'infested_cobblestone',
  'infested_deepslate', 'reinforced_deepslate', 'amethyst_block', 'budding_amethyst', 'soul_sand', 'soul_soil',
  'snow_block', 'powder_snow', 'furnace', 'blast_furnace', 'smoker', 'dispenser', 'dropper', 'observer', 'stonecutter',
  'prismarine', 'dark_prismarine', 'purpur_block', 'purpur_pillar', 'sculk',
  ...COLORS.map((c) => `${c}_terracotta`),
], 'lumio.stone', 'degraded');

// ---- 泥土 / 草方块
rule('dirt', 'lumio.dirt', 'exact');
rule(['coarse_dirt', 'rooted_dirt', 'dirt_path', 'farmland', 'mud', 'packed_mud', 'muddy_mangrove_roots', 'clay',
  'sand', 'red_sand', 'suspicious_sand', 'gravel', 'suspicious_gravel', 'pumpkin', 'carved_pumpkin', 'melon'],
'lumio.dirt', 'degraded');
rule('grass_block', 'lumio.grass_block', 'exact');
rule(['podzol', 'mycelium', 'moss_block', 'crimson_nylium', 'warped_nylium'], 'lumio.grass_block', 'degraded');

// ---- 木头
rule('oak_planks', 'lumio.oak_planks', 'exact');
rule([
  ...ALL_WOODS.filter((w) => w !== 'oak').map((w) => `${w}_planks`), 'bamboo_mosaic', 'crafting_table',
  'bookshelf', 'chiseled_bookshelf', 'barrel', 'note_block', 'jukebox', 'hay_block', 'composter', 'beehive', 'bee_nest',
  'cartography_table', 'fletching_table', 'smithing_table', 'loom', 'lectern',
], 'lumio.oak_planks', 'degraded');
rule('oak_log', 'lumio.oak_log', 'exact', { when: { axis: 'y' } });
rule('oak_log', 'lumio.oak_log', 'degraded', { note: 'axis x/z: our log has no axis' });
const logs = [];
for (const w of WOODS) logs.push(`${w}_log`, `stripped_${w}_log`, `${w}_wood`, `stripped_${w}_wood`);
logs.splice(logs.indexOf('oak_log'), 1);
for (const w of NETHER_WOODS) logs.push(`${w}_stem`, `stripped_${w}_stem`, `${w}_hyphae`, `stripped_${w}_hyphae`);
logs.push('bamboo_block', 'stripped_bamboo_block', 'mushroom_stem', 'brown_mushroom_block', 'red_mushroom_block');
rule(logs, 'lumio.oak_log', 'degraded');

rule('oak_leaves', 'lumio.oak_leaves', 'exact');
rule([...WOODS.filter((w) => w !== 'oak').map((w) => `${w}_leaves`), 'azalea_leaves', 'flowering_azalea_leaves',
  'nether_wart_block', 'warped_wart_block', 'azalea', 'flowering_azalea'], 'lumio.oak_leaves', 'degraded');

const stoneShapeMaterials = ['stone', 'cobblestone', 'mossy_cobblestone', 'stone_brick', 'mossy_stone_brick', 'brick',
  'sandstone', 'smooth_sandstone', 'red_sandstone', 'smooth_red_sandstone', 'granite', 'polished_granite', 'diorite',
  'polished_diorite', 'andesite', 'polished_andesite', 'cobbled_deepslate', 'polished_deepslate', 'deepslate_brick',
  'deepslate_tile', 'nether_brick', 'red_nether_brick', 'quartz', 'smooth_quartz', 'purpur', 'prismarine',
  'prismarine_brick', 'dark_prismarine', 'blackstone', 'polished_blackstone', 'polished_blackstone_brick',
  'end_stone_brick', 'mud_brick', 'tuff', 'polished_tuff', 'tuff_brick', 'cut_copper', 'exposed_cut_copper',
  'weathered_cut_copper', 'oxidized_cut_copper', 'waxed_cut_copper', 'waxed_exposed_cut_copper',
  'waxed_weathered_cut_copper', 'waxed_oxidized_cut_copper', 'bamboo_mosaic'];
rule('oak_stairs', 'lumio.oak_stairs', 'exact', { derive: 'stairs' });
rule([...ALL_WOODS.filter((w) => w !== 'oak').map((w) => `${w}_stairs`),
  ...stoneShapeMaterials.map((m) => `${m}_stairs`)], 'lumio.oak_stairs', 'degraded', { derive: 'stairs' });
rule('oak_slab', 'lumio.oak_slab', 'exact', { derive: 'slab' });
rule([...ALL_WOODS.filter((w) => w !== 'oak').map((w) => `${w}_slab`), ...stoneShapeMaterials.map((m) => `${m}_slab`),
  'smooth_stone_slab', 'cut_sandstone_slab', 'cut_red_sandstone_slab', 'petrified_oak_slab'],
'lumio.oak_slab', 'degraded', { derive: 'slab' });
rule('oak_door', 'lumio.oak_door', 'exact', { derive: 'door' });
rule([...ALL_WOODS.filter((w) => w !== 'oak').map((w) => `${w}_door`), 'iron_door', 'copper_door',
  'exposed_copper_door', 'weathered_copper_door', 'oxidized_copper_door', 'waxed_copper_door',
  'waxed_exposed_copper_door', 'waxed_weathered_copper_door', 'waxed_oxidized_copper_door'],
'lumio.oak_door', 'degraded', { derive: 'door' });
rule('oak_fence', 'lumio.oak_fence', 'exact',
  { note: 'connections are recomputed (D2), MC north/east/south/west dropped' });
const walls = ['cobblestone', 'mossy_cobblestone', 'stone_brick', 'mossy_stone_brick', 'brick', 'sandstone',
  'red_sandstone', 'granite', 'diorite', 'andesite', 'cobbled_deepslate', 'polished_deepslate', 'deepslate_brick',
  'deepslate_tile', 'nether_brick', 'red_nether_brick', 'prismarine', 'blackstone', 'polished_blackstone',
  'polished_blackstone_brick', 'end_stone_brick', 'mud_brick', 'tuff', 'polished_tuff', 'tuff_brick'];
rule([...ALL_WOODS.filter((w) => w !== 'oak').map((w) => `${w}_fence`), 'nether_brick_fence',
  ...ALL_WOODS.map((w) => `${w}_fence_gate`), ...walls.map((w) => `${w}_wall`)], 'lumio.oak_fence', 'degraded');

// ---- 玻璃与透明
rule('glass', 'lumio.glass', 'exact');
rule('tinted_glass', 'lumio.glass', 'degraded');
rule('blue_stained_glass', 'lumio.blue_stained_glass', 'exact');
rule(COLORS.filter((c) => c !== 'blue').map((c) => `${c}_stained_glass`), 'lumio.blue_stained_glass', 'degraded');
rule('glass_pane', 'lumio.glass_pane', 'exact', { note: 'connections recomputed' });
rule(COLORS.map((c) => `${c}_stained_glass_pane`), 'lumio.glass_pane', 'degraded');
rule('iron_bars', 'lumio.iron_bars', 'exact');
rule('chain', 'lumio.iron_bars', 'degraded');
rule('ice', 'lumio.ice', 'exact');
rule(['packed_ice', 'blue_ice', 'frosted_ice'], 'lumio.ice', 'degraded');
rule('glowstone', 'lumio.glowstone', 'exact');
rule(['sea_lantern', 'shroomlight', 'ochre_froglight', 'verdant_froglight', 'pearlescent_froglight', 'redstone_lamp',
  'jack_o_lantern', 'beacon'], 'lumio.glowstone', 'degraded');

// ---- 液体
rule('water', 'lumio.water', 'exact', { derive: 'liquid' });
rule('lava', 'lumio.lava', 'exact', { derive: 'liquid' });
rule(['bubble_column', 'kelp', 'kelp_plant', 'seagrass', 'tall_seagrass'], 'lumio.water', 'degraded', {
  fields: { HeightLevel: 0 },
  note: 'underwater plants are always in water; keep the water, drop the plant',
});

// ---- 火把与小模型
rule('torch', 'lumio.torch', 'exact', { fields: { Direction: 'C1' } });
rule('wall_torch', 'lumio.torch', 'exact', { derive: 'wall_torch' });
rule(['soul_torch', 'redstone_torch', 'lantern', 'soul_lantern', 'end_rod', 'candle'], 'lumio.torch', 'degraded',
  { fields: { Direction: 'C1' } });
rule(['soul_wall_torch', 'redstone_wall_torch'], 'lumio.torch', 'degraded', { derive: 'wall_torch' });
rule('poppy', 'lumio.poppy', 'exact');
rule(['dandelion', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip',
  'oxeye_daisy', 'cornflower', 'lily_of_the_valley', 'wither_rose', 'torchflower', 'sunflower', 'lilac', 'rose_bush',
  'peony', 'pitcher_plant', 'brown_mushroom', 'red_mushroom', 'crimson_fungus', 'warped_fungus', 'sweet_berry_bush',
  'wheat', 'carrots', 'potatoes', 'beetroots', 'pink_petals', 'spore_blossom', 'closed_eyeblossom', 'open_eyeblossom'],
'lumio.poppy', 'degraded');
rule(['short_grass', 'grass'], 'lumio.short_grass', 'exact', { note: '`grass` is the pre-1.20.3 name' });
rule(['fern', 'tall_grass', 'large_fern', 'dead_bush', 'crimson_roots', 'warped_roots', 'nether_sprouts', 'sugar_cane',
  'bamboo', 'bamboo_sapling', 'hanging_roots', 'short_dry_grass', 'tall_dry_grass', 'bush', 'firefly_bush'],
'lumio.short_grass', 'degraded');
rule('oak_sapling', 'lumio.oak_sapling', 'exact');
rule([...WOODS.filter((w) => w !== 'oak' && w !== 'mangrove').map((w) => `${w}_sapling`), 'mangrove_propagule'],
  'lumio.oak_sapling', 'degraded');

// ---- 矿石 / 砖与实心装饰块
const ores = ['coal', 'iron', 'copper', 'gold', 'redstone', 'emerald', 'lapis', 'diamond'];
rule([...ores.map((o) => `${o}_ore`), ...ores.map((o) => `deepslate_${o}_ore`), 'nether_gold_ore', 'nether_quartz_ore',
  'ancient_debris', 'raw_iron_block', 'raw_copper_block', 'raw_gold_block'], 'lumio.ore', 'degraded');
rule(['bricks', 'stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'chiseled_stone_bricks', 'deepslate_bricks',
  'cracked_deepslate_bricks', 'deepslate_tiles', 'cracked_deepslate_tiles', 'chiseled_deepslate', 'nether_bricks',
  'cracked_nether_bricks', 'chiseled_nether_bricks', 'red_nether_bricks', 'prismarine_bricks', 'end_stone_bricks',
  'mud_bricks', 'quartz_block', 'quartz_bricks', 'quartz_pillar', 'chiseled_quartz_block', 'smooth_quartz',
  'polished_blackstone_bricks', 'cracked_polished_blackstone_bricks', 'chiseled_polished_blackstone', 'tuff_bricks',
  'chiseled_tuff', 'chiseled_tuff_bricks', 'iron_block', 'gold_block', 'diamond_block', 'emerald_block', 'lapis_block',
  'redstone_block', 'coal_block', 'netherite_block', 'copper_block', 'exposed_copper', 'weathered_copper', 'oxidized_copper',
  'cut_copper', 'waxed_copper_block', 'sponge', 'wet_sponge', 'target', 'honeycomb_block', 'slime_block', 'honey_block',
  'dried_kelp_block', 'bone_block', 'sculk_catalyst', 'lodestone', 'respawn_anchor', 'crafter', 'trial_spawner', 'vault',
  'spawner', 'enchanting_table', 'anvil', 'chipped_anvil', 'damaged_anvil', 'cauldron', 'water_cauldron', 'lava_cauldron',
  'powder_snow_cauldron', 'piston', 'sticky_piston', 'piston_head', 'tnt',
  ...COLORS.map((c) => `${c}_wool`), ...COLORS.map((c) => `${c}_concrete`), ...COLORS.map((c) => `${c}_concrete_powder`),
  ...COLORS.map((c) => `${c}_glazed_terracotta`), ...COLORS.map((c) => `${c}_shulker_box`), 'shulker_box'],
'lumio.hard_wall', 'degraded');

// ---- 丢弃（没有对应方块：薄片、交互件、只靠方块实体才有意义的东西）
const dropped = ['chest', 'trapped_chest', 'ender_chest', 'snow', 'vine', 'glow_lichen', 'ladder', 'cobweb', 'lily_pad',
  'redstone_wire', 'rail', 'powered_rail', 'detector_rail', 'activator_rail', 'lever', 'tripwire', 'tripwire_hook',
  'repeater', 'comparator', 'daylight_detector', 'flower_pot', 'scaffolding', 'big_dripleaf', 'big_dripleaf_stem',
  'small_dripleaf', 'cave_vines', 'cave_vines_plant', 'weeping_vines', 'weeping_vines_plant', 'twisting_vines',
  'twisting_vines_plant', 'sculk_vein', 'sculk_sensor', 'calibrated_sculk_sensor', 'sculk_shrieker', 'pointed_dripstone',
  'amethyst_cluster', 'large_amethyst_bud', 'medium_amethyst_bud', 'small_amethyst_bud', 'moss_carpet',
  'pale_moss_carpet', 'frogspawn', 'turtle_egg', 'sniffer_egg', 'sea_pickle', 'brewing_stand', 'bell', 'grindstone',
  'campfire', 'soul_campfire', 'conduit', 'decorated_pot', 'end_portal_frame', 'end_portal', 'nether_portal', 'fire',
  'soul_fire', 'light', 'barrier', 'structure_void', 'moving_piston', 'player_head', 'player_wall_head',
  'skeleton_skull', 'skeleton_wall_skull', 'zombie_head', 'creeper_head', 'dragon_head', 'piglin_head',
  'heavy_weighted_pressure_plate', 'light_weighted_pressure_plate', 'stone_pressure_plate',
  'polished_blackstone_pressure_plate', 'stone_button', 'polished_blackstone_button', 'leaf_litter', 'resin_clump',
  'hopper', 'cocoa', 'melon_stem', 'pumpkin_stem', 'attached_melon_stem', 'attached_pumpkin_stem', 'nether_wart',
  'chorus_plant', 'chorus_flower', 'dragon_egg', 'cactus', 'iron_trapdoor', 'heavy_core', 'structure_block', 'jigsaw',
  'command_block', 'chain_command_block', 'repeating_command_block',
  ...COLORS.map((c) => `${c}_bed`), ...COLORS.map((c) => `${c}_carpet`), ...COLORS.map((c) => `${c}_banner`),
  ...COLORS.map((c) => `${c}_wall_banner`), ...COLORS.map((c) => `${c}_candle`)];
for (const w of ALL_WOODS) {
  dropped.push(`${w}_sign`, `${w}_wall_sign`, `${w}_hanging_sign`, `${w}_wall_hanging_sign`, `${w}_trapdoor`,
    `${w}_pressure_plate`, `${w}_button`);
}
for (const p of ['oak_sapling', 'poppy', 'dandelion', 'fern', 'cactus', 'dead_bush', 'red_mushroom', 'brown_mushroom']) {
  dropped.push(`potted_${p}`);
}
rule(dropped, 'air', 'dropped');

export const mappingDocument = {
  version: 1,
  description: 'LumioSample MC import mapping (ADR-124 D10). Game-owned data generated by Tools/mc-mapping.mjs; '
    + 'do not edit by hand. Keys: mc (name or list), when (property subset), to (our block name or air), '
    + 'tier (exact/degraded/dropped), fields (constant BlockState fields), derive (named MC-property -> field maps).',
  derive,
  rules,
};

export function renderMapping() {
  return `${JSON.stringify(mappingDocument, null, 1)}\n`;
}

export function mcNames(doc = mappingDocument) {
  const names = new Set();
  for (const row of doc.rules) for (const n of Array.isArray(row.mc) ? row.mc : [row.mc]) names.add(n);
  return names;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  writeFileSync(MAPPING_PATH, renderMapping());
  console.log(`rules ${rules.length} distinct mc names ${mcNames().size} -> ${MAPPING_PATH}`);
}

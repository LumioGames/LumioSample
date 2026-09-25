# 来源记录（SOURCES）

每张贴图一行；`Tools/check-block-assets.mjs` 读下面这张表，核对 `textures/` 下每张 PNG 都在表里、
「来源」「版本」非空、「许可」只能是 `CC0-1.0` 或 `CC-BY-4.0`。

## 贴图

「来源」列的配方名是 `source/generate-textures.mjs` 里 `recipes` 的键；版本 `r1` 指本仓 R-00789 首版配方
（之后改配方就把对应行的版本加一）。全部是从零程序化绘制，没有上游素材，所以「修改」列写「原创」。

| 文件 | 用途 | 来源 | 版本 | 作者 | 许可 | 修改 |
|---|---|---|---|---|---|---|
| textures/stone.png | 石头 | 本仓 source/generate-textures.mjs 配方 `stone` | r1 | LumioSample contributors | CC0-1.0 | 原创 |
| textures/hard_wall.png | 硬墙 | 本仓 source/generate-textures.mjs 配方 `hard_wall` | r1 | LumioSample contributors | CC0-1.0 | 原创 |
| textures/ore.png | 矿石 | 本仓 source/generate-textures.mjs 配方 `ore` | r1 | LumioSample contributors | CC0-1.0 | 原创 |
| textures/dirt.png | 泥土；也是草方块底面 | 本仓 source/generate-textures.mjs 配方 `dirt` | r1 | LumioSample contributors | CC0-1.0 | 原创 |
| textures/grass_block_top.png | 草方块顶 | 本仓 source/generate-textures.mjs 配方 `grass_block_top` | r1 | LumioSample contributors | CC0-1.0 | 原创 |
| textures/grass_block_side.png | 草方块侧（带土） | 本仓 source/generate-textures.mjs 配方 `grass_block_side` | r1 | LumioSample contributors | CC0-1.0 | 原创 |
| textures/oak_planks.png | 木板；楼梯、台阶、木栅栏共用 | 本仓 source/generate-textures.mjs 配方 `oak_planks` | r1 | LumioSample contributors | CC0-1.0 | 原创 |
| textures/oak_log.png | 原木侧（树皮） | 本仓 source/generate-textures.mjs 配方 `oak_log` | r1 | LumioSample contributors | CC0-1.0 | 原创 |
| textures/oak_log_top.png | 原木顶 / 底（年轮） | 本仓 source/generate-textures.mjs 配方 `oak_log_top` | r1 | LumioSample contributors | CC0-1.0 | 原创 |
| textures/oak_leaves.png | 树叶（镂空） | 本仓 source/generate-textures.mjs 配方 `oak_leaves` | r1 | LumioSample contributors | CC0-1.0 | 原创 |
| textures/glass.png | 普通玻璃（镂空）；玻璃板共用 | 本仓 source/generate-textures.mjs 配方 `glass` | r1 | LumioSample contributors | CC0-1.0 | 原创 |
| textures/blue_stained_glass.png | 蓝色彩色玻璃（半透明） | 本仓 source/generate-textures.mjs 配方 `blue_stained_glass` | r1 | LumioSample contributors | CC0-1.0 | 原创 |
| textures/ice.png | 冰（半透明） | 本仓 source/generate-textures.mjs 配方 `ice` | r1 | LumioSample contributors | CC0-1.0 | 原创 |
| textures/glowstone.png | 萤石 | 本仓 source/generate-textures.mjs 配方 `glowstone` | r1 | LumioSample contributors | CC0-1.0 | 原创 |
| textures/water.png | 水（半透明，静态） | 本仓 source/generate-textures.mjs 配方 `water` | r1 | LumioSample contributors | CC0-1.0 | 原创 |
| textures/lava.png | 岩浆（不透明，静态） | 本仓 source/generate-textures.mjs 配方 `lava` | r1 | LumioSample contributors | CC0-1.0 | 原创 |
| textures/oak_door.png | 门（上下两格共用） | 本仓 source/generate-textures.mjs 配方 `oak_door` | r1 | LumioSample contributors | CC0-1.0 | 原创 |
| textures/iron_bars.png | 铁栏杆（镂空） | 本仓 source/generate-textures.mjs 配方 `iron_bars` | r1 | LumioSample contributors | CC0-1.0 | 原创 |
| textures/torch.png | 火把交叉面片（镂空） | 本仓 source/generate-textures.mjs 配方 `torch` | r1 | LumioSample contributors | CC0-1.0 | 原创 |
| textures/poppy.png | 花交叉面片（镂空） | 本仓 source/generate-textures.mjs 配方 `poppy` | r1 | LumioSample contributors | CC0-1.0 | 原创 |
| textures/short_grass.png | 草丛交叉面片（镂空） | 本仓 source/generate-textures.mjs 配方 `short_grass` | r1 | LumioSample contributors | CC0-1.0 | 原创 |
| textures/oak_sapling.png | 树苗交叉面片（镂空） | 本仓 source/generate-textures.mjs 配方 `oak_sapling` | r1 | LumioSample contributors | CC0-1.0 | 原创 |

预览图 `preview/blocks-preview.png` 由同一脚本从上面的贴图与 `lumio.*.json` 描述拼出，同为 CC0-1.0；
其中的 5×7 点阵字也在脚本里手写，没有使用任何字体文件。

## 选包记录（外部候选）

本轮（2026-09-25，R-00789）**没有下载、没有使用任何外部材质包**：下载外部文件需要 Owner 在会话里明确同意，
执行本卡的 worker 拿不到这项授权，所以按派活时的兜底口径先用自绘 CC0 贴图覆盖全部方块，外部包留作候选。

| 候选包 | 主页 | 许可（据主页，未存许可原文副本） | 是否派生自 Mojang 资源 | 结论 |
|---|---|---|---|---|
| Kenney Voxel Pack（1.0） | https://kenney.nl/assets/voxel-pack 、https://opengameart.org/content/voxel-pack | 主页标 CC0；许可原文副本须随下载包的 `License.txt` 核对 | 作者自绘的独立风格，不是 MC 贴图改色；须下载后逐张复核 | **候选，未采用**：未获下载授权；包内贴图为大尺寸，需统一缩到 16×16；无门、铁栏杆、火把交叉面片等，缺口仍要自绘 |
| MC 原版贴图、从 MC 客户端 jar 提取的资源包 | — | Mojang 所有 | 是 | **禁止**（ADR-124 D9） |
| 「Faithful」「仿原版」一类资源包 | — | 多为自定义许可，且由 Mojang 贴图派生 | 是 | **禁止**（ADR-124 D9） |
| CC-BY-SA / NC / ND、「仅限个人使用」或许可不明的包 | — | 不在 CC0 / CC-BY 之内 | — | **不收**（ADR-124 D9、R-00789 已锁决策） |

## Mojang 派生核查结论

- 本包 22 张贴图全部由 `source/generate-textures.mjs` 的程序化配方逐像素生成：只用固定调色（写在脚本里的 RGB 常量）、
  固定种子伪随机噪声与简单几何（边框、缝线、年轮、交叉面片轮廓）。脚本不读取任何外部图片。
- 没有引用、描摹、取色自 MC 原版或任何资源包；文件名只是通用英文词（stone、dirt、oak_planks……），与方块 `name` 对齐。
- 结论：**不含 MC 原版或由其派生的贴图 / 模型**。

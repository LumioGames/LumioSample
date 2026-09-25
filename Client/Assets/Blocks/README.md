# 方块材质包（Client/Assets/Blocks）

「示例」唯一一套方块材质包：C0 方块清单（ADR-124 第一批）里每种方块的素材描述与贴图。
格式归引擎契约 `engine/wire/block-asset-v1.json`（LumioGameEngine main `af56fb1`），内容归本仓（ADR-124 D9）。
只有客户端读这里的文件；DS 只把目录里的 `assetRef` 当一列原样保存。

## 使用简报

- **观察距离**：第一人称，从贴脸（一格占满半屏）到十几格远（一格只剩几个屏幕像素）。
  所以贴图以「远处一眼认得出是什么方块」为先：主色块明确（石灰、土棕、草绿、木黄、水蓝、岩浆橙），
  细节只是一两级明暗的噪点、缝线和纹路，近看不花、远看不糊成一片。
- **像素风一致**：整套 16×16，渲染端 `NEAREST` 采样、`REPEAT` 平铺（契约 `texture.sampling`），
  所以每张图四边都要能无缝接上（石墙、木板、草地会被贪心合面铺成大片）。不做抗锯齿、不做渐变。
- **镂空 / 半透明怎么判**：
  - 镂空（Cutout，alpha < 0.5 丢弃）：树叶、普通玻璃、玻璃板、铁栏杆、火把、花、草丛、树苗。
    像素要么全透（alpha 0）要么不透（alpha 255），不用中间值——中间值会在 0.5 处被硬切，边缘忽隐忽现。
  - 半透明（alpha 混合）：彩色玻璃、冰、水。整张 alpha 在 110~210 之间，边框略实。
  - 不透明：其余方块。岩浆是液体但画成不透明（它自己发光，透过去看反而怪）。
- **自带颜色**：不做生物群系染色（ADR-124 非目标），草方块顶、树叶、草丛都是画好的绿色，不是等着染色的灰图。

## 已知限制（按 ADR-124 设计，选图时已照顾到）

- 面贴图表只按「方块种类 × 6 面」取，不看 BlockState：
  - 门的上下两格用同一张 `oak_door.png`，所以门的图案上下对称，叠两格仍像一扇门；
  - 楼梯、台阶、木栅栏都用木板 `oak_planks.png`，玻璃板用普通玻璃 `glass.png`；
  - 墙上火把与地上火把是同一张交叉面片 `torch.png`。
- 火把按主会话 2026-09-25 裁决只有交叉面片（形状表里没有方盒），描述里 `faces` 为空、只写 `cross`。
- 水和岩浆是静态贴图，不做动画（契约不支持动画条带）。
- 原木只竖放（C0：不做轴向），顶底是年轮、四周是树皮。

## 文件

| 路径 | 是什么 |
|---|---|
| `pack.json` | 材质包清单：`textureSize` 16、整包许可 CC0-1.0 |
| `lumio.<name>.json` | 每个方块一份素材描述；`asset://blocks/lumio.<name>` 解析到这里 |
| `textures/*.png` | 导出的贴图（生成物，不手改） |
| `preview/blocks-preview.png` | 全部 C0 方块的对照预览，标了方块名与顶 / 侧 / 底 / 交叉面片——C9 浏览器截图逐块对照的「原图」（生成物） |
| `source/generate-textures.mjs` | 贴图与预览的源：程序化配方，固定种子 |
| `SOURCES.md` | 每张贴图的来源、版本、许可，以及候选外部包的核查记录 |
| `LICENSE` / `ATTRIBUTION.md` | 许可与署名 |

## 怎么改、怎么查

```bash
# 改 source/generate-textures.mjs 里的配方（或 lumio.*.json 描述）后重新导出贴图与预览
node Client/Assets/Blocks/source/generate-textures.mjs
# 检查：描述合契约、PNG 边长 2 的幂且一致、C0 每块都有描述、透明度对、每张图有来源与许可
node Tools/check-block-assets.mjs
node --test Tools/check-block-assets.test.mjs
```

换成外部开源包时：贴图放进 `textures/`（同一边长），`SOURCES.md` 每张写来源、版本、许可（只收
CC0-1.0 / CC-BY-4.0），CC-BY 的在 `ATTRIBUTION.md` 署名；MC 原版贴图、从 MC 客户端 jar 提取的资源、
「仿原版」「Faithful」一类 Mojang 派生包不得进仓（ADR-124 D9）。

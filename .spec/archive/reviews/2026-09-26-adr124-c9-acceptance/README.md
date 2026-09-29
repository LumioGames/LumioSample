# ADR-124 第一批验收记录（C9 · 湖边小屋）

一次取证，2026-09-26，本机 macOS x86_64。本目录是记录类文稿：写的是这一次跑出来的结果，不是现状规范。

## 用到的版本

| 仓 | 提交 | 说明 |
|---|---|---|
| LumioGameEngine | 分支 `feat/adr124-c9-integration` @ 3f7dc79 | sdk-native 带目录建世界与形状碰撞、capture-voxel `--catalog`、`eng/voxel-evidence.mjs`、契约追加 |
| LumioVoxelEngine | main @ dfe707d | 含 R-00794、B-00120、B-00119、C10、天光横向扩散 |
| LumioNativeCore | main @ c4e7a88 | |
| LumioGameRuntime | 分支 @ d189f6e | 掩码 13 |
| LumioServer | main @ d21cde2 | |
| LumioClient | 分支 @ 6de0986 | voxel-grid ABI 2、Render 取生成物 |
| LumioPlatform | main @ b5888d6 | 本地镜像 `lumio-platform-local:0.0.1-main.3f7dc79` |

`Engine/` 由架构仓 `node eng/pack-release.mjs --from-main --out <本仓>/Engine --base-version 0.0.1` 用上表检出现填（manifest 版本 `0.0.1-main.3f7dc79`，已被 `.gitignore` 挡住，不入库）。

## 怎么复现

```bash
# 底图（作者态，已入库）
node <LumioGameEngine>/eng/capture-voxel.mjs --cells Server/Assets/Maps/acceptance-lakeside.cells.json \
  --catalog Server/Assets/Maps/official-catalog.json --out Server/Assets/Maps/acceptance-lakeside.voxel --verify-restore
# 原生两端取证（物理 Authority / Client、网格统计、光照摘要）
node <LumioGameEngine>/eng/voxel-evidence.mjs --catalog Server/Assets/Maps/official-catalog.json \
  --map Server/Assets/Maps/acceptance-lakeside.voxel --points Server/Assets/Maps/acceptance-lakeside.points.json --out native-evidence.json
# 浏览器：DS 用验收配置开机，旁观页开 ?view=blocks
dotnet publish Client/UI/Spectator/host/Lumio.Sample.Client.Spectator.csproj -c Release -p:LumioEcsSide=client -p:LumioBrowserReplica=true
LUMIO_DS_CONFIG=Server/Config/Startup/server.acceptance.json node Tools/launcher.mjs --spectator --bots 1
```

本机的 docker 没有 compose 插件，Platform 按 `Engine/platform/docker-compose.yml` 同样的镜像与环境变量用 `docker run` 手起，
启动器带 `--origin http://127.0.0.1:8080`；hostfxr 在 Homebrew 的 libexec 下，需要 `DOTNET_ROOT`。

## 逐条结论（ADR-124「验证」第一批）

| # | 验收项 | 证据 | 结论 |
|---|---|---|---|
| 1 | sdk-native 只经唯一 v2 解析；旧信封被拒；目录使用方全改 v2 | 架构仓 `sdk-native/src/voxel.rs parse_official_catalog`、`tests/root_api.rs catalog_create_rejects_invalid_inputs_without_publishing`（v1 / 3 / "2" / 缺 version 拒、重复键拒、ggg、缺列、缺形状表条目、门三个子形状）；各仓 `git grep retiredNames` 只剩 v2 与刻意的 v1 拒绝用例 | 通过（`2.0` 仍被 VoxelEngine 接受，待修，见交回） |
| 2 | 移动 / 视线掩码 13，「在不在水里」2 | Runtime `VoxelFacadeNativeAbi.MovementMaterialMask = 13`；native-evidence `mask.liquid_2_vs_blocking_13` | 通过 |
| 3 | 四仓 main 合入后能编过 | 分支上：sdk-native 177 测试绿、`dotnet build LumioSample.slnx` 0 错、Runtime VoxelAdapters 编过、Client node 91 例绿、`pack-release --from-main` 全链编过 | 合入后复跑待做 |
| 4 | capture + `--verify-restore`；DS 开机 restore；默认图不受影响 | capture 输出 `cells=2035 sections~2 bytes=17329 verify=ok`（sha256 52b8ab0a…e25e）；DS 日志 `empty store: first boot opens the world from the configured base map path=…/acceptance-lakeside.voxel`；默认 `server.json` 仍开 `sample.voxel`（同机另跑一次） | 通过 |
| 5 | WebGL2 画出底图，覆盖每种方块，对照 C7 预览图 | `shots/lakeside-01…11-*.png`（11 个机位） | 通过（Section 由页内注入，见下「DS 未送达」） |
| 6 | 草方块顶绿侧带土；透过彩色玻璃见湖面 | `shots/lakeside-06-lake_and_lava.png`（湖岸草方块侧面）、`lakeside-04-through_stained_glass.png` | 通过（地图外沿朝外的侧面是黑的，见「已知问题」1） |
| 7 | 删一张贴图：紫黑格子 + 一条告警，其余正常 | `shots/missing-texture-oak_log-side.png`；`browser-evidence.json missingTexture` | 通过 |
| 8 | 剔面四处 | native-evidence `cull.*` 四条 PASS；截图 06 / 07 / 08 | 通过 |
| 9 | 石墙 1 个四边形；三段面数；缺贴图写层 0 | native-evidence `mesh.stone_wall_single_quad`、`mesh.missing_texture_writes_layer_0`；三段面数原生 1113/63/2 + 601/135/63，浏览器同为 1714/198/65 | 通过 |
| 10 | 掩码 13：楼梯、台阶、被栅栏 / 树叶 / 玻璃挡、穿花草、门 | native-evidence `collision.*`、`shape.*` 共 13 条 PASS；掩码改 1 时树叶 / 玻璃 / 玻璃板三条变红 | 通过 |
| 11 | Authority 与 Client 同一组射线逐条一致 | native-evidence `parity`：30 条探针 + 3072 条网格射线 / 扫掠全同，命中 2834 | 通过 |
| 12 | 栅栏旁放上 / 拿走整块，连接臂出现 / 消失，BlockState 不变 | 原生 `connected.fence_toggle_full_block` PASS（东臂探针 Miss → Hit，栅栏 BlockId 259840 不变）；浏览器侧未做（没有写方块的入口） | 原生通过，浏览器未执行 |
| 13 | 火把每格减 1、萤石邻格亮、屋顶下天光、树叶下天光不减 | 原生与浏览器探针一致：火把 (14,12,8)→(8,6,2)、萤石邻格 (14,12,9)、树叶下 15；屋顶下 12 / 11 | 火把、萤石、树叶通过；「屋顶下为 0」按 2026-09-25 天光横向扩散裁决不再成立（门窗透光），点位期望待改 |
| 14 | 原生与浏览器光照逐 Section 摘要相同 | 原生 `native-evidence.json lighting.digests` 与浏览器 `lumio_voxel_light_section_digest`：s:0:0:0 9c816a65…f05b、s:1:0:0 37f01cd3…1769，两端相同 | 通过 |
| 15 | 本记录 | 本文件 | — |

## DS 未送达

同一套构建下，DS 对任何连接都不发 SectionFrame（`ds-probe-acceptance.txt`：一个新连接 8 秒内只收到 Welcome ×1、WorldChange ×160；默认 `sample.voxel` 同样 0 帧，旁观页 `voxel.frames = 0`）。旁观页已按 ABI 2 带目录建好世界、`?view=blocks` 已接好渲染；截图用的两个 Section 是页内取证脚本从 `acceptance-lakeside.cells.json` 编成载荷后交给页面自己的 `deliver()`（与 DS 帧同一条 request_section + deliver_section 路径、摘要由 wasm 算）。归属 LumioServer / Runtime 的 Section 订阅与下发链，不在本卡范围。

## 已知问题

1. 挨着不在本端 Section 的满格面是纯黑（石墙北面、地图四周）：契约 `meshOutput.vertex.light`「邻格所在 Section 不在本端时取本格自己的光照」，满格石头本格光照为 0。是契约口径，不是实现偏差。
2. 墙上火把水平伸出（ADR-124 D5 已知限制）；无天空盒与雾。
3. 目录里 742 行旧占位方块没有素材，每次加载各报一条 `description_missing` 告警（地图不用它们）。

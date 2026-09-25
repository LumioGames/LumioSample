# MC 导入：每份报告的来历

这里的每份 `*.import-report.json` 都是 LumioVoxelEngine `lumio-voxel-mc-import assess` 的真实产出（ADR-124 D10 第 8 条：报告就是导入证据，`source` 段就是来历）。本目录只放映射表、报告和说明；**MC 存档、区域文件、转出的 `.voxel`、MC 原版贴图与模型一律不入本仓**（ADR-124 D9）。

公共参数（两份相同）：

- 工具：LumioVoxelEngine `crates/lumio-voxel-mc-import`，release 构建；报告 `tool` 字段为 `lumio-voxel-mc-import 0.0.0`。prismarine 那份由 PR #84（R-00796）提交 `81aaf99` 产出；sample-house 那份由 ADR-124 审查 P2 修复（分支 `fix/adr124-review-p2`）提交 `abe4419` 重跑——该提交让 `gen-test-world` 按 MC 格式给实体区块写 `Position`、生物计数随区块过滤，小屋的 `entities/r.0.0.mca` 字节因此变了，报告其余内容不变；同一提交重跑 prismarine 与原报告逐字节相同。
- 映射表：本目录 `mc-mapping.json`（由 `Tools/mc-mapping.mjs` 生成），sha256 `8e78b3e918fca860ae32e1a93283595488d0a40a49ca95490d82f141e8fa9f40`。
- 目录：`Server/Assets/Maps/official-catalog.json`（C8 合入的 v2），sha256 `e4d81595ef179f5071cf1d8fc13b985cf83d6fbd39a579df035a391e3ef2a1bf`。
- 严格模式（没有 `--lenient`），`--y-window` 取默认 `-64`（MC Y `[-64, 191]` → 我们的 `[0, 255]`），不裁 `--bbox`，`--origin 0,0`，只读 `Status=minecraft:full` 的区块。

## prismarine-1.21.1（自然地形）

| 项 | 值 |
| --- | --- |
| 报告 | `prismarine-1.21.1.import-report.json`，sha256 `c0a2dcd2416ce102a57c3ef3c961be2abfb0eab0cb2e908603279c16a997087b` |
| MC 版本 / DataVersion | Java 1.21.1 / 3955 |
| 来源 | GitHub `PrismarineJS/prismarine-provider-anvil`（默认分支 `master`，最近改动该目录的提交 `19bb778da80bb600cac9ee9d9f47f1d477e9b0cd`）路径 `test/fixtures/1.21.1/r.0.0.mca` |
| 区域文件 | `r.0.0.mca`，1,056,768 字节，sha256 `d48fc0cd4750c8f56d8b729caba4563c163d788268900641abc1ec560b02d4bf` |
| 许可 | MIT（上游 `package.json` 的 `license` 字段；上游没有单独的 LICENSE 文件）。区域文件本身不在本仓；它作为测试夹具连同来历与 MIT 声明放在 LumioVoxelEngine `crates/lumio-voxel-mc-import/tests/fixtures/prismarine-1.21.1/` |
| 区块 | 225 个里 16 个是 full（`chunksRead` 16，`chunksSkippedUnfinished` 209）；非空气 MC Y 范围 -64..82 |
| 窗口参数 | 默认 `-64`，窗口外 0 格 |

命令：

```bash
lumio-voxel-mc-import assess --input r.0.0.mca \
  --mapping Server/Assets/Maps/mc-import/mc-mapping.json \
  --catalog Server/Assets/Maps/official-catalog.json \
  --report Server/Assets/Maps/mc-import/prismarine-1.21.1.import-report.json
```

这份报告与 LumioVoxelEngine 同一工具测试里的快照 `tests/fixtures/prismarine-1.21.1.import-report.json` 逐字节相同（两边的映射表与目录夹具也逐字节相同）。

## sample-house（建筑小样）

| 项 | 值 |
| --- | --- |
| 报告 | `sample-house.import-report.json`，sha256 `8075f4a40ffe1526ffbe1bfa1ff2f9b7585aade7579eefcf717c935800f37937` |
| MC 版本 / DataVersion | 不是 MC 生成的存档：由工具的测试代码合成（`lumio-voxel-mc-import gen-test-world`，`src/testgen.rs` 的 `sample_house()`），区块按 1.18+ 结构写，DataVersion 3700（相当于 Java 1.20.4） |
| 来源 | 我们自己的测试数据，就是 C10 golden 测试用的那座小屋：门的上下两格、橡木与云杉楼梯（含直梯、外转角左、倒放内转角右）、墙上火把、水源头与 level 3、含水台阶、一个箱子（方块实体）、一头牛（生物）、负坐标区块、一格窗口外的石头 |
| 区域文件 | `region/r.-1.-1.mca` sha256 `af9760257ac22d16c3ae5545d880a24ae4348812738ce0ca76a4558b19642fd4`；`region/r.0.0.mca` sha256 `79b0b1ea2757b6c4a051c7580347bab484693f23dc911abc67af913043515d58`；`entities/r.0.0.mca` sha256 `8a9b9dc49e62119df327cbf3a0a1a71f9efb3cfb985dbbb7e553ebc471faa852` |
| 许可 | 本项目自产数据，不含任何 MC 资源 |
| 区块 | 2 个，全部 full；非空气 MC Y 范围 56..200 |
| 窗口参数 | 默认 `-64`，窗口外 1 格（y 200 那格石头，专门用来测窗口） |

命令：

```bash
lumio-voxel-mc-import gen-test-world <dir>
lumio-voxel-mc-import assess --input <dir> \
  --mapping Server/Assets/Maps/mc-import/mc-mapping.json \
  --catalog Server/Assets/Maps/official-catalog.json \
  --report Server/Assets/Maps/mc-import/sample-house.import-report.json
```

## 为什么只有这两份

原计划「地形 / 村庄 / 建筑」各一张；主会话 2026-09-26 改为 prismarine 自然地形一份 + 工具 golden 小屋一份。

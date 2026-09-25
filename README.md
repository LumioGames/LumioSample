# 示例（Lumio Sample）

> Lumio 引擎的参考实现。最基础的一款 Lumio 游戏——不追求好玩，只把引擎每个接缝走一遍。

这个仓有三个用途：

1. **照着抄**——想用 Lumio 做游戏，从这里开始读：一个游戏组从零开始用引擎所需的每个接缝，这里都有可抄的样板。
2. **当模板**——新游戏直接 `gh repo create --template`，在这个骨架上往下做。
3. **当尺子**——它是引擎的端到端回归基准：一条命令跑完全程、两轮同底图逐位同哈希；也是 Dedicated Server（`lumio-ds`）第一个真实的端到端启动器。

引擎以编好的二进制随子模块 [`Engine/`](#引擎从哪来) 进来（公开仓 `LumioEngineRelease` 的一个版本），不需要任何引擎源码或私有仓权限。

## 玩法一句话

登录进场 → 跑动 → 挥镐挖矿脉 → 挖穿了方块变空气 → 掉出矿石 → 走过去捡 → 旁人同帧看到 → 顺便能聊天。
关服再开，地图还是你挖过的样子，矿石也还在。

没有战斗，没有胜负，没有美术。要看战斗怎么写，去看炸弹人。

## 它教什么（十四步）

```text
编译配表 → 注册登录 → 起 DS（加载配表快照）→ 进房间 → 加载底图 / 从存档恢复 → 玩家入场
  → 跑动 → 聊天 → 挖掘 → 矿脉储量 -1 → 归零则方块变空气 → 掉出矿石 → 走过去捡
  → 存档 → 关服重启 → 地图缺口与矿石数都还在 → 两轮同底图同哈希
```

每一步对应引擎的一个接缝，逐步导览在 [`sample-tour.md`](.spec/knowledge/features/sample-tour.md)。其中最要紧的教学点是**世界模型的四类东西各出现一次**：

| 东西 | 是什么 | 在示例里 |
|---|---|---|
| 地板、硬墙、矿石格 | **体素**（静态、不动、没有服务器逻辑） | 底图里的方块，只有方块类型 |
| 玩家、掉落的矿石 | **CS 实体**（会动或要服务器逻辑，同步给客户端） | 玩家带位置 / 属性 / 技能；矿石被捡走就销毁 |
| 矿脉的剩余储量 | **体素 + 实体两半**（既不动、又有服务器逻辑） | 格子里写方块类型，储量挂一个实体，两半只经一条稀疏引用相连——**不在体素里存业务数据** |
| 挖掘火花 | **Local 实体**（只有客户端表现，服务器不知道） | 只在客户端文件里声明的普通实体，客户端自己创建，不上网 |

跑动与挖掘是 GAS 技能，拾取是瞬时 Effect；数值全部来自配表，源码里没有数值字面量。

## 五分钟跑起来

**前置条件**：git、.NET SDK（版本见 [`global.json`](global.json)）、Node.js 22、Docker（第 2 步「注册登录」要起 Platform）。

```bash
git clone --recursive https://github.com/LumioGames/LumioSample && cd LumioSample
dotnet build LumioSample.slnx
dotnet test  LumioSample.slnx

# 十四步一条命令：没给 --origin 时自己用 Engine/platform 的 compose 起 Platform，跑完删掉
dotnet build Client/Bots/Lumio.Sample.Bots.csproj
node Tools/launcher.mjs --bots 2 --stagger-ms 250 --scenario-dll Client/Bots/bin/Debug/net10.0/Lumio.Sample.Bots.dll
```

**clone 时漏了 `--recursive`**：`dotnet build` 会以 `LUMIO_SDK_UNRESOLVED` 失败并打印要跑的命令；启动器会自己先跑一次。手动补：

```bash
git submodule update --init --depth 1 Engine
```

缺 Docker / 发布物不含本机平台 / 其他前置条件时，启动器逐步打印 `step=NN` 并以 `BLOCKED_ENV`（exit 2）退出、点名缺的东西，不会假绿。[`Tools/`](Tools/) 里是启动器、账号客户端、证据对账和世界断言，见 [`Tools/README.md`](Tools/README.md)。

## 引擎从哪来

`Engine/` 是只读的 git 子模块，指向公开仓 [`LumioEngineRelease`](https://github.com/LumioGames/LumioEngineRelease) 的一个正式 tag（ADR-123）。一个 tag 就是一整套引擎：SDK 包（`sdk/`）、`lumio-ds` 与托管闭包（`server/<rid>/`）、Bot 宿主（`bot/<rid>/`）、旁观页引擎零件与体素 wasm（`web/`）、运行编排脚本（`tools/`）、Platform 的 compose（`platform/`，镜像同版本公开发布），以及记下源码提交号与每个文件 sha256 的 `manifest.json`。

- **编译**：`Directory.Build.targets` 只认 `Engine/sdk/` 作 `Lumio.Engine.SDK` 的包源（[`NuGet.config`](NuGet.config) 用 package source mapping 限定），版本读 `Engine/manifest.json` 的 `version`；第三方包照常走 nuget.org。没有同级仓、global-packages 或 nuget.org 的第二条路。
- **运行**：启动器从 `Engine/` 取引擎那一半、从本仓取玩法 / 配表 / 地图，运行目录落在已 gitignore 的 `.run/`；先用发布物自带的 `Engine/tools/verify-release.mjs` 校验本机平台，发布物不含本机平台时 `BLOCKED_ENV` 点名，不拿别的平台凑。
- **升级引擎**：

  ```bash
  node Tools/update-engine.mjs 0.0.2     # 浅取 tag v0.0.2 → 用新版自带的 verify-release 校验 → 切换并暂存子模块指针
  git commit -m "engine: v0.0.2" -- .gitmodules Engine
  ```

  tag 不存在或校验不过时指针不变。引擎不承诺跨大版本兼容；升级后编不过的玩法代码由本游戏自己改。

`Server/Config/Startup/server.json` 是可运行的 DS 模板（`runtime+voxel` + `snapshot_only`，并要求 `base_map_*`）：只写本仓自己的玩法程序集，引擎一半由启动器从 `Engine/server/<rid>/` 填；准入公钥是 Platform release compose 的本地公钥；本机覆盖在 gitignored 的 `.run/server.local.json`。填我用的 `replace-*` 留在 `Server/Config/Startup/server.sample.json`，未填时报响亮缺值。[`Tools/compose/`](Tools/compose/README.md) 放本游戏给 Platform 的三样输入（分配、目录种子、大厅包）。

**这棵树不写锁文件**（`RestorePackagesWithLockFile=false`）：`Lumio.Engine.SDK` 的版本随子模块指针走，引擎回归还会临时把 `Engine/` 换成同布局的 main 现编产物，钉进锁文件的哈希会让那些 restore 报 `NU1403`。

## 现在到哪儿了

- 玩法声明已在 `Gameplay/`：世界 / 玩家 / 聊天 / 跑动技能 / 矿脉储量 / 掉落 / 拾取 Effect。数值在两端的 `Config/Tables/*/*.json`（源表在 `Gameplay/Tables/`）。
- 一条命令的启动器是 `node Tools/launcher.mjs --bots N`，十四步只有它一个驱动：第 1 名 Bot 跑 `SampleMiningScenario`（`--scenario-dll`），第 05–13 步只凭 DS 日志与该 Bot 的 `result.ndjson` 判，结果文件缺了就是 FAIL；第 14 步在同一份存储上重启 DS，让同一账号以 `SampleRestoreVerifyScenario` 核对世界。它默认给每名 Bot 带上 `--voxel-config Server/Assets/Maps/bot-voxel-budget.json`：这个房间是 `world_profile=runtime+voxel`，**不带体素预算的 Bot 收到第一帧 SectionFrame 就 `session_faulted`**，那是 ADR-112 修订 2 ⑨ 的 fail-closed 设计行为不是缺陷（详见 [`sample-tour.md` 第 4 步](.spec/knowledge/features/sample-tour.md)）。旁观者、纯移动压测这类本就不该拥有体素世界的跑法用 `--voxel-config off`，但那只对不发 Section 的房间成立。
- `Server/Assets/Maps/sample.voxel` 是 Engine capture CLI 产出的可 restore Cube 平面快照（DS 开机只 restore，不重算地形）。

**还没有的**：`Engine/` 还没钉到第一个正式版本（`v0.0.1`，R-00782）——在那之前 `Engine/` 是空的，`dotnet build` 按设计报 `LUMIO_SDK_UNRESOLVED`，内部开发者用架构仓的 `pack-release --from-main` 填它（见 [`AGENTS.md`](AGENTS.md)）；用启动器对着发布物跑通十四步；100 人移动压测的五条实测证据。

**怎么安排**：2026-09-07 架构讨论把整个里程碑逐题拍板，记录在 [`.spec/plans/2026-09-07-sample-milestone-architecture-rulings.md`](.spec/plans/2026-09-07-sample-milestone-architecture-rulings.md)（架构仓副本；其中关于外部可用性与 Platform 镜像的那条已被 ADR-123 取代）。要点：

- 客户端形态：十四步由 **C# Bot** 执行（引擎的无渲染客户端宿主 + 本仓交的场景类与输入映射）；**浏览器是最终的核心验收场景**，第一阶段先旁观。
- 一条命令的真拓扑：平台（账号 + 进房票，PostgreSQL 走 docker compose）→ `lumio-ds` → N 个 Bot → 浏览器旁观。
- 地图是**数据**：底图是一份体素快照文件（一次性脚本经引擎写格再导出，产物不手改），服务器开机加载；不做程序化生成。
- 配表是**文件**：编译出 JSON，引擎生成只含类型的 C# 读表代码，开机装载一次、帧内不可变。

## 仓库结构

| 目录 | 放什么 |
|---|---|
| [`Engine/`](#引擎从哪来) | 只读子模块：引擎发布物（`LumioEngineRelease` 的一个 tag）。不在这里改任何东西 |
| [`Client/`](Client/) | 客户端侧：Application / Bots / UI，以及 `Config/`（`C` 投影表与生成 Reader）|
| [`Server/`](Server/) | **只放数据**：`Config/`（启动配置、`S`+`V` 投影表、生成 Reader）、`Assets/Maps/`、`Tests/`。服务端程序在 `Engine/server/<rid>/` |
| [`Gameplay/`](Gameplay/) | 玩法程序集。服务器与客户端两端共用；`Tables/` 是配表源 |
| [`Tools/`](Tools/) | 一键启动器、引擎更新命令、Platform 的游戏输入、日志、两轮哈希对账与测试工程 |
| [`.spec/`](.spec/AGENTS.md) | 本仓的规范、决策与导览（[`sample-tour.md`](.spec/knowledge/features/sample-tour.md) 逐步导览） |

## 契约来源

**要查字段、错误码或消息 ID，看 SDK 包带的公开使用面**——XML doc，加上由引擎的 ABI 与 wire 契约单源生成的公开 API / 错误码参考（`content/docs/public-api.md`、`error-codes.md`），随 `Engine/sdk/` 里的 `Lumio.Engine.SDK` 包一起分发。用这个仓当模板的人不需要引擎仓的权限。

**本仓不复述任何公共契约字段**，只写「在示例里这条契约怎么用」。

## 许可证

本仓有**两层许可**：

1. **本仓自己的代码与数据**（`Engine/` 以外的一切）采用 **Apache License 2.0**——见 [LICENSE](LICENSE)。你可以自由 fork、修改、二次创作，并用它开发和商业运营你自己的游戏，无需额外授权。
2. **`Engine/` 下的引擎二进制**（`LumioEngineRelease`，含 `Lumio.Engine.*`、`Lumio.GameRuntime.*`、`lumio-ds`、Bot 宿主、Platform 镜像等）采用 **Business Source License 1.1（BUSL-1.1）**，条款见 `Engine/LICENSE`，独立于本仓：
   - ✅ 允许：用它开发、发行、商业运营你自己的游戏与游戏内容
   - ❌ 不允许：用它对外提供游戏引擎、游戏开发套件、运行时、服务端框架等与之竞争的面向开发者的产品或服务
   - 2030-09-07 自动转为 Apache License 2.0

`Client/Assets/Blocks/` 的贴图为 CC0（见该目录 LICENSE / SOURCES.md）。

# 示例（Lumio Sample）

> Lumio 引擎的参考实现。最基础的一款 Lumio 游戏——不追求好玩，只把引擎每个接缝走一遍。

这个仓有三个用途：

1. **照着抄**——想用 Lumio 做游戏，从这里开始读：一个游戏组从零开始用引擎所需的每个接缝，这里都有可抄的样板。
2. **当模板**——新游戏直接 `gh repo create --template`，在这个骨架上往下做。
3. **当尺子**——它是引擎的端到端回归基准：一条命令跑完全程、两轮同底图逐位同哈希；也是 Dedicated Server（`lumio-ds`）第一个真实的端到端启动器。

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

每一步对应引擎的一个接缝，逐步导览在 [`docs/tour.md`](docs/tour.md)。其中最要紧的教学点是**世界模型的四类东西各出现一次**：

| 东西 | 是什么 | 在示例里 |
|---|---|---|
| 地板、硬墙、矿石格 | **体素**（静态、不动、没有服务器逻辑） | 底图里的方块，只有方块类型 |
| 玩家、掉落的矿石 | **CS 实体**（会动或要服务器逻辑，同步给客户端） | 玩家带位置 / 属性 / 技能；矿石被捡走就销毁 |
| 矿脉的剩余储量 | **体素 + 实体两半**（既不动、又有服务器逻辑） | 格子里写方块类型，储量挂一个实体，两半只经一条稀疏引用相连——**不在体素里存业务数据** |
| 挖掘火花 | **Local 实体**（只有客户端表现，服务器不知道） | 只在客户端文件里声明的普通实体，客户端自己创建，不上网 |

跑动与挖掘是 GAS 技能，拾取是瞬时 Effect；数值全部来自配表，源码里没有数值字面量。

## 现在到哪儿了

**今天能做的**：

- 同级开发：设置 `LumioRuntimeRoot` 后 `dotnet build` / `dotnet test`（CI 的 `build` / `test` 作业这样验）。
- 包消费：CI `external-clone` 每次用架构仓现打的 `Lumio.Engine.SDK` nupkg 编过。Owner 还没把这个包发到 nuget.org，所以干净机器上裸 `git clone && dotnet build` 会得到 `LUMIO_SDK_UNRESOLVED`——这是闸门，不是静默降级，也不是「外部 clone 已经能编」。
- 用它当模板建新仓。
- 读 [`docs/tour.md`](docs/tour.md) 看十四步各对应引擎哪个接缝。
- 玩法声明已在 `src/Lumio.Sample.Gameplay/`：世界 / 玩家 / 聊天 / 跑动技能 / 矿脉储量 / 掉落 / 拾取 Effect。数值在 `config/*.json`。
- 一条命令的启动器是 `node integration/launcher.mjs --bots N`。没有 Platform / `lumio-ds` / Bot.Host 时它会逐步打印 `step=NN` 并以 `BLOCKED_ENV`（exit 2）退出，不会假绿。

**还没有的**：对着真 Platform + DS + C# Bot 跑通十四步；可 restore 的底图；100 人移动压测的五条实测证据；存档冷恢复。`maps/sample.voxel` 仍是占位，不能当底图用。旧的程序化地图生成器已删除。

**怎么安排**：2026-09-07 架构讨论把整个里程碑逐题拍板，记录在 [`.spec/plans/2026-09-07-sample-milestone-architecture-rulings.md`](.spec/plans/2026-09-07-sample-milestone-architecture-rulings.md)（架构仓副本）。要点：

- 客户端形态：十四步由 **C# Bot** 执行（引擎的无渲染客户端宿主 + 本仓交的场景类与输入映射）；**浏览器是最终的核心验收场景**，第一阶段先旁观。
- 一条命令的真拓扑：平台（账号 + 进房票，PostgreSQL 走 docker compose）→ `lumio-ds` → N 个 Bot → 浏览器旁观。
- 地图是**数据**：底图是一份体素快照文件（一次性脚本经引擎写格再导出，产物不手改），服务器开机加载；不做程序化生成。
- 配表是**文件**：编译出 JSON，引擎生成只含类型的 C# 读表代码，开机装载一次、帧内不可变。
- 外部性边界：干净机器、无同级仓时，今天的外部验收是 `LUMIO_SDK_UNRESOLVED`（包未发布）和 CI `external-clone`（现打 nupkg 再编）。裸 `git clone && dotnet build` 在 nuget.org 有包之前不会绿。**一条命令跑完全程第一阶段是内部验收**（平台镜像未公开）。查契约走 SDK 包带的公开使用面，不是回私有仓读。
- 前置的引擎卡横跨六个仓，按 wave 0–3 排；本仓的实现卡随各 wave 落地。第一阶段的示例是残的（挖不动石头），不当教学材料对外发。

## SDK 解析（S-2）

玩法工程通过双路径解析引擎依赖。`Directory.Packages.props` 登记了 `Lumio.Engine.SDK` `0.1.0`，由 `Directory.Build.targets` 根据环境在 nuget 模式下自动注入 `<PackageReference Include="Lumio.Engine.SDK" />`。

双路径（`Directory.Build.targets`）：

1. 内部开发：设置 `LumioRuntimeRoot` 指向同级仓。目录存在时注入 Runtime `ProjectReference`（Ecs / Replication / Gas）并跑 `gen-declarations`。空值不是静默降级。
2. 外部：从 nuget.org restore `Lumio.Engine.SDK`（Owner 未发布前不可用）。已 restore 的 global-packages 或 `LumioLocalFeed` nupkg 视为 NuGet 路径。
3. 本地证明：Architecture `node eng/pack-sdk.mjs` 产出 nupkg 后，用 `LumioLocalFeed` 或 NuGet.config folder source。

若两条路径均未命中，构建将失败并输出 `LUMIO_SDK_UNRESOLVED` 检查清单，强制必须选择内部同级仓路径或外部 SDK 包路径之一。

**这棵树不写锁文件**（`Directory.Packages.props` 的 `RestorePackagesWithLockFile=false`）。理由：folder-feed / global-packages 两条路径拿到的 `Lumio.Engine.SDK` 是本地现打的包，`node eng/pack-sdk.mjs` 不产出逐字节确定的 nupkg，打包机器或时间一变 contentHash 就变，钉进锁文件的哈希会让下一次 restore 报 `NU1403`。等这个包正式发到 nuget.org（哈希不可变）之后再回来钉哈希，届时把口径与 `R-00519` 的「包字节可复现」冻结结论对齐。

## 五分钟跑起来

```bash
git clone https://github.com/LumioGames/LumioSample && cd LumioSample
# sibling Runtime，或把现打的 nupkg 指给 LumioLocalFeed：
dotnet build LumioSample.slnx
dotnet test  LumioSample.slnx

# 内部一条命令。缺 Platform / lumio-ds / Bot.Host 时 exit 2，BLOCKED_ENV。
node integration/launcher.mjs --bots 2 --stagger-ms 250
```

[`integration/`](integration/) 里是启动器、账号客户端、证据对账和世界断言，见 [`integration/README.md`](integration/README.md)。已退役的正式 DS smoke 不要再当启动器。

> **一条命令跑完全程第一阶段只在引擎组的内部机器上跑得起来**：这条链要起账号平台，而平台镜像现在是从私有仓源码构建的，外部机器拿不到 compose 文件（见 [`integration/compose/README.md`](integration/compose/README.md)）。让外部也能一条命令跑通，排在对外发布前做。
> 上面的 `dotnet build` / `dotnet test` 在 sibling 或本地/CI 现打的 SDK feed 下绿。干净机器且 nuget.org 还没有包时，应看到 `LUMIO_SDK_UNRESOLVED`。CI 的 `external-clone` 每次现打再编，证明消费链通，不是证明裸 clone 就能编。

## 仓库结构

| 目录 | 放什么 |
|---|---|
| [`src/`](src/) | 玩法程序集。服务器与客户端两端共用 |
| [`tests/`](tests/) | 单元测试 |
| [`config/`](config/) | 源配表与 schema。编译后由 typed Table Reader 读 |
| [`integration/`](integration/) | 一键启动器、日志与两轮哈希对账 |
| [`docs/`](docs/) | [`tour.md`](docs/tour.md) 逐步导览 |
| [`.spec/`](.spec/AGENTS.md) | 本仓的规范、决策与计划 |

## 契约来源

**要查字段、错误码或消息 ID，看 SDK 包带的公开使用面**——XML doc，加上由引擎的 ABI 与 wire 契约单源生成的公开 API / 错误码参考，随 `Lumio.Engine.SDK` NuGet 包一起分发。用这个仓当模板的人不需要引擎仓的权限。

**本仓不复述任何公共契约字段**，只写「在示例里这条契约怎么用」。

> 现状：SDK 包内已包含公开使用面文档（`content/docs/public-api.md`、`error-codes.md`）与托管 XML 文档。更深层的事实源仍位于架构仓 `LumioGameEngine`（私有）——ABI 在 `engine/abi/native-abi.json`，线上语义在 `engine/wire/*.json`，设计概要在 `.spec/knowledge/features/`。

## 许可证

本仓库是 **示例仓库**，采用 **Apache License 2.0** —— 见 [LICENSE](LICENSE)。
你可以自由 fork、修改、二次创作，并用它开发和商业运营你自己的游戏，无需额外授权。

> ⚠️ **引擎本体不在本许可证范围内。** 本仓库所依赖的 Lumio 引擎（`Lumio.Engine.*`、`Lumio.GameRuntime.*` 等）单独采用 **Business Source License 1.1（BUSL-1.1）**，条款独立于本仓库：
>
> - ✅ 允许：用它开发、发行、商业运营你自己的游戏与游戏内容
> - ❌ 不允许：用它对外提供游戏引擎、游戏开发套件、运行时、服务端框架等与之竞争的面向开发者的产品或服务
> - 2030-09-07 自动转为 Apache License 2.0
>
> 完整条款见引擎分发物随附的 LICENSE 文件。

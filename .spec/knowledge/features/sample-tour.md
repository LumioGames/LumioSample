---
name: sample-tour
description: 十四步逐步导览——每步对应的本仓文件与行号、应该看到的日志、缺依赖时的 BLOCKED_ENV 口径;照着走一遍十四步或改启动器步骤时查
metadata:
  type: doc
  status: 实施中
---

# 导览：十四步走完一款 Lumio 游戏

这份导览按真实文件与行号记录示例游戏的十四步。需求真值在架构仓；本文不复述引擎契约字段。

十四步只有一个驱动：[`Tools/launcher.mjs`](../../../Tools/launcher.mjs)。第 1 名 Bot 是**导览 Bot**，跑 `SampleMiningScenario`（`LUMIO_SCENARIO_DLL`）；第 05–13 步在它跑完后**只看它留下的东西**判——DS 标准输出与日志目录、它自己的生命周期日志和 `result.ndjson`（判据在 [`tour-steps.mjs`](../../../Tools/tour-steps.mjs)）。第 14 步等 DS 打出导览 Bot 完成之后才开始的那次 checkpoint，停 DS，在同一份存储上重启，再让同一账号以 `SampleRestoreVerifyScenario` 重新进房核对世界。其余 Bot 是陪跑的 fleet。缺依赖时启动器印 `step=NN status=BLOCKED_ENV` 并以 exit 2 离开——那不是通过。第 04 步只有 Bot 日志出现 `session state changed … Active … established` 才 PASS；进程起来不算入房。

**结果文件缺了、空了、或者截断在 run 记录之前，读它的每一步都是 FAIL**：`BotAssertionSink` 只记失败的名字，所以「结果里没有某个失败名」只有在 assert 记录真的存在时才算证据。每次运行自己的 `bot-N/`、`ds-boot-N/` 与存储目录在开跑前清空或新建，复用的证据目录里上一轮的文件不会被当成这一轮的证据。

| 步 | 做什么 | 本仓落点 |
|---|---|---|
| 1 | 编译配表 | [`Server/Config/Tables/manifest.json`](../../../Server/Config/Tables/manifest.json) · [`SampleTables`](../../../Gameplay/Config/SampleTables.cs) |
| 2 | 注册登录 | [`account-client.mjs`](../../../Tools/account-client.mjs#L313) |
| 3 | 起 DS | [`Server/Config/Startup/server.json`](../../../Server/Config/Startup/server.json#L24) · [`launcher.mjs`](../../../Tools/launcher.mjs) |
| 4 | 进房间 | [`parseBotAdmit`](../../../Tools/launcher.mjs) · [`collectLaunchTickets`](../../../Tools/launcher.mjs) |
| 5 | 加载底图 | [`Server/Assets/Maps/sample.voxel`](../../../Server/Assets/Maps/sample.voxel) · [`capture-basemap.mjs`](../../../Tools/capture-basemap.mjs) |
| 6 | 玩家入场 | [`PlayerEntity`](../../../Gameplay/EntityTypes/PlayerEntity.cs#L8) |
| 7 | 跑动 | [`MoveAbility.SetLocalPosition`](../../../Gameplay/Abilities/MoveAbility.cs#L136) |
| 8 | 聊天 | [`ChatComponent.SendMessage`](../../../Gameplay/Components/Chat/ChatComponent.cs#L10) |
| 9–14 | 挖掘到存档 | [`SampleMiningScenario`](../../../Client/Bots/SampleMiningScenario.cs) · [`SampleRestoreVerifyScenario`](../../../Client/Bots/SampleRestoreVerifyScenario.cs) · 判据 [`tour-steps.mjs`](../../../Tools/tour-steps.mjs) |

> 两轮同底图哈希对账（S-7）贯穿全程，不单列一步。[`verify-evidence.mjs`](../../../Tools/verify-evidence.mjs) 读两轮独立目录的日志，并经 [`world-assert.mjs`](../../../Tools/world-assert.mjs) 核对格子与矿石数。

## 第 1 步：编译配表

数值在 [`Server/Config/Tables/server/movement.json`](../../../Server/Config/Tables/server/movement.json)、[`Server/Config/Tables/server/mining.json`](../../../Server/Config/Tables/server/mining.json)、[`Server/Config/Tables/server/attributes.json`](../../../Server/Config/Tables/server/attributes.json)，由 [`manifest.json`](../../../Server/Config/Tables/manifest.json) 钉指纹。[`SampleTables`](../../../Gameplay/Config/SampleTables.cs) 经 Runtime M9 装载 typed Reader，不扫父目录。

世界单例声明在 [`WorldEntity.cs` 第 7 行](../../../Gameplay/EntityTypes/WorldEntity.cs#L7)：`TickRateHz = 20`。生成注册表把同一数字写进 [`GeneratedRegistry.DeclaredTickRateHz`](../../../Gameplay/generated/server/Lumio.Sample.Gameplay.Registry.g.cs#L66)。

**今天能跑**

```bash
dotnet build LumioSample.slnx
node --test Server/Tests/Gameplay  # 或 dotnet exec 该测试 DLL
```

**应该看到的日志**

- 启动器：`step=01 status=READY LumioConfig export + typed Reader via M9 loader`
- 没有 `1.25` / `0.35` 等配表数字出现在玩法 `.cs` 里（`SampleTablesTests` 会扫）

## 第 2 步：注册登录

账号走 LumioPlatform 的 WebSocket `/account`（子协议 [`lumio-account-v1`](../../../Tools/account-client.mjs#L33)，[`LoginOrRegister`](../../../Tools/account-client.mjs#L34)）。进房票只来自 [`loginAndLaunch`](../../../Tools/account-client.mjs#L313) 调用的 `POST /api/games/sample/launch`——本仓不自签票据。口令来自 `LUMIO_ACCOUNT_PASSWORD` 或本轮生成，不入库、不进日志。`Bot*` 登录名必须带 Platform 签发的 `LUMIO_BOT_TOOL_CREDENTIAL`。

**今天能跑**

```bash
node --test Tools/account-client.test.mjs
```

**应该看到的日志**

- hermetic 测试通过；CLI 摘要只有 AccountId / 绑定字段，没有口令
- 没给 `--origin` 时启动器自己用 `docker compose -f Engine/platform/docker-compose.yml` 起 Platform（游戏输入是 [`Tools/compose/`](../../../Tools/compose/README.md) 的三样），跑完 `down -v`；没有 Docker：`step=02 status=BLOCKED_ENV docker compose is not available …`；`--no-platform`：`step=02 status=BLOCKED_ENV no Platform …`（[launcher.mjs](../../../Tools/launcher.mjs)）
- 真 Platform 换票成功时：启动器继续第 3 步，日志里仍不得出现口令或 admission ticket 明文（`redact` / `summarizeSession`）

## 第 3 步：起 DS

[`Server/Config/Startup/server.json`](../../../Server/Config/Startup/server.json) 是**模板**：启动器每次运行把它抄成证据目录里的 `server.boot-1.json` / `server.boot-2.json`——相对路径先按模板所在目录变成绝对路径，存储换成这次运行新建的目录，日志目录每次开机各一个、级别 `debug`（第 07 步要数 `host.operation_result`），allocation 六项取 Platform launch 应答。CLR 文件的引擎一半只从 `Engine/server/<rid>/` 来（ADR-123）：`SDK/Native/<rid>/` 的 native、`Application/Lumio.Server.HostEntry.dll`（同目录的 `.runtimeconfig.json` 一起用）、`SDK/Managed/` 的 Replication / Ecs；hostfxr 取本机 dotnet；模板只写本仓自己的玩法程序集。任何一个不是文件就 `BLOCKED_ENV` 点名字段与路径，不回落到别处。模板的 `admission_public_key_hex` 是 Platform release compose 本地准入私钥对应的公钥；对接别的 Platform 时用 `LUMIO_PLATFORM_ADMISSION_KEY` 替换。模板的 [`config_dir`](../../../Server/Config/Startup/server.json#L24) 指向本仓 `Server/Config/Tables/`（相对配置文件目录解析，ADR-115），玩法程序集路径指向本仓 `bin/`，[`world_profile`](../../../Server/Config/Startup/server.json#L25) 已冻成 `runtime+voxel`，[`durability`](../../../Server/Config/Startup/server.json#L26) 是 persistence-container-v1 的 `snapshot_only`（不是 `process-crash` / `power-loss`），并要求 `base_map_*`。allocation 是本机可跑的句法 stand-in，不是 Platform 票；填我用的 `replace-*` / `REPLACE_WITH_…` 留在 [`Server/Config/Startup/server.sample.json`](../../../Server/Config/Startup/server.sample.json)，未填时启动器第 03 步是响亮的 `MISSING_VALUE`（不是占位 `BLOCKED_ENV`）。本机覆盖是 gitignored 的 `.run/server.local.json`（`LUMIO_DS_CONFIG`），须抄这份公共词表。启动器经 `Engine/tools/process-tools.mjs` 拉起 `Engine/server/<rid>/lumio-ds`，并从 stdout 解析 [`DS_READY `](../../../Tools/ds-ready.mjs#L1)。

**今天能跑**

```bash
node --test Tools/ds-ready.test.mjs
node Tools/launcher.mjs --bots 2 --stagger-ms 250
```

**应该看到的日志**

- `Engine/` 是空的：启动器先自动执行一次 `git submodule update --init --depth 1 Engine`；仍是空的，第 02–14 步 `BLOCKED_ENV` 并带这条命令，exit 2
- 发布物不含本机平台：`BLOCKED_ENV this machine is <rid>, and Engine/manifest.json (v…) ships only […]`，不拿别的平台凑
- 发布物缺 `lumio-ds`：`step=03 status=BLOCKED_ENV …/Engine/server/<rid>/lumio-ds is missing from the Engine/ release.`（[launcher.mjs](../../../Tools/launcher.mjs)），exit 2——挡的是二进制，不是 `replace-*` 字符串
- 缺 CLR 文件：`step=03 status=BLOCKED_ENV DS config clr.<字段> is not a file (…)`，DS 不起
- 配置里还留着 `replace-*` / `REPLACE_WITH_PLATFORM_32_BYTE_PUBLIC_KEY_HEX`：`step=03 status=FAIL missing required value: …`（`MISSING_VALUE`），exit 1
- 真 DS 起来：一行 `DS_READY { "pid": …, "endpoint": "ws://127.0.0.1:…" }`，endpoint 不得带凭据或 query

## 第 4 步：进房间

启动器按 `--bots N` 规划 `Bot1`…`BotN`，错峰 `--stagger-ms`，每名 Bot 一张 [`loginAndLaunch`](../../../Tools/account-client.mjs#L313) 票。[`collectLaunchTickets`](../../../Tools/launcher.mjs) 拒绝复用。票交给发布物里的 `Bot.Host`（`Engine/bot/<rid>/Lumio.Client.Bot.Host.dll`），并带 `--gameplay`（`LUMIO_GAMEPLAY` 或本仓 `Lumio.Sample.Gameplay.dll`）。本仓不写场景类去顶替宿主接口。

### Bot 要进体素世界，必须带 `--voxel-config`

这个房间的 [`Server/Config/Startup/server.json`](../../../Server/Config/Startup/server.json) 冻在 `world_profile=runtime+voxel`，DS 会向每名 Bot 推 SectionFrame。**没带 `--voxel-config` 的 Bot 收到第一帧就 `session_faulted`**：`ClientSession.HandleSectionFrame` 里 `ResolveVoxelSink()` 为 null 就直接 `FailSession`。

**这是 ADR-112 修订 2 ⑨ 要的 fail-closed 行为，不是缺陷。** 没有体素预算的 Bot 拿不到 Section sink、关不了权威组、挂不上 GAS 联合预测；让它"忽略 SectionFrame 继续跑"就是 ADR-106 决策 1 明令禁止的静默降级——表面在动，实际什么都没预测。所以引擎选择响亮地停，而不是安静地假装。修复之前帧根本到不了 Bot，所以这条在 2026-09-22 端到端验证打通下行链之后才第一次被触发。

预算落在 [`Server/Assets/Maps/bot-voxel-budget.json`](../../../Server/Assets/Maps/bot-voxel-budget.json)，和它的 `catalogPath` 目标 [`Server/Assets/Maps/official-catalog.json`](../../../Server/Assets/Maps/official-catalog.json)（DS 用的同一份目录表）同目录——`BotVoxelConfig` 是**按预算文件自己所在目录**解析 `catalogPath` 的，不是按进程 cwd，所以两份文件一起搬也不会断。它不放 `Server/Config/Tables/`：那整棵树是 LumioConfig 的编译产物，`sync-config-export.mjs --check` 逐字节比对，手写文件进去会污染 `outputHash`。

按 ADR-101，这份文件**每个字段都得写满**，`prediction` 的九个限制一个都不能省——零是"显式关掉这项 Native 资源"的意思，和"没填"必须能区分，所以缺字段是拒绝而不是取默认值。数值依据见 [`Server/Assets/Maps/bot-voxel-budget.json` 的说明](#bot-体素预算的数值依据)。

启动器默认就带上它。要回到 entity-only 形态（旁观者、纯移动压测 Bot 这类本来就不该拥有体素世界的跑法）用 `--voxel-config off`（也认 `none` / `false` / `0` / 空值），或 `LUMIO_BOT_VOXEL_CONFIG=off`。**entity-only 只对不发 Section 的房间成立**；DS 配置的 `world_profile` 含 voxel 时（本仓这份 `Server/Config/Startup/server.json` 就是）启动器不放 entity-only 的 Bot 出去——第 04 步直接 `BLOCKED_ENV`、一个 Bot 都不起，否则每个 Bot 都会在第一帧 SectionFrame 上 fault。指了一个不存在的路径则是启动器当场报错，不会悄悄退回 entity-only。

**今天能跑**

```bash
node --test Tools/launcher.test.mjs
```

**应该看到的日志**

- 发布物缺 Bot.Host：`step=04 status=BLOCKED_ENV …/Engine/bot/<rid>/Lumio.Client.Bot.Host.dll is missing from the Engine/ release.`（[launcher.mjs](../../../Tools/launcher.mjs)）
- 注入两张相同票：测试失败，信息含 `unique`
- 真准入成功：每名 Bot 的滚动日志出现 `state=Active` 且 `reason=established`；进程启动、拒票、无 welcome 都不得把第 04 步标 PASS
- 日志经 redact，看不到 ticket

## 第 5 步：加载底图

底图是作者时 Capture 入库的规范快照，不由玩法程序集程序化生成，DS 开机只 restore。[`Server/Assets/Maps/sample.voxel`](../../../Server/Assets/Maps/sample.voxel) 是 Engine `eng/capture-voxel.mjs` 产出的 Cube 平面（W×D 石头地板 + 一圈硬墙 + 一片矿脉，尺寸与矿脉在 [`Server/Assets/Maps/sample.layout.json`](../../../Server/Assets/Maps/sample.layout.json)）。[`capture-basemap.mjs`](../../../Tools/capture-basemap.mjs) 只在作者时调用那条 CLI，玩法程序集与 DS 不得引用它。

启动器第 05 步要四样同时成立：`DS_READY` 的 `worldProfile` 是 `runtime+voxel`；第一次开机的日志有 `empty store: first boot opens the world from the configured base map`，且**没有** `recovered checkpoint outranks base_map_path`（新存储开出了旧存档就不是加载底图）；`admission baseline: wrote N SectionFrame` 且 N>0；导览 Bot 的 Active 行 `scopeActivated=True`。

[`verify-evidence.mjs`](../../../Tools/verify-evidence.mjs) 读取两轮独立目录的日志，逐位核对收录类别的 `eventOrder`（RPC 消息投递按 ADR-125 具名排除），`appliedTicks` 只查格式（非负、单调、成对，不做两轮比较），并经 [`world-assert.mjs`](../../../Tools/world-assert.mjs) 核对格子与矿石数。空日志或「哈希一致但世界错」都失败。

**今天能跑**

```bash
node --test Tools/verify-evidence.mjs
node --test Tools/capture-basemap.test.mjs
```

**应该看到的日志**

- 启动器：`step=05 status=PASS worldProfile=runtime+voxel; base map boot=true; SectionFrames written=4; bot scope active=true`
- 没设 `LUMIO_SCENARIO_DLL`：第 05–14 步 `BLOCKED_ENV LUMIO_SCENARIO_DLL is not set …`；所有 Bot 照常常驻，第 04 步照样能证明
- fixture `Tools/fixtures/oracle-min` 两轮比对退出码 0；空目录 FAIL

## 第 6 步：玩家入场

[`PlayerEntity`](../../../Gameplay/EntityTypes/PlayerEntity.cs#L8) 声明 Observer + Identity + LogicTransform + Chat + Ability + Attribute + Effect。Identity 只承接平台 accountId / 用户名；聊天说话人仍是 `NetEntityId` hex。直播入场是 DS 准入五步，不在本仓另写一套。

**应该看到的日志**

- 启动器在缺 Bot.Host 时第 6 步也是 `BLOCKED_ENV`（[launcher.mjs](../../../Tools/launcher.mjs)）
- 真入场后：导览 Bot 已准入，且它的 assert 记录里 `self_bound` 没有失败：`step=06 status=PASS admitted=true; self_bound held`

## 第 7 步：跑动

[`MoveAbility`](../../../Gameplay/Abilities/MoveAbility.cs#L17) 是唯一调用 [`SetLocalPosition`](../../../Gameplay/Abilities/MoveAbility.cs#L136) 的手写文件。步长与扫掠半径来自 [`Server/Config/Tables/server/movement.json`](../../../Server/Config/Tables/server/movement.json)。硬墙依赖 `IAbilityPhysicsPort`；端口缺失时拒绝本次位移、不写坐标。启动器第 07 步要导览 Bot 的 `move_activated` / `activation_accepted` / `bot_uplinked` 都成立，且 DS 至少一行 `outcome=Succeeded/Applied`（`debug` 级；有 fleet 时这一半是全房间的，不单指导览 Bot）。

**今天能跑**

```bash
dotnet exec Server/Tests/Gameplay/bin/Debug/net10.0/Lumio.Sample.Gameplay.Tests.dll
```

**应该看到的日志**

- `MoveAbilityTests` 通过；`SourceHygieneTests` 保证其它手写文件不再写坐标
- 启动器：`step=07 status=PASS move_activated+activation_accepted+bot_uplinked held; DS applied ops=N`
- 结果文件缺失：`step=07 status=FAIL no-result (no assert record in result.ndjson); DS applied ops=N`——DS 那一半再多也不够

## 第 8 步：聊天

共享声明在 [`ChatComponent.cs` 第 10 行](../../../Gameplay/Components/Chat/ChatComponent.cs#L10)（`chat.input`）。服务器把说话人写成 [`Entity.ToHex() + ": " + text`](../../../Gameplay/Components/Chat/ChatComponent.Server.cs#L23)，UTF-8 上限 512 是生成器写死的，不是玩法配表。导览 Bot 在第一次看到自己的那一帧经 registry 的 `chat.input` 映射发一行固定文本；启动器第 08 步要它的 `chat_activated` 成立，且 DS 日志里有**这一行文本**的 `says:`——fleet 的聊天不算。

**应该看到的日志**

- 启动器：`step=08 status=PASS chat_activated held; DS says line=true`
- 服务器信息日志形如 `{hex} says: sample tour: hello from the mining bot`（[Server 第 26 行](../../../Gameplay/Components/Chat/ChatComponent.Server.cs#L26)）
- 两轮同输入的 `eventOrder` 由 S-7 对账，不在本步另造哈希

## 一条命令

```bash
dotnet build Client/Bots/Lumio.Sample.Bots.csproj
node Tools/launcher.mjs --bots 2 --stagger-ms 250 --scenario-dll Client/Bots/bin/Debug/net10.0/Lumio.Sample.Bots.dll
```

引擎全部来自 `Engine/`（ADR-123）：`lumio-ds`、Bot.Host、进程管理脚本和 Platform 的 compose 都在发布物里，Platform 镜像是公开的 `manifest.json#platformImage`。前置条件只有 git、.NET SDK、Node、Docker。`forceCleanup` 不是通过证据。

## 第 9–14 步：挖掘到存档

第 09–13 步与前面一样只在导览 Bot 退出之后判，DS 一半读第一次开机的日志目录，Bot 一半读它的 assert 记录。数量只要求「至少一次」，不在启动器里写配表数值。

| 步 | 做什么 | DS 要看到 | 导览 Bot 的 assert 里要成立 |
|---|---|---|---|
| 9 | 挖掘 | `mining_stage txn=…` 与 `mining_pre txn=…` | `mine_activated` |
| 10 | 矿脉储量 -1 | `mining_applied txn=…` | `vein_dug_through` |
| 11 | 方块变空气 | `mining_post txn=… block=0` | — |
| 12 | 掉出矿石 | `mining_reward txn=… amount=N`，N>0 | `pickup_activated`（它只在复制过来的 census 里出现了 `oreDrop` 之后才发） |
| 13 | 拾取 | — | `pickup_activated` 与 `drop_collected`，且整份 assert 通过 |
| 14 | 存档重启 | 见下 | `SampleRestoreVerifyScenario` 整份通过 |

第 14 步：

1. 导览 Bot 退出的那一刻记下 DS 已经打出的 `DS_CHECKPOINT` 代数。
2. 等**第二次**更新的 checkpoint。DS 在一次存档**做完**时才打这一行，存档之间不重叠，所以完成之后打出的第一次可能是完成之前就开始的存档，快照里可能还没有拾取；第二次一定是完成之后才开始的。代数必须严格递增。等到超时或 DS 先退出都是 FAIL，而且不会重启。
3. 停 DS（Windows 没有跨进程 Ctrl+C，只能 kill；受审的是 checkpoint，不是 kill）。
4. 用同一份存储、另一个日志目录重启，同一账号用同一口令（本次运行的 `LUMIO_ACCOUNT_PASSWORD`，没设就是这次运行生成的那一个）重新 login + launch；launch 绑到的 allocation 与重启的 DS 不同就是 FAIL。
5. 以 `SampleRestoreVerifyScenario` 进房。PASS 要三样：重启日志有 `recovered checkpoint outranks base_map_path`、没有 `empty store: first boot …`，以及核对场景整份通过（3 条矿脉、0 个掉落）。开出一张全新底图时它看到 4 条矿脉，第 14 步 FAIL。

`--checkpoint-seconds` / `LUMIO_CHECKPOINT_SECONDS` 可以把本次运行的存档周期调短；不设就用模板的值。没有 Platform（`--no-platform` 且无 `--origin`）就无法重新准入，第 14 步 `BLOCKED_ENV`。

Bot* 登录名要 Platform 签发的 `LUMIO_BOT_TOOL_CREDENTIAL`。本地 release compose 的 bot-tool 公钥还是占位时，用 `--login-prefix` / `LUMIO_LOGIN_PREFIX` 换成普通命名空间的名字；重复跑同一组名字时设固定的 `LUMIO_ACCOUNT_PASSWORD`。

## 100 人压测门

`node Tools/stress-move.mjs` 写出 `verification.json` 的五条判据骨架。帧时钟必须是 NativeCore `clock_now`，Stopwatch 不算。未对着真 100 Bot / 5 分钟跑过之前，不得声称五条已过（R-00588 / ADR-084）。

`stress-move.mjs` 与 `spectator-100.mjs` 今天仍按 entity-only 形态起 Bot，没接 `--voxel-config`。对着本仓这份 `runtime+voxel` 的 `Server/Config/Startup/server.json`，它们同样会在第一帧 Section 上 fault；接线归各自的卡，不在本节的十四步启动器里。

## Bot 体素预算的数值依据

[`Server/Assets/Maps/bot-voxel-budget.json`](../../../Server/Assets/Maps/bot-voxel-budget.json) 是 JSON，装不下注释，而 `BotVoxelConfig` 又**拒绝任何未知字段**，所以依据记在这里。地图事实：`sample.layout.json` 是 32×32×16，Section 是 16³，`Server/Config/Startup/server.json` 的 `voxel_baseline_region` 是 `0,0,0..1,0,1`——**全图 4 个 Section**（`s:0:0:0` / `s:0:0:1` / `s:1:0:0` / `s:1:0:1`）。玩法事实：`Gameplay/Tables/tables/mining.txt` 的 `cooldown_ticks=1`，即 20 Hz 下每帧都可能压进一次挖掘预测。

| 字段 | 值 | 依据 |
|---|---|---|
| `catalogPath` | `official-catalog.json` | 与 `Server/Config/Startup/server.json` 的 `voxel_catalog` 同一份目录表。`BotVoxelConfig` 按**预算文件自己所在目录**解析相对路径，所以同目录的裸文件名最稳，不用 `..` 穿越 |
| `residentSectionBudget` | 8 | 全图 4 个 Section 是下限；取 2× 留余量。它进 Native 的 `PinBudget::new(8, 8)`，同时 `max_pinned_revisions = 64.max(8) = 64`，与 DS 侧同一档发布深度 |
| `receiptRetentionEntries` | 64 | 进 `WorldLimits.max_receipts`。**不能是 0**：`NativeVoxelProvider::create` 对 0 直接 `InvalidArgument`（ABI 口径是 1..u32::MAX，active 与 terminal 各 N、合计至多 2N）。终态回执按最旧优先回收，窗口只需覆盖在途 + 近期历史；64 在 20 Hz 最坏情况下约 3 秒 |
| `prediction.totalRetainedPayloadCeiling` | 65536 | **实测**下限。`lumio-voxel-world` 的 `required_retained_bytes()` 对下面这八项数值算出 **13424 字节**（本机跑真函数所得，非手算）；低于它 `OpenPrediction` 直接 `CapacityExceeded`。取 64 KiB ≈ 4.9× 余量。它只是开会话时的一次性分配闸门，不按上限预留内存，所以余量不花运行时代价 |
| `prediction.maxRecords` | 32 | 未确认输入的记录条数。`cooldown_ticks=1` 意味着每帧一条，32 条 ≈ 20 Hz 下 1.6 秒的未确认窗口；超了驱动挂起而不是崩。单测夹具里的 8 是测试下限，不是生产窗口 |
| `prediction.maxBlockJournal` | 64 | = `maxRecords × 2`。一次挥镐写 1 格；2× 覆盖"同一条记录里既清矿石又写空气"的两格形态 |
| `prediction.maxBindingJournal` | 32 | = `maxRecords × 1`。示例里唯一会被预测的 binding 是矿脉储量那条稀疏引用（挖穿时解绑），每条记录至多一次 |
| `prediction.maxOverlaySlots` | 96 | = `maxBlockJournal + maxBindingJournal`。overlay key 是"每个不同的 (格, 是否 binding) 一个"，最坏情况每次写都落在不同格；取小于这个和的值，会去拒绝另外两条限制本来允许的日志 |
| `prediction.maxValidationSections` | 4 | 每次 stage 前清零，只数**这一次** stage 摸到的 Section。全图就 4 个，再大也够不着 |
| `prediction.maxValidationCellsPerSection` | 64 | 同样是每次 stage 的量。一次挖掘 stage 只有 1–2 格，64 远超任何真实单次 stage，又远小于一个 Section 的 4096 格 |
| `prediction.maxBindingTextEntries` | 32 | = `maxBindingJournal`。每条"设置 binding"的写占一个文本槽；取等值，装满 binding 日志时不会反过来卡在文本槽上 |
| `prediction.bindingTextSlotBytes` | 64 | 示例写进 binding 的身份是 `NetEntityId.ToHex()`，**定长 32 个 ASCII 字符 = 32 字节**（`NetEntityId.cs`）。取 2× 留给将来换身份编码；超长文本会被 `CapacityExceeded` 拒掉 |

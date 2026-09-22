# 导览：十四步走完一款 Lumio 游戏

这份导览按真实文件与行号记录示例游戏的十四步。需求真值在架构仓；本文不复述引擎契约字段。

前八步今天能在本仓走完的是**声明 + hermetic 测试 + 启动器逐步打印**。对着真 Platform / `lumio-ds` / Bot.Host 跑到第八步，还要等 Client R-00534 与内部 compose。缺依赖时启动器印 `step=NN status=BLOCKED_ENV` 并以 exit 2 离开——那不是通过。第 04 步只有 Bot 日志出现 `session state changed … Active … established` 才 PASS；进程起来不算入房。

| 步 | 做什么 | 本仓落点 |
|---|---|---|
| 1 | 编译配表 | [`Server/Config/Tables/manifest.json`](../Server/Config/Tables/manifest.json) · [`SampleTables`](../Gameplay/Config/SampleTables.cs) |
| 2 | 注册登录 | [`account-client.mjs`](../Tools/account-client.mjs#L313) |
| 3 | 起 DS | [`Server/Config/Startup/server.json`](../Server/Config/Startup/server.json#L24) · [`launcher.mjs`](../Tools/launcher.mjs#L216) |
| 4 | 进房间 | [`parseBotAdmit`](../Tools/launcher.mjs) · [`collectLaunchTickets`](../Tools/launcher.mjs) |
| 5 | 加载底图 | [`Server/Assets/Maps/sample.voxel`](../Server/Assets/Maps/sample.voxel) · [`capture-basemap.mjs`](../Tools/capture-basemap.mjs) |
| 6 | 玩家入场 | [`PlayerEntity`](../Gameplay/EntityTypes/PlayerEntity.cs#L8) |
| 7 | 跑动 | [`MoveAbility.SetLocalPosition`](../Gameplay/Abilities/MoveAbility.cs#L136) |
| 8 | 聊天 | [`ChatComponent.SendMessage`](../Gameplay/Components/Chat/ChatComponent.cs#L10) |
| 9–14 | 挖掘到存档 | 占位，见文末；等对应引擎卡 |

> 两轮同底图哈希对账（S-7）贯穿全程，不单列一步。[`verify-evidence.mjs`](../Tools/verify-evidence.mjs) 读两轮独立目录的日志，并经 [`world-assert.mjs`](../Tools/world-assert.mjs) 核对格子与矿石数。

## 第 1 步：编译配表

数值在 [`Server/Config/Tables/server/movement.json`](../Server/Config/Tables/server/movement.json)、[`Server/Config/Tables/server/mining.json`](../Server/Config/Tables/server/mining.json)、[`Server/Config/Tables/server/attributes.json`](../Server/Config/Tables/server/attributes.json)，由 [`manifest.json`](../Server/Config/Tables/manifest.json) 钉指纹。[`SampleTables`](../Gameplay/Config/SampleTables.cs) 经 Runtime M9 装载 typed Reader，不扫父目录。

世界单例声明在 [`WorldEntity.cs` 第 7 行](../Gameplay/EntityTypes/WorldEntity.cs#L7)：`TickRateHz = 20`。生成注册表把同一数字写进 [`GeneratedRegistry.DeclaredTickRateHz`](../Gameplay/generated/server/Lumio.Sample.Gameplay.Registry.g.cs#L66)。

**今天能跑**

```bash
dotnet build LumioSample.slnx
node --test Server/Tests/Gameplay  # 或 dotnet exec 该测试 DLL
```

**应该看到的日志**

- 启动器：`step=01 status=READY LumioConfig export + typed Reader via M9 loader`
- 没有 `1.25` / `0.35` 等配表数字出现在玩法 `.cs` 里（`SampleTablesTests` 会扫）

## 第 2 步：注册登录

账号走 LumioPlatform 的 WebSocket `/account`（子协议 [`lumio-account-v1`](../Tools/account-client.mjs#L33)，[`LoginOrRegister`](../Tools/account-client.mjs#L34)）。进房票只来自 [`loginAndLaunch`](../Tools/account-client.mjs#L313) 调用的 `POST /api/games/sample/launch`——本仓不自签票据。口令来自 `LUMIO_ACCOUNT_PASSWORD` 或本轮生成，不入库、不进日志。`Bot*` 登录名必须带 Platform 签发的 `LUMIO_BOT_TOOL_CREDENTIAL`。

**今天能跑**

```bash
node --test Tools/account-client.test.mjs
```

**应该看到的日志**

- hermetic 测试通过；CLI 摘要只有 AccountId / 绑定字段，没有口令
- 启动器无 `LUMIO_PLATFORM_ORIGIN` 时：`step=02 status=BLOCKED_ENV LUMIO_PLATFORM_ORIGIN is not set`（[launcher.mjs](../Tools/launcher.mjs)）
- 真 Platform 换票成功时：启动器继续第 3 步，日志里仍不得出现口令或 admission ticket 明文（`redact` / `summarizeSession`）

## 第 3 步：起 DS

[`Server/Config/Startup/server.json`](../Server/Config/Startup/server.json) 的 [`config_dir`](../Server/Config/Startup/server.json#L24) 指向本仓 `Server/Config/Tables/`（相对配置文件目录解析，ADR-115），三条程序集路径指向本仓 `bin/`，[`world_profile`](../Server/Config/Startup/server.json#L25) 已冻成 `runtime+voxel`，[`durability`](../Server/Config/Startup/server.json#L26) 是 persistence-container-v1 的 `snapshot_only`（不是 `process-crash` / `power-loss`），并要求 `base_map_*`。allocation 与 `admission_public_key_hex` 是本机可跑的句法 stand-in，不是 Platform 票；填我用的 `replace-*` / `REPLACE_WITH_…` 留在 [`Server/Config/Startup/server.sample.json`](../Server/Config/Startup/server.sample.json)，未填时启动器第 03 步是响亮的 `MISSING_VALUE`（不是占位 `BLOCKED_ENV`）。本机覆盖是 gitignored 的 `.run/server.local.json`（`LUMIO_DS_CONFIG`），须抄这份公共词表。启动器经架构仓 `eng/process-tools.mjs` 拉起 `LUMIO_DS_EXE`，并从 stdout 解析 [`DS_READY `](../Tools/ds-ready.mjs#L1)。

**今天能跑**

```bash
node --test Tools/ds-ready.test.mjs
node Tools/launcher.mjs --bots 2 --stagger-ms 250
```

**应该看到的日志**

- 无 `lumio-ds`：`step=03 status=BLOCKED_ENV LUMIO_DS_EXE is not set or is not a file`（[launcher.mjs](../Tools/launcher.mjs)），exit 2——挡的是二进制，不是 `replace-*` 字符串
- 配置里还留着 `replace-*` / `REPLACE_WITH_PLATFORM_32_BYTE_PUBLIC_KEY_HEX`：`step=03 status=FAIL missing required value: …`（`MISSING_VALUE`），exit 1
- 真 DS 起来：一行 `DS_READY { "pid": …, "endpoint": "ws://127.0.0.1:…" }`，endpoint 不得带凭据或 query

## 第 4 步：进房间

启动器按 `--bots N` 规划 `Bot1`…`BotN`，错峰 `--stagger-ms`，每名 Bot 一张 [`loginAndLaunch`](../Tools/account-client.mjs#L313) 票。[`collectLaunchTickets`](../Tools/launcher.mjs#L93) 拒绝复用。票交给 Client `Bot.Host`（`LUMIO_BOT_DLL`），并带 `--gameplay`（`LUMIO_GAMEPLAY` 或本仓 `Lumio.Sample.Gameplay.dll`）。本仓不写场景类去顶替宿主接口。

### Bot 要进体素世界，必须带 `--voxel-config`

这个房间的 [`Server/Config/Startup/server.json`](../Server/Config/Startup/server.json) 冻在 `world_profile=runtime+voxel`，DS 会向每名 Bot 推 SectionFrame。**没带 `--voxel-config` 的 Bot 收到第一帧就 `session_faulted`**：`ClientSession.HandleSectionFrame` 里 `ResolveVoxelSink()` 为 null 就直接 `FailSession`。

**这是 ADR-112 修订 2 ⑨ 要的 fail-closed 行为，不是缺陷。** 没有体素预算的 Bot 拿不到 Section sink、关不了权威组、挂不上 GAS 联合预测；让它"忽略 SectionFrame 继续跑"就是 ADR-106 决策 1 明令禁止的静默降级——表面在动，实际什么都没预测。所以引擎选择响亮地停，而不是安静地假装。修复之前帧根本到不了 Bot，所以这条在 2026-09-22 端到端验证打通下行链之后才第一次被触发。

预算落在 [`Server/Assets/Maps/bot-voxel-budget.json`](../Server/Assets/Maps/bot-voxel-budget.json)，和它的 `catalogPath` 目标 [`Server/Assets/Maps/official-catalog.json`](../Server/Assets/Maps/official-catalog.json)（DS 用的同一份目录表）同目录——`BotVoxelConfig` 是**按预算文件自己所在目录**解析 `catalogPath` 的，不是按进程 cwd，所以两份文件一起搬也不会断。它不放 `Server/Config/Tables/`：那整棵树是 LumioConfig 的编译产物，`sync-config-export.mjs --check` 逐字节比对，手写文件进去会污染 `outputHash`。

按 ADR-101，这份文件**每个字段都得写满**，`prediction` 的九个限制一个都不能省——零是"显式关掉这项 Native 资源"的意思，和"没填"必须能区分，所以缺字段是拒绝而不是取默认值。数值依据见 [`Server/Assets/Maps/bot-voxel-budget.json` 的说明](#bot-体素预算的数值依据)。

启动器默认就带上它。要回到 entity-only 形态（旁观者、纯移动压测 Bot 这类本来就不该拥有体素世界的跑法）用 `--voxel-config off`（也认 `none` / `false` / `0` / 空值），或 `LUMIO_BOT_VOXEL_CONFIG=off`。**entity-only 只对不发 Section 的房间成立**；对着本仓这份 `Server/Config/Startup/server.json` 用它，Bot 一定 fault。指了一个不存在的路径则是启动器当场报错，不会悄悄退回 entity-only。

**今天能跑**

```bash
node --test Tools/launcher.test.mjs
```

**应该看到的日志**

- 无 Bot.Host：`step=04 status=BLOCKED_ENV LUMIO_BOT_DLL is not set`（[launcher.mjs](../Tools/launcher.mjs)）
- 注入两张相同票：测试失败，信息含 `unique`
- 真准入成功：每名 Bot 的滚动日志出现 `state=Active` 且 `reason=established`；进程启动、拒票、无 welcome 都不得把第 04 步标 PASS
- 日志经 redact，看不到 ticket

## 第 5 步：加载底图

底图是作者时 Capture 入库的规范快照，不由玩法程序集程序化生成，DS 开机只 restore。[`Server/Assets/Maps/sample.voxel`](../Server/Assets/Maps/sample.voxel) 是 Engine `eng/capture-voxel.mjs` 产出的 Cube 平面（W×D 石头地板 + 一圈硬墙 + 一片矿脉，尺寸与矿脉在 [`Server/Assets/Maps/sample.layout.json`](../Server/Assets/Maps/sample.layout.json)）。[`capture-basemap.mjs`](../Tools/capture-basemap.mjs) 只在作者时调用那条 CLI，玩法程序集与 DS 不得引用它。体素写（挖穿变空气）仍是 R-00469，本步只做读与首包。直播冷恢复仍等 R-00498 / R-00507，不得把第 05–14 步整批标 PASS。

[`verify-evidence.mjs`](../Tools/verify-evidence.mjs) 读取两轮独立目录的日志，逐位核对 `eventOrder` 与 `appliedTicks`，并经 [`world-assert.mjs`](../Tools/world-assert.mjs) 核对格子与矿石数。空日志或「哈希一致但世界错」都失败。

**今天能跑**

```bash
node --test Tools/verify-evidence.mjs
node --test Tools/capture-basemap.test.mjs
```

**应该看到的日志**

- 启动器：`step=05 status=READY Server/Assets/Maps/sample.voxel is a VoxelEngine capture; DS boot restores only (R-00522).`
- 第 07–13 步仍是诚实的 `BLOCKED_ENV`（Activate / 聊天 / 挖掘 / 体素写 / 掉落 / 拾取还没直播）
- 第 14 步仍是 `BLOCKED_ENV`：`save/restore waits R-00498 / R-00507`——底图可 restore，不声称直播冷恢复已过
- fixture `Tools/fixtures/oracle-min` 两轮比对退出码 0；空目录 FAIL

## 第 6 步：玩家入场

[`PlayerEntity`](../Gameplay/EntityTypes/PlayerEntity.cs#L8) 声明 Observer + Identity + LogicTransform + Chat + Ability + Attribute + Effect。Identity 只承接平台 accountId / 用户名；聊天说话人仍是 `NetEntityId` hex。直播入场是 DS 准入五步，不在本仓另写一套。

**应该看到的日志**

- 启动器在缺 Bot.Host 时第 6 步也是 `BLOCKED_ENV`（[launcher.mjs](../Tools/launcher.mjs)）
- 真入场后：Bot 日志出现本玩家的 `NetEntityId` hex；聊天将用同一个 hex 当说话人

## 第 7 步：跑动

[`MoveAbility`](../Gameplay/Abilities/MoveAbility.cs#L17) 是唯一调用 [`SetLocalPosition`](../Gameplay/Abilities/MoveAbility.cs#L136) 的手写文件。步长与扫掠半径来自 [`Server/Config/Tables/server/movement.json`](../Server/Config/Tables/server/movement.json)。硬墙依赖 `IAbilityPhysicsPort`；端口缺失时拒绝本次位移、不写坐标。直播 `Activate` 等 Client R-00534 AC10。

**今天能跑**

```bash
dotnet exec Server/Tests/Gameplay/bin/Debug/net10.0/Lumio.Sample.Gameplay.Tests.dll
```

**应该看到的日志**

- `MoveAbilityTests` 通过；`SourceHygieneTests` 保证其它手写文件不再写坐标
- 启动器：`step=07 status=BLOCKED_ENV MoveAbility is in-tree; live Activate waits Client R-00534 AC10`（[launcher.mjs](../Tools/launcher.mjs)）
- 真 Activate 后：Bot 向硬墙跑应停下；对家同帧看到位移。这一条还没有直播证据

## 第 8 步：聊天

共享声明在 [`ChatComponent.cs` 第 10 行](../Gameplay/Components/Chat/ChatComponent.cs#L10)（`chat.input`）。服务器把说话人写成 [`Entity.ToHex() + ": " + text`](../Gameplay/Components/Chat/ChatComponent.Server.cs#L23)，UTF-8 上限 512 是生成器写死的，不是玩法配表。直播收发等 Bot.Host。

**应该看到的日志**

- 启动器：`step=08 status=BLOCKED_ENV ChatComponent is in-tree; live chat waits Bot.Host`（[launcher.mjs](../Tools/launcher.mjs)）
- 真双 Bot：A 发言后 B 按序收到 `OnChatMessage`；服务器信息日志形如 `{hex} says: {text}`（[Server 第 26 行](../Gameplay/Components/Chat/ChatComponent.Server.cs#L26)）
- 两轮同输入的 `eventOrder` 由 S-7 对账，不在本步另造哈希

## 第 3–4 步合在一起：一条内部命令

```bash
node Tools/launcher.mjs --bots 2 --stagger-ms 250
```

判据 2 第一阶段是内部验收：Platform 镜像现在从私有仓构建，外部机器拿不到 compose 文件。本仓用环境变量 `LUMIO_PLATFORM_COMPOSE` 指向那份内部文件，见 [`Tools/compose/README.md`](../Tools/compose/README.md)。`forceCleanup` 不是通过证据。

## 第 9–14 步（占位，等引擎卡）

| 步 | 做什么 | 等哪张卡 | 本仓已有的壳 |
|---|---|---|---|
| 9 | 挖掘（技能五步准入） | **R-00468**；轨 B S-11 | [`MineAbility`](../Gameplay/Abilities/MineAbility.cs#L17) |
| 10 | 矿脉储量 -1 | **R-00469** / **R-00538**；S-12 | [`VeinReserveComponent`](../Gameplay/Components/Vein/VeinReserveComponent.Server.cs) |
| 11 | 储量归零，方块变空气 | **R-00469**；S-12 | `MineAbility.TryRequestAirWrite` 恒为 false |
| 12 | 掉出矿石 | **R-00462**；S-13 | [`OreDropEntity`](../Gameplay/EntityTypes/OreDropEntity.cs) |
| 13 | 拾取（GAS Ability 准入 → Effect 单第 9 相改基础账） | **R-00636**（DS 直播归 R-00600）；S-14 | [`PickupAbility`](../Gameplay/Abilities/PickupAbility.cs) → [`PickupOreEffect`](../Gameplay/Effects/PickupOreEffect.cs) |
| 14 | 存档并重启恢复 | **R-00498** / **R-00507**；S-15 | `world_profile` 已是 `runtime+voxel` + `snapshot_only`；`Server/Assets/Maps/sample.voxel` 是可 restore 的 Capture。直播冷恢复仍等这两张卡，启动器第 14 步保持 `BLOCKED_ENV`。后段正文归 S-16 |

启动器这六步的 `BLOCKED_ENV` 文案在 [`launcher.mjs`](../Tools/launcher.mjs) 的第 9–14 步记录处。

## 100 人压测门

`node Tools/stress-move.mjs` 写出 `verification.json` 的五条判据骨架。帧时钟必须是 NativeCore `clock_now`，Stopwatch 不算。未对着真 100 Bot / 5 分钟跑过之前，不得声称五条已过（R-00588 / ADR-084）。

`stress-move.mjs` 与 `spectator-100.mjs` 今天仍按 entity-only 形态起 Bot，没接 `--voxel-config`。对着本仓这份 `runtime+voxel` 的 `Server/Config/Startup/server.json`，它们同样会在第一帧 Section 上 fault；接线归各自的卡，不在本节的十四步启动器里。

## Bot 体素预算的数值依据

[`Server/Assets/Maps/bot-voxel-budget.json`](../Server/Assets/Maps/bot-voxel-budget.json) 是 JSON，装不下注释，而 `BotVoxelConfig` 又**拒绝任何未知字段**，所以依据记在这里。地图事实：`sample.layout.json` 是 32×32×16，Section 是 16³，`Server/Config/Startup/server.json` 的 `voxel_baseline_region` 是 `0,0,0..1,0,1`——**全图 4 个 Section**（`s:0:0:0` / `s:0:0:1` / `s:1:0:0` / `s:1:0:1`）。玩法事实：`Gameplay/Tables/tables/mining.txt` 的 `cooldown_ticks=1`，即 20 Hz 下每帧都可能压进一次挖掘预测。

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

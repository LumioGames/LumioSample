# 导览：十四步走完一款 Lumio 游戏

这份导览按真实文件与行号记录示例游戏的十四步。需求真值在架构仓；本文不复述引擎契约字段。

前八步今天能在本仓走完的是**声明 + hermetic 测试 + 启动器逐步打印**。对着真 Platform / `lumio-ds` / Bot.Host 跑到第八步，还要等 Client R-00534 与内部 compose。缺依赖时启动器印 `step=NN status=BLOCKED_ENV` 并以 exit 2 离开——那不是通过。第 04 步只有 Bot 日志出现 `session state changed … Active … established` 才 PASS；进程起来不算入房。

| 步 | 做什么 | 本仓落点 |
|---|---|---|
| 1 | 编译配表 | [`config/manifest.json`](../config/manifest.json) · [`SampleTables`](../src/Lumio.Sample.Gameplay/Config/SampleTables.cs) |
| 2 | 注册登录 | [`account-client.mjs`](../integration/account-client.mjs#L313) |
| 3 | 起 DS | [`server.json`](../server.json#L24) · [`launcher.mjs`](../integration/launcher.mjs#L216) |
| 4 | 进房间 | [`parseBotAdmit`](../integration/launcher.mjs) · [`collectLaunchTickets`](../integration/launcher.mjs) |
| 5 | 加载底图 | [`maps/sample.voxel`](../maps/sample.voxel) · [`capture-basemap.mjs`](../integration/capture-basemap.mjs) |
| 6 | 玩家入场 | [`PlayerEntity`](../src/Lumio.Sample.Gameplay/EntityTypes/PlayerEntity.cs#L8) |
| 7 | 跑动 | [`MoveAbility.SetLocalPosition`](../src/Lumio.Sample.Gameplay/Abilities/MoveAbility.cs#L136) |
| 8 | 聊天 | [`ChatComponent.SendMessage`](../src/Lumio.Sample.Gameplay/Components/Chat/ChatComponent.cs#L10) |
| 9–14 | 挖掘到存档 | 占位，见文末；等对应引擎卡 |

> 两轮同底图哈希对账（S-7）贯穿全程，不单列一步。[`verify-evidence.mjs`](../integration/verify-evidence.mjs) 读两轮独立目录的日志，并经 [`world-assert.mjs`](../integration/world-assert.mjs) 核对格子与矿石数。

## 第 1 步：编译配表

数值在 [`config/server/movement.json`](../config/server/movement.json)、[`config/server/mining.json`](../config/server/mining.json)、[`config/server/attributes.json`](../config/server/attributes.json)，由 [`manifest.json`](../config/manifest.json) 钉指纹。[`SampleTables`](../src/Lumio.Sample.Gameplay/Config/SampleTables.cs) 经 Runtime M9 装载 typed Reader，不扫父目录。

世界单例声明在 [`WorldEntity.cs` 第 7 行](../src/Lumio.Sample.Gameplay/EntityTypes/WorldEntity.cs#L7)：`TickRateHz = 20`。生成注册表把同一数字写进 [`GeneratedRegistry.DeclaredTickRateHz`](../src/Lumio.Sample.Gameplay/generated/server/Lumio.Sample.Gameplay.Registry.g.cs#L66)。

**今天能跑**

```bash
dotnet build LumioSample.slnx
node --test tests/Lumio.Sample.Gameplay.Tests  # 或 dotnet exec 该测试 DLL
```

**应该看到的日志**

- 启动器：`step=01 status=READY LumioConfig export + typed Reader via M9 loader`
- 没有 `1.25` / `0.35` 等配表数字出现在玩法 `.cs` 里（`SampleTablesTests` 会扫）

## 第 2 步：注册登录

账号走 LumioPlatform 的 WebSocket `/account`（子协议 [`lumio-account-v1`](../integration/account-client.mjs#L33)，[`LoginOrRegister`](../integration/account-client.mjs#L34)）。进房票只来自 [`loginAndLaunch`](../integration/account-client.mjs#L313) 调用的 `POST /api/games/sample/launch`——本仓不自签票据。口令来自 `LUMIO_ACCOUNT_PASSWORD` 或本轮生成，不入库、不进日志。`Bot*` 登录名必须带 Platform 签发的 `LUMIO_BOT_TOOL_CREDENTIAL`。

**今天能跑**

```bash
node --test integration/account-client.test.mjs
```

**应该看到的日志**

- hermetic 测试通过；CLI 摘要只有 AccountId / 绑定字段，没有口令
- 启动器无 `LUMIO_PLATFORM_ORIGIN` 时：`step=02 status=BLOCKED_ENV LUMIO_PLATFORM_ORIGIN is not set`（[launcher.mjs](../integration/launcher.mjs)）
- 真 Platform 换票成功时：启动器继续第 3 步，日志里仍不得出现口令或 admission ticket 明文（`redact` / `summarizeSession`）

## 第 3 步：起 DS

[`server.json`](../server.json) 的 [`config_dir`](../server.json#L24) 指向本仓 `config/`，三条程序集路径指向本仓 `bin/`，[`world_profile`](../server.json#L25) 已冻成 `runtime+voxel`，[`durability`](../server.json#L26) 是 persistence-container-v1 的 `snapshot_only`（不是 `process-crash` / `power-loss`），并要求 `base_map_*`。本机覆盖是 gitignored 的 `.run/server.local.json`（`LUMIO_DS_CONFIG`），须抄这份公共词表。启动器经架构仓 `eng/process-tools.mjs` 拉起 `LUMIO_DS_EXE`，并从 stdout 解析 [`DS_READY `](../integration/ds-ready.mjs#L1)。

**今天能跑**

```bash
node --test integration/ds-ready.test.mjs
node integration/launcher.mjs --bots 2 --stagger-ms 250
```

**应该看到的日志**

- 无 `lumio-ds`：`step=03 status=BLOCKED_ENV LUMIO_DS_EXE is not set or is not a file`（[launcher.mjs](../integration/launcher.mjs)），exit 2
- 真 DS 起来：一行 `DS_READY { "pid": …, "endpoint": "ws://127.0.0.1:…" }`，endpoint 不得带凭据或 query

## 第 4 步：进房间

启动器按 `--bots N` 规划 `Bot1`…`BotN`，错峰 `--stagger-ms`，每名 Bot 一张 [`loginAndLaunch`](../integration/account-client.mjs#L313) 票。[`collectLaunchTickets`](../integration/launcher.mjs#L93) 拒绝复用。票交给 Client `Bot.Host`（`LUMIO_BOT_DLL`），并带 `--gameplay`（`LUMIO_GAMEPLAY` 或本仓 `Lumio.Sample.Gameplay.dll`）。本仓不写场景类去顶替宿主接口。

**今天能跑**

```bash
node --test integration/launcher.test.mjs
```

**应该看到的日志**

- 无 Bot.Host：`step=04 status=BLOCKED_ENV LUMIO_BOT_DLL is not set`（[launcher.mjs](../integration/launcher.mjs)）
- 注入两张相同票：测试失败，信息含 `unique`
- 真准入成功：每名 Bot 的滚动日志出现 `state=Active` 且 `reason=established`；进程启动、拒票、无 welcome 都不得把第 04 步标 PASS
- 日志经 redact，看不到 ticket

## 第 5 步：加载底图

底图是规范快照文件，不由玩法程序集程序化生成。[`maps/sample.voxel`](../maps/sample.voxel) 仍是占位（文件内有响亮的 `BLOCKED`），**不可 restore**。[`capture-basemap.mjs`](../integration/capture-basemap.mjs) 承认 VoxelFacade 已有 PrepareWrite / Capture / Restore；Sample 还没接 write-cell 消费，同级 Engine 也没有已入库的 capture CLI，所以保持 `BLOCKED_ENV`（R-00522）。缺的命令是「经 VoxelFacade 写格再 Capture 写出规范快照」——不得把占位文件当底图，也不得把「本仓未接线」写成「上游 ABI 不存在」。

[`verify-evidence.mjs`](../integration/verify-evidence.mjs) 读取两轮独立目录的日志，逐位核对 `eventOrder` 与 `appliedTicks`，并经 [`world-assert.mjs`](../integration/world-assert.mjs) 核对格子与矿石数。空日志或「哈希一致但世界错」都失败。

**今天能跑**

```bash
node --test integration/verify-evidence.mjs
node --test integration/capture-basemap.test.mjs
```

**应该看到的日志**

- 启动器：`step=05 status=BLOCKED_ENV maps/sample.voxel is a placeholder and must not be treated as a base map`
- fixture `integration/fixtures/oracle-min` 两轮比对退出码 0；空目录 FAIL

## 第 6 步：玩家入场

[`PlayerEntity`](../src/Lumio.Sample.Gameplay/EntityTypes/PlayerEntity.cs#L8) 声明 Observer + Identity + LogicTransform + Chat + Ability + Attribute + Effect。Identity 只承接平台 accountId / 用户名；聊天说话人仍是 `NetEntityId` hex。直播入场是 DS 准入五步，不在本仓另写一套。

**应该看到的日志**

- 启动器在缺 Bot.Host 时第 6 步也是 `BLOCKED_ENV`（[launcher.mjs](../integration/launcher.mjs)）
- 真入场后：Bot 日志出现本玩家的 `NetEntityId` hex；聊天将用同一个 hex 当说话人

## 第 7 步：跑动

[`MoveAbility`](../src/Lumio.Sample.Gameplay/Abilities/MoveAbility.cs#L17) 是唯一调用 [`SetLocalPosition`](../src/Lumio.Sample.Gameplay/Abilities/MoveAbility.cs#L136) 的手写文件。步长与扫掠半径来自 [`config/server/movement.json`](../config/server/movement.json)。硬墙依赖 `IAbilityPhysicsPort`；端口缺失时拒绝本次位移、不写坐标。直播 `Activate` 等 Client R-00534 AC10。

**今天能跑**

```bash
dotnet exec tests/Lumio.Sample.Gameplay.Tests/bin/Debug/net10.0/Lumio.Sample.Gameplay.Tests.dll
```

**应该看到的日志**

- `MoveAbilityTests` 通过；`SourceHygieneTests` 保证其它手写文件不再写坐标
- 启动器：`step=07 status=BLOCKED_ENV MoveAbility is in-tree; live Activate waits Client R-00534 AC10`（[launcher.mjs](../integration/launcher.mjs)）
- 真 Activate 后：Bot 向硬墙跑应停下；对家同帧看到位移。这一条还没有直播证据

## 第 8 步：聊天

共享声明在 [`ChatComponent.cs` 第 10 行](../src/Lumio.Sample.Gameplay/Components/Chat/ChatComponent.cs#L10)（`chat.input`）。服务器把说话人写成 [`Entity.ToHex() + ": " + text`](../src/Lumio.Sample.Gameplay/Components/Chat/ChatComponent.Server.cs#L23)，UTF-8 上限 512 是生成器写死的，不是玩法配表。直播收发等 Bot.Host。

**应该看到的日志**

- 启动器：`step=08 status=BLOCKED_ENV ChatComponent is in-tree; live chat waits Bot.Host`（[launcher.mjs](../integration/launcher.mjs)）
- 真双 Bot：A 发言后 B 按序收到 `OnChatMessage`；服务器信息日志形如 `{hex} says: {text}`（[Server 第 26 行](../src/Lumio.Sample.Gameplay/Components/Chat/ChatComponent.Server.cs#L26)）
- 两轮同输入的 `eventOrder` 由 S-7 对账，不在本步另造哈希

## 第 3–4 步合在一起：一条内部命令

```bash
node integration/launcher.mjs --bots 2 --stagger-ms 250
```

判据 2 第一阶段是内部验收：Platform 镜像现在从私有仓构建，外部机器拿不到 compose 文件。本仓用环境变量 `LUMIO_PLATFORM_COMPOSE` 指向那份内部文件，见 [`integration/compose/README.md`](../integration/compose/README.md)。`forceCleanup` 不是通过证据。

## 第 9–14 步（占位，等引擎卡）

| 步 | 做什么 | 等哪张卡 | 本仓已有的壳 |
|---|---|---|---|
| 9 | 挖掘（技能五步准入） | **R-00468**；轨 B S-11 | [`MineAbility`](../src/Lumio.Sample.Gameplay/Abilities/MineAbility.cs#L17) |
| 10 | 矿脉储量 -1 | **R-00469** / **R-00538**；S-12 | [`VeinReserveComponent`](../src/Lumio.Sample.Gameplay/Components/Vein/VeinReserveComponent.Server.cs) |
| 11 | 储量归零，方块变空气 | **R-00469**；S-12 | `MineAbility.TryRequestAirWrite` 恒为 false |
| 12 | 掉出矿石 | **R-00462**；S-13 | [`OreDropEntity`](../src/Lumio.Sample.Gameplay/EntityTypes/OreDropEntity.cs) |
| 13 | 拾取（Effect 改两本账） | **R-00480** / **R-00541**；S-14 | [`PickupOreEffect`](../src/Lumio.Sample.Gameplay/Effects/PickupOreEffect.cs) |
| 14 | 存档并重启恢复 | **R-00498** / **R-00507**；S-15 | `world_profile` 已是 `runtime+voxel` + `snapshot_only`；底图仍是占位，冷恢复等真实 capture。后段正文归 S-16 |

启动器这六步的 `BLOCKED_ENV` 文案在 [`launcher.mjs`](../integration/launcher.mjs) 的第 9–14 步记录处。

## 100 人压测门

`node integration/stress-move.mjs` 写出 `verification.json` 的五条判据骨架。帧时钟必须是 NativeCore `clock_now`，Stopwatch 不算。未对着真 100 Bot / 5 分钟跑过之前，不得声称五条已过（R-00588 / ADR-084）。

# 导览：十四步走完一款 Lumio 游戏

这份导览按真实文件记录示例游戏的十四步链路。需求真值在架构仓；本文只说明本仓当前的落点。

| 步 | 做什么 | 状态 |
|---|---|---|
| 1 | 编译配表，生成 typed Reader | JSON 在 [`config/`](../config/)；`SampleTables` 读文件。M8 typed Reader 未接线 |
| 2 | 起账号服，注册登录 | [`integration/account-client.mjs`](../integration/account-client.mjs)；启动器接线见第 3 步 |
| 3 | 起 DS，加载配表快照与 tick 频率 | [`server.json`](../server.json) + [`integration/launcher.mjs`](../integration/launcher.mjs)。无 `lumio-ds` 时 `BLOCKED_ENV` |
| 4 | 进房间（准入五步） | 启动器按 `--bots N` 错峰换票；票不可复用。无 Platform 时 `BLOCKED_ENV` |
| 5 | 加载底图并从存档恢复 | [`maps/sample.voxel`](../maps/sample.voxel) 是占位，**不可 restore**。capture 脚本见 [`integration/capture-basemap.mjs`](../integration/capture-basemap.mjs) |
| 6 | 玩家入场 | [`PlayerEntity`](../src/Lumio.Sample.Gameplay/EntityTypes/PlayerEntity.cs) 已声明；直播入场是 DS 准入 |
| 7 | 跑动 | [`MoveAbility`](../src/Lumio.Sample.Gameplay/Abilities/MoveAbility.cs) 是唯一写 `LogicTransform` 的地方。直播 Activate 等 Client R-00534 |
| 8 | 聊天 | [`ChatComponent`](../src/Lumio.Sample.Gameplay/Components/Chat/ChatComponent.cs) 已声明。直播收发等 Bot.Host |
| 9 | 挖掘（技能五步准入） | [`MineAbility`](../src/Lumio.Sample.Gameplay/Abilities/MineAbility.cs)；引擎准入缺口 R-00468 |
| 10 | 矿脉储量 -1（方块实体绑定） | [`VeinReserveComponent`](../src/Lumio.Sample.Gameplay/Components/Vein/VeinReserveComponent.Server.cs)。体素绑定等 R-00469 |
| 11 | 储量归零，方块变空气 | `MineAbility.TryRequestAirWrite` 恒为 false，直到体素批写 ABI 公开 |
| 12 | 掉出矿石（结构单） | [`OreDropEntity`](../src/Lumio.Sample.Gameplay/EntityTypes/OreDropEntity.cs)。结构提交缺口 R-00462 |
| 13 | 走过去捡（Effect 改属性两本账） | [`PickupOreEffect`](../src/Lumio.Sample.Gameplay/Effects/PickupOreEffect.cs)。DS 结算等 R-00480 |
| 14 | 存档，重启 DS，地图与矿石数都还在 | `world_profile` 仍是 `runtime-only`。等 R-00498 / R-00507 |

> 两轮同底图哈希对账（S-7）贯穿全程，不单列一步。世界对错另走 [`integration/world-assert.mjs`](../integration/world-assert.mjs)，防止「一致但错」。

## 第 2 步：注册登录

账号走 LumioPlatform 的 WebSocket `/account`（子协议 `lumio-account-v1`，登录即注册）。进房票只来自 `POST /api/games/sample/launch` 的 Bearer 换票——本仓不自签票据。口令来自 `LUMIO_ACCOUNT_PASSWORD` 或本轮生成，不入库、不进日志。Bot 命名空间必须带 Platform 签发的 `LUMIO_BOT_TOOL_CREDENTIAL`。

hermetic 协议测试：`node --test integration/account-client.test.mjs`。真 Platform 换票由启动器调用 `loginAndLaunch`。

## 第 3–4 步：一条命令（内部）

```bash
node integration/launcher.mjs --bots 2 --stagger-ms 250
```

判据 2 第一阶段是内部验收：Platform 镜像现在从私有仓 `build: .`，外部机器拿不到。缺任何真拓扑依赖时启动器打印 `step=NN status=BLOCKED_ENV` 并以 exit 2 离开。`forceCleanup` 不是通过证据。进程管理只复用架构仓 `eng/process-tools.mjs`。

## 第 5 步：加载底图

底图是规范快照文件，不由玩法程序集程序化生成。[`maps/sample.voxel`](../maps/sample.voxel) 为占位文件，不可 restore。`integration/capture-basemap.mjs` 在 write-cell / capture ABI 未公开前保持 `BLOCKED_ENV`。

`integration/verify-evidence.mjs` 只读取两轮日志，逐位核对 `eventOrder` 与 `appliedTicks`，并比较日志中的 `baseMapSha256`。它不从其它字段推导事件，也不使用多重集比较。

## 第 7 步：跑动

步长和扫掠半径来自 `config/movement.json`。硬墙依赖 `IAbilityPhysicsPort`；端口缺失按空空间处理，不在本仓再写一套体素碰撞。

## 100 人压测门

`node integration/stress-move.mjs` 写出 `verification.json` 的五条判据骨架。帧时钟必须是 NativeCore `clock_now`，Stopwatch 不算。未对着真 100 Bot / 5 分钟跑过之前，不得声称五条已过、也不得据此打开「已经验收」的挖矿教学。

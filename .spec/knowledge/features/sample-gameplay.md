---
name: sample-gameplay
description: 示例玩法声明与启动器落点——实体/技能/M9 typed Reader/十四步脚本;底图是作者时 Capture、DS 只 restore;改玩法或启动器时查
metadata:
  type: doc
  status: 实施中
---

# 示例玩法与启动器

示例仓把十四步链路的**玩法声明**和**一条命令启动器**落在本仓。引擎缺口不在这里造替代品。

## 世界模型

| 东西 | 落点 |
|---|---|
| 世界单例 | `WorldEntity`（恰好一个 `World = true`，`TickRateHz = 20`） |
| 玩家 | `PlayerEntity`：Observer + Identity + LogicTransform + Chat + Ability + PendingDig + Attribute + Effect。Identity 承接平台 accountId；聊天说话人仍是 `NetEntityId` hex |
| 玩家固定颜色 | `IdentityComponent.ColorHue`（int，0-359，Room/Server 权威同步）：Start/OnHydrate 按账号 FNV 定值并写入，所有端从复制快照读到同一颜色，端上不推导。旁观页以 `hsla(hue,85%,55%,0.75)` 绘制，self 1.5× 半径。int 同步字段进 create 记录依赖 Runtime 生成器的 CaptureSync int 支持 |
| 矿脉储量 | `VeinEntity` + `VeinReserveComponent`。不挂 LogicTransform |
| 掉落矿石 | `OreDropEntity` + `OrePileComponent` + LogicTransform |
| 挖掘火花 | `MiningSparkEntity.Client.cs`（Local，服务器程序集按文件边排除） |
| 跑动 | `MoveAbility`：唯一调用 `LogicTransform.SetLocalPosition` 的地方 |
| 挖掘 | `MineAbility`：准入检查存活矿脉、Native 绑定、储量和真实格心距离，体力不足走 GAS 消耗步。前几击走 `Execute` 当场结算：扣体力基础账、储量 -1。最后一击只经 `SampleMiningComponent.StageFinal` 下地形单并记一笔待结算（玩家、矿脉、扣费额、掉落数），当场不扣体力、不归零、不下掉落单；结算在地形结果回来那一帧的第 4 相，由 `SampleMiningComponent` 经 `HostVoxelWorldAdapter.DrainResults()` 读回后按事务号有序做，被拒或数据不足即丢掉待结算记录、什么都不改（tick.md §3 规则 5）。第 8 相 `DigApplied` 回调只记日志与断言，不写业务、也不消费待结算记录。待结算记录挂在**矿工自己的实体**上（`PendingDigComponent`，全部字段 `[Persist]`、`Scope.None`），不是进程内字典 |
| 四条账 | 体力 / 矿石各 Base+Current。PlayerEntity 用 DeclareAttribute 声明持久基础账，SampleConfigBinding.BindWorld 把 World.GameplayConfig 中的 IAttributeSeedProvider 绑定到 World.SeedProvider，由 Runtime PostAttribute 读取已投影的 attributes 初值。Start 绑定能力上下文；OnHydrate 仅重绑瞬态引用，基础账从存档恢复，Current 由现有属性计算器重建（R-00613） |
| 矿脉出现 | `SampleMiningSystem` 驱动世界单例 `SampleMiningComponent`，按 World 配置的地图宽深扫描恢复后的地板格，以 `ore_block_type` 识别矿石。`SampleVein.Queue` 下结构单，实体正常提交后才用 `HostVoxelWorldAdapter.TryStageMutation` 暂存稀疏绑定，下一帧读到已发布绑定后才开放挖掘 |
| 拾取 | `PickupAbility`（无 cost）：准入要求掉落存活、还有矿石、在移动步长内；`Execute` 把堆清零占位、`Effects.Apply` 下 `PickupOreEffect` 单并下销毁结构单，第 9 相结算入 `Ore` 基础账。同帧两人抢同一份只兑现一次 |
| 技能上下文 | `BindPlayer` 注册 `ActivationContextFactory`：只有 `MineAbility` 走体力 cost 上下文（低于表内消耗映射为 0 在第 3 步被拒），`MoveAbility` / `PickupAbility` 返回 null 用引擎内置无 cost 上下文，体力低时仍能走路和捡矿 |

聊天说话人用 `NetEntityId.ToHex()`，不另造名字属性。

玩法不读取作者时布局，也不重建底图。矿脉坐标、储量与掉落数量通过生成的持久字段保存；冷恢复使用现有 Native 方块、绑定与 ECS 实体重新建立瞬态服务。最终挖掘通过 `TryStageDigThrough` 在帧末发布空气和绑定移除，Runtime 销毁被绑定的矿脉实体；`mining_stage/pre/applied/post/reward/refused/restored` 日志分别记录暂存、实际发布、结算发出的奖励与被拒的地形单，不能单凭日志推断客户端已收到掉落。准入互斥按矿脉与按玩家各一条：同一矿脉同帧只允许一张地形单，第二人在准入第 5 步被拒；同段不同矿脉的两人同帧都可下单，Native 按段校验帧初 revision，输掉版本号的那张被正常拒绝，该玩家什么都没付、下一帧再来。单个玩家在途待结算的上限就是这一个槽（`PendingDigComponent.MaxPerPlayer`），单个世界的上限是 `PendingDigComponent.MaxPerWorld`；越界时拒绝新的挖掘激活，不排队也不扩表。R-00520 的实际 DS 输入、复制、拾取和冷重启验收仍需对应运行证据。

失败边界：地形单在 Execute 里没暂存成功（`StageFinal` 返回 false）就不扣体力、不减储量、不发奖励，但已受理的 GAS 激活序列仍消耗。已暂存的地形单若在第 8 相被 Native 拒绝（最常见的是他人先往同一段写了一笔、顶掉帧初 revision），Sample 在后续帧 `Advance` 排干结果时丢掉那笔待结算，体力 / 储量 / 掉落三样账本一动不动，既不抛异常也不把世界打成 Faulted——按 tick.md §3 规则 5 被拒是合法业务结果而不是故障，同一矿脉下一次挖掘照常进行；不存在「扣了费方块还在」的业务态。

**跨帧待结算属于动态实体快照的一部分**（R-00650）：玩家实体上的 `PendingDigComponent` 与体素改动层、Runtime 未消费的真实事务结果在**同一个切点成组原子换档**（架构仓 [`save-load.md`](../../../../LumioGameEngine/.spec/knowledge/features/save-load.md) ①② 与 M4 / M9）。记录挂在矿工身上，因为成功挖掘会销毁矿脉实体。新 Host 在第一业务帧前恢复有界结果队列，Sample 在第 4 相按原 `TransactionId` 消费：成功才扣原记录的体力、生成掉落，被拒则清记录且不动账本；消费后的快照再次恢复不会重复结算。旧存档没有保存结果时，剩余记录按结果不可得丢弃，不抛异常、不打故障。空气或已清除的绑定不能证明是哪张事务成功，玩法不据此付款；Native 历史回执查询仍可返回 Unknown，不能替代这个同切点的未消费结果队列。

玩家准入使用 Runtime 正式控制消息，在正常 Owner Tick 创建实体；生产玩法没有同步准入或隐式推进 Tick 的辅助入口。测试宿主自行显式驱动 Tick。属性名字是声明身份，配表中的名字必须与声明对应；历史上未包含基础账的存档无法还原当时未保存的数值。

## 配表

源表在 `config/source/`，导出按端位于 `config/server/*.json`、`config/client/*.json`。`SampleConfigBinding` 经 Runtime M9 `LumioConfigLoader` 装载 typed Reader，并将 `ISampleConfig` 投影绑定到 `World.GameplayConfig`；Boot 与 Restore 均要求此绑定。玩法统一通过 `SampleConfigBinding.For(world)` 读取该世界的数值，`SampleTables` 仅解析目录，不再持有缓存或读表入口。八份 Reader（`AttributesTable` / `MiningTable` / `MovementTable` / `MapTable` × server+client）来自上游 LumioConfig `export --csharp-out`，本仓用 `node integration/sync-config-readers.mjs` 同步，`--check` 要求这八份与导出逐字节一致。生成物不得手改。

导出使用 `node integration/sync-config-export.mjs`：在两个全新临时目录编译，逐字节比较全部输出（含根 manifest），再同步回仓库；`--check` 只验证。禁止直接向含源表的 `config/` 导出，因为编译器会把已有文件计入 outputHash。完整命令见 [`config/README.md`](../../../config/README.md)。储量、冷却、体力消耗、掉落数、地图宽深及矿脉比例均来自表；源码检查对数值碰撞逐行分类，不能把输入索引或单次扣除的 `1` 当作冷却默认值。地图尺寸与比例供作者时 `capture-basemap.mjs` 消费 `server/map.json`，修改后须重新 Capture；DS 只恢复底图，不运行时重建地图。

`MoveAbility` 在 GAS 第五步通过 owner 查询一次 `SweepBox`，将 `sweep_radius_meters` 明确用于 AABB 三轴半尺寸。`Execute` 只消费同实例、同 owner、同输入和同 Tick 的准备位置一次。缺端口返回 `physics_unavailable`；已分类查询拒绝在扣费、冷却和执行条目前返回失败，损坏结果和未知异常保留故障诊断。Start/OnHydrate 只重绑既有账本上下文，不安装物理替身；正式物理来自 Runtime Host 的 Manager 绑定，纯托管测试由 harness 显式注入端口。

## 启动器

`integration/launcher.mjs` 是判据 2 的内部启动器：`--bots N`、`--stagger-ms`、逐步打印 `step=NN`。进程管理只 import 架构仓 `eng/process-tools.mjs`（`LUMIO_ENGINE_ROOT` 或同级 `LumioGameEngine`）。进房票只来自 `account-client.mjs` 的 `loginAndLaunch`，一票一 Bot，禁止复用。前八步的文件与行号、以及每步该看到的日志在 [`docs/tour.md`](../../../docs/tour.md)。

缺 Platform / `lumio-ds` / Bot.Host 时 exit 2，`BLOCKED_ENV`。未填的 `replace-*` / `REPLACE_WITH_…` 是 `MISSING_VALUE`（第 03 步 FAIL），不是占位 `BLOCKED_ENV`。Bot 启动带 `--gameplay`。live 子进程在验收窗口（`--duration-ms`，未设则 `--timeout-ms`）结束后才 `forceCleanup`。`forceCleanup` 不是通过证据。`server.json` 已冻成 `runtime+voxel` + `snapshot_only` + 必填 `base_map_*`。本机覆盖 `.run/server.local.json` 不入库。`maps/sample.voxel` 是作者时 Engine capture CLI 写入的可 restore 快照（Cube 平面；尺寸与矿脉在 `maps/sample.layout.json`）；DS 开机只 restore。`capture-basemap.mjs` 只给作者时用，玩法程序集不得引用。启动器第 05 步对可 restore 底图标 READY，第 07–14 步仍诚实 `BLOCKED_ENV`（直播 Activate / 挖掘 / 冷恢复未过）。Sibling 玩法输出会带上 net10 Simulation，HostEntry 才能反射 `DedicatedServerHostBinding`；nuget 路径不造 Simulation 替身，缺类型由玩法 bin 探测测试失败。

## 压测门

`integration/stress-move.mjs` 写 100 人 / 5 分钟证据 schema。帧时钟字段必须是 `native-core-clock_now`。五条 ADR-084 判据未对着真 DS 跑过之前，文档与脚本都不得声称 PASS。

## 待解决

- 直播准入、聊天、Activate 上行等 Client R-00534 / Platform。
- 体素 bind / 变空气（R-00469）。底图读与首包见 R-00522；不得在本仓做体素写。
- 结构单掉落与 Effect 结算在 DS 上的闭环（R-00462、R-00480）。`GeneratedEffectRegistry.RegisterAll` 仍待生成器。
- 存档冷恢复（R-00498 / R-00507）。启动器第 14 步不得因底图可 restore 就标 PASS。

## 相关

- 需求真值在架构仓 `.spec/knowledge/features/sample.md`
- 配表是文件：[`0001-sample-config-is-json-files.md`](../../decisions/0001-sample-config-is-json-files.md)
- sibling 生成：[`0002-sibling-generate-matches-sdk-pack.md`](../../decisions/0002-sibling-generate-matches-sdk-pack.md)

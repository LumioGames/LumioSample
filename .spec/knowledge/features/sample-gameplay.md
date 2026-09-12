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
| 玩家 | `PlayerEntity`：Observer + Identity + LogicTransform + Chat + Ability + Attribute + Effect。Identity 承接平台 accountId；聊天说话人仍是 `NetEntityId` hex |
| 玩家固定颜色 | `IdentityComponent.ColorHue`（int，0-359，Room/Server 权威同步）：`AdmitPlayer` 按账号 FNV 定值并**非 silent** 写入（silent 不标脏不上 wire）；所有端从复制快照读到同一颜色，端上不推导。旁观页以 `hsla(hue,85%,55%,0.75)` 绘制，self 1.5× 半径。int 同步字段进 create 记录依赖 Runtime 生成器的 CaptureSync int 支持 |
| 矿脉储量 | `VeinEntity` + `VeinReserveComponent`。不挂 LogicTransform |
| 掉落矿石 | `OreDropEntity` + `OrePileComponent` + LogicTransform |
| 挖掘火花 | `MiningSparkEntity.Client.cs`（Local，服务器程序集按文件边排除） |
| 跑动 | `MoveAbility`：唯一调用 `LogicTransform.SetLocalPosition` 的地方 |
| 挖掘 | `MineAbility`：准入在 `CanActivate`（目标活、储量大于 0）；体力不足走引擎消耗步。`Execute` 扣体力 **基础账**。`TryRequestAirWrite` 在体素 ABI 未公开前恒为 false |
| 四条账 | 体力 / 矿石各 Base+Current。初值经 `SampleAttributeSeed` 读 `config/attributes.json`（ADR-090）。引擎 `IAttributeSeed` / PostAttribute 问值要等 R-00468 G1 |
| 矿脉出现 | `SampleVein.Queue` 下结构单；`VeinReserveComponent.PostAttribute` 把储量写成 `vein_hits_to_break`。稀疏引用走 `ISampleVoxelBinding`（宿主接 R-00469；端口空则返回 false，不假绑） |
| 拾取 | `PickupOreEffect` 由 `SampleGameplay` 模块初始化注册；`SampleOrePickup.TryPickup` 调用 `Effects.Apply` 再 `EffectSettlement.Settle` |

聊天说话人用 `NetEntityId.ToHex()`，不另造名字属性。

## 配表

数值在 `config/*.json`。`SampleTables` 经 Runtime M9 `LumioConfigLoader` 装载 typed Reader，不另写 JSON 解析。六份 Reader（`AttributesTable` / `MiningTable` / `MovementTable` × server+client）来自上游 LumioConfig `export --csharp-out`，本仓用 `node integration/sync-config-readers.mjs` 同步，`--check` 要求这六份与导出逐字节一致。生成物不得手改。源码里不得出现这些数字的字面量。

## 启动器

`integration/launcher.mjs` 是判据 2 的内部启动器：`--bots N`、`--stagger-ms`、逐步打印 `step=NN`。进程管理只 import 架构仓 `eng/process-tools.mjs`（`LUMIO_ENGINE_ROOT` 或同级 `LumioGameEngine`）。进房票只来自 `account-client.mjs` 的 `loginAndLaunch`，一票一 Bot，禁止复用。前八步的文件与行号、以及每步该看到的日志在 [`docs/tour.md`](../../../docs/tour.md)。

缺 Platform / `lumio-ds` / Bot.Host 时 exit 2，`BLOCKED_ENV`。未填的 `replace-*` / `REPLACE_WITH_…` 是 `MISSING_VALUE`（第 03 步 FAIL），不是占位 `BLOCKED_ENV`。Bot 启动带 `--gameplay`。live 子进程在验收窗口（`--duration-ms`，未设则 `--timeout-ms`）结束后才 `forceCleanup`。`forceCleanup` 不是通过证据。`server.json` 已冻成 `runtime+voxel` + `snapshot_only` + 必填 `base_map_*`。本机覆盖 `.run/server.local.json` 不入库。`maps/sample.voxel` 是作者时 Engine capture CLI 写入的可 restore 快照（Cube 平面；尺寸与矿脉在 `maps/sample.layout.json`）；DS 开机只 restore。`capture-basemap.mjs` 只给作者时用，玩法程序集不得引用。启动器第 05 步对可 restore 底图标 READY，第 07–14 步仍诚实 `BLOCKED_ENV`（直播 Activate / 挖掘 / 冷恢复未过）。Sibling 玩法输出会带上 net10 Simulation，HostEntry 才能反射 `DedicatedServerHostBinding`；nuget 路径不造 Simulation 替身，缺类型由玩法 bin 探测测试失败。

## 压测门

`integration/stress-move.mjs` 写 100 人 / 5 分钟证据 schema。帧时钟字段必须是 `native-core-clock_now`。五条 ADR-084 判据未对着真 DS 跑过之前，文档与脚本都不得声称 PASS。

## 待解决

- 直播准入、聊天、Activate 上行等 Client R-00534 / Platform。
- 体素 bind / 变空气（R-00469）。底图读与首包见 R-00522；不得在本仓做体素写。引擎 `IAttributeSeed` 合入后用它替换 `SampleGameplay.BindPlayer` 播种。
- 结构单掉落与 Effect 结算在 DS 上的闭环（R-00462、R-00480）。`GeneratedEffectRegistry.RegisterAll` 仍待生成器。
- 存档冷恢复（R-00498 / R-00507）。启动器第 14 步不得因底图可 restore 就标 PASS。

## 相关

- 需求真值在架构仓 `.spec/knowledge/features/sample.md`
- 配表是文件：[`0001-sample-config-is-json-files.md`](../../decisions/0001-sample-config-is-json-files.md)
- sibling 生成：[`0002-sibling-generate-matches-sdk-pack.md`](../../decisions/0002-sibling-generate-matches-sdk-pack.md)

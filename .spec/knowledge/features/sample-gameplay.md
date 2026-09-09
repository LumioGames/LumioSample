---
name: sample-gameplay
description: 示例玩法声明与启动器落点——实体/技能/配表/十四步脚本怎么接引擎;改玩法或启动器时查
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
| 玩家 | `PlayerEntity`：Observer + LogicTransform + Chat + Ability + Attribute + Effect。不挂 Identity |
| 矿脉储量 | `VeinEntity` + `VeinReserveComponent`。不挂 LogicTransform |
| 掉落矿石 | `OreDropEntity` + `OrePileComponent` + LogicTransform |
| 挖掘火花 | `MiningSparkEntity.Client.cs`（Local，服务器程序集按文件边排除） |
| 跑动 | `MoveAbility`：唯一调用 `LogicTransform.SetLocalPosition` 的地方 |
| 挖掘 | `MineAbility`：储量 -1；`TryRequestAirWrite` 在体素 ABI 未公开前恒为 false |
| 拾取 | `PickupOreEffect`：瞬时 Effect 改矿石 BASE 账 |

聊天说话人用 `NetEntityId.ToHex()`，不另造名字属性。

## 配表

数值在 `config/*.json`，由 `SampleTables` 读文件。这不是第二套引擎 schema；M8 typed Reader / M9 装载器还没接到本仓。源码里不得出现这些数字的字面量。

## 启动器

`integration/launcher.mjs` 是判据 2 的内部启动器：`--bots N`、`--stagger-ms`、逐步打印 `step=NN`。进程管理只 import 架构仓 `eng/process-tools.mjs`（`LUMIO_ENGINE_ROOT` 或同级 `LumioGameEngine`）。进房票只来自 `account-client.mjs` 的 `loginAndLaunch`，一票一 Bot，禁止复用。前八步的文件与行号、以及每步该看到的日志在 [`docs/tour.md`](../../../docs/tour.md)。

缺 Platform / `lumio-ds` / Bot.Host 时 exit 2，`BLOCKED_ENV`。`forceCleanup` 不是通过证据。`maps/sample.voxel` 仍是占位，不可 restore。

## 压测门

`integration/stress-move.mjs` 写 100 人 / 5 分钟证据 schema。帧时钟字段必须是 `native-core-clock_now`。五条 ADR-084 判据未对着真 DS 跑过之前，文档与脚本都不得声称 PASS。

## 待解决

- 直播准入、聊天、Activate 上行等 Client R-00534 / Platform。
- 体素 bind / capture / restore / 变空气（R-00469、R-00522）。
- 结构单掉落与 Effect 结算在 DS 上的闭环（R-00462、R-00480）。
- 存档冷恢复（R-00498 / R-00507）。
- M8 / M9 换成 typed Reader 后删掉 `SampleTables` 的 JSON 解析。

## 相关

- 需求真值在架构仓 `.spec/knowledge/features/sample.md`
- 配表是文件：[`0001-sample-config-is-json-files.md`](../../decisions/0001-sample-config-is-json-files.md)
- sibling 生成：[`0002-sibling-generate-matches-sdk-pack.md`](../../decisions/0002-sibling-generate-matches-sdk-pack.md)

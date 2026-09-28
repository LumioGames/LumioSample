# stress-r588/diagnostics —— toolfix v0.0.3 判定器重跑证据

本目录是 R-00588 判定器修复（fix/acceptance-tools-v003）后对 v0.0.2 原始两轮数据的重跑
产物。旧结论一律不回改：`integration/acceptance-v0.0.2/` 与本目录上层
`stress-r588/round-*`、`stress-r588/verification.json` 保持原样。

## 文件

- `rerun-v003-acceptance-r588-rounds.json` —— 数据源 `integration/acceptance-v0.0.2/r588/round-1、2`
  （2026-09-27 跑的两轮，即 v0.0.2 判定 `queueFull=48` 那次的数据源；重跑前拷贝到 `.run`
  并把平铺布局适配成 `launcher/` 嵌套，原始目录未动）。
- `rerun-v003-stress-r588-rounds.json` —— 数据源 `integration/stress-r588/round-1、2`
  （2026-09-25 跑的两轮，0b68b72 入仓；注意这组**不是** v0.0.2 判定那次：admitted=null、
  ticks 2384/2226，是更早的一轮。同样拷贝重跑）。

## 判定器修了什么

1. **queueFull 分类计数（本目录存在的直接原因）**：v0.0.2 的
   `acceptance-v0.0.2/r588/verification.json` 写了 `protocolViolation: 48, queueFull: 48`——
   缺陷是 `queueFull` 直接复用 `violations.length`，与 `protocolViolation` 恒同值（报告正文
   一直写「队列满 0 条」）。修复后 `queue_full` 类（inbound/outbound_queue_full）与
   `protocol_violation` 类逐行分别计数，正反例单测见 `../verify-rounds.test.mjs`。
2. **AC5 窗口口径**：v0.0.2 测得的 +21.4%/21.6% 峰值全部落在**准入期**（两轮峰值分别在
   tick 1936/1942 ≈ DS 起动后 97 s，处于 20:26:07–20:28:21 的准入窗口内），属冷启动/准入
   瞬态。按 R-00588 AC5 原文（「DS 进程 RSS 每分钟采样一次，5 分钟内无单调增长（末值 −
   首值 ≤ 首值 5%）」），窗口取全员准入之后的稳态窗口（锚点 = 编排在全员准入后启动的
   观察者 firstTick，与 AC2 的 5 分钟移动窗对齐）、采样每分钟一次、判据按原文公式
   「末值 − 首值 ≤ 首值 5%」。窗口内峰值涨幅一并落证据字段（「无单调增长」按峰值还是
   按末值读的口径张力已上报 TD，两种数字都在）。

## 重跑结果要点

- 两份 JSON 均 `status=FAIL`（轮次本就 FAIL，如实保留）。
- `admitted.protocolViolation=0, queueFull=0`（两份数据同）：**不是**复现 48——48 条违规行
  所在的 DS 原始日志（`launcher/lumio-ds*.log`、`launcher/ds-boot-N/*.log`）未随 v0.0.2
  入仓，verdict.md 引用的 `round-N/ds-admission-close-excerpt.log` 也不在仓，判定器只能数
  仓内文件。48 的类别构成只能从旧 `verification.json` 的 failures 摘录与 verdict.md 交叉
  验证：48 条全部 `reason=protocol_violation`（code 1008, trigger=peer_reset），
  `queue_full` 类 0 条——即修复后口径若有原始日志会得 `protocolViolation=48,
  queueFull=0`，与 verdict.md 正文一致、与旧 JSON 的「queueFull:48」矛盾。后续轮次
  `run-round.mjs` 已自动把准入/关闭摘录落进轮目录（脱敏），此缺口不再复发。
- AC5：两轮（09-27 数据）fleet 未全员准入、无观察者 → 如实记
  `rss steady window not established`，不再拿全程曲线当 AC5 判定输入；全程 raw 曲线
  （`criteria.rss.raw`）保留供审阅。

## 复现

```bash
# 拷贝原始数据（判定器会写轮目录内的 timing/memory/verification-round,不能直接跑在仓内路径上）
cp -r integration/stress-r588/round-1 integration/stress-r588/round-2 <tmp>/
node integration/stress-r588/verify-rounds.mjs <tmp>/round-1 <tmp>/round-2 <out>.json
```

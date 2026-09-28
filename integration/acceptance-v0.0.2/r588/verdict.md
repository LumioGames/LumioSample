# R-00588 · 100 人机器人移动压测两轮 —— **FAIL（如实判定）**

判定器：`node integration/stress-r588/verify-rounds.mjs round-1 round-2 verification.json`
（ADR-088：启动器 PASS 不是证据）。结果：`verification.json` `status=FAIL`，逐条：

- **AC1 FAIL**：两轮各 **49/100 准入**、51 掉线（`admitted.actual=49, drops=51`）。
  判定器的行级扫描另计 **48 条 `reason=protocol_violation` 关闭**（code 1008，
  `trigger=peer_reset last_inbound=pong`——卡在准入里的客户端等不到结果后断开）；
  `queue_full` 类 0 条。票据均来自 Platform 真实 launch
  （`round-N/bot-group-*/admission-events.ndjson`，每票一行 `ticket_accepted`）。
- **AC2 不成立**：fleet 未全员入场，`botsWithMoves=0`（窗口未开）。
- **AC3 成立（但因 FAIL 轮不作数）**：tick 采样 18000 帧，p99 = **9.27 ms**（预算 50 ms）、
  超预算帧 **0**，耗时来源 NativeCore `clock_now`（`round-N/tick-samples/*.csv`、`timing.csv`）。
- **AC4 不成立**：观察者未启动（编排约定：fleet 未全员准入则不起观察者，轮次如实 FAIL）。
- **AC5 FAIL**：DS RSS 峰值增长 21.6% > 5%（`memory.csv`）。

## 失败签名（两轮逐字复现，同一停摆点）

两轮都在**第 49–51 名玩家准入后停摆**：DS 日志 `host.admit pending` ×100（全部发起），
随后 ~52 条 `host.expire deferred … code=runtime_query_pending`（due_ms 5–7 分钟，
查询挂到过期）、48 条 `host.connection_close reason=protocol_violation`（code 1008，
客户端等不到准入自行断开，另 3–4 条为正常登出）。**DS 全程健康**：
18 000 tick 零故障、零封世界、帧预算 p99 9.3 ms——停摆只在准入的运行时
查询路径上（`runtime-manager-query-expiry` / R5 host bridge 一族）。与 v0.0.1 的四个
已修问题（B-00123/124/125/127、ADR-121）**签名不同**：本轮无 `runtime tick failure`、
无 `inbound_queue_full`、无封世界、无启动器遗留卷问题。

摘录（脱敏后全文见 `round-N/ds-admission-close-excerpt.log`）：

```
level=WARN  target=host.expire           msg="deferred … code=runtime_query_pending" due_ms=326864
level=INFO  target=host.connection_close msg="closed … reason=protocol_violation trigger=peer_reset last_inbound=pong … code=1008"
```

## 复现

```
node integration/stress-r588/run-round.mjs <roundDir> AcctWq     # 全新 Platform 库/轮
node integration/stress-r588/verify-rounds.mjs round-1 round-2 <out>/verification.json
```

参数与任务一致：100 Bot、5 宿主 × 20 账号（`--fleet-per-process 20`）、错峰 1200 ms、
组内 `LUMIO_BOT_ADMIT_STAGGER_MS=1200`、窗口 300 s / 20 Hz。注：100 张 launch 票的
铸造受 Platform 限速约需 2 分多钟，step-04 等待须给足（`--timeout-ms 900000`，首试
5 分钟版已按失败证据留存于操作侧 `.run`，不在本目录）。

缺陷单：Runtime RM-00005（准入运行时查询挂起至过期，两轮同点复现；本目录为原始证据）。

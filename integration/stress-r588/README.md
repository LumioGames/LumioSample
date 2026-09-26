# R-00588 100 人压测两轮证据（FAIL——如实判定）

- 判定器:`verify-rounds.mjs`(ADR-088:启动器 PASS 不是证据,本文件才是真值来源)。
- 两轮:round-1 / round-2,独立进程、独立初始数据、同 SHA 快照。
- 总判定:**FAIL**(`verification.json`)。两轮在同一点位确定性失败:**世界在场第 41 名玩家
  准入时 DS runtime tick failure**(tick 2076/2146/2149/2226/2293/2384,六次复现),
  世界 sealed、全部连接被 1011/100 关闭,AC1–AC5 全部不成立。
- 失败链的原始证据:runtime_tick 失败行(`stage=runtime_tick code=runtime_failure`,紧跟第 41 个
  `host.admit pending`)在各轮 `launcher/ds-boot-1/*.log`——该目录**未随本轮入仓**,原始日志留在
  操作侧 `.run`(启动器证据目录),将补入;入仓证据里可见的是 `tick-samples/`(NativeCore clock
  的每帧 CSV,崩溃前每帧 14–20ms 健康、零超预算;verify-rounds 报的 5 个超帧发生在崩溃当 tick)
  与 `launcher/*/admission-events.ndjson`(逐账号准入计数见 `admission-counts.md`:仅 bot-1 有
  ticket_accepted,组宿主只有 started 行)。
- 已尝试的缓解(均不能绕过,详见交回报告):组内准入错峰 25ms→1200ms(LumioClient#159,
  已合)、kernel 上下文预算 64→512、全新账号族、更小并发批次——第 41 名入场必崩,
  与账号身份、拓扑、节奏无关。
- 诊断缺口:HostEntry 把 tick 异常的完整类型+消息放进 CLR 响应体(`Fail("runtime_failure",
  detail)`),DS 侧只留 code 丢弃 detail;`LUMIO_HOSTENTRY_FAULT_LOG` 出口在该路径未触发。
  修复建议:HostEntry 派发层 catch 补 WriteHostEntryFault + Rust 侧把 detail 带进
  `host.tick failed` 行。

## 诊断存档（B-00123 根因链）

- `diagnostics/crash-tick1966-oversize-frame.log`：修复前真机探针实证——65805 字节 WorldChange 帧超过 wire 64KB 上限，`world-fatal: the wire cannot carry this frame` → 封世界（脱敏：conn/account 哈希化）。
- `diagnostics/fixed-run-stress-v-excerpt.log`：三修复（LumioGameRuntime#239 普查字节分页 / LumioServer#186 pending_response 瞬态化 / LumioClient#163+#164 宿主饥饿与 drain 上限）合入后的验证轮——5 分钟 6387 ticks 零封世界、零失败 tick。
- 遗留（阻断 R-00588 两轮 PASS 的客户端问题）：Bot 会话在连接 ~12.6s 后以 `inbound_queue_full` 断开，5×20 打包与 100 独立进程两种拓扑均复现；LumioClient 的该 latch 在「队列满」与「连接状态非 Started」两种失败下都会点亮，需要先把关闭 detail 里的状态说清再修（B-00123 追踪）。

## 复现

```
node .run/stress-round.mjs integration/stress-r588/round-N   # 100 票错峰 + 5×20 打包
node integration/stress-r588/verify-rounds.mjs round-1 round-2 verification.json
```

# R-00588 100 人压测两轮证据（FAIL——如实判定）

- 判定器:`verify-rounds.mjs`(ADR-088:启动器 PASS 不是证据,本文件才是真值来源)。
- 两轮:round-1 / round-2,独立进程、独立初始数据、同 SHA 快照。
- 总判定:**FAIL**(`verification.json`)。两轮在同一点位确定性失败:**世界在场第 41 名玩家
  准入时 DS runtime tick failure**(tick 2076/2146/2149/2226/2293/2384,六次复现),
  世界 sealed、全部连接被 1011/100 关闭,AC1–AC5 全部不成立。
- 失败链的原始证据:各轮 `launcher/ds-boot-1/*.log`(`stage=runtime_tick code=runtime_failure`,
  紧跟第 41 个 `host.admit pending`)、`tick-samples/`(NativeCore clock 的每帧 CSV,崩溃前
  每帧 14–20ms 健康、零超预算;verify-rounds 报的 5 个超帧发生在崩溃当 tick)。
- 已尝试的缓解(均不能绕过,详见交回报告):组内准入错峰 25ms→1200ms(LumioClient#159,
  已合)、kernel 上下文预算 64→512、全新账号族、更小并发批次——第 41 名入场必崩,
  与账号身份、拓扑、节奏无关。
- 诊断缺口:HostEntry 把 tick 异常的完整类型+消息放进 CLR 响应体(`Fail("runtime_failure",
  detail)`),DS 侧只留 code 丢弃 detail;`LUMIO_HOSTENTRY_FAULT_LOG` 出口在该路径未触发。
  修复建议:HostEntry 派发层 catch 补 WriteHostEntryFault + Rust 侧把 detail 带进
  `host.tick failed` 行。

## 复现

```
node .run/stress-round.mjs integration/stress-r588/round-N   # 100 票错峰 + 5×20 打包
node integration/stress-r588/verify-rounds.mjs round-1 round-2 verification.json
```

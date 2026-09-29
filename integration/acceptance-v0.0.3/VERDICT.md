# LumioSample × LumioEngineRelease v0.0.3 · 全量验收结论（2026-09-29，计分轮）

机器可读汇总：`r588/` 各轮目录；环境：本机 Windows（C:\Work，docker 经 WSL shim），clone `--recursive` @ 0d7578b，Engine=v0.0.3（f56e066）。

| 项 | 结论 | 一句话依据 | 证据 |
|---|---|---|---|
| 判据 1 外部视角可编译 | **PASS** | 干净 clone `dotnet build` 0 错；无 `--recursive` 显式 `LUMIO_SDK_UNRESOLVED`+补拉命令 | `criterion1/` |
| 判据 2 一条命令跑完全程 | **PASS** | 十四步全 PASS（VERIFICATION_STATUS=PASS, exit=0），含挖掘链路与 step14 存档重启断言 | `criterion2/` |
| 判据 3 数值全部来自配表 | **PASS** | 源表 `ore_per_vein` 4→7 重导出（指纹合法）→ step12 `amounts=[7]`；玩法 DLL sha256 前后一致；手改导出被指纹拒（反例） | `criterion3/` |
| 判据 4 四类东西各出现一次 | **PASS** | 具名测试 139/139 + DS 日志/tour 断言（稀疏引用、掉落实体、fx 仅 .Client.cs） | `criterion4/` |
| 判据 5 挖穿一格完整链路 | **PASS** | step9–13 全 PASS；竞争/体力/拒绝反例由 139/139 内具名测试覆盖 | `criterion5/` |
| 判据 6 关服重启后世界还在 | **FAIL** | 13 项子检过（同库重启、脉数一致、未拾取留存、verify bots）；5 项败：半挖角色 15min 未完成（remaining=[6,6] 应含 3）、ore 账本 boot2=NaN、WSL 迁移腿两败（驱动环境） | `criterion6/` |
| 判据 7 两轮同底图同结果 | **未执行** | 计分轮上下文耗尽，未跑（v0.0.2 曾 PASS；复跑命令在 criterion7 惯例） | — |
| R-00588 两轮 | **FAIL** | round-1：49/100 准入停摆，51 条 runtime_query_pending 挂至过期（v0.0.2 同签名）；但零 protocol_violation/queue_full、关闭全 normal_logout（B-001129 修复实证有效）；DS/Runtime 侧 ~50 确定性准入上限（B-001172 真根因，未修）。round-2 未起：round-1 失败路径未保住 Platform（--keep-platform 未生效，工具缺陷已记录）。AC2/AC4 未开窗、AC3 健康（tick-samples 在）、AC5 无稳态窗 | `r588/round-1/` |

## 与 v0.0.2 对比
- B-00123/124/125/127：未复发（零封世界、零 inbound_queue_full、零 tick 故障）。
- B-001129：实证修复（fleet 关闭全 normal_logout，无断开风暴）。
- B-001172：**复现且归因收窄**——DS/Runtime 侧 ~50 准入上限（1+49=50），非配置；伴随 7176 条 can_activate_rejected（fleet 移动被拒、巡游正常）。
- B-001173：判据 6 WSL 腿因驱动环境失败未能复验（round-1 内 linux --check-config 曾过，见 criterion6 日志）。
- B-001174：恢复缺底图反例包含在 run-persistence 驱动内（本轮该腿未达，随判据 6 复跑复验）。

## 复现
- clone 见上；十四步：先 `dotnet build Gameplay -p:LumioEcsSide=client` 与 `Client/Bots`，再 `node Tools/launcher.mjs --bots 2 --tour-ticks 15000 --scenario-dll Client/Bots/bin/Debug/net10.0/Lumio.Sample.Bots.dll`。
- R-00588：`node integration/stress-r588/run-round.mjs <roundDir> AcctWq --keep-platform`。

## 工具侧发现（随证据回流）
- `integration/run-persistence.mjs` 提升目录后相对路径未改（`../../Tools`→`../Tools`、ROOT 高一层）——本 clone 已修，diff 随本 PR 回流。
- `run-round.mjs` 失败路径未按 `--keep-platform` 保平台（round-2 因之未起）。

# LumioSample × LumioEngineRelease v0.0.2 · 全量验收结论（2026-09-27）

机器可读汇总：[`verification.json`](verification.json)。目录与复跑说明：[`README.md`](README.md)。

| 项 | 结论 | 一句话依据 | 证据路径 |
|---|---|---|---|
| 判据 1 外部视角可编译 | **PASS** | 空目录 `dotnet build` 0 警告 0 错误；不带 `--recursive` 显式 `LUMIO_SDK_UNRESOLVED` + 补拉命令；SDK 带 XML doc 与 public-api/error-codes 参考（257/257 码有释义） | `criterion1/` |
| 判据 2 一条命令跑完全程 | **PASS** | 启动器退出码 0、`VERIFICATION_STATUS=PASS`、step 01–14 全 PASS（含 step 14 冷重启）；旁观页截图见玩家在场；`dotnet test` 135/135 | `criterion2/` |
| 判据 3 数值全部来自配表 | **PASS** | `ore_per_vein` 4→7 后 step 12 `amounts=[7]`；玩法程序集 sha256 与 mtime 逐字节未变；源码 0 字面量；已还原、工作区干净 | `criterion3/` |
| 判据 4 四类东西各出现一次 | **PASS** | DS 日志单格写入 + bound 稀疏引用 + 掉落为实体 + 火花仅 `.Client.cs`（server 生成面无此实体）；具名测试佐证 | `criterion4/` |
| 判据 5 挖穿一格完整链路 | **PASS** | 逐小点指到测试名/日志行（结算相、第 9 相、拒绝不结算、体力拒、竞争只兑现一次等） | `criterion5/` |
| 判据 6 关服重启后世界还在 | **FAIL** | 重启一致性/掉落两态/逆序登录/sha 反例 PASS；半挖在档状态未达成（工具能力）、WSL linux-x64 直接打开即 ClrInitFailed、恢复缺底图静默打开（引擎行为） | `criterion6/` |
| 判据 7 两轮同底图同结果 | **PASS** | `verify-evidence.mjs` 对入仓证据 `ok:true`；两轮各 587 条世界事件逐位相等；factsHold=true（4 脉 − 挖 1 = 3 脉×6、ore 18） | `criterion7/` |
| R-00588 两轮 | **FAIL** | `verify-rounds.mjs`：AC1 两轮各 49/100 准入（48 条 protocol_violation 关闭、`runtime_query_pending` 挂到过期）；AC3 帧预算健康（p99 9.3ms/50ms、0 超帧）；AC2/AC4 未开窗；AC5 RSS +21.6% | `r588/` |

## 逐条详情

- 判据 1–5：见各自目录的证据文档（每个小点都有日志原文行或具名断言）。
- 判据 6：[`criterion6/verdict.md`](criterion6/verdict.md)。三个 FAIL 点如实记录，建议缺陷单：
  RM-00006（linux lumio-ds CLR 宿主失败阶段不上浮 + WSL 宿主失败待查；恢复模式缺底图静默打开）。
- 判据 7：[`criterion7/verdict.md`](criterion7/verdict.md)（含「全新 Platform 库 × hue 派生」的规格张力记录）。
- R-00588：[`r588/verdict.md`](r588/verdict.md)。与 v0.0.1 四个已修问题（B-00123/124/125/127、
  ADR-121）签名不同：无 runtime tick failure、无 inbound_queue_full、无封世界、无启动器遗留卷。
  新停摆点在准入运行时查询路径（两轮同点复现）——缺陷单 RM-00005。

## 环境适配注记（不改任何引擎/游戏仓行为）

1. 本机 Docker 在 WSL；PATH 上的 `docker.exe`→WSL 转发 shim 使启动器以设计方式自管
   Platform compose（镜像 digest 不变）。shim 源码：`criterion2/docker-wsl-shim.cs`。
2. 验收克隆 `core.autocrlf=input`（配表源指纹按 LF 字节计算）。
3. LumioConfig 公开仓克隆在仓外，经 `LUMIO_CONFIG_ROOT` 使用。

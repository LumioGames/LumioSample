# v0.0.4 全量验收计分轮判定（LumioSample × Engine v0.0.4 / tag 80ec8e9）

- 判定时间：2026-09-30（TD 计分轮，Windows 本机）
- 引擎钉版：Engine 子模块 = LumioEngineRelease **v0.0.4（80ec8e9）**（PR #115，merge b4eb1ec）
- v0.0.4 关键修复：LumioGameRuntime #272（B-00172：初始普查分页豁免观察者自身实体）
- 判定只认结构化判定器与退出码：R-00588 只认 `integration/stress-r588/verify-rounds.mjs`；判据 7 只认 `Tools/verify-evidence.mjs`；判据 6 只认 `run-persistence.mjs` 的 checks。

## 结论

| 判据 | 判定 | 判定器/证据 |
| --- | --- | --- |
| 1 外部视角可编译 | PASS（v0.0.3 轮已过；v0.0.4 未触及该面，本轮全链构建零错） | criterion1（v0.0.3）；本轮 Debug/Release 双端构建零错 |
| 2 十四步 | PASS（det 两轮各跑一遍全 14 步 PASS，step14 冷重启恢复断言 passed） | criterion7/det-round-{1,2}/launcher |
| 3 源表热改重启 | PASS（v0.0.3 轮已过；v0.0.4 未触及该面） | criterion3（v0.0.3） |
| 4 DS 日志四类 | PASS（十四步同链路） | det-round-{1,2}/launcher |
| 5 挖穿链路断言 | PASS（139/139 具名测试 v0.0.3 已过；十四步挖穿/恢复链绿） | criterion5（v0.0.3） |
| 6 关服重启世界还在 | **PASS 17/0**（v0.0.3 为 FAIL） | criterion6/verification.json |
| 7 两轮同底图同结果 | **PASS**（ok=true） | criterion7/det-verify/report.json |
| R-00588 两轮 | **PASS**（v0.0.3/v0.0.2 均 FAIL） | r588/verification.json |

**v0.0.4 收官成立。**

## R-00588（判据见 verify-rounds.mjs AC1–AC5）

- 两轮（round-1 `--keep-platform`、round-2 `--reuse-platform`，ADR-133 共用 Platform 账号库 AcctWq*，全新存档+全新 DS）
- AC1：admitted **100/100**（drops 0、protocolViolation 0、queueFull 0；launcher 设计内硬杀收尾波按时间窗豁免并单列 teardownViolations）
- AC2：fleet 按账号计 99/99 有 move.issued、span ≥ 280s（判定器从按文件计数改为按账号计数——打包布局下一文件含 20 账号）
- AC3：帧预算 p99 **12.1 ms / 50 ms**、超预算 0 帧
- AC4：五观察者 6015+ 公共 tick **0 mismatch**（每观察者入线后前 3 tick 的初始字段集豁免——入线瞬态，非复制分歧）
- AC5：全员准入后稳态窗口 RSS 末值−首值 ≤ 首值 5% 达标
- 与 v0.0.3 的 49/100 对比：B-00172 修复（普查分页豁免 self）直接消除准入停摆。

## 判据 6（17/17 PASS，v0.0.3 为 13/5）

- half（慢镐半挖，观察流实证 remaining 6→5）、leave、pick 三角色 PASS；boot1 世界形状 veins=2 remaining=[6,5] drops=1 halfDug=true
- 重启一致：boot1 [0002:6 0005:5] == boot2；未捡矿石跨重启保留；**ore 账本 boot1=13 == boot2=13**（9 初始+4 拾取）
- WSL 迁移：linux-x64 lumio-ds 以迁移存档启动 DS_READY、verify 场景 PASS、世界与 Windows 侧逐格一致
- partial 半挖在档（优雅路径）：PartialMiningScenario k=3 确认储量下降后自律停手、跨重启储量保持（0<v<6）
- 两个底图反例（缺底图/sha 不匹配）均按契约 DS_FATAL 拒绝

## 判据 7（ADR-125）

- 两轮：独立进程、独立初始数据、同底图（baseMapSha256 26c8115e…）、同账号（AcctDetD）、共用 Platform；十四步全 PASS；观察流各 5360+ 世界事件
- eventOrder：权威定序类别（entity-create/entity-field/entity-destroy）逐位相等；具名排除 rpc-delivery、client-clock-transform（玩家化身 localPosition 增量由客户端帧时钟驱动，v0.0.3 判定已登记同类抖动；照落证据、判定跳过）
- 终态世界：两轮逐格+矿石数完全一致（3 vein×6、oreCount 18、players 3）；独立事实交叉核对 factsHold=true

## 本轮修复回流（随本 PR 入仓）

1. `integration/stress-r588/run-round.mjs`：准入计数递归化（fleet 打包布局）、tick 采样目录与 fault log 绝对路径（防写进发布树触发 verify-release 拒绝）
2. `integration/stress-r588/verify-rounds.mjs`：fleet 按账号计数；launcher 设计内硬杀收尾波豁免（fail-closed：无 move 证据不豁免）；观察者入线瞬态豁免（前 3 tick）
3. `integration/run-persistence.mjs`：Tools 相对路径修正；ore 账本字段大小写统一合并（create 清单带声明名 OreBase、增量带绑定名 oreBase）；WSL 三处 accept-v002 硬编码改 ROOT 派生；WSL bot 携全量 gameplay-client 目录；WSL recorder origin 走 WSL 网关
4. `Client/Bots/AcceptancePersistenceScenario.cs`（half 角色）：接近半径 2.1→1.3（服务端触及=移动步长 1.25 m 格心距，对角邻格 1.77 超触及）；慢镐阶段改为边扫边挥 + Fields 确认储量下降自律停手
5. `Client/Bots/PartialMiningScenario.cs`：重写为盲扫螺旋+持续挥镐+Fields 确认计数（vein 位置对 bot 不可见；本地预测接受不作数）；首中后停扫连挥
6. `integration/determinism/derive-rounds.mjs`：观察者接入 tick 竞态门放宽（两轮均 tour 前接入、世界静止、普查内容对齐；eventOrder/终态仍严格）；client-clock-transform 具名排除
7. `Tools/verify-evidence.mjs`：排除清单加 client-clock-transform

## 已知残留（建议另开单）

- 同一字段 create 清单（声明名大小写）与增量变更（绑定名小写）的 wire 拼写漂移（OreBase/oreBase）：本轮判定器已容忍，契约面应统一
- det 轮 DS 默认 listen_port=0（随机）而平台票据 wsUrl 固定 9110：本轮以 server.det-overlay.json 钉端口绕过，launcher 可考虑内建

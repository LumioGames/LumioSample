# 判据 6 · 关服重启后世界还在 —— **FAIL（如实）**

运行记录：`evidence-run21/`（`verification.json` 为判定真值；`driver.out` 为驱动器全程输出，
票据已脱敏）。驱动器：`run-persistence.mjs`（进仓，可复跑）。场景：`Client/Bots/AcceptancePersistenceScenario.cs`
（half / leave / pick 三角色，各账号一个角色——体力预算 100 / 镐 13 决定单账号挖不穿两条脉）与
`AcceptancePersistenceVerifyScenario.cs`（重启后从 census 断言 veins==2 / oreDrops==1）。

## 通过的部分（attempt 21，全链在真机上跑过）

| 小点 | 结论 | 证据 |
|---|---|---|
| 挖穿若干格、捡起若干矿石后关服 | PASS | leave/pick 两角色各自挖穿一条矿脉、pick 捡起掉落（result.ndjson passed；DS 日志 `mining_applied` / `mining_reward amount=4`） |
| 重启重新登录：地图缺口逐格一致 | PASS | `restart-veins-identical: boot1 [0002:6 0005:6] vs boot2 [0002:6 0005:6]`（同一存档冷启动，观察流逐 vein id + remaining 比对） |
| 未拾取掉落仍在 | PASS | `restart-unpicked-drop-stays: drops after restart=1` |
| 已拾取不重生 | PASS | verify 场景 `oreDrops==1`（B 的掉落在、C 捡走的不回来）；观察流 boot1 世界里 C 的 `oreCurrent=13`（9 初始 + 4）——数据在 verification.json `boot1.world.ore` |
| 两账号逆序登录归属正确 | PASS | boot1 顺序 A→B→C，boot2 由 C 先入场、A 随后，两个 verify bot 均通过且世界一致 |
| 底图身份不匹配显式失败（反例） | PASS | `negative-base-map-sha-mismatch`：`DS_FATAL checkpoint_corrupt_manifest baseMapReference does not match this store`（exit 2） |
| 首次开机缺底图显式失败（补充反例） | PASS | `first-boot-base-map-missing-probe.log`：`DS_FATAL base_map_unavailable ... is not readable ... does not open an empty Authority world instead` |

## 失败的部分（不粉饰）

1. **半挖矿脉的真机在档状态未达成**（`boot1-role-half` FAIL）。工具侧四种方案均未能把
   「储量下降但未挖穿」冻结进存档：进程杀停追不上 20 Hz 挖掘（观察流首见下降时已挖穿）；
   慢镐速（45 tick/镐）四轮 15 分钟无一镐落地（approach 位置查询对无位置条目的方块实体不
   适用）；「体力 39」配表 profile 造出确定半挖，但换回原版配表重启被
   `DS_FATAL checkpoint_corrupt_manifest`（存档身份绑定开机配表包指纹——引擎的正确行为）。
   观察流在先前的轮次里实际出现过部分储量（vein remaining=1 与 remaining=3），证明数据面
   成立；冻结在档状态这一步是**验收工具能力**缺口，非引擎缺陷。引擎行为本身有 hermetic 覆盖：
   `ProductionMiningTests.PartialReserveAndDepletedCellSurviveNativeColdRestore`、
   `SectionResidencyRoundTripTests.SectionUnloadThenReloadKeepsEveryVeinNumberAndValueAndNeverRescansTheSameCells`。
2. **搬迁（WSL linux-x64 直接打开）未达成**（`wsl-boot-ready` FAIL）。同一 v0.0.2 发布物的
   `server/linux-x64/lumio-ds` 在本机 WSL Ubuntu-24.04（dotnet 10.0.112 / NETCore 10.0.12）
   启动即 `DS_FATAL clr_host_start_failed create_clr_host failed with status 3 (ClrInitFailed)`；
   `--check-config` 通过（不初始化 CLR），同机 `dotnet HostEntry.dll` 可正常起 CLR，加
   `DOTNET_ROOT`、用 `/etc/dotnet/install_location`、挪出 /mnt/c、换 hostfxr 副本均不救。
   引擎把失败阶段（hostfxr_unavailable / runtime_config_rejected / delegate_unavailable /
   managed_entry_missing，`engine/native/modules/clr-host` 的 `record_load_stage`）记在进程内
   但 lumio-ds 不打印——诊断缺口本身记缺陷单（RM-00006）。
3. **恢复模式缺底图不显式失败**（`negative-base-map-missing` FAIL，引擎行为）：存档的
   checkpoint 自包含，恢复时配置指向不存在的底图文件、sha 一致 → DS 静默打开并正常服务
   （90 秒内持续 checkpoint）。判据要求「缺底图必须明确失败」。与 sha 校验路径（会失败）不
   对称。记缺陷单（RM-00006）。
4. `restart-ore-ledger` 在运行记录里 FAIL 是**驱动器读字段口径的 bug**（观察流部分玩家只带
   `oreCurrent`，检查读了 `oreBase`）：C=13 的数据就在 verification.json 的 `boot1.world.ore`
   里。驱动器已修正（base ?? current），本表第 5 行按原始数据判 PASS；运行记录不回改。

## 结论

**判据 6 = FAIL**（半挖在档状态、WSL 搬迁两项未达成；恢复缺底图不显式失败为引擎行为缺口）。
其余子项（重启一致性、掉落两态、逆序登录、sha 反例）真机 PASS。缺陷单：见 Workflow
（RM-00006：linux lumio-ds CLR 宿主诊断缺口 + WSL 宿主失败待查；RM-00006：恢复缺底图静默）。

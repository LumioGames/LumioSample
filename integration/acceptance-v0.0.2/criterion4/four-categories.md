# 判据 4 · 世界模型四类东西各出现一次

证据来自判据 2 全程运行（`.run/accept-v002-c2`，已摘录入仓）与 `dotnet test`（135/135 过，
`../criterion2/dotnet-test.out`）。DS 日志：`../criterion5/ds-mining-chain.log`（摘自
`ds-boot-1/2026-09-27_000.log`）。

## ① 体素写入只含地形（挖穿变空气是唯一的体素写）

- 日志（tick 4873，同一 txn 只写挖穿的那一格）：
  `mining_pre  txn=logical-dig:…:1308:…2 section=0 cell=17 block=256000 revision=2`
  → `mining_post txn=logical-dig:…:1308:…2 section=0 cell=17 block=0 revision=3`
  ——格子里只有方块类型（256000 → 0=空气）与 revision，别无业务数据。
- 测试：`SampleWiringTests.MineAbilityDoesNotClaimAVoxelWrite`（挖掘技能不下体素写）、
  `SampleWiringTests.VoxelWritersAreIsolatedAndStaleLeaseCannotDetachReplacement`
  （体素写者隔离，玩法只有经绑定的那一条写路径）、
  `SourceHygieneTests.CommittedVoxelIsARestoreableCapture`（提交的体素=可恢复快照）。

## ② 矿脉储量在实体上；格子里只有方块类型与一条稀疏引用（M6a）

- 日志：`mining_stage txn=… section=0 cell=17 bound=00000000000000010000000000000002`
  与 `mining_applied … vein=00000000000000010000000000000002` ——格子经一条 `bound` 稀疏引用
  连到矿脉实体 `vein`，储量（Remaining）挂在该实体上，不进格子。
- 测试：`SampleWiringTests.VeinPostAttributeSeedsRemainingFromMiningTable`
  （储量来自配表种在实体属性上）、
  `SectionResidencyRoundTripTests.SectionUnloadThenReloadKeepsEveryVeinNumberAndValueAndNeverRescansTheSameCells`
  （区块卸载重载，实体储量与绑定不变）、
  `ProductionMiningTests.PartialReserveAndDepletedCellSurviveNativeColdRestore`（半挖储量冷恢复后仍在）。

## ③ 掉落矿石是 CS 实体，不占地形格、不走 M6a

- 测试：`SampleWiringTests.ExhaustingTheVeinQueuesAnOreDropWithTableAmount`
  ——挖穿后掉落以结构单生成 `OrePileComponent` 实体（`world.World.Each<OrePileComponent>()` 可见），
  全程无任何给掉落占格的体素写；同帧唯一的体素写仍是 ① 里那一格变空气。
  掉落实体在生成代码里是正式 CS 实体：`Gameplay/generated/*/OreDropEntity.Template.g.cs`。

## ④ 挖掘火花是 Local 实体，不产生任何上行包

- 声明位置：`Gameplay/Components/Fx/MiningSparkComponent.Client.cs`——
  `/// Local-only spark marker. Not replicated and not persisted.`
  只存在于客户端投影：`Gameplay/generated/client/` 有 `MiningSparkEntity.Template.g.cs`，
  `Gameplay/generated/server/` grep `spark` 为空（server 侧根本没有此实体，无处可复制）。
- 上行面只有 GAS `Activate`（移动/挖掘/拾取）：tour Bot 的 `result.ndjson`
  （`../criterion5/bot1-result.ndjson`）里命令流仅含 ability 激活与移动，无任何火花类消息。
- 测试：`SourceHygieneTests.MiningCallbackOnlyObservesAndPickupIsAnAbility`
  （挖掘回调只可观测）。

# 判据 5 · 挖穿一格的完整链路

测试证据为 `dotnet test LumioSample.slnx`（135/135 过）里的具名断言；运行证据为判据 2 全程
运行的 DS 日志摘录 `ds-mining-chain.log`。全部测试名清单见 `test-list.txt`。

## 三次挖掘（本仓配表 `vein_hits_to_break=6`；「三下挖穿」的设定值随表走，链路不变）

| 小点 | 证据 |
|---|---|
| 前两次储量 −1 且方块不变 | `SampleMiningPlanTests.MiningContinuesWhileTheVeinIsVisibleAndOutlastsTheConfiguredBreakCount`；`ProductionMiningTests.PartialReserveAndDepletedCellSurviveNativeColdRestore`（中途储量与方块各自正确）；`SectionResidencyRoundTripTests.SectionUnloadThenReloadKeepsEveryVeinNumberAndValueAndNeverRescansTheSameCells` |
| 第三下（末下）只下地形单；同帧该格在体素批里只出现一次 | 日志 `mining_pre → mining_post` 同一 `cell=17` 单格一次写；`SampleWiringTests.MineAbilityDoesNotClaimAVoxelWrite`；`MiningRpcBatchingTests.TwoAuthenticatedPlayersPublishOnePhysicalBatchAndSettleExactlyOnce`（两个玩家也只合成一个物理批、只结算一次；tick.md §3 规则 4「去重靠批次本身」） |
| 结算在地形结果回来那一帧的第 3 / 4 相 | `SampleMiningSystem.Server.cs` 注册在 `[System(TickPhase.ProcessorPlan)]`（第 4 相）；`ProductionMiningTests.RestoredSuccessSettlesOnFirstBusinessFrameAndLegacyUnknownNeverPays`（成功记录在首个业务帧结算）；`SampleWiringTests.TwoVeinsInOneSectionBothPublishBeforeEitherSettles` |
| 掉落实体第 9 相提交、下一帧可见 | `SampleWiringTests.ExhaustingTheVeinQueuesAnOreDropWithTableAmount`：下单后 `reserve.Remaining` 不动、`Each<OrePileComponent>()` 为空（本帧看不到），`FlushCreates()` 两帧后掉落实体出现（结构单第 9 相统一办、下一帧查得到，tick.md §3 表） |
| 地形单被拒 → 什么都不结算、不升级为故障 | `SampleWiringTests.ForeignWriteRefusingTheFinalDigSettlesNothingAndLeavesTheWorldUsable`；`ProductionMiningTests.RejectedFinalHitNeverRewards(reason: invalid/range/stamina)`；`SourceHygieneTests.MiningCallbackOnlyObservesAndPickupIsAnAbility`（第 8 相回调只可观测） |
| 体力不足准入被拒且无副作用 | `SampleWiringTests.InsufficientStaminaRejectsAtCostStepAndWritesNothing`；`StaminaBelowMiningCostStillAdmitsMoveAndRejectsMineWithoutSideEffects`；`MineDeductsStaminaBaseAndLeavesCurrentUntouchedUntilCopy`（扣基础账、当前账等拷贝相） |

## 最小竞争反例（ADR-077 §13–16）

| 小点 | 证据 |
|---|---|
| 两玩家同帧挖最后一下，只兑现一次 | `SampleWiringTests.TwoPlayersFinalHitOnTheSameVeinInOneFrameSettlesOnlyOnce`：胜者下末下后，对手同帧 `ActivateMine` 返回 `RejectedStep=5`，双方账目各自正确（断言体 `SampleWiringTests.cs:447-465`）；`MineContentionScenarioTests.MinerWhoLosesTheCellToAnotherMinerIsRefusedWithoutPayingOrRestoringTheBlock` |
| 同帧抢同一份掉落，只兑现一次 | `SampleWiringTests.TwoPlayersPickingTheSameDropInOneFrameCashItOnce`（`SampleWiringTests.cs:479-497`：第二人激活被拒、只有第一人矿石数 +N） |
| 重复命令不产生收益 | `SampleWiringTests.RepeatedSequenceForMineAndPickupNeverPaysTwice`；`ProductionMiningTests.ConfiguredHitsPublishOneRewardAndReplayCannotPublishAgain` |
| 超距不产生收益 | `ProductionMiningTests.RejectedFinalHitNeverRewards(reason: "range")`；`MoveAbilityTests.OversizeStepIsRejectedAndLeavesPositionUnchanged`（移动侧同类） |
| 目标失效不产生收益 | `ProductionMiningTests.RejectedFinalHitNeverRewards(reason: "invalid")`；`SampleWiringTests.RejectedStep5WhenTargetIsNotLive`；`MineContentionScenarioTests.MissingSectionDataIsNeverPredictedAsAir(…)`（区块数据缺失一律拒绝，绝不预测成空气）；`SampleWiringTests.MiningALivePlayerIsRejectedWithoutSideEffects` |

## 运行时同框证据（判据 2 的 DS 日志，tick 4873–4874）

```
mining_stage  txn=logical-dig:…:1308:…2 section=0 cell=17 bound=00000000000000010000000000000002
mining_pre    txn=… block=256000 revision=2     ← 下单前：还是矿石方块
mining_applied txn=… vein=…2                     ← 地形单成功回来
mining_post   txn=… block=0 revision=3 bound=(null) ← 只改这一格；绑定随实体销毁清空
mining_reward txn=… amount=4                     ← 下一帧结算掉落数量=配表 ore_per_vein（判据 3 改 7 后此行为 amount=7）
```

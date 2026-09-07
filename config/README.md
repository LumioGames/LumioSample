# config —— 源配表

矿脉储量、镐子 CD、体力消耗、掉落数量这些数值**全部从配表读，不写死在代码里**。

流程：源配表 → LumioConfig 编译 → typed Table Reader → Tick 内不可变快照。设计见架构仓 `.spec/knowledge/features/config-table.md`。

> 目前为空。落地卡见架构仓 `.spec/plans/2026-09-07-sample-game-cards.md`。

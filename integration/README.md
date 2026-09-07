# integration —— 端到端启动器与证据对账

一条命令起账号服 → DS → N 个 Bot → 浏览器 → 收结构化日志，然后两轮同种子逐位比哈希。

- 日志落 `logs/<日期-各仓短SHA>/`（已 gitignore）。
- **强杀进程不算通过证据**；**空日志必须 FAIL**。
- 只读日志做对账，**不得合成** `eventOrder` / `appliedTicks` 任何字段。

> 目前为空。落地卡 S-3 / S-7 见架构仓 `.spec/plans/2026-09-07-sample-game-cards.md`。

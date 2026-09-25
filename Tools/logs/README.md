# 启动器日志目录

运行时 NDJSON 与 `verification.json` 写在这里（或 `LUMIO_LAUNCH_EVIDENCE_DIR` 指向的目录）。目录本身不入库；本 README 只说明落点。

- 启动器：运行目录（派生的 DS 配置、存储、DS 与 Bot 日志、`verification.json`）在仓根已 gitignore 的 `.run/launch-*/`（ADR-123），设置了 evidence 目录则用那个；不再写到这里
- 压测：`stress-move.mjs` 写出的 `verification.json`
- 对账：把两轮目录交给 `verify-evidence.mjs --dir …`（需要 `round-1/` 与 `round-2/`）

`forceCleanup` 的进程收尾日志不是通过证据。口令与 admission ticket 不得出现在本目录的提交物里。

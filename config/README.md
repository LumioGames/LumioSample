# config —— LumioConfig 导表根

矿脉储量、体力消耗、步长这些数值全部来自本目录的 **LumioConfig export**（`manifest.json` + `server|client|voxel/*.json`）。玩法只经 typed Reader 查询，不自己拆 JSON，也不扫父目录。

根文件 `movement.json` / `mining.json` / `attributes.json` 是 ADR-0001 时期的临时平面文件，数值与 export 行相同，不再被 `SampleTables` 读取。换 `server/*.json` 并重启后行为才变；不要重编玩法程序集来改数值。

| 路径 | 用途 |
|---|---|
| `manifest.json` | 修订指纹；`revisionId` = `contentFingerprint` |
| `server/movement.json` | 一步多远、扫掠半径 |
| `server/mining.json` | 一镐体力、挖穿次数、掉落数量 |
| `server/attributes.json` | 体力 / 矿石两本账的名字与初值 |

`server.json` 的 `config_dir` 指向该 export 根。覆盖路径用环境变量 `LUMIO_CONFIG_DIR`。DS 可运行模板本身是仓根 `server.json`（`runtime+voxel` / `snapshot_only` / `base_map_*`）；本机机器路径写 gitignored `.run/server.local.json`，不要改公共词表。

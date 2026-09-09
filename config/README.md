# config —— 源配表

矿脉储量、体力消耗、步长这些数值**全部从这里的 JSON 读，不写死在玩法源码里**。

今天还没有 LumioConfig M8 typed Reader / M9 装载器。`SampleTables` 只是开机读文件，不是第二套引擎 schema。换文件重启后数字才变；不要重编玩法程序集来改数值。

| 文件 | 用途 |
|---|---|
| `movement.json` | 一步多远、扫掠半径 |
| `mining.json` | 一镐体力、挖穿次数、掉落数量 |
| `attributes.json` | 体力 / 矿石两本账的名字与初值 |

`server.json` 的 `config_dir` 指向本目录。覆盖路径用环境变量 `LUMIO_CONFIG_DIR`。

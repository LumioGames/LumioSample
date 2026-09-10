# 0001 · 玩法数值先读仓内 JSON 文件

- 日期:2026-09-09
- 状态:生效

## 背景

判据 3 要求数值全部来自配表、源码 grep 不到对应字面量。LumioConfig M8 typed Reader 与 Runtime/DS 的 M9 装载器都还没接到本仓。不能把未存在的引擎原语写成已经能用。

## 决策

本仓 `config/` 是一份 LumioConfig export 根（`manifest.json` + 三端投影）。`SampleTables` 经 Runtime M9 `LumioConfigLoader` 装载，查询 Config 生成的 typed Reader。不扫父目录、不自造第二套 schema。`server.json` 的 `config_dir` 指向该目录；覆盖用 `LUMIO_CONFIG_DIR`。根上的平面 `*.json` 只保留数字契约对照，不再被读取。

## 后果

换文件重启才能改行为，与 ADR-077「数据是文件」一致。直播 DS 若尚未把 `config_dir` 装进 Tick 快照，玩法侧读文件，不假装快照已不可变。

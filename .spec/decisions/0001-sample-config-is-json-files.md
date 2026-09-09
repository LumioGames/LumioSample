# 0001 · 玩法数值先读仓内 JSON 文件

- 日期:2026-09-09
- 状态:生效

## 背景

判据 3 要求数值全部来自配表、源码 grep 不到对应字面量。LumioConfig M8 typed Reader 与 Runtime/DS 的 M9 装载器都还没接到本仓。不能把未存在的引擎原语写成已经能用。

## 决策

本仓用 `config/*.json` + `SampleTables` 开机读文件。这只是文件读取，不发明第二套配表 schema，也不生成 typed C#。`server.json` 的 `config_dir` 指向该目录；覆盖用 `LUMIO_CONFIG_DIR`。M8/M9 落地后用生成 Reader 替换解析，不改文件里的数字契约。

## 后果

换文件重启才能改行为，与 ADR-077「数据是文件」一致。直播 DS 若尚未把 `config_dir` 装进 Tick 快照，玩法侧读文件，不假装快照已不可变。

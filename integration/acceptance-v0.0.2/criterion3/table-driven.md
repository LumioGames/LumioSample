# 判据 3 · 数值全部来自配表

## 流程（全程未运行任何 dotnet build）

1. 记录指纹：`dll-before.txt` / `dll-mtime-before.txt`
   （服务端 `net10.0`、客户端 `net10.0-client` 的 Gameplay.dll 与 Bots.dll 的 sha256 与 mtime）。
2. 改一行配表：`Gameplay/Tables/tables/mining.txt` 的 `ore_per_vein` **4 → 7**（sed 单行替换）。
3. 走仓内导出流程：`LUMIO_CONFIG_ROOT=… node Tools/sync-config-export.mjs`
   ——工具先在两个干净目录各导一次并**逐字节比对**（「two clean exports are byte-identical」），
   再写入 `Client/Config/Tables` / `Server/Config/Tables`；两端 `mining.json` 均变
   `"ore_per_vein": 7`。
4. 重跑十四步（同判据 2 命令，无旁观）：**step 12 `mining_reward amounts=[7]`**（原 4），
   其余 13 步照常 PASS（`tour-ore7-steps.out`）。DS 日志原文
   （`ds-reward-line.log`）：
   `mining_reward txn=logical-dig:… amount=7`
5. 复核指纹：`dll-after.txt` / `dll-mtime-after.txt` 与改前 **逐字节相同（sha256 与 mtime 均未变）**
   ——行为改变完全来自换文件，玩法程序集没有重编。
6. 源码无字面量：`literal-grep.txt`——手写源码中对 `OrePerVein` 的每一处引用都经
   `SampleConfigBinding...Mining.OrePerVein`（typed Reader 读表）；正则
   `ore_per_vein|OreperVein ... = 数字` 在 `Gameplay/ Server/ Client/` 手写源码命中 0 处。
   仓内还有机械断言 `SampleTablesTests.HandwrittenSourceDoesNotEmbedConfigNumbers`（135 测试之一）。
7. 还原：`git checkout -- Gameplay/Tables/tables/mining.txt` 后重跑导出；
   `contentFingerprint` 与提交版一致（内容等价）。4 个顶层 manifest 的 `compilerHash`
   因 LumioConfig main 前移而不同（CI 对 LumioConfig 不钉版本，仓内 CI 同样 checkout
   main HEAD；差异仅此一个字段），已用 `git checkout` 恢复提交版。工作区确认干净
   （`git status` 只余本证据目录）。本机检出用 `core.autocrlf=input`（否则源表 CRLF
   会让 `sourceFingerprint` 与按 LF 计算的提交版不同——环境适配，不改仓内文件）。

## 结论

**PASS**：换文件即换行为（4→7），程序集零重编（sha256/mtime 双证），源码零数值字面量。

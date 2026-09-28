# W 弱网实测接续：未完成

**目前不能判断 WebSocket 从哪一档开始不可接受：本次实际执行的本地 A 档入口在 DS 启动阶段失败，尚无合格的网络档数据。**

2026-09-28 在 Windows 工作区的独立 WSL Ubuntu 24.04 克隆中执行 `node Tools/weak-network.mjs A .tmp/w-resume-20260928/A`，使用已有 `Engine/` 0.0.2 发布物，未拼装私有源码。100 个账号登录完成，但 DS 在 `starting_clr_runtime` 超过 30000ms，记录启动 watchdog 错误；启动器最终等待 240 秒仍未收到 `DS_READY`，返回失败，`run.json` 为 `INCOMPLETE`。没有启动 Bot 测量窗口、没有施加弱网，也没有性能结论。该尝试不是要求的 hosted Ubuntu 主跑。

| 档 | 目标单向附加延迟 / 丢包 | 执行情况 | 输入确认 / 卡顿 / 断线 / tick / RSS |
|---|---|---|---|
| A | 0 / 0 | 本地启动尝试失败；hosted 未执行 | 未测得 |
| B | 50±10ms / 1% | 未执行 | 未测得 |
| C | 100±20ms / 3% | 未执行 | 未测得 |
| D | 150±30ms / 5% | 未执行 | 未测得 |

## 切网与 Nagle

10 Bot 连接中断 5 秒的实测未执行，重连成功率与耗时未知。没有建立 DS/Bot socket，TCP_NODELAY 两端现状未知，A/C 条件对照未执行。`raw/A-nagle.csv` 是实际审计程序创建的原始文件，但仅含表头，**不是测量样本**。不把无观测解释为两端已关闭 Nagle。

## 执行依赖

- [Client #172](https://github.com/LumioGames/LumioClient/pull/172) 仍未合入，包含输入确认等标准 Meter 只读出口；已有 0.0.2 发布物不包含这些出口。
- [Engine #439](https://github.com/LumioGames/LumioGameEngine/pull/439) 关闭且未合入。GitHub 事件显示 Go1c 于 2026-09-28T00:15:35Z 关闭并删除 head 分支，无评论解释原因。已请求协调端确认，不重开、不推回已删除分支。其 43 行 `export_weak_network_artifact` 工作流改动在 fetch 后的主线仍缺失。
- [Engine run 36348258346](https://github.com/LumioGames/LumioGameEngine/actions/runs/36348258346) 在打包阶段失败，`lumio-engine-native` 报 44 个编译错误；尚无可消费的 `engine-release-linux-x64` artifact。
- [Sample #99](https://github.com/LumioGames/LumioSample/pull/99) 仍未合入；默认分支尚未注册 `weak-network.yml` 手动工作流。

依赖解除后的主路径保持不变：协调端安排上述代码及主线编译修复，触发 Engine `sample-regression.yml` 的 `export_weak_network_artifact=true`，取得包含发布物和 Platform 镜像的 run ID，再触发 Sample hosted Ubuntu `weak-network.yml` 全部五档。若实际审计任一端 TCP_NODELAY=false，另用不合入的对照分支执行 A/C。完整原始 CSV 和最终结果报告仍待这条路径执行，不能由本报告代替。

## 本次修复与验证

Linux 预检复现并修复两项入口问题：测量 workflow 显式指定发布物的 `Engine/bot/linux-x64`，避免 distro SDK 的 `ubuntu.24.04-x64` 查找失败；`tc` 不支持 `seed` 时保留原定延迟/抖动/丢包参数并在 `raw/netem-apply.txt` 记录 kernel-selected，支持时仍使用 270927。无固定 seed 的损失序列不可精确复现。

- Ubuntu 24.04、.NET SDK 10.0.112：显式 portable Bot 路径后编译 0 warnings / 0 errors。
- 独立 Linux 网络命名空间中实际执行 B 档参数配置、DS 端口过滤、10 连接双向 DROP 规则安装/删除和 qdisc 清理成功。未向这些连接发包，故不计切网测量或丢包计数证据。
- `node --test Tools/weak-network-analysis.test.mjs Tools/launcher.test.mjs`：75 通过、0 跳过。
- `dotnet build LumioSample.slnx`：Windows 成功，0 警告/错误。
- `dotnet test LumioSample.slnx -- --minimum-expected-tests 1`：Windows 135 项中 107 通过、28 失败；失败输出包含缺少兄弟 LumioConfig 的 `tools/lumio_config.py`，不是弱网采集断言失败。
- Linux 对应 `dotnet test --solution LumioSample.slnx --minimum-expected-tests 1`：135 项中 43 通过、92 失败；包含 distro RID 发布物路径及 native 装载失败，不称全量验证通过。
- `node --test Tools/verify-evidence.mjs`：23 通过、0 跳过。
- `node eng/spec-lint.mjs`：通用 12 项通过，仍报告 integration、Engine gitlink 识别、Server/Config/Profiles 三处既有布局差异，未放宽检查。
- Node 语法检查、`git diff --check` 通过。小范围入口修复沿用既有测试和真实预检，不新增镜像实现测试；纯兼容修复免知识功能文档变更，证据记于此。

## 原始证据

- [执行状态](raw/A-run.json)、[DS 原始日志](raw/A-ds.log)、[socket 审计原始 CSV](raw/A-nagle.csv)、[发布物 manifest](raw/A-engine-manifest.json)。
- [隔离命名空间网络规则实测输出](raw/netem-preflight.txt) 保留 tc 配置、全部 20 条 DROP 规则及最终 noqueue；其中零包计数如实保留。
- `A-run.json` 的 `bots=100` 与 `requiredDurationSeconds=180` 是目标配置，实际完成数为零；无 startMs/endMs。其 `shas` 枚举本机兄弟检出，不代表发布物源码身份；运行引擎身份以保存的 manifest 为准。Sample 原有未提交场景变更保留于接续工作区。
- 本次没有输入确认、卡顿、重连、tick、RSS 的非空原始 CSV；未伪造零值或从单元测试合成结果。

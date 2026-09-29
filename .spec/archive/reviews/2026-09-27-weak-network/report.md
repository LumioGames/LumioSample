# W：弱网实测（2026-09-27）

结论：本轮未能启动合格的弱网测量环境，因此无法判定 WebSocket 从哪一档开始不可接受；A–D 四档与切网档均为 BLOCKED_ENV/未执行。

## 总表

| 档 | 注入网络 | 输入确认 p50/p95/p99/最大 | 扣除注入延迟后 p99 | 卡顿（每 Bot/分钟；总时长） | 服务器 tick p99 / 内存曲线 | 状态 |
|---|---|---:|---:|---:|---:|---|
| A | 0ms / 0% | — | — | — | — | BLOCKED_ENV |
| B | 50±10ms / 1% | — | — | — | — | BLOCKED_ENV |
| C | 100±20ms / 3% | — | — | — | — | BLOCKED_ENV |
| D | 150±30ms / 5% | — | — | — | — | BLOCKED_ENV |

每档要求为 100 Bot、持续 3 分钟。没有任何指标样本；CSV 中的 `0` 表示样本数/事件数为零，空字段表示没有观测值，不表示通过。

## 切网结果

未执行。计划要求 10 个 Bot 丢弃全部连接包 5 秒后恢复，并统计重连成功率、从恢复到重新进入 Active 的耗时；本轮没有 DS/Bot 进程，故无断线或重连观测。原始记录见 [`raw/disconnects.csv`](raw/disconnects.csv)。

## Nagle 对照

未执行且未判定。仅对发布物做了静态字符串扫描，不能证明 DS 服务端或 Bot 客户端 socket 的 `TCP_NODELAY` 状态；两端均记录为 `UNVERIFIED`，没有改动传输代码，也没有建立 Nagle 对照分支。原始记录见 [`raw/nagle.csv`](raw/nagle.csv)。

## 环境与执行证据

- 执行主机：`CuideMacBook-Air.local`，macOS 26.5.2，Darwin arm64；Docker Colima 服务端为 Linux `aarch64`（2 CPU，3.8 GiB）。完整快照见 [`raw/environment.txt`](raw/environment.txt)。
- Sample 提交：`f98322c2eec8f83b5caf07aa2ad15d9c55b6f8fb`；`Engine/` 子模块：`9e57979049fe727e02992ad48116ce1324a42277`；发布物 v0.0.2 仅列 `win-x64`、`linux-x64`。
- 主跑命令：`node Tools/stress-move.mjs --bots 100`，退出码 2，`VERIFICATION_STATUS=BLOCKED_ENV`。启动器在第 02 步因 `osx-x64` 不在发布物平台列表而停止，未启动 DS、Bot 或 Platform；原始 stdout/stderr 与生成的 `verification.json`、空的 timing/memory CSV 均保留在 [`raw/`](raw/)。
- 另一次可运行性探针：`node Tools/launcher.mjs --bots 1 --no-platform` 同样退出码 2，原因相同。两次尝试索引见 [`raw/run-attempts.csv`](raw/run-attempts.csv)。
- 计划要求 Linux `tc netem` 按 DS 端口施加延迟/丢包，并用 iptables 做切网；本机没有 `tc` 或 `iptables`，且没有合格的托管 Ubuntu 测量 workflow 可直接复用。没有把 macOS 或 Rosetta/Colima 结果冒充 Linux 实测，也没有修改 CI。

## 原始数据与未执行项

- 输入确认、卡顿、服务器指标：[`raw/input-confirmation.csv`](raw/input-confirmation.csv)、[`raw/stalls.csv`](raw/stalls.csv)、[`raw/server.csv`](raw/server.csv)。
- 切网：[`raw/disconnects.csv`](raw/disconnects.csv)。
- Nagle：[`raw/nagle.csv`](raw/nagle.csv)。
- 运行尝试与环境：[`raw/run-attempts.csv`](raw/run-attempts.csv)、[`raw/environment.txt`](raw/environment.txt)。
- 未执行：A/B/C/D 四档 100 Bot × 3 分钟；切网档；服务器 tick/内存/发送队列曲线；输入确认直方图；Nagle A/C 对照；GitHub 托管 Ubuntu 手动 workflow（现有 workflow 只跑常规十四步，没有 W 档参数）。

下一次应在 GitHub 托管的 x86_64 Ubuntu 上按本计划重新执行；先确认 `tc netem`、iptables、Linux x64 Engine、Platform、DS、Bot.Host 和 Bot 场景全部可用，再填写上述 CSV 的观测字段。该环境恢复前，本报告不对任何档位给出 PASS/FAIL。

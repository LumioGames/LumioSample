# LumioSample v0.0.2 全量验收（2026-09-27）

在引擎正式发布 **v0.0.2**（`LumioEngineRelease` tag v0.0.2，提交
`9e57979049fe727e02992ad48116ce1324a42277`）上，对 LumioSample `main`
`f98322c2eec8f83b5caf07aa2ad15d9c55b6f8fb` 的完整验收。结论总表见
[`VERDICT.md`](VERDICT.md)，机器可读汇总见 [`verification.json`](verification.json)。

## 目录

| 目录 | 判据 | 真值来源 |
|---|---|---|
| `criterion1/` | 外部视角可编译 | 构建输出 + 反例输出 + SDK 公开使用面 |
| `criterion2/` | 一条命令跑完全程 | 启动器 verification.json（14 步）+ 截图 + dotnet test |
| `criterion3/` | 数值全部来自配表 | step 12 amount=7 + dll sha256/mtime + grep |
| `criterion4/` | 四类东西各出现一次 | DS 日志原文 + 具名测试 |
| `criterion5/` | 挖穿一格完整链路 | DS 日志原文 + 具名测试 |
| `criterion6/` | 关服重启后世界还在 | 驱动器 `run-persistence.mjs` 的 verification.json |
| `criterion7/` | 两轮同底图同结果 | `Tools/verify-evidence.mjs`（ADR-125） |
| `r588/` | R-00588 100 人压测两轮 | `integration/stress-r588/verify-rounds.mjs` |

## 环境与适配注记

- 本机：Windows 11 专业版 10.0.26200，i5-12600KF（10 核），.NET SDK 10.0.400，
  Node v24.18.0，git 2.55；验收克隆在 `C:\Work\accept-v002`（同级无其他 Lumio 仓），
  LumioConfig 在仓外（`LUMIO_CONFIG_ROOT`）。
- 本机 Windows 无 Docker Desktop；Docker 引擎在 WSL `Ubuntu-24.04`（docker 29.8.0 /
  compose v5.5.1）。为满足「一条命令」，PATH 上放了 `docker.exe`→WSL 转发 shim
  （源码 `criterion2/docker-wsl-shim.cs`：路径翻译 + WSLENV 转发，不改任何仓内代码；
  启动器调用的仍是它自己的 `docker compose -f Engine/platform/docker-compose.yml` 流程，
  镜像按 digest 钉住不变）。
- 本克隆 `core.autocrlf=input`（`sourceFingerprint` 按字节 LF 计算；Windows 默认 true 会
  把工作区源表检出成 CRLF，导致重导出的指纹字段与提交版不同——环境适配，不改仓内文件）。
- 判据 6/7/R-00588 的编排脚本在各自目录进仓，可照 `各 README/脚本头注释` 重跑。

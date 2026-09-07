# 示例（Lumio Sample）

> Lumio 引擎的参考实现。最基础的一款 Lumio 游戏——不追求好玩，只把引擎每个接缝走一遍。

这个仓有两个用途：

1. **照着抄**——想用 Lumio 做游戏，从这里开始读。
2. **当模板**——新游戏直接 `gh repo create --template`，改个名就能往下做。

## 玩法一句话

登录进场 → 跑动 → 挥镐挖矿脉 → 挖穿了方块变空气 → 掉出矿石 → 走过去捡 → 旁人同帧看到 → 顺便能聊天。
关服再开，地图还是你挖过的样子，矿石也还在。

没有战斗，没有胜负，没有美术。要看战斗怎么写，去看炸弹人。

## 五分钟跑起来

```bash
git clone <本仓地址> && cd LumioSample
dotnet build LumioSample.slnx
dotnet test  LumioSample.slnx
```

端到端启动器（起账号服 + DS + Bot + 浏览器）见 [`integration/`](integration/)，逐步导览见 [`docs/tour.md`](docs/tour.md)。

## 仓库结构

| 目录 | 放什么 |
|---|---|
| [`src/`](src/) | 玩法程序集。服务器与客户端两端共用 |
| [`tests/`](tests/) | 单元测试 |
| [`config/`](config/) | 源配表与 schema。编译后由 typed Table Reader 读 |
| [`integration/`](integration/) | 一键启动器、日志与两轮哈希对账 |
| [`docs/`](docs/) | [`tour.md`](docs/tour.md) 逐步导览 |
| [`.spec/`](.spec/AGENTS.md) | 本仓的规范、决策与计划 |

## 契约来源

公共语义的唯一事实源是架构仓 `LumioGameEngine`（私有）：ABI 在 `engine/abi/native-abi.json`，线上语义在 `engine/wire/*.json`，设计概要在 `.spec/knowledge/features/`。

**本仓不复述任何公共契约字段。** 要查字段、错误码或消息 ID，回架构仓读；本仓文档只写「在示例里这条契约怎么用」。

## 许可证

本仓库是 **示例仓库**，采用 **Apache License 2.0** —— 见 [LICENSE](LICENSE)。
你可以自由 fork、修改、二次创作，并用它开发和商业运营你自己的游戏，无需额外授权。

> ⚠️ **引擎本体不在本许可证范围内。** 本仓库所依赖的 Lumio 引擎（`Lumio.Engine.*`、`Lumio.GameRuntime.*` 等）单独采用 **Business Source License 1.1（BUSL-1.1）**，条款独立于本仓库：
>
> - ✅ 允许：用它开发、发行、商业运营你自己的游戏与游戏内容
> - ❌ 不允许：用它对外提供游戏引擎、游戏开发套件、运行时、服务端框架等与之竞争的面向开发者的产品或服务
> - 2030-09-07 自动转为 Apache License 2.0
>
> 完整条款见引擎分发物随附的 LICENSE 文件。

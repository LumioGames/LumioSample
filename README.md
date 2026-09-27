# LumioSample

## 我是什么

引擎十四步参考游戏：登录、跑动、聊天、挖矿、拾取、存档与重启恢复。它既是教学模板也是端到端回归入口；地形是体素，矿脉数据和掉落物是实体，纯表现使用 Local Entity。

## 怎么跑

准备 git、.NET SDK（`global.json`）、Node.js 22 与 Docker。

```sh
git clone --recursive https://github.com/LumioGames/LumioSample
cd LumioSample
dotnet build LumioSample.slnx
dotnet build Gameplay/Lumio.Sample.Gameplay.csproj -p:LumioEcsSide=client
dotnet build Client/Bots/Lumio.Sample.Bots.csproj
node Tools/launcher.mjs --bots 2 --stagger-ms 250 --scenario-dll Client/Bots/bin/Debug/net10.0/Lumio.Sample.Bots.dll
```

漏拉子模块时执行 `git submodule update --init --depth 1 Engine`。当前提交钉住 **v0.0.2**；只读 `Engine/` 提供同一 tag 的 SDK、Server Host、Bot、浏览器零件和 Platform compose。缺运行条件时启动器报告 `BLOCKED_ENV`。

配表测试另需 Python 3.11+ 和公开 LumioConfig 检出（`LUMIO_CONFIG_ROOT` 可指定位置）。机器人默认用普通 Player 账号；Bot 命名空间需要 Platform 签发的 `LUMIO_BOT_TOOL_CREDENTIAL`。

## 从哪读

- [十四步导览](.spec/knowledge/features/sample-tour.md)、[玩法设计](.spec/knowledge/features/sample-gameplay.md)、[工具说明](Tools/README.md)。
- [知识导航](.spec/knowledge/README.md)、[引擎发布物](https://github.com/LumioGames/LumioEngineRelease)。
- 游戏代码按 [LICENSE](LICENSE)；`Engine/` 是按 BUSL-1.1 授权的引擎二进制。
- [Lumio-DevKit 帮助手册](https://github.com/LumioGames/Lumio-DevKit)：面向游戏开发者的使用说明与排障入口。

# 判据 2 · 零件来源（全部来自 Engine/ 子模块 = LumioEngineRelease v0.0.2）

命令（退出码 0，`VERIFICATION_STATUS=PASS`，14/14 步 PASS）：

```
node Tools/launcher.mjs --bots 2 --stagger-ms 250 --spectator --scenario-dll Client/Bots/bin/Debug/net10.0/Lumio.Sample.Bots.dll
```

前置构建（README「五分钟跑起来」原文命令）：

```
dotnet build Gameplay/Lumio.Sample.Gameplay.csproj -p:LumioEcsSide=client    # 0 警告 0 错误
dotnet build Client/Bots/Lumio.Sample.Bots.csproj                            # 0 警告 0 错误
```

本机环境注记：本机 Windows 无 Docker Desktop，Docker 引擎在 WSL `Ubuntu-24.04` 内（docker 29.8.0 /
compose v5.5.1）。为让启动器以设计方式自己起 Platform，本机 PATH 上放了一个 `docker.exe`→WSL 转发
shim（源码见 `../criterion2/docker-wsl-shim.cs`，只做路径翻译与转发，不改任何仓内代码）；启动器调用
的还是它自己的 `docker compose -f Engine/platform/docker-compose.yml` 流程。

| 零件 | 来源 | 证据 |
|---|---|---|
| Platform 镜像 | `Engine/manifest.json` 的 `platformImage` = `ghcr.io/lumiogames/lumio-platform:0.0.2@sha256:b63dbeb2a9cb60578894afe0a6f2b660bb0595976bf72206c7a40f2f90583164`（compose 文件内同样钉 digest） | `platform.up.log`、`Engine/platform/docker-compose.yml:52` |
| `lumio-ds`（DS 进程与引擎 CLR 闭包） | `Engine/server/win-x64/`（HostEntry + runtimeconfig + Runtime 三路径 + native） | `launcher.out` 的 bot 参数行 `--engine-native ...\Engine\server\win-x64\SDK\Native\win-x64\lumio_engine_native.dll` |
| Bot 宿主 | `Engine/bot/win-x64/Lumio.Client.Bot.Host.dll` | `launcher.out` 的 `$ ["dotnet",...Engine\bot\win-x64\Lumio.Client.Bot.Host.dll",...]` |
| 旁观页引擎零件与体素 wasm | `Client/UI/Spectator` 的 publish 产物，`lumio_voxel_wasm.wasm` 由发布流程从 `Engine/web/lumio_voxel_wasm.wasm` 拷入（sha256 前 16 位 `03f990f863df965d`，两端一致） | `wwwroot/lumio_voxel_wasm.wasm` 与 `Engine/web/` 同名文件 |
| 玩法程序集 / 场景 | 本仓 `Gameplay/`、`Client/Bots/`（游戏一半，属本仓职责） | 构建输出路径见上 |

Platform 生命周期由启动器管理：本次运行 `platform.up.log` / `platform.predown.log` / `platform.down.log`
均在证据目录（`down -v` 每次运行后删除库，账号不跨次残留）。

旁观页：`spectatorPage.status=HOSTED`（launcher verification.json），截图
`spectator-canvas.png` —— 画面可见体素世界（绿地板 / 紫墙 / 暗红矿脉）与在场玩家实体（粉色圆点为
tour 玩家 Player1，另有 Player2 蓝点与青色掉落物点），取自 step 05–13 窗口期内。

# 判据 1 · SDK 公开使用面

`Engine/sdk/Lumio.Engine.SDK.0.0.2.nupkg`（随 v0.0.2 发布物分发）解包后：

- **XML doc**：`lib/net10.0/*.xml` 共 14 份（Lumio.Engine.SDK / NativeLoader(+Hfsm) /
  GameRuntime.Command / Config / Coordination(+VoxelAdapters) / Ecs / Gas / Movement /
  Persistence / Replication / Simulation 等），与 DLL 同名成对。
- **公开 API 参考**：`content/docs/public-api.md`
- **错误码参考**：`content/docs/error-codes.md` + `error-codes.json`
  （生成自 `engine/abi/native-abi.json` 与 `engine/wire/*.json`；文件头自述 257/257 公共码
  均有 meaning / trigger / handling）。

**不看私有仓即可查到含义的示例**：`sdk_version_mismatch`（error-codes.md「Pack / boot」节）——
meaning：`server.json` 三路径程序集必须与 SDK 包版本一致；trigger：消费方 `LumioSdkVersion` 与
`content/sdk-version.json` 不符；handling：启动拒绝，恢复匹配的 SDK，不得映射为
`registry_required`。全部信息都在包内文件里，无需引擎源码仓权限。

## 正例：空目录（无任何同级 Lumio 仓）构建成功

目录 `C:\Work\accept-v002`（同级只有 LumioSample 一个仓；LumioConfig 放在仓外
`C:\Work\accept-libs`，且此步未用到）：

```
git clone --recursive https://github.com/LumioGames/LumioSample   # HEAD f98322c2..., Engine 9e579790...
dotnet build LumioSample.slnx
```

结果（`build-clean-clone.out`）：`已成功生成。0 个警告 0 个错误`。

## 反例：不带 --recursive 的克隆显式失败

目录 `C:\Work\accept-v002-neg`（同样无同级仓）：

```
git clone https://github.com/LumioGames/LumioSample && dotnet build LumioSample.slnx
```

结果（`build-negative-no-recursive.out`）：生成失败，错误码
`LUMIO_SDK_UNRESOLVED: the engine release is not in ...Engine/`，并打印补拉命令
`git submodule update --init --depth 1 Engine`，同时声明
`There is no other engine path: no sibling checkout, no global-packages, no nuget.org.`
——不静默降级、不找别的包源。

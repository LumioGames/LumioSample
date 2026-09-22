# Server-side tests

ADR-115 决策 1：游戏侧 `Server/` **只放数据，不含源码工程**。所以本目录只有用例
源码，`.csproj` 在 `Tools/` 下：

| 用例源码 | 工程文件 | 进哪条命令 |
|---|---|---|
| [`Gameplay/`](Gameplay/) | [`Tools/Lumio.Sample.Gameplay.Tests`](../../Tools/Lumio.Sample.Gameplay.Tests/) | `dotnet test LumioSample.slnx` |
| [`Host/`](Host/) | [`Tools/Lumio.Sample.Server.HostTests`](../../Tools/Lumio.Sample.Server.HostTests/) | `node Tools/test-server-host.mjs <results-dir>` |

## `Gameplay/`

玩法用例。它们编译并驱动 **服务端侧** 的 Gameplay 构建（`LumioEcsSide` 默认
`server`），所以落在 Server 端。工程离仓根仍是两级，用例里
`AppContext.BaseDirectory` 上溯五级得到仓根的算法不变。

## `Host/`

从 LumioServer 移来的两条准入/落生用例（ADR-115 §3 / R-00692，上游 R-00687 交出）：
`AdmitOnSampleRegistryRuntimeOnly` 与 `AdmitOnSampleRegistryWithVoxel`。
它们守的是**引擎**的保证，不是玩法的——防御性拷贝的 catalog 字节、坏 voxel 半边
被拒且 `Manager` 身份不变、restore 后 `IngressBudget` 身份保持而 `Manager` 换新、
`ActivationContextFactory` 的三条答案、`runtime-only` 快照不带 `voxelBase64`、
`Physics` 随 voxel 模式有无。

`Lumio.Server.HostEntry` 是**进程级单例托管上下文**：两个 registry 同进程会互相
污染。所以这两条各自独立进程跑，清单在
[`Tools/test-server-host.mjs`](../../Tools/test-server-host.mjs)（口径抄自
LumioServer `Tools/test-host-entry.mjs` 的 `isolatedCases`）。

本工程**不在 `LumioSample.slnx` 里**：它要一份已构建的 LumioServer 产物，和
`Client/Bots` 需要预构建 LumioClient 产物同理；`dotnet test LumioSample.slnx`
的用例集不因它变化。游戏工作区不对 LumioServer 取编译期引用，HostEntry 全程经
反射调用，程序集路径由 `LUMIO_SERVER_HOSTENTRY_DLL` 给出——就是
`Server/Config/Startup/server.json` 里 `clr.entry_type` 点名的那一个。

输入全部是「点名的新鲜输入」，缺任何一个都按名字报错，不跳过：

| 变量 | 是什么 |
|---|---|
| `LUMIO_SERVER_HOSTENTRY_DLL` | 本次构建的 `Lumio.Server.HostEntry.dll` |
| `LUMIO_RUNTIME_REPLICATION_DLL` / `LUMIO_RUNTIME_ECS_DLL` | 点名的三路径 Runtime |
| `LUMIO_SAMPLE_GAMEPLAY_DLL` | 本次构建的 `Lumio.Sample.Gameplay.dll`（服务端侧） |
| `LUMIO_CONFIG_DIR` | `Server/Config/Tables`（服务端那一份分端导出） |
| `LUMIO_TEST_VOXEL_FIXTURE_DIR` | 含 `catalog-world.json` + `catalog-world.capture`，须与本次 native 镜像同源 |

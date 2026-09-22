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

这六个值由 [`Tools/prepare-server-host-inputs.mjs`](../../Tools/prepare-server-host-inputs.mjs)
统一造并点名，本机与 CI 走同一个入口。缺任何一个都是 `MISSING_INPUT: <变量名>`：
按 ADR-113 决策 2，缺产物是失败，不是 skip，也不再报 `BLOCKED_ENV`。

## 在 CI 的哪里跑（R-00702）

R-00692 把这两条接了进来并实跑通过，但没进任何流水线——八项引擎级断言只在一台机器上
被跑过一次。现在它们在 [`.github/workflows/ci.yml`](../../.github/workflows/ci.yml)
的两个作业里：

| 作业 | 做什么 |
|---|---|
| `server-hostentry` | 按 LumioServer 自己的口径（`Tools/prepare-host-sdk.mjs` → `dotnet build`）打出本次的 `Lumio.Server.HostEntry.dll`，整个输出目录作为制品传下去（`Assembly.LoadFrom` 的探测是按目录的，旁边的 `Microsoft.Extensions.Logging*` 也是制品的一部分） |
| `server-host` | 造本次的 native 与 voxel fixture、构建服务端侧 Gameplay、取上一个作业的制品，然后逐条独立进程跑这两条，并 grep 断言 `HOST_SUITE cases=2 total=2 passed=2 failed=0 skipped=0` |

触发面按 ADR-113 决策 6：`push` 到 main 与每日作业，PR 不跑（ADR-088 不给 PR 设必绿门）。
跳过计数为 0 是决策 1 的度量口径，所以断言的是那一行而不是退出码。

两个作业而不是一个，是因为 `prepare-host-sdk.mjs` 经 `GITHUB_ENV` 导出
`RestoreConfigFile` / `NUGET_PACKAGES` / `LumioLocalFeed`——同作业里的后续步骤会被它接管，
连带影响本仓自己的 restore。拆开之后 LumioServer 的 SDK 选择留在它自己的作业里，
而交过来的仍是**本次运行**构建的 HostEntry，这正是用例要求的。

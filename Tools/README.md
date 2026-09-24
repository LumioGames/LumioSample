# Tools - verification, production launcher and test projects

ADR-115 把原 `integration/` 归到仓根 `Tools/`（跨端启动器与联测编排）。本目录另外
收着两个测试工程的 `.csproj`——它们的用例源码在各端 `Tests/` 下，工程文件放这里
是因为游戏侧 `Server/` 只放数据、不得含 `.csproj`：

| 工程 | 用例源码 | 怎么跑 |
|---|---|---|
| `Lumio.Sample.Gameplay.Tests` | `Server/Tests/Gameplay/` | `dotnet test LumioSample.slnx` |
| `Lumio.Sample.Server.HostTests` | `Server/Tests/Host/` | `node Tools/test-server-host.mjs <results-dir>` |

## 从 LumioServer 移来的准入用例（R-00692 / R-00702）

`test-server-host.mjs` 逐条独立进程跑 `AdmitOnSampleRegistryRuntimeOnly` 与
`AdmitOnSampleRegistryWithVoxel`——`Lumio.Server.HostEntry` 是进程级单例托管上下文。
所需环境变量、守的八项引擎级断言与不入 `LumioSample.slnx` 的理由见
[`Server/Tests/README.md`](../Server/Tests/README.md)。

`prepare-server-host-inputs.mjs` 造并点名那六个输入，是 CI 与本机的同一个入口：

```bash
node Tools/prepare-server-host-inputs.mjs \
  --engine-root ../LumioGameEngine \
  --hostentry-dir <已构建的 Lumio.Server.HostEntry 输出目录> \
  --gameplay-bin Gameplay/bin/Release/net10.0 \
  --output <本次运行的 fixture 目录>
node Tools/test-server-host.mjs <results-dir>
```

两件事它替你把住：

- **voxel fixture 必须本次现造**。`LumioGameRuntime/modules/coordination/tests/
  fixtures/voxel-native` 是对着另一个 native build 造的，voxel 那条会以
  `load_suspended_missing_voxel` 失败；脚本按 Engine 的两个产出器现造一份，并用
  `catalog-world-evidence.json` 的 `BinarySha256` 对本次 native 的 `build-info.json`
  核一遍，不同源就 `VOXEL_FIXTURE_NATIVE_MISMATCH`。
- **缺产物按名字失败，不跳过**（ADR-113 决策 2）。六个输入缺任何一个都是
  `MISSING_INPUT: <变量名>`，不再报 `BLOCKED_ENV`——那个词在本仓是「环境跑不了」，
  调用方有理由容忍它，而这两条不许被容忍掉。

`Lumio.Server.HostEntry.dll` 要一份已构建的 LumioServer 产物。CI 由
`server-hostentry` 作业按 LumioServer 自己的口径
（`Tools/prepare-host-sdk.mjs` → `dotnet build`）打出来再传给 `server-host` 作业；
本机 macOS ARM64 打不出来——`eng/pack-sdk.mjs` 只发 linux-x64 / win-x64，在这台机器上
是 `BLOCKED_ENV`。

## Platform account client (S-4)

`account-client.mjs` talks to LumioPlatform only: WebSocket `/account`
(`lumio-account-v1`, login-or-register) then `POST /api/games/{slug}/launch`
with the unbound account-auth credential as Bearer. It does not mint
admission tickets. `bot-credential.mjs` resolves the password
(`LUMIO_ACCOUNT_PASSWORD` or a one-shot generated value) and a
Platform-issued bot-tool claim (`LUMIO_BOT_TOOL_CREDENTIAL`); Bot
namespace names refuse to connect without that claim.

Hermetic protocol tests (injected transports, no live Platform):

```bash
node --test Tools/account-client.test.mjs
```

The Room ticket is returned to the caller that imports the module. The
CLI prints only a public summary so secrets never land in logs.

## One-command launcher (S-3 / R-00520)

`launcher.mjs` is the internal fourteen-step command and the only driver of
those steps. It copies the committed `Server/Config/Startup/server.json.clr.kernel_config` object to each run's `kernel-config.json` and passes that path to Bot.Host; native execution has no hidden Context limits. It prints `step=NN`
for every sample.md step, admits `--bots N` names (`Bot1`…, or
`--login-prefix`) with a configurable `--stagger-ms`, and consumes unique
`loginAndLaunch` tickets.

Bot 1 is the tour bot: it runs `SampleMiningScenario` from
`LUMIO_SCENARIO_DLL` / `--scenario-dll`. Steps 05–13 are judged after it exits,
from artefacts only (`tour-steps.mjs`): the DS's stdout and log directory, the
bot's lifecycle log and its `result.ndjson`. A missing, empty or truncated
result file is FAIL for every step that reads it. Step 14 waits for the second
`DS_CHECKPOINT` printed after the tour bot finished (the first may be a save
that was already running), stops the DS, reboots it on the same store and
re-admits the same account under `SampleRestoreVerifyScenario`. Bots 2..N and
the spectator are the fleet and are stopped before the restart.

`--spectator` mints one more `loginAndLaunch` ticket and starts no Bot.Host
for it. Once step 04 passes, the launcher serves the published spectator
bundle (`--spectator-root` / `LUMIO_SPECTATOR_ROOT`, default
`Client/UI/Spectator/host/bin/Release/net10.0/publish/wwwroot`) on
`http://127.0.0.1:<port>/` (`--spectator-static-port` /
`LUMIO_SPECTATOR_STATIC_PORT`, default any free port) and prints
`spectator-url=`. Every `index.html` it serves carries that ticket as
`window.__lumioLaunch` (the page's local test mode, see
[`Client/UI/Spectator/README.md`](../Client/UI/Spectator/README.md)), with the
DS endpoint the bots were given as `wsUrl`; the URL never carries the ticket.
The page is served from loopback, which is what lets it dial the loopback DS
over plaintext `ws:`. The ticket is single-use, so a reload after the page
entered the game needs a new run. No published bundle means no page:
`verification.json` records `spectatorPage.status=BLOCKED_ENV` and the
fourteen steps are unaffected. `--spectator-url` only prints a page the
launcher does not serve and cannot inject into; such a page has to be the
Platform's own `/games/<slug>/` on an origin the browser is logged in to.

`server.json` (or `LUMIO_DS_CONFIG`) is a template: each run writes
`server.boot-1.json` / `server.boot-2.json` into its evidence directory with
absolute paths, a fresh store, one debug log directory per boot and the
Platform launch's allocation claims. The CLR files come from
`LUMIO_ENGINE_NATIVE`, `LUMIO_HOSTFXR`, `LUMIO_SERVER_HOSTENTRY_DLL`,
`LUMIO_RUNTIME_REPLICATION_DLL`, `LUMIO_RUNTIME_ECS_DLL` and
`LUMIO_SAMPLE_GAMEPLAY_DLL`, else from the template; when neither is a file the
run stops at step 03 with `BLOCKED_ENV` naming the variable.
`LUMIO_PLATFORM_ADMISSION_KEY` replaces the template's stand-in key.
Process management is imported from Engine `eng/process-tools.mjs`
(`LUMIO_ENGINE_ROOT` or a sibling `LumioGameEngine` checkout). If that
file is missing the command exits `2` with `VERIFICATION_STATUS=BLOCKED_ENV`.

This is internal-only while the Platform image is built from a private
compose file. The public tree does not ship that file; see
[`compose/README.md`](compose/README.md). Runtime logs land under
[`logs/`](logs/README.md) or `LUMIO_LAUNCH_EVIDENCE_DIR`. A force-kill
is never pass evidence. The retired Game harness names
(`lumio-entity-chat-replay`, `LumioServer/account-server`) do not
appear here.

```bash
node --test Tools/launcher.test.mjs
node Tools/launcher.mjs --bots 2 --stagger-ms 250 --scenario-dll <Lumio.Sample.Bots.dll>
```

## 100-bot move gate (R-00588)

`stress-move.mjs` writes the ADR-084 evidence schema (ten-repo SHAs,
`native-core-clock_now`, RSS, transform consistency). A live 100-bot
5-minute run is `BLOCKED_ENV` until Platform + Bot Activate + NativeCore
clock exist. Do not treat the schema file as a passed gate.

## World assertions (R-00568)

`world-assert.mjs` compares per-cell block types and `oreCount`. An empty
world or a “same hash, wrong blocks” snapshot fails.

## Dedicated Server profile

Committed [`Server/Config/Startup/server.json`](../Server/Config/Startup/server.json) is the runnable operator
template: `world_profile=runtime+voxel`, `durability=snapshot_only`
(persistence-container-v1; not `process-crash` / `power-loss`), and
required `base_map_id` / `base_map_version` / `base_map_content_sha256`
(64 lowercase hex of `Server/Assets/Maps/sample.voxel`). Allocation strings and
`admission_public_key_hex` are local syntactic stand-ins so step 03
is not blocked by `replace-*` tokens. Fill-me tokens live in
[`Server/Config/Startup/server.sample.json`](../Server/Config/Startup/server.sample.json) and fail as
`MISSING_VALUE` (`ds-config.mjs`), not placeholder `BLOCKED_ENV`.
Host entry stays `Lumio.Server.HostEntry.HostEntry` /
`LumioHostEntry`. Local machine overlays live in gitignored
`.run/server.local.json` (`LUMIO_DS_CONFIG`); copy the public vocab,
do not keep `runtime-only`.

## Typed Readers (R-00527)

`sync-config-readers.mjs` copies the six Sample typed Readers
(`AttributesTable` / `MiningTable` / `MovementTable` × server+client)
from sibling LumioConfig `export --csharp-out`. Do not hand-edit
`Client/Config/Generated/** 与 Server/Config/Generated/**`. `--check` re-exports
and asserts those six files are byte-identical.

```bash
node Tools/sync-config-readers.mjs
node Tools/sync-config-readers.mjs --check
node --test Tools/sync-config-readers.test.mjs
```

## Base map capture (R-00522)

`Server/Assets/Maps/sample.voxel` is an author-time Engine capture (`LUMIOSNP1`).
DS boot restores only; it does not recompute terrain. Layout (W×D and
the vein patch) lives in [`Server/Assets/Maps/sample.layout.json`](../Server/Assets/Maps/sample.layout.json).
`capture-basemap.mjs` invokes sibling `LumioGameEngine/eng/capture-voxel.mjs`;
gameplay and DS must not import that script. Voxel write (dig-to-air)
stays R-00469. Missing Engine CLI is `BLOCKED_ENV`; Sample does not
invent an encoder.

---

`verify-evidence.mjs` is the deterministic S-7 evidence gate. It reads two
independent round directories, normalizes CRLF to LF before SHA-256, compares
`eventOrder` and `appliedTicks`, and runs `world-assert.mjs` against each
round's `world.json`. It never synthesizes fields or treats an empty log
directory as success.

```bash
node --test Tools/verify-evidence.mjs
node Tools/verify-evidence.mjs --dir Tools/fixtures/oracle-min
```

The default test command is hermetic and does not start external services:

```bash
node --test Tools/
```

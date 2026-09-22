# Tools - verification, production launcher and test projects

ADR-115 把原 `integration/` 归到仓根 `Tools/`（跨端启动器与联测编排）。本目录另外
收着两个测试工程的 `.csproj`——它们的用例源码在各端 `Tests/` 下，工程文件放这里
是因为游戏侧 `Server/` 只放数据、不得含 `.csproj`：

| 工程 | 用例源码 | 怎么跑 |
|---|---|---|
| `Lumio.Sample.Gameplay.Tests` | `Server/Tests/Gameplay/` | `dotnet test LumioSample.slnx` |
| `Lumio.Sample.Server.HostTests` | `Server/Tests/Host/` | `node Tools/test-server-host.mjs <results-dir>` |

## 从 LumioServer 移来的准入用例（R-00692）

`test-server-host.mjs` 逐条独立进程跑 `AdmitOnSampleRegistryRuntimeOnly` 与
`AdmitOnSampleRegistryWithVoxel`——`Lumio.Server.HostEntry` 是进程级单例托管上下文。
所需环境变量、守的八项引擎级断言与不入 `LumioSample.slnx` 的理由见
[`Server/Tests/README.md`](../Server/Tests/README.md)。

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

`launcher.mjs` is the internal fourteen-step command. It copies the committed `Server/Config/Startup/server.json.clr.kernel_config` object to each run's `kernel-config.json` and passes that path to Bot.Host; native execution has no hidden Context limits. It prints `step=NN`
for every sample.md step, admits `--bots N` names (`Bot1`…) with a
configurable `--stagger-ms`, and consumes unique `loginAndLaunch` tickets.
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
node Tools/launcher.mjs --bots 2 --stagger-ms 250
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

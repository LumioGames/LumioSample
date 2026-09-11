# integration - verification and production launcher

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
node --test integration/account-client.test.mjs
```

The Room ticket is returned to the caller that imports the module. The
CLI prints only a public summary so secrets never land in logs.

## One-command launcher (S-3 / R-00520)

`launcher.mjs` is the internal fourteen-step command. It prints `step=NN`
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
node --test integration/launcher.test.mjs
node integration/launcher.mjs --bots 2 --stagger-ms 250
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

Committed [`server.json`](../server.json) is the runnable operator
template: `world_profile=runtime+voxel`, `durability=snapshot_only`
(persistence-container-v1; not `process-crash` / `power-loss`), and
required `base_map_id` / `base_map_version` / `base_map_content_sha256`
(64 lowercase hex of `maps/sample.voxel`). Host entry stays
`Lumio.Server.EntityChat.HostEntry.HostEntry` /
`LumioEntityChatEntry`. Local machine overlays live in gitignored
`.run/server.local.json` (`LUMIO_DS_CONFIG`); copy the public vocab,
do not keep `runtime-only`.

## Base map capture (R-00522)

`capture-basemap.mjs` refuses `maps/sample.voxel`. That file is a
loud placeholder (`BLOCKED: this is not a restoreable VoxelEngine
capture`). VoxelFacade already exposes PrepareWrite / Capture / Restore;
this repo has not wired write-cell consume, and sibling Engine has no
committed capture CLI, so the placeholder must not be treated as a
restorable base map. Missing command: run VoxelFacade write-cell then
Capture into `maps/sample.voxel`. Do not report that as "upstream ABI
does not exist".

---

`verify-evidence.mjs` is the deterministic S-7 evidence gate. It reads two
independent round directories, normalizes CRLF to LF before SHA-256, compares
`eventOrder` and `appliedTicks`, and runs `world-assert.mjs` against each
round's `world.json`. It never synthesizes fields or treats an empty log
directory as success.

```bash
node --test integration/verify-evidence.mjs
node integration/verify-evidence.mjs --dir integration/fixtures/oracle-min
```

The default test command is hermetic and does not start external services:

```bash
node --test integration/
```

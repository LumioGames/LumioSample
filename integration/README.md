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
compose file. A force-kill is never pass evidence. The retired Game
harness names (`lumio-entity-chat-replay`, `LumioServer/account-server`)
do not appear here.

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

## Base map capture (R-00522)

`capture-basemap.mjs` refuses `maps/sample.voxel`. That file is a
placeholder. Capture/restore ABI slots are not public.

---

`verify-evidence.mjs` is the deterministic S-7 evidence gate. It reads only the two
round log directories, normalizes CRLF to LF before SHA-256, and compares
`eventOrder` and `appliedTicks` position by position. It never synthesizes fields,
compares lengths alone, or treats an empty log directory as success.

```bash
node --test integration/verify-evidence.mjs
node integration/verify-evidence.mjs --dir integration/fixtures/oracle-min
```

The default test command is hermetic and does not start external services:

```bash
node --test integration/
```

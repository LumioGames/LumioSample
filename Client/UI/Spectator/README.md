# Spectator page

This is the game's own browser page (R-00710 moved it here from LumioClient, the same way
R-00692 moved the chat window). The Platform serves its publish output at `/games/<slug>/`
and the page reads which game it is from that path. It is assembled from two sources:

| From this repository | From LumioClient `Client/UI/Spectator/` (engine parts, never copied here) |
| --- | --- |
| `index.html`, `main.js`, `spectator.css` | `connect-ds.mjs`, `voxel-grid.mjs`, `dev-hot-reload.mjs` |
| `SpectatorDump.cs`, `SpectatorReplicaHost.cs` (bound to the Sample registry and config) | `ds-close-codes.mjs`, `not-serving-retry.mjs` (generated there by `eng/generate-*.mjs`, `--check`ed by LumioClient CI) |
| `host/` wasm host, `tests/` C# tests, `*.test.mjs` | `tests/SpectatorSectionFrame.cs`, `tests/ReplicaApplyTickLoop.cs`, and the netstandard2.1 `Lumio.Client.Gameplay.ECS` build |

The LumioClient checkout is `LUMIO_CLIENT_ROOT`, else the sibling `../LumioClient`. The
publish links the JS parts into `wwwroot/` beside `main.js`, both C# projects compile the
two C# parts by link, and the node tests read the same files. A missing checkout is a
BLOCKED build or a failing test, never a local copy and never a skip.

Static spectator page that paints a 2D top-down voxel grid with `LogicTransform`
dots on top of it. JS never decodes WorldChange / LogicTransform fields and never
decodes a Section; it only moves bytes into `[JSExport]` and into the voxel wasm,
and draws `{id,x,z,hue,type}` JSON plus the cells the voxel world reports.

Each dot is painted `hsla(hue, 85%, 55%, 0.75)` — 75% translucent so overlapping
dots blend. The hue is a replicated `IdentityComponent.ColorHue` field the server
stamps at admission; it arrives through the same WorldChange snapshot as the pose,
so every client paints the same fixed color for the same person. The page never
derives color from the entity id. The self dot keeps a white ring for orientation.

## Voxel grid (ADR-078)

The blocks under the dots come from **VoxelEngine's own Rust, built for
`wasm32-unknown-unknown`** — `crates/lumio-voxel-wasm`, published beside this page
as `lumio_voxel_wasm.wasm`. ADR-078 决策 1: there is no JS or C# Section store,
decoder or mesher anywhere here, and Section data never leaves that wasm instance.
2D top-down needs no mesh, so the page generates no geometry at all: it asks
`lumio_voxel_read_box` what block each cell holds and fills a rectangle.

决策 3: that module has its own `WebAssembly.Memory`, separate from the .NET
replica's. The two are never merged and share no codec. 决策 4.3: `voxel-grid.mjs`
re-takes `exports.memory.buffer` after every call into wasm and holds no view
across one, because a successful `Memory.grow` detaches the old buffer.

A SectionFrame reaches it like this:

1. `SpectatorReplicaHost.ApplyFrame` recognises the frame (the Runtime `WireCodec`
   has no `SectionFrame` case) and `SpectatorSectionFrame` reads the envelope —
   only the contract's fields, never the payload. Hex becomes bytes once, here.
2. It queues, and `ApplyFrame` returns `false`: no entity frame was applied.
3. The page pulls `PeekSectionHeader()` (envelope JSON) and `TakeSectionBytes()`
   (32-byte `payloadSha256` then the payload).
4. `voxel-grid.mjs` stages those bytes inside the **Rust** linear memory, calls
   `lumio_voxel_request_section` once per Section key, then
   `lumio_voxel_deliver_section`.
5. Painting reads one `lumio_voxel_read_box` per Y layer, top down, and takes the
   topmost non-air block per column.

The frame's own digest is passed straight through, so no second SHA-256 exists in
the page. `u64` revisions cross to JS as decimal strings and go back to the ABI as
`BigInt`.

**Pending / Unavailable is never painted as air.** A column becomes air only when
every layer answered `Ready`/`Unchanged` with `BLOCK_TYPE_AIR`; the moment any
layer is not resolved — including a presence byte `read_box` never wrote, which the
page pre-fills with a sentinel — that column paints the "loading" tile instead.
With no world at all (module missing, world torn down between sessions) the page
holds a grid that answers "loading" for every column, so there is no state where a
cell could read as air because nothing was asked.

Colours: the downlink carries block ids, not names, and the block catalog is a game
asset the page never receives — so nothing can be looked up, and hardcoding one
game's ids would tie the engine page to that game. The id is split with the voxel
contract's own `BlockType << 8 | BlockState`; the hue is derived from the type (so
every state of one block reads as one material) and the state only shifts lightness.
The legend under the canvas is built at runtime from the ids actually on screen, so
the mapping is readable rather than implied.

### Building and publishing the module

It is a build output of another repo and is committed in neither. The spectator
publish copies it in and **fails closed** (`SPECTATOR_VOXEL_WASM_MISSING`) when it
was not built:

```
cd ../LumioVoxelEngine && cargo build -p lumio-voxel-wasm --release --target wasm32-unknown-unknown
```

Set `LUMIO_VOXEL_ROOT` when LumioVoxelEngine is not a sibling checkout.

`lumio-voxel-wasm` is on LumioVoxelEngine `main` as of `2428a39` (PR #62,
2026-09-21). A checkout older than that merge fails the command above with
"did not match any packages" — fetch before blaming the build.

Keep the LumioVoxelEngine checkout a sibling of the other Lumio repos: the
crate resolves `../LumioNativeCore` by relative path.

### Running the voxel round trip locally

`voxel-grid.test.mjs` drives the shipped `voxel-grid.mjs` against the real `.wasm`
and this repository's real `Server/Assets/Maps/sample.voxel` Sections (`voxel-grid.mjs` itself is
read from the LumioClient checkout). It is not in the CI node list
(CI has no Rust toolchain and no built module) and it fails, never skips, when the
inputs are missing:

```
node --test Client/UI/Spectator/voxel-grid.test.mjs
```

## Static host

**The deployable page is `publish/wwwroot/`, not this source directory.** The
publish produces the whole bundle — `index.html`, `main.js`, `spectator.css`, the
`.mjs` modules, `_framework/` and `lumio_voxel_wasm.wasm` — so it drops into any
static file server, and into `LumioPlatform/eng/games/sample/` (mounted read-only
by compose and served at `/games/sample/*` by `GameBundleFiles`) with no assembly
step. ES modules do not load from `file:`.

```
npx --yes serve -l 4173 Client/UI/Spectator/host/bin/Release/net10.0/publish/wwwroot
```

then open `http://127.0.0.1:4173/`.

Serving this source directory instead only works for editing JS against an
already-booted runtime, and only with a `_framework/` copied in **and** the
published `index.html` — the source `index.html` carries an empty
`<script type="importmap"></script>` that the SDK fills at publish time. Nothing
in `_framework/` is named `dotnet.js`; see "Why the page needs an import map".

This page does not auto-start Chrome. Do not launch a live DS / 100-bot topology
from here.

## Which game, and where the launch comes from

- **Platform mode (default).** The page must sit at `/games/<slug>/` (or
  `/games/<slug>/index.html`), which is how the Platform hosts every published game
  (`platform-port-v1.json` `roleSemantics.game-page`). The slug is read off that path
  and the page calls same-origin `POST /api/games/<slug>/launch` after bootstrapping
  CSRF from `GET /api/account/me`. A reconnect asks for its fresh ticket the same way.
  **A page whose path names no game fails** with `status=failed`,
  `lastError=game_slug_unresolved` and a console error, and sends no request at all;
  there is no default game to fall back to.
- **Local test mode.** Whoever loads the page (node tests, a Playwright probe, a local
  harness) injects the launch as `window.__lumioLaunch` before `main.js` runs. That
  needs no `/games/<slug>/` path. `node Tools/launcher.mjs --spectator` is such a
  harness: it serves the published bundle on `http://127.0.0.1:<port>/` and writes the
  spectator ticket into the served `index.html` (see `Tools/README.md`). `?ws=<loopback url>` may then override only the
  injected launch's address; `?ws=` without an injected launch is refused.
- **Plaintext `ws:`** is accepted only to a loopback DS, and only when the page itself
  was loaded from a loopback host (`127.0.0.1`, `localhost`, `[::1]`): a developer
  machine, including a local Platform compose. A page served from any other origin
  requires `wss:`. There is no `allowLoopback` query parameter: it used to be parsed and
  never read, and a flag a viewer can type in the URL should not relax transport
  security, so R-00710 removed it and made the page's origin decide.

Admission credentials never appear in the URL.

## Closes

Every close goes through one classification in `main.js` (`closeClass`). Every
server close code it compares against or sends comes from the generated `ds-close-codes.mjs`,
which LumioClient generates from the architecture repo's `engine/wire/ds-transport-v1.json`.
The one close code `main.js` writes as a number is `ABNORMAL_CLOSURE` (1006), and it
is not a server close code: the browser reports it itself when the connection drops without
a close frame (RFC 6455 §7.1.5), and an endpoint must never send it (§7.4.1). So no
DS can close with it and the contract's table does not list it. `main.test.mjs` checks
both statements against the source.

- `internal_error` fails the page (`status=failed`, `lastError=internal_error`).
- A network drop (1006, or a registered `connection_timeout` / `queue_full` /
  `send_buffer_overflow`) reconnects with a fresh Platform ticket, but only once the
  session was active.
- `not_serving` (ADR-120) while still connecting is neither a healthy close nor a
  failure: the page dials the **same** launch again after a bounded backoff, with no
  new ticket, and reports `status=failed`, `lastError=not_serving_exhausted` once the
  bound is spent. The bound resets when the session becomes active.
  `NOT_SERVING_RETRY` comes from the generated `not-serving-retry.mjs`, which
  LumioClient's `eng/generate-not-serving-retry.mjs` writes from the same declaration as
  the C# session's default (LumioClient `Client/Gameplay/Session/not-serving-retry.json`).
- `not_serving` once active is a peer contract violation (a DS that follows ADR-120
  sends it only before admission): the page fails with `lastError=not_serving` and
  does not reconnect.
- Every other close, including `shutdown`, ends the page as `closed`.

## Evidence

```
window.__lumioSpectator = {
  status, botCount, positions: [{id,x,z,hue,type}], updatedAtMs, selfId, worldId,
  lastError, lastFrameType, notServingCloses,
  voxel: { status, error, abiVersion, sections, frames, lastDelivery,
           cells: { block, air, loading }, blockIds },
}
```

`botCount` is `positions.length`; `type` is the declared entity wire name
(`player` / `vein` / `oreDrop` / …) straight from the registry, so a probe can tell
the kinds apart without inferring one from a pose. A replica apply failure keeps
`status=failed` and records the C# `LastApplyError` plus the inbound `messageType`
so Wave B probes can name the first remaining fault. Credentials never enter this
object.

`notServingCloses` counts `not_serving` closes (ADR-120: the DS at that address has
not opened yet). A run that waits for `DS_READY` keeps it at 0.

`voxel.status` is the Rust world's own state (`ready` / `unavailable` / `closed`),
never a guess, and `voxel.error` says why when it is not ready — a refused delivery
is recorded there with the engine's error id rather than being swallowed.
`voxel.cells` is the machine-readable form of the painting rule above:
`air` stays 0 for as long as nothing is known, and `block + air + loading` is the
whole 32×32 camera. `voxel.blockIds` lists the raw ids on screen.

## C# dump / wasm (local only)

For development hot reload, serve this host through an ASP.NET Core StaticWebAssets
host started by `dotnet watch`. The project pins Debug, portable PDBs, no AOT and no
trimming so the .NET 10 browser agent can apply supported C# method deltas. Keep the
browser-refresh script enabled; the Engine development bridge filters page reload
commands while preserving code deltas and CSS updates. Unsupported edits remain on
the previous code until the developer performs a full rebuild.

None of these csproj are in `LumioSample.slnx`; do not add them. `Directory.Build.props`
here stops MSBuild's walk, so the repo-root analyzer and central-package settings do
not reach them. What keeps this cross-repo seam honest is the `test` job in
`.github/workflows/ci.yml`: it checks LumioClient out beside this repository and
builds `tests/Lumio.Sample.Client.Spectator.Tests.csproj`, which compiles both game
sources and both LumioClient C# parts against this game's client gameplay, so a
LumioClient or Sample API change turns the PR red instead of surfacing the next time
somebody publishes locally. The same job runs `main.test.mjs`. The C# tests are
compiled there, not run (the same coverage the guard had in LumioClient before
R-00710). The wasm host itself is not built on CI: publishing it needs the
`wasm-tools` workload, and it adds nothing but `Program.cs` on top of the shared
sources the guard compiles.

`SpectatorReplicaHost` consumes the same `IClientReplica` and Runtime application
receipts as the session host. Input opens after the initial WorldChange commits;
duplicate Welcome and WorldChange messages preserve the active world. Conflicting
bindings and data application failures dispose the replica. Matching supersession
also disposes it. A later entry creates a new host and does not reuse failed data.

The WASM apply loop is shared with the desktop host tests. Existing dump tests
continue exercising the Native-backed Runtime tick binding. Building the browser
host requires the `wasm-tools` workload, this game's client-side browser gameplay
build, and LumioClient's netstandard2.1 Replica build.

The Sample client registry declares a gameplay config contract, so `WorldManager`
refuses a world without the matching `WorldConfigBinding`; attribute seeds (player
Stamina / Ore initial values) come from the `attributes` config table through that
binding, not from a static seed class. The shared `CreateSampleWorld` factory calls
`SpectatorDump.LoadSampleConfig()` and passes the binding to `WorldManager.Create`,
so the Sample adapter's `BindWorld` installs the projected config as the seed
provider. Browser wasm has no host filesystem, so the export cannot be located by
directory there: `Directory.Build.props` embeds this repository's own
`Client/Config/Tables/manifest.json` plus the `Client/Config/Tables/client/*.json`
projection into both C# projects under `SampleConfigExport/`, and the dump reads them
back through the Runtime's own `IConfigArtifactBytes` seam. A missing export is a
BLOCKED build, never a silent stub.

```
dotnet test Client/UI/Spectator/tests/Lumio.Sample.Client.Spectator.Tests.csproj -p:LumioEcsSide=client
dotnet build ../LumioClient/Client/Gameplay/ECS/src/Lumio.Client.Gameplay.ECS.csproj -c Release -p:LumioBrowserReplica=true
dotnet build Gameplay/Lumio.Sample.Gameplay.csproj -c Release -p:LumioEcsSide=client -p:LumioBrowserReplica=true
dotnet publish Client/UI/Spectator/host/Lumio.Sample.Client.Spectator.csproj -c Release -p:LumioEcsSide=client -p:LumioBrowserReplica=true
```

For an isolated checkout, pass absolute `-p:LumioRuntimeRoot=...`,
`-p:LumioArchRoot=...` and `-p:LumioClientRoot=...` (or `LUMIO_CLIENT_ROOT`) paths so
the build consumes the intended Runtime, Engine and Client revisions.

Publish output `_framework/` is what `main.js` loads. Missing exports or a failed
wasm boot fail-close the page (`status=failed`); they must not paint the empty dump
stub. The browser host references Replica (ns2.1) and Sample gameplay compiled as
`netstandard2.1` (`LumioBrowserReplica=true`) so NativeLoader never enters
`_framework` (browser cannot load `liblumio_engine_native`). Publish fail-closes
if a non-Hfsm `Lumio.Engine.NativeLoader.*.wasm` still appears.

### Why the page needs an import map

.NET 10 fingerprints the wasm runtime files. `_framework/` contains
`dotnet.<fingerprint>.js` and **never a plain `dotnet.js`** — in build output as
well as publish output. The unfingerprinted name is not a file at all; it exists
only as a second route in the StaticWebAssets endpoint manifest, which the
ASP.NET Core dev host reads and a plain static file server does not. That is why
the page boots under `dotnet watch` and 404s the moment its output is copied to a
static host.

`main.js` imports the runtime by its stable name (`import("./_framework/dotnet.js")`),
so the bridge has to be an **import map**. `index.html` carries the SDK's two
markers — `<link rel="preload" id="webassembly" />` and an empty
`<script type="importmap"></script>` — and `OverrideHtmlAssetPlaceholders` fills
them during build and publish with the fingerprinted targets. Do not "fix" a
missing `dotnet.js` by copying one out of `obj/`: that file is a build
intermediate, it is not the one the boot config's integrity hashes describe, and
the next publish silently reverts it.

The page's own files are exempt from fingerprinting
(`StaticWebAssetsFingerprintContent=false`) because `index.html` reaches
`main.js` through `<script src>` and `spectator.css` through `<link href>`, and
an import map rewrites neither — it only maps ES module specifiers.

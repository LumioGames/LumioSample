# Config export

Sources live beside this file (`repository.yaml`, `schemas/`, `tables/`, `registry/`).
This directory (`Gameplay/Tables`) is the config source root other repos look up by
reading the architecture repo's `repo-layout.json` field `repos.GameWorkspace.configSourceRoot`
(repository-layout.md §5, R-00767) instead of hardcoding this path — `Tools/config-source-root.test.mjs`
checks the two stay in sync. Moving this directory again means updating that field too.
Per-end export roots (`Client/Config/Tables`, `Server/Config/Tables`) are compiler output.
Use the sibling LumioConfig checkout or set `LUMIO_CONFIG_ROOT` to its root.
Python 3.11+ is required (`py -3` on Windows, or set `LUMIO_PYTHON`).

Gameplay reads the target projection through the World binding and generated typed
Readers; it does not parse JSON or scan parent directories. `Server/Config/Startup/server.json`
points `config_dir` at `../Tables` (the server end's export root), and `LUMIO_CONFIG_DIR`
overrides the in-process loader directory. Bots and other clients read
`Client/Config/Tables` instead — `split-export/1` keeps the ends apart. Machine-specific server paths belong in ignored `.run/server.local.json`.

| Table | Values |
|---|---|
| `mining` | Stamina cost, vein reserve, ore count, cooldown ticks |
| `movement` | Step distance and sweep radius |
| `attributes` | Stamina and ore ledger names and initial values |
| `map` | Width, depth, vein ratio for author-time map capture |

From the Sample repository root:

```sh
node Tools/sync-config-export.mjs
node Tools/sync-config-readers.mjs
node Tools/sync-config-export.mjs --check
node Tools/sync-config-readers.mjs --check
```

The export command invokes LumioConfig `export --root Gameplay/Tables
--client-out <fresh>/client-export --server-out <fresh>/server-export
--csharp-out <fresh>/csharp` twice in separate temporary directories (ADR-115 /
`split-export/1`: `C` goes to the client end, `S`+`V` to the server end). It compares
every exported file (including each end's root manifest) and generated Reader
byte-for-byte, then copies only compiler output into `Client/Config/Tables` and
`Server/Config/Tables`, and removes files the compiler no longer writes. `--check`
compares that output against the repository without writing it. Temporary directories
are removed afterwards.

Never export directly into a directory that also holds sources: the compiler includes all
preexisting output-tree files in the root `outputHash`, including source tables,
documentation, and stale exports.
Never edit a generated manifest. The clean staging tree, not the mixed source/output
repository directory, defines the reproducible output hash.

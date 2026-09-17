# Config export

Sources live in `source/`; the root manifest and target directories are compiler output.
Use the sibling LumioConfig checkout or set `LUMIO_CONFIG_ROOT` to its root.
Python 3.11+ is required (`py -3` on Windows, or set `LUMIO_PYTHON`).

Gameplay reads the target projection through the World binding and generated typed
Readers; it does not parse JSON or scan parent directories. `server.json` points
`config_dir` at the export root, and `LUMIO_CONFIG_DIR` overrides the in-process loader
directory. Machine-specific server paths belong in ignored `.run/server.local.json`.

| Table | Values |
|---|---|
| `mining` | Stamina cost, vein reserve, ore count, cooldown ticks |
| `movement` | Step distance and sweep radius |
| `attributes` | Stamina and ore ledger names and initial values |
| `map` | Width, depth, vein ratio for author-time map capture |

From the Sample repository root:

```sh
node integration/sync-config-export.mjs
node integration/sync-config-readers.mjs
node integration/sync-config-export.mjs --check
node integration/sync-config-readers.mjs --check
```

The export command invokes LumioConfig `export --root config/source --out <fresh>/export
--csharp-out <fresh>/csharp` twice in separate temporary directories. It compares every
exported file (including the root manifest) and generated Reader byte-for-byte, then
copies only compiler output into `config/`. `--check` compares that output against the
repository without writing it. Temporary directories are removed afterwards.

Never export directly into `config/`: the compiler includes all preexisting output-tree
files in the root `outputHash`, including source tables, documentation, and stale exports.
Never edit a generated manifest. The clean staging tree, not the mixed source/output
repository directory, defines the reproducible output hash.

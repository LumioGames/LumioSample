# integration - verification and production smoke

`verify-evidence.mjs` is the deterministic S-7 evidence gate. It reads only the two
round log directories, normalizes CRLF to LF before SHA-256, and compares
`eventOrder` and `appliedTicks` position by position. It never synthesizes fields,
compares lengths alone, or treats an empty log directory as success.

Run the committed minimal oracle with:

```bash
node --test integration/verify-evidence.mjs
node integration/verify-evidence.mjs --dir integration/fixtures/oracle-min
```

Real runs should write `logs/<date-short-sha>/round-1` and `round-2`; each round
must contain NDJSON, JSONL, or log files with the authoritative fields and one
`baseMapSha256` value.

## Production DS + client smoke

`formal-ds-smoke.mjs` is the explicit integration check for the production
`lumio-ds` executable and `Lumio.Client.Bot.Host`. It runs
`lumio-ds --check-config`, waits for `DS_READY`, starts the real Bot.Host with
the room admission ticket, and passes only after `bot-host.ndjson` contains a
`chat.input` record. Both processes must then exit cleanly. It does not build
or replace either product.

The default test command is hermetic and does not start external services:

```bash
node --test integration/
```

Run the production smoke explicitly with `LUMIO_DS_EXE`, `LUMIO_DS_CONFIG`,
`LUMIO_BOT_DLL`, `LUMIO_ENGINE_NATIVE`, and `LUMIO_ADMISSION_TICKET` set to
trusted external artifacts and a room-bound ticket. Optional variables are
`LUMIO_DS_ENDPOINT`, `LUMIO_BOT_ACCOUNT_FROM`, `LUMIO_BOT_ACCOUNT_TO`,
`LUMIO_DOTNET`, `LUMIO_FORMAL_EVIDENCE_DIR`, and `LUMIO_FORMAL_TIMEOUT_MS`.

On Windows run `npm --prefix integration run formal`. Evidence is written
below `integration/logs/` (or the configured evidence directory) and never
contains the admission ticket. Missing artifacts or runtime prerequisites
return exit code `2` with `VERIFICATION_STATUS=BLOCKED_ENV`; a started service
or client that fails the proof returns exit code `1`.

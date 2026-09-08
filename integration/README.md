# integration - evidence verification

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

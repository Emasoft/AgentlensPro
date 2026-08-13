---
trdd-id: 461M1HER
title: Transparently gzip sealed span-store segments
column: dev
created: 2026-08-13T12:04:15+0200
updated: 2026-08-13T12:04:15+0200
current-owner: lean-worker
task-type: feature
relevant-rules: []
external-refs: [docs_dev/20260813_seal-compression-spec.md]
---

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-13T12:04:15+0200

Implemented and green. `src/segmentedSpanStore.ts::compressSealedSegments()` gzips any segment
whose day is strictly before today; every reader (`forEachInRange`, `loadOrRebuildIndex`,
`runRetention`'s spanCount fallback) is transparent over `.gz` via `segmentDayMs`'s widened regex
and `forEachNdjsonLineAuto` (new in `src/ndjsonLines.ts`). Hooked into the existing daily+boot
`runSpanRetention()` tick in `standalone/server.ts` — no new scheduler. `src/cli/setup.ts`'s
`storeSpanCount` (a raw-directory consumer bypassing the store) updated to count `.gz` too.

NEXT ACTION: none — task complete for this pass. If resumed, verify `pnpm run check-types` /
`check-mirrors` / `check-identities` still pass after any later, unrelated change to this file
(a concurrent session was editing `src/serverRuntime.ts`/`src/mcpServer.ts` during this task's
gates — unrelated, transient, resolved on its own; re-check if it recurs).

Gotcha for the next reader: when BOTH `<day>.ndjson` and `<day>.ndjson.gz` exist for the same key
(compress crash-recovery window, or a late-arriving span appended after compression — see the
comment in `flush()`), every read path merges the two by `(traceId, spanId)` rather than picking
one — do not "simplify" that back to picking a single winner, it would either double-count a
crash leftover or silently drop a late span.

## Problem

Sealed (immutable) daily NDJSON span segments are stored uncompressed; gzip -9 measured 19.5x on
a real segment (project memory ATOM-UNJH-PDX2). A naive fix was PARKED earlier because
`segmentDayMs()` — the regex every reader path filters segment filenames through — rejected a
`.gz` name, making a compressed segment silently invisible (dropped from reads/stats/retention,
no error).

## What changed

- `src/segmentedSpanStore.ts`: `segmentDayMs` regex now accepts an optional `.gz` suffix;
  `countLinesStreaming` is gz-aware; new `compressSealedSegments()` (atomic: gzip to a temp file
  via the existing `atomicWriteFileSync`, verify byte-identical round-trip, THEN delete the plain
  file — never a window with neither form readable); new `listSegmentFiles()` / `countSpansForKey()`
  helpers so every reader (`forEachInRange`, `loadOrRebuildIndex`) merges both forms by span id
  when (rarely) both exist, instead of silently picking one.
- `src/ndjsonLines.ts`: shared chunk-walking core (`walkNdjsonChunks`) factored out of
  `forEachNdjsonLine`; new `forEachNdjsonLineGz` / `forEachNdjsonLineAuto` /
  `countNdjsonLinesAuto` — a `.gz` segment is decompressed to a Buffer (never one giant string),
  so the V8 max-string-length ceiling this module already routes around for plain files is not
  reintroduced on the decompressed side.
- `standalone/server.ts`: `runSpanRetention()` (boot + daily timer, pre-existing) now also calls
  `compressSealedSegments()` first — reuses the existing cadence, no new scheduler.
- `src/cli/setup.ts`: `storeSpanCount()` (a raw `spans/` directory listing bypassing the store API)
  now matches `.ndjson.gz` too and uses `countNdjsonLinesAuto`.
- Tests: `src/test/segmentedSpanStore.test.ts` — 6 new tests (visibility/byte-identity after
  compress, atomic-crash-tolerance via a `.gz.tmp` leftover, active segments never compressed,
  idempotent second sweep, retention on a compressed segment, day-token integrity, raw-consumer
  parity). All 30 tests in the file pass (24 pre-existing + 6 new).

## Consumers swept (docs_dev spec requirement 6)

| Consumer | Disposition |
|---|---|
| `standalone/server.ts` (`spanStore.*`) | Goes through `SegmentedSpanStore` API — fixed at the source |
| `src/otelCallEvents.ts` / `src/cacheEventLog.ts` | `new SegmentedSpanStore(...)` — fixed at the source |
| `src/cli/setup.ts::storeSpanCount` | Direct `fs.readdirSync` + suffix filter — **updated** (this task) |
| `src/ndjsonDuck.ts` consumers (`transcriptSql.ts`, `burnSeismic.ts`, `causingToolCall.ts`) | Not span-store consumers (different NDJSON sources) — N/A |
| DuckDB `read_json_auto` | Verified with a live probe: reads `.gz` natively (3/3 rows round-tripped) — not currently wired to the spans dir, but the primitive is confirmed safe if ever used |

## Verification

`npx tsc -p tsconfig.json --noEmit` / `npx eslint <touched> --quiet` / `npx tsc -p tsconfig.test.json`
/ `mocha out/test/test/segmentedSpanStore.test.js --no-config --ui tdd --timeout 30000 --require
src/test/setup.js` — all green (30/30 passing). Red-first evidence captured by stashing the fix and
re-running `tsc -p tsconfig.test.json` against the new tests + unfixed source: `TS2339: Property
'compressSealedSegments' does not exist on type 'SegmentedSpanStore'` (8 occurrences) — full report
in `reports/lean-worker/`.

## Approval log

(none required — Tier 0, in-scope dev work per the spec)

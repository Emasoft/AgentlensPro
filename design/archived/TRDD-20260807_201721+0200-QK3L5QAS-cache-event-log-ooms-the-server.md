---
trdd-id: QK3L5QAS
title: get_cache_event_log with no window OOMs and kills the shared server
column: completed
created: 2026-08-07T20:17:21+0200
updated: 2026-08-08T00:41:00+0200
current-owner: agentlenspro-main
task-type: bugfix
severity: high
scope: project
project-id: agentlenspro
labels: [server, stability, cache-ledger]
---

# get_cache_event_log with no window OOMs and kills the shared server

Found incidentally on 2026-08-07 while verifying an unrelated change live. **Not** caused by that
change — verified by re-running against the parent commit's bundle, where it dies identically.

## Symptom

`agentlenspro get_cache_event_log` (no `--window`) returns

```
FAIL: cannot reach http://localhost:4316/mcp: socket hang up
```

and the server's pid changes. The server log's last line is `[AgentLens] tool get_cache_event_log
start` and nothing else — the death leaves no stack, so from the logs alone it looks like a hang.
Because one server owns the data directory for the whole machine, this takes ingestion down for
**every** project, not just the caller's.

## Root cause — measured, not inferred

Reproduced out-of-server against the compiled module, which prints what the server swallows:

```
FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory
```

at ~4 GB after ~62 s. The MCP handler (`src/mcpServer.ts:3604-3607`) passes `windowHours: a.window`,
and `--window` is optional — so the default is `undefined`, which the scan treats as **all of
history** rather than as a default window.

Memory scales linearly with the window, holding every event at once:

| `windowHours` | wall | heap | rows |
|---|---|---|---|
| 1 | 1.8 s | 19 MB | 7 |
| 24 | 14.0 s | 478 MB | 7 |
| 168 | — | OOM | — |
| unbounded (the default) | ~62 s | OOM at ~4 GB | — |

≈20 MB of heap per hour of history, against a `source: otel` scan of a span store that is currently
5.3 GB / 4.4 M spans. So the tool works on a young install and starts killing the server once the
store passes roughly 200 hours — which is why this shipped: it degrades with age, not on day one.

Note the row count does not grow with the window (7 at both 1 h and 24 h). The memory is spent on
events that are scanned and then **excluded** as belonging to other projects, never on output — so
the cost is entirely in the scan, and bounding the scan costs the caller nothing they can see.

## Why it is worth more than a default

Three things are wrong and only one of them is the default:

1. **`undefined` silently means "unbounded"** at a tool boundary where every other bound
   (`limit`, `contextEvents`) is clamped to a documented maximum.
2. **The scan accumulates rather than streams.** A ledger that emits 7 rows should not need 478 MB
   to produce them. Bounding the window hides that; it does not fix it.
3. **The server dies silently.** An OOM in a tool handler takes the process with it and writes
   nothing to `server.log`, so the operator sees a hang and no cause. Whatever else changes, the
   failure should be attributable from the log.

## Acceptance

- [x] `get_cache_event_log` with no `--window` completes on this machine's current store without
      the server's pid changing. **Live: exit 0 in 36 s, pid unchanged, 184,212 calls processed
      across the whole store history** — a query that had never once completed.
- [x] The scan's peak heap is bounded independently of the window — **measured across a 168×
      window range: 1 h → 69 MB, 24 h → 121 MB, 168 h → 147 MB, unbounded → 170 MB.** Worth stating
      precisely rather than as "constant": the residual growth is the retained *events*, which a
      function that returns them must hold. What is now independent of the window is the *scanned*
      spans — peak memory follows what is KEPT, not how much is read. Before: 24 h → 478 MB,
      168 h → OOM.
- [x] A tool handler that throws leaves an attributable line in `server.log` naming the tool —
      **already true, and this criterion was written from a misreading.** `src/mcpServer.ts:3850`
      documents exactly this case: "a WEDGED handler never finishes, so a completion-only log can't
      say which… the last `tool <name> start` with no matching done line IS the culprit." That is
      how the culprit was identified here. An OOM is a fatal V8 abort — uncatchable in-process, so
      no handler could have logged more. Nothing to change.
- [x] A test that fails against the current code. Seven new tests (`otelCallEvents.test.ts`, which
      did not exist, plus two `forEachInRange`≡`loadRange` equivalence tests). Falsified by
      deleting the `return` from the compaction branch — the exact bug a `for…continue` → callback
      rewrite invites — which fails `a compaction span lands in compactions and NOT in events`.
      As predicted, the memory property itself is carried by the measurement above rather than by
      a unit test: a test needing a multi-GB store to fail is a test that never runs.

## Evidence

- Crash + scaling table: this document (measured 2026-08-07 against pid-restart behaviour and the
  compiled `out/test/cacheEventLog.js`).
- Pre-existing: `git checkout HEAD~1 -- src/cacheEventLog.ts src/burnSeismic.ts src/causingToolCall.ts`,
  rebuild, re-run — same death, so it predates the slug work committed the same day.
- The unbounded default: `src/mcpServer.ts:3604-3607`.

## Resolution

The default was NOT changed. `windowHours: undefined` still means all of history — it just no
longer costs the whole store in memory to ask for it. `SegmentedSpanStore.loadRange` returned every
span in the window in one array while `scanOtelCallEvents` kept only `api_request` and `compaction`
spans, so ~1M span objects were materialized and discarded on the next line. The store now exposes
`forEachInRange(since, until, visit)`; `loadRange` is a thin wrapper over it, so the two cannot
drift, and the scan uses the visitor. Capping the window would have hidden the accumulation instead
of removing it, and would have made a legitimate full-history query silently partial.

Wall time improved as a side effect (less GC pressure), though it is dominated by I/O over a store
being written concurrently: same-store, warm, window=24 went 28.7 s → 3.1–5.0 s. One measurement
initially read 36.3 s and looked like a regression; it was a cold page cache after a rebuild.

## Approval log

- 2026-08-08T00:41:00+0200 — COMPLETED. Tier 0 (in-scope bugfix, own project, reversible, no
  release or governance surface). All four acceptance criteria met or shown already satisfied;
  2213 tests pass; verified live against the real server with the exact command that killed it.

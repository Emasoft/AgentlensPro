---
trdd-id: QK3L5QAS
title: get_cache_event_log with no window OOMs and kills the shared server
column: todo
created: 2026-08-07T20:17:21+0200
updated: 2026-08-07T20:17:21+0200
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

- [ ] `get_cache_event_log` with no `--window` completes on this machine's current store without
      the server's pid changing.
- [ ] The scan's peak heap is bounded independently of the window — demonstrated by a measurement
      at two window sizes an order of magnitude apart, not by a default.
- [ ] A tool handler that throws (including OOM, as far as is catchable) leaves an attributable line
      in `server.log` naming the tool.
- [ ] A test that fails against the current code. The honest shape is a bounded-memory assertion on
      the scan, not an end-to-end OOM reproduction — a test that needs a 5 GB store to fail is a
      test that never runs.

## Evidence

- Crash + scaling table: this document (measured 2026-08-07 against pid-restart behaviour and the
  compiled `out/test/cacheEventLog.js`).
- Pre-existing: `git checkout HEAD~1 -- src/cacheEventLog.ts src/burnSeismic.ts src/causingToolCall.ts`,
  rebuild, re-run — same death, so it predates the slug work committed the same day.
- The unbounded default: `src/mcpServer.ts:3604-3607`.

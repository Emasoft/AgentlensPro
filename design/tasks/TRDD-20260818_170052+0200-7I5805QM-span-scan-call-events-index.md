---
trdd-id: 7I5805QM
title: cache-event-log rescanned the whole span store per call — incremental sealed-segment index
column: complete
created: 2026-08-18T17:00:52+0200
updated: 2026-08-18T17:00:52+0200
implementation-commits: [82fb745]
current-owner: AgentlensPro session
task-type: bugfix
severity: HIGH
labels: [performance, span-store, hot-path, mcp]
relevant-files: [src/otelCallIndex.ts, src/otelCallEvents.ts, src/cacheEventLog.ts, src/mcpServer.ts, src/store/db.ts]
release-via: publish
---

# Whole-store span re-walk per call (the "server burns 100% of one core" incidents)

Multiple Claude sessions observed the standalone server pinning one core for minutes (2.4GB RSS,
pids respawning across days). Diagnosed first-hand: `get_cache_event_log` with an absent `window`
means since=0 → `scanOtelCallEvents` walks the ENTIRE segmented span store — 5.5M spans across 31
segments on this machine — single-threaded, per call. Memory was already bounded (TRDD-QK3L5QAS
visitor, TRDD-9NAUEUUR line prefilter); the CPU stayed O(all history) per call because immutable
data was re-parsed every time. Agents omitted the window in practice despite the schema warning.

## The fix (82fb745)

1. `src/otelCallIndex.ts` — sealed segments (UTC day over, the store's own compression criterion)
   are extracted ONCE into per-day JSON sidecars (`<spansDir>/.call-events-index/`); every query
   reads sidecars + parses only TODAY's live segment. Honesty rules: a transient read failure is
   never persisted as an empty day; orphan sidecars drop when retention purges their segment; a
   corrupt sidecar rebuilds; assembly dedupes day-edge double-visits by request identity.
2. `get_cache_event_log` absent window now defaults to 24h; explicit `window: 0` = all history.
3. DuckDB `DEFAULT_THREADS` was a flat 4 — machine-scaled now (`availableParallelism - 2`, floor
   4; `AGENTLENS_DUCKDB_THREADS` override), so SQL paths use the cores the box has (12 here).

## Verification

- 7 new tests (`src/test/otelCallIndex.test.ts`); the decisive one CORRUPTS a sealed segment after
  extraction and proves the answer is unchanged — sealed history is never re-read. Suite 2390.
- Live on the real 5.5M-span store: all-history 32.7s ONCE (extraction), then 3.9s from the index;
  24h default 2.0s. Previously the 32s-class walk recurred on EVERY unbounded call.

## Approval log

- 2026-08-18T17:00:52+0200 — COMPLETED. Diagnosed and implemented under the USER's direct order
  ("the server is too slow... write better sql functions"); the observed burner was the
  single-threaded TypeScript span walk, which this removes. Successor goal: [[TRDD-DMWOBWFH]]
  (Rust+SQL core rewrite). Rides the next publish.

## Notes and lessons learned

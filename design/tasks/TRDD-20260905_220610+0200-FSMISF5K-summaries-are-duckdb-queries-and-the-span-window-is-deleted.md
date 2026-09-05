---
trdd-id: FSMISF5K
title: Per-session summaries are DuckDB queries over the segments and the resident span window is deleted
column: todo
created: 2026-09-05T22:06:10+0200
updated: 2026-09-05T22:06:10+0200
current-owner: main-session
task-type: refactor
priority: high
min-approval-requirement: none
scope: project
project-id: agentlenspro
parent-trdd: 7YPQWKPG
npt: [XTFDRTH2]
related: [7YPQWKPG, Q9WD3K5R, YILE6N3T, 7RM5YW2T]
relevant-files: [rust-core/crates/agentlens-core/src/span_window.rs, rust-core/crates/agentlens-core/src/ui.rs, rust-core/crates/agentlens-core/src/lib.rs, rust-core/crates/agentlens-spanstore/src/writer.rs]
labels: [rust-core, memory, duckdb]
---

# Per-session summaries are DuckDB queries over the segments and the resident span window is deleted

Advisor steps 3 and 4 of TRDD-7YPQWKPG, re-issued by the USER 2026-09-05 22:00 ("make DuckDB the
only memory … why things kept in memory and not written down in parquet"). Today every derived
view is `summarize_spans` over `SpanWindow.spans: Vec<Arc<Value>>` — 24 h of spans replayed into
RAM at boot (`boot_load`) plus every live span — and the summary is a Rust-side rebuild of the
whole window (TRDD-7RM5YW2T).

## Shape

- Per-session aggregates (tokens, cache buckets, tool counts, durations, model) become SQL over
  `read_ndjson_auto(today + yesterday)` into a `session_summary` table refreshed on the 5 s chores
  tick; timeline / synthetic-root / subagent logic stays Rust but runs PER SESSION ON DEMAND
  (`/api/timeline/:id`), never over the whole window.
- `boot_load` and `window.spans` are deleted. The 5-minute burn window = the writer's flushed
  buffer + a query over today's segment. Sealed segments convert to parquet (Q9WD3K5R's rebuild
  decision governs the schema).
- The only RAM the server keeps for spans is the bytes-bounded ingest buffer between arrival and
  flush (7YPQWKPG principle 4).

## NEXT ACTION

After XTFDRTH2: inventory every consumer of `window.spans` and of the whole-window summary
(`grep -n 'window.spans\|summary_snapshot\|summarize_spans'`), write the `session_summary` SQL and
prove it reproduces the current summary on the parity goldens BEFORE deleting anything, then
delete `boot_load` → `SpanWindow` → the rebuild loop, one phase per file group (≤5 files).

## Acceptance

- [ ] `SpanWindow` and `boot_load` no longer exist; `spans.inMemory` in `/api/server-stats`
      reports only the unflushed buffer.
- [ ] Parity goldens for every summary-derived route unchanged.
- [ ] Boot time and steady-state RSS recorded; RSS after 24 h under a bound the advisor sets
      (7YPQWKPG acceptance).

## Notes and lessons learned

## Approval log

- 2026-09-05T22:06:10+0200 — Authored into `todo` as an NPT-gated child of the USER-approved
  7YPQWKPG.

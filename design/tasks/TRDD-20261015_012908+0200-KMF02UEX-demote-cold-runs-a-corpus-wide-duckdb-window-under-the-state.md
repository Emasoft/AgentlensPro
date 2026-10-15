---
trdd-id: KMF02UEX
title: demote_cold runs a corpus-wide DuckDB window under the state lock and panics on out-of-memory
column: todo
status: tasked
created: 2026-10-15T01:29:08+0200
updated: 2026-10-15T03:38:43+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T01:29:08+0200
project-id: agentlenspro
---

# demote_cold runs a corpus-wide DuckDB window under the state lock and panics on out-of-memory

## Problem
`CardStore::demote_cold` (rust-core/crates/agentlens-core/src/card_store.rs:567-616) ranks ALL rows with a window function (`row_number() OVER (ORDER BY last_active_ms DESC, seq ASC)`) on every call past the hot-set size, and it runs on the lock-held ingest path (`ingest_scanned`, lib.rs:353-372). It has four `.expect` calls on DuckDB statements (:582, :585, :586, :602). A DuckDB out-of-memory there panics while the state lock is held: the same failure class as TRDD-DA0GN1CS (the four .expect calls and the whole-table window verified by MEASURE, reports_dev/da0gn1cs-measure.md section 10; the call under the lock read by the main agent: `CoreState::ingest_scanned(&mut self)` at lib.rs:353-372 calls `demote_cold_timelines`; not yet observed firing).

## Fix direction
Bound the scan (only rows with timeline_len > 0 beyond the hot set), move the DuckDB work off the state lock, and return an error instead of panicking.

## Acceptance
- [ ] demote_cold performs no corpus-scaled DuckDB query under the state lock.
- [ ] A DuckDB error in demote_cold is logged and retried, never a panic under the lock; a test forces it.

## Approval log

- 2026-10-15T01:29:08+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Notes and lessons learned

2026-10-15: when this card rewrites demote_cold, also correct the TRDD-RVKQDLRD QoS comment in log_reader.rs start_sweeper (from e3c3c388): say "each non-empty ingest batch" (ingest_scanned returns early on an empty batch), "once the corpus exceeds the hot set" (demote_cold returns early below it), and that the hold's duration is unmeasured.

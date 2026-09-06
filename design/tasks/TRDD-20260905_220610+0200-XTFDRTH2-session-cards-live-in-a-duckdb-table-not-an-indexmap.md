---
trdd-id: XTFDRTH2
title: Session cards live in a DuckDB table upserted on ingest, not in a 32k-entry IndexMap
column: dev
created: 2026-09-05T22:06:10+0200
updated: 2026-09-06T03:19:16+0200
implementation-commits: []
current-owner: main-session
task-type: refactor
priority: high
min-approval-requirement: none
scope: project
project-id: agentlenspro
parent-trdd: 7YPQWKPG
npt: [YILE6N3T, 7RM5YW2T]
related: [7YPQWKPG, Q9WD3K5R, FSMISF5K]
relevant-files: [rust-core/crates/agentlens-core/src/lib.rs, rust-core/crates/agentlens-core/src/log_reader.rs, rust-core/crates/agentlens-core/src/feed_merge.rs]
labels: [rust-core, memory, duckdb]
---

# Session cards live in a DuckDB table upserted on ingest, not in a 32k-entry IndexMap

Advisor step 2 of TRDD-7YPQWKPG (verdict 2026-09-02), re-issued by the USER 2026-09-05 22:00
("why are there persistent data structures in RAM instead of just the small query results from
DuckDB"). Today `CoreState.log_sessions: IndexMap<String, Arc<Value>>` holds 32,607 cards
(`lib.rs:188`), filled by the boot/incremental log scan, stripped to headers except 50 hot ones,
cloned wholesale into every summary snapshot.

## Shape

ONE long-lived in-memory DuckDB connection owned by `CoreState`; table
`cards(session_id PK, start_ms, card JSON)`; `put_log_session` becomes an upsert; boot restores
from the delta log (`log_reader.rs:689`) via `read_ndjson_auto` (precedent `transcript_sql.rs:413`);
`feed_merge.rs` stays Rust over the colliding ids only; every reader that today iterates
`log_sessions` becomes a query that returns and drops its rows. The wire shape of every route
stays byte-identical (7YPQWKPG acceptance).

## NEXT ACTION

Blocked on the two same-day bugfix NPTs landing (they change the same files' hot paths). Then:
list every reader of `log_sessions` (`grep -n log_sessions` — `lib.rs`, `ui.rs`, `log_reader.rs`,
`feed_merge.rs`, `chores.rs`), write the table + upsert + boot-restore, convert readers one file per
phase (≤5 files per phase), parity tests unchanged.

## Acceptance

- [ ] `CoreState` has no `log_sessions` map; `grep -rn 'log_sessions' src/` → only the DuckDB
      accessor.
- [ ] All parity/golden tests unchanged; every `agentlenspro` tool answers with identical shape.
- [ ] Resident mimalloc heap after boot ≤ the pre-change figure minus the cards' share, recorded.

## Notes and lessons learned

## Approval log

- 2026-09-05T22:06:10+0200 — Authored into `todo` as an NPT-gated child of the USER-approved
  7YPQWKPG (Tier 0: scope already ruled by the USER).

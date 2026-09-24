---
trdd-id: TWDGR75R
title: A card-store OOM poisons the core lock and silently kills the log sweeper
column: todo
created: 2026-09-24T16:11:23+0200
updated: 2026-09-24T17:14:11+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: bugfix
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-24T16:11:23+0200
---

# A card-store OOM poisons the core lock and silently kills the log sweeper

## Approval log

- 2026-09-24T16:11:23+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Evidence

reports/cc-alignment/20260924_160531+0200-reparse-bounded.md, section "Observed, NOT fixed": an isolated full-size run crashed at t≈55-60s AFTER boot completed cleanly, with these two panic lines: `thread 'tokio-rt-worker' panicked at crates/agentlens-core/src/card_store.rs:218:66: scan the cards: DuckDBFailure(... "Out of Memory Error: could not allocate block of size 352.0 KiB (255.8 MiB/256.0 MiB used)" ...)` and `thread 'log-sweeper' panicked at crates/agentlens-core/src/log_reader.rs:1230:53: core state: PoisonError { .. }`.

## Two defects

(a) CardStore::cards_json (card_store.rs:218, `SELECT card FROM cards ORDER BY seq`) scans every card in the store under DuckDB's 256 MiB MEMORY_LIMIT — a corpus this size (well over the ~34,697 restored cards) exceeds it during summary_snapshot.
(b) a panic while holding the CoreState mutex poisons it; the log-sweeper thread (log_reader.rs:1230) then panics on the poisoned lock on its next periodic tick, so ingestion stops silently while the process stays up (observed on an isolated copy: the log sweeper stops; other ingest paths unverified) — the process never exits, so nothing restarts it.

## Open question

Caused by the TRDD-ORGJ0E3G re-parse (cards duplicated rather than replaced?) or latent at this corpus size regardless of that change; a read-only investigation is running and its report will land in reports/cc-alignment/ as *-cardstore-oom.md.

## Acceptance

The full-table scan cannot exceed DuckDB's MEMORY_LIMIT at 2x today's card count (bound cards_json/summary_snapshot instead of an unbounded full scan) — one test. A panic under the CoreState lock is either impossible or makes the process exit loudly so it is restarted (never a silent, still-running ingestion stop) — one test.

## Notes and lessons learned



## VERDICT

## VERDICT (2026-09-24, reports/cc-alignment/20260924_164606+0200-cardstore-oom.md) — caused by the re-parse, not by row duplication. card_store.rs put() (lines 161-165) is a strict upsert on the session_id PRIMARY KEY: a re-parsed card for an already-seen session id REPLACES that row's card/last_active_ms/timeline_len in place, it never adds a row. A freshly parsed card is much larger than the restored form (cacheCreate1hTokens and other fields the persisted/stripped form on disk did not carry), so re-parsing ~8,900 transcripts roughly doubled cards.duckdb (215 MB live, un-reparsed, vs 430 MB after re-parse on the same corpus) and the FIRST cards_json() call (card_store.rs:218) exceeded DuckDB's 256 MiB buffer-pool limit. The deployed binary (a187815e build, no re-parse) ran the same cards_json() scan 26+ times on the un-re-parsed corpus without incident, and runs fine today at ~34.7k cards. Whether the 256 MiB ceiling is ALSO reachable by ordinary organic growth (no re-parse) is inferred, not verified — no run tested un-reparsed growth past today's corpus size.

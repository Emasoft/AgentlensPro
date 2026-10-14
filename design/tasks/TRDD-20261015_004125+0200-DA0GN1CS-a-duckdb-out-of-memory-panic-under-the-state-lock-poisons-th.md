---
trdd-id: DA0GN1CS
title: A DuckDB out-of-memory panic under the state lock poisons the collector and stops all ingestion
column: todo
status: tasked
created: 2026-10-15T00:41:25+0200
updated: 2026-10-15T00:42:16+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T00:41:25+0200
---

# A DuckDB out-of-memory panic under the state lock poisons the collector and stops all ingestion

## Approval log

- 2026-10-15T00:41:25+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Findings (2026-10-15)

- Live incident: thread 'log-sweeper' panicked at crates/agentlens-core/src/card_store.rs:520:14, `.expect("scan the cards for persistence")`, on DuckDB 'Out of Memory Error: failed to pin block of size 2.2 MiB (254.5 MiB/256.0 MiB used)' (server.log line 575405, 2026-10-14 about 16:21:48). The call runs under the state lock (log_reader.rs:1185, `st.cards.persist_records()`), so the panic POISONED the state mutex.
- Consequences (main agent verified 7162 'state poisoned' log lines, the last at 2026-10-15T00:39:56; the rest by code read in the report): the log sweeper is dead, so log ingestion has stopped; the burn tick skips every tick; OTLP ingest returns 'state poisoned', so exporter batches are rejected; the hook-spool drain still runs (it recovers with into_inner).
- Same .expect at HEAD (card_store.rs:520; also :508 `.expect("scan the cards")`). DuckDB MEMORY_LIMIT is 256 MiB with 41,819 card rows (~77 MB text). Earlier warnings of the same OOM: 'card store NOT reusing cards.duckdb (the cards table is unreadable: Out of Memory ...)' at 2026-10-13T21:18 and 2026-10-14 11:06 and 14:13.
- Fix direction: (1) never panic under the state lock — a persist/scan failure returns an error, is logged, and is retried, never `.expect`; audit every `.expect`/`unwrap` reachable while the state guard is held; (2) decide how the process behaves with a poisoned lock: recover with into_inner where state is still consistent, or exit so the supervisor restarts it, instead of running half-dead; (3) the OOM itself: persisting all cards in one scan at a 256 MiB limit; stream or batch it, or raise the limit with evidence.
- Live remedy is the owner's: `agentlenspro server restart` clears the poison; it does not fix the cause.
- Also observed (report, inferred and not proven causal): RSS HARD CAP exits on most days since 2026-10-02 (44-135 per day).

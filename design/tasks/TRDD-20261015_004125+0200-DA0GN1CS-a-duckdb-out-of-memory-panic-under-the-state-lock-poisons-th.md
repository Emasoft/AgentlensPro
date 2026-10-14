---
trdd-id: DA0GN1CS
title: A DuckDB out-of-memory panic under the state lock poisons the collector and stops all ingestion
column: dev
status: tasked
created: 2026-10-15T00:41:25+0200
updated: 2026-10-15T01:30:14+0200
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
eht: [TYJSS45N]
---

# A DuckDB out-of-memory panic under the state lock poisons the collector and stops all ingestion

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-15

- ROOT CAUSE (verified, reports_dev/poison-fix-facts.md): `save_cards` ran `CardStore::persist_records()`, a whole-table DuckDB scan, UNDER the state lock; at the 256 MiB limit it hit out-of-memory at the `.expect` at card_store.rs:520, the log-sweeper panicked holding the lock, the mutex was poisoned. Second occurrence: the first was 2026-10-03 17:27:28 (server.log:442035), about 52 h of dead ingestion until a hook revive on 2026-10-05 21:46:16 (how that process ended is INFERRED: an external kill).
- WHY NOTHING RESTARTED IT: the hook revive is pidfile-only; a steady-state panic leaves the process alive (unwind), while a boot-time sweeper failure exits (alcore.rs:370-374).
- COMMIT 1 (in dev): build the persist records from the resident parsed layer (`persist_snapshot` + `persist_records_from`), no DuckDB scan under the lock. Spec docs_dev/da0gn1cs-commit1-spec.md; adversarially reviewed and MEASURE-verified 2026-10-15 (reports_dev/da0gn1cs-measure.md).
- COMMIT 2 (deferred): a panic hook in the alcore binary that logs the location and exits(1). BLOCKED until TRDD-0BDOV3WC lands, because every restart re-runs the reuse path that deletes cards.duckdb on out-of-memory. Needs a binary-level test (feature-gated panic trigger on a worker thread holding the lock: exit 1, FATAL line, no survivor).
- REVIEW FINDING REJECTED: "lock_timed's .expect panics on a lock timeout" — lock_timed has no timeout; it blocks on Mutex::lock and errs only on poison (lib.rs:1352-1380).
- DERIVED: TRDD-0BDOV3WC (reuse OOM deletes a valid DB), TRDD-KMF02UEX (demote_cold OOM under the lock), TRDD-WCENKH6T (sweeper death without a panic), TRDD-TYJSS45N (poison-recovery cleanup after commit 2).
- LIVE: pid 55408 is still poisoned; restart is the OWNER's call. Before a restart, back up the whole set: cards.duckdb, cards.duckdb.wal, log-offsets.*.ndjson, log-sessions.*.ndjson, log-delta-version.json (restoring the DB alone next to newer offsets leaves stale cards).

## Approval log

- 2026-10-15T00:41:25+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-15T01:30:14+0200 — column → dev by main-agent@agentlenspro. commit 1 implementation started 2026-10-15

## Findings (2026-10-15)

- Live incident: thread 'log-sweeper' panicked at crates/agentlens-core/src/card_store.rs:520:14, `.expect("scan the cards for persistence")`, on DuckDB 'Out of Memory Error: failed to pin block of size 2.2 MiB (254.5 MiB/256.0 MiB used)' (server.log line 575405, 2026-10-14 16:21:48, verified by reading the line). The call runs under the state lock (log_reader.rs:1185, `st.cards.persist_records()`), so the panic POISONED the state mutex.
- Consequences (1,035 'state poisoned' lines from the panic line, server.log:575405, onward, 1,034 of them the resident-blob scan at chores.rs:554, counted by position on 2026-10-15; the earlier figure of 7,162 counted the whole log, which also holds the 2026-10-03 poisoning; the rest by code read in the report): the log sweeper is dead, so log ingestion has stopped; the burn tick skips every tick; OTLP ingest maps the poison to an error (lib.rs:1213, by code read; no rejection is logged, so the rejection itself is INFERRED); the hook-spool drain still runs (it recovers with into_inner).
- Same .expect at HEAD (card_store.rs:520; also :508 `.expect("scan the cards")`). DuckDB MEMORY_LIMIT is 256 MiB with 41,819 card rows (~77 MB text). Earlier warnings of the same OOM: 'card store NOT reusing cards.duckdb (the cards table is unreadable: Out of Memory ...)' at 2026-10-13T21:18 and 2026-10-14 11:06 and 14:13.
- Fix direction: (1) never panic under the state lock — a persist/scan failure returns an error, is logged, and is retried, never `.expect`; audit every `.expect`/`unwrap` reachable while the state guard is held; (2) decide how the process behaves with a poisoned lock: recover with into_inner where state is still consistent, or exit so the supervisor restarts it, instead of running half-dead; (3) the OOM itself: persisting all cards in one scan at a 256 MiB limit; stream or batch it, or raise the limit with evidence.
- Live remedy is the owner's: `agentlenspro server restart` clears the poison; it does not fix the cause.
- Also observed (report, inferred and not proven causal): RSS HARD CAP exits on most days since 2026-10-02 (44-135 per day).

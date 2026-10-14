---
trdd-id: DA0GN1CS
title: A DuckDB out-of-memory panic under the state lock poisons the collector and stops all ingestion
column: dev
status: tasked
created: 2026-10-15T00:41:25+0200
updated: 2026-10-15T01:51:23+0200
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
eht: []
---

# A DuckDB out-of-memory panic under the state lock poisons the collector and stops all ingestion

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-15 rev 2

- SCOPE: this card is commit 1 ONLY, the removal of the observed panic site. Exit-on-panic moved to TRDD-3RVTC1HY, which is blocked by TRDD-0BDOV3WC. This card completes when commit 1 lands and is verified.
- ROOT CAUSE (main agent read the code): `save_cards` (log_reader.rs ~1182) ran `CardStore::persist_records()`, a whole-table DuckDB `SELECT session_id, card FROM cards ORDER BY seq`, UNDER the state lock. At the 256 MiB limit it failed out-of-memory at the `.expect` at card_store.rs:520, the log-sweeper panicked holding the lock, and the mutex was poisoned. The panic is at server.log:575405; the log lines just before it are stamped 2026-10-14T16:21:48 (both read by the main agent).
- FIRST OCCURRENCE: the same :520 panic on 2026-10-03 17:27:28 (server.log:442035, per reports_dev/poison-fix-facts.md); the hook revive followed on 2026-10-05 21:46:16. That ingestion was dead for those ~52 h is INFERRED from the two times, and how that process ended (an external kill) is INFERRED.
- WHY NOTHING RESTARTED IT: the hook revive is pidfile-only (src/cli/hookHandlers.ts:108-133 `pidfileOwnerAlive`, read), and the poisoned process stays alive. A boot-time sweeper failure does exit (alcore.rs:370-374, per the facts report).
- COMMIT 1 PLAN (in dev, worker running): (1) `CardStore::persist_snapshot()` returns the resident parsed layer under a short lock, one refcount bump per card. It counts `full_scan_calls` and carries a `debug_assert` that the resident count equals the table row count; `persist_records` is deleted. (2) `log_reader::persist_records_from()` builds the (sessionId, strip_card_for_persist) records OFF the lock; `restore_reused` and `save_cards` share it. (3) Tests: an order-sensitive serialized comparison against the table, of the stripped records AND of the unstripped layers, after a put, an upsert, `demote_cold` and a verified reuse reopen; and a separate positive control that a full save counts once. Mutations M1 (reversed order), M2 (empty key), M3 (skipped resident demotion), M4 (counter removed) and M5 (unstripped resident copy) must each fail; one that does not is reported verbatim. (4) The comments naming persist_records are updated (log_reader.rs ~995, ~1126, ~1202, ~1484; the parity test ~1063 and ~1114). The worker spec is docs_dev/da0gn1cs-commit1-spec.md plus the review amendments sent to the worker on 2026-10-15.
- VERIFICATION OWED before complete: cargo clippy --all-targets -- -D warnings, and cargo test --workspace compared with the HEAD baseline (956 passed, 0 failed for the workspace, reports_dev/rust-head-check.md); release alcore rebuilt and codesigned; then `pnpm run test:unit` against that binary.
- WHY THE TWO SOURCES ARE EQUIVALENT (main agent and MEASURE read the code): the resident key is the card's sessionId on every write path; `parsed` is mutated only by insert (which keeps the slot), clear and get_mut; serde_json is built with float_roundtrip. HAZARD if this ever breaks: `DeltaLog::save` diffs deletions, so a partial resident layer would tombstone cards in the NDJSON snapshot that the reuse fallback restores from. The debug_assert and the count checks guard against that.
- REVIEW FINDING REJECTED, timeout half only: "lock_timed's .expect panics on a lock timeout". lock_timed blocks on Mutex::lock and errs only on poison (lib.rs:1352-1380). The other half stands and moves to TRDD-3RVTC1HY: until that lands, every DuckDB `.expect` reachable under the lock still turns an out-of-memory error in steady state into a zombie (at boot the same panics crash-loop instead). demote_cold's is carded as TRDD-KMF02UEX.
- DERIVED: TRDD-3RVTC1HY (exit on any panic, formerly commit 2), TRDD-0BDOV3WC (reuse refusal deletes cards.duckdb), TRDD-KMF02UEX (demote_cold OOM under the lock), TRDD-WCENKH6T (sweeper death without a panic); TRDD-TYJSS45N follows TRDD-3RVTC1HY.
- OBLIGATION: the TRDD-RVKQDLRD QoS justification (source comment log_reader.rs ~1484) cited the full-corpus lock hold that commit 1 removes, so the sweeper's normal-QoS decision needs re-deciding under RVKQDLRD. That card carries foreign uncommitted edits, so the obligation is recorded here.
- LIVE: pid 55408 is still poisoned, and the restart is the OWNER's call. Before a restart, back up the whole set: cards.duckdb, cards.duckdb.wal, log-offsets.*.ndjson, log-sessions.*.ndjson and log-delta-version.json. Restoring the database alone next to newer offsets leaves stale cards. The body's "Live remedy" line and its "Fix direction" bullet are superseded by this block.

## Approval log

- 2026-10-15T00:41:25+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-15T01:30:14+0200 — column → dev by main-agent@agentlenspro. commit 1 implementation started 2026-10-15

## Findings (2026-10-15)

- Live incident: thread 'log-sweeper' panicked at crates/agentlens-core/src/card_store.rs:520:14, `.expect("scan the cards for persistence")`, on DuckDB 'Out of Memory Error: failed to pin block of size 2.2 MiB (254.5 MiB/256.0 MiB used)' (server.log line 575405, 2026-10-14 16:21:48, verified by reading the line). The call runs under the state lock (log_reader.rs:1185, `st.cards.persist_records()`), so the panic POISONED the state mutex.
- Consequences (1,035 'state poisoned' lines from the panic line, server.log:575405, onward, 1,034 of them the resident-blob scan error at chores.rs:554 (read), counted by position at about 01:00 on 2026-10-15; the count grows while pid 55408 stays poisoned; the earlier figure of 7,162 counted the whole log, which includes the 2026-10-03 poisoning; the rest by code read in the report): the log sweeper is dead, so log ingestion has stopped; the burn tick skips every tick (INFERRED, from the facts fork's code read); OTLP ingest maps the poison to an error (lib.rs:1213, by code read; no rejection is logged, so the rejection itself is INFERRED); the hook-spool drain still runs (it recovers with into_inner).
- Same .expect at HEAD (card_store.rs:520; also :508 `.expect("scan the cards")`). DuckDB MEMORY_LIMIT is 256 MiB with 41,819 card rows (~77 MB text). Earlier warnings of the same OOM: 'card store NOT reusing cards.duckdb (the cards table is unreadable: Out of Memory ...)' at 2026-10-13T21:18 and 2026-10-14 11:06 and 14:13.
- SUPERSEDED 2026-10-15 by the STATE block (commit 1 here; exit-on-panic in TRDD-3RVTC1HY). Fix direction: (1) never panic under the state lock — a persist/scan failure returns an error, is logged, and is retried, never `.expect`; audit every `.expect`/`unwrap` reachable while the state guard is held; (2) decide how the process behaves with a poisoned lock: recover with into_inner where state is still consistent, or exit so the supervisor restarts it, instead of running half-dead; (3) the OOM itself: persisting all cards in one scan at a 256 MiB limit; stream or batch it, or raise the limit with evidence.
- SUPERSEDED 2026-10-15 by the STATE block (a restart re-runs the reuse path, which can delete cards.duckdb; back up first). Live remedy is the owner's: `agentlenspro server restart` clears the poison; it does not fix the cause.
- Also observed (report, inferred and not proven causal): RSS HARD CAP exits on most days since 2026-10-02 (44-135 per day).
- 2026-10-15: commit 1 also removes the whole-store persist scan from the sweeper's lock-held path, so the long-holder analyses in TRDD-N60JUWU3 and TRDD-H3D5ZBO1 must not count that hold after it lands; N60JUWU3 cites save_cards/persist_records directly.

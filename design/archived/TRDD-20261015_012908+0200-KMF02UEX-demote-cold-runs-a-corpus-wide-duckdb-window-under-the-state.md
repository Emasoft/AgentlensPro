---
trdd-id: KMF02UEX
title: demote_cold runs a corpus-wide DuckDB window under the state lock and panics on out-of-memory
column: complete
status: archived
created: 2026-10-15T01:29:08+0200
updated: 2026-10-15T11:09:58+0200
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
implementation-commits: [f9e0742e]
---

# demote_cold runs a corpus-wide DuckDB window under the state lock and panics on out-of-memory

## Problem
`CardStore::demote_cold` (rust-core/crates/agentlens-core/src/card_store.rs:567-616) ranks ALL rows with a window function (`row_number() OVER (ORDER BY last_active_ms DESC, seq ASC)`) on every call past the hot-set size, and it runs on the lock-held ingest path (`ingest_scanned`, lib.rs:353-372). It has four `.expect` calls on DuckDB statements (:582, :585, :586, :602). A DuckDB out-of-memory there panics while the state lock is held: the same failure class as TRDD-DA0GN1CS (the four .expect calls and the whole-table window verified by MEASURE, reports_dev/da0gn1cs-measure.md section 10; the call under the lock read by the main agent: `CoreState::ingest_scanned(&mut self)` at lib.rs:353-372 calls `demote_cold_timelines`; not yet observed firing).

## Fix direction
Bound the scan (only rows with timeline_len > 0 beyond the hot set), move the DuckDB work off the state lock, and return an error instead of panicking.

## Acceptance
MOVED to TRDD-074C0DK8 (not met by f9e0742e): demote_cold performs no corpus-scaled DuckDB query under the state lock.
- [x] A DuckDB error in demote_cold is logged and retried, never a panic under the lock; a test forces it.

## Approval log

- 2026-10-15T01:29:08+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-15T11:09:33+0200 — acceptance narrowed at close by main-agent@agentlenspro: box 1 was not met by f9e0742e and moved verbatim to TRDD-074C0DK8; box 2 met, its caller half verified by reading. The card stayed in todo while f9e0742e was worked and moves from todo straight to complete (a board lapse, as the A2KNXCNH review caught).
- 2026-10-15T11:09:58+0200 — COMPLETE by main-agent@agentlenspro. box 2 met and gated at f9e0742e; box 1 moved to TRDD-074C0DK8.

## Notes and lessons learned

2026-10-15: when this card rewrites demote_cold, also correct the TRDD-RVKQDLRD QoS comment in log_reader.rs start_sweeper (from e3c3c388): say "each non-empty ingest batch" (ingest_scanned returns early on an empty batch), "once the corpus exceeds the hot set" (demote_cold returns early below it), and that the hold's duration is unmeasured.
2026-10-15: the RVKQDLRD start_sweeper comment correction this note asked for landed in f9e0742e.

## Results

2026-10-15 — Implemented in f9e0742e: demote_cold returns Result<usize, String>; the early return counts the resident layer; candidates come from a keys-only query (ids, never card text); each candidate is fetched by primary key, stripped, UPDATEd, and only then stripped in the resident layer; every error is an Err. CoreState::demote_cold_timelines counts errors (degradations "alcore.demoteColdError"), logs the first failure of a streak and the recovery, and the next batch retries.
Box 2 met: demote_cold_returns_err_on_a_db_error_and_strips_nothing and a_failing_demote_cold_does_not_poison_the_lock_it_runs_under force a DuckDB error (DROP TABLE) and assert Err with no panic and an unpoisoned mutex. The caller half (CoreState::demote_cold_timelines counting the error, logging the first failure and the recovery, and the degradations entry "alcore.demoteColdError") is verified by reading, not by a test: no test references demote_cold_errors, demote_failing or demoteColdError.
Box 1 NOT met by f9e0742e: the keys-only window still ranks every row under the lock on every non-empty batch (memory at most 16 MiB measured, lock hold unmeasured). Moved verbatim to TRDD-074C0DK8, which replaces this card on the TRDD-HSPUF5XH release-blocker list. The first half of this card title ("runs a corpus-wide DuckDB window under the state lock") remains true at close; the second half ("panics on out-of-memory") is fixed.
Gate at f9e0742e (re-checked by the main agent from the raw files: the TS counts and exit, the latency guard, the no-op rebuild log, the binary sha256 after the run and the five hashes; worker-reported: the release build exit, the --version exit and the step-5 sha256): release build and a no-op rebuild (0 "Compiling agentlens-core" lines); alcore --version exit 64; sha256 34e2f8db45446c1c68c0f85e845f9563ff0698ca94f3060e68ef4930ead09e70, unchanged at run end; TS unit with AGENTLENS_ALCORE unset: 3177 passing, 13 pending, 0 failing, exit=0 written into reports_dev/kmf02uex-gate-ts.txt; latency guard RAN (4 checks passed). Rust: cargo test -p agentlens-core 808 passed, 0 failed over 123 binaries (worker run before the comment-only rewording; clippy -D warnings re-run after it, clean). Report: reports_dev/kmf02uex-gate-report.md.
Residuals (not fixed here): per-card UPDATE memory at 256 MiB with 80 KB to 2.3 MB cards is unmeasured (with 4 KB timeline entries, no memory limit let the old read fail while demote_cold succeeded, because the per-card UPDATEs needed more); the first failing card aborts the loop, so one bad row blocks every later candidate and resident timelines stay unstripped while it lasts; a resident entry missing from parsed is still skipped silently after its UPDATE (unchanged); the strip-after-UPDATE order has no test (TRDD-59OONXOV); other .expect sites under the lock remain (TRDD-3RVTC1HY).
Corrections to the f9e0742e commit message: five of the six changed demote_cold callers assert the returned count, the sixth (persist_records_from_the_resident_layer_equal_the_table) only calls .expect("demote"); the worker report names "a buggy mutation script" without saying what it wrote with, so "against its fastedit-only instruction" should read "tool unknown"; large-r30 is a synthetic regrowth (30 rewrites of the 31 timeline cards), not a copy of a file production regrew, which is also what the doc comment phrase "a scratch copy of a regrown file" means.

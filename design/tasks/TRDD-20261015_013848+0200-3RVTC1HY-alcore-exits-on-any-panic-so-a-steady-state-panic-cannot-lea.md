---
trdd-id: 3RVTC1HY
title: alcore exits on any panic so a steady-state panic cannot leave a live-looking zombie
column: dev
status: tasked
created: 2026-10-15T01:38:48+0200
updated: 2026-10-16T04:30:34+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T01:38:48+0200
blocked-by: []
eht: [TYJSS45N]
pre-block-column: 
project-id: agentlenspro
blocker-probe: [trddgrep, why, 3RVTC1HY]
blocker-holds-if: not-match:READY
---

# alcore exits on any panic so a steady-state panic cannot leave a live-looking zombie

## Problem
TRDD-DA0GN1CS: a panic in steady state unwinds, poisons the state mutex, and leaves alcore alive but not ingesting; the pidfile-only hook revive (src/cli/hookHandlers.ts:108-133 `pidfileOwnerAlive`) never replaces it. DA0GN1CS removes the one observed site (the persist scan). The class remains: the facts fork counted 38 DuckDB `.expect` calls reachable under the state lock (reports_dev/poison-fix-facts.md), and each can recreate the zombie in steady state (at boot the same panics crash-loop instead, as the 40,350 old upsert panics did).

## Design (proposed 2026-10-15 as DA0GN1CS commit 2, reviewed twice, not implemented)
As the first statement of `main` in rust-core/crates/agentlens-core/src/bin/alcore.rs, install `std::panic::set_hook`. The hook calls the default hook, logs "alcore: FATAL — a thread panicked; exiting so the hook revive restarts a clean process", then exits 1. It is scoped to the binary: the alternative, `panic = "abort"` in the workspace release profile, would also change alstore and the other workspace members. It must not take the state lock.

## Blocked by TRDD-0BDOV3WC
Every restart re-runs the reuse path, and that path deletes cards.duckdb after an out-of-memory read. Turning panics into restarts before that is fixed multiplies the data-loss risk.

## Prerequisites and open questions (2026-10-15 reviews and MEASURE, reports_dev/da0gn1cs-measure.md)
- Binary-level test: a cargo-feature-gated panic trigger on a worker thread that holds the state lock. Assert exit code 1, the FATAL line, and no surviving process.
- `std::process::exit` runs DuckDB's C++ static destructors while other threads may be inside DuckDB; consider `libc::_exit(1)`. rss_guard shares this risk and has 1,517 exits on record (per the facts fork).
- No span flush happens on a panic exit, whereas rss_guard flushes first. TRDD-N60JUWU3's lock-free handles would let the hook flush too.
- UNDECIDED (MEASURE): whether a dependency (duckdb-rs, hyper, notify) panics and catches internally as normal control flow; the hook would turn that into an exit. Evidence against it: every panic in server.log's history ran on the log-sweeper thread (40,350 at card_store.rs:168 and 2 at card_store.rs:520, counted by the main agent 2026-10-15; that the :168 ones came from an older binary at boot is per the facts fork).
- Behaviour changes: tokio handler panics become process exits, and the swallowed thread panics at log_reader.rs:268 and spool_tap.rs:384-385 become exits.
- Backoff: a panic more than 5 minutes after start escapes the quick-death window (src/cli/hookHandlers.ts:159 REVIVE_CRASH_WINDOW_MS), so a deterministic late panic restarts with no backoff.
- lib.rs `lock_timed_tests::poisoned_mutex_still_yields_a_usable_guard` stays, because it tests a library property. TRDD-TYJSS45N removes the unreachable recovery code after this card lands.
- Run `pnpm run test:unit` against the rebuilt binary; the TS real-boot suites spawn rust-core/target/release/alcore.

## Acceptance
- [x] TRDD-0BDOV3WC is complete.
- [x] The hook is the first statement in main, and the binary-level test passes; the test fails when the hook is removed.
- [x] exit versus _exit is decided and recorded with its reason.
- [x] cargo clippy and cargo test pass, and `pnpm run test:unit` passes against the rebuilt binary.

## Approval log

- 2026-10-15T01:38:48+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-15T01:39:06+0200 — column → blocked by main-agent@agentlenspro. waits for TRDD-0BDOV3WC (every restart re-runs the reuse path)
- 2026-10-16T00:48:08+0200 — column → todo by main-agent@agentlenspro. blocker TRDD-0BDOV3WC complete (4d5db2dc) Cleared blocked-by (--clear-blocker override).
- 2026-10-16T01:04:18+0200 — column → dev by main-agent@agentlenspro. implementation started (reviewed proposal 2026-10-16)

## Notes and lessons learned

2026-10-15: f9e0742e (TRDD-KMF02UEX) removed the panics on the demote path (the DuckDB .expect calls in demote_cold and its parse/serialize .expect). Panic sites under the state lock that remain on the ingest and restore paths (reports_dev/kmf02uex-facts.md section 2; other lock holders not surveyed): the serialize .expect and the upsert in put_arc (every put), begin/commit in the restore, set_meta in mark_restore_complete, discard_cards, and len() where restore_reused still calls it.
2026-10-16: motivating incident — the live collector stayed a live-looking zombie for over 28 hours after a log-sweeper panic poisoned the state lock (2026-10-14 16:21:56); exit-on-panic would have turned it into a restart. Unblocked: TRDD-0BDOV3WC landed in 4d5db2dc.
2026-10-16: exit vs _exit decided: libc::_exit(1). std::process::exit runs atexit handlers and DuckDB static destructors while other threads may hold DuckDB locks, so it can block, and a blocked exit is the zombie again; _exit cannot. rss_guard keeps exit (separate). The hook arms a 10 s alarm(2) once, on the first panic, to bound a blocked stderr write or backtrace; the supervisor drains stderr continuously (src/cli/serverControl.ts:961), so the alarm is a backstop.
2026-10-16: deviation from the design: the test trigger is a hidden flag --panic-after-ready, not a cargo feature, because agentlens-core has no [features] section and CI runs cargo test --manifest-path rust-core/Cargo.toml --workspace (.github/workflows/ci.yml:299) without features, so a feature-gated test would never run in CI (precedent: --ingest-interval-secs).
2026-10-16: behaviour changes: every tokio task or handler panic now exits the process (tokio catches them today; MEASURE found 0 of 40,352 recorded panics on a tokio thread, all on the log-sweeper); a request-triggered panic now restarts the collector, losing up to 5 s of spans and refusing OTLP during the restart; a deterministic panic more than 5 min after start escapes REVIVE_CRASH_WINDOW_MS (no backoff, the supervisor path backs off 1 s to 30 s); an install with neither hooks nor the supervisor does not restart at all; rusqlite scalar callbacks (forensics_db.rs:239-277) no longer turn a panic into an SQL error (no panic site there today). Request-path unwrap/expect sites, UNCLASSIFIED: ui.rs 1 (line 1192, before its first cfg(test) at line 4394), mcp.rs 1 (line 32), mcp_tools.rs 3 (lines 683, 2313, 3263), lib.rs ingest_post and ingest_parsed 0; full list in docs_dev/20261016-3rvtc1hy-impl-report.md.
2026-10-16: with the hook, the state lock can no longer be observed poisoned in alcore (_exit runs before the unwind), so the poisoned-lock recovery in shutdown::flush_with_deadline (shutdown.rs:35) and Outcome::Poisoned (shutdown.rs:24) are dead in the binary path: TRDD-TYJSS45N scope.
2026-10-16: mutation results: M1 (hook removed) failed at the deadline with 'trigger fired but process did not exit' (run before R1 and R2; neither changes the hook-removed path); M2 (_exit removed) failed on the exit-code assertion, because the hook's alarm backstop killed the process with signal 14 about 10 s later. The test pins 'exits with status 1 through the hook'; it does not distinguish _exit from std::process::exit; that choice rests on the destructor-blocking argument, not on a test. R1 (alarm armed once, by the first panic) verified by reading the code; a panic stream is not reproducible in CI. Gates: clippy clean; exit_on_panic passes intact; cargo test --workspace 988 passed, 0 failed (load 16 at start, 213 at end); release build passed; pnpm run test:unit 3177 passing, 13 pending, 0 failing (load 19 at start). An earlier test:unit run had one failure (ingest end to end, loaded=0) with load 18 at start and 337 at end; the clean rerun passed.
2026-10-16: SIGALRM disposition reset to SIG_DFL at startup, verified by reading (the test cannot tell it apart, _exit fires first). The inherited signal MASK is not reset: the live collector (pid 55408, started by the shipped spawn path) shows a blocked mask of 0 (`ps -o blocked= -p 55408`), so SIGALRM is assumed unblocked; macOS ps cannot show the ignored set.

---
trdd-id: 3RVTC1HY
title: alcore exits on any panic so a steady-state panic cannot leave a live-looking zombie
column: blocked
status: tasked
created: 2026-10-15T01:38:48+0200
updated: 2026-10-15T11:05:29+0200
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
blocked-by: [0BDOV3WC]
eht: [TYJSS45N]
pre-block-column: todo
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
- [ ] TRDD-0BDOV3WC is complete.
- [ ] The hook is the first statement in main, and the binary-level test passes; the test fails when the hook is removed.
- [ ] exit versus _exit is decided and recorded with its reason.
- [ ] cargo clippy and cargo test pass, and `pnpm run test:unit` passes against the rebuilt binary.

## Approval log

- 2026-10-15T01:38:48+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-15T01:39:06+0200 — column → blocked by main-agent@agentlenspro. waits for TRDD-0BDOV3WC (every restart re-runs the reuse path)

## Notes and lessons learned

2026-10-15: f9e0742e (TRDD-KMF02UEX) removed the panics on the demote path (the DuckDB .expect calls in demote_cold and its parse/serialize .expect). Panic sites under the state lock that remain on the ingest and restore paths (reports_dev/kmf02uex-facts.md section 2; other lock holders not surveyed): the serialize .expect and the upsert in put_arc (every put), begin/commit in the restore, set_meta in mark_restore_complete, discard_cards, and len() where restore_reused still calls it.

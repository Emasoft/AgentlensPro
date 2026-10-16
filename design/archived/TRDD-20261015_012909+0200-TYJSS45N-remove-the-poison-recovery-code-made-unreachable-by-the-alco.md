---
trdd-id: TYJSS45N
title: Remove the poison-recovery code made unreachable by the alcore panic hook
column: complete
status: archived
created: 2026-10-15T01:29:09+0200
updated: 2026-10-16T09:17:53+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T01:29:09+0200
blocked-by: []
pre-block-column:
project-id: agentlenspro
blocker-probe:
blocker-holds-if:
implementation-commits: [aa61b49d, 4ebb9196]
---

# Remove the poison-recovery code made unreachable by the alcore panic hook

## Problem
After TRDD-3RVTC1HY (a panic hook in the alcore binary that exits the process), the state mutex can no longer be observed poisoned in production. The poison-recovery code becomes unreachable: the `into_inner()` sites (chores.rs:226/234/249/383 per MEASURE section 5, chores.rs:695/1032/1251 per reports_dev/poison-fix-facts.md, summary_engine.rs:166, shutdown.rs:35, lib.rs:1241, and the poison branch of lock_timed at lib.rs:1386-1392) and the poison-to-error mappings in ui.rs (273/398/427/445/4411/4461/4524). Site list: reports_dev/da0gn1cs-measure.md section 5.

## Acceptance
- [x] Only after TRDD-3RVTC1HY lands: each site is removed or rewritten, and each removal is justified by the hook's guarantee.
- [x] `lib.rs` `lock_timed_tests::poisoned_mutex_still_yields_a_usable_guard` is kept (a library property) or rewritten to state the new contract.

## Approval log

- 2026-10-15T01:29:09+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-15T01:42:14+0200 — column → blocked by main-agent@agentlenspro. follows TRDD-3RVTC1HY
- 2026-10-15T01:50:19+0200 — column → todo by main-agent@agentlenspro. not blocked: it is an EHT of 3RVTC1HY; its body gates the work on 3RVTC1HY landing Cleared blocked-by (--clear-blocker override).
- 2026-10-15T03:22:06+0200 — column → backburner by main-agent@agentlenspro. pull when TRDD-3RVTC1HY reaches testing: until the panic hook lands the poison-recovery code is still reachable, and a todo card would be drained early
- 2026-10-16T06:41:49+0200 — column → dev by main-agent@agentlenspro. pulled: 3RVTC1HY in testing (542ceca2); reviewed proposal 2026-10-16
- 2026-10-16T09:17:53+0200 — COMPLETE by main-agent@agentlenspro. both commits landed (aa61b49d, 4ebb9196), gates green except the baseline watcher flake, reviews done.

## Notes and lessons learned

2026-10-15: parked in backburner, not todo: it is an EHT of 3RVTC1HY, and a blocked-by on 3RVTC1HY would make a cycle with that EHT. Pull it when 3RVTC1HY reaches testing.
2026-10-16: scope corrected (reports_dev/tyjss45n-facts.md): the listed chores.rs 226/234/249/383, ui.rs 273/398/427/445, summary_engine.rs 166 and spool_tap.rs sites are NOT on the CoreState lock; the CoreState sites are the lock_timed() call lines (measured at HEAD: 152 lines contain lock_timed() across src and tests, comments and the trait line included; 91 of them in ui.rs are the state poisoned map_err). The 15 non-CoreState sites stay out of scope: ui.rs 351-357 records rebuild_gate poisoning as deliberately not fatal (a decision, recorded here).
2026-10-16: decision (main agent, under the owner standing order of 2026-10-05 recorded on TRDD-AVUGZV1K): lock_timed becomes infallible (returns StateGuard, panics with CoreState lock poisoned); this changes the library contract that T6 and the lib unit test pinned. Both become negative tests. T6 used to assert the silent ingest stall as correct.
2026-10-16: the premise is guarded by tests/exit_on_panic.rs only for a panic hook replaced before readiness on the --no-log-scan startup path; a dependency that called set_hook lazily later would not be caught (no runtime API reports the installed hook).
2026-10-16: only two direct CoreState acquisitions exist outside the lock_timed impl in production (shutdown.rs try_lock and the lib.rs impl internals), both handled, so the type change enumerates every other site (reports_dev/tyjss45n-proposal-measure.md step 8).
2026-10-16: mutations and gates: M1 (poison recovered silently, guard returned) -> lib poisoned_mutex_panics_in_lock_timed FAILED (should panic, did not) and card_reuse ingest_chunk_on_a_poisoned_lock_panics_and_appends_nothing FAILED at card_reuse.rs:462 (expect_err: a poisoned state lock must make ingest_chunk panic, not skip); M2 (panic message changed to CoreState mutex poisoned) -> lib poisoned_mutex_panics_in_lock_timed FAILED (note: panic did not contain expected string). Both reverted; lib test passes again. clippy --workspace --all-targets -D warnings: exit 0. Tests: lib 121 passed; card_reuse 17 passed; lock_holder_site 1 passed; exit_on_panic 1 passed; cargo test --workspace 991 passed, 0 failed; release alcore build exit 0; pnpm test:unit 3177 passing, 13 pending, exit 0. 1-minute load 12.4 at workspace end and 19.5 at unit end (start-of-run load not recorded).
2026-10-16: count correction: 152 is the number of lines containing lock_timed() across src and tests (comments, the trait line and test sites included); 136 is the number of production CoreState sites by category in reports_dev/tyjss45n-facts.md. Both stand, they count different things.
2026-10-16: box 1 is met for the scope-corrected CoreState list (see the scope note); the 15 non-CoreState sites are out of scope by decision. Guard-scope audit: reports_dev/tyjss45n-guard-audit.md, 44 functions SAFE, 0 risk.
2026-10-16: commit 2: the five functions that could no longer fail (summary_now, stripped_now, burn_status_now, burn_status_seed, sse_response) return their value directly; gates: clippy --workspace --all-targets -D warnings exit 0; cargo test -p agentlens-core stopped at the first failing binary (81 binaries reached): tests/log_reader_parity.rs watcher_advances_a_card_on_growth_without_waiting_for_the_backstop failed (left 3, right 4 at line 510); cargo test --workspace --no-fail-fast: 990 passed, 1 failed (the same test); 1-minute load 13.85 at the start of the crate run and 19.58 at the end of the workspace run. That test is flaky and not caused by commit 2: isolated runs failed 2 of 6 at aa61b49d (commit 1, 1-minute load 12.0 to 12.6) and 4 of 10 on the current tree (1-minute load 12.6 to 29.2). Correction to aa61b49d's message: lock_timed returns StateGuard<'_> (the shell dropped the apostrophe, so the message reads StateGuard<_>); the 136 CoreState sites are A92 + B25 + E3 + C6 + D7 plus shutdown, the lock_timed body and the trait line (reports_dev/tyjss45n-facts.md:38).
2026-10-16: review of 4ebb9196. (1) Its message says push_update's let-else was the last silent skip of this shape; wrong: the same commit also removes run_burn_tick's let-else, and no codebase-wide search backs 'the last'. (2) VERIFIED: the five changed functions are called only from ui.rs and log_reader.rs references none of them, so the watcher test (it calls only log_reader::start_sweeper) cannot reach them. (3) composition_for keeps a real error source (the join map_err) and compositions_in_scope propagates it, so both Result types stay. (4) The line-510 watcher failure predates this card (4/20 on 542ceca2^, 4/20 on 4ebb9196; TRDD-WBYDQH8K) and does not block it.
2026-10-16: close-out (docs_dev/20261016-tyjss45n-closeout-report.md): release build exit 0; pnpm run test:unit 3177 passing, 13 pending, 0 failing; clippy -W clippy::unnecessary_wraps finds no hit in the touched files. Both commits reviewed; the dispositions are in the 4ebb9196 note above. The only red gate was the baseline watcher signature (TRDD-WBYDQH8K).

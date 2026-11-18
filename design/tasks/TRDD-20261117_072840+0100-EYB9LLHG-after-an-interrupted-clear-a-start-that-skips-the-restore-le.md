---
trdd-id: EYB9LLHG
title: After an interrupted clear a start that skips the restore leaves the store refused at every start
column: backburner
status: tasked
created: 2026-11-17T07:28:40+0100
updated: 2026-11-17T17:09:31+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T07:28:40+0100
---

# After an interrupted clear a start that skips the restore leaves the store refused at every start

Read in commit e9782faf (TRDD-JDQR0HDT), not run: after an interrupted /api/clear the rebuilt card store is written with clear_in_progress = 1, and the only code that clears it on that path is restore_from_snapshot (log_reader.rs, after the two tombstones). If a start does not run that restore (for example a start with the log scan off), the flag stays 1, so the next start refuses the store again and rebuilds it empty, at every start, until a start with the restore runs. Whether such a start exists in production paths was not read.

## Acceptance

- [x] It is established by reading, with file:line, which start modes skip DurableState::restore.
- [ ] A test starts such a mode after an interrupted clear and shows what the store holds at the following start.
- [ ] If the store is refused forever in that mode, the flag is cleared on that path too, with a test that fails without the change.

## Notes and lessons learned
2026-11-17T08:07+0100 main agent, BOX 1 by reading (grep of the core crate sources, then the lines): DurableState::restore has ONE caller, start_sweeper (log_reader.rs:1620); start_sweeper has ONE caller, alcore.rs:418, inside `if log_scan` (alcore.rs:410); log_scan is true unless the argument --no-log-scan is given (alcore.rs:126, :145). So the only start mode that skips the restore is --no-log-scan. Who passes it, by grep over src, standalone/cli.ts, scripts and rust-core/crates: test files (floodBenchRate.test.ts, alcoreCutover.test.ts, five Rust integration tests) and one bench script (scripts/bench/alcore_core_utilization.py:142); no production TypeScript file. The header comment of alcore.rs says this mode keeps the window empty. Reading of the main agent: the case on this card needs a hand-started or test-started server with --no-log-scan on a data folder whose last clear was interrupted; a production start through the CLI does not reach it. Low priority; boxes 2 and 3 stay open. Not read: whether a start with log scan on can return from start_sweeper before restore (an error path). 
2026-11-17T17:09+0100 main agent, LIMITS CARRIED FROM TRDD-JDQR0HDT (archived complete at 17:07 today, frozen; these could not be added there). (1) Its 'second window' (the sweeper's finish_clear before the card save) is called closed by commit eef01b1d on the strength of ONE unit test, a_reused_start_brings_the_card_log_level_with_the_store_at_the_first_timed_tick: the test puts a 'ghost' key in the card-log files that the store lacks and asserts it is tombstoned after the first timed tick. It does NOT go through clear_all, finish_clear and a death; the real clear path for this direction is unexercised, by a unit test or by a server run. (2) That test's pass result (lib log_reader 9 passed) is from the worker's worktree run; on the committed files only the lib delta_log tests were rerun. The full crate suite is owed at the pre-push run; a failure found there needs a new card. (3) JDQR0HDT went from ai_review through human_review to complete in two commands by the main agent, with no advisor call and no separate review in those columns; the harness never reviewed the worker's last turn on e9782faf. (4) A start that dies before its first timed tick (about 60 s) leaves the window open until a later start lives that long.

## Approval log

- 2026-11-17T07:28:40+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

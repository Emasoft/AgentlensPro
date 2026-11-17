---
trdd-id: 32UTVFP0
title: Three log_reader_parity tests fail, suspected date gate on a fixture
column: backburner
status: tasked
created: 2026-11-17T07:25:52+0100
updated: 2026-11-17T07:25:52+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T07:25:52+0100
---

# Three log_reader_parity tests fail, suspected date gate on a fixture

Seen 2026-11-17 in the checks of TRDD-JDQR0HDT (reports_dev/JDQR0HDT/G-log_reader_parity.txt, read by the main agent: 'test result: FAILED. 24 passed; 3 failed', exit 101). Failing tests of rust-core/crates/agentlens-core/tests/log_reader_parity.rs: restore_backfill_fills_the_correct_deduplicated_value_and_touches_nothing_else, run_1h_backfill_step_persists_before_returning_so_a_hard_exit_loses_nothing, run_1h_backfill_step_does_not_scan_the_whole_card_store. BY THE WORKER'S REPORT, not confirmed: the log says 'flagged 0 transcript(s) ... (1 skipped, older than 30 days)' (the phrase occurs 6 times in the output, counted by the main agent); queue_1h_candidate skips a transcript whose modification time is older than REPARSE_MAX_AGE (30 days), and the fixture transcript is dated 2026-09-25, 53 days before the run. If so the tests have failed since about 2026-10-25 whatever the code. Not done: a run of the same tests on a tree without the JDQR0HDT change (the worker ran no git), so that change is not excluded as the cause by measurement.

## Acceptance

- [ ] The three tests are run on a tree without commit e9782faf (a worktree at its parent) and the result is recorded: same three failures, or not.
- [ ] The cause is recorded with file:line (the age gate and where the fixture gets its date).
- [ ] The tests no longer depend on the calendar date (the fixture's time is set by the test, or the gate takes an injected clock), and pass.

## Notes and lessons learned

## Approval log

- 2026-11-17T07:25:52+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

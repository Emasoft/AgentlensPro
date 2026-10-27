---
trdd-id: AMSCZHF5
title: Three log_reader_parity backfill tests fail on HEAD
column: todo
status: tasked
created: 2026-10-27T14:41:26+0100
updated: 2026-10-27T14:41:26+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-27T14:41:26+0100
---

# Three log_reader_parity backfill tests fail on HEAD

The 3 tests in rust-core/crates/agentlens-core/tests/log_reader_parity.rs are the same 3 tests that fail on HEAD 3398d30f without the item-1 change (found while working TRDD-735Q3JF4) (baseline run 2026-10-27, 18 passed and 3 failed). The failing tests are restore_backfill_fills_the_correct_deduplicated_value_and_touches_nothing_else (panics at :827:59), run_1h_backfill_step_persists_before_returning_so_a_hard_exit_loses_nothing (:1124:5), and run_1h_backfill_step_does_not_scan_the_whole_card_store (:1199:51). The run log shows "1 skipped, older than 30 days", and the fixtures are dated 2026-08-01. The literal 'older than 30' was not found under rust-core/crates/*/src (it may be a format string, or come from tests/), and the fixtures were already more than 30 days old when the test file last changed (2026-10-16), so the date explanation is unverified. Next: read the three panic sites and find the cause.

## Approval log

- 2026-10-27T14:41:26+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

---
trdd-id: WBYDQH8K
title: The watcher parity test fails about one run in five on an unmodified tree
column: todo
status: tasked
created: 2026-10-16T09:05:54+0200
updated: 2026-10-16T09:05:54+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-16T09:05:54+0200
---

# The watcher parity test fails about one run in five on an unmodified tree

log_reader_parity::watcher_advances_a_card_on_growth_without_waiting_for_the_backstop (rust-core/crates/agentlens-core/tests/log_reader_parity.rs) fails intermittently on unmodified trees with three signatures: line 510 'the watcher + targeted sweep advanced the card' (left 3, right 4), line 538 'the post-clear sweep was FULL', and 'card never refilled within 10 s after clear_all' (TRDD-9VX3WTGU 2026-10-02). Line 510 measured 4/20 on 542ceca2^ and 4/20 on 4ebb9196, interleaved at matched 1-minute load 11.9 to 18.9 (reports_dev/20261016-watcher510-baseline.md). It turns test gates red about one run in five, which trains reviewers to ignore red gates. Next action: find why the debounced targeted sweep sometimes misses the growth within the wait; fix the cause, not by lengthening the timeout.

## Approval log

- 2026-10-16T09:05:54+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

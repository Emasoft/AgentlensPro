---
trdd-id: WBYDQH8K
title: The watcher parity test fails about one run in five on an unmodified tree
column: todo
status: tasked
created: 2026-10-16T09:05:54+0200
updated: 2026-10-16T09:21:29+0200
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
project-id: agentlenspro
---

# The watcher parity test fails about one run in five on an unmodified tree

log_reader_parity::watcher_advances_a_card_on_growth_without_waiting_for_the_backstop (rust-core/crates/agentlens-core/tests/log_reader_parity.rs) fails intermittently on unmodified trees with three signatures: line 510 'the watcher + targeted sweep advanced the card' (left 3, right 4), line 538 'the post-clear sweep was FULL', and a third that TRDD-9VX3WTGU recorded on 2026-10-02 as 'card never refilled within 10 s after clear_all' (paraphrased there; that text is not in the test file). Line 510 measured 4/20 on 542ceca2^ and 4/20 on 4ebb9196, interleaved at matched 1-minute load 11.9 to 18.9 (reports_dev/20261016-watcher510-baseline.md). It turns test gates red about one run in five, which trains reviewers to ignore red gates. Next action: find why the debounced targeted sweep sometimes misses the growth within the wait; fix the cause, not by lengthening the timeout.

## Approval log

- 2026-10-16T09:05:54+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Acceptance

- [ ] The cause of each failure signature is named, with evidence.
- [ ] The cause is fixed in code, not by lengthening a timeout.
- [ ] 0 failures in 40 interleaved isolated runs at 1-minute load 12 or higher.

## Notes and lessons learned

2026-10-16: 'baseline' means predates 542ceca2 (this session's commits) only. Whether line 510 existed on 2026-10-02, when TRDD-9VX3WTGU ruled that a new signature blocks, is unknown: 24 commits touching log_reader.rs, card_store.rs, lib.rs or the test landed between 2026-10-02 and 542ceca2. First step: bisect that range with the interleaved driver described in reports_dev/20261016-watcher510-baseline.md.

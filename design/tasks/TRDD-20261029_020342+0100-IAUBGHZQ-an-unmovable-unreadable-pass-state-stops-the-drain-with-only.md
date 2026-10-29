---
trdd-id: IAUBGHZQ
title: an unmovable unreadable pass state stops the drain with only one log line
column: todo
status: tasked
created: 2026-10-29T02:03:42+0100
updated: 2026-10-29T02:04:43+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-29T02:03:42+0100
priority: medium
---

# an unmovable unreadable pass state stops the drain with only one log line

Found by the review of 805eea34. TRDD-FINMFYDE: when .pass-state.json cannot be read AND cannot be renamed aside, alcore bodies_pass skips every tick, counting it only in the static STATE_LOAD_FAILS (rust-core/crates/agentlens-core/src/chores.rs) and logging once. No save runs, so TRDD-5K0YLLEF's stateSaveFails does not see it. Direction: expose the consecutive skipped-tick count and the last time in /api/server-stats bodies, same pattern as stateSaveFails/lastStateSaveFailAt (state_save_failures getter, frozen key-order test). Acceptance: see the checklist below.

## Approval log

- 2026-10-29T02:03:42+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Acceptance criteria

- [ ] /api/server-stats reports the consecutive skipped-tick count and the last time (test forcing a read failure plus a failed rename through bodies_pass).
- [ ] the test fails when the count is not exposed (mutation-checked).

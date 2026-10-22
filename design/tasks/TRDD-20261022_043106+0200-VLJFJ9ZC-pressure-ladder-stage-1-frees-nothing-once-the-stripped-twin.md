---
trdd-id: VLJFJ9ZC
title: Pressure ladder stage 1 frees nothing once the stripped twin is gone
column: blocked
status: tasked
created: 2026-10-22T04:31:06+0200
updated: 2026-10-22T04:31:30+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: refactor
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-22T04:31:06+0200
blocked-by: [091Z1FU0]
pre-block-column: todo
---

# Pressure ladder stage 1 frees nothing once the stripped twin is gone

rust-core/crates/agentlens-core/src/lib.rs:833-835: pressure-ladder stage 1 only clears stripped_cache. TRDD-091Z1FU0 removes the stripped twin, which leaves stage 1 inert, and the first stage that frees memory becomes stage 2. Decide: renumber the ladder (delete stage 1 and adjust thresholds and tests), or give stage 1 a measured target. Blocked by TRDD-091Z1FU0. Evidence: docs_dev/20261022-b2-measure.md item 5; adversarial review of the 091Z1FU0 proposal, 2026-10-22.

## Approval log

- 2026-10-22T04:31:06+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-22T04:31:30+0200 — column → blocked by main-agent@agentlenspro. waits on 091Z1FU0

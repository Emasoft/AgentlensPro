---
trdd-id: LDWBRV9B
title: agentlenspro server status does not show failed pass-state saves
column: todo
status: tasked
created: 2026-10-29T02:03:41+0100
updated: 2026-10-29T02:04:42+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-29T02:03:41+0100
priority: medium
---

# agentlenspro server status does not show failed pass-state saves

Found by the review of 805eea34 (TRDD-5K0YLLEF). /api/server-stats now reports bodies.stateSaveFails and bodies.lastStateSaveFailAt, but neither agentlenspro server status nor the dashboard prints them, so a full disk is visible only to someone querying the API. Direction: in src/cli/serverControl.ts, next to the capture-down line (bodiesCaptureLine), print one line when stateSaveFails > 0 (count and last failure time); absent field = older server, print nothing. Acceptance: see the checklist below.

## Approval log

- 2026-10-29T02:03:41+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Acceptance criteria

- [ ] server status prints a line when stateSaveFails > 0 (test).
- [ ] nothing is printed when stateSaveFails is 0 or absent (test).

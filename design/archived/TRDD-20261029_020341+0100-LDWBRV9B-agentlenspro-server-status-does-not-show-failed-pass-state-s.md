---
trdd-id: LDWBRV9B
title: agentlenspro server status does not show failed pass-state saves
column: complete
status: archived
created: 2026-10-29T02:03:41+0100
updated: 2026-10-29T02:16:54+0100
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
implementation-commits: [586c565b, da346542]
---

# agentlenspro server status does not show failed pass-state saves

Found by the review of 805eea34 (TRDD-5K0YLLEF). /api/server-stats now reports bodies.stateSaveFails and bodies.lastStateSaveFailAt, but neither agentlenspro server status nor the dashboard prints them, so a full disk is visible only to someone querying the API. Direction: in src/cli/serverControl.ts, next to the capture-down line (bodiesCaptureLine), print one line when stateSaveFails > 0 (count and last failure time); absent field = older server, print nothing. Acceptance: see the checklist below.

## Approval log

- 2026-10-29T02:03:41+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-29T02:16:54+0100 — COMPLETE by main-agent@agentlenspro. helper tested, wiring read; review of 586c565b no blockers.

## Acceptance criteria

- [x] server status prints a line when stateSaveFails > 0 (test).
- [x] nothing is printed when stateSaveFails is 0 or absent (test).

## Evidence

Item 1: commits 586c565b and da346542; stateSaveFailLine (src/cli/serverControl.ts) is wired into showStatus under the capture line. The helper is tested (src/test/bodiesCaptureLine.test.ts, count prints a line with count and age; the helper-always-null mutation fails it); the showStatus wiring itself was only read, not tested.
Item 2: tests for zero (null) and absent fields (null), plus count with 0 or absent timestamp (prints 'last failure time not reported'; mutation caught, docs_dev/ld2-*). Review of 586c565b: no blockers; s.bodies is already dereferenced unguarded at serverControl.ts:859, so no new crash path; minutes-only age kept consistent with line 861. Not run against a live server.

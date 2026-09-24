---
trdd-id: 8YM21R5X
title: A buried role marker in a spawned agent's own brief still self-exempts it from its SubagentStop gate
column: backburner
created: 2026-09-24T09:10:39+0200
updated: 2026-09-24T09:24:14+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: security
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-24T09:10:39+0200
related-trdd: BA0DCW98
---

# A buried role marker in a spawned agent's own brief still self-exempts it from its SubagentStop gate

## Approval log

- 2026-09-24T09:10:39+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Defect

declaredRoleOwnTranscript in src/cli/reviewGate.ts is unanchored by design because the harness may prepend boilerplate to the spawned agent's first transcript entry; anchoring it without knowing that shape would deadlock every real review fork.

## NEXT ACTION

Measure the real wrapped shape of a MEASURE/REVIEW agent's own first transcript entry, then anchor declaredRoleOwnTranscript accordingly.

## Notes

2026-09-24: a fork's own first entry arrives as '...</fork-boilerplate>' then 'Your directive: ROLE: REVIEW' on one line (seen by a review fork 2026-09-24, inferred), so the unanchored regex does not even match a fork; forks are exempted by the separate review-fork rule; the residual concerns non-fork subagents such as lean-worker -- measure one real lean-worker transcript's first entry.

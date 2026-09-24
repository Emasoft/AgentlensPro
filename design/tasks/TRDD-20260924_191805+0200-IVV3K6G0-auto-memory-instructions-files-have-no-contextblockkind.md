---
trdd-id: IVV3K6G0
title: Auto-memory instructions files have no ContextBlockKind
column: backburner
status: tasked
created: 2026-09-24T19:18:05+0200
updated: 2026-09-24T19:18:05+0200
current-owner: emanuelesabetta
created-by: emanuelesabetta
task-type: feature
min-approval-requirement: none
assignee: emanuelesabetta
mandate: true
mandated-by: none
approved: true
approval-judge: emanuelesabetta
approval-datetime: 2026-09-24T19:18:05+0200
---

# Auto-memory instructions files have no ContextBlockKind

Auto-memory / instructions files injected at session start have no dedicated ContextBlockKind in the context classifier, so they are misclassified or invisible in ctxmap/ctxvis breakdowns instead of appearing as their own attributable block. Add a dedicated kind for them alongside the existing CLAUDE.md/skill/hook kinds.

## Approval log

- 2026-09-24T19:18:05+0200 — MANDATE issued by emanuelesabetta (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

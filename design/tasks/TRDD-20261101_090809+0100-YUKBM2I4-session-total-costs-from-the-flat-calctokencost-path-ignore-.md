---
trdd-id: YUKBM2I4
title: Session-total costs from the flat calcTokenCost path ignore prompt-length tiers
column: backburner
status: tasked
created: 2026-11-01T09:08:09+0100
updated: 2026-11-01T09:08:09+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-01T09:08:09+0100
---

# Session-total costs from the flat calcTokenCost path ignore prompt-length tiers

calcTokenCost in src/shared/pricing.ts prices session totals at flat rates; it is used by media/src/sessionMetrics.ts and media/src/tabs/HistoryTab.tsx. It cannot apply a per-call tier, so Haiku 5.5 calls over 100,000 input tokens read up to 5x low there (and historical sonnet-4 calls over 200,000 read low too). Per-call costs from calcTokenCostUsd are exact. Fix direction is open: sum per-call costs where per-call data exists. Found by the TRDD-KQ549VCQ review on 2026-11-01.

## Approval log

- 2026-11-01T09:08:09+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

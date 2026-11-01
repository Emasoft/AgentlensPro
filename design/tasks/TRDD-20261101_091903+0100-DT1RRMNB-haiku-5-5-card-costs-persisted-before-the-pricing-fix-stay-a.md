---
trdd-id: DT1RRMNB
title: Haiku 5.5 card costs persisted before the pricing fix stay at zero
column: backburner
status: tasked
created: 2026-11-01T09:19:03+0100
updated: 2026-11-01T09:19:03+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-01T09:19:03+0100
---

# Haiku 5.5 card costs persisted before the pricing fix stay at zero

Before f1b252d4, claude-haiku-5-5 calls priced at $0 (no RATES row). Card costs already persisted in the store keep that $0; nothing re-parses or backfills them, so cross-session totals under-report Haiku 5.5 subagent work done before the fix. Fix direction open: re-parse flagged cards, as the 1h-tier backfill did, or recompute at read time. Found by the TRDD-KQ549VCQ review on 2026-11-01.

## Approval log

- 2026-11-01T09:19:03+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

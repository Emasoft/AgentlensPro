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

## Caveats (2026-11-01 review)

The boundary is the deploy of a rebuilt alcore, not commit f1b252d4: until the running server is rebuilt, re-signed and restarted, every Haiku 5.5 call still prices at zero. The premise is unverified: nobody has checked whether alcore stores a cost per card or recomputes it from token counts at read time, whether a re-parse or the step 2 schema migration re-derives cards, or whether pre-fix calls were stored as $0 or as unpriced. Check those three before designing a fix; if costs are recomputed at read time, this card closes as not-a-bug.

## Approval log

- 2026-11-01T09:19:03+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

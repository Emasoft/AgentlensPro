---
trdd-id: 53Y38MXJ
title: Option C watermark of read positions per full card save kept as an optional refusal cost optimization
column: backburner
status: tasked
created: 2026-10-15T05:18:00+0200
updated: 2026-10-15T05:25:34+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: feature
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T05:18:00+0200
---

# Option C watermark of read positions per full card save kept as an optional refusal cost optimization

## What option C is
At each FULL card save, persist the read positions (log offsets) exported at that moment as a watermark; on a refused reuse of cards.duckdb, import that watermark set instead of the current offsets, so files changed since the last full card save are re-read and their cards rebuilt.

## Why it was set aside on 2026-10-15
Decided in review round 1 plus the advisor, while planning TRDD-6B7VV2Z7:
- Until TRDD-6B7VV2Z7's per-chunk progress lands, C shares the no-progress mechanism (verified by main) at a smaller scale, because the card snapshot lags by days (TRDD-WCG7I5D8); whether a cap death lands inside its re-read is unmeasured.
- It adds a second offsets log, clear-race and version-stamp special cases, a first-start fallback, seeding, and new boot-fatal load errors.
- All of that is for an event that becomes rare IF the owner accepts TRDD-0BDOV3WC decision (a) (stop instead of delete on an out-of-memory boot read); until then 8 of the last 10 refusals were out-of-memory errors.

## When to revisit
Only if refused reuses stay frequent after TRDD-0BDOV3WC and TRDD-6B7VV2Z7 land, measured. Do not revive it standalone.

Local evidence (gitignored): reports_dev/6b7vv2z7-facts.md, reports_dev/6b7vv2z7-optionC-measure.md.

## Approval log

- 2026-10-15T05:18:00+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

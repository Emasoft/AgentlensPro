---
trdd-id: DYKJUYX3
title: The span window prune is skipped silently when the state lock is busy
column: todo
status: tasked
created: 2026-10-05T02:34:27+0200
updated: 2026-10-05T03:18:11+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-05T02:34:27+0200
---

# The span window prune is skipped silently when the state lock is busy

Follow-up of TRDD-YILE6N3T (completed 2026-10-05). The chore that prunes the span window runs only when it can take the state lock in time and otherwise skips the pass without a log line or a counter (chores.rs, per the 2026-10-05 review; not read by the main agent). YILE6N3T listed this as a candidate cause of the window never shrinking and it was never ruled out by a test, only by the live result of 2026-09-06. Other cards have since measured multi-second holds of that lock (TRDD-QE114936, TRDD-MVR6PXC0). Done when a skipped prune is counted and visible in /api/server-stats or the log, and a test holds the lock, lets the tick fire, and asserts the skip is recorded and the next free tick prunes.

## Approval log

- 2026-10-05T02:34:27+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Correction 2026-10-05

- The multi-second holds of the state lock cited in the body were measured on 2026-09-05 (cards QE114936 and MVR6PXC0), and the QE114936 fix removed most of them; they are not a current measurement.
- The clause "and the QE114936 fix removed most of them" in the correction above was not re-verified after the session was cleared and its source was not re-read; treat it as unverified. What stands is that the cited holds were measured on 2026-09-05 and are not a current measurement.

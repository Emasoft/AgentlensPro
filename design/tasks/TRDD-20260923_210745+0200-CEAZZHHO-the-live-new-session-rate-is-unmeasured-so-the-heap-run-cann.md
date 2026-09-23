---
trdd-id: CEAZZHHO
title: The live new-session rate is unmeasured so the heap run cannot calibrate session churn
column: todo
created: 2026-09-23T21:07:45+0200
updated: 2026-09-23T21:07:45+0200
current-owner: main-session
created-by: main-session
task-type: spike
min-approval-requirement: none
assignee: main-session
mandate: true
mandated-by: none
approved: true
approval-judge: main-session
approval-datetime: 2026-09-23T21:07:45+0200
---

# The live new-session rate is unmeasured so the heap run cannot calibrate session churn

TRDD-EQCGAVGV's arms use --new-session-every to reproduce session churn (a per-session leak cannot show with a fixed id set), but the live rate is unknown: the statusline WAL holds only the current process's samples (13 min at the last measurement, 4 main + 3 subagent ids), and the sealed day's parquet parts were not read.

Measure distinct new session ids per hour over at least 24 h from a source that spans process restarts (the sealed statusline parts via DuckDB, or the collector's session cards), counting ids only, never content.

Acceptance: [ ] new sessions/hour with the time span and source stated; [ ] the derived --new-session-every value recorded on EQCGAVGV. related: [EQCGAVGV].

## Approval log

- 2026-09-23T21:07:45+0200 — MANDATE issued by main-session (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

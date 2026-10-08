---
trdd-id: CEAZZHHO
title: The live new-session rate is unmeasured so the heap run cannot calibrate session churn
column: ai_review
created: 2026-09-23T21:07:45+0200
updated: 2026-10-08T18:37:25+0200
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
status: tasked
---

# The live new-session rate is unmeasured so the heap run cannot calibrate session churn

TRDD-EQCGAVGV's arms use --new-session-every to reproduce session churn (a per-session leak cannot show with a fixed id set), but the live rate is unknown: the statusline WAL holds only the current process's samples (13 min at the last measurement, 4 main + 3 subagent ids), and the sealed day's parquet parts were not read.

Measure distinct new session ids per hour over at least 24 h from a source that spans process restarts (the sealed statusline parts via DuckDB, or the collector's session cards), counting ids only, never content.

Acceptance: [x] new sessions/hour with the time span and source stated (1.67/h steady Oct 7 full day; 16/h peak burst; 2.64/h active-hour; 0.65/h whole span; source = sealed statusline parts 2026-09-11..10-08, 664.8 h, ids only); [x] the derived --new-session-every value recorded on EQCGAVGV (225 s for peak-rate churn, 2100 s steady — see its calibration line). related: [EQCGAVGV].

## Approval log

- 2026-09-23T21:07:45+0200 — MANDATE issued by main-session (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-08T18:33:49+0200 — column → dev by main-agent@agentlenspro.
- 2026-10-08T18:37:13+0200 — column → ai_review by main-agent@agentlenspro.
- 2026-10-08T18:37:25+0200 — column → ai_review by main-agent@agentlenspro.

## Measured (2026-10-08)

Source: sealed statusline parquet parts (~/.agentlens/statusline/main/*/part-*.parquet, 1204 files spanning 2026-09-11 00:25 .. 2026-10-08 17:13 = 664.8 h) — a source that spans process restarts, per the card's requirement. Ids only: ts + session_id read per part, first-seen timestamp per distinct id, never content. RESULTS: 435 distinct ids; steady 1.67 new sessions/h (Oct 7 full day: 40 ids/24 h); peak burst hour 16/h (2026-10-06 15:00); active-hour mean 2.64/h (Oct 6-8, 36 hours with >=1); whole-span 0.65/h. Days with no sealed parts: 2026-09-12..09-22 and 2026-10-04. DERIVED AND RECORDED ON EQCGAVGV: --new-session-every 225 s (= 16/h, one live peak hour per 1-h arm — the heap-run arms run minutes-to-hours so peak-rate churn is the sizing case; a steady-rate arm would use 2100 s). Both acceptance boxes ticked. Report: reports/ceazzhho/20261008_184700+0200-new-session-rate.md.

---
trdd-id: V79W9T2R
title: The bodiesMaxGb over-cap valve has no test of its own
column: backburner
status: tasked
created: 2026-10-03T02:48:33+0200
updated: 2026-10-04T13:47:43+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-03T02:48:33+0200
---

# The bodiesMaxGb over-cap valve has no test of its own

chores.rs bodies_pass ingests live bodies at age 0 when the live otel-bodies dir exceeds bodiesMaxGb (retention_config.rs:23, default 8 GB) and deletes them; chores_bodies_spool_drain.rs covers only the 10 s age drain, so disabling the valve fails no test.

## Done when
1. A test fills a temp bodies dir past a small cap and asserts the pass drains it, and fails if the cap branch is removed.

Related: TRDD-Y1M56VMY.

## Approval log

- 2026-10-03T02:48:33+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-04T13:47:20+0200 — worker wJ: valve still at HEAD (chores.rs bodies_pass over_cap). Added test over_cap_valve_drains_a_body_younger_than_the_age_cutoff in tests/chores_bodies_spool_drain.rs (config.json bodiesMaxGb 0.5, the knob floor, plus an unreadable sparse 513 MiB file). Mutation over_cap=false: test FAILED (exit 101); restored, 2 passed.

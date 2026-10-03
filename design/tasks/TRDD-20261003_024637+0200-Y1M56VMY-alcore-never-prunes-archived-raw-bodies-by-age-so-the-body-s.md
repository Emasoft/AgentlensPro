---
trdd-id: Y1M56VMY
title: alcore never prunes archived raw bodies by age so the body store grows without bound now that capture is mandatory
column: todo
status: tasked
created: 2026-10-03T02:46:37+0200
updated: 2026-10-03T02:46:37+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-03T02:46:37+0200
---

# alcore never prunes archived raw bodies by age so the body store grows without bound now that capture is mandatory

## Problem
Owner order 2026-10-02: raw body dumps are MANDATORY (reverses TRDD-BKF5NZD3; TS side b867797a, Rust side in flight under TRDD-9VX3WTGU). With capture always on, the only bound on body data is `bodiesMaxGb` (default 8 GB, rust-core/crates/agentlens-core/src/retention_config.rs:23), and it bounds only the LIVE otel-bodies dir: over the cap, chores.rs bodies_pass ingests at age 0 into the store and deletes the live files. Nothing prunes the store itself.
`bodiesRetentionDays` (default 31, retention_config.rs:24) has NO Rust consumer: grep for BODIES_RETENTION_DAYS finds only its definition and its entry in the knob table (retention_config.rs:31). The TS side reads it (src/retentionConfig.ts) but the TS server is retired (567fc5c2). So the configured 31-day body retention is advertised and not enforced.
Comparable enforced knobs to copy the shape from: spans `run_retention` (agentlens-spanstore/src/writer.rs:578, whole expired segments only, floor of 1 day) and hook events `purge_buckets` (hook_events.rs:59).
## Also missing
The over-cap valve (bodiesMaxGb) has no dedicated test; chores_bodies_spool_drain.rs covers only the 10 s age drain.
## Done when
1. alcore deletes stored body data older than bodiesRetentionDays (whole units only, never a partial one, floor 1 day), on the chores tick.
2. A test fails if the age prune is disabled; a test fails if the bodiesMaxGb valve is disabled.
3. Related: TRDD-7NHUU6GK (archive retention gate keeps a volume holding a re-emitted body) - check whether it is the same mechanism before implementing.

## Approval log

- 2026-10-03T02:46:37+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

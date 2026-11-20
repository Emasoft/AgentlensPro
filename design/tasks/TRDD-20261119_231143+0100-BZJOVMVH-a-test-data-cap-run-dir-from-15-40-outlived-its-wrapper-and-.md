---
trdd-id: BZJOVMVH
title: A test-data-cap run dir from 15 40 outlived its wrapper and holds an alcore spool
column: todo
status: tasked
created: 2026-11-19T23:11:43+0100
updated: 2026-11-19T23:38:27+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-19T23:11:43+0100
---

# A test-data-cap run dir from 15 40 outlived its wrapper and holds an alcore spool

Found 2026-11-19T23:11+0100: tests_dev/tmp/run-20261119_154017-42981 (20716 KB, one alspool dir with 34 entries) exists; its wrapper pid 42981 is not running. scripts/test-data-cap.sh removes RUN_DIR in its EXIT trap, so either the wrapper was SIGKILLed or the trap failed. Cause NOT established. Next: find which command ran at 15:40 (session transcript, agentlenspro search 'run-20261119_154017'), decide whether an alcore spool inside a cap dir means a test daemon escaped the group kill, and add a start-of-run sweep for dead-owner run dirs (the Gap 1 spec item 6 covers images only).

## Approval log

- 2026-11-19T23:11:43+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Findings

2026-11-19T23:38+0100: the alspool entries (s01, s02-*, s02-spool, s08-false, s19) are fixture names of rust-core/crates/agentlens-spool/tests/spool.rs, so the run was a cargo test of agentlens-spool (the gate's g5 workspace run). Trace (reports_dev/BZJOVMVH/20261119-trace.md): consistent with wrapper 42981 being stopped by TaskStop at 15:40:27, 10 s after it started; the TaskStop signal is not recorded, so KILL (no trap) vs a failed rm is unverified. Fix decided: a start-of-run sweep of run dirs whose owner pid is dead, in scripts/test-data-cap.sh, implemented with the Gap 1 change on branch fix/test-cap-hard-image.

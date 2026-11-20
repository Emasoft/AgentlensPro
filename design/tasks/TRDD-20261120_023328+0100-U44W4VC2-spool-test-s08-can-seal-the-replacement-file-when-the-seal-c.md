---
trdd-id: U44W4VC2
title: spool test s08 can seal the replacement file when the seal child starts late
column: todo
status: tasked
created: 2026-11-20T02:33:28+0100
updated: 2026-11-20T02:38:15+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
scope: project
project-id: agentlenspro
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-20T02:33:28+0100
---

# spool test s08 can seal the replacement file when the seal child starts late

Seen once on 2026-11-20 in a full run of rust-core/crates/agentlens-spool/tests/spool.rs on a loaded host: s08_seal_that_lost_the_race_does_nothing panicked at spool.rs:285 with 'the losing seal sealed something' (reports_dev/JCUXA6Z4/det-fail-1.txt). s08 alone then passed 5 of 5. Cause, read in code: assert_blocked (spool.rs:105-108) only sleeps BLOCKED_FOR and checks that the seal child has not exited; it does not prove the child is already waiting on the lock of the original current.ndjson. If the child starts late, the test renames current.ndjson away and (replaced=true) writes a new one before the child opens it, so the seal locks and seals the new file and prints it. s08 uses spawn_seal, which the TRDD-JCUXA6Z4 helper change does not touch. Fix: make the test wait until the seal child is provably blocked on the lock (for example poll for the child's open of the file, or have alspool report that it is waiting on stderr behind a test-only flag), not on a fixed sleep. Acceptance: s08 passes 200 of 200 under a parallel CPU load.

## Approval log

- 2026-11-20T02:33:28+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Process log

2026-11-20 correction: the cause above is INFERRED, not read in full. Only assert_blocked (spool.rs:105-108, a fixed sleep plus a not-exited check) and the s08 body were read; hold_lock and alspool's seal path (open, lock, re-check the path) were not. Evidence of the failure and of 5 of 5 solo passes comes from the worker report reports_dev/JCUXA6Z4/20261120_023207+0100-deterministic.md, read by the main agent.

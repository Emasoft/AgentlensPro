---
trdd-id: A2KNXCNH
title: Long sweeps persist read positions per chunk so a killed sweep resumes instead of restarting
column: todo
status: tasked
created: 2026-10-15T07:12:03+0200
updated: 2026-10-15T07:12:08+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-15T07:12:03+0200
npt: [0R0NGVK6]
---

# Long sweeps persist read positions per chunk so a killed sweep resumes instead of restarting

## What
Commit 1 of TRDD-6B7VV2Z7's revision-2 plan, split out 2026-10-15 so it can land now while 6B7VV2Z7's own fix (B') waits for TRDD-0BDOV3WC and TRDD-USSG465Q. `DurableState::ingest_chunk` appends each flushed chunk's read positions with `append_changed` right after that chunk's cards are put (both ingest closures, plus the boot remainder and the full-sweep remainder; targeted sweeps keep saving on the 60 s tick); the version-stale branch of `restore_from_snapshot` tombstones both logs and stamps the version before the cold rescan; the appends count in the persistence counters. Full spec and test list (T3 with more than SCAN_CHUNK files and a death after chunk 1, T4, T6 poisoned lock, T7 steady-state 0 bytes; key derivation as export_file_state; append only on the lock Ok arm): TRDD-6B7VV2Z7 STATE PLAN.

## Why
VERIFIED (main, 2026-10-15): the startup sweep persists no read positions until it returns, so any long sweep killed partway restarts from the beginning.

## Acceptance
- [ ] ingest_chunk on both closures and both remainders; version-stale stamping
- [ ] tests T3, T4, T6, T7 with recorded mutations
- [ ] clippy -D warnings clean; cargo test -p agentlens-core green; TS unit suite green

## Approval log

- 2026-10-15T07:12:03+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

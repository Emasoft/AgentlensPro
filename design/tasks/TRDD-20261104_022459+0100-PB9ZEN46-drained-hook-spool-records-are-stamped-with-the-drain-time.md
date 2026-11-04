---
trdd-id: PB9ZEN46
title: Drained hook-spool records are stamped with the drain time
column: todo
status: tasked
created: 2026-11-04T02:24:59+0100
updated: 2026-11-04T02:24:59+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-04T02:24:59+0100
---

# Drained hook-spool records are stamped with the drain time

Found during the TRDD-RBBEX59R step (c) review (spec design/specs/TRDD-RBBEX59R-step-c-no-collection-mode.md, decision D2). Defect 1: drain_hook_spool ingests each spooled hook event with the drain time (rust-core/crates/agentlens-core/src/hook_events.rs:138-141, build_hook_event_record takes ts as an argument; :397 passes now_ms; callers rust-core/crates/agentlens-core/src/chores.rs:1424 and :1647), so a backlog drained at once reads as a fresh fan-out to RUNAWAY_FANOUT and FANOUT_HEADSUP. The real event time survives only in the spool filename prefix (src/cli/hookHandlers.ts:87, Date.now()-pid-rand). Fix: stamp a drained record with that prefix. Defect 2: files whose proof is None are kept and sort first, and the periodic drain takes at most 200 per tick, so 200 or more kept files starve newer spool files. Both exist in normal mode today; neither is caused by step (c). Each fix needs a test with a recorded mutation run.

## Approval log

- 2026-11-04T02:24:59+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

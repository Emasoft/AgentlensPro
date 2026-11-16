---
trdd-id: RU9A8H7A
title: Disk monitor samples volumes every minute even when folder walks are slow
column: todo
status: tasked
created: 2026-11-16T19:05:14+0100
updated: 2026-11-16T19:39:27+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-16T19:05:14+0100
---

# Disk monitor samples volumes every minute even when folder walks are slow

Derived from TRDD-HTARKH87. Measured 2026-11-16 19:00-19:04 under host load 31-56: launchd ran disk-sample 4 times, but only 3 volume samples landed in 3.4 min (19:00:26, then 19:03:48), about one every 100 s, not every 60 s. Cause: each run also spends up to its 40 s walk budget (walks of ~/.agentlens 21 s, ~/Library/Caches 27 s, a .trashcan 33 s), so a run exceeds the 60 s StartInterval and launchd skips the tick. Fix: volume rows from a fast run every 60 s; folder walks from a second launchd job (or a detached child) on their own slower cadence, never delaying the volume row. Owner order: 'every 1 minute the datetime and the used and free disk space'.

## Approval log

- 2026-11-16T19:05:14+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

## Measurements

2026-11-16 19:40 — after the 60/300 s split (4fdee385) one post-install gap of 61.7 s (the 67.7 s gap spans the reinstall), then one 7:00.019 gap (exactly 7×60 s); launchctl showed runs=3, pmset showed no sleep, load average 128–169. Inferred cause: ProcessType Background lets launchd throttle/coalesce the timer under load. Next: volume job set to ProcessType Standard (walk stays Background), reinstall, re-measure. Card stays open until a 10-minute window shows ~60 s gaps.

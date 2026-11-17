---
trdd-id: JKVUBKLR
title: The card-log file pass slows 5 to 59 times under host load, more than a fair CPU share explains
column: backburner
status: tasked
created: 2026-11-17T17:30:40+0100
updated: 2026-11-17T17:30:40+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: spike
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-17T17:30:40+0100
---

# The card-log file pass slows 5 to 59 times under host load, more than a fair CPU share explains

## Problem
Residue of box 1 of TRDD-YR6WX7VQ. The file pass (DeltaLog::seed_written_from_disk on the log-sweeper thread) took 1.9 s on a quiet host on the gate copies and 0.34 s on a copy of the live files, and under load: 10.8 s (28 busy processes, 1-minute load 23 to 100), 72.1 s (same processes, load 100 to 114), 113.4 s (two disk writers, load 215), 14.2 s (a release compile), 32.9 s (live copy doubled to 143 MB, load rising to 101). The host has 14 cores, so a fair share at load 100 to 215 predicts 7 to 15 times, not 37 to 59. Evidence: reports_dev/YR6WX7VQ/gate-cause, gate-load, gate-live.

## Established
A kill before the start has no effect on a quiet host (1,897 against 1,939 ms). CPU load alone slows the pass. The code does not put the sweeper thread at background priority (one caller of set_background_qos, the second runtime's thread-start hook); the thread's class at run time was not measured.

## Not established
Disk load alone (both disk cells ran at host load 215; the no-kill disk cell was never run; the generator that was used is forbidden now, TRDD-H9UX6HFB). The spread between two CPU cells of the same kind (10.8 and 72.1 s): no cell was repeated, and the host is shared. Whether memory pressure, core type or the thread's run-time class explains the excess over a fair share. Whether tombstone removal by IndexMap shift_remove (delta_log.rs, index_files) is what makes a tombstone-heavy log five times slower than the live shape (inferred from two sizes, not measured).

## Acceptance
- [ ] One cell is repeated at least three times on a host whose load is recorded per second, with the sweeper thread's run-time class read once.
- [ ] The tombstone-removal cost is measured on a card log with and without tombstone lines, read-only, no load generator that writes.
- [ ] A decision with evidence: cheaper pass, pass off the sweeper thread, or accepted.

## Approval log

- 2026-11-17T17:30:40+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

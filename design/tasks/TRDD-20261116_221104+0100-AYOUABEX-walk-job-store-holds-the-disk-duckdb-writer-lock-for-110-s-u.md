---
trdd-id: AYOUABEX
title: walk job store holds the disk.duckdb writer lock for 110 s under load
column: backburner
status: tasked
created: 2026-11-16T22:11:04+0100
updated: 2026-11-16T22:11:04+0100
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-11-16T22:11:04+0100
---

# walk job store holds the disk.duckdb writer lock for 110 s under load

## Symptom (measured 2026-11-16 22:00, load 131-243)
The walk job logged `disk-sample: held disk.duckdb 110093 ms (store), opened 2026-11-16T21:00:01.788Z`: its store step held the single DuckDB writer lock for 110 s. Two consecutive sampler ticks were refused the lock in that time (carried over and written later by the fix in 38df4734).

## Cause (code read in src/cli/diskSample.ts storeOutcomes; duration measured, split not measured)
storeOutcomes opens the file and writes every outcome in ONE transaction: deletes, then appenders for the followed links and the pending directories (316k pending rows under the user's code folder were recorded once). The job runs at Nice 10 with LowPriorityIO, so under CPU load the whole transaction is slow while the lock is held. Not measured: which statement takes the time.

## Impact
With the carry-over the sampler loses nothing; a sample taken during the hold is written with the next tick (up to one period late, 5 minutes after the owner's directive of 2026-11-16). Readers (`agentlenspro disk ...`) wait only 5 s for the lock and fail during such a hold.

## Decision (delegated by the owner 2026-11-16: "decide yourself")
Backburner. The data loss is fixed; shortening the hold means splitting the store transaction, which risks a half-written walk cursor. Revisit only if readers failing during a hold becomes a reported problem.

## Options if revisited
- prepare the rows in memory first and open the file only for the final insert (already the case) and time each statement to find the slow one;
- write the pending directories of one folder per transaction;
- give readers a longer lock wait.

## Approval log

- 2026-11-16T22:11:04+0100 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

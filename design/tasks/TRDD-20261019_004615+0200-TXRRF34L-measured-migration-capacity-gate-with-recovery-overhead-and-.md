---
trdd-id: TXRRF34L
title: Measured migration capacity gate with recovery overhead and 20 GiB reserve
column: todo
status: tasked
created: 2026-10-19T00:46:15+0200
updated: 2026-10-19T00:57:55+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: spike
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: user
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-19T00:46:15+0200
derived: true
npt: []
eht: []
---

# Measured migration capacity gate with recovery overhead and 20 GiB reserve

## WHY
The measured backlog is larger than currently free space, so migration must not start from raw-size arithmetic or optimistic compression assumptions; it needs a measured peak-space model that includes every concurrent copy and preserves a hard 20 GiB reserve.

## Scope
- Benchmark representative corpus strata through the direct native DuckDB path.
- Measure database growth, raw compression, typed expansion, WAL, checkpoints, temporary spill, reconstruction workspace, crash recovery, filesystem allocation, and safety-copy overhead.
- Derive a conservative byte-level admission formula and preflight gate for each bounded migration batch.
- Include continued source growth and the immutable 20 GiB free-space reserve.

## Acceptance criteria
- [ ] Benchmarks cover representative source sizes, payload shapes, ages, and pathological high-expansion inputs.
- [ ] Peak observed and conservatively projected bytes are reported separately for database, WAL, checkpoint, temporary, reconstruction, and recovery components.
- [ ] The gate refuses a batch unless projected post-allocation free space remains at least 20 GiB.
- [ ] The gate re-measures actual free space and current database/WAL state immediately before every admitted batch.
- [ ] Prediction error is tested against held-out batches and the safety margin covers the observed worst case.

## Failure and refusal conditions
- Refuse migration when any overhead component is unmeasured, stale, or cannot be bounded.
- Refuse when free-space probes disagree or when reserve accounting would fall below 20 GiB.
- Refuse extrapolation outside benchmarked input bounds without a new benchmark.
- Never count source deletion as available capacity before deletion is separately authorized and completed.

## Out of scope
- Implementing storage schema, running the live migration, consumer cutover, retention policy, and deleting any source.

## Relevant links
- Parent architecture and measurements: TRDD-LHCHVK9Z.
- Direct DuckDB schema: TRDD-TC8HW857.
- Source identity substrate: TRDD-U50JCH0J.
- Retention owner: TRDD-Y1M56VMY.
- Runner, reconciliation, and live-drain cards will be linked after minting.
- Byte-bounded runner: TRDD-IFOQAQYV; full reconciliation: TRDD-JK4I9MFY; separately authorized live drain: TRDD-IGPWXZ1M.

## Dependency semantics
This is a depth-one atomic implementation card: `npt` and `eht` are empty and it has no `parent-trdd`.

## Approval log

- 2026-10-19T00:46:15+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.

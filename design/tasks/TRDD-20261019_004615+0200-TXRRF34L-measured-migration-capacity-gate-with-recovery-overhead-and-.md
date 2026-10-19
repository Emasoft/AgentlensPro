---
trdd-id: TXRRF34L
title: Measured migration capacity gate with recovery overhead and 20 GiB reserve
column: todo
status: tasked
created: 2026-10-19T00:46:15+0200
updated: 2026-10-20T01:47:02+0200
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
MEASURED 2026-10-20 (live machine, real corpus + real store) - read before quoting any compression figure. Raw bytes already ingested: 167,907,132,892 (167.9 GB) over 492,088 bodies. Total store on disk: 1.78 GB (blobs 736 MB + parts 974 MB + bodies 69 MB + api_calls 66 MB). The naive ratio 167.9 GB / 1.78 GB = ~94x is a CUMULATIVE, DEDUPLICATED figure and is NOT a capacity basis. The MARGINAL ratio for new content is ~12.5x: one live pass reported bytesIn=536,540,321 and bytesStored=42,875,585. A single verified body (712,898 bytes) produced 235 new blobs / 629,949 new bytes. Projected store for the remaining ~212 GB: ~17 GB at the marginal ratio, ~2.2 GB at the cumulative ratio. THE MARGINAL NUMBER IS THE PLANNING NUMBER; the cumulative one understates the store by ~8x. Free space at measurement: 86 GB at 96% full, so the 20 GiB reserve must survive a ~17 GB store plus WAL, checkpoints, working set, and the 4,861 + 4,836 parquet parts the fsync barrier touches. NEITHER ratio is a typed-column DuckDB compression ratio: the store is Parquet parts and the typed-DuckDB projection (TRDD-TC8HW857) is UNMEASURED, so this card must measure the typed path itself rather than extrapolating from the Parquet store.

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

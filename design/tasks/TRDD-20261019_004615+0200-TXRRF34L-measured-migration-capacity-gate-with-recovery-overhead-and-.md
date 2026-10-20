---
trdd-id: TXRRF34L
title: Measured migration capacity gate with recovery overhead and 20 GiB reserve
column: todo
status: tasked
created: 2026-10-19T00:46:15+0200
updated: 2026-10-20T04:12:24+0200
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
MEASURED INPUTS (NOT A RESULT) 2026-10-20, live machine, real corpus and real store. THIS CARD IS NOT SATISFIED BY THESE NUMBERS: the peak-space model its acceptance criteria require (database, WAL, checkpoint, temporary, reconstruction and recovery components reported separately) DOES NOT EXIST YET. Read these as inputs to that model, not as the model. THE ONE CONSISTENT DENOMINATOR: raw bytes ingested divided by MEASURED ON-DISK STORE GROWTH. A completed drain pass on the live corpus ingested 2,146,499,796 raw bytes and grew the store by 124,694,528 bytes on disk (1,845,744 KB to 1,967,516 KB) = 17.2x. That is the MARGINAL on-disk ratio for new content and it is the planning number. The cumulative figure of ~94x (167.9 GB raw ingested against a 1.78 GB store) is DEDUPLICATED and cumulative, so it must NOT be used for new content. The pass field bytesStored (59,124,650 for that same pass) is NOT a stored-size measure: it counts only newly written UNCOMPRESSED blob bytes and excludes the inline literal part bytes, so dividing bytesIn by it yields 36x, which is not a compression ratio at all. Do not quote bytesStored as a ratio. The cumulative ratio remains an upper bound on what good dedup achieves; the marginal 17.2x is the floor the gate must plan against. RESERVE ARITHMETIC: 87 GB free at 96 percent full, minus the 20 GiB reserve, leaves roughly 66 GB usable; the projected store for the remaining corpus at 17.2x is about 12-13 GB, leaving roughly 53 GB for the still-unmeasured WAL, checkpoint, working-set and recovery transients, against a store of 9,697 parquet parts (4,836 blobs + 4,861 parts) that the fsync barrier must touch. NEITHER ratio is a typed-column DuckDB compression ratio: the store is Parquet parts, and the typed-DuckDB projection (TRDD-TC8HW857) is UNMEASURED, so this card must measure the typed path itself rather than extrapolating from the Parquet store.

## Acceptance criteria
- [ ] Benchmarks cover representative source sizes, payload shapes, ages, and pathological high-expansion inputs.
- [ ] Peak observed and conservatively projected bytes are reported separately for database, WAL, checkpoint, temporary, reconstruction, and recovery components.
- [ ] The gate refuses a batch unless projected post-allocation free space remains at least 20 GiB.
- [ ] The gate re-measures actual free space and current database/WAL state immediately before every admitted batch.
- [ ] Prediction error is tested against held-out batches and the safety margin covers the observed worst case.
- MEASUREMENT DONE (2026-10-20) - THE NATIVE-DUCKDB 'database' COMPONENT, AND IT COMES OUT AGAINST THE NATIVE PATH. The report is at reports_dev/20261020_native-duckdb-capacity-measurement.md (DuckDB v1.5.4, real body files, deterministic sample, each shape measured in its own fresh process). THE HEADLINE: DuckDB's own compression does NOT compress these payloads. A whole body in a VARCHAR column lands at 0.93-0.98 of the raw bytes - the file is LARGER than the data it holds, because DuckDB selects the Uncompressed codec for them. The mechanism is a 4096-byte string-size threshold, reproduced at VARCHAR and BLOB: 4000-byte strings compress 22.36x, 4096-byte strings 0.96x. Chunking below the threshold recovers only part of it: 1.41-1.53 (chunked VARCHAR, FSST) and 2.32-3.09 (zstd-precompressed BLOB), against the ZSTD-PARQUET CONTROL ON THE SAME BYTES at 5.09-6.33. THE PARQUET PATH IS 2-4x BETTER PER BYTE than the native path the owner's directive asked for. WHAT THIS DOES NOT SETTLE: it settles ONE component of the peak-space model this card requires (the database component), and the other components - WAL, checkpoint, temporary, reconstruction, recovery - REMAIN UNMEASURED. The card is NOT satisfied by it and the peak-space model STILL DOES NOT EXIST. The measurement also found two measurement TRAPS worth knowing before anyone re-runs it: the FIRST DuckDB instance in a process behaves differently from later ones (two earlier runs of this same shape disagreed by 50% for exactly that reason), and DuckDB's codec choice is NOT deterministic (the same shape and corpus gave 1.414, 1.414, 0.957, 1.414), so a single run is not a number - the RANGE is.


- MEASUREMENT DONE (2026-10-20, same day, second session) - THE NATIVE-DUCKDB WAL COMPONENT, PLUS A WRITER-SAFETY FINDING. Both recorded in the same report (reports_dev/20261020_native-duckdb-capacity-measurement.md, What-was-NOT-measured section). WAL: during an open transaction the .wal tracks the inserted bytes closely (small 78.5 KB, medium 9.37-9.38 MB, large 36.4 MB against 78.1 KB / 9.37 MB / 36.36 MB raw), and after CHECKPOINT+close it is gone or absorbed - durable = db file only; chunk size (4096-262144) did NOT change durable size for either pragma. This BOUNDS the WAL component at roughly 1x the bytes of one ingest transaction - it is measured, not a component the model lacks. Writer safety: the node binding (@duckdb/node-api) DEADLOCKS PERMANENTLY if thousands of PreparedStatement.run() calls are issued without awaiting them - 4 libuv workers spin-blocked on one ClientContext mutex at 0% CPU, one thread inside ClientContext::Destroy() while a query was still executing (sampled twice for a stable stack). A serial (awaited) insert loop is MANDATORY for the native-ingest runner this card gates; the harness reproduced the deadlock twice before identifying the un-awaited prep() call as the cause. STILL UNMEASURED after this: checkpoint, temporary spill, reconstruction workspace, crash recovery, filesystem allocation, safety-copy overhead - the peak-space model still DOES NOT EXIST and the card is still NOT satisfied.

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

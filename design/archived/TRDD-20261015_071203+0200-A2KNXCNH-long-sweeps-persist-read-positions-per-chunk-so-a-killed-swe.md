---
trdd-id: A2KNXCNH
title: Long sweeps persist read positions per chunk so a killed sweep resumes instead of restarting
column: complete
status: archived
created: 2026-10-15T07:12:03+0200
updated: 2026-10-15T08:49:15+0200
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
implementation-commits: [15eb1ff0]
---

# Long sweeps persist read positions per chunk so a killed sweep resumes instead of restarting

## What
Commit 1 of TRDD-6B7VV2Z7's revision-2 plan, split out 2026-10-15 so it can land now while 6B7VV2Z7's own fix (B') waits for TRDD-0BDOV3WC and TRDD-USSG465Q. `DurableState::ingest_chunk` appends each flushed chunk's read positions with `append_changed` right after that chunk's cards are put (both ingest closures, plus the boot remainder and the full-sweep remainder; targeted sweeps keep saving on the 60 s tick); the version-stale branch of `restore_from_snapshot` tombstones log-offsets and stamps the version before the cold rescan (the log-sessions tombstone moves to TRDD-6B7VV2Z7: without B', a version bump followed by a refused reuse would restore an empty snapshot next to current positions and lose cards instead of leaving them stale); the appends count in the persistence counters. Full spec and test list (T3 with more than SCAN_CHUNK files and a death after chunk 1, T4, T6 poisoned lock, T7 steady-state 0 bytes; key derivation as export_file_state; append only on the lock Ok arm): TRDD-6B7VV2Z7 STATE PLAN.
Copied 2026-10-15 from TRDD-6B7VV2Z7: Commit 1 must also: derive each record key exactly as `export_file_state` does (`PathBuf::from(&s.file).to_string_lossy()`), or the next save tombstones and re-appends every key; append only on the lock's Ok arm (a poisoned lock puts nothing and appends nothing); rebuild T3 with more than SCAN_CHUNK generated files (precedent tests/log_reader_parity.rs:168-200), a simulated death after chunk 1, and the mutation 'append once after the sweep instead of per chunk'; add T7 (after appends, a forced tick with no change writes 0 offsets bytes and the version stamp is current). Narrow claim: no `Drop` in agentlens-core/src/*.rs saves state (subfolders unchecked; dropping a DuckDB connection checkpoints without changing content). Other readers of the three files (checked by main 2026-10-15): log-delta-version.json is read and written only by DurableState (log_reader.rs:832); standalone/cli.js references none of the three file names and contains no deltaLog symbol; server_stats.rs:500-501 reads only disk sizes.
Version-stale branch (log_reader.rs 876-882): before its early return call self.offsets.save(&{}) then self.stamp_version() LAST (no cards.save(&{}) here — see above) (a kill midway re-runs it idempotently). Bundled because append_changed fills `written`, so the first tick may write 0 bytes and skip the stamp (stamp_version runs only when bytes > 0); a death before a card save would then discard the scan. Measured once-per-version-bump cost (reports_dev/6b7vv2z7-rev2-measure.md): log-offsets compacts to empty; the ~1.55 MB log-sessions tombstone cost moves with the tombstone to TRDD-6B7VV2Z7. Targeted sweeps (sweep_paths) are excluded and keep saving on the 60 s tick. Mutations: T3 append once after the sweep instead of per chunk; T4 skip stamp_version; T6 append outside the lock's Ok arm; T7 drop the persistence-counter update.

## Why
VERIFIED (main, 2026-10-15): the startup sweep persists no read positions until it returns, so any long sweep killed partway restarts from the beginning.

## Acceptance
- [x] ingest_chunk on both closures and both remainders; version-stale stamping
- [x] tests T3, T4, T6, T7 with recorded mutations
- [x] clippy -D warnings clean; cargo test -p agentlens-core green; TS unit suite green

## Approval log

- 2026-10-15T07:12:03+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
- 2026-10-15T07:43:23+0200 — column → dev by main-agent@agentlenspro. prerequisite 0R0NGVK6 complete (2b3004b0); implementation worker started 2026-10-15 07:39, shortly before that completion, with its code dependency 3ee0c44c already landed
- 2026-10-15T08:49:15+0200 — COMPLETE by main-agent@agentlenspro. every acceptance box ticked with evidence (15eb1ff0; Rust 803/0, TS 3177/0/13, gate checks); deployment is not an acceptance item, as with 0R0NGVK6 and DA0GN1CS.

## Results

2026-10-15: implemented in 15eb1ff0. cargo test -p agentlens-core 803 passed / 0 failed (run 2, --no-fail-fast; run 1 had one unrelated shutdown-test flake that passed alone); clippy -D warnings clean; T3/T4/T6/T7 each fail under their recorded mutation (reports_dev/a2knxcnh-impl-report.md). Release build OK, no-op rebuild compiled nothing, --version exit 64, sha256 a23424e33930ed78b048bfb8f76af0a9add70b5777b8333be7811f50799a0949 (same after the TS run); TS unit 3177 passing / 0 failing / 13 pending (exit 0, no test failed so no flake to name), latency guard ran. The start_sweeper wiring is verified by reading only (tests drive ingest_chunk directly).
803/0 is worker-reported.
The commit message's 'the next full save sees them as unchanged' holds for Claude, Codex and Copilot files; an OpenCode chunk record comes from a second stat call, so the next save may rewrite that key (the safe direction).
Residuals: After a version bump the stamp is current at once while log-sessions keeps old-version records until the first full card save; a refused reuse before that save, or a death followed by a reused start (seed_written leaves those records untouched), can restore old-version cards for idle sessions later. This widens an existing 60-300 s window to the first 60 s; TRDD-6B7VV2Z7 (B') closes it. Per-chunk positions are a subset of the export; a resumed rescan runs on the sequential incremental path (inferred slower); no fsync on the offsets log.

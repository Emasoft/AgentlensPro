---
trdd-id: 2HRA270Y
title: Idle alcore RSS grows by about 4 GB in 75 s when otel-bodies is present
column: dev
status: tasked
created: 2026-10-22T13:08:46+0200
updated: 2026-10-22T23:41:28+0200
current-owner: main-agent@agentlenspro
created-by: main-agent@agentlenspro
task-type: bugfix
min-approval-requirement: none
assignee: main-agent@agentlenspro
mandate: true
mandated-by: none
approved: true
approval-judge: main-agent@agentlenspro
approval-datetime: 2026-10-22T13:08:46+0200
eht: [12FGMAEP]
---

# Idle alcore RSS grows by about 4 GB in 75 s when otel-bodies is present

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-10-22

- Cause identified (docs_dev/20261022-climb-stacks.md): open_store, run by bodies_pass every 60 s, is on the stack in every alcore-bg sample; load_pass_state and the bodies watcher were not observed active.
- NEXT ACTION (as of 2026-10-22 23:30): steps 4, 1, 2 and 3 are committed on branch fix/setup-agent-preflight (step 1 99d5c582; step 2 8c658bd1, 0964e060, 83d4f46c; step 3 1d1b2430 plus review fixes b7ad2c64, 2859c780, 71f32763). Clone run 1 (2026-10-22 23:06-23:36, docs_dev/20261022-clone-run-report.md) was INCONCLUSIVE: mimalloc commit stayed 1257-1873 MB (under 2 GB) but process RSS reached 4701 MB (about 2.8 GB outside mimalloc, i.e. DuckDB past its 1536MB limit); the first bodies pass opened the store at about 270 s and was still in reconstruct_chunk (per-body verify) at 900 s with no summary line, having deleted 1600 of 42997 otel-bodies files (pass.rs deletes each file right after its own verify, before the pass summary); the data-loss export of the whole store window hung for 900 s and verified 0 of 1600; alcore segfaulted on SIGTERM (COJI87P7). Next: re-run with the export narrowed to the deleted files' mtime window, the pass given time to complete, and a measured per-body verify cost; reconstruct_chunk is now the pass bottleneck. Deploy ONLY after TRDD-12FGMAEP's whole-process backstop lands or an owner waiver is recorded on 12FGMAEP (step 4 removes the only whole-process memory guard).
- Step 3 obligations (a)-(c) are done: part_file ids come from Store::next_file_id, the core_cap_guard check follows the store open into chores.rs, and sync_new_parts is the per-tick coherence step. The step-3 reviews added: export and purge open the store on first use (an idle server never ran a pass); the tick try_locks the writer (a purge never stalls HEAVY); after a poisoned lock, no reopen while the released instance is still referenced (a reopen for a different data dir records nothing, which only tests do); sync is a DuckDB anti-join both ways, and parts deleted out of band leave known_blob and body_durable (body_durable carries file_id, hidden from all_of); each part dir is listed by one read_dir, with only NotFound read as empty; an idle tick syncs an already-open store. Purge deletes archive volumes only and refuses while staging holds rows. Still open: purge holds the writer for its whole run; export reads staged rows by design (all_of); a body whose blob part was deleted out of band still points at missing bytes (sync cannot restore them); purge on an idle server has no test of its own (needed before deploy); a persistent sync error is logged every tick.
- Open from the step-2 reviews, to settle on the clone run: per-body probe cost over a full pass of 1,300+ files (option A's assumption, unmeasured at pass scale); size of the two ART indexes and duckdb_memory() during a full pass at 1536MB with 2 threads; cost of blob_fetch_sql's extra count query; from step 3: duration of the first store open and how long it holds the slot mutex, idle-sync cost per tick, duckdb_memory() after removals, steady-state RSS with the tables resident. Known gaps: api_call rows have no flush anti-join (a misfiring ingest short-circuit writes a duplicate api_calls part, shown by mutant B in docs_dev/20261022-step2-review2-fixes.md); a flush that fails after earlier tables committed leaves those parts unfsynced until the next successful settle.
- Step 4 alone does not end the crash loop: TRDD-2JOIAH2G records one canonical exit with mimalloc commit at 2.59 GB, which still breaches the commit-keyed cap; steps 1-3 are expected, not yet measured, to bring commit under 2 GB.
- SUPERSEDED 2026-10-22: "Candidates left: load_pass_state, open_store, the bodies watcher." and "the reader responsible is not identified" — replaced by the cause line above.
- SUPERSEDED 2026-10-22: the earlier Step 2 wording "dedup by anti-join at flush; no per-body probes" — replaced by option A in the Plan section.
- Note: the measurement lines under "## Approval log" are left in place because that section is append-only; this block supersedes them where they differ.

Measured 2026-10-22 (docs_dev/20261022-bodies-discriminator.md, isolated clones, --no-log-scan, no ingest, one run per arm): RSS +4255 MB over 2-75 s with <data_dir>/otel-bodies present (21,495 files, 2.92 GB), +50 MB with it moved out. The burn bodies watcher retains only a few MB; the reader is now identified (open_store): see the STATE block and the Plan 2026-10-22 section (docs_dev/20261022-climb-stacks.md). This is step 1 of the conversion order on TRDD-KBM09XHB and the largest single contributor to the TRDD-2JOIAH2G crash loop measured so far. Owner rule (KBM09XHB, 2026-10-22): body data is digested into DuckDB tables and read back as query answers; nothing corpus-sized resident in alcore's heap.

## Approval log

- 2026-10-22T13:08:46+0200 — MANDATE issued by main-agent@agentlenspro (min-approval-requirement: none). Pre-approved: issuer authority >= required approver. No approval request was sent.
2026-10-22: deploy gate added. Do not deploy step 4 (cap on mimalloc commit) to the live collector without TRDD-12FGMAEP's whole-process backstop or an explicit owner waiver recorded on 12FGMAEP. Step-4 checks recorded for reviewers: mimalloc dependency has no override feature (Cargo.toml lines 88-92), mi_process_info 6th argument is current_commit in libmimalloc-sys 0.1.49 extended.rs:359-368. package.json version bump plus CHANGELOG are due in the same PR (env var meaning changed).

## STATE

2026-10-22: all measurements are RSS (not phys_footprint, which the guard kills on), one run per arm; heap attribution waits for docs_dev/20261022-climb-stacks.md.
File counts are per clone: 21,495 (discriminator clone), 21,820 (live count at MEASURE time), 21,948 (arm-C clone); files keep arriving live.
Arm B (otel-bodies moved out) does NOT isolate the reader: with no staged bodies, bodies_pass returns at chores.rs:324 before open_store and before load_pass_state, so arm B removes the files, the store open, and the 75 MB load of store/.pass-state.json together.
Arm C (every clone body future-dated, so the 10 s age gate admits none) still climbed to 5,576 MB. Confounds: staged bytes are non-zero so the pass still opens the store and parses the 75 MB .pass-state.json; future mtimes also make the bodies watcher see every file as fresh and make retention-by-age skip them. Ranking from the stack samples below: open_store first; load_pass_state and the bodies watcher were not observed active.
Stack samples (docs_dev/20261022-climb-stacks.md): open_store is on the stack in every alcore-bg sample (DuckDB parquet table scans plus String HashSet inserts); load_pass_state and the bodies watcher were not observed active in three 5 s windows. phys_footprint 3.8 GB vs RSS 4.76 GB at 31 s (one vmmap).
Step 0 measured (docs_dev/20261022-step0-store-tables-measure.md): 3,866,224 blob shas; 1,520,728 body keys; known_blob about 420 MiB as VARCHAR, about 181 MiB as BLOB; body_durable about 860 MiB in DuckDB; DuckDB memory_limit does not bound process RSS (512 MB limit ended at 1,150 MiB RSS, spilling 721 MiB to temp; 1,536 MB limit ended at 2,497 MiB RSS, no spill).

## Plan 2026-10-22 (owner-approved)

Cause (stack samples, docs_dev/20261022-climb-stacks.md): every 60 s bodies_pass calls agentlens_store::open_store, which re-reads every Parquet part into a fresh in-memory DuckDB and copies every blob sha and body key into four Rust sets; .pass-state.json holds 1,488,247 skip names, 0 of which match the 22,111 files present.
Constraint kept: no persistent .duckdb for the store (300x SSD writes, lib.rs:4-5); Parquet parts stay write-once; DuckDB stays fileless but is opened once per process.
Step 0: done 2026-10-22, see the STATE block (docs_dev/20261022-step0-store-tables-measure.md).
Step 1: prune skip/stranded names to files present; drop a name when its file is unlinked.
Step 2 (revised 2026-10-22, option A, after the step-2 worker found the flush-only design breaks IngestResult): replace the four Rust sets with indexed DuckDB tables part_file, known_blob (sha as BLOB, ART index on sha) and body_durable (ART index on body_id, src_name); per-body probes against these tables, one query per body and never one per span, keep IngestResult's existed/new_blobs/new_bytes; the flush anti-join stays as the correctness net; the store gets its own STORE_MEMORY_LIMIT (1536MB), which assumes step 4: measured RSS at 1536MB was 2,497 MiB, so if step 4 is vetoed the limit must be re-sized. Per-body probes are safe where the 2026-08-18 runaway was not because each probe hits an in-memory ART index, not a Parquet scan; batch per settle group if profiling shows probe cost.
Step 3: open the store once per process (lazy, first non-idle tick), shared by bodies_pass and export/purge via try_clone; each tick ingests only part files not yet in part_file, so parts written by alstore or scripts stay visible.
Step 4: the 2 GB guard counts mimalloc committed bytes (alcore's own heap) per the owner's 2026-10-22 words. DuckDB is governed by its memory_limit, which was measured not to bound process RSS (512 MB gave 1,150 MiB RSS); the guard deliberately stops counting DuckDB, so under step 4 nothing caps whole-process memory; DuckDB's only limit is its memory_limit plus spill, which overruns. Separate commit, vetoable.
Tension disclosed at approval: TRDD-LHCHVK9Z routes raw bodies away from the legacy Parquet path; steps 1-3 invest in that path because the crash loop is now and LHCHVK9Z's children are unlanded.
Full plan text: ~/.claude/plans/elegant-churning-ripple.md (copied here in summary; this card is the durable record).

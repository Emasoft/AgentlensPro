---
trdd-id: 768NEX6E
title: What does the 60 s bodies pass cost the machine, and why is alcore 7 GB resident
column: dev
created: 2026-09-02T09:31:25+0200
updated: 2026-09-02T13:10:29+0200
current-owner: main-session
task-type: spike
priority: high
min-approval-requirement: none
related: [2R36W8Q1, YU8QPU89, ZW4APOPI]
---

# What does the 60 s bodies pass cost the machine, and why is alcore 7 GB resident

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-02

- **USER constraint 2026-09-02:** no fleet soak ("100 instances will crash this machine"); measure only
  under the sessions already running.
- **Measured:** five `/usr/bin/sample` captures of alcore (pid 95443) taken the instant
  `/api/server-stats` failed to answer within 2 s (09:20–09:27). In three of them `chores::bodies_pass →
  agentlens_store::pass::ingest_pass` spans the WHOLE 2–3 s capture, with 4,674 and 10,694 DuckDB frames
  and up to 142 `__psynch_mutexwait` samples — nearly all inside DuckDB's own
  `MultiFileFunction<ParquetMultiFileInfo>::{WaitForFile,TryInitializeNextBatch,TryOpenNextFile}` and
  `ExternalFileCache`: a multi-file parquet scan. The store is **3.3 GB in 15,406 parquet files**.
  Whether every pass scans the whole store is NOT yet read from the SQL — that is box 1.
- alcore RSS 6.3–8.0 GB across 9,301 logged requests since boot (first logged 7,476 MB). Two in-memory
  DuckDB connections default to `memory_limit` 2GB each (`bodies_evidence.rs:76`, `statusline_store.rs:231`);
  the store connection takes `memory_limit`/`threads` from `open_store` (`agentlens-store/src/lib.rs:6`).
- HTTP handlers were seen waiting on the state mutex in two captures (`ui::handle`, `hyper dispatch`), but the
  captures did not name the holder; `server_stats` walks the filesystem under the lock (`parked_bodies_gauge`
  stats every parked name, `statusline.stats()` lists every day partition) and `span_tick` holds it across
  `run_retention` + `compress_sealed_segments`. Lock-hold attribution is TRDD-2R36W8Q1's instrumentation.
- **Box 1 ANSWERED (verified by reading, 2026-09-02 09:45).** Every pass, `chores::bodies_pass` opens a
  FRESH in-memory DuckDB via `open_store(dir, DEFAULT_MEMORY_LIMIT /* "8GB", agentlens-store/src/lib.rs:39 */,
  threads = available_parallelism()-2 min 4)` (`chores.rs:266-267`) — the offline `alstore pass` sizing,
  inside a resident server, once a minute. `open_store` then runs `SELECT DISTINCT sha FROM
  parquet_scan(blobs/*.parquet)` (`lib.rs:138`; 6,798 files, 1.3 GB) and `INSERT INTO body_durable SELECT *
  FROM parquet_scan(bodies/*.parquet)` (`lib.rs:152`; 1,843 files, 91 MB, loaded in full) to rebuild the
  dedup sets from scratch. The verify-before-delete query `SELECT sha, data FROM <all blob parts> WHERE sha
  IN (…)` (`lib.rs:456`) "decompresses the ENTIRE blob corpus per query" by the code's own comment
  (`lib.rs:439-445`): parts are insertion-ordered so no row group can be pruned. Net: ~15k file opens and
  ~1.3 GB of decompression per minute on up to 8 GB and ~12 threads. That matches the stall samples (DuckDB
  `MultiFileFunction<Parquet>` waits, 10,694 DuckDB frames) and the 7 GB resident set.
- **Fix design (do in this order, each measured):**
  1. Size the in-server chore like the other in-server DuckDB uses: `threads = 2`, `memory_limit = 2GB`
     (`chores.rs:266-267`). Two lines. The pass may take longer; the tick skips overlaps via the pass lock.
  2. Build a `sha → part file` index in `open_store` from the scan it already does (add `filename=true` to
     `lib.rs:138`'s `parquet_scan`), keep it on `Store`, insert into it on every blob write, and make the
     verify read `read_parquet([only the files that own the requested shas]) WHERE sha IN (…)` instead of
     `all_of("blob")`. O(this pass's blobs) instead of O(corpus). The delete-gate proof still holds: the
     bytes come from the durable parquet file on disk, never from ingest RAM.
  3. NOT this: keeping the `Store` open across passes to skip the two rebuild scans. Retention/purge deletes
     part files; a cached `known` sha set would then claim a blob exists that is gone, dedup would skip
     writing it, and the new body would reference a missing blob — data loss. Only safe with an inventory
     check; card separately if step 2 is not enough.
- **Steps 1 + 2 LANDED (commits ef60b90f store index, f5926457 chores sizing + timing) and MEASURED
  2026-09-02 12:53–13:08 (pid 26060, 2 threads / 2 GB, sessions already running, no soak).** Twelve
  `bodies pass:` lines: 2–17 files ingested per pass, wall time **14.0, 13.8, 13.8, 14.1, 15.4, 16.2, 17.1,
  19.7, 23.0 s** typical and **55.6, 69.0, 141.4 s** for three passes that overlapped the state-lock
  holds TRDD-2R36W8Q1's instrumentation named in the same window (ui.rs:560 held 74.7 s / 34.8 s /
  27.2 s — the CPU was contended, the pass does not take that lock). A 14 s floor for a 2-file pass is
  the `open_store` rebuild — `SELECT DISTINCT sha, filename FROM read_parquet([6,798 blob parts])` plus
  loading the 1,843 bodies parts — which step 2 does not touch: the index makes the VERIFY read
  O(pass) but the DEDUP-SET rebuild is still O(corpus) every minute. Step 3's "only safe with an
  inventory check" is therefore the next lever → carded as TRDD-2TQHNMEC.
- **NEXT ACTION:** box 3 — decompose alcore's resident set (8,081 MB at the 12:52 boot per `server
  status`) with `vmmap`/`footprint` on the live pid, attributing the span window, log-session cards,
  summary cache and the three DuckDB pools; then decide the `memory_limit` defaults from numbers.

## Acceptance

- [x] The exact SQL each bodies pass runs is quoted with file:line, and the number of parquet files it opens
      per pass is measured (DuckDB `EXPLAIN ANALYZE` or the file cache counters).
      Evidence: STATE "Box 1 ANSWERED" (the three statements with `lib.rs` lines); file count per pass
      is the part-file list `open_store` binds by construction — 6,798 blob parts + 1,843 bodies parts
      (`part_files()`), every pass, before the index shrinks the verify read. Not `EXPLAIN ANALYZE`; the
      SQL names every file, so the count is exact without it.
- [ ] One pass's wall time, CPU time and bytes read are measured on this machine under normal load.
      Wall time IS measured (STATE: 14–23 s typical, 55–141 s under lock-hold contention, 12 passes);
      CPU time and bytes read are NOT — they belong with TRDD-2TQHNMEC's before/after.
- [ ] alcore's resident set is decomposed (span window, log-session cards, summary cache, DuckDB pools) with
      a measurement, not an estimate; a decision on the DuckDB `memory_limit` defaults follows from it.
- [x] If a pass scans the whole store: a partition-scoped rewrite is carded (or done here if ≤ 3 files).
      DONE HERE 2026-09-02T11:35:15+0200 — fix steps 1+2. Step 1: `chores.rs:266-267` no longer sizes
      the in-server chore like the offline CLI (`available_parallelism()-2 min 4` threads,
      `DEFAULT_MEMORY_LIMIT` "8GB"); now `threads=2`, `memory_limit="2GB"`, matching
      `statusline_store.rs`/`bodies_evidence.rs`. Step 2: `Store.blob_files: HashMap<sha, path>`
      built in `open_store` (`lib.rs`) via a new `parquet_scan_with_filenames` (`filename := true`
      added to the existing `known`-set scan), kept current on every blob flush
      (`flush_detailed`), and consumed by a new `blob_fetch_sql()` that scopes the verify-gate's
      blob read to only the owning part file(s) — falling back to the old `all_of("blob")`
      whole-corpus scan whenever any requested sha isn't yet indexed (still-staged blobs), so the
      delete gate never skips a sha. `cargo build -p agentlens-store -p agentlens-core`: clean.
      `cargo test -p agentlens-store`: 22/22 pass, incl. 2 new unit tests
      (`blob_fetch_sql_tests::*` — scoped-query and fallback) and 1 new integration test
      (`roundtrip.rs::blob_files_indexes_every_durable_sha_to_an_existing_part_file`).
      `cargo clippy -p agentlens-store --all-targets`: clean. Full report:
      `reports/w5-bodies-pass/20260902_113515+0200-report.md`.

## Notes and lessons learned

- A `sample` capture triggered by a summary-dependent probe catches summary rebuilds by construction; the
  five captures here were triggered by `/api/server-stats`, which does not touch the summary.

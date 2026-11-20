---
trdd-id: 768NEX6E
status: tasked
title: What does the 60 s bodies pass cost the machine, and why is alcore 7 GB resident
column: blocked
created: 2026-09-02T09:31:25+0200
updated: 2026-11-19T01:25:04+0100
current-owner: main-session
task-type: spike
priority: high
min-approval-requirement: none
related: [2R36W8Q1, YU8QPU89, ZW4APOPI]
pre-block-column: dev
blocked-by: [7YPQWKPG]
---

# What does the 60 s bodies pass cost the machine, and why is alcore 7 GB resident

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-09-02

- **2026-09-04 — TRDD-H5G9RRF3 FOLDED IN HERE (it was cancelled).** This card's title says 7 GB;
  the machine now reads **~15 GB**. New material sits in the resident-set acceptance box, not in
  this STATE block, so look there: (a) the guard-has-no-lever finding —
  `apply_memory_pressure` only halves the summarization window and it is pinned at
  `SUMMARY_WINDOW_FLOOR_MS`, a 288-fold clamp from the configured 24 h, with nothing responding
  past that; (b) live RSS readings and a quiet-sampling band of 28 MB over 9 samples; (c) a killed
  hypothesis (high RSS does NOT stall the compression sweep — 30 of 31 segments are `.gz`, and
  that sweep is TypeScript while the live server is Rust); (d) the `server status` observability
  gap. Pointer recorded here because a resuming session reads STATE first and would otherwise miss
  an annotation buried in an acceptance box.
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
  27.2 s — CPU contention INFERRED from co-occurrence; the pass does not take that lock and no CPU
  measurement was taken). A 14 s floor for a 2-file pass is
  the `open_store` rebuild — `SELECT DISTINCT sha, filename FROM read_parquet([6,798 blob parts])` plus
  loading the 1,843 bodies parts — which step 2 does not touch: the index makes the VERIFY read
  O(pass) but the DEDUP-SET rebuild is still O(corpus) every minute. Step 3's "only safe with an
  inventory check" is therefore the next lever → carded as TRDD-2TQHNMEC.
- **Box 3 MEASURED 2026-09-02 21:18 (pid 54270, build 4b878fd7, up 1h05m): RSS 11.6 GB;
  `footprint`/`vmmap` phys_footprint 9347 MB (peak 11 GB); vmmap resident 11.6 G / dirty 9.0 G.**
  vmmap's "IOAccelerator" category is **8.8 GB resident / 6.5 GB dirty, 94 regions (74×128 MB + one
  8.0 GB arena) — this IS the Rust heap, not GPU memory.** agentlens-core sets `mimalloc` 0.1.52
  (`libmimalloc-sys` 0.1.49) as the global allocator, and mimalloc tags every mmap it makes with VM
  tag 100 (`c_src/mimalloc/v2/src/options.c:147` default `os_tag=100`;
  `prim/unix/prim.c:309` `VM_MAKE_TAG(os_tag)`); macOS names VM tag 100 `VM_MEMORY_IOACCELERATOR`
  (`mach/vm_statistics.h:642`). The system-malloc zones (MALLOC_SMALL ≈1.9 GB resident/311 KB live/
  2.3 GB reclaimable; MALLOC_LARGE 562 MB) are the separate C/C++ side — DuckDB's own allocations,
  which don't route through Rust's global allocator. Metal/MPS/IOKit frameworks are transitively
  mapped but `alcore` links none of them (`otool -L` shows 6 libs) — irrelevant to RSS. Conclusion:
  Rust-heap ≈8.8 GB resident (6.5 GB dirty) vs DuckDB/C heap ≈2.5 GB — the card's hypothesis (span
  window, log-session cards, summary cache dominate) is SUPPORTED, not refuted; DuckDB pools are the
  smaller share. Full report: `reports/trdd-768nex6e/20260902_211803+0200-box3-vmmap-footprint.md`
  (see its own `## CORRECTION` section — the report's original "IOAccelerator = GPU, not
  application heap" reading is superseded by the mimalloc VM-tag fact above).
- **SUPERSEDED — do NOT carry forward:** any reading of vmmap's "IOAccelerator" region as GPU
  memory, a macOS VM-accounting artifact, or "not attributable to the DuckDB pools/span
  window/caches the card asked about" (the report's original box-3 conclusion, before the mimalloc
  VM-tag fact was found).
- **Box 4 DONE 2026-09-02.** Bounded resident structures (335k-span window as `Arc<Value>`,
  27,918 stripped + 50 hot cards, overlay ≤500) sum to **< 1 GB** — not the culprit. The 7–8 GB
  mimalloc heap is **churn from back-to-back whole-window `summarize_spans` rebuilds that mimalloc
  never decommits** (no `mi_collect`/purge call exists; `ui.rs:83-126` comment documents a prior
  26 GiB-committed measurement, TRDD-YU8QPU89, and defers an incremental summarizer). DuckDB's C
  heap is a separate 3.6 GB resident from parquet decompression. RSS grew 7.9 GB → 13.3 GB in
  15 min at 218–294% CPU on pid 67312; `sample` hottest frames: `summarize_spans` +
  `IndexMap` clone/`get_index_of` + duckdb zstd decompress. Full report:
  `reports/trdd-768nex6e/20260902_220716+0200-box4-heap-by-structure.md`.
- **SUPERSEDED — do NOT carry forward:** "the RSS is a retained data model" (box 3's framing) —
  it is allocator churn from repeated whole-window rebuilds plus DuckDB's own heap, not a growing
  resident structure.
- **NEXT ACTION:** the memory_limit-defaults question is now downstream of TRDD-7YPQWKPG's
  migration-order decision (advisor consult in flight). On the advisor's verdict, either close
  this card as complete with the box 1–4 measurements, or move its remaining memory_limit box
  into a child of 7YPQWKPG.
- **2026-09-03T05:34:53+0200 — moved dev → blocked:** box 2 (CPU time/bytes read) is measured
  under TRDD-2TQHNMEC, box 3's memory_limit decision under TRDD-7YPQWKPG; restore to dev when
  both are terminal (report reports/board-sweep/20260903_053411+0200-768nex6e-fold-verdict.md).
- **2026-09-03T10:58:52+0200 — box 2 CPU/bytes measured on pid 94042 (live alcore, no
  restart):** wall time confirmed from log lines (11.8–20.8 s across 3 observed passes).
  CPU time has no per-pass counter in the binary; two proxies used — a `ps cputime` bracket
  around one pass-completion boundary gave 64.11 s CPU over a 37.84 s poll window (WHOLE
  busy multi-threaded server, an upper bound, not pass-exclusive), and an
  `/usr/bin/sample 94042 18` (1 ms interval, `sudo -n true` confirmed no non-interactive
  sudo so `fs_usage` was skipped per the task's fallback) found the pass's own
  `body_writers::scan_live_body_writers` symbol in only ~27 of ~13,585 samples — the pass
  is almost entirely I/O-bound, own CPU plausibly low-hundreds-of-ms. Bytes read has no
  counter either; proxied by the pass's own "freed X.XMB" log figure (27.4–42.4MB observed)
  as a LOWER BOUND (files must be read/stat'd before delete/ingest decisions).
  Report: `reports/trdd-768nex6e/20260903_105436+0200-box2-cpu-bytes.md`.
- **2026-09-03T11:00:24+0200 — box 2 measured directly (report above); 2TQHNMEC dropped from
  blocked-by** — it optimises the pass, it is not needed to measure it. Remaining open box 3
  (memory_limit-defaults decision) is owned by TRDD-7YPQWKPG.

## Acceptance

- [x] The exact SQL each bodies pass runs is quoted with file:line, and the number of parquet files it opens
      per pass is measured (DuckDB `EXPLAIN ANALYZE` or the file cache counters).
      Evidence: STATE "Box 1 ANSWERED" (the three statements with `lib.rs` lines); file count per pass
      is the part-file list `open_store` binds by construction — 6,798 blob parts + 1,843 bodies parts
      (`part_files()`), every pass, before the index shrinks the verify read. Not `EXPLAIN ANALYZE`; the
      SQL names every file, so the count is exact without it.
- [x] One pass's wall time, CPU time and bytes read are measured on this machine under normal load.
      Wall time IS measured (STATE: 14–23 s typical, 55–141 s under lock-hold contention, 12 passes;
      re-confirmed 2026-09-03 at 11.8–20.8 s across 3 more passes). CPU time and bytes read are
      documented proxies (no per-pass counter exists in the binary): CPU via a `ps cputime`
      whole-process bracket (64.11 s upper bound over one pass's 37.84 s poll window) plus a
      `sample`-based symbol breakdown showing the pass logic itself is ~0.2% of sampled CPU
      (I/O-bound); bytes read via the pass's own "freed X.XMB" log figure as a lower bound.
      Evidence: `reports/trdd-768nex6e/20260903_105436+0200-box2-cpu-bytes.md`.
- [ ] alcore's resident set is decomposed (span window, log-session cards, summary cache, DuckDB pools) with
      a measurement, not an estimate; a decision on the DuckDB `memory_limit` defaults follows from it.

      **NEW DATA 2026-09-04 (pid 37180, uptime 6h22m) — this card's title says 7 GB; it is now ~15 GB.**
      Measured on `/api/server-stats`, same endpoint and field each time:

      | reading | `memory.rssMb` |
      |---|---|
      | ~15:26 | 15,085 |
      | ~15:36 | 14,712 |
      | ~15:37 (+57 s) | 15,015 |

      RSS **oscillates** in a ~300–400 MB band around ~14.9 GB — it is NOT monotonically climbing
      (an earlier claim that it was differenced two different instruments and is withdrawn).

      The datum most useful to THIS box: over the 57-second pair, RSS moved **+303 MB** while
      `spans.inMemory` moved **+25** (418,178 → 418,203) and `spans.windowMs` stayed pinned at
      300,000 (= `SUMMARY_WINDOW_FLOOR_MS`, `span_window.rs:23`) throughout. **So the swings do not
      track the span window** — a weak hint about where the decomposition might look first, and
      nothing more. **Do not treat it as an anomaly.** The comparison is rigged by construction (the
      window is clamped, so span count is near-constant by definition — a noisy numerator over a
      deliberately-constant denominator always looks dramatic), and ordinary causes cover the
      magnitude: this card's own note records 74 × 128 MB mimalloc arenas, so **two arena commits is
      256 MB** of the 303. DuckDB query buffers, background chores, and a 91.7 MB `/api/summary`
      response fetched minutes earlier were all uncontrolled.

      **THE GUARD HAS NO LEVER PAST THE WINDOW FLOOR** (folded in from TRDD-H5G9RRF3, which was
      cancelled 2026-09-04 as too thin to stand alone — see its Approval log). Read from source:

      - `apply_memory_pressure` (`span_window.rs:100-111`) responds to `rss > budget` by HALVING
        `effective_ms`, floored at `SUMMARY_WINDOW_FLOOR_MS` (`span_window.rs:23` = `5 * 60_000`).
        That is its ONLY response; nothing else in the codebase reacts to memory pressure.
      - Live: `configuredWindowMs` 86,400,000 (24 h) vs `windowMs` 300,000 — the floor exactly. The
        guard has clamped the window **288-fold** and has no further move.
      - It IS wired (`lib.rs:663`, on the flush tick) and announces each narrowing on stdout.

      **Why this matters to this card's decomposition:** the process is degraded-but-stable rather
      than failing, and the clamped window is why. It also means the span window is unlikely to be
      the dominant term in the resident set — it is pinned at its smallest legal size while RSS
      sits at ~15 GB.

      **Quiet-sampling band, 9 samples over 4.1 min** (`/api/server-stats`, 30 s apart): 15,109 →
      15,137 MB, **band 28 MB**, band FLOOR +2 MB across the window (noise, no leak signal), while
      `spans.inMemory` rose +308. Compare the 373 MB spread (15,085 / 14,712 / 15,015) recorded
      earlier the same day.

      **State that comparison precisely:** under quiet 30-second sampling the band is 28 MB; the
      373 MB spread was measured under heavy ad-hoc tool traffic and **was never re-run**. Do NOT
      say the larger band "does not reproduce" — nothing attempted to reproduce it, the two series
      differ in sample count, method and concurrent load, and 4 minutes is far short of the 15–30
      minute window a leak claim would need. Consistent with the swings having been self-inflicted
      traffic; not established.

      A small observability gap this exposed, worth fixing wherever it lands:
      `agentlenspro server status` prints `spans: … (5m window)` with NO indication that the
      configured value is 24 h and the process has been cut 288-fold. I read that line during this
      session and took it for normal operation. `/api/server-stats` should carry an explicit
      at-floor signal rather than requiring a reader to know `SUMMARY_WINDOW_FLOOR_MS` and compare
      by hand.

      Method already recorded and not to be re-derived:
      `[[vmmap-ioaccelerator-is-the-mimalloc-heap]]` (ATOM-WA0C-AO6Q) — macOS labels the ENTIRE
      Rust heap `IOAccelerator` (mimalloc VM tag 100), so `IOAccelerator` = Rust side and `MALLOC_*`
      = C/C++ side (DuckDB, which does not route through Rust's global allocator). Attribute with
      `MIMALLOC_SHOW_STATS=1`; do NOT chase Metal/GPU, those are transitive dyld loads.
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

## Notes

2026-11-19T01:25:02+0100 main agent: removed from TRDD-HSPUF5XH blocked-by as RISK ACCEPTED. The line with its failure mode and whether the mechanism existed at v2.33.1 is in HSPUF5XH, section 'Release list decision 2026-11-19'. This card stays open; only the release gate changed.

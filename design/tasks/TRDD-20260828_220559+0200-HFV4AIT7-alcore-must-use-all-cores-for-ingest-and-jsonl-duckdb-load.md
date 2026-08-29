---
trdd-id: HFV4AIT7
title: Measure and guarantee that alcore uses all CPU cores for telemetry and hook ingest and for the JSONL to DuckDB load
column: todo
created: 2026-08-28T22:05:59+0200
updated: 2026-08-29T01:23:27+0200
current-owner: claude-agentlenspro
task-type: audit
project-id: agentlenspro
parent-trdd: DMWOBWFH
blocked-by: []
---

# alcore must use all CPU cores

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-29

> **ITEM 3 — ROOT CAUSE ISOLATED (2026-08-29). It is NOT rayon-vs-tokio, and it is NOT the parser.**
> Measured with `/usr/bin/time -l`, same corpus, same machine:
>
> | path | wall | CPU-s | cores busy | work done |
> |---|---:|---:|---:|---|
> | `allogscan --dir ~/.claude/projects` | 4.8 s | 38.7 | **8.02** of 14 | parse only |
> | `cold_scan` standalone (`examples/scan_census`) | 25.9 s | 80.0 | **3.09** of 14 | parse + cards |
> | server boot scan | 20.5 s | — | ~1.4 of 14 | parse + cards + tokio |
>
> **Tokio contention is ELIMINATED as the cause:** `cold_scan` run with NO tokio runtime at all takes
> **25.9 s — slower than the server's 20.5 s**. rayon is innocent, and `rayon::current_num_threads()`
> reports the full 14.
>
> **The defect is inside `cold_scan`'s own per-item path.** It does ~2x the CPU work of the parser
> (80 vs 38.7 CPU-s — the card building is real work) but achieves **2.6x WORSE parallelism**
> (3.09 vs 8.02 cores). At `allogscan`'s efficiency those same 80 CPU-seconds would finish in ~10 s
> instead of 26. Two separable costs, and only the second is a bug.
>
> **The strongest lead is the sys time: 10.2 s vs 1.8 s — 5.7x.** That is syscall/page-fault
> pressure, not user-space compute, and it scales with the 20,557 cards built rather than with the
> 15,505 files parsed. Hypothesis to test next (NOT yet verified): allocator contention building
> large `serde_json::Value` card trees on 14 threads, which would cap parallelism exactly this way.
> Cheap discriminator: re-run `scan_census` with `RAYON_NUM_THREADS=4` — if wall time barely moves,
> the limit is shared (allocator/syscalls), not thread count.
>
> Reproduce: `cargo build --release -p agentlens-core --example scan_census` then
> `/usr/bin/time -l ./target/release/examples/scan_census`.

> **ITEM 3 DIAGNOSED — the parse is fine; the SERVER INTEGRATION loses 3.4x. Measured 2026-08-29.**
>
> | path | throughput |
> |---|---:|
> | raw single-threaded read of the 15,496 files | 1,533 MB/s |
> | **`allogscan --dir ~/.claude/projects`** (the shipped standalone parallel scanner) | **1,439 MB/s** (8.78 GB in **6.1 s**) |
> | **server boot scan** (the 20.5 s figure below) | **428 MB/s** |
>
> The parallel parse runs at **94% of raw sequential read speed** when run on its own, so
> `par_iter()` IS realised and the library is not the problem. The server does the same work over
> the same corpus **3.4x slower**, at ~1.4 of 14 cores.
>
> **Candidates, now narrowed to the server path** (`log_reader::cold_scan` → `sweep` → boot):
> - `discover_all` — **ELIMINATED**: 0.26 s including process start (~1% of 20.5 s), measured via
>   the shipped `disc_census` example. It is sequential (`discovery.rs:204`, chained `read_dir`
>   loops) and inside the timed window, but far too cheap to matter.
> - rayon's pool competing with the tokio runtime the server is already running.
> - the post-parse work the standalone binary does NOT do: `finish_transcript` / card building /
>   the `!Send` `LogTailer` collect, which forces results back onto one thread.
>
> **CAVEAT, stated rather than glossed:** `allogscan` parses but does not build session cards or
> seed `file_state`, so the two are not doing byte-identical work — some of the 3.4x is real extra
> work, not pure overhead. The next measurement should time `cold_scan` itself (it already returns
> `elapsed_ms`) split against `parse_one` alone, which separates "extra work" from "serialization".

> **CORRECTION TO THE CORRECTION (2026-08-29, and this one is measured on both axes).** An earlier
> revision of this block declared the load "I/O-bound, not a defect" using **18.19 GB** as the
> corpus size. That number came from `du -sk ~/.claude/projects`, i.e. the WHOLE directory; the
> actual `.jsonl` payload the scan reads is **8.78 GB** across 15,496 files. With the right
> numerator the conclusion reverses:
>
> | | |
> |---|---:|
> | raw single-threaded read of the SAME 15,496 files (per-file open overhead included) | **1,533 MB/s** |
> | cold scan — 8.78 GB / 20.5 s | **428 MB/s** |
> | cores busy during the scan | ~1.4 of 14 |
>
> **The scan is ~3.6x slower than a plain sequential read of the same files, with ~90% of the CPU
> idle.** So it is neither disk-bound nor CPU-bound, and something serializes it. `cold_scan` DOES
> use `par_iter()` (rayon, `Cargo.toml:26`) — so the parallelism is declared but not realised, which
> is a more interesting defect than "nobody parallelised it". Candidates, none yet checked: the
> rayon pool competing with the tokio runtime; `discover_all` running sequentially before the
> par_iter and counted inside the 20.5 s; per-file `stat` on the same thread as the parse; or the
> `!Send` `LogTailer` forcing a collect back onto one thread.
>
> **Lesson, because this item has now been scored three different ways:** the first read ("9.9% CPU
> = one core = not parallel") ignored the code; the second ("I/O-bound, not a defect") used a
> corpus size from the wrong directory. Both were confident. The number that settled it was a
> like-for-like comparison — the same files, read the same way, timed against the scan.

> **SUPERSEDED — kept for provenance; the block above corrects it.**
>
> **THE JSONL LOAD IS NOT A MISSING-PARALLELISM DEFECT — corrected 2026-08-29.** The table below
> records "9.9% mean / 54% max CPU" for the cold JSONL load and it was read as "one core, not
> parallel". The code says otherwise: `log_reader::cold_scan` maps over discovered files with
> **`par_iter()`** (rayon, declared in `agentlens-core/Cargo.toml:26`) — the scan is parallel by
> construction. Only the OpenCode SQLite dbs are sequential, and deliberately (rusqlite, native WAL
> read).
>
> The low CPU is what an **I/O-bound** parallel scan looks like:
>
> | | |
> |---|---:|
> | corpus (`~/.claude/projects`) | **18.19 GB** |
> | cold scan | 15,424 sessions in **20.5 s** |
> | implied read throughput | **~909 MB/s** sustained |
> | warm page-cache read (521 MB file) | **4,428 MB/s** |
> | CPU during scan | 9.9% mean of 14 cores ≈ **1.4 cores** |
>
> Memory bandwidth is not the limit (4.4 GB/s warm), and parsing is not the limit (1.4 cores busy —
> a CPU-bound parse would saturate many). What remains is cold device reads. **More cores cannot
> speed up a disk-bound scan**, so "uses all cores" is the wrong success criterion for this path;
> the right one is whether it saturates the DEVICE.
>
> **HONEST LIMIT:** `sudo purge` was unavailable, so there is no measured COLD-read ceiling for this
> disk — 909 MB/s is compared against a warm figure and against CPU headroom, not against a measured
> cold baseline. To settle it: purge the cache, `cat` a few GB of the corpus, and compare that
> MB/s against 909. If cold reads measure ~900 MB/s the scan is at device speed and this item is
> DONE; if they measure much higher, the scan has a real serialization point and this stays open.

**Measured (isolated instance, 14-core machine, 32 concurrent posters):**

| path | before | after the ingest split | after the off-lock rebuild | reading |
| --- | --- | --- | --- | --- |
| OTLP `/v1/traces` | 131 req/s (2.7k spans/s), 29% mean / 97% max CPU | 201 req/s, 96% mean / 109% max CPU | **949 req/s (11.0k spans/s), 168.8% mean / 216.8% max CPU**; `__psynch_mutexwait` **83,061 → 70,909** | the summarize left the lock; ingest now serialises on ITSELF (see root cause 3) |
| hook events | 17,081 req/s, 123% mean CPU | (unchanged) | (unchanged) | cheap; the 32-client generator is the bottleneck |
| cold JSONL load (real 19 GB corpus) | 15,424 sessions in 20.5 s, **9.9% mean / 54% max CPU**, `/api/summary` p99 473 ms | — | — | one core, mostly waiting; no API stall |

Reports: `reports/bench/20260828_230236+0200-alcore-ingest-baseline.md`,
`reports/bench/20260828_230856+0200-alcore-cold-jsonl-load.md`. Generator:
`scripts/bench/alcore-ingest-flood.mjs` + `scripts/bench/cpu-sample.sh`.

**Root cause 1 (fixed, uncommitted at the time of writing):** `ingest_post` parsed the JSON AND
called `flush_spans()` → index `sync_all()` per payload, all under the global `Mutex<CoreState>`
(`lib.rs`). Split into `parse_payload` (off-lock, on the worker thread) + `ingest_parsed`
(lock: buffer append + window insert only); the HTTP path leaves the flush to the existing 5 s
tick in `chores.rs:426-438`. `ingest_post` keeps parse+ingest+flush for its 14 direct callers.
Two socket tests that read the segment right after a POST now flush explicitly.

**Root cause 2 (FIXED — option B landed):** implemented as decided below, with ONE deliberate
deviation: `/api/summary`, `/events` and `GET /` serve an EXACTLY-CURRENT summary rather than a
≤1-rebuild-stale one — `ui::summary_now` does the rebuild off the lock ON the read path (snapshot
under the lock → summarize outside → `store_if_newer`), which buys the same lock behaviour with no
staleness AND keeps every existing test's contract intact. A GET/HEAD preamble on `/`, `/events`,
`/api/*` warms the memo so the ~25 drill-down routes that reach `build_session_summary` under the
lock find a pointer clone. `run_burn_tick` uses it too (`burn_status_over`), and both burn paths
now BORROW `summary["sessions"]` instead of deep-cloning the card array under the lock.
Report: `reports/hfv4ait7/20260829_012200+0200-off-lock-rebuild.md`. 544 tests pass; clippy clean.

**Root cause 3 (OPEN — the new top-of-stack holder):** `ingest_parsed` holds the one
`Mutex<CoreState>` across its per-span `writer.append` loop. Call graph: ~300 samples per tokio
worker in `ingest_parsed`, **~296 of them in `SpanStoreWriter::append`** (serde serialization;
leaves `_platform_memmove` 5,098, `IndexMap::get_index_of` 1,785, `SipHasher::write` 787) — ×14
workers ≈ 4,300 samples of serialized work, which is why 70,909 mutexwait samples remain. Ingest is
no longer starved by a summarize; it is bounded by itself. That is why the PASS criterion's
"mutexwait near zero" was NOT met even though req/s (949 > 300) and CPU (168.8% ≫ 100%) were.
Per the stop rule, option (C) was NOT started. Smaller residual, named for honesty: the snapshot
clones a `Vec<Arc<Value>>` that reached ~480k entries (~3.8 MB memcpy + 480k atomic increments) on
each rebuild miss — ~15 times over the run, negligible against `append`, but it grows with the window.

**Root cause 2 (as PROFILED before the fix — kept for provenance):** `/usr/bin/sample` under the
flood (release build with symbols): 83,061 samples in `__psynch_mutexwait`; the lock-holder's CPU
is `summarize_spans` / `build_interaction_card` / IndexMap<String,Value> hashing — the FULL
summary rebuild `run_push_loop` triggers every 4 s (and `/api/summary`, `/events`, `GET /`)
under the SAME mutex ingest needs. Ingest is not slow; it is starved. `window.add` is O(1).

**Design (advisor verdict, Fable 5 — option B):**
1. `SpanWindow.spans: Vec<Arc<Value>>` (add wraps; prune unchanged); readers move to
   `&[Arc<Value>]` — 12 sites in 7 files (`summarizer.rs:69`, `update_payload.rs:260`,
   `codex.rs`, `server_stats.rs`, `ui.rs`, `lib.rs`, `bin/alcore.rs`); no reader mutates a
   stored span (no `iter_mut`), so `Arc<Value>` is safe by construction.
2. `log_sessions: IndexMap<String, Arc<Value>>` (`summary_over` already clones every card at
   ~lib.rs:312; `demote_cold_timelines` uses `Arc::make_mut` on the hot few).
3. ONE rebuilder: `push_update` locks, clones the two containers + `data_version`, unlocks,
   `spawn_blocking(summary_over)`, re-locks and stores via `VersionedCache::store_if_newer`.
   Single in-flight rebuild. `/api/summary`, `/events`, `GET /` serve the LATEST CACHED summary
   (≤ one rebuild stale — say so in the TRDD and in a `ponytail:` comment naming incremental
   summarize as the upgrade). `otel_attribution` is written in the same store step.
4. Rejected: (A) `Arc<Vec<Value>>` COW (a 200k deep clone under the lock per rebuild — moves
   the stall, does not remove it); (C) a second mutex (lock-order risk, only if B still shows
   waiting — then the holder is `writer.append`); (D) rate-limiting (hides the symptom);
   `im`/`rpds` (dependency for nothing — the Arc snapshot is ~1-2 ms).

**PASS CRITERION (the one measurement):** rerun `scripts/bench/alcore-ingest-flood.mjs
--mix otlp --concurrency 32 --seconds 40` with `/usr/bin/sample` (memory:
`sample-on-path-is-a-python-shim`): `__psynch_mutexwait` samples drop from 83k to near zero AND
req/s scales past 300 (expect > 2k) AND mean %cpu well past 100%.

**NEXT ACTION:** decide whether root cause 3 is worth pursuing — the honest question is whether
949 req/s (11k spans/s) against a measured real peak of 26 spans/s is already 400× headroom, i.e.
whether the remaining mutexwait is a number to fix or a number to record. If it IS pursued, the
target is the `writer.append` loop inside `ingest_parsed` (append into a per-request buffer merged
under the lock, or a dedicated writer mutex — note the card's own rejection note for (C): lock-order
risk), NOT more summary work.

**OPEN follow-ups from the adversarial review of ae513a4** (`reports/review-fork/20260829_000443+0200-ae513a4-review.md`):
- **F1 (HIGH) — FIXED in this commit.** The shutdown `select!` awaited only `ctrl_c()` (SIGINT), yet
  `agentlenspro server stop` sends SIGTERM — so on the NORMAL stop path the flush block never ran and
  up to 5 s of spans died in the writer buffer (the 5 s chores tick became the durability boundary the
  moment the HTTP path stopped flushing per payload). A `SignalKind::terminate()` arm now sits beside
  `ctrl_c()`; `tests/shutdown_flush.rs` proves it and is mutation-verified (removing the arm fails it,
  SIGKILL must not flush). Confirmed live: the SIGTERM ending the bench flushed 481,200 spans.
- **F2 (MEDIUM) — OPEN, not implemented.** 14 concurrent 8 MB payloads parsed on the shared tokio
  runtime stalled `/api/summary` to 2.38 s (idle 0.5 ms). A body above ~1 MB should parse on
  `spawn_blocking` rather than on a runtime worker.
- **F3 (LOW) — OPEN, not implemented.** The 5 s durability contract is documented in `lib.rs` but not
  where it is DEPENDED ON — the `chores.rs` tick and the `alcore.rs` shutdown block both need the
  comment, since F1 was exactly the failure of nobody reading it there.

**Memory (belongs to YU8QPU89, recorded here because it was measured here):** RSS 3.4 GB after
the baseline runs, **9.6 GB** after 289k spans, **15.0 GB** after 481k spans (2026-08-29 run) — the
window keeps every span as a `serde_json::Value`; the `Arc` wrapper adds 8 bytes + a refcount per
span and changes nothing about that.

USER goal (2026-08-28): *"test that it actually uses all cpu cores when ingesting all the data
from claude code telemetry and hooks and when loading the data from the jsonl via the duckdb."*
The reason the Rust rewrite exists at all (USER, same day): *"the typescript was unable to use all
16 cores, and the async loading of the data from the jsonl and the duckdb was stalling the
system."* So this is not a nice-to-have benchmark; it is the acceptance test of the migration's
purpose.

## What to measure (not infer)

Three load paths, each driven at a rate well above the real peak (26 spans/s measured; see
DMWOBWFH STATE) on an ISOLATED instance (own `DATA_DIR`, own ports — never the live :3000):

1. **OTLP ingest** — N parallel POSTers to `/v1/traces`.
2. **Hook events** — N parallel POSTers to `/api/hook-events` + the spool drain.
3. **Cold JSONL → DuckDB load** — boot against a copy of this machine's real `~/.claude/projects`
   (15 282 offsets / 25 900 cards, the numbers VHH7FXGC recorded) with `--no-log-scan` OFF.

For each: per-core utilisation over the run (`ps -o %cpu` is one number — use `top -l` samples or
`powermetrics`/`sample` so the answer is "how many cores were busy", not "how much CPU"), wall
time to drain, and the tokio worker count actually configured. Read the runtime construction in
`alcore.rs` and the ingest/log-scan task structure FIRST: a single `Mutex<CoreState>` around the
hot path serialises every path onto one core no matter how many workers exist, and that is the
most likely finding.

## Acceptance

- [ ] a reproducible script under `scripts/` (or `rust-core/…/benches`) drives all three paths and
      prints cores-busy + throughput; its output is committed as a report path in this card
- [ ] each path shows ≥ (cores − 2) cores busy under saturation, or the card records the exact
      lock/queue that prevents it and the fix lands as an NPT of this card
- [ ] the cold JSONL load does not stall the UI: `/api/summary` p99 latency during the load is
      recorded and stays under 1 s

## Notes and lessons learned

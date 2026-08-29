---
trdd-id: HFV4AIT7
title: Measure and guarantee that alcore uses all CPU cores for telemetry and hook ingest and for the JSONL to DuckDB load
column: ai_review
created: 2026-08-28T22:05:59+0200
updated: 2026-08-29T19:35:05+0200
current-owner: claude-agentlenspro
task-type: audit
project-id: agentlenspro
parent-trdd: DMWOBWFH
blocked-by: []
---

# alcore must use all CPU cores

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-29

> **▶ CURRENT STATE IS THE "BOTH ITEMS RESOLVED" BLOCK FURTHER DOWN (2026-08-29 18:30). Everything
> from here to it is the investigation trail, kept for provenance, and it contains two conclusions
> that were later overturned — that the cause was unknown, and that ingest was capped at ~1 core.
> Do not act on this section.**
>
> **(superseded) ⛔ STOP — THE JSONL-CORES CAUSE IS UNKNOWN. Every "ROOT CAUSE ISOLATED" claim below is
> SUPERSEDED (2026-08-29 16:10).** Five candidate fixes have now been implemented and measured on
> `(user+sys)/real` (the only load-stable metric on this machine — wall clock gave 28.4 s and
> 103.0 s for the SAME binary). Baseline **3.05 / 3.13 / 3.47** cores; `allogscan`'s ceiling on the
> same corpus is **8.67**.
>
> | mechanism removed | cores after | verdict |
> |---|---|---|
> | I/O held across the LISTING lock | ~baseline | kept on principle, no gain (`ac812b01`) |
> | LISTING mutex sharded 64 ways, capacity HELD at 5000 | 3.16 / 3.17 / 3.21 | **lock RULED OUT** |
> | mimalloc in the bench, matching the shipped binary | 2.17 / 2.58 / 3.03 | **allocator RULED OUT** (bench fix kept, `b2ae70b6`) |
> | `RAYON_NUM_THREADS` 4 vs 14 | 4 beat 14 | **thread count RULED OUT** |
> | listing-membership instead of a per-(session × slug) stat | 3.49 / 3.18 / 2.24, sys 37-72 s | reverted — thrashes the wholesale-`clear()` cache |
> | **hoisted scan-invariant `(uid, slug)` index — removes the stat fan-out entirely** | **3.10 / 3.08 / 3.06** | **stat fan-out RULED OUT** |
>
> **The last row is the one that changes the diagnosis.** The 405,436 `filesStatted` arithmetic
> (÷ 26,377 sessions = 15.4 = exactly the uid×slug fan-out in `find_session_scratch_dirs`) was
> correct as arithmetic, and the previous STATE blocks promoted it to a cause. Attempt 5 removed
> that fan-out outright — the enumeration is hoisted into one mtime-fingerprinted index per scan
> instead of a stat per session — and cores moved by **0.0**. So the stat count is a **correlate,
> not the constraint**. The patch is preserved at
> `reports_dev/scan-perf-attempts/20260829_160649+0200-attempt5-hoisted-scratch-index.patch`
> (gitignored) and reverted from the tree; it is correct code that buys nothing.
>
> **✅✅ BOTH ITEMS RESOLVED 2026-08-29 18:30. Read this block; the two below it are the trail and
> both contain conclusions this one overturns.**
>
> ### ITEM 3 — FIXED. ~3.2 → up to 6.81 cores (`a852281`)
>
> `list_dir_cached` stored `Vec<String>` and a cache **HIT** did `names.clone()` — a deep clone of
> every `String` in the listing — **while holding the process-global `LISTING` mutex**. Hits are
> 88.3% of calls, so the lock was held for allocations proportional to directory size, once per
> session, ~26k times. Fix: `Arc<Vec<String>>`, so a hit is a refcount bump.
>
> | | cores | parallel-region time |
> |---|---|---|
> | before | 3.05 / 3.13 / 3.47 (2.58 / 2.74 / 3.05 profiled) | 23.0–44.2 s |
> | after (7 runs) | **4.23 / 3.66 / 5.12 / 6.14 / 5.27 / 6.78 / 6.81** | **7.8–19.7 s** |
>
> Every run after beats every run before; `allogscan`'s ceiling on this corpus is 8.67, so most of
> the gap is closed. 453 tests pass, clippy `-D warnings` clean.
>
> **WHY SIX ATTEMPTS MISSED IT, because this is the reusable part.** The earlier fix moved the
> SYSCALLS out of the lock and left behind the comment *"the lock now covers only the map
> operations"* — true of `read_dir`, false of the clone a map operation **returns**. And the 64-way
> shard test looked like it exonerated the lock outright; it does not, because sharding gives no
> relief when the hot directories concentrate on a few shards, which they do. **Both measurements
> were correct and the conclusion drawn from them was wrong** — the trap was a true sentence in a
> comment, not a bad measurement.
>
> ### ITEM 2 — the "~1 core ceiling" WAS A BENCHMARK ARTIFACT. Retraction retracted.
>
> Every earlier run drove the server from ONE node process. node is single-threaded, so a flood
> that saturates its own event loop produces exactly the server-side signature of serialization —
> flat throughput, rising latency, one busy core. Driving the SAME server from N independent
> clients:
>
> | clients × conc | spans/s | server cores |
> |---|---|---|
> | 1 × 16 | 1,656 | 0.63 |
> | 4 × 16 | 12,697 | 0.84 |
> | 8 × 32 | 86,552 | 1.35 |
> | **14 × 32** | **170,561** | **1.19** |
>
> At peak: `droppedOnFailure: 0`, `spoolBackpressureSpills: 0`, `spoolBackpressureActive: false`,
> `shedTotal: 0`, no server-side errors logged, 1,000,080 spans in memory (the 1M cap), RSS 20 GB.
>
> **So the 162–174k spans/s figure I retracted an hour earlier was CORRECT** — it just needed
> enough client parallelism to reach. The retraction is itself retracted, and the reason is worth
> keeping: I replaced a right number with a wrong one because my measurement had a bottleneck I
> had not looked for. **170,561 ÷ 26 spans/s per session ≈ 6,560 concurrent Claude Code sessions**,
> not the 87 I reported.
>
> **The in-server profile is what exposed it** (`AGENTLENS_INGEST_PROFILE=1`, kept): `parse` 0.1
> ms/req, `held_lock` **0.1 ms/req** (0.665 s across a 100 s run — 0.67% of the time), while
> callers waited 12–22 ms/req. A lock held 0.67% of the time cannot be the constraint, and
> parse+lock together were 1.4 s of 77.6 CPU-seconds. That ruled the server out from the inside
> and pointed at the harness.
>
> **Honest limit:** the server never saturates on this machine — at 14 clients the *generators*
> take the cores (server cores fell 1.35 → 1.19 as client count rose). So "uses all 14 cores" is
> not demonstrable for ingest, because ingest needs ~1.2 cores to absorb more load than this
> machine can generate. `nonOk` scales with total sockets and is **0** at any duration with one
> client — client-side connection churn, matching zero server errors/shed/drops.
>
> **(superseded) ⚠ ITEM 2 (INGEST CORES) IS NOT ✅ — IT WAS NEVER MEASURED IN CORES, AND IT IS ~1 CORE.**
> Measured 2026-08-29 17:45 with `scripts_dev/ingest-cores.sh` (isolated `DATA_DIR` + HOME + ports
> 4971/3971/4972, `--no-log-scan`, 100 sessions, 120 s), CPU read straight off the live server
> process (`ps -o time=`), not off the flood:
>
> | flood concurrency | server cores | req/s | spans/s | OTLP p50 | OTLP p99 | dropped | spool | RSS |
> |---|---|---|---|---|---|---|---|---|
> | 8 | **0.90** | 89.4 | 1,787 | 0.55 ms | 109 ms | 0 | 0 | 6.4 GB |
> | **64** (8×) | **1.02** | 114.1 | 2,271 | 1.46 ms | **904 ms** | 0 | 0 | 7.1 GB |
>
> **Eight times the offered load bought 8% more throughput and 0.12 more cores, while p99 latency
> went up 8×.** Throughput flat + latency rising linearly with concurrency + one core busy is the
> signature of a SERIALIZED path, not of a server with spare capacity. The first row on its own
> reads as "0.9 cores, zero drops, comfortably keeping up"; only the second row shows it cannot go
> faster. **A single load point can never answer "does it use all cores" — it only shows whether it
> NEEDED to.** That is why both rows are here.
>
> **THE ✅ ON ITEM 2 IN THE HANDOFF WAS WRONG, and specifically it was a THROUGHPUT number
> answering a CORES question**: "162–174k spans/s, 0 drops". Over HTTP the measured rate is
> **~2,270 spans/s**, ~75× lower — so that figure cannot have come from this path (an in-process
> or batched benchmark, not the OTLP listener). Do not reinstate it without saying which path it
> measured.
>
> **WHAT THIS DOES AND DOES NOT MEAN FOR THE USER'S QUESTION.** The goal asks whether ingest keeps
> up "when running many claude code sessions in parallel" without filling the spool. At the
> measured real per-session peak of 26 spans/s, 2,271 spans/s is **~87 concurrent sessions** —
> with `droppedOnFailure: 0`, `spoolBackpressureSpills: 0`, `spoolBackpressureActive: false` and
> `hookEvents.spooled: 0` at every load tried. So the spool and memory halves of the goal are MET
> at this rate; the "uses all cores" half is NOT, and the ceiling is ~87 sessions rather than the
> ~6,000 the retracted figure would have implied.
>
> **NEXT MEASUREMENT for item 2 (same discipline — no fix from inspection):** find the serialized
> section. Sample the server under the concurrency-64 flood and attribute the ~1 core: if it is one
> mutex, name it; if it is the single-threaded HTTP accept path or a per-request write lock, name
> that. `spoolBackpressureSpills: 0` rules the spool out as the constraint already.
>
> **THE MEASUREMENT WAS TAKEN (2026-08-29 17:30) AND IT ANSWERS THE STRUCTURAL QUESTION.**
> `AGENTLENS_SCAN_PROFILE=1` now splits the scan into its serial and parallel halves and samples,
> every 2 ms, how many rayon workers are actually inside the parallel body. Three runs:
>
> | run | total | discover (SERIAL) | par | mean workers inside | samples at 0 | cores `(user+sys)/real` |
> |---|---|---|---|---|---|---|
> | 1 | 44,949 ms | 547 ms — **1.2%** | 44,161 ms | **13.98** | 0.0% | 2.58 |
> | 2 | 31,304 ms | 163 ms — **0.5%** | 30,965 ms | **13.88** | 0.0% | 2.74 |
> | 3 | 23,424 ms | 280 ms — **1.2%** | 23,007 ms | **13.94** | 0.0% | 3.05 |
>
> Concurrency histogram, run 3: **14 workers inside 99.5% of the time**, 1 worker 0.4%, zero 0.0%.
>
> **TWO CANDIDATE EXPLANATIONS DIE HERE.** (a) **Amdahl / a serial phase** — `discover_all` runs
> sequentially before `par_iter`, which would cap the whole scan no matter how good the parallel
> half is. It is **~1%**. (b) **A starved or under-filled pool** — the pool is never idle; all 14
> workers are inside the body essentially always.
>
> **WHAT IT LEAVES, stated precisely because this is now a narrow question rather than a hunt:**
> 14 threads are *inside the body* while the process consumes ~3 cores of CPU. Those two facts
> together mean **~11 threads are PARKED — blocked in the kernel, not running.** Not waiting for
> work; waiting *inside* the work. The question is no longer "why is the scan not parallel" (it is
> fully parallel) but **"what are 11 of 14 threads blocked ON?"**
>
> **The suspect list, and the one thing that must be explained about it.** `/usr/bin/sample`
> attributed **100% (25,614/25,614)** of `__psynch_mutexwait` under `list_dir_cached` — but
> sharding that mutex 64 ways with capacity held constant changed cores by nothing (3.16/3.17/3.21
> vs 3.05/3.13/3.47). A shard test that gives no relief is what you would ALSO see if the shard
> KEY is concentrated — nearly every session lives under a handful of hot slug directories, so 64
> shards can still put every thread on one or two of them. That reconciles the two measurements
> instead of dismissing either, and it is a hypothesis, **not** a finding.
>
> **NEXT MEASUREMENT (not a fix — the sixth guess is not owed a build):** instrument the blocked
> time itself — accumulate, per worker, nanoseconds spent waiting to acquire the listing lock, and
> the per-shard acquisition counts. If blocked-time ≈ (14−3)/14 of wall, the lock is confirmed and
> the concentrated-key hypothesis is testable from the shard histogram in the same run. If it is
> not, the threads are blocked on the filesystem and "use all CPU cores" is the wrong goal for
> this workload — which would itself be the answer to give the USER.
>
> **NOTE ON THE GOAL WORDING:** if the scan turns out to be disk-blocked rather than CPU-blocked,
> more cores cannot help and the honest report is that the ingest path (item 2) parallelises and
> the JSONL load is I/O-bound. Do not manufacture core utilisation that the hardware is not able
> to deliver.
>
> **(superseded) NEXT ACTION FOR ITEM 3 — a MEASUREMENT, not a sixth fix.** Do not propose another change from
> inspection: five inspection-derived fixes have now each cost a build + 3 runs and returned
> nothing. Instrument the scan with per-thread busy/idle accounting (how many rayon workers are
> executing at each instant, and what the ones that are idle are waiting for) so the remaining
> candidates can be told apart: per-thread work-distribution skew in the rayon split, a serialising
> section inside the card builder, or a kernel per-directory vnode lock. `/usr/bin/sample` cannot
> settle this — 100% of its attributed `__psynch_mutexwait` samples sat under `list_dir_cached`,
> and sharding that lock 64 ways then changed nothing, which is exactly how a symptom reads as a
> cause.
>
> **Everything below this block is retained for provenance and must NOT be read as current.**

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
> **DISCRIMINATOR RUN — the limit IS shared, not thread count. `RAYON_NUM_THREADS=4` gives
> real 23.0 s / 2.67 cores, versus 14 threads at 25.9 s / 3.09 cores: 3.5x fewer threads is
> slightly FASTER.** More parallelism buys nothing, so the ceiling is a shared resource the threads
> contend on — matching the 5.7x sys-time gap (10.2 s vs 1.8 s for the parse-only path). The
> remaining candidates are allocator contention on the large `serde_json::Value` card trees and
> per-file syscalls; the parse itself already proved it can hit 8 cores in `allogscan`, so the
> contention is introduced by the card-building half.
>
> **This also sets the realistic target.** The work is ~80 CPU-seconds; at `allogscan`'s 8-core
> efficiency that is ~10 s against today's 26 s. Not a 14x win — a ~2.5x one, and only if the
> shared bottleneck is removed rather than more threads added. Do NOT "fix" this by raising the
> thread count.
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

---
trdd-id: HFV4AIT7
title: Measure and guarantee that alcore uses all CPU cores for telemetry and hook ingest and for the JSONL to DuckDB load
column: todo
created: 2026-08-28T22:05:59+0200
updated: 2026-08-28T22:05:59+0200
current-owner: claude-agentlenspro
task-type: audit
project-id: agentlenspro
parent-trdd: DMWOBWFH
blocked-by: []
---

# alcore must use all CPU cores

## ⏵ STATE — READ THIS FIRST ON RESUME (authoritative; supersedes the body) — 2026-08-28

**Measured (isolated instance, 14-core machine, 32 concurrent posters, 30 s):**

| path | before | after the ingest split | reading |
| --- | --- | --- | --- |
| OTLP `/v1/traces` | 131 req/s (2.7k spans/s), 29% mean / 97% max CPU | 201 req/s, 96% mean / 109% max CPU | disk serialisation removed; now CPU-bound on ONE core |
| hook events | 17,081 req/s, 123% mean CPU | (unchanged) | cheap; the 32-client generator is the bottleneck |
| cold JSONL load (real 19 GB corpus) | 15,424 sessions in 20.5 s, **9.9% mean / 54% max CPU**, `/api/summary` p99 473 ms | — | one core, mostly waiting; no API stall |

Reports: `reports/bench/20260828_230236+0200-alcore-ingest-baseline.md`,
`reports/bench/20260828_230856+0200-alcore-cold-jsonl-load.md`. Generator:
`scripts/bench/alcore-ingest-flood.mjs` + `scripts/bench/cpu-sample.sh`.

**Root cause 1 (fixed, uncommitted at the time of writing):** `ingest_post` parsed the JSON AND
called `flush_spans()` → index `sync_all()` per payload, all under the global `Mutex<CoreState>`
(`lib.rs`). Split into `parse_payload` (off-lock, on the worker thread) + `ingest_parsed`
(lock: buffer append + window insert only); the HTTP path leaves the flush to the existing 5 s
tick in `chores.rs:426-438`. `ingest_post` keeps parse+ingest+flush for its 14 direct callers.
Two socket tests that read the segment right after a POST now flush explicitly.

**Root cause 2 (PROFILED, design decided, implementation OPEN):** `/usr/bin/sample` under the
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

**NEXT ACTION:** implement 1-3 on top of the committed ingest split, run the whole crate suite,
then the pass measurement; record numbers here.

**Memory (belongs to YU8QPU89, recorded here because it was measured here):** RSS 3.4 GB after
the baseline runs, **9.6 GB** after 289k spans — the window keeps every span as a `serde_json::Value`.

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

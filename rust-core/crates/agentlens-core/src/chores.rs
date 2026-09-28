//! The background chore scheduler (TRDD-DMWOBWFH, tier A). ONE place that ARMS the recurring
//! maintenance work; the chore BODIES live in the modules that own their subject
//! (`hook_events::purge_buckets`, `statusline_store::purge`, `SpanStoreWriter::run_retention` /
//! `compress_sealed_segments`) and are sync, clock-parameterized and manifest-returning so they
//! can be tested without a scheduler at all.
//!
//! WHY THIS IS A LIBRARY MODULE AND NOT MORE INLINE TIMERS IN `main()`. Every one of alcore's
//! background tasks was declared inline in the binary, and the measured consequence is that
//! `run_burn_tick` HAS NO TEST — a grep across `tests/` returns nothing, and an integration test
//! cannot reach into a binary's `main`. Adding more chores the same way multiplies that hole.
//!
//! CADENCES ARE PORTED, NOT CHOSEN (`standalone/server.ts`):
//!   - span retention + compression: 24h, and **retention runs FIRST** (:476). An expired segment
//!     must be unlinked, never pointlessly gzipped first.
//!   - hook-event + log-event buckets + statusline: 1h (:943), all three on one tick as the TS does.
//!   - flush + window prune: 5s. Lifecycle heartbeat: 30s. Statusline seal: 60s.
//!
//! NOT ARMED HERE YET (each needs its own slice, and a stub would be worse than an absence):
//! `archiveOtelBodies` (A3 — the bodies pass has its own lock and options surface) and
//! `scanResidentBlobs` (A4 — `burn/runtime.rs` still hard-codes `residentBlobs: []`).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use serde_json::Value;

use crate::{CoreState, LockTimed};

/// TWO ENGINES, ONE DATA DIR — the risk that does not exist in the TS, because there was only
/// ever one server. If the TS server and alcore run against the same data dir, their retention
/// and compression passes race: both enumerate the same segments, both decide the same file is
/// expired, and the loser's `remove_file` fails on a path the winner already unlinked (or worse,
/// compression re-creates a `.gz` for a segment retention just deleted).
///
/// The bodies pass already solved this with a kernel flock (`agentlens-store` `pass.rs:46`), and
/// this is the same primitive for the same reason: an flock is released on ANY process death, so
/// a crashed engine cannot leave a lock nobody can clear. Busy ⇒ SKIP THIS TICK, never block —
/// the other engine is doing the work, and a 24h chore losing one tick costs nothing.
///
/// A `--no-chores` flag was considered and rejected: it makes correctness depend on the operator
/// knowing to pass it.
pub fn with_chores_lock<T>(data_dir: &Path, body: impl FnOnce() -> T) -> Option<T> {
    use fs2::FileExt;
    let f = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(data_dir.join(".chores.lock"))
        .ok()?;
    if f.try_lock_exclusive().is_err() {
        return None; // another engine owns this tick
    }
    let out = body();
    let _ = fs2::FileExt::unlock(&f);
    Some(out)
}

/// The 24h span tick: retention, THEN compression. `runSpanRetention(); runCompressionSweepIncrementally()`
/// (server.ts:476) — the order is load-bearing, see the module header.
///
/// ponytail: this HOLDS THE STATE LOCK for the whole pass, so a large compression sweep stalls
/// every reader for its duration. Accepted deliberately — `writer` lives inside `CoreState` and
/// retention mutates its index, so the pass must exclude concurrent writes either way, and the TS
/// blocks its entire event loop here for the same work. Upgrade path if it ever bites: move the
/// segment enumeration outside the lock and re-acquire per file, which is only safe once the
/// index is separable from the writer.
fn span_tick(state: &Arc<Mutex<CoreState>>, now_ms: f64) {
    let Ok(mut st) = state.lock_timed() else { return };
    let data_dir = st.data_dir.clone();
    let days = crate::retention_config::resolve_knob(&data_dir, &crate::retention_config::SPANS_RETENTION_DAYS);
    let ran = with_chores_lock(&data_dir, || {
        let deleted = st.writer.run_retention(days, now_ms);
        if !deleted.is_empty() {
            let spans: u64 = deleted.iter().map(|d| d.spans).sum();
            println!("{} alcore: span retention: deleted {} segment(s), {spans} span(s)", crate::log_ts(), deleted.len());
        }
        // `usize::MAX` = the whole backlog in one call, matching the TS default of `Infinity`.
        // The bounded-slice mode exists for a BOOT sweep (a 31-segment backlog held the TS
        // servers' ports closed for 3m40s); on the 24h tick there is nothing to keep responsive.
        // `under_pressure` is `false` here for the same reason — the RSS ratchet it guards is a
        // back-to-back boot sweep, not one steady-state tick.
        let c = st.writer.compress_sealed_segments(now_ms as i64, usize::MAX, &|| false);
        if !c.compressed.is_empty() {
            println!(
                "{} alcore: span compression: sealed {} segment(s), saved {:.1}MB",
                crate::log_ts(),
                c.compressed.len(),
                c.bytes_saved as f64 / 1_048_576.0
            );
        }
        for w in &c.warnings {
            eprintln!("{} alcore: {w}", crate::log_ts());
        }
    });
    if ran.is_none() {
        // Not an error: the other engine holds the lock and is doing this work. Said out loud
        // anyway, because a chore that silently does nothing forever looks identical to a chore
        // that has nothing to do.
        eprintln!("{} alcore: span retention/compression skipped — another engine holds .chores.lock", crate::log_ts());
    }
}

/// `Math.max(1, Number(process.env.AGENTLENS_HOOK_EVENTS_RETENTION_DAYS) || 31)` (server.ts:765).
/// Ported through JS truthiness rather than "parse or default", because they differ where it
/// matters: `Number("0")` is 0, which is FALSY, so an explicit `0` falls back to 31 — it does NOT
/// mean "keep nothing". `Number("abc")` and `Number("NaN")` are NaN, also falsy, also 31. A
/// NEGATIVE value is truthy, so it survives the `||` and is then caught by the floor. Rust's
/// `"NaN".parse::<f64>()` SUCCEEDS, so the NaN filter is load-bearing, not defensive noise.
///
/// Takes the env as a MAP rather than reading the process environment, matching its sibling
/// `statusline_store::retention_days`. Not stylistic: cargo runs tests as parallel threads in one
/// process, so a test that sets a real env var races every other test in the binary.
pub fn hook_events_retention_days(vars: &std::collections::HashMap<String, String>) -> f64 {
    vars.get("AGENTLENS_HOOK_EVENTS_RETENTION_DAYS")
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|v| *v != 0.0 && !v.is_nan()) // JS falsy (0, -0, NaN) ⇒ take the default
        .unwrap_or(31.0)
        .max(1.0)
}

/// The 1h purge tick: hook-event buckets, log-event buckets, statusline partitions —
/// `purgeHookEvents(); purgeLogEvents(); purgeStatusline()` (server.ts:943).
///
/// The retention FLOOR is applied here, by `resolve_knob`'s `Knob.min`, because that is the split
/// the TS uses: `purgeBuckets` takes whatever number it is given. Passing a raw config value
/// straight through would let `logEventsRetentionDays: 0` wipe the store.
fn purge_tick(state: &Arc<Mutex<CoreState>>, now_ms: f64) {
    let (data_dir, sl_root) = {
        let Ok(st) = state.lock_timed() else { return };
        (st.data_dir.clone(), st.statusline.root.clone())
    };

    // TWO DIFFERENT KNOBS, and they are not interchangeable. log-events is a real config.json
    // knob (`RETENTION_META`), but hook-events is a BARE ENV READ with its own inline floor
    // (server.ts:765) and deliberately is NOT in that table — so `resolve_knob` cannot supply it.
    let vars: std::collections::HashMap<String, String> = std::env::vars().collect();
    let hook_days = hook_events_retention_days(&vars);
    let log_days = crate::retention_config::resolve_knob(&data_dir, &crate::retention_config::LOG_EVENTS_RETENTION_DAYS);
    for (dir, days, label) in [
        (data_dir.join("hook-events"), hook_days, "hook-events"),
        (data_dir.join("log-events"), log_days, "log-events"),
    ] {
        let (removed, freed) = crate::hook_events::purge_buckets(&dir, days, now_ms);
        if !removed.is_empty() {
            println!(
                "{} alcore: {label} retention: purged {} bucket(s), {:.1}MB",
                crate::log_ts(),
                removed.len(),
                freed as f64 / 1_048_576.0
            );
        }
    }

    let (removed, freed) = crate::statusline_store::purge(&sl_root, crate::statusline_store::retention_days(&vars), now_ms);
    if !removed.is_empty() {
        println!(
            "{} alcore: statusline retention: purged {} partition(s), {:.1}MB",
            crate::log_ts(),
            removed.len(),
            freed as f64 / 1_048_576.0
        );
    }
}

/// `stagedBodyBytes` for ONE target (server.ts:634) — the live bytes still staged in the bodies
/// dir. Only `*.request.json` / `*.response.json` count; anything else in there is not ours.
/// Fails OPEN (a raced dir or file contributes 0) because it runs on a timer and must never throw.
pub fn staged_body_bytes(dir: &Path) -> u64 {
    let Ok(rd) = std::fs::read_dir(dir) else { return 0 };
    rd.flatten()
        .filter_map(|e| {
            let name = e.file_name().to_str()?.to_owned();
            if !name.ends_with(".request.json") && !name.ends_with(".response.json") {
                return None;
            }
            e.metadata().ok().map(|m| m.len())
        })
        .sum()
}

/// `archiveOtelBodies` (server.ts:648) — ingest raw OTEL bodies into the content-addressed store,
/// then reclaim their disk space. The pass only deletes a body AFTER proving it reconstructs
/// byte-for-byte from a DURABLE part, so this is not a delete-on-a-timer in the sense the reaper
/// chores are; the proof is inside `ingest_pass`.
///
/// IN-PROCESS, not an exec of `alstore pass`. The TS shells out because the TS cannot run this
/// code; alcore can. Deciding factor: locating our own sibling binary at runtime is genuinely
/// fragile in this repo — the documented trap is that `agentlenspro` resolves to a published
/// global npm install rather than the local build, and a bodies pass silently run by a DIFFERENT
/// VERSION of the store engine is a data-integrity problem, not a nuisance. (A fable-advisor
/// consult was dispatched on exactly this question and did not return — the third advisor call to
/// hang on this card. The decision rests on the verified facts above, not on an unavailable
/// verdict; recorded so a later reader knows which it was.)
/// The cost accepted with it: this pass runs in the server's own address space, and DuckDB
/// ingestion is memory-heavy — the prior art in this repo is an unbounded boot sweep driving RSS
/// to 5.4GB. `max_bytes_per_pass` is what bounds it, which is why it is passed explicitly below
/// rather than left to the default.
/// How many throttled `ingest_pass` calls one tick may chain per dir before yielding. Bounds the
/// time the store lock is held and the blocking-pool thread is occupied; the next tick resumes
/// where this one stopped, so a backlog larger than this still drains, just over several ticks.
const DRAIN_MAX_PASSES: usize = 16;

/// B-1 (TRDD-Z53IJFE9 step B, advisor verdict): the fsync barrier's "already durable" set, kept
/// for the life of the process instead of rebuilt every tick — see the doc at its use site in
/// `bodies_pass`. Module-scoped (not function-local) only so `fsynced_parts_snapshot_for_test`
/// below can read it; nothing else needs to reach it from outside `bodies_pass`.
static FSYNCED_PARTS: OnceLock<Mutex<std::collections::HashSet<PathBuf>>> = OnceLock::new();

/// Test-only introspection: there is no other way for an integration test to observe that the
/// fsync barrier skipped an already-proven part rather than re-fsyncing it, since `ingest_pass`
/// reports no per-part counters. Returns a snapshot (cloned, so the lock is never held past this
/// call) of every parquet part this process has fsynced so far via `bodies_pass`.
pub fn fsynced_parts_snapshot_for_test() -> std::collections::HashSet<PathBuf> {
    FSYNCED_PARTS.get().map(|m| m.lock().unwrap_or_else(|e| e.into_inner()).clone()).unwrap_or_default()
}

pub fn bodies_pass(state: &Arc<Mutex<CoreState>>, now_ms: f64) {
    let data_dir = {
        let Ok(st) = state.lock_timed() else { return };
        st.data_dir.clone()
    };
    // The ONE bodies dir, `<data>/otel-bodies` — capture writes straight to it (TRDD-Z53IJFE9
    // step D removed the RAM-disk spool that this chore used to drain alongside it, and with the
    // spool went the free-space back-pressure valve: it existed to relieve a 2GB RAM disk that
    // filled in minutes, a hazard the SSD dir does not have — `bodiesMaxGb`'s over-cap valve
    // below still guards it).
    let scope = crate::burn::guard::resolve_bodies_read_scope(&data_dir, &std::env::vars().collect());

    if scope.capture_on {
        // server.ts:818-823 — the sink precondition, once per pass tick, warnings on TRANSITIONS
        // only (a per-tick repeat is filtered out by the day it matters). TRDD-U0L78B3Z.
        let problem = crate::server_stats::probe_sink(&crate::burn::guard::default_bodies_dir(&data_dir));
        if let Ok(mut st) = state.lock_timed() {
            if problem != st.sink_problem {
                match &problem {
                    Some(p) => eprintln!("{} alcore: bodies sink precondition FAILED: {p} (TRDD-4FMHW124)", crate::log_ts()),
                    None => eprintln!("{} alcore: bodies sink precondition recovered", crate::log_ts()),
                }
                st.sink_problem = problem;
            }
        }
    }

    if scope.dirs.is_empty() {
        return;
    }

    // B-3 (TRDD-Z53IJFE9 step B, advisor verdict): with the SSD dir drained continuously at a 60s
    // interval it is empty most ticks, and `open_store` (DuckDB open) is the expensive part of this
    // chore — "where the per-pass parquet rebuild scans happen" per the comment below. Checking
    // every dir's staged bytes is one `read_dir` each; do that BEFORE the pass lock and BEFORE
    // opening the store, so an idle minute costs a directory read instead of a DuckDB open for
    // nothing. `over_cap`/emergency-valve reasoning below still re-checks per dir once real work
    // exists — this is only the fast "nothing to do" exit.
    if scope.dirs.iter().all(|d| staged_body_bytes(d) == 0) {
        return;
    }

    let store_dir = data_dir.join("store");

    let max_gb = crate::retention_config::resolve_knob(&data_dir, &crate::retention_config::BODIES_MAX_GB);
    let cap_bytes = (max_gb * 1024.0 * 1024.0 * 1024.0) as u64;

    // The lock spans load → ingest → save. Narrowing it to the ingest alone lets two engines
    // interleave a load and a save on .pass-state.json and silently drop names: a lost skip name
    // re-examines a body forever, a lost STRANDED name forgets a body that could not be
    // reconstructed — and that one loses data.
    let lock = match agentlens_store::pass::acquire_pass_lock(&store_dir) {
        Ok(f) => f,
        Err(agentlens_store::pass::PassLockErr::Busy) => return, // another engine owns this pass
        Err(agentlens_store::pass::PassLockErr::Io(e)) => {
            eprintln!("{} alcore: bodies pass cannot take the store lock: {e}", crate::log_ts());
            return;
        }
    };
    // TRDD-768NEX6E: this chore runs every 60s INSIDE the resident server, not as an offline
    // CLI pass — `DEFAULT_MEMORY_LIMIT` ("8GB") + available_parallelism() is the `alstore pass`
    // CLI's sizing. Measured 2026-09-02: at that sizing the pass's DuckDB scans became the
    // machine's dominant IO/CPU load (stall samples: 10,694 DuckDB frames, all inside
    // `MultiFileFunction<Parquet>` waits). Match the server's other two in-process DuckDB uses
    // (statusline_store.rs, bodies_evidence.rs): threads=2, memory_limit="2GB".
    let threads = 2;
    // Timed from the store open, not the tick: TRDD-768NEX6E's acceptance wants one pass's wall
    // time on the log line, and the open is where the per-pass parquet rebuild scans happen.
    let started = std::time::Instant::now();
    let mut store = match agentlens_store::open_store(&store_dir, "2GB", threads) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("{} alcore: bodies pass cannot open the store: {e}", crate::log_ts());
            return;
        }
    };
    let state_file = store_dir.join(agentlens_store::pass::PASS_STATE_FILE);
    let (mut skip, mut stranded) = agentlens_store::pass::load_pass_state(&state_file);
    // B-1 (advisor verdict): parquet parts are immutable once written (`agentlens_store::lib.rs`
    // never merges/rewrites one), so a part fsynced on an earlier tick is fsynced for the life of
    // the process — recomputing the set fresh every tick (the old `HashSet::new()` here) made the
    // durability barrier O(total parts in the store) and growing forever. The module-level
    // `FSYNCED_PARTS` static is keyed by nothing but the part path, which is absolute and unique
    // per store dir, so two data dirs (or two tests) can never collide in it. A restart empties the
    // set and pays one full barrier on the next tick, which is the correct "prove everything
    // again" behavior.
    let fsynced_lock = FSYNCED_PARTS.get_or_init(|| Mutex::new(std::collections::HashSet::new()));
    let mut fsynced = fsynced_lock.lock().unwrap_or_else(|e| e.into_inner());
    let max_bytes_per_pass = ingest_max_bytes_per_pass(&std::env::vars().collect());

    let mut ingested = 0u64;
    let mut deleted = 0u64;
    let mut bytes_freed = 0u64;
    let mut reemitted = 0u64;
    let mut failed = 0u64;
    let mut any_over_cap = false;

    for bodies_dir in &scope.dirs {
        // `ingest_pass` is THROTTLED BY DESIGN — it returns `throttled: true` when it stopped at
        // `max_bytes_per_pass` with work left. One call per tick is therefore not a drain: it is a
        // nibble, and a producer faster than one nibble per interval wins forever. Keep passing
        // until the dir reports empty (TRDD-5YL1OQV1).
        //
        // ponytail: bounded at DRAIN_MAX_PASSES so one enormous backlog cannot monopolise the
        // blocking pool or hold the store lock for an unbounded time — the next tick resumes it.
        for pass_num in 0..DRAIN_MAX_PASSES {
            // Re-evaluated per pass: draining changes the staged size, and a dir that starts over
            // cap should stop draining at age 0 once it is back under.
            let over_cap = staged_body_bytes(bodies_dir) > cap_bytes;
            any_over_cap |= over_cap;
            let opts = agentlens_store::pass::PassOptions {
                bodies_dir: bodies_dir.clone(),
                // THE EMERGENCY VALVE (server.ts:667). Over the cap, ingest EVERYTHING (age 0)
                // rather than only what has aged out — otherwise a runaway producer outruns the
                // drain and the dir grows without bound while the pass politely skips every file
                // that is not old enough yet.
                //
                // B-2 (TRDD-Z53IJFE9 step B, advisor verdict): the SSD dir does not wait out
                // `bodiesMaxAgeHours` (72h default) to batch — it is the only durable capture
                // dir, so batching for free disk space no longer applies. `max_age_ms: 10_000`
                // is a small non-zero cutoff instead of 0: `ingest_pass`'s parse gate already keeps
                // (never deletes) a file that fails to parse and re-tries it next tick
                // (`pass.rs::ingest_body` → `sectionize`), and `verify_bodies_in_store_cached`
                // re-reads the file at settle time, so a file that finished writing between ingest
                // and verify fails verify and converges through re-ingest — no cross-tick
                // size/mtime tracker is needed. 10s just keeps a body captured mid-write off the
                // per-tick `failed N` log line; it costs nothing on an SSD dir already durable.
                max_age_ms: if over_cap { 0 } else { 10_000 },
                max_bytes_per_pass,
                // The SSD dir is a durable source (the TS target carries `durable: true`), which
                // gates the fsync barrier inside the pass.
                durable_source: true,
                ..Default::default()
            };
            let res = agentlens_store::pass::ingest_pass(&mut store, &opts, &mut skip, &mut stranded, &mut fsynced);
            ingested += res.ingested;
            deleted += res.deleted;
            bytes_freed += res.bytes_freed;
            reemitted += res.reclaimed_reemitted;
            failed += res.failed.len() as u64;
            if !res.throttled {
                break;
            }
            // TRDD-2JOIAH2G R2 — the bound is load-bearing: the RSS-cap kill fires between
            // passes/ticks, so this cap is what turns one enormous backlog into per-tick
            // nibbles. When the last allowed pass still reports throttled, say so (and what
            // remains) instead of ending the tick silently — the next tick resumes the drain.
            if pass_num + 1 == DRAIN_MAX_PASSES {
                eprintln!(
                    "{} alcore: drain stopped after DRAIN_MAX_PASSES passes; {:.1} MB remain",
                    crate::log_ts(),
                    staged_body_bytes(bodies_dir) as f64 / 1_048_576.0
                );
            }
        }
    }
    agentlens_store::pass::save_pass_state(&state_file, &skip, &stranded);
    drop(lock);

    // `failed` is in the line because "deleted" alone cannot distinguish a drained legacy park
    // from one that failed verify and is now re-examined every tick (TRDD-6SPXOV0P review): the
    // PARKED gauge reads the state file, which the drain empties BEFORE the gate decides.
    if ingested > 0 || deleted > 0 || failed > 0 {
        println!(
            "{} alcore: bodies pass: ingested {}, deleted {} ({} of them re-emitted), failed {}, freed {:.1}MB across {} dir(s) in {} ms{}",
            crate::log_ts(),
            ingested,
            deleted,
            reemitted,
            failed,
            bytes_freed as f64 / 1_048_576.0,
            scope.dirs.len(),
            started.elapsed().as_millis(),
            if any_over_cap { " (OVER CAP — drained at age 0)" } else { "" }
        );
    }
    let _ = now_ms;
}

/// `INGEST_MAX_BYTES_PER_PASS` (server.ts:597) — `Math.max(16MB, Number(env) || DEFAULT)`. Same JS
/// truthiness as the retention knob: an explicit `0` is FALSY and means the default, not "ingest
/// nothing". The 16MB floor then applies on top, so no configuration can stall the drain entirely.
pub fn ingest_max_bytes_per_pass(vars: &std::collections::HashMap<String, String>) -> u64 {
    let v = vars
        .get("AGENTLENS_INGEST_MAX_BYTES_PER_PASS")
        .and_then(|s| s.trim().parse::<f64>().ok())
        .filter(|v| *v != 0.0 && !v.is_nan())
        .unwrap_or(agentlens_store::pass::DEFAULT_MAX_BYTES_PER_PASS as f64);
    (v.max(16.0 * 1024.0 * 1024.0)) as u64
}

/// The nine fields the TS projects out of each blob (server.ts:1485). A PROJECTION, not the whole
/// row: this value is re-sent inside every burn-status SSE frame, so carrying the engine's full
/// row would put the extra fields on the wire four times a minute forever.
const RESIDENT_BLOB_FIELDS: [&str; 9] = [
    "sessionId",
    "project",
    "kind",
    "label",
    "isImage",
    "peakTokens",
    "residentTurns",
    "cumulativeReadTokens",
    "cumulativeReadCostUsd",
];

/// `scanResidentBlobs` (server.ts:1480) — refresh the resident-blob cache the burn enrichment
/// reads. `minResidentTurns: 3` / `minTokens: 20_000` are the TS's own filter, NOT this port's
/// choice, and they are stricter than the engine's defaults (2 / 0) on purpose: this feed is a
/// proactive WARNING, so it should surface blobs worth acting on, not every resident block.
///
/// Ranking comes from the engine (cumulative read cost, then tokens); the TS takes its default
/// top-20 and then slices 10, and this mirrors that rather than asking for 10 directly — the two
/// agree only because the sort is total, and mirroring costs nothing.
async fn resident_blob_scan(state: &Arc<Mutex<CoreState>>, now_ms: f64) {
    let (comps, coverage) = match crate::ui::compositions_in_scope(state, None, now_ms).await {
        Ok(v) => v,
        Err(e) => {
            // WARN, never propagate: the TS catches here too. A failed scan must leave the last
            // good cache in place and let the burn tick keep serving — it must not take down the
            // scheduler, and it must not blank the feed into a false "no resident blobs".
            eprintln!("{} alcore: resident-blob scan error: {e}", crate::log_ts());
            return;
        }
    };
    let out = crate::context_composition_index::find_resident_blobs(
        &comps,
        None,
        coverage,
        None,
        Some(20_000.0),
        Some(3.0),
        None,
    );
    let rows = project_resident_blobs(&out);
    if let Ok(mut st) = state.lock_timed() {
        st.latest_resident_blobs = rows;
    }
}

/// The `.slice(0, 10).map(...)` half of `scanResidentBlobs`, split out because it is the only
/// part with rules of its own — the rest is one engine call and one assignment.
pub fn project_resident_blobs(engine_out: &Value) -> Vec<Value> {
    engine_out
        .get("blobs")
        .and_then(Value::as_array)
        .map(|b| {
            b.iter()
                .take(10)
                .map(|blob| {
                    let mut m = serde_json::Map::new();
                    for k in RESIDENT_BLOB_FIELDS {
                        // ABSENT stays ABSENT. Inserting Null for a missing field would put a key
                        // on the wire that the TS object spread never produces, and a consumer
                        // reading `isImage: null` cannot tell it from a real value.
                        if let Some(v) = blob.get(k) {
                            m.insert(k.to_owned(), v.clone());
                        }
                    }
                    Value::Object(m)
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Shared by the boot drain and the periodic tick (TRDD-L6V1UUW0) so the two report identically.
fn log_spool_drain(d: &crate::hook_events::SpoolDrain) {
    if *d != crate::hook_events::SpoolDrain::default() {
        println!(
            "{} alcore: hook-spool: drained {} event(s), quarantined {} bad, kept {} unverified, kept {} for retry",
            crate::log_ts(),
            d.drained, d.rejected, d.unverified, d.kept
        );
    }
}

/// TRDD-2JOIAH2G — the one-line composition report, PURE so its arithmetic is unit-testable.
///
/// The crash-loop investigation proved (exit stats: post-GC committed == peak, 1.8/1.9/2.2 GiB)
/// that the 2+ GiB the RSS guard kills over is LIVE memory, not freed-but-retained — so the
/// question became "live at WHAT?". This line names the measured structures and DERIVES the
/// remainder; it must never hunt for or attribute unnamed subsystems, because a named guess
/// reads like a finding and this is a subtraction.
///
/// WHY CARD TEXT IS NOT SUBTRACTED FROM COMMIT: DuckDB allocates through its own C allocator, so
/// its buffer pool is invisible to mimalloc's commit counter — card text is reported for scale,
/// next to its `memory_limit`, but it lives outside the denominator. Window spans are
/// Rust-allocated (`Vec<Arc<Value>>`), so their estimate IS in-commit live data and is the one
/// structure slack is measured against.
#[allow(clippy::too_many_arguments)] // one flat diagnostic line: every field is a scalar in the sentence, a struct would not shorten anything
pub fn composition_line(
    commit_mb: u64,
    rss_mb: u64,
    window_count: usize,
    window_est_mb: u64,
    card_rows: usize,
    card_text_mb: u64,
    _persist_bytes: u64,
    summary_cache_mb: Option<u64>,
    stripped_cache_mb: Option<u64>,
) -> String {
    let slack = commit_mb.saturating_sub(window_est_mb);
    // `None` = no cached value for either cache (cold boot, or nothing derived yet) — reported
    // as `none`, never as 0 MB, because "zero bytes" and "nothing cached" are different facts.
    let cache_field = |mb: Option<u64>, name: &str| match mb {
        Some(v) => format!("{name} {v} MB"),
        None => format!("{name} none MB"),
    };
    format!(
        "alcore: composition: mimalloc commit {commit_mb} MB, process rss {rss_mb} MB, \
         window.spans {window_count} (~{window_est_mb} MB sampled est), {}, {}, \
         card rows {card_rows} (~{card_text_mb} MB text, DuckDB own allocator, limit 256 MiB), \
         derived slack = commit - window est = {slack} MB",
        cache_field(summary_cache_mb, "summary-cache"),
        cache_field(stripped_cache_mb, "stripped-cache"),
    )
}

/// TRDD-2JOIAH2G — one composition report: what the committed bytes ARE, in one server.log line.
/// Phase 1 runs under the state lock and touches nothing heavier than counter reads, ≤20 `Arc`
/// refcount bumps and one aggregate SELECT (see the comment at that call); phase 2 — the only
/// allocation-heavy step, serializing the sample — runs OFF the lock.
fn composition_tick(state: &Arc<Mutex<CoreState>>) {
    let (window_count, sample, card_corpus, summary_cached, stripped_cached) = {
        let st = state.lock_timed().unwrap_or_else(|e| e.into_inner());
        let window_count = st.window.spans.len();
        // An even sample across the window, at most 20 handles: cloning an `Arc` is a refcount
        // bump, so the whole lock hold stays in microseconds. `step >= 1` here because the
        // branch only runs when the window has more than 20 spans.
        let sample: Vec<Arc<Value>> = if window_count <= 20 {
            st.window.spans.to_vec()
        } else {
            st.window.spans.iter().step_by(window_count / 20).take(20).cloned().collect()
        };
        // TRDD-2JOIAH2G round-73: the two derived caches are the PRIME-but-UNMEASURED
        // candidate for the ~2.3 GB unexplained live memory. Same contract as the window
        // sample: an Arc clone under the lock, the multi-MB serialize happens below OFF the
        // lock. `cached_value` (not `cached_any`) deliberately: a 60s measurement read must
        // not inflate the served hit/miss ratio.
        let summary_cached = st.summary_cache.cached_value();
        let stripped_cached = st.stripped_cache.cached_value();
        // Card corpus, one aggregate. DEVIATION from the card's "never under the state lock":
        // `CardStore` is a plain field of `CoreState` with no lock of its own, so its connection
        // is only reachable from here — and the boot restore already holds this lock across
        // THOUSANDS of DuckDB puts (log_reader.rs `restore`). One aggregate SELECT over ≤32k
        // rows is bounded and strictly cheaper than that precedent.
        (window_count, sample, st.cards.corpus_bytes(), summary_cached, stripped_cached)
    };

    let (card_rows, card_text_bytes) = match card_corpus {
        Ok(v) => v,
        Err(e) => {
            // The corpus metric is gone, the tick is not: the line still reports commit/rss/window.
            println!("{} alcore: composition: card corpus UNAVAILABLE: {e}", crate::log_ts());
            (0, 0)
        }
    };

    // Off the lock: serialize the sample (megabytes can move here) and read the process-global
    // mimalloc counters (no CoreState involvement).
    let mut ser_failures = 0usize;
    let sampled_bytes: u64 = sample
        .iter()
        .map(|s| match serde_json::to_vec(s.as_ref()) {
            Ok(v) => v.len() as u64,
            Err(_) => {
                ser_failures += 1;
                0
            }
        })
        .sum();
    if ser_failures > 0 {
        println!(
            "{} alcore: composition: {ser_failures}/{} sampled spans did not serialize — window est is a LOWER bound",
            crate::log_ts(),
            sample.len()
        );
    }
    let sampled_count = sample.len();
    // Extrapolate the sample to the whole window. u128 on the multiply: sample bytes × window
    // length outgrows u32 long before anything else here, and a wrapping estimate would print
    // fiction next to a real commit number.
    let window_est_bytes = if sampled_count > 0 {
        (sampled_bytes as u128 * window_count as u128 / sampled_count as u128) as u64
    } else {
        0
    };
    const MB: u64 = 1024 * 1024;
    // Off the lock, same as the sample serialization: each cache holds ONE big Value (the
    // merged summary / its stripped form over the whole corpus), so this can move real bytes.
    // A value that fails to serialize (or is absent) reports `none` — the tick continues either
    // way; a cache size we cannot measure must not cost the whole composition line.
    let cache_mb = |cached: &Option<Arc<Value>>| -> Option<u64> {
        cached.as_ref().map(|v| match serde_json::to_vec(v.as_ref()) {
            Ok(b) => (b.len() as u64) / MB,
            Err(_) => 0,
        })
    };
    let summary_cache_mb = cache_mb(&summary_cached);
    let stripped_cache_mb = cache_mb(&stripped_cached);
    let mi = crate::rss_guard::mimalloc_info();
    let commit_mb = mi.current_commit_bytes / MB;
    // TRDD-2JOIAH2G round-98 Task A: committed/reset/purged answer "does mimalloc decommit under
    // pressure" — the composition line's shape is frozen except for this suffix. `reset`/`purged`
    // are cumulative-since-boot counters (bare integers in the stats JSON), so 0 genuinely means
    // "nothing ever decommitted" and is printed; the omitted pieces are the ones with no reading.
    let mut mi_suffix = String::new();
    if mi.committed_current_bytes > 0 {
        mi_suffix.push_str(&format!(", mi committed {} MB", mi.committed_current_bytes / MB));
    }
    mi_suffix.push_str(&format!(", mi reset {} MB, mi purged {} MB", mi.reset_total_bytes / MB, mi.purged_total_bytes / MB));
    if mi.pages_abandoned > 0 {
        mi_suffix.push_str(&format!(", mi abandoned {} pages", mi.pages_abandoned));
    }
    if mi.pages_abandoned_peak > 0 {
        mi_suffix.push_str(&format!(" (peak {})", mi.pages_abandoned_peak));
    }
    println!(
        "{} {}{}{}",
        crate::log_ts(),
        crate::uptime_prefix(),
        composition_line(
            commit_mb,
            mi.current_rss_bytes / MB,
            window_count,
            window_est_bytes / MB,
            card_rows,
            card_text_bytes / MB,
            0, // persist_bytes: spec-reserved parameter; the line's shape does not print it
            summary_cache_mb,
            stripped_cache_mb,
        ),
        mi_suffix
    );

    // TRDD-2JOIAH2G collect-probe: force mimalloc's FULL collect (visits ALL heaps, including
    // the 32 worker theaps) and log commit before/after. A big drop = the memory is a DRAINABLE
    // POOL (retire-pools, abandoned pages); a small drop = LIVE data. KNOWN CAVEAT (round-74):
    // this probe cannot separate retained structures from steady in-flight churn — both read as
    // "doesn't drop" — that separation is attribution's job, not this probe's.
    // WHY gated at >= 1024 MB: below that the answer carries no decision weight and the collect
    // costs CPU on every tick.
    if commit_mb >= 1024 {
        unsafe { libmimalloc_sys::mi_collect(true) };
        let after = crate::rss_guard::mimalloc_info();
        let after_mb = after.current_commit_bytes / MB;
        let (dropped, pct) = collect_drop_pct(commit_mb, after_mb);
        println!(
            "{} {}alcore: collect-probe: before {commit_mb} MB, after {after_mb} MB, dropped {dropped} MB ({pct}% of before)",
            crate::log_ts(),
            crate::uptime_prefix()
        );
    }
}

/// Drop (before-after, saturating — `after >= before` is a no-op collect, not an error) and the
/// percentage of `before` it represents, both integers. Pure so the arithmetic is testable
/// without a live mimalloc.
fn collect_drop_pct(before_mb: u64, after_mb: u64) -> (u64, u64) {
    let dropped = before_mb.saturating_sub(after_mb);
    let pct = dropped.saturating_mul(100).checked_div(before_mb).unwrap_or(0);
    (dropped, pct)
}

/// TRDD-2JOIAH2G — the abandoned-page sweep, the REMEDY TRIAL after the collect-probe retired
/// (round-80: mi_collect's reach is theaps + calling-theap pages + arena purge only; the
/// abandoned pool is the prime remaining drainable candidate and no instrument had measured it).
/// Every 60s, when `pages_abandoned > 10_000`, apply allocation pressure and log the counter
/// delta; below the threshold the pool is small and not worth the intervention — print nothing,
/// do nothing.
///
/// Process-global counters: NO CoreState involvement, never take the state lock (round-84
/// constraint) — the parameter exists only to keep the chore signature uniform. The reclaim
/// lever is allocation pressure (4 rounds of 8x16 MB allocated and freed immediately), NOT
/// `mi_collect` — the probe that called mi_collect is retired; the reclaim path
/// (`reclaim_on_free` / `mi_abandoned_page_try_free`, free.c:375-387) runs inside free.
fn abandoned_sweep_tick(_state: &Arc<Mutex<CoreState>>) {
    const MB: u64 = 1024 * 1024;
    const SWEEP_MIN_PAGES: u64 = 10_000;
    let before = crate::rss_guard::mimalloc_info();
    if before.pages_abandoned == 0 {
        // Nothing to sweep; also the parse-failure path reads 0 — say so rather than sit
        // silent behind the gate (round-84 review fold 3: a permanent parse failure must
        // not disable the instrument invisibly).
        println!(
            "{} {}alcore: abandoned-sweep: pages UNAVAILABLE or zero ({}) — no sweep",
            crate::log_ts(),
            crate::uptime_prefix(),
            before.pages_abandoned
        );
        return;
    }
    if before.pages_abandoned <= SWEEP_MIN_PAGES {
        return;
    }
    // Page-backed pressure ONLY (round-84 review fold 1): 16 MB blocks are HUGE-class —
    // they never enter page queues and freeing them never touches the abandoned-page
    // paths (reclaim_on_free / mi_abandoned_page_try_free fire only for page-backed
    // objects). Draining the pool requires same-size-class pressure: thousands of
    // small/medium objects (64 KiB page class) and several large objects (512 KiB,
    // inside the ~1 MiB large-page bound), so the page-queue machinery must reclaim
    // abandoned pages to satisfy the allocations.
    for _ in 0..4 {
        let small: Vec<Vec<u8>> = (0..4000).map(|_| vec![1u8; 16 * 1024]).collect();
        std::hint::black_box(&small);
        drop(small);
        let large: Vec<Vec<u8>> = (0..64).map(|_| vec![1u8; 512 * 1024]).collect();
        std::hint::black_box(&large);
        drop(large);
    }
    let after = crate::rss_guard::mimalloc_info();
    // Signed deltas: the pool can also GROW from the pressure (fresh pages may be abandoned
    // after), and a saturating delta would print that as 0 — a direction the reading needs.
    let pages_delta = after.pages_abandoned as i64 - before.pages_abandoned as i64;
    let commit_delta =
        (after.current_commit_bytes as i64 - before.current_commit_bytes as i64) / MB as i64;
    println!(
        "{} {}alcore: abandoned-sweep: pages {} -> {} (delta {pages_delta}), commit {} -> {} MB (delta {commit_delta} MB)",
        crate::log_ts(),
        crate::uptime_prefix(),
        before.pages_abandoned,
        after.pages_abandoned,
        before.current_commit_bytes / MB,
        after.current_commit_bytes / MB,
    );
}

/// TRDD-2JOIAH2G — positive control for the sweep's instrument, run ONCE at boot. Rounds
/// 86/87/88 established the old commit-drop ballast CANNOT discriminate (its commit delta is
/// satisfiable from already-committed free stock; the abandoned counter never moves), so that
/// mechanism is deleted and the control now synthesizes a KNOWN abandoned-count change via
/// thread lifecycle.
///
/// Mechanism: a GENUINELY NEW OS thread (`std::thread::Builder`, NOT a tokio blocking-pool
/// thread — the pool reuses threads, killing freshness) allocates 200 × 512 KiB page-backed
/// objects (~100 MB) and exits. mimalloc's thread-done path UNCONDITIONALLY abandons every
/// page the dying thread owned (round-64 mechanics — the same path that formed the 316-page
/// stop-block residual), so `pages_abandoned` MUST move. The ballast is LEAKED, not dropped
/// (round-90 review, blocking fold 1): the drop self-cancels the measurement — fill-time
/// abandons rise during allocation, then the frees drain them outright (try_free on emptied
/// abandoned pages, free.c:249-256; retire-at-empty on owned pages, free.c:42-47) and the
/// after-read returns to ~baseline on a healthy instrument. Only pages OWNED at exit are
/// abandoned by thread death, so the ballast is never dropped.
///
/// SEQUENCING IS LOAD-BEARING: before-read → spawn → join → after-read. The join must
/// complete before the after-read, or the thread-exit has not run yet. A first after-read
/// still showing a sub-threshold delta gets ONE re-read after 2s — a hedge for abandoned-stat
/// merge-visibility lag (round-89): the mechanism is a hypothesis, and the retry is cheap and
/// safe under both merge semantics.
///
/// Unlike the commit-drop control, whose PASS was satisfiable without any abandon happening,
/// this control FAILs only if the abandon mechanism or the counter-reading path itself is
/// broken. Read-path noise: each `mimalloc_info()` read allocates (JSON buffer + parse), so
/// deltas under a few MB / a few pages are read-noise, not signal — hence the 100-page floor.
fn abandoned_control_pass() {
    let before = crate::rss_guard::mimalloc_info().pages_abandoned;
    let spawned = std::thread::Builder::new()
        .name("alcore-abandon-control".into())
        .spawn(|| {
            // `vec![1u8; N]`, not `vec![0u8; N]`: a zeroed vec can take the OS zero-page path;
            // the non-zeroed form memsets every byte (precedent: rss_guard.rs's control test).
            // 512 KiB objects are page-backed large-class — never the HUGE class (round-84
            // fold 1), so every object lands on page-queue pages.
            let ballast: Vec<Vec<u8>> = (0..200).map(|_| vec![1u8; 512 * 1024]).collect();
            std::hint::black_box(&ballast);
            // LEAK, not drop (round-90 review, blocking fold 1): the control's premise is
            // "pages OWNED at exit are abandoned by thread death". Dropping the ballast
            // self-cancels the measurement — fill-time abandons rise during allocation, then
            // every free drains them (mi_abandoned_page_try_free frees emptied abandoned
            // pages outright, free.c:249-256; retire-at-empty frees owned pages, free.c:42-47),
            // so the after-read returns to ~baseline on a perfectly healthy instrument.
            // Forgetting the Vec keeps the pages owned-at-exit: thread death is then the ONLY
            // thing that can reclaim them, and _mi_thread_done abandons every one.
            // 100 MB leaked once at boot is bounded and irrelevant next to the 2+ GB commit.
            std::mem::forget(ballast);
        })
        .expect("failed to spawn alcore-abandon-control thread");
    spawned
        .join()
        .expect("alcore-abandon-control thread panicked");
    let mut after = crate::rss_guard::mimalloc_info().pages_abandoned;
    if !control_passes(after as i64 - before as i64) {
        std::thread::sleep(Duration::from_secs(2));
        after = crate::rss_guard::mimalloc_info().pages_abandoned;
    }
    let delta = after as i64 - before as i64;
    // The thread id printed is the SPAWNING thread's (the blocking-pool task running this
    // function) — the ballast thread is anonymous by design, its death is the mechanism.
    let thread = format!("{:?}", std::thread::current().id());
    if control_passes(delta) {
        println!(
            "{} {}alcore: abandoned-control: pages {before} -> {after} (delta {delta}) — PASS, thread {thread}",
            crate::log_ts(),
            crate::uptime_prefix()
        );
    } else {
        println!(
            "{} {}alcore: abandoned-control: pages {before} -> {after} (delta {delta}) — FAILED (delta {delta} < 100), thread {thread}",
            crate::log_ts(),
            crate::uptime_prefix()
        );
    }
}

/// The control's pass threshold, pure so it is testable without a live mimalloc. GEOMETRY-
/// DERIVED (round-90 review, blocking fold 2): 200 × 512 KiB = 100 MB in 2 MiB large pages
/// = 4 blocks/page ≈ 50 pages — the review's arithmetic; the threshold is set at 30 to sit
/// clear of read-noise (a few pages) while staying below the dominant-geometry expectation,
/// and the FIRST live delta is calibration data: if the observed delta sits far from 50,
/// the geometry assumption (4-per-page) is what's wrong, not the counter. Signed — the pool
/// can also SHRINK if the sweep's churn races the control.
fn control_passes(delta_pages: i64) -> bool {
    delta_pages >= 30
}

/// Arm every recurring chore on `rt`. Called once from `main` after the state is built and before
/// the listeners bind. Boot-time passes run INLINE first (the TS calls each chore once at startup
/// before setting its interval), so a server that is restarted more often than a chore's period
/// still performs it.
pub fn spawn_all(rt: &tokio::runtime::Runtime, state: Arc<Mutex<CoreState>>) {
    // Boot passes, in the TS's order.
    //
    // The hook-spool drain runs FIRST (TRDD-465EXTJ6). Events spooled while the server was down
    // are the oldest data in the system and the only copy of themselves; reingesting them before
    // the purge pass means a bucket-retention sweep can never delete the bucket they are about to
    // land in. It is also idempotent, so a crash mid-drain simply leaves the rest for next boot.
    {
        let mut st = state.lock_timed().unwrap_or_else(|e| e.into_inner());
        let now = crate::now_ms();
        // Boot pass has no lock contention yet — drain the whole backlog, unbounded.
        let d = crate::hook_events::drain_hook_spool(&mut st, now, usize::MAX);
        log_spool_drain(&d);
    }
    span_tick(&state, crate::now_ms() as f64);
    purge_tick(&state, crate::now_ms() as f64);
    bodies_pass(&state, crate::now_ms() as f64);

    let s = state.clone();
    rt.spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(24 * 3600));
        tick.tick().await; // the first tick fires immediately — boot already ran this pass
        loop {
            tick.tick().await;
            let s2 = s.clone();
            // On the blocking pool: retention unlinks files and compression gzips whole segments.
            let _ = tokio::task::spawn_blocking(move || span_tick(&s2, crate::now_ms() as f64)).await;
        }
    });

    let s = state.clone();
    rt.spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(3600));
        tick.tick().await;
        loop {
            tick.tick().await;
            let s2 = s.clone();
            let _ = tokio::task::spawn_blocking(move || purge_tick(&s2, crate::now_ms() as f64)).await;
        }
    });

    // The bodies pass (server.ts:853). ALWAYS 60s (TRDD-Z53IJFE9 step B): the SSD dir is the only
    // durable capture target, and it gets the continuous drain — an hourly timer cannot guard a
    // growing SSD dir (measured going 162MB -> 1.4MB free in ~2 minutes from ONE subagent).
    // On the blocking pool — a pass runs DuckDB ingestion and byte-for-byte reconstruction.
    let s = state.clone();
    let bodies_interval: u64 = 60;
    rt.spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(bodies_interval));
        tick.tick().await; // boot pass ran inline above
        loop {
            tick.tick().await;
            let s2 = s.clone();
            let _ = tokio::task::spawn_blocking(move || bodies_pass(&s2, crate::now_ms() as f64)).await;
        }
    });

    // The 30s resident-blob scan (server.ts:1497), boot pass included (:1498). 30s and not the
    // burn tick's 4s for the TS's own stated reason: bodies parse once then hit the LRU cache, so
    // a 4s recompute would waste the work for no gain.
    // NON-OVERLAP is by construction here, not by a flag: this is ONE task awaiting each scan
    // before the next tick, so the TS's `residentScanRunning` guard has nothing to guard. A
    // `spawn` per tick would need it back.
    let s = state.clone();
    rt.spawn(async move {
        resident_blob_scan(&s, crate::now_ms() as f64).await;
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        tick.tick().await; // boot pass just ran
        loop {
            tick.tick().await;
            resident_blob_scan(&s, crate::now_ms() as f64).await;
        }
    });

    // The 5s flush + window prune (server.ts flushSpanAppends, SAVE_INTERVAL_MS): settle anything
    // still buffered (ingest_post already flushes per payload) and prune the summarization window
    // by time — trimming memory is not data loss, every trimmed span is on disk.
    let s = state.clone();
    rt.spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        loop {
            tick.tick().await;
            if let Ok(mut st) = s.lock_timed() {
                if st.writer.pending_appends() > 0 {
                    st.flush_spans();
                }
                st.prune_window(crate::now_ms());
            }
        }
    });

    // The account-state timeline's flush window (TRDD-YQZ9P8IL; the TS's own 60s unref'd timer,
    // `AGENTLENS_ACCOUNT_STATE_FLUSH_MS`). The 4s burn tick only ENQUEUES on a discrete state
    // change; the append+fsync happens here, once per window per batch, so a rotation storm costs
    // one fsync instead of one per change. A kill -9 mid-window loses at most this window's
    // changes and never a flushed record — alcore's graceful exit flushes again on the way out.
    let s = state.clone();
    // `Math.max(1000, Number(env) || 60_000)`, ported exactly. Two JS details are load-bearing and
    // an obvious-looking Rust version gets both wrong: an explicit `0` is FALSY, so it means the
    // DEFAULT rather than "no delay"; and a NEGATIVE value is TRUTHY, so it survives the `||` and
    // is clamped by the floor to 1000 — parsing into an unsigned type would reject it and silently
    // yield 60_000 instead. `i64` keeps both. ("NaN" fails to parse either way, which is the
    // correct answer here and is NOT true of `parse::<f64>()`.)
    let account_flush = std::env::var("AGENTLENS_ACCOUNT_STATE_FLUSH_MS")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|ms| *ms != 0)
        .unwrap_or(60_000)
        .max(1000) as u64;
    rt.spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(account_flush));
        loop {
            tick.tick().await;
            if let Ok(mut st) = s.lock_timed() {
                st.account_timeline.flush();
            }
        }
    });

    // The 30s lifecycle heartbeat (server.ts:1730, TRDD-PJC8N1HO spec 2): a crash then leaves
    // lastHeartbeat as a truthful downtime-gap boundary. The TS pairs this with scheduleDurableSave;
    // the Rust durable cadences live on the sweeper thread (P5e), so only the heartbeat is here.
    let s = state.clone();
    rt.spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        tick.tick().await; // boot just wrote the start marker
        loop {
            tick.tick().await;
            if let Ok(mut st) = s.lock_timed() {
                let file = crate::collector_lifecycle::lifecycle_file(&st.data_dir);
                crate::collector_lifecycle::record_heartbeat(&file, &mut st.lifecycle, crate::now_ms());
            }
        }
    });

    // The 60s statusline seal (server.ts:1004). Sealing runs DuckDB over whole WALs, so it
    // deliberately shares only the root path + the Arc'd counters with the store, NEVER the state
    // lock — a seal must not stall every reader for the length of a re-encode.
    let (sl_root, sl_counters) = {
        let Ok(st) = state.lock_timed() else { return };
        (st.statusline.root.clone(), st.statusline.counters.clone())
    };
    let sl_vars: std::collections::HashMap<String, String> = std::env::vars().collect();
    rt.spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        loop {
            tick.tick().await;
            let (root, counters, vars) = (sl_root.clone(), sl_counters.clone(), sl_vars.clone());
            let _ = tokio::task::spawn_blocking(move || {
                crate::statusline_store::maybe_seal(&root, &counters, &vars, crate::now_ms() as f64)
            })
            .await;
        }
    });

    // Periodic hook-spool drain (TRDD-L6V1UUW0): the boot-only drain above never re-runs while
    // the server stays up, so an event spooled AFTER boot (e.g. `agentlenspro hook` hitting a
    // 1s timeout during a stall, TRDD-2R36W8Q1) sat forever until the next restart — measured
    // 2026-09-02: 28 files spooled, 0 drained in 40 minutes of uptime. Parity with the retired TS
    // server's `HOOK_SPOOL_DRAIN_MS` (default 30s, `Math.max(5_000, ...)` floor), same env-parsing
    // shape as `account_flush` above. The 200-file-per-tick cap (see `drain_hook_spool`'s doc) is
    // what keeps this safe to run on the same lock the request handlers use.
    let hook_spool_drain_ms = std::env::var("AGENTLENS_HOOK_SPOOL_DRAIN_MS")
        .ok()
        .and_then(|v| v.parse::<i64>().ok())
        .filter(|ms| *ms != 0)
        .unwrap_or(30_000)
        .max(5_000) as u64;
    let s = state.clone();
    rt.spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(hook_spool_drain_ms));
        tick.tick().await; // boot pass already drained; wait a full period before the first tick
        loop {
            tick.tick().await;
            let mut st = s.lock_timed().unwrap_or_else(|e| e.into_inner());
            let now = crate::now_ms();
            let d = crate::hook_events::drain_hook_spool(&mut st, now, 200);
            log_spool_drain(&d);
        }
    });

    // TRDD-2JOIAH2G — the 60s composition tick. Crash-loop forensics: the RSS guard kills at 2 GiB
    // while exit stats say post-GC committed == peak, so what matters is naming the LIVE bytes.
    // One tick, on the blocking pool (the serialization half moves real bytes); a skipped or
    // overlapping tick costs one missing line, which is fine for a 60s diagnostic.
    let s = state.clone();
    rt.spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        tick.tick().await; // boot pass ran inline below
        loop {
            tick.tick().await;
            let s2 = s.clone();
            let _ = tokio::task::spawn_blocking(move || composition_tick(&s2)).await;
        }
    });
    composition_tick(&state); // boot pass, inline — matches every other chore's boot-then-interval shape

    // TRDD-2JOIAH2G — the abandoned-sweep chore: control ONCE at boot, then the 60s interval.
    // Same blocking-pool shape as the other spawn_blocking chores; one task awaiting each tick
    // means no overlap guard is needed (same construction as resident_blob_scan above). The
    // control itself spawns a GENUINELY NEW OS thread for its ballast (pool threads are
    // reused, and thread DEATH is the mechanism under test — the allocating thread must
    // actually die); `pages_abandoned` is a process-global stat, so the reading thread's
    // identity does not matter.
    let s = state.clone();
    rt.spawn(async move {
        let _ = tokio::task::spawn_blocking(abandoned_control_pass).await;
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        tick.tick().await; // the first tick fires immediately — boot did the control, skip to 60s
        loop {
            tick.tick().await;
            let s2 = s.clone();
            let _ = tokio::task::spawn_blocking(move || abandoned_sweep_tick(&s2)).await;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{collect_drop_pct, composition_line, control_passes};

    #[test]
    fn composition_line_subtracts_window_est_from_commit() {
        let line = composition_line(2048, 1800, 5000, 400, 32_000, 120, 0, Some(500), Some(300));
        assert_eq!(
            line,
            "alcore: composition: mimalloc commit 2048 MB, process rss 1800 MB, \
             window.spans 5000 (~400 MB sampled est), summary-cache 500 MB, \
             stripped-cache 300 MB, card rows 32000 (~120 MB text, \
             DuckDB own allocator, limit 256 MiB), derived slack = commit - window est = 1648 MB"
        );
    }

    #[test]
    fn composition_line_prefix_is_exact() {
        assert!(composition_line(1, 1, 0, 0, 0, 0, 0, None, None).starts_with("alcore: composition:"));
    }

    #[test]
    fn composition_line_none_reports_none_not_zero() {
        // `None` (nothing cached) must print as `none`, never `0 MB` — "zero bytes" and
        // "nothing cached" are different facts and the line must not blur them.
        let line = composition_line(100, 90, 1000, 400, 10, 5, 0, None, None);
        assert!(line.contains("summary-cache none MB"), "{line}");
        assert!(line.contains("stripped-cache none MB"), "{line}");
        assert!(line.ends_with("derived slack = commit - window est = 0 MB"), "{line}");
    }

    #[test]
    fn composition_line_zero_window_yields_full_commit_as_slack() {
        let line = composition_line(2048, 1800, 0, 0, 10, 5, 0, None, None);
        assert!(line.ends_with("derived slack = commit - window est = 2048 MB"), "{line}");
    }

    #[test]
    fn collect_drop_pct_normal_drop() {
        assert_eq!(collect_drop_pct(1024, 512), (512, 50));
    }

    #[test]
    fn collect_drop_pct_after_ge_before_yields_zero() {
        // after == before and after > before are both "the collect freed nothing" — must be (0,0),
        // no underflow, no panic.
        assert_eq!(collect_drop_pct(512, 512), (0, 0));
        assert_eq!(collect_drop_pct(512, 600), (0, 0));
    }

    #[test]
    fn collect_drop_pct_before_zero_yields_zero() {
        assert_eq!(collect_drop_pct(0, 0), (0, 0));
    }

    #[test]
    fn control_passes_at_30_page_boundary() {
        // Geometry-derived threshold (round-90): 200 x 512 KiB in 2 MiB large pages = ~50
        // pages; the bar sits at 30 — clear of read-noise, below the dominant-geometry
        // expectation. Exactly 30 passes, 29 fails. The delta is signed: a shrinking pool
        // (sweep churn racing the control) fails too.
        assert!(control_passes(30));
        assert!(control_passes(50));
        assert!(!control_passes(29));
        assert!(!control_passes(0));
        assert!(!control_passes(-5));
    }
}

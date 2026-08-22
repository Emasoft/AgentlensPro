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

use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::Value;

use crate::CoreState;

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
    let Ok(mut st) = state.lock() else { return };
    let data_dir = st.data_dir.clone();
    let days = crate::retention_config::resolve_knob(&data_dir, &crate::retention_config::SPANS_RETENTION_DAYS);
    let ran = with_chores_lock(&data_dir, || {
        let deleted = st.writer.run_retention(days, now_ms);
        if !deleted.is_empty() {
            let spans: u64 = deleted.iter().map(|d| d.spans).sum();
            println!("alcore: span retention: deleted {} segment(s), {spans} span(s)", deleted.len());
        }
        // `usize::MAX` = the whole backlog in one call, matching the TS default of `Infinity`.
        // The bounded-slice mode exists for a BOOT sweep (a 31-segment backlog held the TS
        // servers' ports closed for 3m40s); on the 24h tick there is nothing to keep responsive.
        // `under_pressure` is `false` here for the same reason — the RSS ratchet it guards is a
        // back-to-back boot sweep, not one steady-state tick.
        let c = st.writer.compress_sealed_segments(now_ms as i64, usize::MAX, &|| false);
        if !c.compressed.is_empty() {
            println!(
                "alcore: span compression: sealed {} segment(s), saved {:.1}MB",
                c.compressed.len(),
                c.bytes_saved as f64 / 1_048_576.0
            );
        }
        for w in &c.warnings {
            eprintln!("alcore: {w}");
        }
    });
    if ran.is_none() {
        // Not an error: the other engine holds the lock and is doing this work. Said out loud
        // anyway, because a chore that silently does nothing forever looks identical to a chore
        // that has nothing to do.
        eprintln!("alcore: span retention/compression skipped — another engine holds .chores.lock");
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
        let Ok(st) = state.lock() else { return };
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
                "alcore: {label} retention: purged {} bucket(s), {:.1}MB",
                removed.len(),
                freed as f64 / 1_048_576.0
            );
        }
    }

    let (removed, freed) = crate::statusline_store::purge(&sl_root, crate::statusline_store::retention_days(&vars), now_ms);
    if !removed.is_empty() {
        println!(
            "alcore: statusline retention: purged {} partition(s), {:.1}MB",
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
///
/// SINGLE TARGET, and that is a CONDITIONAL truth worth stating: the TS drains two dirs only in
/// SPOOL_MODE, and the spool gate is `OTLP_PORT === 4318`, which alcore is not (it binds 4319).
/// The day alcore takes 4318 this becomes wrong and the spool dir must join the drain.
fn bodies_pass(state: &Arc<Mutex<CoreState>>, now_ms: f64) {
    let data_dir = {
        let Ok(st) = state.lock() else { return };
        st.data_dir.clone()
    };
    // The LEGACY dir specifically, matching the TS's non-spool drain target — NOT
    // `burn::guard::default_bodies_dir`, which prefers a configured spool and would drain
    // something this chore has no mandate over.
    let bodies_dir = data_dir.join("otel-bodies");
    if !bodies_dir.exists() {
        return;
    }
    let store_dir = data_dir.join("store");

    let max_gb = crate::retention_config::resolve_knob(&data_dir, &crate::retention_config::BODIES_MAX_GB);
    let max_age_hours = crate::retention_config::resolve_knob(&data_dir, &crate::retention_config::BODIES_MAX_AGE_HOURS);
    let cap_bytes = (max_gb * 1024.0 * 1024.0 * 1024.0) as u64;

    // THE EMERGENCY VALVE (server.ts:667). Over the cap, ingest EVERYTHING (age 0) rather than
    // only what has aged out — otherwise a runaway producer outruns the drain and the dir grows
    // without bound while the pass politely skips every file that is not old enough yet.
    let over_cap = staged_body_bytes(&bodies_dir) > cap_bytes;
    let max_age_ms = if over_cap { 0 } else { (max_age_hours * 3_600_000.0) as i64 };

    // The lock spans load → ingest → save. Narrowing it to the ingest alone lets two engines
    // interleave a load and a save on .pass-state.json and silently drop names: a lost skip name
    // re-examines a body forever, a lost STRANDED name forgets a body that could not be
    // reconstructed — and that one loses data.
    let lock = match agentlens_store::pass::acquire_pass_lock(&store_dir) {
        Ok(f) => f,
        Err(agentlens_store::pass::PassLockErr::Busy) => return, // another engine owns this pass
        Err(agentlens_store::pass::PassLockErr::Io(e)) => {
            eprintln!("alcore: bodies pass cannot take the store lock: {e}");
            return;
        }
    };
    let threads = std::thread::available_parallelism().map(|n| n.get().saturating_sub(2).max(4)).unwrap_or(4);
    let mut store = match agentlens_store::open_store(&store_dir, agentlens_store::DEFAULT_MEMORY_LIMIT, threads) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("alcore: bodies pass cannot open the store: {e}");
            return;
        }
    };
    let state_file = store_dir.join(agentlens_store::pass::PASS_STATE_FILE);
    let (mut skip, mut stranded) = agentlens_store::pass::load_pass_state(&state_file);
    let mut fsynced = std::collections::HashSet::new();
    let opts = agentlens_store::pass::PassOptions {
        bodies_dir,
        max_age_ms,
        max_bytes_per_pass: ingest_max_bytes_per_pass(&std::env::vars().collect()),
        // The legacy dir is a DURABLE source (the TS target carries `durable: true`), which gates
        // the fsync barrier inside the pass: there IS something durable about the source to
        // protect. Only the volatile RAM spool sets this false.
        durable_source: true,
        ..Default::default()
    };
    let res = agentlens_store::pass::ingest_pass(&mut store, &opts, &mut skip, &mut stranded, &mut fsynced);
    agentlens_store::pass::save_pass_state(&state_file, &skip, &stranded);
    drop(lock);

    if res.ingested > 0 || res.deleted > 0 {
        println!(
            "alcore: bodies pass: ingested {}, deleted {}, freed {:.1}MB{}",
            res.ingested,
            res.deleted,
            res.bytes_freed as f64 / 1_048_576.0,
            if over_cap { " (OVER CAP — drained at age 0)" } else { "" }
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
            eprintln!("alcore: resident-blob scan error: {e}");
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
    if let Ok(mut st) = state.lock() {
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

/// Arm every recurring chore on `rt`. Called once from `main` after the state is built and before
/// the listeners bind. Boot-time passes run INLINE first (the TS calls each chore once at startup
/// before setting its interval), so a server that is restarted more often than a chore's period
/// still performs it.
pub fn spawn_all(rt: &tokio::runtime::Runtime, state: Arc<Mutex<CoreState>>) {
    // Boot passes, in the TS's order.
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

    // The bodies pass (server.ts:853). 1h, not the spool mode's 60s: BODIES_PASS_INTERVAL_MS is
    // `SPOOL_MODE ? 60_000 : 3600e3`, and alcore is not in spool mode (it binds 4319, not 4318).
    // On the blocking pool — a pass runs DuckDB ingestion and byte-for-byte reconstruction.
    let s = state.clone();
    rt.spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(3600));
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
            if let Ok(mut st) = s.lock() {
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
            if let Ok(mut st) = s.lock() {
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
            if let Ok(mut st) = s.lock() {
                let file = crate::collector_lifecycle::lifecycle_file(&st.data_dir);
                crate::collector_lifecycle::record_heartbeat(&file, &mut st.lifecycle, crate::now_ms());
            }
        }
    });

    // The 60s statusline seal (server.ts:1004). Sealing runs DuckDB over whole WALs, so it
    // deliberately shares only the root path + the Arc'd counters with the store, NEVER the state
    // lock — a seal must not stall every reader for the length of a re-encode.
    let (sl_root, sl_counters) = {
        let Ok(st) = state.lock() else { return };
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
}

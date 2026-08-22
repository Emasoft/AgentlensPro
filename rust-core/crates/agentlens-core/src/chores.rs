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

/// Arm every recurring chore on `rt`. Called once from `main` after the state is built and before
/// the listeners bind. Boot-time passes run INLINE first (the TS calls each chore once at startup
/// before setting its interval), so a server that is restarted more often than a chore's period
/// still performs it.
pub fn spawn_all(rt: &tokio::runtime::Runtime, state: Arc<Mutex<CoreState>>) {
    // Boot passes, in the TS's order.
    span_tick(&state, crate::now_ms() as f64);
    purge_tick(&state, crate::now_ms() as f64);

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

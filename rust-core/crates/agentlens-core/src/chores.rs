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
    let mut st = state.lock_timed();
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
        let st = state.lock_timed();
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

/// The bodies store, opened ONCE per process and kept (TRDD-2HRA270Y step 3). open_store rebuilds
/// the in-memory dedup tables (known_blob, part_file, body_durable, about 1 GB on the real store)
/// from every parquet part, and the bodies pass used to pay that on every 60s tick. Now the
/// bodies pass (lazily, after the idle exit, `.pass.lock` and the HEAVY slot), export and purge (through
/// `bodies_store_open_or_get`) open it on first use, and each tick refreshes it with `sync_new_parts`.
/// Export reads through the `reader` connection; purge borrows the writer with try_lock.
///
/// KEYED BY `store_dir`: a call for a different store dir drops the open store and reopens.
/// Production has one data dir; the test binaries run tests in parallel threads with one data dir
/// each, and serving one test's dedup tables to another would be wrong.
///
/// LOCK ORDER: `.pass.lock`, then HEAVY, then the slot (briefly), then the writer mutex, then
/// FSYNCED_PARTS. Export holds only the reader mutex and nothing waits for the writer while holding
/// the reader. Purge only try_locks the writer, so it can never deadlock with a pass.
struct SharedBodiesStore {
    store_dir: PathBuf,
    writer: Arc<Mutex<agentlens_store::Store>>,
    reader: Arc<Mutex<agentlens_store::StoreReader>>,
}

static BODIES_STORE: Mutex<Option<SharedBodiesStore>> = Mutex::new(None);
static BODIES_STORE_OPENS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The handles a caller of the shared store gets: the writer (bodies pass, purge) and the reader
/// (export). Both point at the one store the slot holds (TRDD-2HRA270Y step 3).
#[derive(Clone)]
pub struct BodiesStoreHandles {
    pub writer: Arc<Mutex<agentlens_store::Store>>,
    pub reader: Arc<Mutex<agentlens_store::StoreReader>>,
}

type RetiredStore = (std::sync::Weak<Mutex<agentlens_store::Store>>, std::sync::Weak<Mutex<agentlens_store::StoreReader>>);
/// The weak handles of the store that drop_poisoned_bodies_store last released (TRDD-2HRA270Y step 3,
/// F3). Releasing the slot does not free the database while a caller still holds a clone (export holds
/// the reader, purge the writer), and a reader connection keeps the same in-memory DuckDB alive. A second
/// open while either handle still upgrades would run two ~1 GB instances spilling into one store/tmp.
static RETIRED_STORE: Mutex<Option<RetiredStore>> = Mutex::new(None);

fn bodies_slot() -> std::sync::MutexGuard<'static, Option<SharedBodiesStore>> {
    // The slot only holds Arcs and is never held across store work, so a poison here carries no
    // half-done state; the store mutexes have their own poison handling (drop_poisoned_bodies_store).
    BODIES_STORE.lock().unwrap_or_else(|e| e.into_inner())
}

/// Test-only: how many times this process has opened the shared bodies store.
pub fn bodies_store_opens_for_test() -> u64 {
    BODIES_STORE_OPENS.load(std::sync::atomic::Ordering::SeqCst)
}

/// Test-only: poison the writer mutex of the open store for `store_dir` (a thread panics while
/// holding it), to drive the poison path. No-op when that store is not open.
pub fn poison_bodies_store_writer_for_test(store_dir: &Path) {
    if let Some(w) = bodies_store_writer(store_dir) {
        let _ = std::thread::spawn(move || {
            let _g = w.lock();
            panic!("poisoning the bodies store writer for a test");
        })
        .join();
    }
}

/// A poisoned writer or reader mutex means a thread panicked mid-operation, so the store's tables
/// may be half-updated. Drop the shared store and let the next bodies pass reopen it from the
/// parquet parts, the only durable truth (TRDD-2HRA270Y step 3, A6).
pub fn drop_poisoned_bodies_store(which: &str) {
    eprintln!(
        "{} alcore: bodies store {which} mutex is POISONED — dropping the shared store; the next bodies pass reopens it (TRDD-2HRA270Y)",
        crate::log_ts()
    );
    // WHY keep Weak handles (F3, TRDD-2HRA270Y step 3): an export or a purge may still hold a clone of
    // the released store, and dropping the slot does not free the database while one exists. Recording
    // the Weaks lets open_shared_bodies_writer refuse a second open until they are gone.
    let released = bodies_slot().take();
    if let Some(old) = released {
        *RETIRED_STORE.lock().unwrap_or_else(|e| e.into_inner()) = Some((Arc::downgrade(&old.writer), Arc::downgrade(&old.reader)));
    }
}

/// The writer of the open bodies store for `store_dir`, or None when it is not open.
pub fn bodies_store_writer(store_dir: &Path) -> Option<Arc<Mutex<agentlens_store::Store>>> {
    bodies_slot().as_ref().filter(|s| s.store_dir == store_dir).map(|s| s.writer.clone())
}

/// The reader of the open bodies store for `store_dir`, or None when it is not open.
pub fn bodies_store_reader(store_dir: &Path) -> Option<Arc<Mutex<agentlens_store::StoreReader>>> {
    bodies_slot().as_ref().filter(|s| s.store_dir == store_dir).map(|s| s.reader.clone())
}

/// The shared store handles for `store_dir`, opening the store when it is not open (TRDD-2HRA270Y step
/// 3, F1). Export and purge call this: an idle server runs no bodies pass, and a store that only a pass
/// opens would answer "not open" to both routes for the life of the process. None means a released
/// instance is still referenced (F3), and the caller answers 503.
pub fn bodies_store_open_or_get(store_dir: &Path) -> Result<Option<BodiesStoreHandles>, String> {
    open_shared_bodies_writer(store_dir, crate::cores::duckdb_threads())
}

/// The handles of the shared store for `store_dir`, opening it when it is not open (or open for another
/// dir). None means a released instance is still referenced (F3): the caller skips and retries later.
/// The open itself is serialized by the slot mutex, which is held across it.
fn open_shared_bodies_writer(store_dir: &Path, threads: usize) -> Result<Option<BodiesStoreHandles>, String> {
    let mut slot = bodies_slot();
    if let Some(s) = slot.as_ref().filter(|s| s.store_dir == store_dir) {
        return Ok(Some(BodiesStoreHandles { writer: s.writer.clone(), reader: s.reader.clone() }));
    }
    // WHY (F3, TRDD-2HRA270Y step 3): a released instance must be gone before a new one opens. Its
    // clones are released by the callers that still hold them, not by this function, so refuse while
    // either one still upgrades; the next tick (or request) retries.
    {
        let mut retired = RETIRED_STORE.lock().unwrap_or_else(|e| e.into_inner());
        if let Some((writer, reader)) = retired.as_ref() {
            if writer.upgrade().is_some() || reader.upgrade().is_some() {
                return Ok(None);
            }
        }
        *retired = None;
    }
    // Drop the other dir's store BEFORE opening, so two stores' tables are never resident at once.
    *slot = None;
    // STORE_MEMORY_LIMIT, not SERVER_MEMORY_LIMIT: open_store builds ART indexes on known_blob/body_durable that cannot spill, and at 512MiB the sha probe runs out of memory (measured 2026-10-22, TRDD-2HRA270Y).
    let store = agentlens_store::open_store(store_dir, agentlens_store::STORE_MEMORY_LIMIT, threads).map_err(|e| e.to_string())?;
    let reader = store.reader().map_err(|e| format!("cannot clone a reader connection: {e}"))?;
    BODIES_STORE_OPENS.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    let writer = Arc::new(Mutex::new(store));
    let reader = Arc::new(Mutex::new(reader));
    *slot = Some(SharedBodiesStore { store_dir: store_dir.to_path_buf(), writer: writer.clone(), reader: reader.clone() });
    Ok(Some(BodiesStoreHandles { writer, reader }))
}

/// Unreadable parts sync_new_parts already reported, so each is logged once, not every tick.
static SYNC_SKIPS_LOGGED: Mutex<Option<std::collections::HashSet<String>>> = Mutex::new(None);
/// The last "staging cleared" log line and when it was printed (one per distinct error or minute).
static LEFTOVER_LOGGED: Mutex<Option<(String, std::time::Instant)>> = Mutex::new(None);
/// Last time the "bodies store busy" and "still referenced by a released instance" lines were printed:
/// each is rate-limited to one line a minute, because the bodies pass retries every tick (TRDD-2HRA270Y).
static BUSY_LOGGED: Mutex<Option<std::time::Instant>> = Mutex::new(None);
static REOPEN_REFUSED_LOGGED: Mutex<Option<std::time::Instant>> = Mutex::new(None);

/// Consecutive failed saves of `.pass-state.json` (TRDD-ZR3OGSAV): the pass runs every 60s, so a
/// persistent failure (full disk) is logged on the first failure only, then counted and summarized on recovery.
/// Per PROCESS (one alcore = one data dir): any test forcing a save failure through bodies_pass must reset it.
static STATE_SAVE_FAILS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
/// Epoch ms of the last failed `.pass-state.json` save (0 = never), TRDD-5K0YLLEF. A successful save clears the
/// count but not this: the count answers "how many in a row now", this answers "when did the disk last refuse us".
static LAST_STATE_SAVE_FAIL_MS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// Consecutive ticks on which an unreadable `.pass-state.json` could not be moved aside (TRDD-FINMFYDE). The move is
/// retried every tick, so the failure is logged on its first tick only, counted while it persists, and the next readable load logs once.
/// Per PROCESS (one alcore = one data dir): any test forcing a move failure through bodies_pass must reset it.
static STATE_LOAD_FAILS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// The last bodies-pass reading (TRDD-HDUETCU7), held here and not in `CoreState`; `server_stats`
/// reads it through `bodies_pass_stats()`. The type is `crate::BodiesPassStats`.
// ponytail: this static is per PROCESS, not per data dir: alcore owns exactly one data dir (pid
// lock), so only a test binary running two passes over two dirs would see them summed; move it
// into `CoreState` if that ever matters.
static BODIES_PASS_STATS: Mutex<crate::BodiesPassStats> = Mutex::new(crate::BodiesPassStats {
    last_at_ms: 0,
    last_removed_files: 0,
    last_freed_bytes: 0,
    reclaimed_since_boot: 0,
    last_non_zero_pass_at_ms: 0,
});

/// A copy of the last bodies-pass reading (TRDD-HDUETCU7).
pub fn bodies_pass_stats() -> crate::BodiesPassStats {
    *BODIES_PASS_STATS.lock().unwrap_or_else(|e| e.into_inner())
}

/// `(consecutive failed .pass-state.json saves, epoch ms of the last failed save)`, read by `server_stats` (TRDD-5K0YLLEF).
/// Two separate loads, not one snapshot: a save can land between them. The reader is a diagnostic, so that skew is harmless.
pub fn state_save_failures() -> (u64, u64) {
    (STATE_SAVE_FAILS.load(std::sync::atomic::Ordering::Relaxed), LAST_STATE_SAVE_FAIL_MS.load(std::sync::atomic::Ordering::Relaxed))
}

/// Test-only: zero both counters so a test that forces a save failure starts from a known state (TRDD-5K0YLLEF).
pub fn reset_state_save_failures_for_test() {
    STATE_SAVE_FAILS.store(0, std::sync::atomic::Ordering::Relaxed);
    LAST_STATE_SAVE_FAIL_MS.store(0, std::sync::atomic::Ordering::Relaxed);
}
/// Record one COMPLETED pass (TRDD-HDUETCU7). The TS overwrote its last-pass object on every pass,
/// an empty one included. Only `bodies_pass` calls this, and only on the paths that ran a pass (or
/// found nothing staged): the other early exits did not run one, so they must not claim one, and
/// they delete nothing, so no count is lost.
fn record_bodies_pass(now_ms: f64, deleted: u64, bytes_freed: u64) {
    let mut s = BODIES_PASS_STATS.lock().unwrap_or_else(|e| e.into_inner());
    s.last_at_ms = now_ms as i64;
    s.last_removed_files = deleted;
    s.last_freed_bytes = bytes_freed;
    s.reclaimed_since_boot += deleted;
    if deleted > 0 {
        s.last_non_zero_pass_at_ms = now_ms as i64;
    }
}

/// Print `msg` unless the same kind of line was printed in the last minute (TRDD-2HRA270Y). The bodies
/// pass retries every tick, so an unrepeated line per tick would flood server.log.
fn log_at_most_once_a_minute(last: &Mutex<Option<std::time::Instant>>, msg: &str) {
    let mut last = last.lock().unwrap_or_else(|e| e.into_inner());
    if matches!(*last, Some(at) if at.elapsed() < Duration::from_secs(60)) {
        return;
    }
    eprintln!("{} alcore: {msg}", crate::log_ts());
    *last = Some(std::time::Instant::now());
}

/// Log what one sync_new_parts call found: each unreadable part once, and the count of part files that
/// vanished whenever it is nonzero (TRDD-2HRA270Y step 3, F4).
fn log_sync_outcome(sync: &agentlens_store::SyncStats) {
    let mut logged = SYNC_SKIPS_LOGGED.lock().unwrap_or_else(|e| e.into_inner());
    let logged = logged.get_or_insert_with(Default::default);
    for (file, err) in &sync.skipped {
        if logged.insert(file.clone()) {
            eprintln!("{} alcore: bodies pass: cannot load new part {file}, retrying next tick: {err}", crate::log_ts());
        }
    }
    let removed: u64 = sync.removed_files.iter().sum();
    if removed > 0 {
        eprintln!("{} alcore: bodies store: {removed} part file(s) vanished; their dedup rows were removed (TRDD-2HRA270Y)", crate::log_ts());
    }
}

/// The idle tick share of the shared store (TRDD-2HRA270Y step 3, F5). It refreshes a store that is
/// already open and NEVER opens one (chores_bodies_empty_dir_skips_store_open). Nothing here waits: the
/// pass lock, the HEAVY slot and the writer are all try-taken, and a busy one skips the refresh until the
/// next tick. Lock order is the same as bodies_pass: .pass.lock, HEAVY, the slot (briefly), the writer.
fn sync_open_store_idle(store_dir: &Path) {
    static SKIPS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let Some(writer) = bodies_store_writer(store_dir) else {
        return;
    };
    let _lock = match agentlens_store::pass::acquire_pass_lock(store_dir) {
        Ok(f) => f,
        Err(agentlens_store::pass::PassLockErr::Busy) => return,
        Err(agentlens_store::pass::PassLockErr::Io(e)) => {
            eprintln!("{} alcore: idle bodies sync cannot take the store lock: {e}", crate::log_ts());
            return;
        }
    };
    let Some(_heavy) = agentlens_store::transcript_sql::acquire_heavy_for_chore("bodies sync", &SKIPS) else {
        return;
    };
    let mut store = match writer.try_lock() {
        Ok(g) => g,
        Err(std::sync::TryLockError::WouldBlock) => return,
        Err(std::sync::TryLockError::Poisoned(_)) => {
            drop_poisoned_bodies_store("writer");
            return;
        }
    };
    match agentlens_store::sync_new_parts(&mut store) {
        Ok(sync) => log_sync_outcome(&sync),
        Err(e) => eprintln!("{} alcore: idle bodies sync cannot sync new store parts: {e}", crate::log_ts()),
    }
}

/// Test-only introspection: there is no other way for an integration test to observe that the
/// fsync barrier skipped an already-proven part rather than re-fsyncing it, since `ingest_pass`
/// reports no per-part counters. Returns a snapshot (cloned, so the lock is never held past this
/// call) of every parquet part this process has fsynced so far via `bodies_pass`.
pub fn fsynced_parts_snapshot_for_test() -> std::collections::HashSet<PathBuf> {
    FSYNCED_PARTS.get().map(|m| m.lock().unwrap_or_else(|e| e.into_inner()).clone()).unwrap_or_default()
}

/// A spill file older than this belongs to no live query (queries are seconds long).
pub const SPILL_MAX_AGE: Duration = Duration::from_secs(3600);

/// The DuckDB spill directories, relative to the data dir: `agentlens_store::open_store`,
/// `statusline_store::open_duck`, `SessionSummarySql` (the transcript/evidence connections use
/// the store one).
const SPILL_DIRS: [&str; 3] = ["store/tmp", "statusline/tmp", "tmp/session-summary"];

/// Unlink the files in the spill dirs: all of them when `max_age` is None (boot), else only those
/// older than `max_age`. Returns the count removed. Missing dirs are fine. DuckDB spill files from
/// a killed process are never cleaned by DuckDB itself, so without this a crash loop fills the disk.
pub fn clean_spill_dirs(data_dir: &Path, max_age: Option<Duration>) -> usize {
    clean_spill_dirs_except(data_dir, max_age, &[])
}

/// The periodic (age-based) spill cleanup. Skips `store/tmp` while the shared bodies store is open
/// for this data dir (TRDD-2HRA270Y step 3): that DuckDB now lives for the whole process and keeps
/// its spill blocks there, so an mtime rule cannot tell a dead file from a live one. Boot cleanup
/// (clean_spill_dirs with None) still empties it, and max_temp_directory_size bounds it meanwhile.
pub fn clean_spill_dirs_periodic(data_dir: &Path) -> usize {
    let skip: &[&str] = if bodies_store_writer(&data_dir.join("store")).is_some() { &["store/tmp"] } else { &[] };
    clean_spill_dirs_except(data_dir, Some(SPILL_MAX_AGE), skip)
}

/// Total bytes of the files directly in `dir` (0 when missing).
fn dir_file_bytes(dir: &Path) -> u64 {
    std::fs::read_dir(dir)
        .map(|rd| rd.flatten().filter_map(|e| e.metadata().ok()).filter(|m| m.is_file()).map(|m| m.len()).sum())
        .unwrap_or(0)
}

fn clean_spill_dirs_except(data_dir: &Path, max_age: Option<Duration>, skip: &[&str]) -> usize {
    let mut removed = 0;
    for sub in SPILL_DIRS.into_iter().filter(|s| !skip.contains(s)) {
        let Ok(rd) = std::fs::read_dir(data_dir.join(sub)) else { continue };
        for e in rd.flatten() {
            let Ok(meta) = e.metadata() else { continue };
            if !meta.is_file() {
                continue;
            }
            let old_enough = match max_age {
                None => true,
                Some(age) => meta.modified().ok().and_then(|m| m.elapsed().ok()).is_some_and(|el| el > age),
            };
            if old_enough && std::fs::remove_file(e.path()).is_ok() {
                removed += 1;
            }
        }
    }
    removed
}

pub fn bodies_pass(state: &Arc<Mutex<CoreState>>, now_ms: f64) {
    let (data_dir, tap, no_collection) = {
        let st = state.lock_timed();
        (st.data_dir.clone(), st.spool_tap.clone(), st.no_collection)
    };
    // TRDD-RBBEX59R no-collection mode: no raw-body pass at all — no drain into the store and no
    // tap.body call (this pass is its only caller). The boot call and the 60 s timer both land here.
    // The burn-tick body scan (ui.rs) is a separate guard input and is not affected.
    if no_collection {
        return;
    }
    // The ONE bodies dir, `<data>/otel-bodies` — capture writes straight to it (TRDD-Z53IJFE9
    // step D removed the RAM-disk spool that this chore used to drain alongside it, and with the
    // spool went the free-space back-pressure valve: it existed to relieve a 2GB RAM disk that
    // filled in minutes, a hazard the SSD dir does not have — `bodiesMaxGb`'s over-cap valve
    // below still guards it).
    let scope = crate::burn::guard::resolve_bodies_read_scope(&data_dir);

    // WHY no capture switch here: raw-body capture is mandatory (owner order 2026-10-02), so outside
    // no-collection mode the sink probe, the drain and the over-cap valve below run on every tick
    // unconditionally. The old opt-in gated only this probe (never the drain), so a fresh install
    // silently skipped the one check that says "the capture dir is not writable". The ONE exception
    // is no-collection mode (TRDD-RBBEX59R), which returns before all of it, above.
    // server.ts:818-823 — the sink precondition, once per pass tick, warnings on TRANSITIONS
    // only (a per-tick repeat is filtered out by the day it matters). TRDD-U0L78B3Z.
    let problem = crate::server_stats::probe_sink(&crate::burn::guard::default_bodies_dir(&data_dir));
    {
        let mut st = state.lock_timed();
        if problem != st.sink_problem {
            match &problem {
                Some(p) => eprintln!("{} alcore: bodies sink precondition FAILED: {p} (TRDD-4FMHW124)", crate::log_ts()),
                None => eprintln!("{} alcore: bodies sink precondition recovered", crate::log_ts()),
            }
            st.sink_problem = problem;
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
    let store_dir = data_dir.join("store");
    if scope.dirs.iter().all(|d| staged_body_bytes(d) == 0) {
        // WHY (F5, TRDD-2HRA270Y step 3): an idle tick still refreshes a store that is already open, so
        // a part another writer added reaches the dedup tables without waiting for a busy tick. It never
        // opens the store (chores_bodies_empty_dir_skips_store_open pins that).
        sync_open_store_idle(&store_dir);
        // TRDD-HDUETCU7: an idle tick is a completed, empty pass. The TS overwrote its last-pass
        // object every pass; without this a healthy idle server shows a stale `at` that reads as
        // a dead chore.
        record_bodies_pass(now_ms, 0, 0);
        return;
    }

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
    // `MultiFileFunction<Parquet>` waits). Match the server's other in-process DuckDB uses:
    // threads = crate::cores::duckdb_threads() (TRDD-YH822LDI), memory_limit=STORE_MEMORY_LIMIT.
    let threads = crate::cores::duckdb_threads();
    // Timed from the store open, not the tick: TRDD-768NEX6E's acceptance wants one pass's wall
    // time on the log line. Since TRDD-2HRA270Y step 3 the store is opened once per process, so
    // only the first busy tick includes the parquet rebuild; later ticks time the sync and the pass.
    let started = std::time::Instant::now();
    // Same heavy-DuckDB slot as transcript/seismic queries (budget: card 256MB + ONE transient 1GB);
    // busy => skip this tick, the next one retries. Declared before `store` so it drops after it.
    static SKIPS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
    let Some(_heavy) = agentlens_store::transcript_sql::acquire_heavy_for_chore("bodies pass", &SKIPS) else {
        return;
    };
    // The shared store (see SharedBodiesStore for the lock order): opened on the first busy tick,
    // kept after. An open error leaves it unopened and the next tick retries.
    let handles = match open_shared_bodies_writer(&store_dir, threads) {
        Ok(Some(h)) => h,
        // WHY skip (F3, TRDD-2HRA270Y step 3): a released instance is still referenced, and a second
        // store would be a second ~1 GB DuckDB spilling into the same store/tmp. Retry on a later tick.
        Ok(None) => {
            log_at_most_once_a_minute(&REOPEN_REFUSED_LOGGED, "bodies store still referenced by a released instance; pass skipped (TRDD-2HRA270Y)");
            return;
        }
        Err(e) => {
            eprintln!("{} alcore: bodies pass cannot open the store: {e}", crate::log_ts());
            return;
        }
    };
    // WHY try_lock and not lock (F2, TRDD-2HRA270Y step 3): a purge holds the writer through a long
    // verify, and blocking here would keep HEAVY taken for that whole time and stall every dashboard
    // query. WouldBlock skips this tick: the staged bodies stay on disk and the next tick retries.
    // The guards already taken (HEAVY, .pass.lock) release when this function returns.
    let mut store = match handles.writer.try_lock() {
        Ok(g) => g,
        Err(std::sync::TryLockError::WouldBlock) => {
            log_at_most_once_a_minute(&BUSY_LOGGED, "bodies store busy (purge); pass skipped (TRDD-2HRA270Y)");
            return;
        }
        Err(std::sync::TryLockError::Poisoned(_)) => {
            drop_poisoned_bodies_store("writer");
            return;
        }
    };
    // Refresh the dedup tables with parts another writer (alstore pass/ingest) added since the last
    // tick. Under `.pass.lock`, so no locked writer is mid-write; an unreadable file is skipped and
    // retried next tick, logged once.
    match agentlens_store::sync_new_parts(&mut store) {
        Ok(sync) => log_sync_outcome(&sync),
        Err(e) => {
            eprintln!("{} alcore: bodies pass cannot sync new store parts: {e}", crate::log_ts());
            return;
        }
    }
    let state_file = store_dir.join(agentlens_store::pass::PASS_STATE_FILE);
    // WHY move the file aside and rebuild it, rather than skip the tick (TRDD-FINMFYDE): the save at the end of
    // this pass writes its sets over the state file, so an unreadable file must not stay where that save can
    // overwrite it, and it must not be read as empty and silently lose its bookkeeping. Moving it aside keeps the
    // bytes for inspection, and the pass starts from empty sets. That is safe: a skip name is only a shortcut,
    // because the delete gate re-reads the store and the body before any delete, and a stranded name is routed to
    // that same gate. Only a failed move skips the tick, because then the unreadable file is still in place for the
    // save to overwrite. An idle tick returns earlier and never reaches this load, so it never reads the state.
    let (mut skip, mut stranded) = match agentlens_store::pass::load_pass_state(&state_file) {
        Ok(sets) => {
            let n = STATE_LOAD_FAILS.swap(0, std::sync::atomic::Ordering::Relaxed);
            if n > 0 {
                eprintln!("{} alcore: bodies pass: pass state {} is readable again after {n} ticks it could not be moved aside", crate::log_ts(), state_file.display());
            }
            sets
        }
        Err(e) => {
            let aside = std::path::PathBuf::from(format!("{}.corrupt-{}", state_file.display(), crate::now_ms()));
            match std::fs::rename(&state_file, &aside) {
                Ok(()) => {
                    // The loud line below reports this move, so a count of failed moves starts over.
                    STATE_LOAD_FAILS.store(0, std::sync::atomic::Ordering::Relaxed);
                    eprintln!("{} alcore: bodies pass: cannot read the pass state ({e}); moved it aside to {} and rebuilt it from empty", crate::log_ts(), aside.display());
                    (Default::default(), Default::default())
                }
                Err(move_err) => {
                    if STATE_LOAD_FAILS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) == 0 {
                        eprintln!("{} alcore: bodies pass skipped (repeats suppressed until it recovers): cannot read the pass state ({e}) and cannot move it aside to {}: {move_err}", crate::log_ts(), aside.display());
                    }
                    return;
                }
            }
        }
    };
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
    // Staging rows a previous tick's failed flush left behind: flush them, or clear them when that
    // fails again (the sources are still on disk and re-ingest). Staging never grows across ticks.
    // Runs while FSYNCED_PARTS is held; the parts it writes are fsynced by the settle barrier
    // (pass.rs sweeps all four part dirs) before any source is deleted.
    match agentlens_store::flush_or_clear_leftovers(&mut store) {
        Ok(agentlens_store::Leftovers::Cleared(e)) => {
            let mut last = LEFTOVER_LOGGED.lock().unwrap_or_else(|p| p.into_inner());
            let repeat = last.as_ref().is_some_and(|(prev, at)| *prev == e && at.elapsed() < Duration::from_secs(60));
            if !repeat {
                eprintln!("{} alcore: bodies pass: staging cleared after a failed flush (sources stay on disk and re-ingest): {e}", crate::log_ts());
                *last = Some((e, std::time::Instant::now()));
            }
        }
        Ok(_) => {}
        Err(e) => {
            eprintln!("{} alcore: bodies pass cannot flush or clear leftover staging: {e}", crate::log_ts());
            return;
        }
    }
    let max_bytes_per_pass = ingest_max_bytes_per_pass(&std::env::vars().collect());

    let mut ingested = 0u64;
    let mut deleted = 0u64;
    let mut bytes_freed = 0u64;
    let mut reemitted = 0u64;
    let mut failed = 0u64;
    let mut any_over_cap = false;

    // ONE prune per tick across ALL bodies dirs: the name sets are shared by every dir, so a per-dir prune
    // would drop the other dirs names. Runs inside the pass lock (taken above) and after the load.
    if let Some(line) = agentlens_store::pass::prune_pass_names(&scope.dirs, &mut skip, &mut stranded) {
        eprintln!("{} alcore: bodies pass: {line}", crate::log_ts());
    }
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
            // SPOOL TAP: the API-body receive point. Claude Code writes the body files itself, so
            // this pass is the only place alcore ever holds their text; `ingest_pass_observed` calls
            // the observer with the text it already read, and only AFTER the store accepted the file
            // (a file the pass retries is therefore spooled once). Bodies ingested before the tap was
            // switched on are not spooled: backfilling them is a separate step.
            // Installed only when the `bodies` source is enabled (it is off by default: disk growth).
            let body_tap = tap.as_ref().filter(|t| t.wants("bodies"));
            let mut tap_observer = |name: &str, raw: &str| {
                if let Some(tap) = body_tap {
                    tap.body(name, raw);
                }
            };
            let observer: Option<&mut agentlens_store::pass::BodyObserver<'_>> = if body_tap.is_some() { Some(&mut tap_observer) } else { None };
            // QSFYIHUO step 2 (S6 wiring): the prefix extractor is threaded HERE, at the one
            // production ingest site, so request rows carry their serialized TurnPrefix before the
            // settle gate deletes the body file. A future caller that bypasses this site writes
            // NULL prefix rows and the read site falls back to the body scan — the wiring test
            // (tests/chores_prefix_wiring.rs) pins this exact construction.
            let mut prefix_extractor = |parsed: Option<&Value>| -> Option<String> {
                let p = crate::cache_break_timeline::extract_turn_prefix(parsed)?;
                Some(crate::turn_prefix_codec::to_prefix_json(&p))
            };
            // QSFYIHUO step 3: the raw-facts extractor, threaded at the same one production site.
            // Wraps the hoisted store-side extractor with the same 6 MiB bound scan_request uses.
            let mut raw_facts_extractor = |raw: &str| {
                crate::burn::investigator_scan::extract_raw_facts(raw, 6 * 1024 * 1024)
            };
            // TRDD-2HRA270Y: taken with the store in hand, immediately before the first ingest pass of the
            // process; the window to the existing `first_bodies_ingest` reading is that one pass.
            static FIRST_INGEST_START: std::sync::Once = std::sync::Once::new();
            FIRST_INGEST_START.call_once(|| crate::rss_guard::log_boot_phase("first_ingest_start", None));
            let res = agentlens_store::pass::ingest_pass_observed_with(
                &mut store,
                &opts,
                &mut skip,
                &mut stranded,
                &mut fsynced,
                observer,
                Some(&mut prefix_extractor),
                Some(&mut raw_facts_extractor),
            );
            ingested += res.ingested;
            // TRDD-2HRA270Y: one boot-phase reading after the first ingest of the process returns.
            static FIRST_INGEST: std::sync::Once = std::sync::Once::new();
            FIRST_INGEST.call_once(|| crate::rss_guard::log_boot_phase("first_bodies_ingest", None));
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
    // TRDD-ZR3OGSAV: this tick's deletions already ran, so a failed save cannot be rolled back and the
    // tick cannot return an error. WHY state-change-only: the pass ticks every 60s, so a full disk would
    // otherwise repeat this line forever; log the first failure, count repeats, log recovery once.
    // Real risk of a lost save (the next tick RELOADS the old file from disk, nothing stays in memory):
    // a body never reaches the delete gate on the strength of these name sets — the gate re-verifies
    // the content against the store (verify_bodies_in_store + content_unchanged_since_read) — so no
    // unverified body is deleted. The loss is wasted work: skip names are forgotten (bodies re-ingested,
    // dedup makes that a no-op), a pending stranded->skip move or prune is redone. Stranded names are
    // only consulted for `relocate_stranded_to`, which this chore never sets. And on a full disk this
    // very log line may itself be lost.
    match agentlens_store::pass::save_pass_state(&state_file, &skip, &stranded) {
        Err(e) => {
            // TRDD-5K0YLLEF: stamped on EVERY failure, not only the first one the log prints, so the time is the LAST failure.
            LAST_STATE_SAVE_FAIL_MS.store(now_ms as u64, std::sync::atomic::Ordering::Relaxed);
            if STATE_SAVE_FAILS.fetch_add(1, std::sync::atomic::Ordering::Relaxed) == 0 {
                eprintln!("{} alcore: bodies pass: FAILED to persist {} (repeats suppressed until it recovers): {e}", crate::log_ts(), state_file.display());
            }
        }
        Ok(()) => {
            let n = STATE_SAVE_FAILS.swap(0, std::sync::atomic::Ordering::Relaxed);
            if n > 0 {
                eprintln!("{} alcore: bodies pass: persisting {} recovered after {n} failed saves", crate::log_ts(), state_file.display());
            }
        }
    }
    // Release in reverse lock order (FSYNCED_PARTS, writer, then `.pass.lock`); the store itself
    // stays open in the slot for the next tick.
    drop(fsynced);
    drop(store);
    drop(lock);
    // TRDD-HDUETCU7: publish the real counts (the locals used to reach only the log line below).
    record_bodies_pass(now_ms, deleted, bytes_freed);

    // `failed` is in the line because "deleted" alone cannot distinguish a drained legacy park
    // from one that failed verify and is now re-examined every tick (TRDD-6SPXOV0P review): the
    // PARKED gauge reads the state file, which the drain empties BEFORE the gate decides.
    if ingested > 0 || deleted > 0 || failed > 0 {
        println!(
            "{} alcore: bodies pass: ingested {}, deleted {} ({} of them re-emitted), failed {}, freed {:.1}MB across {} dir(s) in {} ms, store spill {:.1}MB{}",
            crate::log_ts(),
            ingested,
            deleted,
            reemitted,
            failed,
            bytes_freed as f64 / 1_048_576.0,
            scope.dirs.len(),
            started.elapsed().as_millis(),
            // TRDD-2HRA270Y step 3 (A7): the long-lived store keeps its spill files, so their size
            // is reported where an operator already looks.
            dir_file_bytes(&store_dir.join(agentlens_store::TMP_DIR)) as f64 / 1_048_576.0,
            if any_over_cap { " (OVER CAP — drained at age 0)" } else { "" }
        );
    }
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
    {
        let mut st = state.lock_timed();
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
/// TRDD-RBBEX59R: one hook-spool drain pass, run ONLY on the hook write path (mode off AND capture
/// on); `None` = skipped. Both drain callers (boot and the periodic tick) go through here. Without
/// the check the ring-only path would re-ingest every kept spool file on every tick: the drain keeps
/// a file whose ingest appended nothing, so each tick would push it into the ring again with `ts`
/// set to now, and the gate would count stale events as fresh.
pub fn spool_drain_tick(st: &mut CoreState, now_ms: i64, max_files: usize) -> Option<crate::hook_events::SpoolDrain> {
    if crate::hook_events::hook_ring_only_reason(st).is_some() {
        return None;
    }
    Some(crate::hook_events::drain_hook_spool(st, now_ms, max_files))
}
fn log_spool_drain(d: &crate::hook_events::SpoolDrain) {
    if *d != crate::hook_events::SpoolDrain::default() {
        println!(
            "{} alcore: hook-spool: drained {} event(s), quarantined {} bad, kept {} unverified, kept {} for retry",
            crate::log_ts(),
            d.drained, d.rejected, d.unverified, d.kept
        );
    }
}

/// TRDD-2JOIAH2G — what the composition line reports for one derived cache: a session COUNT, read
/// under the state lock, never a serialized size. Three states because "absent" and "present but
/// uncountable" are different facts: `Absent` prints `none`, and nothing else may.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheSessions {
    /// No cached value (cold boot, or the cache was taken by an in-flight rebuild).
    Absent,
    /// A cached value with a top-level `sessions` array of this length.
    Sessions(usize),
    /// A cached value with no top-level `sessions` array (not an object, or the key missing).
    Unknown,
}

impl CacheSessions {
    /// Classify a borrowed cache value. Takes `&Value`, never an `Arc`, so the caller's handle
    /// can be dropped inside the lock block (see `composition_tick`).
    pub fn of(cached: Option<&Value>) -> Self {
        match cached {
            None => CacheSessions::Absent,
            Some(v) => match v.get("sessions").and_then(Value::as_array) {
                Some(arr) => CacheSessions::Sessions(arr.len()),
                None => CacheSessions::Unknown,
            },
        }
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
    summary_cache: CacheSessions,
) -> String {
    let slack = commit_mb.saturating_sub(window_est_mb);
    // `Absent` = no cached value (cold boot, or nothing derived yet) — reported as `none`, and
    // `none` means ONLY that: a present cache with zero sessions prints `0 sessions`, and a
    // present cache whose shape carries no `sessions` array prints `present (count unknown)`.
    // "nothing cached" and "cached but empty" are different facts and the line must not blur them.
    let cache_field = |c: CacheSessions, name: &str| match c {
        CacheSessions::Absent => format!("{name} none"),
        CacheSessions::Sessions(n) => format!("{name} {n} sessions"),
        CacheSessions::Unknown => format!("{name} present (count unknown)"),
    };
    format!(
        "alcore: composition: mimalloc commit {commit_mb} MB, process rss {rss_mb} MB, \
         window.spans {window_count} (~{window_est_mb} MB sampled est), {}, \
         card rows {card_rows} (~{card_text_mb} MB text, DuckDB own allocator, limit 256 MiB), \
         derived slack = commit - window est = {slack} MB",
        cache_field(summary_cache, "summary-cache"),
    )
}

/// The mi-suffix appended after `composition_line`'s text on the 60s composition tick. PURE so
/// the full line's exact shape is unit-testable (the tick itself takes the state lock and
/// prints — this builder only formats). Field order is the frozen shape: committed (omitted
/// when 0 — a missing reading must not read as "zero committed"), reset, purged, abandoned
/// (with peak when nonzero), and TRDD-9VX3WTGU Phase 0's live/free-in-page pair ALWAYS last:
///
/// * `live` = walked live-block bytes (`rss_guard::mi_live_bytes`) — what the process actually
///   holds in allocated blocks.
/// * `free-in-page` = committed − live, saturating — the residue inside pages mimalloc still
///   holds (partially-used pages + freed-but-undecommitted), the number Phases C/F/D re-rank
///   against.
/// * A failed walk (`None`) prints `?` for BOTH fields: an unmeasurable quantity must be
///   visible, not read as 0 — same contract as `none` for the caches above.
fn mi_suffix(mi: &crate::rss_guard::MimallocInfo, live_bytes: Option<u64>) -> String {
    const MB: u64 = 1024 * 1024;
    let mut s = String::new();
    if mi.committed_current_bytes > 0 {
        s.push_str(&format!(", mi committed {} MB", mi.committed_current_bytes / MB));
    }
    s.push_str(&format!(", mi reset {} MB, mi purged {} MB", mi.reset_total_bytes / MB, mi.purged_total_bytes / MB));
    if mi.pages_abandoned > 0 {
        s.push_str(&format!(", mi abandoned {} pages", mi.pages_abandoned));
    }
    if mi.pages_abandoned_peak > 0 {
        s.push_str(&format!(" (peak {})", mi.pages_abandoned_peak));
    }
    match live_bytes {
        Some(live) => {
            let live_mb = live / MB;
            let free_in_page_mb = mi.committed_current_bytes.saturating_sub(live) / MB;
            s.push_str(&format!(", mi live {live_mb} MB, mi free-in-page {free_in_page_mb} MB"));
        }
        None => s.push_str(", mi live ? MB, mi free-in-page ? MB"),
    }
    s
}

/// TRDD-2JOIAH2G — one composition report: what the committed bytes ARE, in one server.log line.
/// Phase 1 runs under the state lock and touches nothing heavier than counter reads, ≤20 `Arc`
/// refcount bumps, two cache session counts (their handles dropped inside the lock) and one
/// aggregate SELECT (see the comment at that call); phase 2 — the only
/// allocation-heavy step, serializing the sample — runs OFF the lock.
fn composition_tick(state: &Arc<Mutex<CoreState>>) {
    let (window_count, sample, card_corpus, summary_cache) = {
        let st = state.lock_timed();
        let window_count = st.window.spans.len();
        // An even sample across the window, at most 20 handles: cloning an `Arc` is a refcount
        // bump, so the whole lock hold stays in microseconds. `step >= 1` here because the
        // branch only runs when the window has more than 20 spans.
        let sample: Vec<Arc<Value>> = if window_count <= 20 {
            st.window.spans.to_vec()
        } else {
            st.window.spans.iter().step_by(window_count / 20).take(20).cloned().collect()
        };
        // TRDD-2JOIAH2G: the derived summary cache is reported as a SESSION COUNT computed here,
        // under the lock, from a statement-scoped `Arc` that is dropped before the lock is
        // released. No `Arc<Value>` of the cache may leave this block: while this tick held
        // it across an off-lock serialize, every rebuild landing in that window found the
        // previous summary shared and `take_sessions` (summary_engine.rs) deep-copied the whole
        // sessions array (rig: sharedCopies 0 -> 2 at +71 s, footprint 1,590 -> 2,365 MB).
        // `cached_value` (not `cached_any`) deliberately: a 60s measurement read must not
        // inflate the served hit/miss ratio.
        let summary_cache = CacheSessions::of(st.summary_cache.cached_value().as_deref());
        // Card corpus, one aggregate. DEVIATION from the card's "never under the state lock":
        // `CardStore` is a plain field of `CoreState` with no lock of its own, so its connection
        // is only reachable from here — and the boot restore already holds this lock across
        // THOUSANDS of DuckDB puts (log_reader.rs `restore`). One aggregate SELECT over ≤32k
        // rows is bounded and strictly cheaper than that precedent.
        (window_count, sample, st.cards.corpus_bytes(), summary_cache)
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
    // TRDD-2JOIAH2G: the cache-size serialization is DELETED outright (no env var, no opt-in).
    // Serializing the ~70 MB summary cache meant holding its Arc across a
    // multi-MB serialize, which forced full summary copies in `take_sessions` whenever a rebuild
    // landed meanwhile (sizes recorded on TRDD-2JOIAH2G). The line reports session counts instead.
    let mi = crate::rss_guard::mimalloc_info();
    let commit_mb = mi.current_commit_bytes / MB;
    let live_bytes = crate::rss_guard::mi_live_bytes();
    let suffix = mi_suffix(&mi, live_bytes);
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
            summary_cache,
        ),
        suffix
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
/// thread — the pool reuses threads, killing freshness) allocates 16 × 512 KiB page-backed
/// objects (~8 MB) and exits. mimalloc's thread-done path UNCONDITIONALLY abandons every
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
///
/// TRDD-9VX3WTGU Phase 0: TWO changes. (1) The ballast shrank 200 → 16 objects (100 MB → 8 MB
/// leaked at every boot): the instrument was proven (its positive control passed repeatedly),
/// and an UNCONDITIONAL 100 MB-per-boot permanent leak is exactly the kind of standing residue
/// this redesign is out to kill — 8 MB keeps the same 4-blocks-per-2MiB-page geometry, so the
/// mechanism under test is unchanged. (2) The whole pass is gated behind
/// `AGENTLENS_ABANDON_CONTROL=1` (default OFF): it is a one-time instrument calibration, not a
/// recurring need — the skip must be VISIBLE (one boot log line) so an operator who expects it
/// can tell "off" from "ran and passed".
fn abandoned_control_pass() {
    if std::env::var("AGENTLENS_ABANDON_CONTROL").ok().as_deref() != Some("1") {
        println!(
            "{} {}alcore: abandoned-control: SKIPPED (set AGENTLENS_ABANDON_CONTROL=1 to run the boot-time positive control)",
            crate::log_ts(),
            crate::uptime_prefix()
        );
        return;
    }
    let before = crate::rss_guard::mimalloc_info().pages_abandoned;
    let spawned = std::thread::Builder::new()
        .name("alcore-abandon-control".into())
        .spawn(|| {
            // `vec![1u8; N]`, not `vec![0u8; N]`: a zeroed vec can take the OS zero-page path;
            // the non-zeroed form memsets every byte (precedent: rss_guard.rs's control test).
            // 512 KiB objects are page-backed large-class — never the HUGE class (round-84
            // fold 1), so every object lands on page-queue pages.
            let ballast: Vec<Vec<u8>> = (0..16).map(|_| vec![1u8; 512 * 1024]).collect();
            std::hint::black_box(&ballast);
            // LEAK, not drop (round-90 review, blocking fold 1): the control's premise is
            // "pages OWNED at exit are abandoned by thread death". Dropping the ballast
            // self-cancels the measurement — fill-time abandons rise during allocation, then
            // every free drains them (mi_abandoned_page_try_free frees emptied abandoned
            // pages outright, free.c:249-256; retire-at-empty frees owned pages, free.c:42-47),
            // so the after-read returns to ~baseline on a perfectly healthy instrument.
            // Forgetting the Vec keeps the pages owned-at-exit: thread death is then the ONLY
            // thing that can reclaim them, and _mi_thread_done abandons every one.
            // 8 MB leaked once at boot is bounded and irrelevant next to the 2+ GB commit.
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
/// DERIVED (round-90 review, blocking fold 2; re-derived for the Phase 0 ballast, TRDD-9VX3WTGU):
/// 16 × 512 KiB = 8 MB in 2 MiB large pages = 4 blocks/page ≈ 4 pages — the same arithmetic at
/// the shrunken ballast. The threshold sits at 2: one page is indistinguishable from read-noise
/// (the round-90 reasoning), two clear it while staying below the dominant-geometry expectation,
/// and the FIRST live delta is calibration data: if the observed delta sits far from 4,
/// the geometry assumption (4-per-page) is what's wrong, not the counter. Signed — the pool
/// can also SHRINK if the sweep's churn races the control.
fn control_passes(delta_pages: i64) -> bool {
    delta_pages >= 2
}

/// Arm every recurring chore. Called once from `main` after the state is built and before the
/// listeners bind. The hook-spool boot drain runs INLINE first (the TS calls each chore once at
/// startup before setting its interval), so a server that is restarted more often than a chore's
/// period still performs it; the other boot passes run as a task on `bg`.
///
/// TRDD-RVKQDLRD: TWO runtimes. `rt` is the normal-priority request runtime and keeps every
/// durability/latency chore (5s span flush + window prune, account-timeline flush, lifecycle
/// heartbeat, periodic hook-spool drain): at background QoS under CPU load their cadence stalls
/// (tests/shutdown_flush.rs lost its "nothing flushed yet" premise that way) and a crash would
/// lose more buffered data. `bg` is the background-QoS runtime and takes the heavy housekeeping
/// (boot passes, span/purge/bodies/composition ticks, resident and abandoned scans, statusline
/// seal, spill cleanup).
pub fn spawn_all(rt: &tokio::runtime::Runtime, bg: &tokio::runtime::Runtime, state: Arc<Mutex<CoreState>>) {
    // Spill dirs are emptied BEFORE any DuckDB connection of this process opens (none has yet).
    let data_dir = state.lock_timed().data_dir.clone();
    clean_spill_dirs(&data_dir, None);
    let dd = data_dir.clone();
    // TRDD-RVKQDLRD: spill cleanup is disk housekeeping -> `bg`.
    bg.spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        tick.tick().await; // boot cleanup ran inline above
        loop {
            tick.tick().await;
            let dd = dd.clone();
            // Skips store/tmp while the long-lived bodies store is open (TRDD-2HRA270Y step 3): its
            // DuckDB keeps spill blocks there for the life of the process, and an age rule cannot
            // tell those from a dead process's leftovers. The other dirs keep the age sweep.
            let _ = tokio::task::spawn_blocking(move || clean_spill_dirs_periodic(&dd)).await;
        }
    });
    // Boot passes, in the TS's order.
    //
    // The hook-spool drain runs FIRST (TRDD-465EXTJ6). Events spooled while the server was down
    // are the oldest data in the system and the only copy of themselves; reingesting them before
    // the purge pass means a bucket-retention sweep can never delete the bucket they are about to
    // land in. It is also idempotent, so a crash mid-drain simply leaves the rest for next boot.
    //
    // TRDD-RVKQDLRD: the drain stays INLINE (synchronous, before `spawn_all` returns, i.e. before
    // the listeners bind). It is cheap, and it keeps drain-before-live-ingest ordering: were it
    // moved to the background task, a live hook event arriving on the freshly bound listener
    // could be ingested before older spooled events. Only the expensive passes below moved.
    {
        let mut st = state.lock_timed();
        let now = crate::now_ms();
        // Boot pass has no lock contention yet — drain the whole backlog, unbounded.
        if let Some(d) = spool_drain_tick(&mut st, now, usize::MAX) {
            log_spool_drain(&d);
        }
    }
    // TRDD-RVKQDLRD: span_tick, purge_tick, bodies_pass and composition_tick run as ONE task on
    // `bg` (the background-QoS runtime built in alcore.rs), NOT inline before the listeners bind.
    // Inline they delayed the ports by the whole bodies pass (6-374 s measured) and ran at normal
    // priority, competing with the user's apps. Their relative order is unchanged, and purge
    // still runs after the inline drain above, so drain-before-purge holds.
    {
        let s = state.clone();
        bg.spawn(async move {
            let boot =tokio::task::spawn_blocking(move || {
                span_tick(&s, crate::now_ms() as f64);
                purge_tick(&s, crate::now_ms() as f64);
                bodies_pass(&s, crate::now_ms() as f64);
                composition_tick(&s); // boot pass — same task, same relative order as before
            })
            .await;
            if let Err(e) = boot {
                // Fail loudly: the old inline shape took the process down on a panic here, and a
                // JoinError swallowed by `let _` would silently skip retention for the whole run.
                eprintln!("{} alcore: boot chores failed: {e}", crate::log_ts());
                std::process::exit(1);
            }
        });
    }

    // TRDD-RVKQDLRD: daily span retention/compression is heavy housekeeping -> `bg`.
    let s = state.clone();
    bg.spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(24 * 3600));
        tick.tick().await; // the first tick fires immediately — boot already ran this pass
        loop {
            tick.tick().await;
            let s2 = s.clone();
            // On the blocking pool: retention unlinks files and compression gzips whole segments.
            let _ = tokio::task::spawn_blocking(move || span_tick(&s2, crate::now_ms() as f64)).await;
        }
    });

    // TRDD-RVKQDLRD: hourly bucket purge is heavy housekeeping -> `bg`.
    let s = state.clone();
    bg.spawn(async move {
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
    // TRDD-RVKQDLRD: DuckDB ingestion + reconstruction, can run tens of seconds -> `bg`.
    let bodies_interval: u64 = 60;
    bg.spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(bodies_interval));
        tick.tick().await; // boot pass runs in the boot-chores task above
        loop {
            tick.tick().await;
            let s2 = s.clone();
            let _ = tokio::task::spawn_blocking(move || bodies_pass(&s2, crate::now_ms() as f64)).await;
        }
    });

    // The digest spool tap's seal + collect (spool_tap.rs), only when the tap is on. Its first tick
    // fires immediately, which IS the start-up collect: whatever the previous process sealed (or left
    // in current.ndjson at a hard kill) is loaded now, off the boot path on `bg`. `aldigest collect`
    // runs as a child process under its own `.collect.lock` — NOT `with_chores_lock`, which a
    // ten-minute collect would hold against the bodies pass and the status-line seal — so a busy
    // tick is skipped rather than queued. One task awaiting each tick means ticks never overlap.
    let tap = state.lock_timed().spool_tap.clone();
    if let Some(tap) = tap {
        bg.spawn(async move {
            let mut tick = tokio::time::interval(tap.interval());
            // After a long collect, do not replay the ticks it overran back to back.
            tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            loop {
                tick.tick().await;
                let t = tap.clone();
                let _ = tokio::task::spawn_blocking(move || t.seal_and_collect()).await;
            }
        });
    }

    // The 30s resident-blob scan (server.ts:1497), boot pass included (:1498). 30s and not the
    // burn tick's 4s for the TS's own stated reason: bodies parse once then hit the LRU cache, so
    // a 4s recompute would waste the work for no gain.
    // NON-OVERLAP is by construction here, not by a flag: this is ONE task awaiting each scan
    // before the next tick, so the TS's `residentScanRunning` guard has nothing to guard. A
    // `spawn` per tick would need it back.
    // TRDD-RVKQDLRD: diagnostic scan, not on a durability path -> `bg`.
    let s = state.clone();
    bg.spawn(async move {
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
    // TRDD-RVKQDLRD: stays on `rt` (normal priority): this is the durability flush. Its first
    // tick fires immediately; at background QoS under load that tick landed after
    // tests/shutdown_flush.rs's POST and flushed early, and a crash would lose more spans.
    let s = state.clone();
    rt.spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(5));
        loop {
            tick.tick().await;
            {
                let mut st = s.lock_timed();
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
    // TRDD-RVKQDLRD: durability flush (fsync of account changes) -> stays on `rt`.
    rt.spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(account_flush));
        loop {
            tick.tick().await;
            {
                let mut st = s.lock_timed();
                st.account_timeline.flush();
            }
        }
    });

    // The 30s lifecycle heartbeat (server.ts:1730, TRDD-PJC8N1HO spec 2): a crash then leaves
    // lastHeartbeat as a truthful downtime-gap boundary. The TS pairs this with scheduleDurableSave;
    // the Rust durable cadences live on the sweeper thread (P5e), so only the heartbeat is here.
    // TRDD-RVKQDLRD: tiny lock hold whose whole value is a truthful downtime boundary after a
    // crash; a stalled background heartbeat would falsify it -> stays on `rt`.
    let s = state.clone();
    rt.spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(30));
        tick.tick().await; // boot just wrote the start marker
        loop {
            tick.tick().await;
            {
                let mut st = s.lock_timed();
                let file = crate::collector_lifecycle::lifecycle_file(&st.data_dir);
                crate::collector_lifecycle::record_heartbeat(&file, &mut st.lifecycle, crate::now_ms());
            }
        }
    });

    // The 60s statusline seal (server.ts:1004). Sealing runs DuckDB over whole WALs, so it
    // deliberately shares only the root path + the Arc'd counters with the store, NEVER the state
    // lock — a seal must not stall every reader for the length of a re-encode.
    let (sl_root, sl_counters) = {
        let st = state.lock_timed();
        (st.statusline.root.clone(), st.statusline.counters.clone())
    };
    let sl_vars: std::collections::HashMap<String, String> = std::env::vars().collect();
    // TRDD-RVKQDLRD: DuckDB WAL re-encode, never takes the state lock -> `bg`.
    bg.spawn(async move {
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
    // TRDD-RVKQDLRD: spooled hook events are the only copy of themselves until drained, and the
    // drain holds the state lock request handlers use -> stays on `rt`, not at background QoS.
    let s = state.clone();
    rt.spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_millis(hook_spool_drain_ms));
        tick.tick().await; // boot pass already drained; wait a full period before the first tick
        loop {
            tick.tick().await;
            let mut st = s.lock_timed();
            let now = crate::now_ms();
            // TRDD-RBBEX59R: the write-path condition is re-checked on EVERY tick (capture can be
            // toggled through POST /api/hook-config); spool_drain_tick skips the drain otherwise.
            if let Some(d) = spool_drain_tick(&mut st, now, 200) {
                log_spool_drain(&d);
            }
        }
    });

    // TRDD-2JOIAH2G — the 60s composition tick. Crash-loop forensics: the RSS guard kills at 2 GiB
    // while exit stats say post-GC committed == peak, so what matters is naming the LIVE bytes.
    // One tick, on the blocking pool (the serialization half moves real bytes); a skipped or
    // overlapping tick costs one missing line, which is fine for a 60s diagnostic.
    // TRDD-RVKQDLRD: diagnostic -> `bg`.
    let s = state.clone();
    bg.spawn(async move {
        let mut tick = tokio::time::interval(Duration::from_secs(60));
        tick.tick().await; // boot pass runs in the boot-chores task above
        loop {
            tick.tick().await;
            let s2 = s.clone();
            let _ = tokio::task::spawn_blocking(move || composition_tick(&s2)).await;
        }
    });

    // TRDD-2JOIAH2G — the abandoned-sweep chore: control ONCE at boot, then the 60s interval.
    // Same blocking-pool shape as the other spawn_blocking chores; one task awaiting each tick
    // means no overlap guard is needed (same construction as resident_blob_scan above). The
    // control itself spawns a GENUINELY NEW OS thread for its ballast (pool threads are
    // reused, and thread DEATH is the mechanism under test — the allocating thread must
    // actually die); `pages_abandoned` is a process-global stat, so the reading thread's
    // identity does not matter.
    // TRDD-RVKQDLRD: diagnostic -> `bg`.
    let s = state.clone();
    bg.spawn(async move {
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
    use super::{collect_drop_pct, composition_line, control_passes, mi_suffix, CacheSessions};
    use serde_json::json;
    use crate::rss_guard::MimallocInfo;

    /// A stats-shaped MimallocInfo for suffix tests: the fields the mi-suffix reads, at
    /// plausible magnitudes. `mimalloc_info()` itself needs a live mimalloc (test binaries
    /// don't link one as global allocator) — the suffix builder is pure over the struct.
    fn fake_mi() -> MimallocInfo {
        MimallocInfo {
            current_rss_bytes: 1800 * 1024 * 1024,
            peak_rss_bytes: 1900 * 1024 * 1024,
            current_commit_bytes: 2048 * 1024 * 1024,
            page_faults: 9,
            pages_abandoned: 146,
            pages_abandoned_peak: 19_600,
            committed_current_bytes: 2048 * 1024 * 1024,
            reset_total_bytes: 3 * 1024 * 1024,
            purged_total_bytes: 0,
        }
    }

    #[test]
    fn composition_line_subtracts_window_est_from_commit() {
        let line = composition_line(
            2048,
            1800,
            5000,
            400,
            32_000,
            120,
            0,
            CacheSessions::Sessions(500),
        );
        assert_eq!(
            line,
            "alcore: composition: mimalloc commit 2048 MB, process rss 1800 MB, \
             window.spans 5000 (~400 MB sampled est), summary-cache 500 sessions, card rows 32000 (~120 MB text, \
             DuckDB own allocator, limit 256 MiB), derived slack = commit - window est = 1648 MB"
        );
    }

    #[test]
    fn full_line_shape_with_live_and_free_in_page() {
        // TRDD-9VX3WTGU Phase 0: the FULL composition line's exact shape, including the new
        // suffix tail. The suffix builder is the format half of composition_tick; pairing it
        // with composition_line here pins the whole line a `grep alcore: composition` would
        // see. Plausible values: commit 2048 MB, live 640 MB → free-in-page 1408 MB.
        let mi = fake_mi();
        let live = 640 * 1024 * 1024;
        let line = format!(
            "{}{}",
            composition_line(
                mi.current_commit_bytes / (1024 * 1024),
                mi.current_rss_bytes / (1024 * 1024),
                5000,
                400,
                32_000,
                120,
                0,
                CacheSessions::Sessions(500),
            ),
            mi_suffix(&mi, Some(live))
        );
        assert_eq!(
            line,
            "alcore: composition: mimalloc commit 2048 MB, process rss 1800 MB, \
             window.spans 5000 (~400 MB sampled est), summary-cache 500 sessions, card rows 32000 (~120 MB text, \
             DuckDB own allocator, limit 256 MiB), derived slack = commit - window est = 1648 MB, \
             mi committed 2048 MB, mi reset 3 MB, mi purged 0 MB, mi abandoned 146 pages \
             (peak 19600), mi live 640 MB, mi free-in-page 1408 MB"
        );
    }

    #[test]
    fn mi_suffix_unmeasured_live_prints_question_marks() {
        // A failed walk must print `?` for BOTH fields, never 0 — "unmeasured" and
        // "zero bytes" are different facts (same contract as the caches' `none`).
        let s = mi_suffix(&fake_mi(), None);
        assert!(s.ends_with(", mi live ? MB, mi free-in-page ? MB"), "{s}");
        assert!(s.contains("mi committed 2048 MB"), "{s}");
    }

    #[test]
    fn mi_suffix_live_over_commit_saturates_free_in_page() {
        // free-in-page is saturating: a live reading above committed (the two counters are
        // sampled microseconds apart) yields 0, never an underflow panic.
        let s = mi_suffix(&fake_mi(), Some(3 * 1024 * 1024 * 1024));
        assert!(s.ends_with(", mi live 3072 MB, mi free-in-page 0 MB"), "{s}");
    }

    #[test]
    fn composition_line_prefix_is_exact() {
        assert!(
            composition_line(1, 1, 0, 0, 0, 0, 0, CacheSessions::Absent)
                .starts_with("alcore: composition:")
        );
    }

    #[test]
    fn composition_line_none_reports_none_not_zero() {
        // `Absent` (nothing cached) must print as `none`, and `none` must mean ONLY that: a
        // present cache with zero sessions prints `0 sessions`, and a present cache with no
        // countable `sessions` array prints `present (count unknown)` — "nothing cached",
        // "cached but empty" and "cached, uncountable" are different facts.
        let line = composition_line(100, 90, 1000, 400, 10, 5, 0, CacheSessions::Absent);
        assert!(line.contains("summary-cache none,"), "{line}");
        assert!(line.ends_with("derived slack = commit - window est = 0 MB"), "{line}");

        let line = composition_line(100, 90, 1000, 400, 10, 5, 0, CacheSessions::Sessions(0));
        assert!(line.contains("summary-cache 0 sessions,"), "{line}");
        assert!(!line.contains("summary-cache none"), "{line}");

        let line = composition_line(100, 90, 1000, 400, 10, 5, 0, CacheSessions::Unknown);
        assert!(line.contains("summary-cache present (count unknown),"), "{line}");
        assert!(!line.contains("summary-cache none"), "{line}");
    }

    #[test]
    fn cache_sessions_classifies_absent_counted_and_uncountable() {
        // The three states come from the cached value's shape, not its size: absent → Absent,
        // a top-level `sessions` array → its length (0 included), anything else → Unknown.
        assert_eq!(CacheSessions::of(None), CacheSessions::Absent);
        assert_eq!(CacheSessions::of(Some(&json!({"sessions": []}))), CacheSessions::Sessions(0));
        assert_eq!(CacheSessions::of(Some(&json!({"sessions": [1, 2, 3], "k": 1}))), CacheSessions::Sessions(3));
        assert_eq!(CacheSessions::of(Some(&json!({"k": 1}))), CacheSessions::Unknown);
        assert_eq!(CacheSessions::of(Some(&json!({"sessions": "x"}))), CacheSessions::Unknown);
    }

    #[test]
    fn composition_line_zero_window_yields_full_commit_as_slack() {
        let line = composition_line(2048, 1800, 0, 0, 10, 5, 0, CacheSessions::Absent);
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
    fn control_passes_at_2_page_boundary() {
        // Geometry-derived threshold re-derived for the Phase 0 ballast (TRDD-9VX3WTGU):
        // 16 x 512 KiB in 2 MiB large pages = ~4 pages; the bar sits at 2 — one page is
        // read-noise, two clear it, below the dominant-geometry expectation. Exactly 2 passes,
        // 1 fails. The delta is signed: a shrinking pool (sweep churn racing the control)
        // fails too.
        assert!(control_passes(2));
        assert!(control_passes(4));
        assert!(!control_passes(1));
        assert!(!control_passes(0));
        assert!(!control_passes(-5));
    }

    /// `clean_spill_dirs` removes a >1h-old spill file, keeps a fresh one, tolerates missing dirs,
    /// and with no age limit (boot) removes everything.
    #[test]
    fn clean_spill_dirs_removes_only_stale_files_unless_boot() {
        let dd = std::env::temp_dir().join(format!("al-spill-clean-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dd);
        assert_eq!(super::clean_spill_dirs(&dd, None), 0, "missing dirs are not an error");
        for sub in ["store/tmp", "statusline/tmp", "tmp/session-summary"] {
            std::fs::create_dir_all(dd.join(sub)).unwrap();
        }
        let stale = dd.join("store/tmp/duckdb_temp_storage-0.tmp");
        let fresh = dd.join("statusline/tmp/duckdb_temp_storage-1.tmp");
        let boot_only = dd.join("tmp/session-summary/duckdb_temp_storage-2.tmp");
        for f in [&stale, &fresh, &boot_only] {
            std::fs::write(f, b"x").unwrap();
        }
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(2 * 3600);
        std::fs::File::options().write(true).open(&stale).unwrap().set_modified(old).unwrap();

        assert_eq!(super::clean_spill_dirs(&dd, Some(super::SPILL_MAX_AGE)), 1);
        assert!(!stale.exists() && fresh.exists() && boot_only.exists());
        assert_eq!(super::clean_spill_dirs(&dd, None), 2, "boot removes every file");
        assert!(!fresh.exists() && !boot_only.exists());
        let _ = std::fs::remove_dir_all(&dd);
    }
}

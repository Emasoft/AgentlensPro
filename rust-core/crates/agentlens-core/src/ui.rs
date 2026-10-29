//! The UI/API listener behind the FROZEN wire contract (TRDD-DMWOBWFH P4e; spec = the P4a freeze
//! report §1). This slice: the per-request preamble pieces a GET can observe + `GET /api/summary`
//! + the 404 fallback.
//!
//! Reproduced exactly (report §1.1 / §1.2):
//!   - CORS: echo `Access-Control-Allow-Origin: <Origin>` + `Vary: Origin` ONLY for a same-origin
//!     (Origin.host === Host) or loopback Origin; never `*`; no Origin ⇒ no ACAO; unparseable
//!     Origin ⇒ disallowed. No OPTIONS handler — OPTIONS falls through to the 404.
//!   - Viewer-role gate: a PRESENT `x-agentlens-viewer` header that cannot be verified is
//!     `invalid` → 403 `{"error":"unverifiable viewer assertion — rejected (AgentlensPro#4 §B5)"}`.
//!     alcore has no embed key loaded yet, so EVERY present header resolves to invalid — the
//!     TS rule for "key is null" verbatim (src/embedAuth.ts); the HMAC-verified `maestro` /
//!     `restricted` roles land with the embed-key slice. Absent header ⇒ standalone.
//!   - CSRF gate: non-GET/HEAD with a disallowed Origin → 403 `{"error":"cross-origin request
//!     refused"}`.
//!   - `GET /api/summary` → 200 `application/json`, the summarizeSpans output with
//!     `sessions[].timeline=[]` and `fileOps/generatedFiles/generatedFilesTruncated` dropped
//!     (stripSessionDetail, server.ts:2464). OTEL-only for now: the log-session merge
//!     (feedMergePolicy + spawn collapse) arrives with the log-scan wiring slice.
//!   - `/events` (ANY method — the TS handler has no method check): 200 `text/event-stream`,
//!     `Cache-Control: no-cache`, `Connection: keep-alive`; first bytes `:\n\n`, then
//!     `data: <update payload>\n\n` on connect and on every coalesced push (report §1.3; the
//!     update payload is update_payload::build_update_payload). sessionChanged / burnStatus /
//!     alert frames are later slices (log-scan wiring, burn investigator).
//!   - `GET /` + `/index.html` (server.ts:4407): the dashboard shell, `media/index.html` with its
//!     six `@@TOKENS@@` substituted (the SAME file the TS getHtml reads — one template, two servers,
//!     TRDD-VHH7FXGC), `Content-Type: text/html`, `Vary: X-Agentlens-Viewer` (1ZH1D5EG) and the
//!     loopback-only `frame-ancestors` CSP (FMIZO8Y4). Static assets under `media_dir` by the
//!     4-entry MIME map with the separator-terminated containment check. Both need
//!     `CoreState.media_dir`; without it they are the 404 below.
//!   - fallback → 404, NO Content-Type, body `Not found`.
//!
//! Deferred (documented, not silently dropped): admission-control 503s, base-path (BOTH the
//! strip in handle() and the prefix in the shell — dashboard_html emits root-absolute URLs).

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::{Full, StreamBody};
use hyper::body::Frame;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use serde_json::{Map, Value};
use tokio::sync::broadcast;

use crate::update_payload::build_update_payload;
use crate::{CoreState, LockTimed};

/// The coalesce window for the aggregate `update` push (server.ts PUSH_COALESCE_MS — the
/// TRDD-0KNGDFQI OOM fix: N ingest POSTs become ONE full rebuild after the burst settles).
pub const PUSH_COALESCE_MS: u64 = 4000;

/// Fan-out of SSE frames to every connected `/events` client (the TS `sseClients` list). A
/// lagging client simply misses frames (`RecvError::Lagged`) and keeps going — the TS write
/// failure path drops the client; here the stream stays open, which the dashboard's
/// reconnect+poll fallback tolerates either way.
pub struct SseHub {
    tx: broadcast::Sender<Bytes>,
}

impl Default for SseHub {
    fn default() -> Self {
        SseHub { tx: broadcast::channel(64).0 }
    }
}

impl SseHub {
    pub fn subscribe(&self) -> broadcast::Receiver<Bytes> {
        self.tx.subscribe()
    }
    pub fn broadcast(&self, frame: Bytes) {
        let _ = self.tx.send(frame); // no receivers ⇒ Err, harmless
    }
    pub fn client_count(&self) -> usize {
        self.tx.receiver_count()
    }
}

fn sse_frame(payload: &str) -> Bytes {
    Bytes::from(format!("data: {payload}\n\n"))
}

/// THE summary rebuilder — the one path that never holds the state lock across the build
/// (TRDD-HFV4AIT7). Under the lock: a version check and, on a miss, a pointer snapshot of the
/// window + the log cards. The summarize itself runs on the caller's own thread.
///
/// Measured before this split: 32 concurrent OTLP posters reached only 201 req/s at 96% mean CPU
/// (one core) on a 14-core machine, and `/usr/bin/sample` put **83,061** samples in
/// `__psynch_mutexwait` — every poster queued behind the 4 s ticks rebuilding a whole-window
/// summary while holding the mutex that `ingest_parsed` needs.
///
/// Returns the data version the summary was built for, so a derived view memoizes against the
/// SAME version rather than whatever `data_version` reads afterwards.
///
/// SINGLE-FLIGHT: at most one rebuild runs at a time. This gate was review F1 of `5e7f455`, was
/// assigned to an agent that stalled before landing it, and its absence was measured on 2026-08-29
/// as the process's dominant memory holder (TRDD-YU8QPU89).
///
/// The comment this replaces said two readers computing the same version was "wasted CPU, never a
/// stalled ingest". The CPU half was right and the cost was wrong: each in-flight rebuild holds its
/// own `SummaryInputs` snapshot (a `Vec<Arc<Value>>` over the whole window plus, since
/// TRDD-XTFDRTH2, a `Vec<String>` of the card corpus read out of the card table — it used to be a
/// clone of the resident card map) AND the per-session card set it is building, while the previous
/// summary stays
/// alive until `store_summary` swaps it. So concurrent rebuilds cost N COMPLETE COPIES of the
/// derived state, not N times the CPU. Measured: `MIMALLOC_SHOW_STATS=1` reported **26.3 GiB
/// committed** with the window capped at 200,000 spans (~300 MB) and the writer buffer empty —
/// every bounded structure eliminated by inspection (`VersionedCache` is one slot;
/// `otel_attribution` is replaced wholesale), leaving this.
///
/// LOCK ORDER IS GATE-THEN-STATE, ALWAYS. The fast path takes the state lock and RELEASES it before
/// touching the gate, so the two are never held in the opposite order and this cannot deadlock.
/// After winning the gate the cache is re-checked, because the usual outcome is that the rebuild we
/// queued behind already produced exactly what we wanted — waiters then pay a pointer clone instead
/// of a second full pass.
///
/// ponytail: one process-global gate rather than a per-state lock, because there is one server per
/// process and threading a second lock through ~25 call sites buys nothing. The remaining ceiling is
/// unchanged — a rebuild is still the WHOLE window — and the upgrade is still an incremental
/// summarizer, not more locking.
///
/// ponytail (TRDD-2R36W8Q1, rationed by TRDD-7RM5YW2T): admission is `try_lock`, so readers never
/// block. Rebuilds used to run BACK-TO-BACK under sustained ingest — the moment one finished the
/// next cache miss started another — a steady 100% of ONE core (measured 101.9%, later 84%) and
/// the allocation churn behind the multi-GB plateau. The 25 ms rebuild loop now records what each
/// pass cost in the gate and skips its next `REBUILD_COST_FACTOR ×` that, capping its rebuilding at
/// a fifth of the wall clock — with ONE override: a reader waiting on it, honoured only while the
/// rebuild can still land inside that reader's budget (`READER_WAITING`, below). That RATIONS the
/// cost; the ceiling is unchanged — a rebuild is still the WHOLE window — and the upgrade is still
/// the incremental summarizer named above, which removes it rather than rationing it.
/// How long a reader waits for an in-flight rebuild before serving stale (TRDD-2R36W8Q1).
///
/// Sized against BOTH failure modes rather than picked. Long enough that an ordinary rebuild
/// (milliseconds at normal window sizes) is WAITED FOR, so `POST /v1/traces` then `GET
/// /api/summary` still sees its own write. Short enough that the pathological case — a rebuild
/// over ~1M spans, measured at over 20 s — cannot hold a reader long enough to time out its HTTP
/// client, which is what made the server look dead while ingest was healthy.
const STALE_BUDGET_MS: u64 = 500;

/// How many times its own cost a rebuild must sit out before another may start (TRDD-7RM5YW2T).
///
/// WHY A BACK-OFF AT ALL. The 25 ms tick below rebuilds whenever `data_version` moved, and ingest
/// bumps that version on every payload (~6.7 bumps/s measured), so under any sustained ingest
/// rebuilds ran BACK-TO-BACK: each pass snapshots the whole window (570k `Arc<Value>`) plus a clone
/// of the log cards, builds a full card summary, swaps it in and drops the previous one. Measured
/// 2026-09-05 on the live collector: **8.7 GB of resident mimalloc churn** (13.1 GB footprint,
/// 21.3 GB peak — mimalloc never decommits it) and **84% of a core** twenty minutes after boot,
/// while every bounded structure in the process summed to under 1 GB.
///
/// WHY A MULTIPLE OF THE COST AND NOT A PERIOD, AND NO FLOOR UNDER IT. `4 × d` caps rebuilding at a
/// fifth of the wall clock at EVERY window size, so nothing needs retuning as the window grows: a
/// 1 ms rebuild is waved through 4 ms later, a 20 s rebuild gets an 80 s gap. A fixed floor would
/// be a second constant that buys nothing: at `d ≈ 1 ms` there is no churn left to ration.
///
/// WHAT THE FACTOR ALONE DOES TO READ-YOUR-WRITES, stated rather than waved away. With a rebuilder
/// active a cache-missing reader never builds; it waits ≤ `STALE_BUDGET_MS` for the loop. Before
/// this back-off that held for `d + tick ≲ 500 ms`, i.e. `d ≲ 475 ms`; with a blind `4 × d` skip it
/// would hold only for `4d + tick + d ≲ 500 ms`, i.e. `d ≲ 95 ms`, and a 5k–25k-span store (an
/// ordinary dev install, 100–500 ms per rebuild) would sit in the regressed band. `READER_WAITING`
/// closes that band: a waiting reader overrides the skip whenever the rebuild can still land inside
/// its budget. What remains, deliberately, is a larger staleness ceiling at LARGE `d` — a reader
/// there was served stale before too, and the summary it sees is now up to ≈`5d` old, not ≈`d`.
///
/// The override reads the LAST pass's cost as a proxy for the next one's. That misleads only
/// transiently and self-corrects on the following pass: a window that just grew past the budget
/// grants one unhelpful override (one extra pass, the reader stale anyway); a one-off spike above
/// it denies one override (one stale answer). Neither is worth a second measurement.
const REBUILD_COST_FACTOR: u32 = 4;

/// The single-flight gate, and the back-off record it protects.
///
/// The record lives INSIDE the gate deliberately: the gate already serializes rebuilds, so the only
/// thread that can read or write it is the one holding it. That is a second lock avoided, not a
/// lock elided — there is no unsynchronized access here to get wrong.
#[derive(Default)]
struct RebuildGate {
    /// When the last rebuild finished, and how long it took. `None` until the first pass lands.
    last: Option<(std::time::Instant, std::time::Duration)>,
}

fn rebuild_gate() -> &'static Mutex<RebuildGate> {
    static GATE: std::sync::OnceLock<Mutex<RebuildGate>> = std::sync::OnceLock::new();
    GATE.get_or_init(|| Mutex::new(RebuildGate::default()))
}

/// May a new rebuild start, given when the last one finished and what it cost? Pure — the clock and
/// the gate are read by the caller — so the arithmetic is unit-testable without sleeping or faking
/// an `Instant`.
///
/// THE ONLY CALLER IS THE 25 ms LOOP. This predicate knows what the last rebuild COST and nothing
/// about `data_version`, so it cannot tell "no one needs this pass" from "someone just wrote and is
/// asking for it". That is why it is never applied to the read path, and why the loop pairs it with
/// `READER_WAITING`: in production the loop is a waiting reader's ONLY source of fresh data, so a
/// reader raising that flag is the version term this arithmetic lacks.
///
/// `saturating_mul` because `Duration * u32` PANICS on overflow, and `saturating_duration_since`
/// because a clock that went backwards must read as "no time passed", not wrap into "due".
fn should_rebuild(finished_at: std::time::Instant, took: std::time::Duration, now: std::time::Instant) -> bool {
    now.saturating_duration_since(finished_at) >= took.saturating_mul(REBUILD_COST_FACTOR)
}

/// Set by `run_summary_rebuild` while a dedicated background task owns rebuilding.
///
/// WHY A FLAG AND NOT AN UNCONDITIONAL RULE (TRDD-2R36W8Q1). Taking the rebuild off the request
/// path is only safe when SOMETHING ELSE is doing it. `summary_now` is a library function: the
/// unit tests, and any embedder that never spawns the task, call it with no rebuilder running. If
/// readers unconditionally refused to build, those callers would be served the first summary
/// forever and nothing would say why — a silent staleness bug, worse than the latency it fixes.
/// So the flag makes the contract explicit: rebuilder present ⇒ readers only ever WAIT and serve;
/// rebuilder absent ⇒ the previous self-healing inline-build behaviour, unchanged.
static REBUILDER_ACTIVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Raised by a reader entering the `STALE_BUDGET_MS` wait in `summary_now`; consumed by
/// `rebuild_once` at the start of the pass that answers it (TRDD-7RM5YW2T).
///
/// The cost back-off has no `data_version` term, and with a rebuilder active a cache-missing reader
/// cannot build for itself — the loop is its only source of fresh data. This flag is how the reader
/// tells the loop "someone is waiting on you", so the loop can override its skip while the rebuild
/// can still land inside the reader's budget. Advisory, like `REBUILDER_ACTIVE`: a spurious extra
/// pass costs one rebuild, a lost flag costs one stale answer, neither is a safety property, hence
/// `Relaxed`.
static READER_WAITING: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Owns summary rebuilds so no HTTP request ever runs one (TRDD-2R36W8Q1).
///
/// THE HOLE THIS CLOSES. `STALE_BUDGET_MS` protects every reader that LOSES the admission gate,
/// and does nothing for the one that WINS it: that request ran the whole O(window) rebuild on the
/// request path. Measured under a 100-session fleet soak, six `/api/server-stats` probes came back
/// 0.50 / 0.60 / 0.50 / **10.53** / 0.50 / **13.25** s — the ~0.5 s cluster is the budget working,
/// and the two outliers are gate winners. Every request is eventually elected winner, so no budget
/// could fix them; only removing the election can. With this task running, the winner is always
/// this task, and the read path is O(1) by construction rather than by a timeout.
///
/// The poll interval is deliberately far below `STALE_BUDGET_MS`: a reader that misses must see
/// the rebuild it needs START well inside its budget, or read-your-writes degrades from "correct"
/// to "usually correct". At normal window sizes the rebuild itself is milliseconds, so a caller
/// doing `POST /v1/traces` then `GET /api/summary` still sees its own write.
///
/// `spawn_blocking` because `summary_from` is CPU-bound over the whole span window — running it on
/// a tokio worker thread would stall every other task on that worker, which is the same class of
/// bug as holding a lock across a syscall.
pub async fn run_summary_rebuild(state: Arc<Mutex<CoreState>>) {
    REBUILDER_ACTIVE.store(true, std::sync::atomic::Ordering::Relaxed);
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(25));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    loop {
        tick.tick().await;
        let state = state.clone();
        // A rebuild that panics must not silently stop the loop — the flag would stay true and
        // every reader would then serve stale forever with nothing rebuilding. Errors from
        // spawn_blocking (panic or runtime shutdown) fall through to the next tick.
        let _ = tokio::task::spawn_blocking(move || rebuild_once(&state)).await;
    }
}

/// One rebuild pass, or nothing if the cache is already current. Blocking; the gate is held only
/// for the duration of THIS pass, and `summary_from` runs off the state lock.
fn rebuild_once(state: &Arc<Mutex<CoreState>>) {
    // Cheap pre-check before touching the gate: under fleet ingest this is a miss and we proceed,
    // but on an idle server it is a hit and the task costs one version compare per tick.
    {
        let mut st = state.lock_timed();
        let version = st.data_version;
        // WHY (TRDD-735Q3JF4 increment 1, item 1): build nothing until a reader has asked. Before this gate the
        // 25 ms loop passed the back-off at boot (flight.last is None) and built the whole summary (~43,811 sessions)
        // for no reader at all; run C2 measured mimalloc commit at ~660 MB with the build off against ~1964 MB on.
        // Trade-off: the first reader after boot pays one cold build (same as after a stage-2 cache clear); once
        // any reader has asked, behaviour is unchanged. CAVEAT: the burn tick and resident_blob_scan no longer call
        // summary_now (item 2: a card subset, see CoreState::burn_subset_summary; item 3: the cards table, see
        // composition_projects). Other summary_now callers (the dashboard, SSE, the MCP and HTTP routes, the
        // pre-warm, the composition-index route) still build the whole summary on their first request.
        // The flag is monotonic and advisory, written under the state lock that every reader and this pass already
        // take, so no atomic ordering is involved.
        if !st.summary_asked {
            return;
        }
        if st.summary_cache.current(version).is_some() {
            return;
        }
    }
    let mut flight = match rebuild_gate().try_lock() {
        Ok(g) => g,
        // Someone is already rebuilding (a cold-boot reader, or a previous pass that outran the
        // tick). Skipping is correct: the in-flight rebuild produces the same value.
        Err(std::sync::TryLockError::WouldBlock) => return,
        Err(std::sync::TryLockError::Poisoned(e)) => e.into_inner(),
    };
    // THE COST BACK-OFF (TRDD-7RM5YW2T). Without it this tick fires every 25 ms for as long as
    // ingest keeps bumping the version, which is what turned a whole-window rebuild into 84% of a
    // core and 8.7 GB of mimalloc churn.
    //
    // THE ONE OVERRIDE: a reader waiting on this loop, honoured ONLY while the rebuild can still land
    // inside that reader's budget (`took <= STALE_BUDGET_MS`). Below the budget the override is what
    // keeps read-your-writes where it was before this change (`d ≲ 475 ms`, not `d ≲ 95 ms` — see
    // `REBUILD_COST_FACTOR`). Above it the reader is served stale either way, exactly as before, and
    // honouring it there would hand every dashboard poll a whole-window rebuild — the back-to-back
    // churn at precisely the sizes this card exists for.
    let now = std::time::Instant::now();
    let reader_waiting = READER_WAITING.load(std::sync::atomic::Ordering::Relaxed);
    let due = flight.last.is_none_or(|(finished_at, took)| {
        should_rebuild(finished_at, took, now)
            || (reader_waiting && took <= std::time::Duration::from_millis(STALE_BUDGET_MS))
    });
    if !due {
        return;
    }
    // Consumed BEFORE the snapshot, not after the store: a reader that raises the flag mid-pass has
    // a write this pass's snapshot does not contain, and clearing after the store would lose it —
    // it would time out on the next backed-off tick. Cleared here, any reader arriving after the
    // snapshot re-raises the flag and the next tick sees it.
    READER_WAITING.store(false, std::sync::atomic::Ordering::Relaxed);
    // The timer starts before the snapshot: it clones the window's spans and the log cards under
    // the state lock, and that is part of the cost being rationed (and the part that blocks ingest).
    let started = std::time::Instant::now();
    let mut inputs = {
        let mut st = state.lock_timed();
        let version = st.data_version;
        if st.summary_cache.current(version).is_some() {
            return;
        }
        st.summary_snapshot()
    };
    let build = CoreState::summary_from(&mut inputs, crate::now_ms() as f64);
    let took = started.elapsed();
    {
        let mut st = state.lock_timed();
        st.store_summary(inputs.version, build);
    }
    // Recorded even if the store above failed on a poisoned lock: the CPU and the allocation churn
    // were spent either way, and that is what the back-off rations.
    flight.last = Some((std::time::Instant::now(), took));
}

pub fn summary_now(state: &Arc<Mutex<CoreState>>, now_ms: f64) -> (u64, Arc<Value>) {
    // Fast path: a warm cache never queues behind a rebuild. Under sustained ingest this misses
    // essentially always (see `cached_any`), so `stale` is what actually answers the request.
    let stale = {
        // Releases rebuild_once (TRDD-735Q3JF4 item 1): a reader has now asked. Set before the cache check so a
        // warm-cache hit also counts.
        let mut st = state.lock_timed();
        st.summary_asked = true;
        let version = st.data_version;
        if let Some(cached) = st.summary_cache.current(version) {
            return (version, cached);
        }
        st.summary_cache.cached_any()
    };

    // ADMISSION IS NON-BLOCKING — `try_lock`, never `lock`. This is the whole fix for
    // TRDD-2R36W8Q1 and the reason the gate alone was not enough.
    //
    // The gate (463f4802) already bounded rebuild CONCURRENCY to one, which is why only ONE core
    // was ever pegged. What it did not bound is how long a READER waits: every request that
    // missed the cache queued on `lock()` behind a rebuild that takes over 20 s at 1M spans, so
    // the UI path stopped answering while ingest stayed healthy at 0.3 ms.
    //
    // The tempting fix — a staleness TOLERANCE, "serve the cache if it is younger than N ms" —
    // does not work, and it is worth writing down why so it is not tried again. A tolerance only
    // controls how often a rebuild STARTS. Once one is running, every other reader is still
    // parked on the mutex for the full rebuild, so requests still time out; a 1 s tolerance in
    // front of a 20 s rebuild changes nothing a caller can observe. The blocking is the defect,
    // not the cadence.
    //
    // So: at most ONE request ever pays for a rebuild, and everyone else is answered immediately
    // from the last good summary. The cost is that the served summary can be one rebuild behind —
    // which is strictly better than the status quo of not being served at all.
    //
    // A poisoned gate is not fatal: the guard protects no data, only admission, so recover the
    // guard and proceed rather than failing a read because some other thread panicked.
    // THE READ PATH, when a background rebuilder owns rebuilds (TRDD-2R36W8Q1). A reader WAITS and
    // SERVES; it never builds. That is what makes this path O(1) instead of O(window): the 10.53 s
    // and 13.25 s probes in the fleet soak were requests that won the admission gate and ran the
    // whole rebuild themselves, which no budget can bound because every request eventually wins.
    //
    // Cold boot is the one exception and falls through below: with nothing ever cached there is no
    // stale value to serve, so waiting is the only correct answer. It can happen at most once per
    // process.
    if REBUILDER_ACTIVE.load(std::sync::atomic::Ordering::Relaxed) {
        if let Some(stale_pair) = stale.clone() {
            let deadline =
                std::time::Instant::now() + std::time::Duration::from_millis(STALE_BUDGET_MS);
            // Tell the loop someone is waiting on it, so its cost back-off yields while the rebuild
            // can still land inside this budget (TRDD-7RM5YW2T). The loop consumes the flag.
            READER_WAITING.store(true, std::sync::atomic::Ordering::Relaxed);
            loop {
                std::thread::sleep(std::time::Duration::from_millis(2));
                {
                    let mut st = state.lock_timed();
                    let version = st.data_version;
                    if let Some(cached) = st.summary_cache.current(version) {
                        return (version, cached);
                    }
                }
                if std::time::Instant::now() >= deadline {
                    // Budget spent. Serve the freshest value that EXISTS — re-read rather than
                    // reusing the pre-wait snapshot, since a newer one may have landed meanwhile
                    // and serving it is free.
                    let newest = {
                        let mut st = state.lock_timed();
                        st.summary_cache.cached_any()
                    };
                    return newest.unwrap_or(stale_pair);
                }
            }
        }
    }

    // NO COST BACK-OFF ON THIS PATH, deliberately (TRDD-7RM5YW2T). The back-off has no
    // `data_version` term — it only knows what the last rebuild cost — so applying it to a reader
    // would answer one whose write landed INSIDE the window with the pre-write summary. This inline
    // build is reached only without a rebuilder (tests, embedders); a reader is bounded by how often
    // anyone asks, and its rebuild is not what churned. The 25 ms tick was.
    let _flight = match rebuild_gate().try_lock() {
        Ok(g) => g,
        Err(std::sync::TryLockError::Poisoned(e)) => e.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => {
            // A rebuild is in flight. Wait for it, but only for STALE_BUDGET_MS.
            //
            // WHY A BUDGET AND NOT AN IMMEDIATE STALE ANSWER. Returning stale the instant the gate
            // is taken breaks READ-YOUR-WRITES, and it broke it in CI: `POST /v1/traces` then
            // `GET /api/summary` returned `sessions: []`, because a concurrent warm rebuild held
            // the gate and the only cached value was the empty pre-ingest summary. That is a
            // correctness regression, not a freshness trade — the caller asked about data it had
            // just written.
            //
            // At normal sizes a rebuild is milliseconds, so the waiter almost always gets the
            // FRESH summary and the fast path below returns it. The budget only binds in the
            // pathological case this whole change exists for — a rebuild over ~1M spans taking
            // >20 s — where waiting is what wedged the server. So: correct when it can be, live
            // when it cannot.
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(STALE_BUDGET_MS);
            loop {
                std::thread::sleep(std::time::Duration::from_millis(2));
                // The rebuild we are waiting on may have stored exactly the version we want.
                {
                    let mut st = state.lock_timed();
                    let version = st.data_version;
                    if let Some(cached) = st.summary_cache.current(version) {
                        return (version, cached);
                    }
                }
                match rebuild_gate().try_lock() {
                    Ok(g) => break g,
                    Err(std::sync::TryLockError::Poisoned(e)) => break e.into_inner(),
                    Err(std::sync::TryLockError::WouldBlock) => {}
                }
                if std::time::Instant::now() >= deadline {
                    // Budget spent: the rebuild is genuinely slow. Serve the freshest value that
                    // exists rather than queueing behind it. Re-read it here instead of reusing
                    // the snapshot taken before the wait — one may have landed meanwhile, and
                    // serving the newer one is free.
                    let newest = {
                        let mut st = state.lock_timed();
                        st.summary_cache.cached_any()
                    };
                    if let Some(pair) = newest.or(stale) {
                        return pair;
                    }
                    // COLD BOOT ONLY: no summary has ever been built, so there is nothing to
                    // serve and waiting is the only correct answer. It can happen at most once per
                    // process — after the first store `cached_any` always succeeds.
                    break rebuild_gate().lock().unwrap_or_else(|e| e.into_inner());
                }
            }
        }
    };

    let mut inputs = {
        let mut st = state.lock_timed();
        let version = st.data_version;
        // Re-check under the gate — the rebuild we waited for very likely stored this version.
        if let Some(cached) = st.summary_cache.current(version) {
            return (version, cached);
        }
        st.summary_snapshot()
    };
    let build = CoreState::summary_from(&mut inputs, now_ms);
    let mut st = state.lock_timed();
    (inputs.version, st.store_summary(inputs.version, build))
}

/// The merged summary restricted to what the burn computation reads, built with the state lock
/// RELEASED and memoized on `data_version` (TRDD-735Q3JF4 item 2). The lock is held only to check the memo
/// and take `burn_snapshot` (Arc clones); the card selection and the merge run after it, and the result is
/// stored only if no write moved `data_version` meanwhile. The 4 s tick and every burn route share the one
/// computation per version. The memo is the SUMMARY, not the burn status: `burn_status_for` depends on `now`.
/// Does not touch `summary_cache` and does not set `summary_asked`: asking for burn status must not start
/// the whole-summary rebuilder.
pub(crate) fn burn_summary_now(state: &Arc<Mutex<CoreState>>) -> Arc<Value> {
    let (version, inputs) = {
        let st = state.lock_timed();
        if let Some((v, memo)) = &st.burn_subset_memo {
            if *v == st.data_version {
                return memo.clone();
            }
        }
        (st.data_version, st.burn_snapshot())
    };
    let built = Arc::new(CoreState::burn_subset_summary(&inputs.spans, &inputs.cards, &inputs.accounts));
    let mut st = state.lock_timed();
    if st.data_version == version {
        st.burn_subset_memo = Some((version, built.clone()));
    }
    built
}

/// The request-path twin of the 4 s tick's off-lock compute (TRDD-O3ICDRLO): the burn status
/// for a route, computed with the state lock RELEASED. Every route that used to call
/// `CoreState::live_burn_status` under its guard goes through here instead.
///
/// TRDD-XX1UAZHS: with the tick off the lock, the worst hold left on pid 54270 was a single
/// 4,894 ms inside the `get_burn_status` tool route — `live_burn_status` is a whole-window
/// `build_session_summary` PLUS the gather + `compute_burn_status`, all under the lock, and the
/// sweeper's `save_cards` (4.7 s) and the rebuilder (2.9 s) queued behind that one request. The
/// summary comes from `burn_summary_now` (the burn subset built off the lock and memoized per data_version,
/// TRDD-735Q3JF4 item 2; the lock is taken twice (summary, then ttl/config), so the two can come from slightly
/// different moments, which is harmless), the only two lock-guarded inputs are snapshotted in a short hold, and
/// `burn_status_for` runs released. Callers hold the lock again only for what they
/// store or read next (`current_account`, `latest_resident_blobs`) — do not fold the compute
/// back under a guard.
pub fn burn_status_now(state: &Arc<Mutex<CoreState>>, now_ms: f64) -> Value {
    let summary = burn_summary_now(state);
    let (ttl, config) = {
        let mut st = state.lock_timed();
        (st.burn.ttl_context(now_ms), st.burn.config.clone())
    };
    crate::burn_status_for(&summary, &config, &ttl, now_ms)
}

/// TRDD-QE114936 site 20: the value `CoreState::burn_risk_report` used to produce for itself, by
/// calling `live_burn_status` under the caller's guard — a whole-window rebuild, on every
/// `/api/burn-risk` or `check_burn_risk` request in the first ≤4 s after a restart, before the
/// burn tick has stored a status.
///
/// The peek matters: `burn_status_now` is not free (it gathers and computes), so computing one
/// unconditionally would trade a rare lock-held rebuild for a per-request cost on every call. The
/// peek's own hold is a single `is_none()`. Racing another seeder is harmless — `burn_risk_report`
/// re-checks under its own guard and keeps whichever landed first.
fn burn_status_seed(state: &Arc<Mutex<CoreState>>, now_ms: f64) -> Option<Value> {
    let missing = {
        let st = state.lock_timed();
        st.burn.last_status.is_none()
    };
    if !missing {
        return None;
    }
    Some(burn_status_now(state, now_ms))
}

/// pushUpdate — ONE full rebuild broadcast to every client. Called from the coalesced timer.
pub fn push_update(state: &Arc<Mutex<CoreState>>, hub: &SseHub, now_ms: f64) {
    if hub.client_count() == 0 {
        return;
    }
    let (_, summary) = summary_now(state, now_ms);
    // The lock covers ONLY the three cheap reads; the payload assembly (which walks every span
    // and re-strips every card) runs after it is released.
    let (spans, gaps, build_id) = {
        let st = state.lock_timed();
        let gaps = crate::collector_lifecycle::compute_gaps(&st.lifecycle, crate::collector_lifecycle::MIN_GAP_MS);
        (st.window.spans.clone(), gaps, st.build_id.clone())
    };
    let payload = build_update_payload(&summary, &spans, &build_id, gaps, now_ms).to_string();
    hub.broadcast(sse_frame(&payload));
}

type SseBody = http_body_util::combinators::BoxBody<Bytes, std::convert::Infallible>;

fn boxed_full(b: Bytes) -> SseBody {
    use http_body_util::BodyExt;
    Full::new(b).boxed()
}

/// isDisallowedCrossOrigin — Origin present and neither same-origin nor loopback.
pub fn is_disallowed_cross_origin(origin: Option<&str>, host: Option<&str>) -> bool {
    let Some(origin) = origin.filter(|o| !o.is_empty()) else { return false };
    // WHATWG-URL-shaped parse: scheme://host[:port][/...]. An unparseable Origin is refused.
    let Some(rest) = origin.split_once("://").map(|(_, r)| r) else { return true };
    let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
    if authority.is_empty() {
        return true;
    }
    if let Some(h) = host {
        if authority == h {
            return false;
        }
    }
    // hostname: strip the port (IPv6 keeps its brackets in the authority, then strip them).
    let hostname = if let Some(end) = authority.strip_prefix('[').and_then(|a| a.find(']')) {
        &authority[1..=end]
    } else {
        authority.rsplit_once(':').map(|(h, _)| h).unwrap_or(authority)
    };
    let hn = hostname.trim_start_matches('[').trim_end_matches(']');
    !(hn == "localhost" || hn == "127.0.0.1" || hn == "::1")
}

/// stripSessionDetail — drop the heavy per-session detail from the broadcast payload.
// WHY it walks in place instead of deep-cloning: the old body cloned the whole summary
// (every timeline included) only to overwrite `sessions`, then cloned each session in full
// before dropping its heavy keys — paid per `/api/summary` read and per SSE frame
// (TRDD-091Z1FU0, TRDD-MBQ9LXAN). Walking in order clones only what survives; bytes stay
// identical because `preserve_order` keeps a replaced key in place and appends a new one,
// exactly like the old insert/shift_remove sequence did.
pub fn strip_session_detail(summary: &Value) -> Value {
    let Some(obj) = summary.as_object() else { return summary.clone() };
    let mut out = Map::with_capacity(obj.len());
    for (k, v) in obj {
        if k == "sessions" {
            if let Some(sessions) = v.as_array() {
                out.insert(k.clone(), Value::Array(sessions.iter().map(strip_one_session).collect()));
                continue;
            }
        }
        out.insert(k.clone(), v.clone());
    }
    Value::Object(out)
}

/// One element of `strip_session_detail's `sessions` array: drop `fileOps`/`generatedFiles`/
/// `generatedFilesTruncated`, blank `timeline` in place (appending it when absent, matching the
/// old insert-then-remove order exactly), and clone every other field.
pub(crate) fn strip_one_session(s: &Value) -> Value {
    let Some(sobj) = s.as_object() else {
        let mut c = Map::new();
        c.insert("timeline".into(), Value::Array(Vec::new()));
        return Value::Object(c);
    };
    let mut c = Map::with_capacity(sobj.len());
    let mut saw_timeline = false;
    for (k, v) in sobj {
        match k.as_str() {
            "timeline" => {
                c.insert(k.clone(), Value::Array(Vec::new()));
                saw_timeline = true;
            }
            "fileOps" | "generatedFiles" | "generatedFilesTruncated" => {}
            _ => {
                c.insert(k.clone(), v.clone());
            }
        }
    }
    if !saw_timeline {
        c.insert("timeline".into(), Value::Array(Vec::new()));
    }
    Value::Object(c)
}

/// Byte-identical streaming twin of `strip_session_detail(summary).to_string()`.
// WHY: the stripped summary used to be a second resident per-session Value tree (removed by
// TRDD-091Z1FU0); both of its readers immediately serialize it, so writing the stripped form
// straight from the summary removes the tree without changing a byte. Every branch mirrors
// strip_session_detail / strip_one_session; `preserve_order` keeps key positions, so the order
// below IS the contract.
pub struct StrippedView<'a>(pub &'a Value);

const EMPTY_TIMELINE: &[Value] = &[];

impl serde::Serialize for StrippedView<'_> {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let Some(obj) = self.0.as_object() else { return self.0.serialize(ser) };
        let mut m = ser.serialize_map(Some(obj.len()))?;
        for (k, v) in obj {
            if k == "sessions" {
                if let Some(arr) = v.as_array() {
                    m.serialize_entry(k, &StrippedSessions(arr))?;
                    continue;
                }
            }
            m.serialize_entry(k, v)?;
        }
        m.end()
    }
}

struct StrippedSessions<'a>(&'a [Value]);

impl serde::Serialize for StrippedSessions<'_> {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeSeq;
        let mut seq = ser.serialize_seq(Some(self.0.len()))?;
        for s in self.0 {
            seq.serialize_element(&StrippedSession(s))?;
        }
        seq.end()
    }
}

struct StrippedSession<'a>(&'a Value);

impl serde::Serialize for StrippedSession<'_> {
    fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        let Some(sobj) = self.0.as_object() else {
            let mut m = ser.serialize_map(Some(1))?;
            m.serialize_entry("timeline", EMPTY_TIMELINE)?;
            return m.end();
        };
        let mut m = ser.serialize_map(None)?;
        let mut saw_timeline = false;
        for (k, v) in sobj {
            match k.as_str() {
                "timeline" => {
                    m.serialize_entry(k, EMPTY_TIMELINE)?;
                    saw_timeline = true;
                }
                "fileOps" | "generatedFiles" | "generatedFilesTruncated" => {}
                _ => m.serialize_entry(k, v)?,
            }
        }
        if !saw_timeline {
            m.serialize_entry("timeline", EMPTY_TIMELINE)?;
        }
        m.end()
    }
}

/// Default and ceiling for `GET /api/cards/page?limit=`.
const CARDS_PAGE_DEFAULT_LIMIT: usize = 50;
const CARDS_PAGE_MAX_LIMIT: usize = 200;

/// `GET /api/cards/page|children|by-ids` and `GET /api/stats/overview` (TRDD-9VX3WTGU Phase C,
/// Amendment 1: the dashboard never receives the whole corpus). Blocking — run it on
/// `spawn_blocking`. Every answer comes from the DuckDB card table (key columns + the page cards
/// own text), NOT from the memoized summary, so none of them waits on, or is invalidated by, a
/// summary rebuild; they are the raw LOG cards (no OTEL merge stamps), header-stripped by
/// `strip_one_session` exactly like `/api/summary`.
///
/// The store lock is held for the queries only; stripping happens after it is released.
fn cards_route(
    state: &Arc<Mutex<CoreState>>,
    path: &str,
    q: &std::collections::HashMap<String, String>,
) -> (StatusCode, String) {
    let bad = |msg: &str| (StatusCode::BAD_REQUEST, error_json(msg));
    let strip_all = |v: Vec<Value>| -> Vec<Value> { v.iter().map(strip_one_session).collect() };
    let st = state.lock_timed();
    match path {
        "/api/cards/page" => {
            let limit = match q.get("limit") {
                None => CARDS_PAGE_DEFAULT_LIMIT,
                Some(v) => match v.parse::<usize>() {
                    Ok(n) if (1..=CARDS_PAGE_MAX_LIMIT).contains(&n) => n,
                    _ => return bad(&format!("limit must be an integer in 1..={CARDS_PAGE_MAX_LIMIT}")),
                },
            };
            // `<last_active_ms>:<seq>` — exactly what `nextCursor` emits. A malformed cursor is a
            // 400, never "start over": silently restarting would loop a buggy client forever.
            let after = match q.get("cursor").filter(|c| !c.is_empty()) {
                None => None,
                Some(c) => {
                    let parsed = c.split_once(':').and_then(|(ms, seq)| Some((ms.parse::<f64>().ok()?, seq.parse::<i64>().ok()?)));
                    match parsed {
                        Some((ms, seq)) if ms.is_finite() => Some((ms, seq)),
                        _ => return bad("cursor must be <last_active_ms>:<seq>"),
                    }
                }
            };
            let page = st.cards.page(after, limit);
            drop(st);
            let next = page.next_cursor.map(|(ms, seq)| Value::from(format!("{ms}:{seq}"))).unwrap_or(Value::Null);
            let body = serde_json::json!({
                "sessions": strip_all(page.sessions),
                "nextCursor": next,
                "hasMore": page.has_more,
                "total": page.total,
            });
            (StatusCode::OK, body.to_string())
        }
        "/api/cards/children" => {
            let Some(parent) = q.get("parentId").filter(|p| !p.is_empty()) else { return bad("parentId is required") };
            let kids = st.cards.children(parent);
            let total = st.cards.child_count(parent);
            drop(st);
            (StatusCode::OK, serde_json::json!({ "sessions": strip_all(kids), "total": total }).to_string())
        }
        "/api/cards/by-ids" => {
            let ids: Vec<&str> = q.get("ids").map(|s| s.split(',').filter(|i| !i.is_empty()).collect()).unwrap_or_default();
            let found = st.cards.by_ids(&ids);
            drop(st);
            (StatusCode::OK, serde_json::json!({ "sessions": strip_all(found) }).to_string())
        }
        "/api/stats/overview" => {
            let mut stats = st.cards.stats_key();
            let active = st.cards.newest_root_id();
            drop(st);
            // `activeSessionId`: the root card with the newest activity. `lastReceivedAtMs` is
            // null until Phase E adds a maintained field — deriving it here would mean scanning
            // the span window's `receivedAt` stamps, an O(window) walk this endpoint exists to
            // avoid.
            if let Some(o) = stats.as_object_mut() {
                o.insert("activeSessionId".into(), active.map_or(Value::Null, Value::from));
                o.insert("lastReceivedAtMs".into(), Value::Null);
            }
            (StatusCode::OK, stats.to_string())
        }
        _ => (StatusCode::NOT_FOUND, error_json("not found")),
    }
}

/// The query params of a request (the TS `new URLSearchParams(rawUrl.slice(qIdx + 1))` — last
/// value wins for a repeated key, which URLSearchParams.get answers as FIRST; our handlers never
/// send repeated keys, so the difference is unobservable on the frozen surface).
fn query_of<T>(req: &Request<T>) -> std::collections::HashMap<String, String> {
    let mut out = std::collections::HashMap::new();
    let Some(q) = req.uri().query() else { return out };
    for pair in q.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        // percent-decode + '+' → space (the subset URLSearchParams applies).
        let dec = |s: &str| percent_decode(&s.replace('+', " "));
        out.entry(dec(k)).or_insert_with(|| dec(v));
    }
    out
}

/// Lossy percent-decode — shared by query_of and the `/api/timeline/:id` path segment. The TS
/// path segment goes through decodeURIComponent, which THROWS a URIError on a malformed escape;
/// the freeze pins the always-200 response shape, so a malformed escape decodes lossily here
/// (the literal byte survives) rather than reproducing V8's exception path. NO '+' handling —
/// decodeURIComponent has none; the URLSearchParams '+' → space belongs to query_of alone.
fn percent_decode(s: &str) -> String {
    let mut bytes = Vec::with_capacity(s.len());
    let mut it = s.bytes();
    while let Some(b) = it.next() {
        if b == b'%' {
            let h = [it.next().unwrap_or(0), it.next().unwrap_or(0)];
            let hex = std::str::from_utf8(&h).ok().and_then(|h| u8::from_str_radix(h, 16).ok());
            bytes.push(hex.unwrap_or(b'%'));
        } else {
            bytes.push(b);
        }
    }
    String::from_utf8_lossy(&bytes).into_owned()
}

/// server.ts readBodyCapped — the whole body, or None once it exceeds `max` (the TS destroys the
/// socket and never answers; the caller turns None into an Err that drops the connection).
async fn read_body_capped(mut body: hyper::body::Incoming, max: usize) -> Result<Option<Vec<u8>>, String> {
    use http_body_util::BodyExt;
    let mut buf: Vec<u8> = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|e| format!("body read: {e}"))?;
        if let Some(data) = frame.data_ref() {
            if buf.len() + data.len() > max {
                return Ok(None);
            }
            buf.extend_from_slice(data);
        }
    }
    Ok(Some(buf))
}

/// The POST /api/hook-config reader: chunks are kept only while the total so far is under
/// `max` (the rest is read and dropped), and whatever was kept is what gets parsed.
async fn read_body_keep_under(mut body: hyper::body::Incoming, max: usize) -> Result<Vec<u8>, String> {
    use http_body_util::BodyExt;
    let mut buf: Vec<u8> = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|e| format!("body read: {e}"))?;
        if let Some(data) = frame.data_ref() {
            if buf.len() < max {
                buf.extend_from_slice(data);
            }
        }
    }
    Ok(buf)
}

/// Resolve one call to its full CallContext (freeze row 35's engine). Shared by the HTTP route and
/// the `get_call_context` MCP tool — the TS has ONE `resolveCallContext` behind both, and a second
/// copy here would be a wire-shape fork waiting to happen.
///
/// LOCK CHOREOGRAPHY (the P4s rule): the registry lookup is cheap and in-memory so it runs UNDER
/// the lock with the POINTER CLONED OUT; the multi-MB body read happens with the lock RELEASED;
/// the lock is re-taken only for the TRDD-BURNWDGT account backfill.
/// `ContextCompositionIndex.getSession` — one session's composition, LRU-cached, parsed on demand
/// from the live registry (never a background sweep). Shared by freeze row 36 and the three scoped
/// composition tools.
///
/// LOCK CHOREOGRAPHY (the P4s rule, and the whole reason this is shaped this way): resolve refs
/// UNDER the lock (cheap, in-memory), RELEASE it before parsing body files, re-take it only to
/// store. Parsing a multi-MB body while holding CoreState would stall every other request.
///
/// NOT PORTED: the TS `heavyGuard` admission deferral. It keeps concurrent heavy parses from
/// blowing the V8 heap; this core has no V8 heap and the work is already off the executor.
async fn composition_for(
    state: &Arc<Mutex<CoreState>>,
    session_id: &str,
    now: f64,
    projects: &std::collections::HashMap<String, String>,
) -> Result<Value, String> {
    let cached = {
        let mut st = state.lock_timed();
        st.composition.get_cached(session_id)
    };
    if let Some(c) = cached {
        return Ok(c);
    }
    // The project HINT is load-bearing, not decoration: it fills every composition's `project`
    // and is what a `scope` string is matched against. Omitting it (as this route did until
    // P4x.2c) makes every composition read `project: "unknown"` and every project-scoped query
    // match nothing — while still answering 200.
    //
    // The map is BUILT BY THE CALLER and passed in. Building it here was O(sessions) per
    // session: `compositions_in_scope` calls this once per in-scope session, and each call
    // rebuilt the whole `sessionId → project` map over the entire summary — O(sessions²) map
    // probes per scope pass. The live profile put 14,071 of 14,071 samples in exactly that
    // shape (`composition_project_map` → `IndexMap::get_index_of` → `_platform_memcmp`).
    // The map is now built ONCE per pass and borrowed.
    let project = projects.get(session_id).cloned();
    let refs = {
        let st = state.lock_timed();
        crate::context_composition_index::resolve_refs(&st.bodies, session_id)
    };
    let sid = session_id.to_owned();
    let project_known = project.is_some();
    let built = tokio::task::spawn_blocking(move || {
        crate::context_composition_index::build_session_composition(&sid, &refs, project.as_deref(), now)
    })
    .await
    .map_err(|e| format!("composition build join failed: {e}"))?;
    // The served summary can be one rebuild behind (that is what keeps the read off the lock,
    // TRDD-UTFVMVT8), so a session younger than one rebuild is ABSENT from it and its project is
    // None. The composition cache is keyed on session id alone (LRU 64, no data_version), so
    // caching that build would pin `project: "unknown"` for the session until eviction — the
    // P4x.2c failure where a project-scoped query matches nothing while answering 200. Serve it,
    // do not cache it; the next call resolves against a newer summary.
    // ponytail: a session whose card NEVER appears re-parses its bodies on every call — key the
    // cache on data_version if that ever shows up in the timings.
    if project_known {
        let mut st = state.lock_timed();
        st.composition.put(session_id, built.clone());
    }
    Ok(built)
}

/// `sessionsInScope` — the scoped set of compositions plus the coverage block that describes it.
/// Sequential by design: each `composition_for` may parse multi-MB bodies, and the cap (25) is what
/// bounds the work — fanning them out would just make the same bounded work concurrent while
/// multiplying peak memory.
pub(crate) async fn compositions_in_scope(state: &Arc<Mutex<CoreState>>, scope: Option<&str>, now: f64) -> Result<(Vec<Value>, Value), String> {
    // The project map comes from the cards table and the burn subset, never from `summary_now` (TRDD-735Q3JF4
    // item 3). This scan used to build the whole summary at boot and every 30 s, one of the summary_now callers
    // that run C2 measured against the idle commit fill. The state lock is held only for the two short reads
    // below; TRDD-UTFVMVT8 measured the inline rebuild this replaced at 12.6 s and 30.1 s under that same lock.
    let all_ids: Vec<String> = {
        let st = state.lock_timed();
        st.bodies.session_ids().iter().map(|s| (*s).to_owned()).collect()
    };
    let projects = composition_projects(state, &all_ids).await?;
    let (ids, coverage) = {
        let refs: Vec<&str> = all_ids.iter().map(String::as_str).collect();
        crate::context_composition_index::resolve_scope(
            &refs,
            scope,
            &|id| projects.get(id).cloned(),
            crate::context_composition_index::DEFAULT_SCOPE_CAP,
        )
    };
    let mut comps = Vec::with_capacity(ids.len());
    for id in ids {
        // The SAME map, borrowed: the per-session rebuild of this map was the O(sessions²)
        // shape the live profile sampled (14,071/14,071 frames in
        // `composition_project_map` → `IndexMap::get_index_of` → `_platform_memcmp`).
        comps.push(composition_for(state, &id, now, &projects).await?);
    }
    Ok((comps, coverage))
}

/// TRDD-735Q3JF4 item 3 — the `sessionId → project` map `compositions_in_scope` needs for the bodies in
/// `ids`: exactly `composition_project_map` over the full summary, for those ids, with no summary built.
///
/// The full merge settles an id's project from three things, and each is read here: its own card row (its
/// project, and whether a log card displaces an OTEL twin of the same id); the `agent-<id>` row, which the
/// feed merge collapses with the placeholder `<id>`; and that placeholder row, whose workspace the collapsed
/// transcript falls back to. So the card read covers the closure of every bodies id, `{id, agent-<id>, id
/// without an agent- prefix}`. The OTEL-window sessions come from `burn_summary_now`: its OTEL survivors are
/// the full merge's own, because every card with an OTEL id is in the burn subset, so the displacement is the
/// same. The merge is `feed_merge`'s, run unchanged over light copies of the values it reads.
///
/// The DuckDB read runs on a second connection (`CardStore::read_connection`, taken under the lock) and on
/// the blocking pool. The merge and the projection run on this task, so the thread-local
/// `composition_project_map_builds` counter sees this pass's build. A failed step (the clone, the blocking task,
/// the query, one row's parse) returns an error naming it; `compositions_in_scope` propagates it with `?`.
///
/// KNOWN GAP, theoretical and not reachable by the ids seen so far (the review judged that real ids never take
/// this shape; not checked here): the closure fetches an id's own `agent-` twin, not that twin's twin. If a bodies
/// id `X` is an `agent-Y` transcript that is itself a placeholder candidate (it carries a parent), the full merge may
/// consume `X` through its own twin row `agent-agent-Y`, which this closure does not fetch. `X` would then map here
/// and be absent from the full summary.
pub(crate) async fn composition_projects(state: &Arc<Mutex<CoreState>>, ids: &[String]) -> Result<std::collections::HashMap<String, String>, String> {
    let mut closure: Vec<String> = Vec::with_capacity(ids.len() * 3);
    for id in ids {
        closure.push(id.clone());
        // The twin rule of `feed_merge::link_twin_id`, applied to an id: `agent-` followed by the sessionId.
        closure.push(format!("agent-{id}"));
        if let Some(placeholder) = id.strip_prefix("agent-") {
            closure.push(placeholder.to_owned());
        }
    }
    closure.sort();
    closure.dedup();
    let conn = state.lock_timed().cards.read_connection()?;
    let burn = burn_summary_now(state);
    let rows = {
        let read = closure.clone();
        tokio::task::spawn_blocking(move || crate::card_store::composition_rows(&conn, &read))
            .await
            .map_err(|e| format!("the composition card read did not finish: {e}"))??
    };
    let in_closure: std::collections::HashSet<&str> = closure.iter().map(String::as_str).collect();
    // Only the OTEL-fed entries of the burn subset: its log cards are already in `rows`. Light copies, so the
    // window sessions' timelines are not cloned on every pass.
    let otel: Vec<Value> = burn
        .get("sessions")
        .and_then(Value::as_array)
        .map(|sessions| {
            sessions
                .iter()
                .filter(|s| s.get("dataSource").and_then(Value::as_str) == Some("otel"))
                .filter(|s| s.get("sessionId").and_then(Value::as_str).is_some_and(|id| in_closure.contains(id)))
                .map(light_session)
                .collect()
        })
        .unwrap_or_default();
    let merged = crate::feed_merge::link_subagent_transcripts(crate::feed_merge::merge_otel_and_log_sessions(otel, rows));
    let mut root = Map::new();
    root.insert("sessions".into(), Value::Array(merged));
    Ok(crate::composition_project_map(&Value::Object(root)))
}

/// The fields of a session that the feed merge and the project resolver read, copied. The rest, the
/// timeline above all, stays where it is.
fn light_session(session: &Value) -> Value {
    let mut light = Map::new();
    for key in ["sessionId", "source", "dataSource", "projectPath", "workspace"] {
        if let Some(value) = session.get(key) {
            light.insert(key.into(), value.clone());
        }
    }
    Value::Object(light)
}

/// resolveSessionCard (server.ts) — the summary card with its timeline made REAL. Shared by freeze
/// row 30 and the `get_session_detail` MCP tool, which in the TS both go through the same accessor.
///
/// An empty (or absent) timeline on a session a log file backs ⇒ one fresh full parse of that file,
/// re-stored (`put_log_session` bumps data_version, as the TS putLogSession does). Then
/// TRDD-5GFSFX0Q: the displaced OTEL twin's api_request entries are grafted onto the SERVED copy
/// only — the graft runs AFTER put_log_session, so the STORED card stays pure (the TS grafts onto a
/// shallow copy for the same reason).
///
/// NOT PORTED: statuslineReader.overlay on the reparsed card (the statusline store is unported —
/// the P4m note).
///
/// TRDD-QE114936: `summary` is now READ IN by the caller (via `summary_now`, off the state lock)
/// instead of being rebuilt here under `st`'s guard — this call previously ran the whole O(window)
/// `build_session_summary` PER INVOCATION while already holding the lock; one caller (the
/// per-candidate `timeline_of` closure in `get_cache_break_report`) measured a single 64.5 s hold
/// this way. `st` is kept `&mut` only for the reparse-on-demand fallback's `put_log_session`.
///
/// CALL THIS AT MOST ONCE PER SESSION ID PER HANDLER. The reparse fallback below re-stores the
/// card via `put_log_session`, which bumps `data_version`; when the summary was rebuilt inline the
/// next call saw the freshly stored timeline and did no work. The summary a handler now holds is
/// FROZEN for the whole scan, so a second call on the same id re-reads the same empty timeline and
/// reparses the multi-MB transcript AGAIN. Every current shaper resolves one timeline per card,
/// which is what makes this safe — a shaper that starts resolving a card twice would turn a
/// bounded scan into an unbounded one.
///
/// TRDD-MVR6PXC0: the body is now four steps — three cheap ones that need the state, and ONE
/// (`reparse_session_card`) that needs only `&Env`. That is the split `resolve_session_card_offlock`
/// exploits; the pieces are shared so the two drivers cannot drift into two different answers.
fn resolve_session_card(st: &mut CoreState, summary: &Value, session_id: &str, now: i64) -> Option<Value> {
    let mut session = summary_card(summary, session_id);
    if timeline_empty(session.as_ref()) && st.cards.contains(session_id) {
        if let Some(card) = reparse_session_card(&st.log_env, session_id, now) {
            session = Some(stamp_and_store_reparsed(st, card));
        }
    }
    if let Some(s) = session.as_mut() {
        graft_otel_attribution_onto(st, s, session_id);
    }
    session
}

/// The summary's own copy of one card, before any reparse — a linear scan over an already-in-memory
/// snapshot the caller read off the lock. No state, no I/O.
fn summary_card(summary: &Value, session_id: &str) -> Option<Value> {
    summary
        .get("sessions")
        .and_then(Value::as_array)
        .and_then(|ss| ss.iter().find(|s| s.get("sessionId").and_then(Value::as_str) == Some(session_id)))
        .cloned()
}

/// The reparse precondition: a card that IS in the summary but carries no timeline. Absent ⇒ false
/// (there is no card to fill in), which is what makes a miss cost nothing.
fn timeline_empty(session: Option<&Value>) -> bool {
    session.is_some_and(|s| s.get("timeline").and_then(Value::as_array).is_none_or(Vec::is_empty))
}

/// TRDD-MVR6PXC0: the SLOW half of the reparse-on-demand fallback, split out precisely because it
/// needs only `&Env` — a fresh FULL parse of the one (possibly multi-MB) transcript backing the id,
/// i.e. a synchronous disk read plus a JSONL parse, measured at 1,037–3,948 ms per candidate. It has
/// zero data dependency on `CoreState`, so no caller has any reason to hold the state guard across
/// it, and every per-candidate caller must not: the state mutex is the INGEST path's mutex, so a
/// 4 s hold stalls every session posting to this server for those 4 s.
fn reparse_session_card(env: &agentlens_logscan::discovery::Env, session_id: &str, now: i64) -> Option<Value> {
    crate::log_reader::reparse_session(env, session_id, now).and_then(|scanned| scanned.cards.into_iter().next())
}

/// The CHEAP half of the fallback, and the only part that needs `&mut CoreState`: the accountId
/// stamp (a registry lookup) plus `put_log_session` (an IndexMap insert + a `data_version` bump).
fn stamp_and_store_reparsed(st: &mut CoreState, mut card: Value) -> Value {
    // ingest_scanned's accountId stamp — the TS parser stamps it natively inside
    // _buildCard, so the reparsed card must carry it here too.
    if let Some(obj) = card.as_object_mut() {
        let acct = obj.get("sessionId").and_then(Value::as_str).and_then(|sid| st.accounts.account_for(sid)).map(str::to_owned);
        if let Some(a) = acct {
            obj.insert("accountId".into(), Value::from(a));
        }
    }
    st.put_log_session(card.clone());
    card
}

/// TRDD-5GFSFX0Q's graft, onto the SERVED copy only — it runs AFTER `put_log_session`, so the
/// STORED card stays pure. Cheap and state-bound: one IndexMap read plus a merge of two Vecs already
/// sized to a single session's timeline, so this half keeps the guard.
fn graft_otel_attribution_onto(st: &CoreState, session: &mut Value, session_id: &str) {
    let claude_log = session.get("source").and_then(Value::as_str) == Some("claude_code")
        && session.get("dataSource").and_then(Value::as_str) == Some("log");
    if !claude_log {
        return;
    }
    if let Some(entries) = st.otel_attribution.get(session_id).filter(|e| !e.is_empty()) {
        let log_tl: Vec<Value> = session.get("timeline").and_then(Value::as_array).cloned().unwrap_or_default();
        let grafted = crate::feed_merge::graft_otel_attribution(&log_tl, Some(entries));
        if let Some(obj) = session.as_object_mut() {
            obj.insert("timeline".into(), Value::Array(grafted));
        }
    }
}

/// TRDD-MVR6PXC0: `resolve_session_card` for the PER-CANDIDATE scan closures — the same answer, with
/// the transcript reparse run OUTSIDE the state guard. TRDD-UTFVMVT8's snapshot-then-work shape,
/// applied one level down: the guard is taken three times, briefly, for work that is a map lookup or
/// a map insert, and released across the disk read between them.
///
/// Four handlers (`get_cost_by_cause`, `get_cache_risk_costs`, `get_cache_break_report`,
/// `check_cache_expiry`) call this up to 20–50 times per invocation, and each call that reparses
/// used to hold the mutex for the whole parse: eight holds of 1,037–3,948 ms in one measured window
/// (the card's own table). `resolve_session_card` itself is UNCHANGED for its four single-lookup
/// callers — they pay the reparse at most once per request, so the extra lock churn buys them
/// nothing.
///
/// THE TRADE, stated rather than silently accepted (UTFVMVT8 framed its own the same way):
/// check-reparse-store is no longer one atomic critical section, so
///   1. two concurrent scans landing on the same empty-timeline id can both reparse the same file —
///      wasted disk, not a wrong answer (`put_log_session` is a last-write-wins upsert and both
///      compute the same card from the same file; cf. `burn_status_seed`'s "racing another seeder is
///      harmless"), and
///   2. a sweeper that stores a FRESHER card for this id during our unlocked reparse loses to our
///      store when we re-lock. Bounded staleness, not loss: the window is one file parse, and the
///      next sweeper pass — or the next resolve that again finds an empty timeline — re-stores the
///      newer card.
///
/// Both are strictly cheaper than blocking every ingest for up to four seconds per candidate.
fn resolve_session_card_offlock(
    st2: &Arc<Mutex<CoreState>>,
    env: &agentlens_logscan::discovery::Env,
    summary: &Value,
    session_id: &str,
    now: i64,
) -> Option<Value> {
    let mut session = summary_card(summary, session_id);
    if timeline_empty(session.as_ref()) {
        // Lock 1: one indexed point query on the card table.
        let has_log = {
            let st = st2.lock_timed();
            st.cards.contains(session_id)
        };
        if has_log {
            // NO GUARD IS ALIVE HERE — this is the multi-MB disk read + JSONL parse.
            if let Some(card) = reparse_session_card(env, session_id, now) {
                // Lock 2: the accountId stamp + the store.
                let mut st = st2.lock_timed();
                session = Some(stamp_and_store_reparsed(&mut st, card));
            }
        }
    }
    if let Some(s) = session.as_mut() {
        // Lock 3: the OTEL graft's one map read and in-memory merge.
        let st = st2.lock_timed();
        graft_otel_attribution_onto(&st, s, session_id);
    }
    session
}

/// Drill ONE block to its real content (freeze row 37's engine + the `get_block_content` tool).
/// Shared for the same reason `resolve_call_context` is: the TS has ONE `getBlockContent` behind
/// both surfaces, and two copies of a payload this shape is a wire fork waiting to happen.
///
/// The TWO message branches are DISTINCT on purpose, and both are a normal answer rather than an
/// error: "no body captured for that turn" and "that block does not exist" are different facts, and
/// collapsing them would leave a caller unable to tell a gap in capture from a bad index.
///
/// An IMAGE returns metadata + a body-file ref ONLY — never the base64 bytes (pointer-only), which
/// is what keeps a drill from pasting a multi-MB blob into the caller's transcript.
async fn resolve_block_content(
    state: &Arc<Mutex<CoreState>>,
    session_id: &str,
    turn: f64,
    block_index: f64,
    full: bool,
) -> Result<Value, String> {
    let n = crate::summarize::helpers::num;
    let fmt = crate::summarize::helpers::fmt_js_num;
    let pointer = {
        let st = state.lock_timed();
        // requestPointers(session)[turn - 1] — 1-based turns.
        let ptrs = st.bodies.request_pointers(session_id);
        let idx = turn - 1.0;
        if idx < 0.0 { None } else { ptrs.get(idx as usize).and_then(|p| p.body_ref.clone()) }
    };
    let Some(body_ref) = pointer.filter(|b| !b.is_empty()) else {
        return Ok(serde_json::json!({
            "sessionId": session_id,
            "turn": n(turn),
            "message": format!("No raw body for call/turn {} of session {session_id} in the live registry (lazy — historical bodies are not indexed).", fmt(turn)),
        }));
    };
    let read = tokio::task::spawn_blocking(move || {
        crate::context_composition_index::read_block_content(&body_ref, block_index as i64, full)
    })
    .await
    .map_err(|e| format!("block-content join failed: {e}"))?;
    let Some(b) = read else {
        return Ok(serde_json::json!({
            "sessionId": session_id,
            "turn": n(turn),
            "blockIndex": n(block_index),
            "message": format!("No block {} at turn {}.", fmt(block_index), fmt(turn)),
        }));
    };
    // `{ sessionId, turn, ...block }` — the spread puts the block's own keys AFTER these two, in
    // the block's order.
    let mut m = serde_json::Map::new();
    m.insert("sessionId".into(), Value::String(session_id.to_owned()));
    m.insert("turn".into(), n(turn));
    if let Some(o) = b.as_object() {
        for (k, v) in o {
            m.insert(k.clone(), v.clone());
        }
    }
    Ok(Value::Object(m))
}

async fn resolve_call_context(
    state: &Arc<Mutex<CoreState>>,
    session_id: &str,
    request_id: Option<&str>,
    span_id: Option<&str>,
) -> Result<Value, String> {
    let ptr = {
        let st = state.lock_timed();
        st.bodies.resolve_request(session_id, request_id, span_id).cloned()
    };
    let Some(p) = ptr else { return Ok(Value::Null) };
    let (body_ref, inline) = (p.body_ref.clone(), p.inline_body.clone());
    let built = tokio::task::spawn_blocking(move || match body_ref {
        Some(r) if !r.is_empty() => crate::raw_body_context::build_call_context(&r, false),
        // An inline body is only present when Claude Code had no file sink configured; a parse
        // failure there is a null context, never an error.
        _ => inline
            .and_then(|b| serde_json::from_str::<Value>(&b).ok())
            .and_then(|v| crate::raw_body_context::build_call_context_from_json(&v, false)),
    })
    .await
    .map_err(|e| format!("callcontext build join failed: {e}"))?;
    let Some(ctx) = built else { return Ok(Value::Null) };
    let ctx = crate::raw_body_context::finalize_resolved_context(
        ctx,
        session_id,
        request_id,
        p.request_id.as_deref(),
        p.model.as_deref(),
    );
    if let Some(acct) = ctx.get("accountUuid").and_then(Value::as_str).filter(|a| !a.is_empty()) {
        let mut st = state.lock_timed();
        st.accounts.record(session_id, acct);
    }
    Ok(ctx)
}

fn json_response(status: StatusCode, body: String) -> Response<SseBody> {
    let mut resp = Response::new(boxed_full(Bytes::from(body)));
    *resp.status_mut() = status;
    resp.headers_mut().insert("Content-Type", hyper::header::HeaderValue::from_static("application/json"));
    resp
}

/// The `/events` response: preamble ping + the on-connect update frame, then every broadcast
/// frame for as long as the client stays connected.
fn sse_response(state: &Arc<Mutex<CoreState>>, hub: &SseHub, now_ms: f64) -> Response<SseBody> {
    use http_body_util::BodyExt;
    let (_, summary) = summary_now(state, now_ms);
    let (spans, gaps, build_id) = {
        let st = state.lock_timed();
        let gaps = crate::collector_lifecycle::compute_gaps(&st.lifecycle, crate::collector_lifecycle::MIN_GAP_MS);
        (st.window.spans.clone(), gaps, st.build_id.clone())
    };
    let first = build_update_payload(&summary, &spans, &build_id, gaps, now_ms).to_string();
    let mut rx = hub.subscribe();
    let (tx, frames) = tokio::sync::mpsc::unbounded_channel::<Bytes>();
    // Pump the broadcast into this client's own queue; the pump ends when the client drops the
    // body (send fails) or the hub closes.
    tokio::spawn(async move {
        loop {
            match rx.recv().await {
                Ok(b) => {
                    if tx.send(b).is_err() {
                        return;
                    }
                }
                Err(broadcast::error::RecvError::Lagged(_)) => continue,
                Err(broadcast::error::RecvError::Closed) => return,
            }
        }
    });
    let stream = SseStream { head: vec![Bytes::from_static(b":\n\n"), sse_frame(&first)].into(), frames };
    let body = StreamBody::new(stream).boxed();
    let mut resp = Response::new(body);
    *resp.status_mut() = StatusCode::OK;
    let h = resp.headers_mut();
    h.insert("Content-Type", hyper::header::HeaderValue::from_static("text/event-stream"));
    h.insert("Cache-Control", hyper::header::HeaderValue::from_static("no-cache"));
    h.insert("Connection", hyper::header::HeaderValue::from_static("keep-alive"));
    resp
}

/// A frame stream: the fixed head chunks first, then the client's queue until it closes.
struct SseStream {
    head: std::collections::VecDeque<Bytes>,
    frames: tokio::sync::mpsc::UnboundedReceiver<Bytes>,
}

impl futures_core::Stream for SseStream {
    type Item = Result<Frame<Bytes>, std::convert::Infallible>;
    fn poll_next(mut self: std::pin::Pin<&mut Self>, cx: &mut std::task::Context<'_>) -> std::task::Poll<Option<Self::Item>> {
        if let Some(b) = self.head.pop_front() {
            return std::task::Poll::Ready(Some(Ok(Frame::data(b))));
        }
        self.frames.poll_recv(cx).map(|o| o.map(|b| Ok(Frame::data(b))))
    }
}

/// server.ts safeJson — JSON inlined into a `<script>` must not be able to close that script,
/// open a comment, or start a template expression.
fn safe_json(v: &Value) -> String {
    safe_json_text(v.to_string())
}

/// safe_json over already-serialized JSON text — the same three replacements, so the shell bytes
/// are identical whether the JSON came from a Value or from StrippedView (TRDD-091Z1FU0).
fn safe_json_text(s: String) -> String {
    s.replace("</", "<\\/").replace("<!--", "<\\!--").replace("${", "\\${")
}

#[cfg(test)]
mod safe_json_tests {
    use super::*;

    /// safe_json_text over the serialized JSON gives the same bytes as safe_json over the Value,
    /// for each breakout sequence the three replacements neutralize.
    #[test]
    fn safe_json_text_matches_safe_json() {
        let v = serde_json::json!({"a": "</script><!-- ${x} \u{2028}", "b": ["\u{0001}", "🚀"]});
        assert_eq!(safe_json_text(v.to_string()), safe_json(&v));
    }
}

/// src/shellTemplate.ts substituteTokens — ONE left-to-right scan. A chain of `replace` calls
/// rescans each step's output, so a session whose prompt is the literal `@@SIDEBAR_INIT_JSON@@`
/// would have the sidebar JSON spliced INTO the summary JSON string — a breakout of the string
/// literal, executed in the dashboard's origin (review of 85f0b08, F1). Unknown tokens stay verbatim.
fn substitute_tokens(template: &str, values: &[(&str, &str)]) -> String {
    // Compiled once (review of 0eb2cf9, G3) — the TS twin's regex is module-level too.
    static TOKEN: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = TOKEN.get_or_init(|| regex::Regex::new(r"@@[A-Z_]+@@").expect("static pattern"));
    re.replace_all(template, |c: &regex::Captures| {
        let t = &c[0];
        values.iter().find(|(k, _)| *k == t).map(|(_, v)| (*v).to_owned()).unwrap_or_else(|| t.to_owned())
    })
    .into_owned()
}

/// `GET /` — server.ts getHtml + the route's two contract headers (server.ts:4407).
fn dashboard_html(state: &Arc<Mutex<CoreState>>, media_dir: &std::path::Path, restricted: bool) -> Result<Response<SseBody>, String> {
    let now = crate::now_ms() as f64;
    // Read per request, like the TS: 28 KB, and a dev can edit the shell without a restart.
    let tmpl = std::fs::read_to_string(media_dir.join("index.html")).map_err(|e| format!("index.html: {e}"))?;
    let (_, summary) = summary_now(state, now);
    let (spans, build_id) = {
        let st = state.lock_timed();
        // The SAME build_id the update frames carry — the dashboard reloads on a mismatch, so a
        // different fingerprint here (the TS's bundle mtimes) would reload it on first connect.
        (st.window.spans.clone(), st.build_id.clone())
    };
    let sidebar = if summary.is_null() {
        serde_json::json!({ "isActive": false, "lastActivityMs": 0, "sessionCount": 0, "agentSources": [], "currentSession": null, "burnRate": null })
    } else {
        crate::update_payload::compute_sidebar_payload(&summary, &spans, now)
    };
    let summary_json = safe_json_text(serde_json::to_string(&StrippedView(&summary)).expect("stripped summary serializes: string keys only"));
    let sidebar_json = safe_json(&sidebar);
    // The mount prefix is EMPTY here, deliberately, and not read from AGENTLENS_BASE_PATH: the
    // base-path STRIP in handle() is still on this module's deferred list, and a shell that emits
    // `/lens/dashboard.js` to a router that only knows `/dashboard.js` is a 200 page that can never
    // load (review F2) — worse than the honest root-only behaviour. Port both halves together.
    let base = "";
    // TRDD-1ZH1D5EG: the RESTRICTED verdict reaches the webview through this meta tag.
    let viewer_meta = if restricted { "\n  <meta name=\"agentlens-viewer\" content=\"restricted\">" } else { "" };
    let build_id_json = Value::from(build_id).to_string();
    let html = substitute_tokens(
        &tmpl,
        &[
            ("@@VIEWER_META@@", viewer_meta),
            ("@@BASE_PATH_JSON@@", "\"\""),
            ("@@BASE_PATH@@", base),
            ("@@SESSION_SUMMARY_JSON@@", &summary_json),
            ("@@BUILD_ID_JSON@@", &build_id_json),
            ("@@SIDEBAR_INIT_JSON@@", &sidebar_json),
        ],
    );
    let mut r = Response::new(boxed_full(Bytes::from(html)));
    let h = r.headers_mut();
    h.insert("Content-Type", hyper::header::HeaderValue::from_static("text/html"));
    // TRDD-1ZH1D5EG (WYC4KB50 #4): the HTML differs by viewer role, so a cache keyed on the URL
    // alone could hand a maestro the restricted page. Vary on the header the verdict derives from.
    h.insert("Vary", hyper::header::HeaderValue::from_static("X-Agentlens-Viewer"));
    // TRDD-FMIZO8Y4: loopback-served apps MAY iframe the dashboard; a remote page framing
    // http://localhost:<UI_PORT> (drive-by clickjack of the local dashboard) is refused.
    h.insert(
        "Content-Security-Policy",
        hyper::header::HeaderValue::from_static(
            "frame-ancestors 'self' http://localhost:* http://127.0.0.1:* https://localhost:* https://127.0.0.1:*",
        ),
    );
    Ok(r)
}

/// The static route (server.ts:4428): a file under `media_dir` with a known extension, or None.
fn static_asset(media_dir: &std::path::Path, path: &str) -> Option<Response<SseBody>> {
    // Node's path.extname: the suffix of the LAST component, and a dotfile (`/.js`) has NO
    // extension — a bare rsplit on the whole path would serve a file literally named `.js`
    // that the TS 404s (review F3).
    let (stem, ext) = path.rsplit('/').next().unwrap_or("").rsplit_once('.')?;
    if stem.is_empty() {
        return None;
    }
    let mime = match ext {
        "css" => "text/css",
        "js" => "application/javascript",
        "png" => "image/png",
        "svg" => "image/svg+xml",
        _ => return None,
    };
    // canonicalize resolves `..` (the TS relies on path.join's normalization) and fails on a
    // missing file (its existsSync). `media_dir` is canonical too (alcore.rs canonicalizes it at
    // boot), so the two sides compare in the same namespace even when /tmp is a symlink.
    let file = std::fs::canonicalize(media_dir.join(path.trim_start_matches('/'))).ok()?;
    // Containment. Path::starts_with is COMPONENT-wise, which is exactly the TS's separator-
    // terminated prefix (server.ts:4431): a sibling `<media_dir>-assets/x.js` shares the string
    // prefix but not the component, so it is rejected here as it is there.
    if !file.starts_with(media_dir) {
        return None;
    }
    let bytes = std::fs::read(&file).ok()?;
    let mut r = Response::new(boxed_full(Bytes::from(bytes)));
    r.headers_mut().insert("Content-Type", hyper::header::HeaderValue::from_static(mime));
    Some(r)
}

fn error_json(msg: &str) -> String {
    let mut m = Map::new();
    m.insert("error".into(), msg.into());
    Value::Object(m).to_string()
}

/// The process-wide admission controller.
///
/// One controller, not one per server: the OTLP, UI and MCP listeners share a machine, so bounding
/// them independently would let three separate pools each admit up to the ceiling and blow through
/// the resource wall the ceiling exists to defend. The TS twin is a single module-level instance
/// for exactly this reason ("one resource monitor + one admission controller shared by BOTH HTTP
/// servers", standalone/server.ts:2744).
pub fn admission_controller() -> &'static crate::admission::Admission {
    static A: std::sync::OnceLock<crate::admission::Admission> = std::sync::OnceLock::new();
    A.get_or_init(|| {
        crate::admission::Admission::new(crate::admission::AdmissionLimits::from_env(
            std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1),
        ))
    })
}

async fn handle(
    req: Request<hyper::body::Incoming>,
    state: Arc<Mutex<CoreState>>,
    hub: Arc<SseHub>,
) -> Result<Response<SseBody>, String> {
    let t0 = std::time::Instant::now();
    let path = req.uri().path().to_owned();
    let origin = req.headers().get("origin").and_then(|v| v.to_str().ok()).map(str::to_owned);
    let host = req.headers().get("host").and_then(|v| v.to_str().ok()).map(str::to_owned);
    let disallowed = is_disallowed_cross_origin(origin.as_deref(), host.as_deref());
    let method = req.method().clone();

    // The signed viewer-role assertion (embedAuth.ts / AgentlensPro#4 §B5). A DUPLICATED header is
    // present-but-unverifiable ⇒ invalid: hyper hands back both values, and picking either one
    // would let a caller append a second header to override the first.
    let viewer_role = {
        let mut vals = req.headers().get_all(crate::embed_auth::VIEWER_HEADER).iter();
        let first = vals.next();
        let duplicated = vals.next().is_some();
        let key = state.lock_timed().embed_key.clone();
        if duplicated {
            crate::embed_auth::ViewerRole::Invalid
        } else {
            crate::embed_auth::resolve_viewer_role(
                first.and_then(|v| v.to_str().ok()),
                key.as_deref(),
                crate::now_ms() as f64,
            )
        }
    };
    // ONE BLANKET METHOD GATE, not per-route checks — ported deliberately from the TS, whose own
    // comment gives the reason: a hidden settings panel is not a restricted one unless its
    // endpoints are dead too, and a per-route allowlist always misses the NEXT route. The single
    // read-side exception is /api/hook-config, which leaks settings (capture paths, gate state).
    // Local consumers (CLI, hooks) send no header at all, so they are `standalone` and unaffected.
    let restricted_block = viewer_role == crate::embed_auth::ViewerRole::Restricted
        && ((method != Method::GET && method != Method::HEAD && method != Method::OPTIONS)
            || path == "/api/hook-config");

    // ADMISSION CONTROL (D3K7QM2P/1c, ported in TRDD-465EXTJ6). Bound in-flight work, queue the
    // overflow briefly, shed at a hard resource wall. Placed HERE — before the summary warm below
    // and before any route body — because the whole point is to not do the work: warming a summary
    // or rebuilding a window for a request that is about to be shed spends exactly the resource the
    // wall is protecting.
    //
    // `_admit` is held for the rest of the function. The slot is returned when it drops, i.e. when
    // the response has been built, which is why there is no explicit release and no way to leak one.
    let _admit = if crate::admission::Admission::is_exempt(method.as_str(), &path) {
        None
    } else {
        // ONE sampler, reused: `resource_sample` is the port of src/resourceMonitor.ts and is
        // already what /api/server-stats reports, so admission decisions and the numbers an
        // operator reads to explain them can never disagree.
        let sample = {
            let data_dir = state.lock_timed().data_dir.clone();
            let v = crate::server_stats::resource_sample(&data_dir);
            crate::admission::ResourceSample {
                rss_mb: v.get("rssMb").and_then(Value::as_f64).unwrap_or(0.0),
                // null ⇒ statvfs failed ⇒ treat as INFINITE free space, matching the TS (which
                // yields Infinity there). Shedding every request because a disk query failed would
                // turn an unreadable stat into a total outage.
                free_disk_mb: v.get("freeDiskMb").and_then(Value::as_f64).unwrap_or(f64::INFINITY),
                load_per_core: v.get("loadPerCore").and_then(Value::as_f64).unwrap_or(0.0),
            }
        };
        match admission_controller().enter(sample).await {
            crate::admission::Admit::Ok(g) => Some(g),
            crate::admission::Admit::Shed(reason) => {
                // 503 + Retry-After, with the reason in the body: "server busy" alone cannot tell a
                // memory wall from a full queue, and that distinction is what an operator acts on.
                let mut resp = json_response(
                    StatusCode::SERVICE_UNAVAILABLE,
                    format!(r#"{{"error":"server busy — backpressure","reason":"{}"}}"#, reason.as_str()),
                );
                resp.headers_mut().insert(
                    "Retry-After",
                    hyper::header::HeaderValue::from_str(&reason.retry_after_sec().to_string())
                        .unwrap_or_else(|_| hyper::header::HeaderValue::from_static("1")),
                );
                return Ok(resp);
            }
        }
    };

    // TRDD-HFV4AIT7 — refresh the memoized summary HERE, off the lock, so the two dozen read
    // routes below find it warm. They now READ it off the lock too (TRDD-QE114936 moved the last
    // of them off `CoreState::build_session_summary`, which rebuilds INLINE under the state lock;
    // at 13.5k cards that is ~1s of `summarize_spans` with every ingest POST queued behind it),
    // so warming here is what keeps that read a pointer clone instead of a stale-budget wait.
    // A PREFIX, not a per-route allowlist, for the reason the method gate above gives: an
    // allowlist always misses the NEXT route. The cost on a route that never reads the summary is
    // one version compare (a hit) or one off-lock rebuild — never a held lock.
    let reads_summary = (method == Method::GET || method == Method::HEAD)
        && (path == "/" || path == "/events" || path.starts_with("/api/"))
        // The card/stats routes read the DuckDB card table directly, so warming the summary for
        // them would spend a whole-corpus rebuild on a request that never reads it.
        && !(path.starts_with("/api/cards/") || path == "/api/stats/overview")
        && viewer_role != crate::embed_auth::ViewerRole::Invalid
        && !restricted_block;
    if reads_summary {
        let _ = summary_now(&state, crate::now_ms() as f64);
    }

    let mut resp = if method != Method::GET && method != Method::HEAD && disallowed {
        json_response(StatusCode::FORBIDDEN, error_json("cross-origin request refused"))
    } else if viewer_role == crate::embed_auth::ViewerRole::Invalid {
        json_response(StatusCode::FORBIDDEN, error_json("unverifiable viewer assertion — rejected (AgentlensPro#4 §B5)"))
    } else if restricted_block {
        json_response(
            StatusCode::FORBIDDEN,
            error_json("restricted viewer — this surface requires a maestro assertion (AgentlensPro#4)"),
        )
    } else if path == "/events" {
        sse_response(&state, &hub, crate::now_ms() as f64)
    } else if method == Method::GET && path == "/api/summary" {
        let (_, summary) = summary_now(&state, crate::now_ms() as f64);
        let body = serde_json::to_string(&StrippedView(&summary)).expect("stripped summary serializes: string keys only");
        json_response(StatusCode::OK, body)
    } else if method == Method::GET && path == "/api/server-stats" {
        let body = {
            let st = state.lock_timed();
            crate::server_stats::server_stats(&st, crate::now_ms()).to_string()
        };
        json_response(StatusCode::OK, body)
    } else if method == Method::GET && path == "/api/embed-status" {
        // The wiring probe (TRDD-1ZH1D5EG, #4 Q9): lets ai-maestro PROVE its proxy stamps
        // assertions and that this gate consumes them, rather than assuming — a proxy that stamps
        // nothing would otherwise pass its own tests while the gate never engages.
        // `keyLoaded` is FALSE only when the key file was unusable at boot, so the embedding side
        // sees WHY a present header 403s instead of guessing. Vary, so a cache cannot serve one
        // viewer role's response to another.
        let key_loaded = state.lock_timed().embed_key.is_some();
        let body = serde_json::json!({
            "mode": if viewer_role == crate::embed_auth::ViewerRole::Standalone { "standalone" } else { "embedded" },
            "role": match viewer_role {
                crate::embed_auth::ViewerRole::Maestro => Value::from("maestro"),
                // The wire word is "user"; the internal verdict is Restricted. Same role.
                crate::embed_auth::ViewerRole::Restricted => Value::from("user"),
                _ => Value::Null,
            },
            "keyLoaded": key_loaded,
        });
        let mut r = json_response(StatusCode::OK, body.to_string());
        r.headers_mut().insert("Vary", hyper::header::HeaderValue::from_static("X-Agentlens-Viewer"));
        r
    } else if method == Method::GET && path == "/api/hook-config" {
        let body = {
            let st = state.lock_timed();
            let mut m = Map::new();
            m.insert("config".into(), st.hook_runtime.to_value());
            m.insert("file".into(), crate::server_stats::hook_config_file(&st.data_dir).to_string_lossy().into_owned().into());
            Value::Object(m).to_string()
        };
        json_response(StatusCode::OK, body)
    } else if method == Method::POST && path == "/api/hook-config" {
        // server.ts keeps chunks only while the total is under 8KB, then parses what it kept — an
        // oversized patch is a parse error (400), never a silent apply of half of it.
        let buf = read_body_keep_under(req.into_body(), 8192).await?;
        let applied: Result<Value, String> = (|| {
            let patch = serde_json::from_slice::<Value>(&buf).map_err(|e| e.to_string())?;
            let patch = patch.as_object().cloned().ok_or_else(|| "patch must be a JSON object".to_owned())?;
            let mut st = state.lock_timed();
            let next = crate::server_stats::save_hook_runtime_config(&st.data_dir, st.hook_runtime, &patch)?;
            st.hook_runtime = next;
            println!(
                "{} alcore: hook config updated: gate={} capture={} advisor={}",
                crate::log_ts(),
                if next.gate_enabled { next.gate_mode } else { "off" },
                next.capture_enabled,
                next.advisor_enabled
            );
            let mut m = Map::new();
            m.insert("config".into(), next.to_value());
            m.insert("applied".into(), Value::Bool(true));
            Ok(Value::Object(m))
        })();
        match applied {
            Ok(v) => json_response(StatusCode::OK, v.to_string()),
            Err(e) => json_response(StatusCode::BAD_REQUEST, error_json(&e)),
        }
    } else if method == Method::POST && path == "/api/clear" {
        // 200 with NO Content-Type and an empty body; the full re-scan runs on the sweeper
        // thread after the clear, so the client sees the cleared state first.
        {
            let mut st = state.lock_timed();
            st.clear_all();
        }
        push_update(&state, &hub, crate::now_ms() as f64);
        Response::new(boxed_full(Bytes::new()))
    } else if method == Method::POST && path == "/action" {
        // readBodyCapped(256KB): overflow destroys the socket (no response); a malformed body is
        // logged and still answered 200; only `{type:"clearAll"}` does anything.
        let Some(buf) = read_body_capped(req.into_body(), 256 * 1024).await? else {
            return Err("/action body over 256KB cap — connection aborted".to_owned());
        };
        match serde_json::from_slice::<Value>(&buf) {
            Ok(v) if v.get("type").and_then(Value::as_str) == Some("clearAll") => {
                {
                    let mut st = state.lock_timed();
                    st.clear_spans();
                }
                push_update(&state, &hub, crate::now_ms() as f64);
            }
            Ok(_) => {}
            Err(e) => eprintln!("{} alcore: malformed /action body: {e}", crate::log_ts()),
        }
        Response::new(boxed_full(Bytes::new()))
    } else if method == Method::POST && path == "/api/statusline-samples" {
        // Row 5 (server.ts:3371): ≤512KB (overflow destroys the socket, no response); the
        // payload must be a JSON OBJECT; `statusline_stream:"subagent"` selects the subagent
        // stream else main; the answer is {ok:true} / 400 {error}.
        let Some(buf) = read_body_capped(req.into_body(), crate::hook_events::HOOK_EVENT_MAX_BYTES).await? else {
            return Err("/api/statusline-samples body over 512KB cap — connection aborted".to_owned());
        };
        match serde_json::from_slice::<Value>(&buf) {
            // The TS 400 text is V8's parse message; serde's here — shape is the contract.
            Err(e) => json_response(StatusCode::BAD_REQUEST, error_json(&e.to_string())),
            Ok(v) => match v.as_object() {
                None => json_response(StatusCode::BAD_REQUEST, error_json("payload must be a JSON object")),
                Some(payload) => {
                    let stream = if v.get("statusline_stream").and_then(Value::as_str) == Some("subagent") { "subagent" } else { "main" };
                    {
                        let mut st = state.lock_timed();
                        let now = crate::now_ms();
                        st.statusline.append(payload, stream, now as f64);
                        st.persist.statusline_samples += 1;
                        // SPOOL TAP: here, with the nested `payload` map still whole — the store's
                        // append above flattens it, and the digest schemas are nested. The tap drops
                        // the two keys the CLI adds (`hook_event_name`, `statusline_stream`).
                        if let Some(tap) = &st.spool_tap {
                            tap.statusline(payload, stream);
                        }
                        // A statusline sample IS capture activity (TRDD-8ADTIGKT, TRDD-465EXTJ6).
                        // Without this bump a statusline-only machine could never trip CAPTURE
                        // DOWN — a silent blind spot rather than a false alarm, which is the
                        // harder kind to notice: the feed looks connected and produces nothing.
                        st.last_ingest_activity_ms = now;
                    }
                    json_response(StatusCode::OK, r#"{"ok":true}"#.to_owned())
                }
            },
        }
    } else if method == Method::POST && path == "/api/hook-events" {
        // ≤512KB: overflow destroys the socket (no response); a malformed body is a 400; the
        // rest is ingestHookEvent's frozen taxonomy (hook_events::ingest_hook_event).
        let Some(buf) = read_body_capped(req.into_body(), crate::hook_events::HOOK_EVENT_MAX_BYTES).await? else {
            return Err("/api/hook-events body over 512KB cap — connection aborted".to_owned());
        };
        match serde_json::from_slice::<Value>(&buf) {
            Err(e) => json_response(StatusCode::BAD_REQUEST, error_json(&e.to_string())),
            Ok(payload) => {
                let (status, body, _proof) = {
                    let mut st = state.lock_timed();
                    // `buf` is the exact POST body: the spool tap writes these bytes, not a re-serialised Value.
                    crate::hook_events::ingest_hook_event(&mut st, &payload, &buf, crate::now_ms())
                };
                json_response(StatusCode::from_u16(status).unwrap_or(StatusCode::OK), body.to_string())
            }
        }
    } else if method == Method::GET && path == "/api/hook-events" {
        let q = query_of(&req);
        let num = |k: &str| q.get(k).filter(|v| !v.is_empty()).and_then(|v| v.parse::<i64>().ok());
        let events = {
            let st = state.lock_timed();
            crate::hook_events::read_hook_events(
                &st.data_dir.join("hook-events"),
                &crate::hook_events::HookEventFilter {
                    session: q.get("session").map(String::as_str),
                    ev: q.get("ev").map(String::as_str),
                    since_ms: num("since"),
                    until_ms: num("until"),
                    limit: num("limit"),
                },
            )
        };
        json_response(StatusCode::OK, serde_json::json!({ "count": events.len(), "events": events }).to_string())
    } else if method == Method::GET && path == "/api/lifecycle-events" {
        let q = query_of(&req);
        let limit = q.get("limit").and_then(|v| v.parse::<i64>().ok()).filter(|n| *n > 0).unwrap_or(200) as usize;
        let kinds: Option<Vec<String>> = q.get("kinds").map(|v| v.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect());
        let session = q.get("session").map(String::as_str);
        let (dir, records) = {
            let st = state.lock_timed();
            let dir = st.data_dir.join("hook-events");
            let records = crate::hook_events::read_hook_events(&dir, &crate::hook_events::HookEventFilter { session, limit: Some(1000), ..Default::default() });
            (dir, records)
        };
        let events = crate::hook_events::extract_lifecycle_events(&records, kinds.as_deref(), session, limit);
        let body = serde_json::json!({
            "hookEventsDir": dir.to_string_lossy(),
            "dirExists": std::fs::metadata(&dir).is_ok(),
            "count": events.len(),
            "events": events,
        });
        json_response(StatusCode::OK, body.to_string())
    } else if method == Method::POST && path == "/api/import" {
        // readBodyCapped(64MB): overflow destroys the socket. Any parse failure is the TS
        // `String(e)` 400 (the message text is serde's, not V8's — the status and shape are the
        // contract); a body without a `sessions` array is its own 400.
        let Some(buf) = read_body_capped(req.into_body(), 64 * 1024 * 1024).await? else {
            return Err("/api/import body over 64MB cap — connection aborted".to_owned());
        };
        match serde_json::from_slice::<Value>(&buf) {
            Err(e) => json_response(StatusCode::BAD_REQUEST, error_json(&format!("SyntaxError: {e}"))),
            Ok(body) => match body.get("sessions").and_then(Value::as_array) {
                None => json_response(StatusCode::BAD_REQUEST, error_json("sessions array required")),
                Some(sessions) => {
                    let (imported, skipped) = {
                        let mut st = state.lock_timed();
                        crate::import_card::import_sessions(&mut st, sessions, crate::now_ms())
                    };
                    push_update(&state, &hub, crate::now_ms() as f64);
                    let out = serde_json::json!({ "imported": imported, "skipped": skipped, "failed": 0, "total": sessions.len() });
                    json_response(StatusCode::OK, out.to_string())
                }
            },
        }
    } else if method == Method::POST && path == "/api/write-prompts-file" {
        // Row 17 (server.ts:3766): append the prompt to `agentlens-prompts-<slug>.md` in the
        // server's cwd; errors are logged and the answer is ALWAYS 200 empty (fire-and-forget).
        let Some(buf) = read_body_capped(req.into_body(), 4 * 1024 * 1024).await? else {
            return Err("/api/write-prompts-file body over 4MB cap — connection aborted".to_owned());
        };
        let write = || -> Result<std::path::PathBuf, String> {
            let v = serde_json::from_slice::<Value>(&buf).map_err(|e| e.to_string())?;
            let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
            let (agent, label, prompt) = (s("agent"), s("label"), s("prompt"));
            let (slug, name) = match agent.as_str() {
                "claude_code" => ("claude", "Claude"),
                "codex" => ("codex", "Codex"),
                _ => ("copilot", "Copilot"),
            };
            let file = std::env::current_dir().map_err(|e| e.to_string())?.join(format!("agentlens-prompts-{slug}.md"));
            // new Date().toISOString().replace('T', ' ').slice(0, 19)
            let ts = crate::summarize::helpers::iso_from_ms(crate::now_ms() as f64).replace('T', " ")[..19].to_owned();
            let entry = format!("## {ts} — {label}\n\n{prompt}\n\n---\n\n");
            let content = match std::fs::read_to_string(&file) {
                Ok(existing) => existing + &entry,
                Err(_) => format!("# AgentLens Prompts — {name}\n\n{entry}"),
            };
            std::fs::write(&file, content).map_err(|e| e.to_string())?;
            Ok(file)
        };
        match write() {
            Ok(file) => println!("{} alcore: prompt written to {}", crate::log_ts(), file.display()),
            Err(e) => eprintln!("{} alcore: write-prompts-file error: {e}", crate::log_ts()),
        }
        Response::new(boxed_full(Bytes::new()))
    } else if method == Method::POST && path == "/api/branch-dump" {
        // Row 18 (server.ts:3800, TRDD-4CH9QLAH): write over-threshold branch node outputs under
        // the Claude projects tree. The slug must be separator-free AND name an EXISTING project
        // dir — never mkdir an arbitrary tree for an attacker-chosen name; each file's sanitized
        // single-segment name is asserted to resolve DIRECTLY under the dump root before writing.
        let Some(buf) = read_body_capped(req.into_body(), 48 * 1024 * 1024).await? else {
            return Err("/api/branch-dump body over 48MB cap — connection aborted".to_owned());
        };
        let run = || -> Result<Response<SseBody>, String> {
            let v = serde_json::from_slice::<Value>(&buf).map_err(|e| e.to_string())?;
            let slug = v.get("slug").and_then(Value::as_str).unwrap_or("");
            let session_id = v.get("sessionId").and_then(Value::as_str).unwrap_or("");
            let empty = Vec::new();
            let dumps = v.get("dumps").and_then(Value::as_array).unwrap_or(&empty);
            let slug_ok = !slug.is_empty() && slug.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-')) && !slug.contains("..");
            if !slug_ok {
                return Ok(json_response(StatusCode::BAD_REQUEST, error_json("invalid project slug")));
            }
            let env = agentlens_logscan::discovery::Env::from_process();
            let proj_root = agentlens_logscan::discovery::claude_projects_dirs(&env)
                .into_iter()
                .map(|r| r.join(slug))
                .find(|p| std::fs::metadata(p).is_ok_and(|m| m.is_dir()));
            let Some(proj_root) = proj_root else {
                return Ok(json_response(StatusCode::BAD_REQUEST, error_json("unknown project slug (no matching Claude project dir)")));
            };
            let dump_root = proj_root.join("agentlens-branch-dumps");
            std::fs::create_dir_all(&dump_root).map_err(|e| e.to_string())?;
            let dump_root_resolved = std::fs::canonicalize(&dump_root).map_err(|e| e.to_string())?;
            let ts: String = crate::summarize::helpers::iso_from_ms(crate::now_ms() as f64)
                .chars()
                .map(|c| if c == ':' || c == '.' { '-' } else { c })
                .collect();
            let safe = |s: &str| -> String {
                // s.replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 60) || 'x'
                let mut out = String::new();
                let mut in_run = false;
                for c in s.chars() {
                    if c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') {
                        out.push(c);
                        in_run = false;
                    } else if !in_run {
                        out.push('-');
                        in_run = true;
                    }
                }
                let out: String = out.chars().take(60).collect();
                if out.is_empty() { "x".to_owned() } else { out }
            };
            let mut paths = Map::new();
            for d in dumps.iter().filter_map(Value::as_object) {
                let id = d.get("id").and_then(Value::as_str).unwrap_or("");
                if id.is_empty() || !id.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-')) {
                    continue; // a malformed placeholder id cannot round-trip into text — skip
                }
                let name = d.get("name").and_then(Value::as_str).unwrap_or("output");
                let file_name = format!("{}-{ts}-{}-{}.txt", safe(session_id), safe(name), safe(id));
                let target = dump_root.join(&file_name);
                if target.parent().and_then(|p| std::fs::canonicalize(p).ok()).as_deref() != Some(&dump_root_resolved) {
                    continue;
                }
                let content = d.get("content").and_then(Value::as_str).unwrap_or("");
                std::fs::write(&target, content).map_err(|e| e.to_string())?;
                paths.insert(id.to_owned(), Value::from(target.to_string_lossy().into_owned()));
            }
            println!("{} alcore: branch-dump: {} file(s) → {}", crate::log_ts(), paths.len(), dump_root.display());
            let body = serde_json::json!({ "dir": dump_root.to_string_lossy(), "paths": paths });
            Ok(json_response(StatusCode::OK, body.to_string()))
        };
        match run() {
            Ok(resp) => resp,
            // The TS wraps the whole handler in one try → 500 {error} (a parse error included).
            Err(e) => json_response(StatusCode::INTERNAL_SERVER_ERROR, error_json(&e)),
        }
    } else if method == Method::GET && path == "/api/debug/codex-store-groups" {
        // server.ts:4000 — the DISTINCT sorted traceIds of the window's codex.* spans: the ONLY
        // place the STORE-level Codex grouping is directly observable (the summarizer re-groups
        // downstream, so /api/summary would mask a per-prompt vs per-conversation regression).
        let body = {
            let st = state.lock_timed();
            let mut ids: Vec<&str> = st
                .window
                .spans
                .iter()
                .filter_map(|s| s.as_object())
                .filter(|s| s.get("name").and_then(Value::as_str).is_some_and(|n| n.starts_with("codex.")))
                .filter_map(|s| s.get("traceId").and_then(Value::as_str))
                .collect();
            ids.sort_unstable();
            ids.dedup();
            serde_json::json!({ "codexTraceIds": ids }).to_string()
        };
        json_response(StatusCode::OK, body)
    } else if method == Method::GET && path == "/api/debug/span-attr" {
        // server.ts:4012 (S3-F3b) — read one attribute off ONE stored span through a FRESH read,
        // the only place the store's gen_ai read-time overlay is directly observable. Windowed to
        // 24h unless fromMs widens it (an unbounded read once streamed the whole multi-GB store).
        let q = query_of(&req);
        let trace_id = q.get("traceId").cloned().unwrap_or_default();
        let span_id = q.get("spanId").cloned().unwrap_or_default();
        let key = q.get("key").filter(|k| !k.is_empty()).cloned().unwrap_or_else(|| "gen_ai.output.messages".to_owned());
        let now = crate::now_ms();
        let from_ms = q.get("fromMs").and_then(|v| v.parse::<i64>().ok()).filter(|v| *v > 0).unwrap_or(now - 24 * 3_600_000);
        let body = {
            let mut st = state.lock_timed();
            let span = st
                .writer
                .load_range(from_ms, i64::MAX, now)
                .into_iter()
                .find(|s| s.get("traceId").and_then(Value::as_str) == Some(&trace_id) && s.get("spanId").and_then(Value::as_str) == Some(&span_id));
            let value = span.as_ref().and_then(|s| {
                s.get("attributes")?
                    .as_array()?
                    .iter()
                    .find(|a| a.get("key").and_then(Value::as_str) == Some(&key))?
                    .get("value")?
                    .get("stringValue")
                    .cloned()
            });
            serde_json::json!({ "found": span.is_some(), "value": value.unwrap_or(Value::Null) }).to_string()
        };
        json_response(StatusCode::OK, body)
    } else if method == Method::GET && path == "/api/ingest-status" {
        // The digest spool tap's counters (spool_tap.rs). Inside the same chain as every
        // neighbouring /api route, so it passes the same viewer-role, cross-origin and admission
        // gates above; it carries counts and names only, no paths.
        let body = {
            let st = state.lock_timed();
            crate::spool_tap::status(&st).to_string()
        };
        json_response(StatusCode::OK, body)
    } else if method == Method::GET && path == "/api/debug/capture-activity" {
        // Ported from standalone/server.ts:3622 (TRDD-1B98LCVR). This endpoint existed ONLY in the
        // TypeScript server, so retiring that server without porting it would have deleted a live
        // endpoint and broken its two tests — the one real blocker the retire-the-TS-backend
        // scoping pass turned up.
        //
        // Shape is byte-for-byte the TS one: `{"lastIngestActivityAt": <ms>}`, a bare number, `0`
        // when nothing has ever been ingested. Do NOT "improve" it into an object or add an
        // `active` boolean — the consumers are tests that assert the raw bump, and the window
        // comparison belongs to the caller (server.ts kept CAPTURE_ACTIVITY_WINDOW_MS on its side).
        let body = {
            let st = state.lock_timed();
            serde_json::json!({ "lastIngestActivityAt": st.last_ingest_activity_ms }).to_string()
        };
        json_response(StatusCode::OK, body)
    } else if method == Method::GET && path == "/api/debug/requests" {
        // Row 26: the recent-request ring + heap pressure. No V8 ⇒ the heap object is honest
        // zeros (over: false), as /api/server-stats reports; rssMb per row carries the story.
        let body = {
            let st = state.lock_timed();
            serde_json::json!({
                "heap": { "heapUsedMb": 0, "limitMb": 0, "hwmMb": 0, "over": false },
                "requests": st.requests.recent(200),
            })
            .to_string()
        };
        json_response(StatusCode::OK, body)
    } else if method == Method::GET && path == "/api/debug/log-scan-stats" {
        let body = {
            let st = state.lock_timed();
            let s = st.log_scan;
            let (sh, sm) = st.summary_cache.stats();
            let (readdirs, lhits, cached) = crate::generated_files::scratch_listing_stats();
            // NOT PORTED: the sidebar/analytics caches (those views are built inside the update
            // payload here, not as separate routes) — idle zeros.
            serde_json::json!({
                "incrementalReads": s.incremental_reads,
                "fullReads": s.full_reads,
                "filesStatted": s.files_statted,
                "dataVersion": st.data_version,
                // Summary rebuilds that deep-copied the sessions array because a reader still held
                // the previous summary — each one is a full-corpus copy (see `summary_engine`).
                "summaryEngine": { "sharedCopies": crate::summary_engine::shared_copies() },
                "derivedCaches": {
                    "summary": { "hits": sh, "misses": sm },
                    "sidebar": { "hits": 0, "misses": 0 },
                    "analytics": { "hits": 0, "misses": 0 },
                },
                "scratchListing": { "readdirs": readdirs, "hits": lhits, "cached": cached },
            })
            .to_string()
        };
        json_response(StatusCode::OK, body)
    } else if method == Method::GET && path == "/api/burn-status" {
        // Row 24 (server.ts:3950): enrichBurnStatus(computeBurnStatus(gatherBurn())) — 200
        // always. The TS catch answers {"error":…} at 200 for a V8 throw; the Rust compute
        // cannot throw, so only the success shape is reachable.
        let now = crate::now_ms() as f64;
        // TRDD-XX1UAZHS: the status is computed OFF the lock; the guard below only reads the
        // account and the resident blobs.
        let status = burn_status_now(&state, now);
        let body = {
            let mut st = state.lock_timed();
            let account = st.burn.current_account(now);
            crate::burn::runtime::enrich_burn_status(&status, &account, &st.latest_resident_blobs).to_string()
        };
        json_response(StatusCode::OK, body)
    } else if method == Method::GET && path == "/api/burn-risk" {
        // Row 12 (server.ts:3519): checkBurnRisk over the three feeds + the verbatim spawning
        // calls behind an active fan-out. The TS 500-on-throw path is unreachable here (the
        // Rust compute cannot throw); every feed absence is reported in `sources`, not as an error.
        let now = crate::now_ms() as f64;
        let body = {
            // TRDD-QE114936 site 20: computed OFF the lock, and only when the 4 s tick has not
            // stored a status yet — `burn_risk_report` used to fill it in by rebuilding the whole
            // summary under this guard.
            let seed = burn_status_seed(&state, now);
            let mut st = state.lock_timed();
            st.burn_risk_report(now, seed, None, None).to_string()
        };
        json_response(StatusCode::OK, body)
    } else if method == Method::POST && path == "/api/agent-gate" {
        // Row 13 (server.ts:3553, TRDD-GOD0108C) — THE CONTRACT IS FAIL-OPEN: allow → 204 empty;
        // PostToolUse advisory / deny / warn → the three 200 hookSpecificOutput shapes; EVERY
        // error path → 204, because a gate that can error a launch is worse than no gate. The
        // 1MB overflow destroys the socket (the TS req.destroy() — no response at all).
        let Some(buf) = read_body_capped(req.into_body(), crate::burn::agent_gate::GATE_BODY_MAX).await? else {
            return Err("/api/agent-gate body over 1MB cap — connection aborted".to_owned());
        };
        let no_content = || {
            let mut r = Response::new(boxed_full(Bytes::new()));
            *r.status_mut() = StatusCode::NO_CONTENT;
            r
        };
        // The SSE alert mirror (pushBurnSse) is computed under the lock, broadcast after it.
        let mut alert: Option<String> = None;
        let resp = (|| {
            use crate::burn::agent_gate;
            let Ok(p) = serde_json::from_slice::<Value>(&buf) else { return no_content() }; // the TS catch → 204
            let now = crate::now_ms() as f64;
            let session_id = p.get("session_id").and_then(Value::as_str).unwrap_or("unknown");
            let transcript_path = p.get("transcript_path").and_then(Value::as_str);
            let cwd = p.get("cwd").and_then(Value::as_str);
            // Real parent context (tokens from the transcript's last usage) + cache warmth (mtime).
            let parent = match transcript_path {
                Some(tp) => agent_gate::read_transcript_context(std::path::Path::new(tp), now, agent_gate::TRANSCRIPT_TAIL_BYTES),
                None => serde_json::json!({ "contextTokens": null, "idleMs": null }),
            };
            let mut st = state.lock_timed();
            let mut gate_state = agent_gate::build_gate_state(&mut st, now, parent, session_id, transcript_path, cwd);
            st.persist.gate_checks += 1;

            if p.get("hook_event_name").and_then(Value::as_str) == Some("PostToolUse") {
                if !st.hook_runtime.advisor_enabled {
                    return no_content();
                }
                // In-band advisory to the MODEL after an agent wave — deduped per session+risk.
                let adv = agent_gate::build_advisory(&gate_state);
                if let Some(advo) = adv.as_object() {
                    let code = advo.get("code").and_then(Value::as_str).unwrap_or("");
                    let text = advo.get("text").cloned().unwrap_or(Value::Null);
                    let key = format!("{session_id}:{code}");
                    let last = st.advisory_issued.get(&key).copied().unwrap_or(0.0);
                    if now - last > agent_gate::ADVISORY_DEDUPE_MS {
                        st.advisory_issued.insert(key, now);
                        agent_gate::prune_advisory_issued(&mut st.advisory_issued, now);
                        st.persist.gate_advisories += 1;
                        alert = Some(
                            serde_json::json!({ "type": "alert", "label": format!("burn advisory ({code})"), "detail": text, "severity": "warning" })
                                .to_string(),
                        );
                        return json_response(
                            StatusCode::OK,
                            serde_json::json!({ "hookSpecificOutput": { "hookEventName": "PostToolUse", "additionalContext": text } }).to_string(),
                        );
                    }
                }
                return no_content();
            }

            // PreToolUse (default): decide before the launch happens. SendMessage takes the
            // NARROWER evaluator, and its deny further requires the TARGET to resolve dead.
            if !st.hook_runtime.gate_enabled {
                return no_content();
            }
            let tool_name = p.get("tool_name").and_then(Value::as_str);
            let d = if tool_name == Some("Read") {
                // Read is matched ONLY for the image cache-guard, which has its own runtime
                // switch: it rides a hot path, so "the image warning annoys me" must never cost
                // the user the agent-launch disaster gate. Warn-only by construction.
                if !st.hook_runtime.cache_guard_enabled {
                    return no_content();
                }
                agent_gate::evaluate_image_read_gate(p.get("tool_input"), &gate_state)
            } else if tool_name == Some("SendMessage") {
                let to = p.get("tool_input").and_then(|t| t.get("to"));
                let target = to.and_then(Value::as_str).map(str::to_owned);
                let liveness = agent_gate::resolve_message_target_liveness(to, &st.recent_hook_events);
                if let Some(obj) = gate_state.as_object_mut() {
                    obj.insert("messageTarget".into(), target.map_or(Value::Null, Value::from));
                    obj.insert("targetLiveness".into(), Value::from(liveness));
                }
                agent_gate::evaluate_send_message_gate(&gate_state)
            } else {
                agent_gate::evaluate_agent_gate(p.get("tool_input"), &gate_state)
            };
            let decision = d.get("decision").and_then(Value::as_str).unwrap_or("");
            let code = d.get("code").and_then(Value::as_str).unwrap_or("").to_owned();
            // `detail: d.reason ?? ''` on the SSE mirror; the response bodies carry d.reason raw.
            let reason_str = d.get("reason").and_then(Value::as_str).unwrap_or("").to_owned();
            if decision == "deny" {
                st.persist.gate_denies += 1;
                // Mirror onto the dashboard's SSE alert channel — same surface as the burn alerts.
                alert = Some(
                    serde_json::json!({ "type": "alert", "label": format!("burn-gate DENY ({code})"), "detail": reason_str, "severity": "error" })
                        .to_string(),
                );
                return json_response(
                    StatusCode::OK,
                    serde_json::json!({
                        "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": d.get("reason").cloned().unwrap_or(Value::Null) },
                        "systemMessage": format!("[agentlens burn-gate] blocked an agent launch ({code}). The reason went to the agent so it can adapt; disable/downgrade in realtime: agentlenspro-cli --hooks gate=off|warn."),
                    })
                    .to_string(),
                );
            }
            if decision == "warn" {
                // IMG_RESIDENT rides `Read`, so unlike every other rule it can fire many times
                // in one turn — and its own advice is "read every image in ONE message", which
                // would then earn one ~700-char systemMessage per image. Dedupe it per session
                // on the advisory cadence; the rare agent-launch rules keep warning every time.
                if code == "IMG_RESIDENT" {
                    let key = format!("{session_id}:{code}");
                    if now - st.advisory_issued.get(&key).copied().unwrap_or(0.0) <= agent_gate::ADVISORY_DEDUPE_MS {
                        return no_content();
                    }
                    st.advisory_issued.insert(key, now);
                    agent_gate::prune_advisory_issued(&mut st.advisory_issued, now);
                }
                st.persist.gate_warns += 1;
                alert = Some(
                    serde_json::json!({ "type": "alert", "label": format!("burn-gate warning ({code})"), "detail": reason_str, "severity": "warning" })
                        .to_string(),
                );
                return json_response(
                    StatusCode::OK,
                    serde_json::json!({ "systemMessage": d.get("reason").cloned().unwrap_or(Value::Null) }).to_string(),
                );
            }
            no_content()
        })();
        // pushBurnSse: no clients ⇒ no frame (the TS early return).
        if let Some(a) = alert {
            if hub.client_count() > 0 {
                hub.broadcast(sse_frame(&a));
            }
        }
        resp
    } else if method == Method::GET && path == "/api/cache-risk-commands" {
        // Row 9 (server.ts:3465): the transcript scan for prefix-mutating slash commands.
        let q = query_of(&req);
        let window_hours = q
            .get("window")
            .and_then(|v| v.parse::<f64>().ok())
            .filter(|v| v.is_finite() && *v > 0.0)
            .unwrap_or(24.0 * 7.0);
        let limit = q.get("limit").and_then(|v| v.parse::<f64>().ok()).filter(|v| v.is_finite() && *v > 0.0).map(|v| v as usize).unwrap_or(300);
        let kinds: Option<Vec<String>> = q
            .get("kinds")
            .map(|v| v.split(',').map(str::trim).filter(|s| !s.is_empty()).map(str::to_owned).collect::<Vec<_>>())
            .filter(|v: &Vec<String>| !v.is_empty());
        let body = {
            let st = state.lock_timed();
            let dirs = agentlens_logscan::discovery::claude_projects_dirs(&st.log_env);
            crate::cache_risk_commands::cache_risk_commands_response(&dirs, crate::now_ms() as f64, window_hours, kinds.as_deref(), limit)
                .to_string()
        };
        json_response(StatusCode::OK, body)
    } else if method == Method::GET && path == "/api/generated-file" {
        // Row 31 (server.ts:4064): the on-demand scratch-file leaf — always 200, the
        // readScratchFile shapes carry existence/containment honestly.
        let q = query_of(&req);
        let file_path = q.get("path").map(String::as_str).unwrap_or("");
        json_response(StatusCode::OK, crate::generated_files::read_scratch_file(file_path, 200 * 1024).to_string())
    } else if method == Method::GET && path.starts_with("/api/instruction-suggestions") {
        // Row 19 (server.ts:3852; PREFIX match, as the TS url.startsWith does). The advisor is
        // pure analysis over the workspace's sessions; the response is a BARE array.
        let q = query_of(&req);
        match q.get("workspace").map(|w| w.trim()).filter(|w| !w.is_empty()) {
            None => json_response(StatusCode::BAD_REQUEST, error_json("workspace query param is required")),
            Some(ws) => {
                // TRDD-QE114936: the summary is read OFF the state lock. Building it under the
                // guard is an O(window) rebuild that measured 12–64 s holds on the live server,
                // during which every ingest and read path queues behind it. Nothing else in this
                // route needs `CoreState`, so the guard disappears entirely.
                let (_, summary) = summary_now(&state, crate::now_ms() as f64);
                let body = {
                    // `(s.workspace ?? '') === workspace || s.workspace?.startsWith(workspace)`
                    let sessions: Vec<Value> = summary
                        .get("sessions")
                        .and_then(Value::as_array)
                        .map(Vec::as_slice)
                        .unwrap_or(&[])
                        .iter()
                        .filter(|s| {
                            let w = s.get("workspace").and_then(Value::as_str);
                            w.unwrap_or("") == ws || w.is_some_and(|w| w.starts_with(ws))
                        })
                        .cloned()
                        .collect();
                    let existing = crate::instruction_files::read_all_instruction_content(ws);
                    Value::Array(crate::instruction_advisor::generate_suggestions(&sessions, &existing)).to_string()
                };
                json_response(StatusCode::OK, body)
            }
        }
    } else if method == Method::GET && path.starts_with("/api/instruction-files") {
        // Row 20 — pure fs probing, bare array, same 400.
        let q = query_of(&req);
        match q.get("workspace").map(|w| w.trim()).filter(|w| !w.is_empty()) {
            None => json_response(StatusCode::BAD_REQUEST, error_json("workspace query param is required")),
            Some(ws) => json_response(StatusCode::OK, Value::Array(crate::instruction_files::detect_instruction_files(ws)).to_string()),
        }
    } else if method == Method::POST && path == "/api/instructions/apply" {
        // Row 21 (server.ts:3885): ≤4MB; targetFile becomes a filesystem APPEND path, so it is
        // restricted to the exact instruction files the advisor offers (without this a request
        // could append to ~/.zshrc → code execution), plus the resolved-path escape guard.
        let Some(buf) = read_body_capped(req.into_body(), 4 * 1024 * 1024).await? else {
            return Err("/api/instructions/apply body over 4MB cap — connection aborted".to_owned());
        };
        (|| {
            let parsed: Value = match serde_json::from_slice(&buf) {
                Ok(v) => v,
                // The TS catch answers 500 {error: String(e)} — shape is the contract, text is serde's.
                Err(e) => return json_response(StatusCode::INTERNAL_SERVER_ERROR, error_json(&format!("SyntaxError: {e}"))),
            };
            let field = |k: &str| parsed.get(k).and_then(Value::as_str).filter(|v| !v.is_empty());
            let (Some(workspace), Some(target), Some(text), Some(id)) =
                (field("workspace"), field("targetFile"), field("appliedText"), field("id"))
            else {
                return json_response(StatusCode::BAD_REQUEST, error_json("workspace, targetFile, appliedText, and id are required"));
            };
            const ALLOWED: [&str; 4] = ["CLAUDE.md", ".claude/CLAUDE.md", ".github/copilot-instructions.md", "AGENTS.md"];
            if !ALLOWED.contains(&target) {
                return json_response(StatusCode::BAD_REQUEST, error_json("targetFile must be a recognized instruction file"));
            }
            let abs = std::path::Path::new(workspace).join(target);
            // Belt-and-suspenders behind the allowlist: reject anything still resolving outside
            // the workspace (e.g. a workspace that is itself a traversal string).
            let resolved = crate::instruction_files::resolve_lexical(&abs.to_string_lossy());
            let ws_prefix = format!("{}{}", crate::instruction_files::resolve_lexical(workspace).display(), std::path::MAIN_SEPARATOR);
            if !resolved.to_string_lossy().starts_with(&ws_prefix) {
                return json_response(StatusCode::BAD_REQUEST, error_json("resolved path escapes the workspace"));
            }
            match crate::instruction_files::append_suggestion(&abs, text, id) {
                Ok(()) => json_response(StatusCode::OK, r#"{"ok":true}"#.to_owned()),
                Err(e) => json_response(StatusCode::INTERNAL_SERVER_ERROR, error_json(&e.to_string())),
            }
        })()
    } else if method == Method::POST && path == "/api/bodies/export" {
        // Row 14 (server.ts:3664): 1MB cap (overflow destroys the socket). The WAD reader + the
        // store half run on the blocking pool and NOT under the state lock — an export walks
        // gigabytes and every other route must stay responsive meanwhile (the store is its own
        // read-only DuckDB open over immutable parquet, safe beside the alstore pass).
        let Some(buf) = read_body_capped(req.into_body(), 1024 * 1024).await? else {
            return Err("/api/bodies/export body over 1MB cap — connection aborted".to_owned());
        };
        let data_dir = { state.lock_timed().data_dir.clone() };
        let (status, body) = tokio::task::spawn_blocking(move || crate::body_archive::bodies_export(&data_dir, &buf))
            .await
            .map_err(|e| e.to_string())?;
        json_response(StatusCode::from_u16(status).unwrap_or(StatusCode::OK), body.to_string())
    } else if method == Method::POST && path == "/api/bodies/purge" {
        // Row 15 (server.ts:3711): the request body is never read (the TS handler does not
        // consume it either); destruction is per-volume verify-before-delete (TRDD-K3WDPR7M).
        let data_dir = { state.lock_timed().data_dir.clone() };
        let (status, body) = tokio::task::spawn_blocking(move || crate::body_archive::bodies_purge(&data_dir))
            .await
            .map_err(|e| e.to_string())?;
        json_response(StatusCode::from_u16(status).unwrap_or(StatusCode::OK), body.to_string())
    } else if method == Method::GET && path == "/api/collector-gaps" {
        // Row 29 (server.ts:4038, TRDD-PJC8N1HO spec 2): the lifecycle-derived downtime windows.
        // The TS wraps computeCollectorGaps in a catch → []; the Rust compute cannot throw.
        let body = {
            let st = state.lock_timed();
            serde_json::json!({ "collectorGaps": crate::collector_lifecycle::compute_gaps(&st.lifecycle, crate::collector_lifecycle::MIN_GAP_MS) })
                .to_string()
        };
        json_response(StatusCode::OK, body)
    } else if method == Method::GET && (path.starts_with("/api/cards/") || path == "/api/stats/overview") {
        // TRDD-9VX3WTGU Phase C — DuckDB-paginated card reads + key-column stats. Blocking DuckDB
        // work, so spawn_blocking like the composition/history routes below; see `cards_route`.
        let q = query_of(&req);
        let (state, route) = (state.clone(), path.clone());
        let (status, body) = tokio::task::spawn_blocking(move || cards_route(&state, &route, &q))
            .await
            .map_err(|e| format!("cards route join failed: {e}"))?;
        json_response(status, body)
    } else if method == Method::GET && path.starts_with("/api/composition/") {
        // Row 32 (server.ts:4208). Reconstructs the per-turn composition by STREAMING the session's
        // raw .jsonl — multi-GB files are routine, so this runs on spawn_blocking and the Env is
        // cloned out from under the lock rather than held across the parse.
        //
        // Always 200: `{composition: null}` is a legitimate answer for a pure OTEL/synth card with
        // no transcript and no known parent. `?parent=` supplies the fork's parent so a sub-agent
        // session (which has no log of its own) reconstructs from the parent's transcript.
        let session_id = percent_decode(&path["/api/composition/".len()..]);
        let parent = query_of(&req).get("parent").map(|s| s.to_owned()).filter(|s| !s.is_empty());
        let env = {
            let st = state.lock_timed();
            st.log_env.clone()
        };
        let composition = tokio::task::spawn_blocking(move || {
            crate::context_composition::build_context_composition(&env, &session_id, parent.as_deref())
        })
        .await
        .map_err(|e| format!("composition build join failed: {e}"))?;
        json_response(
            StatusCode::OK,
            serde_json::json!({ "composition": composition.unwrap_or(Value::Null) }).to_string(),
        )
    } else if method == Method::GET && path.starts_with("/api/history/") {
        // Row 33 (server.ts:4244). Same shape and same streaming discipline as row 32: the raw
        // .jsonl is streamed on spawn_blocking with the Env cloned out from under the lock, and
        // `{history: null}` stays a legitimate 200 for a card with no transcript and no parent.
        let session_id = percent_decode(&path["/api/history/".len()..]);
        let parent = query_of(&req).get("parent").map(|s| s.to_owned()).filter(|s| !s.is_empty());
        let env = {
            let st = state.lock_timed();
            st.log_env.clone()
        };
        let history = tokio::task::spawn_blocking(move || {
            crate::context_history::build_context_history(&env, &session_id, parent.as_deref())
        })
        .await
        .map_err(|e| format!("history build join failed: {e}"))?;
        json_response(StatusCode::OK, serde_json::json!({ "history": history.unwrap_or(Value::Null) }).to_string())
    } else if method == Method::GET && path == "/mcp" {
        // mcpServer.ts handleMcpRequest's GET branch — a plain health check so opening the MCP
        // URL in a browser (or this test's ACAO probe) gets a clear 200 instead of the generic
        // 404 every other unmatched route returns. `disallowed`/CORS are already computed above
        // and applied in the shared postamble below, so this arm needs no CORS logic of its own.
        json_response(
            StatusCode::OK,
            serde_json::json!({
                "status": "ok",
                "server": "agentlens-mcp",
                "transport": "streamable-http",
                "endpoint": req.uri().to_string(),
            })
            .to_string(),
        )
    } else if method == Method::POST && path == "/mcp" {
        // P4x — the MCP JSON-RPC endpoint. Served on THIS listener for now; the dedicated
        // :4316 listener the CLI defaults to is a separate wiring step (point it here meanwhile
        // with AGENTLENS_MCP_URL). See mcp.rs for why plain JSON is sufficient for our CLI and
        // where that stops being true.
        // The TS caps the MCP body and DESTROYS the socket on overflow (no response at all), so a
        // client cannot mistake a too-large request for a rejected one. 4 MB matches
        // mcpServer.ts's MCP_BODY_MAX_BYTES exactly — tool-call requests are small JSON, only a
        // hostile or broken client exceeds this.
        let Some(buf) = read_body_capped(req.into_body(), 4 * 1024 * 1024).await? else {
            return Err("/mcp body over 4MB cap — connection aborted".to_owned());
        };
        // An unparseable body becomes Null, which handle_rpc answers with a proper JSON-RPC error
        // rather than a transport failure.
        let parsed: Value = serde_json::from_slice(&buf).unwrap_or(Value::Null);
        let reply = match crate::mcp::route_rpc(&parsed) {
            crate::mcp::Dispatch::Reply(v) => v,
            crate::mcp::Dispatch::Tool { id, name, args } => {
                let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_owned);
                match name.as_str() {
                    "get_call_context" => {
                        let session_id = s("sessionId").unwrap_or_default();
                        let (rid, sid) = (s("requestId"), s("spanId"));
                        let ctx = resolve_call_context(&state, &session_id, rid.as_deref(), sid.as_deref()).await?;
                        let payload = crate::mcp_tools::get_call_context(
                            Some(&ctx),
                            &session_id,
                            rid.as_deref(),
                            sid.as_deref(),
                        );
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_burn_status" => {
                        // TRDD-BURNWDGT — label the per-account windows so the caller sees WHICH
                        // account each budget belongs to.
                        //
                        // `label_burn_status_accounts`, NOT `enrich_burn_status`: enrich is
                        // label + `currentAccount` + `residentBlobs`, and those two belong to the
                        // HTTP row-24 payload only. Reusing enrich here because it is "the burn
                        // status function" would ship two fields this tool never had.
                        //
                        // The TS also has a "Burn monitor unavailable in this runtime" branch for
                        // when no live source is wired; in this core the monitor is always present,
                        // so that branch is unreachable rather than omitted.
                        let now = crate::now_ms() as f64;
                        // TRDD-XX1UAZHS: this guard held 4,894 ms with the compute inside it.
                        // The status is computed off the lock; the hold is the account read only.
                        let status = burn_status_now(&state, now);
                        let mut st = state.lock_timed();
                        let account = st.burn.current_account(now);
                        drop(st);
                        let payload = crate::burn::runtime::label_burn_status_accounts(&status, Some(&account));
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_session_status" => {
                        // Pass-through: `computeSessionStatus` IS the payload, there is no shaper.
                        // Its no-match branch is a `{message, matchedBy:'none'}` object, NOT an
                        // error — a caller who mistypes a session id gets an honest answer.
                        let now = crate::now_ms() as f64;
                        let (sid, ws) = (s("sessionId"), s("workspace"));
                        // TRDD-QE114936: this used to call `live_session_status`, which rebuilt the
                        // summary INSIDE itself under this guard — the same O(window) hold as the
                        // eighteen direct sites, one call deep where a grep here could not see it.
                        // Renamed `session_status_over` (it computes OVER a summary, it does not
                        // build one) and the summary is read off the lock and passed in.
                        let (_, summary) = summary_now(&state, now);
                        let mut st = state.lock_timed();
                        let payload = st.session_status_over(&summary, sid.as_deref(), ws.as_deref(), now);
                        drop(st);
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_window_budget" => {
                        let now = crate::now_ms() as f64;
                        // TRDD-XX1UAZHS: compute off the lock, hold only for the account read.
                        let status = burn_status_now(&state, now);
                        let mut st = state.lock_timed();
                        let account = st.burn.current_account(now);
                        drop(st);
                        let payload = crate::mcp_tools::get_window_budget(Some(&status), Some(&account), s("accountId").as_deref());
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_recent_sessions" | "get_workspace_patterns" | "find_relevant_context" | "get_efficiency_report"
                    | "get_instruction_suggestions" => {
                        let now = crate::now_ms() as f64;
                        // TRDD-QE114936: summary OFF the lock; the guard is kept only for the
                        // lifecycle gaps, which read the live `CoreState`.
                        let (_, summary) = summary_now(&state, now);
                        let sessions: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                        let gaps = {
                            let st = state.lock_timed();
                            crate::collector_lifecycle::compute_gaps(&st.lifecycle, crate::collector_lifecycle::MIN_GAP_MS)
                        };
                        let payload = if name == "get_recent_sessions" {
                            // TRDD-PJC8N1HO: the session list is WRAPPED with the collector's
                            // downtime gaps, so a caller sees where telemetry was lost rather than
                            // reading a gap as a quiet period. The shape is `{sessions,
                            // collectorGaps}` — it was a bare array before, and the bare form is
                            // what made the loss invisible.
                            let rows = crate::mcp_tools::get_recent_sessions(
                                &sessions,
                                s("agent").as_deref(),
                                s("workspace").as_deref(),
                                args.get("limit").and_then(Value::as_f64),
                                now,
                            );
                            serde_json::json!({ "sessions": rows, "collectorGaps": gaps })
                        } else if name == "get_workspace_patterns" {
                            crate::mcp_tools::get_workspace_patterns(&sessions, args.get("days").and_then(Value::as_f64), now)
                        } else if name == "find_relevant_context" {
                            crate::mcp_tools::find_relevant_context(&sessions, s("task").as_deref().unwrap_or(""), now)
                        } else if name == "get_efficiency_report" {
                            crate::mcp_tools::get_efficiency_report(&sessions, args.get("days").and_then(Value::as_f64), now)
                        } else {
                            // The instruction FILES are read from disk, so the read happens with
                            // the lock already released (the sessions were cloned out above).
                            let ws = s("workspace");
                            let existing = ws
                                .as_deref()
                                .map(str::trim)
                                .filter(|w| !w.is_empty())
                                .map(crate::instruction_files::read_all_instruction_content)
                                .unwrap_or_default();
                            crate::mcp_tools::get_instruction_suggestions(&sessions, ws.as_deref(), &existing)
                        };
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_image_report" | "find_resident_blobs" | "query_context_blocks" => {
                        let now = crate::now_ms() as f64;
                        let n = |k: &str| args.get(k).and_then(Value::as_f64);
                        // query_context_blocks scopes by `sessionId ?? project`; the other two take
                        // an explicit `scope`. Same resolver, different door.
                        let scope = if name == "query_context_blocks" {
                            s("sessionId").or_else(|| s("project"))
                        } else {
                            s("scope")
                        };
                        let (comps, coverage) = compositions_in_scope(&state, scope.as_deref(), now).await?;
                        let payload = match name.as_str() {
                            "get_image_report" => crate::context_composition_index::image_report(&comps, scope.as_deref(), coverage),
                            "find_resident_blobs" => crate::context_composition_index::find_resident_blobs(
                                &comps,
                                scope.as_deref(),
                                coverage,
                                s("kind").as_deref(),
                                n("minTokens"),
                                n("minResidentTurns"),
                                n("topN"),
                            ),
                            _ => {
                                // The filter is REBUILT from the named fields, not handed `args`
                                // wholesale: it is ECHOED BACK in the payload, so passing the raw
                                // arguments would ship `verbosity`/`maxTokens`/`groupBy` inside a
                                // field that claims to describe the block filter. Key order is the
                                // TS literal's, and an absent field is OMITTED, never null.
                                let mut filter = serde_json::Map::new();
                                for k in ["project", "sessionId", "kind", "model", "minTokens", "turnFrom", "turnTo", "topN"] {
                                    if let Some(v) = args.get(k).filter(|v| !v.is_null()) {
                                        filter.insert(k.to_owned(), v.clone());
                                    }
                                }
                                crate::context_composition_index::query_blocks(
                                    &comps,
                                    &Value::Object(filter),
                                    s("groupBy").as_deref().unwrap_or("kind"),
                                    coverage,
                                    now,
                                )
                            }
                        };
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_runtime_inventory" => {
                        // ps + lsof + claude --version are all SUBPROCESS calls — off the executor.
                        let now = crate::now_ms() as f64;
                        let payload = tokio::task::spawn_blocking(move || {
                            crate::runtime_inventory::build_runtime_inventory(None, false, now)
                        })
                        .await
                        .map_err(|e| format!("runtime inventory join failed: {e}"))?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_skill_attribution" => {
                        // P4s lock choreography: resolve the transcript roots UNDER the lock, clone
                        // them out, UNLOCK, then do the multi-file disk scan on spawn_blocking. A
                        // full-history attribution walk reads thousands of files; holding the state
                        // lock across it would stall every other request for its duration.
                        let now = crate::now_ms() as f64;
                        let dirs = {
                            let st = state.lock_timed();
                            agentlens_logscan::discovery::claude_projects_dirs(&st.log_env)
                        };
                        // Non-finite is treated as ABSENT: in the TS a NaN window is falsy (so no
                        // sinceMs) and serializes to null (so no windowHours) — the same shape.
                        let f = |k: &str| args.get(k).and_then(Value::as_f64).filter(|v| v.is_finite());
                        let (window, top_n) = (f("window"), f("topN"));
                        let payload = tokio::task::spawn_blocking(move || {
                            crate::skill_attribution::get_skill_attribution(&dirs, window, top_n, now)
                        })
                        .await
                        .map_err(|e| format!("skill attribution join failed: {e}"))?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_cost_by_cause" => {
                        // Up to CAUSE_SCAN_CAP transcript reparses, so the whole scan goes on
                        // spawn_blocking with the lock released — and the shaper carries the same
                        // 20s budget the TS uses, so a post-restart cold pool degrades to a labelled
                        // SAMPLE instead of stalling the request.
                        let now = crate::now_ms();
                        // TRDD-QE114936: ONE off-lock summary read for the WHOLE handler — the
                        // session list here and every candidate's timeline inside `timeline_of`
                        // below. Both used to be O(window) rebuilds taken under the state lock.
                        let (_, timeline_summary) = summary_now(&state, now as f64);
                        let sessions: Vec<Value> =
                            timeline_summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                        // TRDD-MVR6PXC0: the log env, cloned off the lock ONCE for the whole scan.
                        // It is the only input the per-candidate reparse needs, which is what lets
                        // that reparse run with no guard alive.
                        let env = state.lock_timed().log_env.clone();
                        let (a, st2) = (args.clone(), state.clone());
                        let payload = tokio::task::spawn_blocking(move || {
                            let timeline_of = |c: &Value| -> Vec<Value> {
                                let Some(sid) = c.get("sessionId").and_then(Value::as_str) else { return Vec::new() };
                                // TRDD-MVR6PXC0: re-locked PER SESSION *and* only for the cheap
                                // in-memory steps — the transcript reparse runs OUTSIDE the guard.
                                // Held across it, this site measured 1,475 ms, and the state mutex is
                                // the ingest path's mutex: every posting session stalls for exactly
                                // as long as we hold it, so a 4 s hold is 4 s of blocked ingest.
                                resolve_session_card_offlock(&st2, &env, &timeline_summary, sid, now)
                                    .and_then(|c| c.get("timeline").and_then(Value::as_array).cloned())
                                    .unwrap_or_default()
                            };
                            crate::mcp_tools::get_cost_by_cause(&sessions, &timeline_of, &a, now as f64, 20_000.0)
                        })
                        .await
                        .map_err(|e| format!("cost-by-cause scan join failed: {e}"))?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_agent_tokens" => {
                        // The timeline is resolved LAZILY, per matched card: resolution can reparse
                        // a multi-MB transcript, and every early return here (not found, ambiguous,
                        // wrong parent) needs none of it.
                        let now = crate::now_ms();
                        // TRDD-QE114936: summary and id selection happen OFF the lock; the guard
                        // below covers only the `resolve_session_card` loop, which needs
                        // `&mut CoreState` for its reparse-on-demand fallback.
                        let (_, summary) = summary_now(&state, now as f64);
                        let sessions: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                        // The matched card is not known until the shaper runs, so resolve only
                        // the ONE id the query can possibly name — the normalized equivalence
                        // class is a pure string test, so it is safe to precompute here.
                        let q = args.get("agentId").and_then(Value::as_str).unwrap_or("").trim().to_lowercase();
                        let q_bare = q.strip_prefix("agent-").unwrap_or(&q).to_owned();
                        let ids: Vec<String> = sessions
                            .iter()
                            .filter_map(|s| s.get("sessionId").and_then(Value::as_str))
                            .filter(|id| {
                                let lower = id.to_lowercase();
                                lower.strip_prefix("agent-").unwrap_or(&lower) == q_bare
                            })
                            .map(str::to_owned)
                            .collect();
                        let timelines: std::collections::HashMap<String, Vec<Value>> = {
                            let mut st = state.lock_timed();
                            let mut timelines = std::collections::HashMap::new();
                            for id in ids {
                                let tl = resolve_session_card(&mut st, &summary, &id, now)
                                    .and_then(|c| c.get("timeline").and_then(Value::as_array).cloned())
                                    .unwrap_or_default();
                                timelines.insert(id, tl);
                            }
                            timelines
                        };
                        let timeline_of = |c: &Value| -> Vec<Value> {
                            timelines.get(c.get("sessionId").and_then(Value::as_str).unwrap_or("")).cloned().unwrap_or_default()
                        };
                        let payload = crate::mcp_tools::get_agent_tokens(&sessions, &timeline_of, &args, now as f64);
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_account_state_at" => {
                        let path = {
                            let st = state.lock_timed();
                            crate::account_state_timeline::account_state_timeline_path(&st.data_dir)
                        };
                        let payload = crate::mcp_tools::get_account_state_at(&args, &path);
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_context_inflation_report" => {
                        // Composition AND (single-session only) full history — both are transcript
                        // parses, so the whole thing runs on spawn_blocking with the lock released.
                        let now = crate::now_ms() as f64;
                        // TRDD-QE114936: summary OFF the lock (it was an O(window) rebuild held
                        // under the guard); the lock is now taken only for the log env.
                        let (_, summary) = summary_now(&state, now);
                        let sessions: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                        let env = state.lock_timed().log_env.clone();
                        let a = args.clone();
                        let payload = tokio::task::spawn_blocking(move || {
                            let file_ids = crate::context_composition::list_session_file_ids(&env);
                            let parent_of = |sid: &str| -> Option<String> {
                                sessions
                                    .iter()
                                    .find(|s| s.get("sessionId").and_then(Value::as_str) == Some(sid))
                                    .and_then(|s| s.get("parentSessionId").and_then(Value::as_str))
                                    .map(str::to_owned)
                            };
                            let ancestor_of = |sid: &str| -> Option<String> {
                                crate::context_composition::resolve_logged_ancestor(&env, sid, &parent_of).or_else(|| parent_of(sid))
                            };
                            let get_comp = |sid: &str| crate::context_composition::build_context_composition(&env, sid, ancestor_of(sid).as_deref());
                            let get_hist = |sid: &str| crate::context_history::build_context_history(&env, sid, ancestor_of(sid).as_deref());
                            crate::mcp_tools::get_context_inflation_report(&sessions, &file_ids, &a, &get_comp, &get_hist)
                        })
                        .await
                        .map_err(|e| format!("inflation scan join failed: {e}"))?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "find_context_hogs" => {
                        // The pool is capped at 25 sessions but each one is a transcript REPARSE, so
                        // the whole scan goes on spawn_blocking with the state lock released — the
                        // P4s rule, and the reason the composition accessor is a closure here rather
                        // than a pre-built map.
                        let now = crate::now_ms() as f64;
                        // TRDD-QE114936: summary OFF the lock (it was an O(window) rebuild held
                        // under the guard); the lock is now taken only for the log env.
                        let (_, summary) = summary_now(&state, now);
                        let sessions: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                        let env = state.lock_timed().log_env.clone();
                        let a = args.clone();
                        let payload = tokio::task::spawn_blocking(move || {
                            let file_ids = crate::context_composition::list_session_file_ids(&env);
                            let parent_of = |sid: &str| -> Option<String> {
                                sessions
                                    .iter()
                                    .find(|s| s.get("sessionId").and_then(Value::as_str) == Some(sid))
                                    .and_then(|s| s.get("parentSessionId").and_then(Value::as_str))
                                    .map(str::to_owned)
                            };
                            // The TS accessor is `.catch(() => null)`-wrapped: a session whose
                            // composition cannot be reconstructed is SKIPPED, and — crucially — is
                            // not counted as scanned, so `coverage` stays honest.
                            let get_comp = |sid: &str| -> Option<Value> {
                                let ancestor = crate::context_composition::resolve_logged_ancestor(&env, sid, &parent_of).or_else(|| parent_of(sid));
                                crate::context_composition::build_context_composition(&env, sid, ancestor.as_deref())
                            };
                            crate::mcp_tools::find_context_hogs(&sessions, &file_ids, &a, &get_comp)
                        })
                        .await
                        .map_err(|e| format!("context hog scan join failed: {e}"))?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_context_growth" => {
                        let now = crate::now_ms();
                        let session_id = s("sessionId").unwrap_or_default();
                        // TRDD-QE114936: the summary is read OFF the lock; the guard covers only
                        // the resolved timeline (the same reparse-on-demand + OTEL graft path
                        // row 30 uses), which needs `&mut CoreState`.
                        let (_, summary) = summary_now(&state, now as f64);
                        let card = summary
                            .get("sessions")
                            .and_then(Value::as_array)
                            .and_then(|v| v.iter().find(|c| c.get("sessionId").and_then(Value::as_str) == Some(session_id.as_str())).cloned());
                        let timeline: Vec<Value> = {
                            let mut st = state.lock_timed();
                            resolve_session_card(&mut st, &summary, &session_id, now)
                                .and_then(|c| c.get("timeline").and_then(Value::as_array).cloned())
                                .unwrap_or_default()
                        };
                        let payload = match card {
                            Some(c) => crate::mcp_tools::get_context_growth(&c, &timeline),
                            // The TS builds this error in the DISPATCH case, not the handler — an
                            // unknown session is a bad request, not an undiagnosable session.
                            None => serde_json::json!({ "error": format!("Session {session_id} not found.") }),
                        };
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_subagent_tree" => {
                        let now = crate::now_ms() as f64;
                        // TRDD-QE114936: summary OFF the lock — nothing else here needs the state.
                        let (_, summary) = summary_now(&state, now);
                        let sessions: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                        let payload = crate::mcp_tools::get_subagent_tree(&sessions, &s("sessionId").unwrap_or_default(), now);
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_loaded_plugin_versions" => {
                        // Same P4s choreography as get_skill_attribution: roots under the lock,
                        // then UNLOCK before the disk walk — this one reads every transcript AND
                        // stats the whole plugin cache.
                        let now = crate::now_ms() as f64;
                        let (dirs, cache_root) = {
                            let st = state.lock_timed();
                            (
                                agentlens_logscan::discovery::claude_projects_dirs(&st.log_env),
                                // The TS uses os.homedir() directly here, NOT the CLAUDE_CONFIG_DIR
                                // override the projects dirs honour — so this must not "helpfully"
                                // resolve differently from the paths the report compares against.
                                st.log_env.home.join(".claude").join("plugins").join("cache"),
                            )
                        };
                        let plugin = args.get("plugin").and_then(Value::as_str).map(str::to_owned);
                        // `opts.activeMinutes !== undefined` is a PRESENCE test, not a truthy one, so
                        // 0 is a real window (cutoff = now). An explicit `null` is present too and
                        // coerces to 0 in `now - null * 60_000` — reproduced rather than "fixed",
                        // because a silent divergence is a bug to re-derive later while an inherited
                        // quirk stays fixable in one place. Any other non-number yields a NaN cutoff,
                        // which compares false and is therefore inert — the same as no window.
                        let active = match args.get("activeMinutes") {
                            None => None,
                            Some(Value::Null) => Some(0.0),
                            Some(v) => v.as_f64().filter(|n| n.is_finite()),
                        };
                        // `opts.staleOnly &&` is a TRUTHY test, not a boolean read.
                        let stale_only = args.get("staleOnly").is_some_and(crate::summarize::helpers::truthy);
                        let payload = tokio::task::spawn_blocking(move || {
                            crate::loaded_plugin_versions::build_loaded_versions_report(
                                &dirs,
                                &cache_root,
                                plugin.as_deref(),
                                active,
                                stale_only,
                                now,
                            )
                        })
                        .await
                        .map_err(|e| format!("loaded plugin versions join failed: {e}"))?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_cost_rollup" | "predict_session_cost" => {
                        let now = crate::now_ms() as f64;
                        // TRDD-QE114936: summary OFF the lock — nothing else here needs the state.
                        let (_, summary) = summary_now(&state, now);
                        let sessions: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                        let payload = if name == "get_cost_rollup" {
                            crate::mcp_tools::get_cost_rollup(&sessions, &args, now)
                        } else {
                            crate::mcp_tools::predict_session_cost(&sessions, &args, now)
                        };
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_session_detail" => {
                        let now = crate::now_ms();
                        let session_id = s("sessionId").unwrap_or_default();
                        // TRDD-QE114936: the summary cards are read OFF the lock. The guard below
                        // still covers the RESOLVED timeline (the same resolveSessionCard row 30
                        // uses — reparse-on-demand + OTEL graft) and the fork-ancestor walk, both
                        // of which need `CoreState`. The multi-GB transcript parse then runs with
                        // the lock RELEASED.
                        let (_, summary) = summary_now(&state, now as f64);
                        let sessions: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                        let (timeline, env, ancestor) = {
                            let mut st = state.lock_timed();
                            let timeline: Vec<Value> = resolve_session_card(&mut st, &summary, &session_id, now)
                                .and_then(|c| c.get("timeline").and_then(Value::as_array).cloned())
                                .unwrap_or_default();
                            let parent_of = |sid: &str| -> Option<String> {
                                sessions
                                    .iter()
                                    .find(|s| s.get("sessionId").and_then(Value::as_str) == Some(sid))
                                    .and_then(|s| s.get("parentSessionId").and_then(Value::as_str))
                                    .map(str::to_owned)
                            };
                            let ancestor = crate::context_composition::resolve_logged_ancestor(&st.log_env, &session_id, &parent_of)
                                .or_else(|| parent_of(&session_id));
                            (timeline, st.log_env.clone(), ancestor)
                        };
                        let sid = session_id.clone();
                        // Composition is OPTIONAL context — the TS wraps the accessor in
                        // `.catch(() => null)`, so a failed reconstruction only omits the rollup.
                        let composition = tokio::task::spawn_blocking(move || {
                            crate::context_composition::build_context_composition(&env, &sid, ancestor.as_deref())
                        })
                        .await
                        .unwrap_or(None);
                        let payload = crate::mcp_tools::get_session_detail(
                            &sessions,
                            &timeline,
                            composition.as_ref(),
                            &session_id,
                            now as f64,
                        );
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_block_content" => {
                        // The MCP args are already JSON numbers, so there is no `Number('')===0`
                        // trap here — that one belongs to the HTTP path segments. An absent arg is
                        // 0, matching the TS's `undefined` arithmetic reaching the same pointer
                        // lookup rather than throwing.
                        let n = |k: &str| args.get(k).and_then(Value::as_f64).unwrap_or(0.0);
                        let payload = resolve_block_content(
                            &state,
                            &s("sessionId").unwrap_or_default(),
                            n("turn"),
                            n("blockIndex"),
                            args.get("full") == Some(&Value::Bool(true)),
                        )
                        .await?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_body_writers" => {
                        // A full pass over the bodies dir (stat every file, bounded-read every
                        // request), so it goes on spawn_blocking with the lock released.
                        //
                        // `store: None` — the durable DuckDB store is not held by the Rust server,
                        // so this takes the TS's OWN store-unavailable branch: totals cover the
                        // live dir only, and the payload's `note` says "STORE UNAVAILABLE" rather
                        // than presenting a partial total as a complete one.
                        let now = crate::now_ms() as f64;
                        // TRDD-QE114936: summary OFF the lock; the guard covers only the two
                        // path/home reads that need `CoreState`.
                        let (_, summary) = summary_now(&state, now);
                        let sessions: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                        let (dir, home) = {
                            let st = state.lock_timed();
                            let dir = crate::burn::guard::default_bodies_dir(&st.data_dir);
                            let home = st.burn.home_dir.to_string_lossy().into_owned();
                            (dir, home)
                        };
                        let n = |k: &str, d: f64| args.get(k).and_then(Value::as_f64).unwrap_or(d).max(1.0) * 60_000.0;
                        let (window_ms, active_ms) = (n("window_min", 30.0), n("active_min", 10.0));
                        let limit = args.get("limit").and_then(Value::as_f64).unwrap_or(20.0).max(1.0);
                        let payload = tokio::task::spawn_blocking(move || {
                            let live = crate::body_writers::scan_live_body_writers(&dir, now, window_ms);
                            // Only these three card fields cross the boundary, as in the TS — a
                            // whole card could let a future field shadow the body's own attribution.
                            let cards: Vec<Value> = sessions
                                .iter()
                                .map(|s| {
                                    let mut m = serde_json::Map::new();
                                    for k in ["sessionId", "workspace", "source"] {
                                        if let Some(v) = s.get(k) {
                                            m.insert(k.to_owned(), v.clone());
                                        }
                                    }
                                    Value::Object(m)
                                })
                                .collect();
                            crate::body_writers::build_body_writers_report(&crate::body_writers::BodyWritersOpts {
                                live: &live,
                                store: None,
                                cards: &cards,
                                now_ms: now,
                                window_ms,
                                active_ms,
                                limit,
                                home: &home,
                            })
                        })
                        .await
                        .map_err(|e| format!("body-writers scan join failed: {e}"))?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_cache_creation_report" => {
                        // A bounded pass over the raw-body dir (stat every file, parse the capped
                        // slice), so it runs on spawn_blocking with the state lock released.
                        let now = crate::now_ms() as f64;
                        let dir = {
                            let st = state.lock_timed();
                            crate::burn::guard::default_bodies_dir(&st.data_dir)
                        };
                        let group_by = args.get("groupBy").and_then(Value::as_str).unwrap_or("session").to_owned();
                        let payload = if group_by == "cause" {
                            // The TS routes groupBy='cause' to buildCauseCostPeakReport
                            // (cacheBreakTimeline.ts), which needs the full prefix-diff classifier —
                            // not yet ported. Naming the gap is the only honest answer: silently
                            // falling back to 'session' would return a DIFFERENT report under the
                            // label the caller asked for, and every number in it would look right.
                            crate::mcp_tools::error_payload(
                                "groupBy='cause' is served by buildCauseCostPeakReport (cacheBreakTimeline), which the Rust core has not ported yet. session|account|model|time are available.",
                            )
                        } else {
                            let bucket = args.get("bucket").and_then(Value::as_str).unwrap_or("cache_creation").to_owned();
                            let top_n = args.get("topN").and_then(Value::as_f64);
                            let format = args.get("format").and_then(Value::as_str).unwrap_or("json").to_owned();
                            let opts = crate::cache_creation_forensics::ScanOptions {
                                window_hours: args.get("window").and_then(Value::as_f64),
                                ..Default::default()
                            };
                            tokio::task::spawn_blocking(move || {
                                let report = crate::cache_creation_forensics::build_cache_creation_report(
                                    &dir, &opts, &group_by, &bucket, top_n, now,
                                );
                                crate::cache_creation_forensics::format_cost_peaks(&report, &format)
                            })
                            .await
                            .map_err(|e| format!("cache-creation report scan join failed: {e}"))?
                        };
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "trace_expensive_writes" => {
                        // Heavier than the report: with chainDepth > 0 it fully parses a second
                        // bounded request slice AND builds a call composition per turn.
                        let now = crate::now_ms() as f64;
                        let dir = {
                            let st = state.lock_timed();
                            crate::burn::guard::default_bodies_dir(&st.data_dir)
                        };
                        let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_owned);
                        let n = |k: &str| args.get(k).and_then(Value::as_f64);
                        let filters = crate::cache_creation_forensics::TraceFilters {
                            session_id: s("sessionId"),
                            account_uuid: s("accountUuid"),
                            model: s("model"),
                            min_cache_create: n("minCacheCreate"),
                            min_output_tokens: n("minOutputTokens"),
                            turn_from: n("turnFrom"),
                            turn_to: n("turnTo"),
                            // The wire names drop the Iso suffix the engine field carries.
                            time_from_iso: s("timeFrom"),
                            time_to_iso: s("timeTo"),
                            top_n: n("topN"),
                            chain_depth: n("chainDepth"),
                        };
                        let opts = crate::cache_creation_forensics::ScanOptions {
                            window_hours: n("window"),
                            ..Default::default()
                        };
                        let format = args.get("format").and_then(Value::as_str).unwrap_or("json").to_owned();
                        let payload = tokio::task::spawn_blocking(move || {
                            let trace = crate::cache_creation_forensics::build_expensive_writes_trace(&dir, &opts, &filters, now);
                            crate::cache_creation_forensics::format_expensive_writes(&trace, &format)
                        })
                        .await
                        .map_err(|e| format!("expensive-writes trace join failed: {e}"))?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_heartbeat_cost" => {
                        // Reads every body file in the window (regex over raw text, plus a full
                        // parse per candidate for the fire-start walk), so it goes on
                        // spawn_blocking with the state lock released.
                        let now = crate::now_ms() as f64;
                        let dir = {
                            let st = state.lock_timed();
                            crate::burn::guard::default_bodies_dir(&st.data_dir)
                        };
                        let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_owned);
                        let opts = crate::heartbeat_cost::HeartbeatCostOptions {
                            marker: s("marker"),
                            session_id: s("sessionId"),
                            window_hours: args.get("window").and_then(Value::as_f64),
                            fire: s("fire"),
                        };
                        let payload = tokio::task::spawn_blocking(move || {
                            crate::heartbeat_cost::build_heartbeat_cost(&dir, &opts, now)
                        })
                        .await
                        .map_err(|e| format!("heartbeat cost join failed: {e}"))?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_cache_break_timeline" | "get_cache_break_causes" => {
                        // A bounded, recency-first scan of the raw request/response bodies (spool ∪
                        // Parquet store), chunk-loaded and re-parsed per turn — spawn_blocking work,
                        // and the CoreState lock is released before any of it (the P4s rule).
                        let is_timeline = name == "get_cache_break_timeline";
                        let (data_dir, projects_dirs) = {
                            let st = state.lock_timed();
                            (st.data_dir.clone(), agentlens_logscan::discovery::claude_projects_dirs(&st.log_env))
                        };
                        let session_id = args.get("sessionId").and_then(Value::as_str).map(str::to_owned);
                        let scope = args.get("scope").and_then(Value::as_str).map(str::to_owned);
                        let min_tokens = args.get("minTokens").and_then(Value::as_f64);
                        // The MCP arg is `window`, in HOURS — the builders' field is `windowHours`.
                        let window_hours = args.get("window").and_then(Value::as_f64);
                        let top_n = args.get("topN").and_then(Value::as_f64);
                        let format = args
                            .get("format")
                            .and_then(Value::as_str)
                            .unwrap_or("json")
                            .to_owned();
                        let payload = tokio::task::spawn_blocking(move || {
                            if is_timeline {
                                let mut o = crate::cache_break_timeline::CacheBreakTimelineOptions::new(data_dir);
                                o.session_id = session_id;
                                o.scope = scope;
                                o.min_tokens = min_tokens;
                                o.window_hours = window_hours;
                                o.top_n = top_n;
                                o.projects_dirs = Some(projects_dirs);
                                let report = crate::cache_break_timeline::build_cache_break_timeline(&o);
                                crate::cache_break_timeline::format_timeline(&report, &format)
                            } else {
                                let mut o = crate::cache_break_timeline::CacheBreakCausesOptions::new(data_dir);
                                o.scope = scope;
                                o.min_tokens = min_tokens;
                                o.window_hours = window_hours;
                                o.top_n = top_n;
                                crate::cache_break_timeline::build_cache_break_causes(&o)
                            }
                        })
                        .await
                        .map_err(|e| format!("cache-break scan join failed: {e}"))?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "burn_seismic" => {
                        let (dirs, tmp_dir) = {
                            let st = state.lock_timed();
                            (
                                agentlens_logscan::discovery::claude_projects_dirs(&st.log_env),
                                st.data_dir.join("store").join(agentlens_store::TMP_DIR),
                            )
                        };
                        let scope_s = args.get("scope").and_then(Value::as_str).unwrap_or("fleet").to_owned();
                        let workspace = args.get("workspace").and_then(Value::as_str).map(str::to_owned);
                        let session_id = args.get("sessionId").and_then(Value::as_str).map(str::to_owned);
                        // The two scopes that cannot be run without their argument fail HERE with a
                        // named error rather than silently scanning the whole fleet, which is what a
                        // missing workspace would otherwise turn into.
                        let missing = if scope_s == "workspace" && workspace.is_none() {
                            Some("scope='workspace' requires a workspace path")
                        } else if scope_s == "session" && session_id.is_none() {
                            Some("scope='session' requires a sessionId")
                        } else {
                            None
                        };
                        let a = args.clone();
                        let payload = tokio::task::spawn_blocking(move || {
                            use crate::burn_seismic as bs;
                            if let Some(msg) = missing {
                                return serde_json::json!({ "error": msg });
                            }
                            let g = |k: &str| a.get(k).and_then(Value::as_f64);
                            let gs = |k: &str| a.get(k).and_then(Value::as_str).map(str::to_owned);
                            let now = crate::now_ms() as f64;
                            let window_hours = g("windowHours").unwrap_or(8.0).clamp(0.1, 72.0);
                            let since_ms = now - window_hours * 3_600_000.0;
                            let scope = match scope_s.as_str() {
                                "workspace" => bs::SeismicScope::Workspace,
                                "session" => bs::SeismicScope::Session,
                                _ => bs::SeismicScope::Fleet,
                            };
                            let files = bs::resolve_seismic_files(&bs::ResolveSeismicOptions {
                                scope,
                                workspace: workspace.as_deref(),
                                session_id: session_id.as_deref(),
                                since_ms,
                                include_subagents: a.get("includeSubagents").and_then(Value::as_bool).unwrap_or(false),
                                max_files: g("maxFiles"),
                                projects_dirs: dirs,
                            });
                            let (fdr_method, rate_law, pvalue_engine) =
                                (gs("fdrMethod"), gs("rateLaw"), gs("pvalueEngine"));
                            let opts = bs::BurnSeismicOptions {
                                files,
                                since_iso: Some(crate::summarize::helpers::iso_from_ms(since_ms)),
                                bucket_minutes: g("bucketMinutes"),
                                fdr_alpha: g("fdrAlpha"),
                                fdr_method: fdr_method.as_deref(),
                                cfar_reference: g("cfarReference"),
                                cfar_guard: g("cfarGuard"),
                                cfar_trim: g("cfarTrim"),
                                cfar_min_reference: g("cfarMinReference"),
                                rate_law: rate_law.as_deref(),
                                pvalue_engine: pvalue_engine.as_deref(),
                                top_events: Some(10.0),
                                top_sessions: Some(10.0),
                                ..bs::BurnSeismicOptions::default()
                            };
                            // One session for the whole analysis: the three statements are only
                            // consistent with each other if they see the same connection.
                            let seismic = match agentlens_store::transcript_sql::DuckSession::open_in_memory(&tmp_dir) {
                                Ok(sess) => bs::burn_seismic(&opts, &|sql| sess.query(sql), now),
                                // The TS reaches the same place by failing to import the binding.
                                Err(_) => bs::burn_seismic(&opts, &|_| Err("duckdb unavailable".to_owned()), now),
                            };
                            // Ship the rendered report AND the structured result: the CLI prints
                            // `report` verbatim, an MCP caller keeps the machine-readable fields.
                            // `buckets[]` is dropped from the wire form (480+ rows) — the report
                            // plus events/sessions already carry the signal.
                            let mut wire = serde_json::Map::new();
                            wire.insert("report".into(), Value::String(bs::render_burn_seismic(&seismic)));
                            if let Value::Object(m) = seismic {
                                for (k, v) in m {
                                    if k != "buckets" {
                                        wire.insert(k, v);
                                    }
                                }
                            }
                            Value::Object(wire)
                        })
                        .await
                        .map_err(|e| format!("burn seismic join failed: {e}"))?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "compare_configs" => {
                        // Same fact store, same lazy index, same blocking shape as
                        // run_diagnostics_sql below — the two tools are one engine's two front ends.
                        let data_dir = {
                            let st = state.lock_timed();
                            st.data_dir.clone()
                        };
                        let a = args.clone();
                        let payload = tokio::task::spawn_blocking(move || {
                            use crate::forensics_compare as fc;
                            let now = crate::now_ms() as f64;
                            let filter = a.get("filter");
                            let db = crate::forensics_db::default_forensics_db(&data_dir);
                            let mut o = crate::forensics_scan::ScanApiCallOptions::new(
                                crate::burn::guard::default_bodies_dir(&data_dir),
                                data_dir.join("store"),
                            );
                            o.window_hours = filter.and_then(|f| f.get("window")).and_then(Value::as_f64);
                            // Unconditional here, unlike run_diagnostics_sql: compare_configs has no
                            // argument-free mode that answers without touching the facts.
                            if let Err(e) = crate::forensics_scan::ensure_fresh_index(
                                &db,
                                &o,
                                &crate::forensics_db::default_main_db(&data_dir),
                                true,
                                5.0 * 60_000.0,
                                false,
                                now,
                            ) {
                                return crate::mcp_tools::error_payload(&format!("forensics index failed: {e}"));
                            }
                            fc::build_compare_configs(
                                &db,
                                &fc::CompareConfigsOptions {
                                    group_by: a.get("groupBy").and_then(Value::as_str),
                                    metric: a.get("metric").and_then(Value::as_str),
                                    agg: a.get("agg").and_then(Value::as_str),
                                    filter,
                                    rank_order: a.get("rankOrder").and_then(Value::as_str),
                                    top_n: a.get("topN").and_then(Value::as_f64),
                                },
                                now,
                            )
                        })
                        .await
                        .map_err(|e| format!("compare configs join failed: {e}"))?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "run_diagnostics_sql" => {
                        // SQLite over the forensics fact store, plus the lazy index pass that fills
                        // it — both blocking, so spawn_blocking with the state lock released first.
                        let data_dir = {
                            let st = state.lock_timed();
                            st.data_dir.clone()
                        };
                        let a = args.clone();
                        let payload = tokio::task::spawn_blocking(move || {
                            use crate::forensics_sql as fsql;
                            let now = crate::now_ms() as f64;
                            let params = a.get("params").and_then(Value::as_object);
                            let preset = a.get("preset").and_then(Value::as_str);
                            let sql = a.get("sql").and_then(Value::as_str);
                            let db = crate::forensics_db::default_forensics_db(&data_dir);
                            // Index only when actually querying — no args lists the preset library,
                            // which needs no facts and must stay free.
                            if preset.is_some() || sql.is_some() {
                                let mut o = crate::forensics_scan::ScanApiCallOptions::new(
                                    crate::burn::guard::default_bodies_dir(&data_dir),
                                    data_dir.join("store"),
                                );
                                o.window_hours = params.and_then(|p| p.get("window")).and_then(Value::as_f64);
                                // The TS `await`s this with no catch, so a failed index fails the
                                // CALL. Kept: answering from stale facts under a freshness contract
                                // would be a wrong answer that looks exactly like a right one.
                                if let Err(e) = crate::forensics_scan::ensure_fresh_index(
                                    &db,
                                    &o,
                                    &crate::forensics_db::default_main_db(&data_dir),
                                    true,
                                    5.0 * 60_000.0,
                                    false,
                                    now,
                                ) {
                                    return crate::mcp_tools::error_payload(&format!(
                                        "forensics index failed: {e}"
                                    ));
                                }
                            }
                            fsql::run_diagnostics_sql(
                                &db,
                                &fsql::RunDiagnosticsSqlOptions {
                                    preset,
                                    sql,
                                    params,
                                    format: a.get("format").and_then(Value::as_str),
                                    limit: a.get("limit").and_then(Value::as_f64),
                                },
                                now,
                            )
                        })
                        .await
                        .map_err(|e| format!("diagnostics sql join failed: {e}"))?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "run_transcript_sql" => {
                        // DuckDB over a BOUNDED set of transcript files — blocking, so
                        // spawn_blocking with the state lock released first.
                        let (dirs, tmp_dir) = {
                            let st = state.lock_timed();
                            (
                                agentlens_logscan::discovery::claude_projects_dirs(&st.log_env),
                                st.data_dir.join("store").join(agentlens_store::TMP_DIR),
                            )
                        };
                        let preset = args.get("preset").and_then(Value::as_str).map(str::to_owned);
                        let sql = args.get("sql").and_then(Value::as_str).map(str::to_owned);
                        let session_id = args.get("sessionId").and_then(Value::as_str).map(str::to_owned);
                        // The MCP arg is `window`; the engine's field is `windowHours`.
                        let window_hours = args.get("window").and_then(Value::as_f64);
                        let limit = args.get("limit").and_then(Value::as_f64);
                        let payload = tokio::task::spawn_blocking(move || {
                            let opts = agentlens_store::transcript_sql::TranscriptSqlOptions {
                                preset: preset.as_deref(),
                                sql: sql.as_deref(),
                                session_id: session_id.as_deref(),
                                window_hours,
                                limit,
                                projects_dirs: dirs,
                                tmp_dir,
                            };
                            agentlens_store::transcript_sql::run_transcript_sql(&opts, crate::now_ms() as f64)
                        })
                        .await
                        .map_err(|e| format!("transcript sql join failed: {e}"))?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "run_cache_turns_sql" => {
                        // TRDD-GVA8TTJF — DuckDB over the api_call parts + body-links + the
                        // statusline stream. Blocking; spawn_blocking with the lock released.
                        let data_dir = {
                            let st = state.lock_timed();
                            st.data_dir.clone()
                        };
                        let preset = args.get("preset").and_then(Value::as_str).map(str::to_owned);
                        let sql = args.get("sql").and_then(Value::as_str).map(str::to_owned);
                        let window = args.get("window").and_then(Value::as_f64);
                        let limit = args.get("limit").and_then(Value::as_f64);
                        let payload = tokio::task::spawn_blocking(move || {
                            crate::cache_turns_sql::run_preset_or_sql(
                                &data_dir,
                                preset.as_deref(),
                                sql.as_deref(),
                                window,
                                limit,
                            )
                        })
                        .await
                        .map_err(|e| format!("cache turns sql join failed: {e}"))?;
                        // Errors fold INTO the payload (sibling contract): a SQL error is a
                        // structured tool answer, not a hard failed call.
                        let payload = payload.unwrap_or_else(|e| serde_json::json!({ "error": e }));
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_subscription_usage" => {
                        // The one tool here that talks to the network. Blocking transport + file
                        // locks, so it runs on spawn_blocking with the state lock released first.
                        let (data_dir, home) = {
                            let st = state.lock_timed();
                            (st.data_dir.clone(), st.log_env.home.clone())
                        };
                        let force = args.get("force").and_then(Value::as_bool).unwrap_or(false);
                        let format = args.get("format").and_then(Value::as_str).unwrap_or("table").to_owned();
                        let payload = tokio::task::spawn_blocking(move || {
                            use crate::subscription_usage as su;
                            let now = crate::now_ms() as f64;
                            let vars: std::collections::HashMap<String, String> = std::env::vars().collect();
                            let cfg_dir = vars.get("CLAUDE_CONFIG_DIR").map(std::path::PathBuf::from);
                            // `allow_keychain` is the per-CALL override the MCP tool never sets
                            // (the TS handler passes only `force`); consent comes from the durable
                            // env-or-config knob, which is why it is resolved here and not latched
                            // at boot.
                            let loaded = su::load_token(
                                cfg_dir.as_deref(),
                                &home,
                                false,
                                su::keychain_read_allowed(&data_dir, &vars),
                                cfg!(target_os = "macos"),
                            );
                            // The label the LOCAL config claims, used only to flag a disagreement
                            // with the token's own identity. The keychain reader is stubbed out: it
                            // would only fill in the plan type, and an un-ACL'd read pops a
                            // password prompt on a path that must never block a tool call.
                            let no_keychain = || None;
                            let claimed =
                                crate::burn::account_info::get_current_account(&home, &vars, Some(&no_keychain)).email;
                            let usage = su::get_subscription_usage(
                                &su::UsagePaths::under(&data_dir),
                                &loaded,
                                now,
                                force,
                                claimed.as_deref(),
                                &su::live_fetch_usage,
                                &su::live_fetch_identity,
                            );
                            if format == "json" {
                                usage.unwrap_or_else(|| {
                                    serde_json::json!({"error": "unavailable", "reason": "no_token_or_opt_in_required"})
                                })
                            } else {
                                serde_json::json!({
                                    "format": "table",
                                    "text": su::format_subscription_usage(usage.as_ref(), now),
                                })
                            }
                        })
                        .await
                        .map_err(|e| format!("subscription usage join failed: {e}"))?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_rate_limit_report" => {
                        // Reads the hook-event buckets, then deep-attributes the newest episode via
                        // a bounded body scan — spawn_blocking, lock released first.
                        let now = crate::now_ms() as f64;
                        let (rl_data_dir, hook_dir, home, projects_dirs) = {
                            let st = state.lock_timed();
                            (
                                st.data_dir.clone(),
                                st.data_dir.join("hook-events"),
                                st.log_env.home.to_string_lossy().into_owned(),
                                agentlens_logscan::discovery::claude_projects_dirs(&st.log_env),
                            )
                        };
                        // Resolved ONCE, outside the closure: `investigate` is called per window and
                        // re-statting the candidate dirs on every call would let the scope shift
                        // mid-report, so two windows in one report could disagree about coverage.
                        let rl_scope = crate::burn::guard::resolve_bodies_read_scope(&rl_data_dir);
                        let rl_scope_dirs: Vec<String> =
                            rl_scope.dirs.iter().map(|p| p.to_string_lossy().into_owned()).collect();
                        let rl_scope_missing: Vec<String> =
                            rl_scope.missing.iter().map(|p| p.to_string_lossy().into_owned()).collect();
                        let opts = crate::rate_limit_report::RateLimitReportOptions {
                            window_hours: args.get("windowHours").and_then(Value::as_f64),
                            max_episodes: args.get("maxEpisodes").and_then(Value::as_f64),
                            max_files: args.get("maxFiles").and_then(Value::as_f64),
                        };
                        let payload = tokio::task::spawn_blocking(move || {
                            // The TS passes the real investigateBurn here; the Result seam exists
                            // for the oracle's stub, so the production closure is always Ok.
                            let investigate = |hours: f64, until: f64, max_files: f64| {
                                // Same full multi-dir scope as the burn-investigator arm. This site
                                // carried the identical single-dir shortcut with NO comment marking
                                // it, which is how a known divergence becomes an unknown one.
                                let io = crate::burn::investigator_scan::InvestigateOptions {
                                    scope: crate::burn::investigator_scan::BodiesScope {
                                        dirs: rl_scope_dirs.clone(),
                                        missing: rl_scope_missing.clone(),
                                    },
                                    hook_events_dir: hook_dir.clone(),
                                    home: home.clone(),
                                    window_hours: Some(hours),
                                    until_ms: Some(until),
                                    max_files: Some(max_files),
                                    // QSFYIHUO step 3: the rate-limit arm reads the same store
                                    // (data_dir/store) the burn arm does — mirroring
                                    // cache_event_log.rs's store threading.
                                    store_dir: Some(rl_data_dir.join("store")),
                                };
                                let mut inv = crate::burn::investigator::investigate_burn(&io, now);
                                crate::burn::investigator::attach_causing_calls(&mut inv, &home, &projects_dirs);
                                Ok(inv)
                            };
                            crate::rate_limit_report::build_rate_limit_report(
                                &hook_dir, &opts, now, &investigate,
                            )
                        })
                        .await
                        .map_err(|e| format!("rate limit report join failed: {e}"))?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "investigate_burn" => {
                        // Scans every request AND response body in the window (a chunked read per
                        // request, up to 6MB each), then reads transcripts for whatever the
                        // detectors found — squarely spawn_blocking work, lock released first.
                        let now = crate::now_ms() as f64;
                        let until_iso = args.get("untilIso").and_then(Value::as_str).map(str::to_owned);
                        let until_ms = match &until_iso {
                            Some(s) => crate::summarize::helpers::parse_iso_ms(s),
                            None => None,
                        };
                        // An unparseable untilIso is an EXPLICIT error payload, never a silent
                        // fallback to "now" — a window the caller did not ask for would be
                        // answered with confident numbers about the wrong hours.
                        let bad_iso = until_iso.as_ref().filter(|_| until_ms.is_none()).cloned();
                        let (data_dir, hook_dir, home, projects_dirs) = {
                            let st = state.lock_timed();
                            (
                                st.data_dir.clone(),
                                st.data_dir.join("hook-events"),
                                st.log_env.home.to_string_lossy().into_owned(),
                                agentlens_logscan::discovery::claude_projects_dirs(&st.log_env),
                            )
                        };
                        // The multi-dir scope (captureConfig.resolveBodiesReadScope): one dir
                        // since TRDD-Z53IJFE9 step D (the RAM-disk spool is gone), but the list
                        // shape is kept so `missing` can name unreadable dirs.
                        let scope = crate::burn::guard::resolve_bodies_read_scope(&data_dir);
                        let opts = crate::burn::investigator_scan::InvestigateOptions {
                            scope: crate::burn::investigator_scan::BodiesScope {
                                dirs: scope.dirs.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
                                missing: scope.missing.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
                            },
                            hook_events_dir: hook_dir,
                            home: home.clone(),
                            window_hours: args.get("windowHours").and_then(Value::as_f64),
                            until_ms,
                            max_files: args.get("maxFiles").and_then(Value::as_f64),
                            // QSFYIHUO step 3: store-first scan for the burn arm (mirrors
                            // cache_event_log.rs:739's store threading).
                            store_dir: Some(data_dir.join("store")),
                        };
                        let payload = match bad_iso {
                            Some(s) => crate::mcp_tools::error_payload(&format!(
                                "untilIso \"{s}\" is not a parseable ISO datetime"
                            )),
                            None => tokio::task::spawn_blocking(move || {
                                let mut inv = crate::burn::investigator::investigate_burn(&opts, now);
                                // Name the VERBATIM tool-call behind each fan-out finding. Reads
                                // the JSONL only for real findings, so a blind/empty scan pays
                                // nothing.
                                crate::burn::investigator::attach_causing_calls(&mut inv, &home, &projects_dirs);
                                inv
                            })
                            .await
                            .map_err(|e| format!("investigate burn join failed: {e}"))?,
                        };
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_session_burn_profile" => {
                        // Reads every body file in the window (regex over raw text, one full parse
                        // for the newest), so it goes on spawn_blocking with the lock released.
                        let now = crate::now_ms() as f64;
                        let session_id = args.get("sessionId").and_then(Value::as_str).unwrap_or("").to_owned();
                        let payload = if session_id.is_empty() {
                            crate::mcp_tools::error_payload("get_session_burn_profile requires sessionId")
                        } else {
                            // TRDD-QE114936: summary OFF the lock; the guard covers only the
                            // bodies-dir path read.
                            let (_, summary) = summary_now(&state, now);
                            let sessions: Vec<Value> =
                                summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                            let bodies_dir = {
                                let st = state.lock_timed();
                                crate::burn::guard::default_bodies_dir(&st.data_dir)
                            };
                            let opts = crate::session_burn_profile::SessionBurnProfileOptions {
                                session_id: session_id.clone(),
                                window_hours: args.get("window").and_then(Value::as_f64),
                            };
                            tokio::task::spawn_blocking(move || {
                                let mut profile =
                                    crate::session_burn_profile::build_session_burn_profile(&bodies_dir, &opts, now);
                                // P7 provenance: the profile itself is body-scan derived, so the
                                // served card carries which feed backs the session's token figures.
                                // Exact id first, then the same unique-PREFIX match the tool accepts
                                // — otherwise a prefix query gets a profile with no provenance.
                                fn sid_of(s: &Value) -> &str {
                                    s.get("sessionId").and_then(Value::as_str).unwrap_or("")
                                }
                                let card = sessions
                                    .iter()
                                    .find(|s| sid_of(s) == session_id)
                                    .or_else(|| sessions.iter().find(|s| sid_of(s).starts_with(&session_id)));
                                if let Some(obj) = profile.as_object_mut() {
                                    // `?? null` KEEPS the key — a missing card is "unknown", never
                                    // a silently absent field.
                                    obj.insert(
                                        "tokensSource".into(),
                                        card.and_then(|c| c.get("tokensSource")).cloned().unwrap_or(Value::Null),
                                    );
                                    // `...(card?.coverageNote ? {…} : {})` is TRUTHY — an absent OR
                                    // empty note DROPS the key entirely.
                                    if let Some(note) = card
                                        .and_then(|c| c.get("coverageNote"))
                                        .filter(|v| crate::summarize::helpers::truthy(v))
                                    {
                                        obj.insert("coverageNote".into(), note.clone());
                                    }
                                }
                                profile
                            })
                            .await
                            .map_err(|e| format!("session burn profile join failed: {e}"))?
                        };
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_cache_event_log" => {
                        // A bounded body scan PLUS a span-store walk, so it goes on spawn_blocking
                        // with the state lock released.
                        let now = crate::now_ms() as f64;
                        let (bodies_dir, spans_dir, store_dir) = {
                            let st = state.lock_timed();
                            (crate::burn::guard::default_bodies_dir(&st.data_dir), st.data_dir.join("spans"), st.data_dir.join("store"))
                        };
                        let s = |k: &str| args.get(k).and_then(Value::as_str).map(str::to_owned);
                        let n = |k: &str| args.get(k).and_then(Value::as_f64);
                        // Default 24h; an EXPLICIT 0 means all history (TRDD-7I5805QM). An absent
                        // window used to mean since=0 — the one input that walked the whole
                        // 5.5M-span store, which agents supplied in practice despite the schema
                        // warning, so the fail-safe default does what they meant.
                        let window_hours = match n("window") {
                            Some(0.0) => None,
                            Some(w) => Some(w),
                            None => Some(24.0),
                        };
                        let opts = crate::cache_event_log::CacheEventLogOptions {
                            project: s("project"),
                            session_id: s("sessionId"),
                            mode: s("mode"),
                            context_events: n("context"),
                            limit: n("limit"),
                            window_hours,
                            scan_cap: None,
                        };
                        let format = args.get("format").and_then(Value::as_str).unwrap_or("table").to_owned();
                        let projects_dirs = agentlens_logscan::discovery::claude_projects_dirs(
                            &agentlens_logscan::discovery::Env::from_process(),
                        );
                        let project_env_dir = std::env::var("CLAUDE_PROJECT_DIR").ok();
                        let cwd = std::env::current_dir().map(|p| p.to_string_lossy().into_owned()).unwrap_or_default();
                        let payload = tokio::task::spawn_blocking(move || {
                            let zone = crate::cache_event_log::DisplayZone::system();
                            let env = crate::cache_event_log::LedgerEnv {
                                bodies_dir: &bodies_dir,
                                spans_dir: &spans_dir,
                                store_dir: Some(&store_dir),
                                projects_dirs: &projects_dirs,
                                project_env_dir: project_env_dir.as_deref(),
                                cwd: &cwd,
                                zone: &zone,
                                now_ms: now,
                            };
                            let log = crate::cache_event_log::build_cache_event_log(&opts, &env);
                            crate::cache_event_log::format_cache_event_log(&log, &format)
                        })
                        .await
                        .map_err(|e| format!("cache event log join failed: {e}"))?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_cache_break_gap_report" => {
                        let now = crate::now_ms() as f64;
                        let dir = {
                            let st = state.lock_timed();
                            crate::burn::guard::default_bodies_dir(&st.data_dir)
                        };
                        let opts = crate::cache_creation_forensics::ScanOptions {
                            window_hours: args.get("window").and_then(Value::as_f64),
                            ..Default::default()
                        };
                        // `?? DEFAULT_BIG_CACHE_CREATE` is NULLISH, so an explicit 0 means "classify
                        // every write", not "fall back to 100k".
                        let min_cc = args.get("minCacheCreate").and_then(Value::as_f64);
                        let payload = tokio::task::spawn_blocking(move || {
                            crate::cache_creation_forensics::build_cache_break_gap_report(&dir, &opts, min_cc, now)
                        })
                        .await
                        .map_err(|e| format!("cache-break gap report join failed: {e}"))?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_window_eta" => {
                        // Same shape as get_account_burners — the two tools SHARE their attribution
                        // rule and capacity resolver by design, so they read the same timeline, the
                        // same event stream and the same observed table. The default spec differs:
                        // 'current' here (how long have I got?) vs 'previous' there (who burned it?).
                        let now = crate::now_ms() as f64;
                        // TRDD-QE114936: the one long guard is SPLIT rather than kept and wrapped.
                        // `summary_now` takes the same non-reentrant lock, so it can only be called
                        // with no guard live — and splitting also lifts `read_account_segments`
                        // (a file read) out from under the lock, and skips the summary entirely on
                        // the two error arms below, which never look at it.
                        let timeline_path = {
                            let st = state.lock_timed();
                            crate::account_state_timeline::account_state_timeline_path(&st.data_dir)
                        };
                        let segments = crate::account_burners::read_account_segments(&timeline_path);
                        let payload = if segments.is_empty() {
                            crate::mcp_tools::error_payload(
                                "No account-state timeline yet (~/.agentlens/account-state.ndjson) — nothing to project against.",
                            )
                        } else {
                            let spec = args.get("account").and_then(Value::as_str).unwrap_or("current");
                            match crate::account_burners::resolve_target_account(&segments, spec, now) {
                                None => crate::mcp_tools::error_payload(&format!(
                                    "No account matches '{spec}'. Known: {}",
                                    crate::account_burners::known_accounts(&segments)
                                )),
                                Some(target) => {
                                    let (_, summary) = summary_now(&state, now);
                                    let sessions: Vec<Value> =
                                        summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                                    let events = crate::burn::monitor::gather_consumption_events(&sessions, &[], now);
                                    let rate_window_ms =
                                        args.get("rate_window_min").and_then(Value::as_f64).unwrap_or(30.0).max(1.0) * 60_000.0;
                                    let observed = {
                                        let st = state.lock_timed();
                                        st.burn.config.observed.clone()
                                    };
                                    crate::window_eta::build_window_eta_report(&crate::window_eta::WindowEtaOpts {
                                        events: &events,
                                        target: &target,
                                        all_segments: &segments,
                                        now_ms: now,
                                        rate_window_ms,
                                        observed: &observed,
                                    })
                                }
                            }
                        };
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_account_burners" => {
                        // Pure once the inputs are gathered (no transcript reparse), so it runs on
                        // this thread rather than on spawn_blocking — but NOT under one long guard
                        // any more (TRDD-QE114936): the gather runs with the lock released.
                        //
                        // Every early return is an ERROR THAT NAMES ITSELF: an empty timeline and
                        // an unmatched account produce different messages, and the unmatched one
                        // lists the accounts it DOES know — a bare null would send the caller
                        // hunting for a bug in the tool instead of fixing the argument.
                        let now = crate::now_ms() as f64;
                        // TRDD-QE114936: same split as get_window_eta above — `summary_now` needs
                        // no guard live, the segment file read leaves the lock, and the error arms
                        // never pay for a summary they do not read.
                        let timeline_path = {
                            let st = state.lock_timed();
                            crate::account_state_timeline::account_state_timeline_path(&st.data_dir)
                        };
                        let segments = crate::account_burners::read_account_segments(&timeline_path);
                        let payload = if segments.is_empty() {
                            crate::mcp_tools::error_payload(
                                "No account-state timeline yet (~/.agentlens/account-state.ndjson) — the server records it on account changes; nothing to attribute against.",
                            )
                        } else {
                            let spec = args.get("account").and_then(Value::as_str).unwrap_or("previous");
                            match crate::account_burners::resolve_target_account(&segments, spec, now) {
                                None => crate::mcp_tools::error_payload(&format!(
                                    "No account matches '{spec}' in the timeline. Known: {}",
                                    crate::account_burners::known_accounts(&segments)
                                )),
                                Some(target) => {
                                    let interval = args.get("interval").and_then(Value::as_str).unwrap_or("last");
                                    let (until_ms, err) = crate::account_burners::resolve_window_until(interval, &target, now);
                                    match err {
                                        Some(e) => crate::mcp_tools::error_payload(&e),
                                        None => {
                                            let (_, summary) = summary_now(&state, now);
                                            let sessions: Vec<Value> =
                                                summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                                            let events = crate::burn::monitor::gather_consumption_events(&sessions, &[], now);
                                            // The TS hands only these four card fields through, and
                                            // passing the whole card instead would let a future field
                                            // shadow an event's own workspace.
                                            let cards: Vec<Value> = sessions
                                                .iter()
                                                .map(|s| {
                                                    let mut m = serde_json::Map::new();
                                                    for k in ["sessionId", "workspace", "source", "model"] {
                                                        if let Some(v) = s.get(k) {
                                                            m.insert(k.to_owned(), v.clone());
                                                        }
                                                    }
                                                    Value::Object(m)
                                                })
                                                .collect();
                                            let limit = args.get("limit").and_then(Value::as_f64).unwrap_or(15.0).max(1.0);
                                            // `process.env.HOME ?? ''` — the burn runtime already
                                            // resolves the machine's home, so the table's `~/…`
                                            // abbreviation matches every other burn surface.
                                            let (home, observed) = {
                                                let st = state.lock_timed();
                                                (st.burn.home_dir.to_string_lossy().into_owned(), st.burn.config.observed.clone())
                                            };
                                            crate::account_burners::build_account_burners_report(&crate::account_burners::AccountBurnersOpts {
                                                events: &events,
                                                target: &target,
                                                all_segments: &segments,
                                                cards: &cards,
                                                until_ms,
                                                now_ms: now,
                                                limit,
                                                observed: &observed,
                                                home: &home,
                                            })
                                        }
                                    }
                                }
                            }
                        };
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_cache_risk_costs" => {
                        // Two transcript SCANS (slash commands + effort transitions) over the whole
                        // history, then up to 40 pooled sessions each costing a reparse plus a
                        // composition rebuild — all of it disk-bound, so it goes on spawn_blocking
                        // with the state lock released and re-locked PER SESSION inside
                        // `timeline_of` (the P4s rule).
                        let now = crate::now_ms();
                        // TRDD-QE114936: ONE off-lock summary read for the WHOLE handler — the
                        // session list here and every candidate's timeline inside `timeline_of`
                        // below. The lock is now taken only for the log env.
                        let (_, timeline_summary) = summary_now(&state, now as f64);
                        let sessions: Vec<Value> =
                            timeline_summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                        // TRDD-ZQQYRYBO I6c2: no TTL-context fetch here any more — the
                        // idle-break judgment now reads each gap's MEASURED write tier off the
                        // session's own timeline (cache_break.rs), not the regime right now.
                        let env = {
                            let st = state.lock_timed();
                            st.log_env.clone()
                        };
                        let (a, st2) = (args.clone(), state.clone());
                        let payload = tokio::task::spawn_blocking(move || {
                            let file_ids = crate::context_composition::list_session_file_ids(&env);
                            let dirs = agentlens_logscan::discovery::claude_projects_dirs(&env);
                            let parent_of = |sid: &str| -> Option<String> {
                                sessions
                                    .iter()
                                    .find(|s| s.get("sessionId").and_then(Value::as_str) == Some(sid))
                                    .and_then(|s| s.get("parentSessionId").and_then(Value::as_str))
                                    .map(str::to_owned)
                            };
                            let get_comp = |sid: &str| {
                                let ancestor = crate::context_composition::resolve_logged_ancestor(&env, sid, &parent_of).or_else(|| parent_of(sid));
                                crate::context_composition::build_context_composition(&env, sid, ancestor.as_deref())
                            };
                            let timeline_of = |c: &Value| -> Vec<Value> {
                                let Some(sid) = c.get("sessionId").and_then(Value::as_str) else { return Vec::new() };
                                // TRDD-MVR6PXC0: the guard covers only the cheap in-memory steps; the
                                // transcript reparse runs OUTSIDE it, on the `env` already cloned off
                                // the lock above. This site held the mutex 1,234–3,948 ms across that
                                // reparse, and the state mutex is the ingest path's mutex — a 4 s hold
                                // blocks every session posting to this server for 4 s.
                                resolve_session_card_offlock(&st2, &env, &timeline_summary, sid, now)
                                    .and_then(|c| c.get("timeline").and_then(Value::as_array).cloned())
                                    .unwrap_or_default()
                            };
                            let ctx = crate::mcp_tools::CacheRiskCtx {
                                file_ids: &file_ids,
                                dirs: &dirs,
                                get_composition: Some(&get_comp),
                                timeline_of: &timeline_of,
                                now_ms: now as f64,
                                time_budget_ms: 20_000.0,
                            };
                            crate::mcp_tools::get_cache_risk_costs(&sessions, &a, &ctx)
                        })
                        .await
                        .map_err(|e| format!("cache-risk-cost scan join failed: {e}"))?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_cache_break_report" => {
                        // Up to 20 pooled sessions, each one a transcript REPARSE plus a
                        // composition rebuild, so the whole scan goes on spawn_blocking with the
                        // state lock released and re-locked PER SESSION inside `timeline_of` — the
                        // P4s rule.
                        //
                        // The accessor is always Some here: unlike the TS embedder, which may be
                        // constructed with a null accessor, the Rust side always has the log env. A
                        // session with no reconstructable transcript still answers None one level
                        // down, which is the same signal — reported as
                        // `sessionsWithLog`/`sessionsAnalyzed`, not as a whole-tool error.
                        let now = crate::now_ms();
                        // TRDD-QE114936: this closure's `resolve_session_card` call (below) was
                        // measured live holding the state lock for 64,494 ms — the worst of the
                        // 18-site pattern (reports/trdd-qe114936/20260902_224726+0200-investigation.md)
                        // — because it rebuilt the whole-window summary INLINE, under the lock, once
                        // PER CANDIDATE. `summary_now` is read OFF the lock, ONCE, before the scan
                        // starts (cache-served under sustained ingest; `data_version` moves ~6.7×/s
                        // here, so a per-candidate re-fetch would still pay N cache lookups for no
                        // benefit) and threaded into every candidate instead. The SAME read also
                        // supplies this handler's session list, so the lock is taken only for the
                        // log env.
                        let (_, timeline_summary) = summary_now(&state, now as f64);
                        let sessions: Vec<Value> =
                            timeline_summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                        // TRDD-ZQQYRYBO I6c2: no TTL-context fetch here any more — the
                        // idle-gap judgment now reads each gap's MEASURED write tier off the
                        // session's own timeline (cache_break.rs), not the regime right now.
                        let env = {
                            let st = state.lock_timed();
                            st.log_env.clone()
                        };
                        let (a, st2) = (args.clone(), state.clone());
                        let payload = tokio::task::spawn_blocking(move || {
                            let file_ids = crate::context_composition::list_session_file_ids(&env);
                            let parent_of = |sid: &str| -> Option<String> {
                                sessions
                                    .iter()
                                    .find(|s| s.get("sessionId").and_then(Value::as_str) == Some(sid))
                                    .and_then(|s| s.get("parentSessionId").and_then(Value::as_str))
                                    .map(str::to_owned)
                            };
                            let get_comp = |sid: &str| {
                                let ancestor = crate::context_composition::resolve_logged_ancestor(&env, sid, &parent_of).or_else(|| parent_of(sid));
                                crate::context_composition::build_context_composition(&env, sid, ancestor.as_deref())
                            };
                            let timeline_of = |c: &Value| -> Vec<Value> {
                                let Some(sid) = c.get("sessionId").and_then(Value::as_str) else { return Vec::new() };
                                // TRDD-MVR6PXC0: the lock is now held only for THIS candidate's cheap
                                // in-memory steps — QE114936 took the summary rebuild out of here, and
                                // this takes the reparse out too (it runs on the `env` cloned off the
                                // lock above). Held across the reparse this site measured 1,037 and
                                // 1,274 ms; the state mutex is the ingest path's mutex, so every one
                                // of those milliseconds is blocked ingest for every posting session.
                                resolve_session_card_offlock(&st2, &env, &timeline_summary, sid, now)
                                    .and_then(|c| c.get("timeline").and_then(Value::as_array).cloned())
                                    .unwrap_or_default()
                            };
                            let ctx = crate::mcp_tools::CacheBreakReportCtx {
                                file_ids: &file_ids,
                                get_composition: Some(&get_comp),
                                timeline_of: &timeline_of,
                                now_ms: now as f64,
                                time_budget_ms: 20_000.0,
                            };
                            crate::mcp_tools::get_cache_break_report(&sessions, &a, &ctx)
                        })
                        .await
                        .map_err(|e| format!("cache-break scan join failed: {e}"))?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "check_cache_expiry" => {
                        // Every probed candidate can reparse a multi-MB transcript, so the whole
                        // scan runs on spawn_blocking with the state lock released and re-locked
                        // PER SESSION inside `timeline_of` — the P4s rule.
                        //
                        // `get_last_request_ms` is None: the bounded tail resolver (TRDD-CXPLAT01)
                        // is NOT PORTED, so this takes the TS's own documented fallback path —
                        // "without a resolver the previous reparse-per-candidate behavior is
                        // preserved unchanged" — rather than a different answer.
                        let now = crate::now_ms();
                        // Summary read OFF the lock, and the per-card clone too (TRDD-UTFVMVT8):
                        // this guard rebuilt the summary inline on a miss and then deep-cloned
                        // every card while holding the state lock — 10.2 s measured live. Only
                        // the TTL context still needs the guard.
                        let (_, summary) = summary_now(&state, now as f64);
                        let sessions: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                        let ttl = {
                            let mut st = state.lock_timed();
                            st.burn.ttl_context(now as f64)
                        };
                        let (a, st2) = (args.clone(), state.clone());
                        // TRDD-CXPLAT01: the bounded last-request resolver (standalone/server.ts:1536).
                        // Cloned OUT of the state before spawn_blocking — the closure must be 'static,
                        // and holding the state lock across a 256KB read per candidate would block
                        // every other reader for the whole scan.
                        let log_env = state.lock_timed().log_env.clone();
                        // TRDD-QE114936: `summary` (already read off-lock above) is moved into the
                        // closure and threaded into resolve_session_card, instead of it rebuilding
                        // its own copy under st2's per-candidate guard.
                        let payload = tokio::task::spawn_blocking(move || {
                            let timeline_of = |c: &Value| -> Vec<Value> {
                                let Some(sid) = c.get("sessionId").and_then(Value::as_str) else { return Vec::new() };
                                // TRDD-MVR6PXC0: same per-candidate shape as the other three scan
                                // handlers, so the same fix — the reparse runs OUTSIDE the guard, on
                                // `log_env` (already cloned off the lock for `last_request_ms` below).
                                // This site never surfaced a ≥1000 ms line in the measured window, but
                                // it probes the same multi-MB transcripts under the same mutex the
                                // ingest path takes; a hold here blocks every posting session too.
                                resolve_session_card_offlock(&st2, &log_env, &summary, sid, now)
                                    .and_then(|c| c.get("timeline").and_then(Value::as_array).cloned())
                                    .unwrap_or_default()
                            };
                            // Without this, a session idle >24h has its timeline stripped, so the
                            // probe cannot find its last api_request and answers `verdict: unknown`
                            // with a null idleMs — where the TS answers `expired` with the real
                            // timestamp. One stat + one bounded tail read per candidate, never a
                            // full reparse (measured on this machine: a cold probe read 163.6MB of
                            // JSONL synchronously; the tails total ~1.5MB).
                            let last_request_ms = |sid: &str| -> Option<f64> {
                                let p = crate::log_reader::transcript_path_for(&log_env, sid)?;
                                crate::burn::agent_gate::read_transcript_context(
                                    &p,
                                    now as f64,
                                    crate::burn::agent_gate::TRANSCRIPT_TAIL_BYTES,
                                )
                                .get("lastRequestAtMs")
                                .and_then(Value::as_f64)
                            };
                            crate::mcp_tools::check_cache_expiry(
                                &sessions,
                                &timeline_of,
                                Some(&ttl),
                                &a,
                                now as f64,
                                20_000.0,
                                Some(&last_request_ms),
                            )
                        })
                        .await
                        .map_err(|e| format!("cache-expiry scan join failed: {e}"))?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_account_status" => {
                        // The TS `all: true` form calls listAllAccounts() — the on-disk roster +
                        // per-account usage archive, which needs NONE of the live accessors and so
                        // works with the server cold. NOT PORTED, so it says so by name rather
                        // than quietly answering the singular question instead.
                        if args.get("all") == Some(&Value::Bool(true)) {
                            crate::mcp::not_implemented(&id, "get_account_status(all: true)")
                        } else {
                            let now = crate::now_ms() as f64;
                            // TRDD-XX1UAZHS: compute off the lock, hold only for account + TTL.
                            let status = burn_status_now(&state, now);
                            let mut st = state.lock_timed();
                            let account = st.burn.current_account(now);
                            let ttl = st.burn.ttl_context(now);
                            drop(st);
                            // rate_limits is None: the statusline reader is NOT PORTED (the same
                            // gap live_burn_status documents), so `windowSource` reports
                            // calibrated/none instead of cc-rate-limits — visible, not silent.
                            let payload = crate::mcp_tools::get_account_status(Some(&account), Some(&status), Some(&ttl), None);
                            crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                        }
                    }
                    "check_burn_risk" => {
                        // Pass-through: the risk report IS the payload. The two threshold args are
                        // the ONLY place they are caller-settable; `check_burn_risk` floors both
                        // (2 / 10k) so a caller cannot switch a risk row off by asking.
                        let now = crate::now_ms() as f64;
                        let n = |k: &str| args.get(k).and_then(Value::as_f64);
                        // TRDD-QE114936 site 20 — see the `/api/burn-risk` route: off the lock,
                        // and only when the tick has not stored a status yet.
                        let seed = burn_status_seed(&state, now);
                        let mut st = state.lock_timed();
                        let payload = st.burn_risk_report(now, seed, n("fanoutThreshold"), n("spikeTokensPerMin"));
                        drop(st);
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_lifecycle_events" => {
                        let n = |k: &str| args.get(k).and_then(Value::as_f64);
                        let limit = n("limit").filter(|v| *v > 0.0).unwrap_or(100.0) as usize;
                        let kinds: Option<Vec<String>> = args
                            .get("kinds")
                            .and_then(Value::as_array)
                            .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect());
                        let session = s("session");
                        // `window` is HOURS back; absent means no lower bound at all, NOT zero —
                        // `since_ms: Some(0.0)` would read the same records but claim a bound.
                        let since_ms = n("window").map(|h| crate::now_ms() - (h * 3_600_000.0) as i64);
                        let (dir, records) = {
                            let st = state.lock_timed();
                            let dir = st.data_dir.join("hook-events");
                            let records = crate::hook_events::read_hook_events(
                                &dir,
                                &crate::hook_events::HookEventFilter {
                                    session: session.as_deref(),
                                    since_ms,
                                    limit: Some(1000),
                                    ..Default::default()
                                },
                            );
                            (dir, records)
                        };
                        let dir_exists = std::fs::metadata(&dir).is_ok();
                        let events = crate::hook_events::extract_lifecycle_events(&records, kinds.as_deref(), session.as_deref(), limit);
                        let payload = crate::mcp_tools::get_lifecycle_events(&dir.to_string_lossy(), dir_exists, events);
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_context_composition" | "get_context_history" | "get_conversation" => {
                        let session_id = s("sessionId").unwrap_or_default();
                        let n = |k: &str| args.get(k).and_then(Value::as_f64);
                        // The card's model is needed ONLY by get_context_history, and only for its
                        // costUsd — see step_cost: the TS prices from the CARD's model, never the
                        // step's.
                        // TRDD-QE114936: the summary is read OFF the lock, and only on the ONE
                        // branch that needs it — the other two tools never read a card model, so
                        // they must not pay for a summary read at all.
                        let card_model = if name == "get_context_history" {
                            let (_, summary) = summary_now(&state, crate::now_ms() as f64);
                            summary
                                .get("sessions")
                                .and_then(Value::as_array)
                                .and_then(|ss| ss.iter().find(|c| c.get("sessionId").and_then(Value::as_str) == Some(session_id.as_str())))
                                .and_then(|c| c.get("model").and_then(Value::as_str))
                                .map(str::to_owned)
                        } else {
                            None
                        };
                        let env = state.lock_timed().log_env.clone();
                        let sid = session_id.clone();
                        let tool = name.clone();
                        // Streaming a transcript is blocking, multi-GB-capable work — off the
                        // executor and never under the lock.
                        let engine = tokio::task::spawn_blocking(move || match tool.as_str() {
                            "get_context_composition" => crate::context_composition::build_context_composition(&env, &sid, None),
                            "get_context_history" => crate::context_history::build_context_history(&env, &sid, None),
                            _ => crate::conversation::build_conversation(&env, &sid, None),
                        })
                        .await
                        .map_err(|e| format!("{name} build join failed: {e}"))?
                        .unwrap_or(Value::Null);
                        let payload = match name.as_str() {
                            "get_context_composition" => {
                                crate::mcp_tools::get_context_composition(Some(&engine), &session_id, n("turn"))
                            }
                            "get_context_history" => crate::mcp_tools::get_context_history(
                                Some(&engine),
                                card_model.as_deref(),
                                &session_id,
                                n("turn"),
                                s("blockId").as_deref(),
                                crate::now_ms() as f64,
                            ),
                            _ => crate::mcp_tools::get_conversation(
                                Some(&engine),
                                &session_id,
                                n("turn"),
                                n("turnFrom"),
                                n("turnTo"),
                            ),
                        };
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    // Every other frozen tool is still served by the TypeScript MCP server, and
                    // says so by name rather than answering emptily.
                    other => crate::mcp::not_implemented(&id, other),
                }
            }
        };
        json_response(StatusCode::OK, reply.to_string())
    } else if method == Method::GET && path.starts_with("/api/callcontext/") {
        // Row 35 (server.ts:4161) — the LAST HTTP row. The full literal context of ONE llm call,
        // rebuilt from the raw OTEL request body. `callContext: null` means no body was captured
        // for that call; the client renders an honest "not captured" note, never a spinner.
        //
        // LOCK CHOREOGRAPHY (the P4s rule): the registry lookup is cheap and in-memory, so it runs
        // UNDER the lock and the POINTER IS CLONED OUT. The multi-MB body read/parse then happens
        // with the lock RELEASED, and the lock is re-taken only for the account backfill.
        let rest = &path["/api/callcontext/".len()..];
        let mut segs = rest.splitn(2, '/');
        let session_id = percent_decode(segs.next().unwrap_or(""));
        // `parts[1] ? decode(parts[1]) : undefined` — TRUTHY, so an EMPTY second segment is
        // undefined, not "".
        let request_id = segs.next().filter(|s| !s.is_empty()).map(percent_decode);
        let span_id = query_of(&req).get("span").filter(|s| !s.is_empty()).cloned();

        let call_context =
            resolve_call_context(&state, &session_id, request_id.as_deref(), span_id.as_deref()).await?;
        json_response(StatusCode::OK, serde_json::json!({ "callContext": call_context }).to_string())
    } else if method == Method::GET && path.starts_with("/api/conversation/") {
        // Row 34 (server.ts:4271). The narrative reconstruction — same streaming discipline and
        // same `{x: null}`-is-a-valid-200 contract as rows 32-33.
        let session_id = percent_decode(&path["/api/conversation/".len()..]);
        let parent = query_of(&req).get("parent").map(|s| s.to_owned()).filter(|s| !s.is_empty());
        let env = {
            let st = state.lock_timed();
            st.log_env.clone()
        };
        let conversation = tokio::task::spawn_blocking(move || {
            crate::conversation::build_conversation(&env, &session_id, parent.as_deref())
        })
        .await
        .map_err(|e| format!("conversation build join failed: {e}"))?;
        json_response(
            StatusCode::OK,
            serde_json::json!({ "conversation": conversation.unwrap_or(Value::Null) }).to_string(),
        )
    } else if method == Method::GET && path.starts_with("/api/composition-index/") {
        // Row 36 (server.ts:4193). Per-session composition summary, parsed on demand from the live
        // registry (never a background sweep) and LRU-cached. A session with no captured raw bodies
        // returns an HONEST empty summary carrying a coverageNote — never a spinner, never an error.
        //
        // NOT PORTED: the TS `heavyGuard` admission deferral. It exists to keep concurrent heavy
        // parses from blowing the V8 heap; this core has no V8 heap to guard, and the work is
        // already off the executor via spawn_blocking.
        //
        // LOCK CHOREOGRAPHY (the P4s rule, and the whole reason this route is shaped this way):
        // resolve refs UNDER the lock (cheap, in-memory), then RELEASE it before parsing body
        // files, then re-take it only to store the result. Parsing a multi-MB body while holding
        // CoreState would stall every other request on the server.
        let session_id = percent_decode(&path["/api/composition-index/".len()..]);
        let now = crate::now_ms() as f64;
        let (_, comp_summary) = summary_now(&state, now);
        let comp_projects = crate::composition_project_map(&comp_summary);
        let comp = composition_for(&state, &session_id, now, &comp_projects).await?;
        let summary = crate::context_composition_index::session_composition_summary(&comp);
        json_response(StatusCode::OK, serde_json::json!({ "summary": summary }).to_string())
    } else if method == Method::GET && path.starts_with("/api/block-content/") {
        // Row 37 (server.ts:4212): drill ONE block to its real content. An IMAGE returns metadata
        // + a body-file ref ONLY — never the base64 bytes (pointer-only).
        let parts: Vec<&str> = path["/api/block-content/".len()..].split('/').collect();
        let session_id = percent_decode(parts.first().unwrap_or(&""));
        // `Number(parts[i])`: a MISSING segment is NaN → 400, but an EMPTY one is 0 and passes,
        // because `Number('') === 0`. Mirrored deliberately — `"".parse()` would reject it and
        // turn a request the TS answers 200 into a 400.
        let js_number = |s: Option<&&str>| -> Option<f64> {
            match s {
                None => None,
                Some(v) if v.trim().is_empty() => Some(0.0),
                Some(v) => v.trim().parse::<f64>().ok().filter(|n| n.is_finite()),
            }
        };
        let turn = js_number(parts.get(1));
        let block_index = js_number(parts.get(2));
        let full = query_of(&req).get("full").map(String::as_str) == Some("1");
        match (session_id.is_empty(), turn, block_index) {
            (false, Some(t), Some(bi)) => {
                let block = resolve_block_content(&state, &session_id, t, bi, full).await?;
                json_response(StatusCode::OK, serde_json::json!({ "block": block }).to_string())
            }
            _ => json_response(
                StatusCode::BAD_REQUEST,
                serde_json::json!({ "block": Value::Null, "error": "bad sessionId/turn/blockIndex" }).to_string(),
            ),
        }
    } else if method == Method::GET && path.starts_with("/api/timeline/") {
        // Row 30 (server.ts:4044): the lazy per-session detail — resolveSessionCard's
        // reparse-on-demand for a disk-restored stripped card, plus the TRDD-5GFSFX0Q graft of
        // the OTEL api_request attribution a log-winning Claude card lacks. Always 200; an
        // unknown id serves the empty shape. generatedFiles rides THIS payload only —
        // strip_session_detail drops it from /api/summary (TRDD-ZS1GDXVY).
        let session_id = percent_decode(&path["/api/timeline/".len()..]);
        let now = crate::now_ms();
        // TRDD-QE114936: summary read OFF the lock before the guard below, instead of
        // resolve_session_card rebuilding it inline while holding `st`.
        let (_, summary) = summary_now(&state, now as f64);
        let body = {
            let mut st = state.lock_timed();
            let session = resolve_session_card(&mut st, &summary, &session_id, now);
            // `session?.<k> ?? <default>` — nullish: an explicit null falls back too.
            let field = |k: &str, default: Value| {
                session.as_ref().and_then(|s| s.get(k)).filter(|v| !v.is_null()).cloned().unwrap_or(default)
            };
            serde_json::json!({
                "timeline": field("timeline", Value::Array(Vec::new())),
                "fileOps": field("fileOps", Value::Array(Vec::new())),
                "generatedFiles": field("generatedFiles", Value::Array(Vec::new())),
                "generatedFilesTruncated": field("generatedFilesTruncated", Value::Bool(false)),
            })
            .to_string()
        };
        json_response(StatusCode::OK, body)
    } else {
        // The dashboard shell and its assets (server.ts:4407-4439). Neither TS branch checks the
        // method, so neither does this one; the CSRF/viewer gates above already ran.
        let media_dir = state.lock_timed().media_dir.clone();
        let served = match media_dir {
            Some(dir) if path == "/" || path == "/index.html" => {
                Some(dashboard_html(&state, &dir, viewer_role == crate::embed_auth::ViewerRole::Restricted)?)
            }
            Some(dir) => static_asset(&dir, &path),
            None => None,
        };
        match served {
            Some(r) => r,
            None => {
                let mut r = Response::new(boxed_full(Bytes::from_static(b"Not found")));
                *r.status_mut() = StatusCode::NOT_FOUND;
                r
            }
        }
    };

    // setAllowedOriginCors — runs in the preamble for every response, 403s and 404s included.
    if let Some(o) = origin.as_deref().filter(|o| !o.is_empty()) {
        if !disallowed {
            if let Ok(v) = hyper::header::HeaderValue::from_str(o) {
                resp.headers_mut().insert("Access-Control-Allow-Origin", v);
                resp.headers_mut().insert("Vary", hyper::header::HeaderValue::from_static("Origin"));
            }
        }
    }
    // serverRuntime.ts requestLog — one row per request, recorded at response construction (the
    // TS records at socket finish; for a full body the two agree, for the SSE stream this counts
    // the connect frame rather than the lifetime bytes — a debug diagnostic, noted, not frozen).
    {
        use hyper::body::Body;
        let bytes = resp.body().size_hint().exact().unwrap_or(0);
        {
            let mut st = state.lock_timed();
            let dur = t0.elapsed().as_millis() as i64;
            st.requests.record(method.as_str(), &path, resp.status().as_u16(), dur, bytes, crate::now_ms());
        }
    }
    Ok(resp)
}

/// Serve the UI/API contract on `addr` until the process ends. `hub` is the SSE fan-out the
/// coalesced pusher (`push_update`) broadcasts into.
/// The DEDICATED MCP listener (`startMcpHttpServer`, src/mcpServer.ts:4020) — the port a Claude
/// Code MCP config actually points at.
///
/// WHY A SECOND LISTENER AT ALL, when `/mcp` is already routed on the UI listener: at the D1
/// cutover alcore replaces the TS server, and every client configured for the MCP port would
/// otherwise find nothing there. Reporting the truth instead ("MCP is on the UI port") is not an
/// equivalent fix — it still breaks every already-configured client. So this is a D1 PREREQUISITE,
/// not a tidy-up.
///
/// It delegates to the SAME `handle`, so there is exactly one implementation of the 53 tools and
/// one viewer-role gate. The wrapper only NARROWS the surface to what the TS's dedicated server
/// exposes — OPTIONS, and POST /mcp — because that server routes nothing else. Serving the whole
/// API here instead would be a superset of the TS's surface on a port clients treat as MCP-only.
pub async fn serve_mcp(
    addr: std::net::SocketAddr,
    state: Arc<Mutex<CoreState>>,
    hub: Arc<SseHub>,
    on_bound: impl FnOnce(std::net::SocketAddr),
) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    on_bound(listener.local_addr()?);
    loop {
        let (stream, _) = listener.accept().await?;
        let io = hyper_util::rt::TokioIo::new(stream);
        let (state, hub) = (state.clone(), hub.clone());
        tokio::spawn(async move {
            let svc = service_fn(move |req: Request<hyper::body::Incoming>| {
                let (state, hub) = (state.clone(), hub.clone());
                async move {
                    let (method, path) = (req.method().clone(), req.uri().path().to_owned());
                    if method == Method::OPTIONS {
                        // Preflight, answered before anything else — as the TS does.
                        //
                        // IT MUST CARRY THE CORS HEADERS ITSELF (TRDD-465EXTJ6). This used to
                        // return a bare 204 and note that "the CORS headers are added by
                        // `handle`'s preamble for real requests" — true, and precisely the bug:
                        // a preflight never reaches that preamble, so the browser got NO
                        // Access-Control-Allow-Origin and the actual request was never sent. Same
                        // scoped policy as the preamble: echo an allowed origin, send NOTHING for
                        // a disallowed one, never the wildcard (TRDD-F6BM1BDI).
                        let origin = req.headers().get("origin").and_then(|v| v.to_str().ok()).map(str::to_owned);
                        let host = req.headers().get("host").and_then(|v| v.to_str().ok()).map(str::to_owned);
                        let mut r = Response::new(boxed_full(Bytes::new()));
                        *r.status_mut() = StatusCode::NO_CONTENT;
                        if let Some(o) = origin.as_deref().filter(|o| !o.is_empty()) {
                            if !is_disallowed_cross_origin(Some(o), host.as_deref()) {
                                if let Ok(v) = hyper::header::HeaderValue::from_str(o) {
                                    r.headers_mut().insert("Access-Control-Allow-Origin", v);
                                    r.headers_mut().insert("Vary", hyper::header::HeaderValue::from_static("Origin"));
                                    r.headers_mut().insert("Access-Control-Allow-Methods", hyper::header::HeaderValue::from_static("GET, POST, OPTIONS"));
                                    r.headers_mut().insert("Access-Control-Allow-Headers", hyper::header::HeaderValue::from_static("Content-Type"));
                                }
                            }
                        }
                        return Ok::<_, String>(r);
                    }
                    // GET is the plain health check (mcpServer.ts handleMcpRequest); POST is the
                    // JSON-RPC tool endpoint. Both, and only those, route to the shared `handle`.
                    if !(path == "/mcp" && (method == Method::POST || method == Method::GET)) {
                        let mut r = Response::new(boxed_full(Bytes::from_static(b"Not found")));
                        *r.status_mut() = StatusCode::NOT_FOUND;
                        return Ok(r);
                    }
                    handle(req, state, hub).await
                }
            });
            let _ = hyper::server::conn::http1::Builder::new().serve_connection(io, svc).await;
        });
    }
}

pub async fn serve_ui(
    addr: std::net::SocketAddr,
    state: Arc<Mutex<CoreState>>,
    hub: Arc<SseHub>,
    on_bound: impl FnOnce(std::net::SocketAddr),
) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    on_bound(listener.local_addr()?);
    loop {
        let (stream, _) = listener.accept().await?;
        let io = hyper_util::rt::TokioIo::new(stream);
        let (state, hub) = (state.clone(), hub.clone());
        tokio::spawn(async move {
            let svc = service_fn(move |req| handle(req, state.clone(), hub.clone()));
            let _ = hyper::server::conn::http1::Builder::new().serve_connection(io, svc).await;
        });
    }
}

/// The burn SSE tick (server.ts tickBurn, 4s cadence): compute the burn status, store it as
/// `burn.last_status` (the TTL usage-credit signal + the P4r.4 burn-risk hot path read it),
/// push a `burnStatus` frame, and push each NEW alert once until its condition clears
/// (`firedBurnAlerts` dedupe). It also samples the account-state timeline (TRDD-YQZ9P8IL),
/// fires `mac_notify` for each newly-fired alert, and detects the account-ROTATION edge — the one
/// moment a non-live account's rate-limit windows can be read at all.
/// server.ts macNotify — a macOS notification banner for a burn alert, opt-in via
/// `AGENTLENS_NOTIFY=1` / `notify: true` in the burn config.
///
/// Fire-and-forget by design: the TS passes an empty callback, so a missing or failing
/// `osascript` is silently nothing. Escaping `"` and `\` is not cosmetic — the alert text is
/// interpolated into an AppleScript string literal, and an unescaped quote there does not merely
/// garble the banner, it changes what osascript executes.
///
/// ONE DELIBERATE DIVERGENCE FROM THE TS, on the safe side. The TS escapes and THEN slices to 240
/// (`s.replace(/["\\]/g, '\\$&').slice(0, 240)`), so a cut landing between a backslash and the
/// character it escapes emits a DANGLING escape into the script. Truncating first and escaping
/// after cannot produce one. The visible result is the same banner for every input that is not
/// pathological; reproducing the TS byte-for-byte here would mean reproducing an injection edge
/// on the one path in this function that has security consequences.
fn mac_notify(enabled: bool, label: &str, detail: &str) {
    if !enabled || !cfg!(target_os = "macos") {
        return;
    }
    let esc = |s: &str| -> String {
        s.chars().take(240).flat_map(|c| if c == '"' || c == '\\' { vec!['\\', c] } else { vec![c] }).collect()
    };
    let script = format!("display notification \"{}\" with title \"AgentLens: {}\"", esc(detail), esc(label));
    // spawn(), not output(): waiting on osascript would stall the 4s tick behind a UI call. The
    // reaper thread is not optional — a dropped `Child` is never waited on, so without it every
    // alert leaves a zombie for the life of the process.
    if let Ok(mut child) = std::process::Command::new("osascript").arg("-e").arg(script).spawn() {
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
}

pub async fn run_burn_tick(state: Arc<Mutex<CoreState>>, hub: Arc<SseHub>) {
    let mut fired: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(4));
    loop {
        tick.tick().await;
        let mut frames: Vec<String> = Vec::new();
        // TRDD-HFV4AIT7: build the summary BEFORE taking the lock. This tick fired every 4 s on
        // every install, with or without a dashboard connected, and `live_burn_status` rebuilt the
        // whole window inside the lock — the single biggest source of the 83k `__psynch_mutexwait`
        // samples under an ingest flood. `burn_status_over` below now gets a ready summary.
        let tick_summary = burn_summary_now(&state);
        // Declared OUTSIDE the lock blocks (uninitialized — the only paths that skip the
        // assignment are the `continue`s below, which also skip every read): the rotation edge is
        // detected under the lock, and the capture it triggers runs after the lock is released.
        let rotation_capture: Option<(
            std::path::PathBuf,
            std::path::PathBuf,
            std::collections::HashMap<String, String>,
        )>;
        let now = crate::now_ms() as f64;
        // TRDD-O3ICDRLO: the lock is taken TWICE, briefly, around an OFF-lock compute. The guard's
        // per-statement split (41 holds over 2h49m on pid 71093) put 96% of its lock time —
        // 25.8 of 26.9 s, max 1.5 s inside one 4 s tick — in `burn_status_over`, whose gather +
        // compute needs nothing the lock protects beyond a TTL snapshot and the config; the bodies
        // poll, the WAL flush and the timeline sample together never reached 50 ms. So the first
        // hold snapshots those two inputs, the status is computed with the lock RELEASED, and the
        // second hold stores it and does the rest. Every ingest and read path was queued behind
        // that 1.5 s four times a minute — do not fold the compute back under either guard.
        let (ttl, config, t_flush, held_a, bodies_in_flight) = {
            let mut st = state.lock_timed();
            let t0 = std::time::Instant::now();
            // TRDD-H3D5ZBO1: the bodies scan is NOT run here. Its first pass after boot held this
            // lock for 534-588 s; it runs in a blocking task started below that takes the lock
            // only for the merge. The gate and the risk report read the last merged result.
            let bodies_in_flight = st.burn.bodies.in_flight_handle();
            // The statusline WAL flush (the TS runs a dedicated 5s timer; this 4s tick gives
            // the same ≤5s durability window with one fewer task). Sealing is NOT here — it
            // runs DuckDB over whole WALs and lives on alcore's own 60s task, outside the lock.
            st.statusline.flush(None);
            let t_flush = t0.elapsed();
            let ttl = st.burn.ttl_context(now);
            (ttl, st.burn.config.clone(), t_flush, t0.elapsed(), bodies_in_flight)
        };
        // The bodies watcher's cadence (the TS runs a dedicated 5s timer; this 4s tick gives the
        // same ≤5s staleness with one fewer task). Fire-and-forget and never awaited: a scan that
        // outlasts the tick must not stall it, and `in_flight` stops the next tick stacking a
        // second one. The task's own compare_exchange is the authority; this load only skips a
        // pointless spawn.
        if !bodies_in_flight.load(std::sync::atomic::Ordering::Acquire) {
            let scan_state = state.clone();
            tokio::task::spawn_blocking(move || crate::burn::bodies_activity::run_bodies_scan(&scan_state));
        }
        let t_off = std::time::Instant::now();
        let status = crate::burn_status_for(&tick_summary, &config, &ttl, now);
        let off_lock = t_off.elapsed();
        // TRDD-2JOIAH2G: release the summary `Arc` the moment its last use is done (`status` is
        // owned, nothing borrows from it). Held to the end of the tick, it made the previous
        // summary shared whenever a rebuild landed in that window, so `take_sessions`
        // (summary_engine.rs) deep-copied the whole sessions array (rig: +1 shared copy at +116 s).
        drop(tick_summary);
        {
            let mut st = state.lock_timed();
            let t1 = std::time::Instant::now();
            st.burn.last_status = Some(status.clone());
            let account = st.burn.current_account(now);
            // TRDD-YQZ9P8IL: sample the subscription state onto the change-detected timeline.
            // `record` only enqueues on a discrete change (account/mode/plan/ttl), so this 4s call
            // is a key comparison in the common case and a real write a few times an hour — which
            // is what makes it safe on the hot tick. The flush is a 60s chore, never here.
            // Re-read here rather than reusing the snapshot above: the TS samples the TTL context
            // AFTER storing the fresh status, and `ttl_context` reads `last_status` (a cached key
            // compare, not a cost).
            let ttl_ctx = st.burn.ttl_context(now);
            let sample = crate::account_state_timeline::build_account_state_record(Some(&account), Some(&ttl_ctx), now);
            st.account_timeline.record(sample);
            let t_account = t1.elapsed();
            let notify = st.burn.config.notify;
            // The rotation EDGE (server.ts:1656). Detected under the lock (a string compare), acted
            // on outside it — the refresh does network I/O and must never stall the 4s tick or hold
            // the state mutex across it.
            let rotated = st.burn.last_seen_account_uuid.as_deref() != account.account_uuid.as_deref();
            if rotated {
                st.burn.last_seen_account_uuid = account.account_uuid.clone();
            }
            rotation_capture = rotated.then(|| (st.data_dir.clone(), st.burn.home_dir.clone(), st.burn.vars.clone()));
            let enriched = crate::burn::runtime::enrich_burn_status(&status, &account, &st.latest_resident_blobs);
            frames.push(serde_json::json!({ "type": "burnStatus", "burnStatus": enriched }).to_string());
            let mut active: std::collections::HashSet<String> = std::collections::HashSet::new();
            if let Some(alerts) = status.get("alerts").and_then(Value::as_array) {
                for a in alerts {
                    let id = a.get("id").and_then(Value::as_str).unwrap_or("").to_owned();
                    active.insert(id.clone());
                    if fired.insert(id) {
                        frames.push(
                            serde_json::json!({ "type": "alert", "label": a["label"], "detail": a["detail"], "severity": a["severity"] })
                                .to_string(),
                        );
                        // server.ts macNotify — the desktop banner for an alert that JUST fired.
                        // Inside the `fired.insert` guard on purpose: once per condition, not once
                        // per 4s tick for as long as the condition holds.
                        mac_notify(
                            notify,
                            a.get("label").and_then(Value::as_str).unwrap_or(""),
                            a.get("detail").and_then(Value::as_str).unwrap_or(""),
                        );
                    }
                }
            }
            // Clear fired keys whose condition cleared so the alert can re-fire if it returns.
            fired.retain(|id| active.contains(id));
            let held_b = t1.elapsed();
            // Printed beside the `held` line(s) at the same threshold, one line for both holds plus
            // the off-lock compute, so a regression that drags work back under a guard is named by
            // the statement group, not inferred from the site.
            let threshold = std::time::Duration::from_millis(crate::lock_trace_threshold_ms());
            if held_a >= threshold || held_b >= threshold {
                eprintln!(
                    "{} alcore: burn tick guard split: lock_a {} ms (statusline_flush {} ms, ttl_config {} ms), off_lock burn_status {} ms, lock_b {} ms (account_timeline {} ms, alerts_notify {} ms)",
                    crate::log_ts(),
                    held_a.as_millis(),
                    t_flush.as_millis(),
                    (held_a - t_flush).as_millis(),
                    off_lock.as_millis(),
                    held_b.as_millis(),
                    t_account.as_millis(),
                    (held_b - t_account).as_millis()
                );
            }
        }
        if let Some((data_dir, home, vars)) = rotation_capture {
            // Fire-and-forget on the blocking pool, exactly as the TS's `void refreshAccountUsage()`
            // is fire-and-forget: capturing the window is best-effort, and a failure must not
            // disturb the tick. `force: true` bypasses the freshness TTL on purpose — the cached
            // row belongs to the PREVIOUS account, and serving it here is the failure this edge
            // exists to prevent. The cooldown and the cross-process lock still apply inside.
            tokio::task::spawn_blocking(move || {
                // CLAUDE_CONFIG_DIR, not a bare `None`: with the var set, `None` would read
                // `~/.claude/.credentials.json` — a file belonging to a different install — and
                // report a confident answer about the wrong account.
                let cfg_dir = vars.get("CLAUDE_CONFIG_DIR").map(std::path::PathBuf::from);
                let loaded = crate::subscription_usage::load_token(
                    cfg_dir.as_deref(),
                    &home,
                    false,
                    crate::subscription_usage::keychain_read_allowed(&data_dir, &vars),
                    cfg!(target_os = "macos"),
                );
                let no_keychain = || None;
                let claimed = crate::burn::account_info::get_current_account(&home, &vars, Some(&no_keychain)).email;
                let u = crate::subscription_usage::get_subscription_usage(
                    &crate::subscription_usage::UsagePaths::under(&data_dir),
                    &loaded,
                    crate::now_ms() as f64,
                    true,
                    claimed.as_deref(),
                    &crate::subscription_usage::live_fetch_usage,
                    &crate::subscription_usage::live_fetch_identity,
                );
                // Log EVERY outcome, not just success (server.ts:977's own lesson): a refusal and a
                // timer that never fired look identical in a log that only records `ok`.
                let reason = u
                    .as_ref()
                    .and_then(|v| v.get("reason").and_then(Value::as_str))
                    .unwrap_or("no-result")
                    .to_owned();
                eprintln!("{} alcore: usage refresh (account changed): {reason}", crate::log_ts());
            });
        }
        if hub.client_count() > 0 {
            for f in &frames {
                hub.broadcast(sse_frame(f));
            }
        }
    }
}

/// The coalesced aggregate push (server.ts schedulePushUpdate): a tick every PUSH_COALESCE_MS
/// that rebuilds ONCE when the data version moved since the last push. Trailing-edge by
/// construction — a burst of ingest lands at most one rebuild per window.
pub async fn run_push_loop(state: Arc<Mutex<CoreState>>, hub: Arc<SseHub>) {
    let mut last_pushed: u64 = 0;
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(PUSH_COALESCE_MS));
    loop {
        tick.tick().await;
        let version = state.lock_timed().data_version;
        if version != last_pushed {
            last_pushed = version;
            // push_update does the rebuild + the payload assembly off the lock (summary_now); the
            // sequential loop is what keeps a single rebuild in flight — a tick that fires while
            // one is running simply finds the memo current when it gets there.
            push_update(&state, &hub, crate::now_ms() as f64);
        }
    }
}

/// TRDD-2R36W8Q1: a reader must NOT block behind an in-flight summary rebuild.
///
/// These live in-file because the discriminator is the private `rebuild_gate()`. The property is
/// "a reader whose cache missed returns immediately while a rebuild is running", and the only way
/// to test that deterministically is to HOLD the gate — a timing race against a real rebuild would
/// be flaky, and a flaky guard on a livelock is worse than none.
///
/// MUTATION CHECK (do this if you touch `summary_now`): change the `try_lock` admission back to
/// `rebuild_gate().lock()` and `reader_does_not_block_behind_an_in_flight_rebuild` MUST hang (the
/// harness will time it out) rather than pass. A test that still passes with the blocking
/// admission reinstated is guarding nothing.
#[cfg(test)]
mod rebuild_admission_tests {
    use std::sync::atomic::Ordering;
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use super::{rebuild_gate, rebuild_once, summary_now, READER_WAITING, REBUILDER_ACTIVE, STALE_BUDGET_MS};
    use crate::{CoreState, LockTimed};

    /// `REBUILDER_ACTIVE` is process-global and cargo runs these tests on parallel threads, so a
    /// test that flips it would otherwise change the behaviour under a test that assumes it clear
    /// — specifically `an_uncontended_reader_gets_fresh_data_not_stale`, whose whole assertion is
    /// that an uncontended reader BUILDS. Every test that reads or writes the flag takes this
    /// first, which is cheaper and far more obvious than making the flag injectable through a
    /// function that has a dozen call sites.
    fn serial() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(())).lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Sets `REBUILDER_ACTIVE` for the life of the guard and always clears it, including on a
    /// panicking assertion — a leaked `true` would make later runs of the sibling tests fail for a
    /// reason that has nothing to do with them.
    struct RebuilderActive {
        /// Never read — held purely so the serial lock lives exactly as long as the flag does.
        /// Underscore-named because rustc's dead-code pass does not count a Drop-only field.
        _serial: std::sync::MutexGuard<'static, ()>,
    }
    impl RebuilderActive {
        fn on() -> Self {
            let _serial = serial();
            REBUILDER_ACTIVE.store(true, std::sync::atomic::Ordering::Relaxed);
            Self { _serial }
        }
    }
    impl Drop for RebuilderActive {
        fn drop(&mut self) {
            REBUILDER_ACTIVE.store(false, std::sync::atomic::Ordering::Relaxed);
        }
    }

    fn state_with_a_warm_summary(tag: &str) -> (Arc<Mutex<CoreState>>, u64) {
        let dir = std::env::temp_dir().join(format!("al-admission-{}-{}", tag, std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = Arc::new(Mutex::new(CoreState::open(&dir)));
        let (version, _) = summary_now(&state, crate::now_ms() as f64);
        (state, version)
    }

    /// The fix. With the gate held by someone else, a cache-missing reader is answered from the
    /// last good summary instead of queueing — promptly, and with the version that summary was
    /// actually built for (never the current `data_version`, which is what keeps a derived view
    /// keyed to inputs it really derives from).
    #[test]
    fn reader_does_not_block_behind_an_in_flight_rebuild() {
        // This test HOLDS the process-global gate for the whole wait below, so any sibling that
        // `try_lock`s it meanwhile (`rebuild_once` in the wiring test) sees `WouldBlock` and reads
        // that as "someone is rebuilding". Measured 2/30 flakes at --test-threads=8 before this.
        let _serial = serial();
        let (state, warm_version) = state_with_a_warm_summary("nonblock");

        // Force the fast path to miss exactly the way sustained ingest does: bump the key.
        state.lock_timed().data_version += 1;
        let current = state.lock_timed().data_version;
        assert_ne!(current, warm_version, "the cache key must have moved, or this proves nothing");

        // Stand in for a 20-second rebuild.
        let held = rebuild_gate().lock().unwrap_or_else(|e| e.into_inner());

        let began = Instant::now();
        let (served_version, _summary) = summary_now(&state, crate::now_ms() as f64);
        let waited = began.elapsed();
        drop(held);

        assert_eq!(
            served_version, warm_version,
            "a blocked-then-fresh answer means admission still queues; the served version must be the STALE one"
        );
        assert!(
            waited < Duration::from_secs(2),
            "reader waited {waited:?} behind the gate — admission is blocking again (the 2R36W8Q1 livelock)"
        );
        // The budget must actually have been spent: an INSTANT stale answer is the regression CI
        // caught (read-your-writes broken — `POST /v1/traces` then `GET /api/summary` returned
        // `sessions: []`). Serving stale is only correct AFTER waiting for the in-flight rebuild.
        assert!(
            waited >= Duration::from_millis(STALE_BUDGET_MS / 2),
            "returned stale after only {waited:?} — the reader must WAIT out its budget before giving up on fresh data"
        );
    }

    /// Read-your-writes: with NO rebuild in flight, a reader whose cache missed gets a summary
    /// built from the CURRENT data version — never a stale one. This is the property that
    /// `try_lock`-and-immediately-serve-stale destroyed, and it is the reason the budget exists.
    #[test]
    fn an_uncontended_reader_gets_fresh_data_not_stale() {
        // Held for the whole test: this asserts the NO-rebuilder shape, so it must not run while
        // a sibling has the flag set.
        let _serial = serial();
        let (state, warm_version) = state_with_a_warm_summary("fresh");
        state.lock_timed().data_version += 1;
        let current = state.lock_timed().data_version;

        // Nobody holds the gate here — the reader must rebuild rather than serve the warm value.
        let (served_version, _) = summary_now(&state, crate::now_ms() as f64);
        assert_eq!(served_version, current, "an uncontended reader must serve the CURRENT version");
        assert_ne!(served_version, warm_version, "serving the pre-bump summary is the read-your-writes bug");
    }

    /// THE BACK-OFF, WIRED (TRDD-7RM5YW2T). `rebuild_backoff_tests` below proves the arithmetic;
    /// this proves the 25 ms tick actually CONSULTS it — delete the check in `rebuild_once` and the
    /// middle assertion fails. Without a test at this level the loop could ignore the whole thing
    /// and every arithmetic assertion would still be green.
    ///
    /// The record is WRITTEN directly, with an absurd cost, so the second tick is inside the window
    /// on any machine at any load; timing it against a real microsecond rebuild would be a flake.
    /// `serial()` because the gate is process-global: a sibling holding it makes `rebuild_once`
    /// `try_lock` → `WouldBlock` → "someone is rebuilding" → the first assertion fails (measured
    /// 2/30 at --test-threads=8), and this test's own momentary `.lock()`s can fail a sibling's
    /// `try_lock().is_ok()` the same way.
    ///
    /// The reader-waiting override is exercised on both sides of its budget bound: an absurd cost
    /// with a reader waiting must STILL skip (the reader is stale either way, and honouring it would
    /// recreate the churn), a 10 ms cost with a reader waiting must build and consume the flag.
    #[test]
    fn the_rebuild_loop_skips_a_pass_inside_the_backoff_window() {
        let _serial = serial();
        let dir = std::env::temp_dir().join(format!("al-backoff-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let state = Arc::new(Mutex::new(CoreState::open(&dir)));
        let set_record = |last| rebuild_gate().lock().unwrap_or_else(|e| e.into_inner()).last = last;
        // A reader has asked, or the item-1 gate would make every pass below a no-op.
        state.lock_timed().summary_asked = true;
        let is_current = |state: &Arc<Mutex<CoreState>>| {
            let mut st = state.lock_timed();
            let version = st.data_version;
            st.summary_cache.current(version).is_some()
        };
        set_record(None);
        READER_WAITING.store(false, Ordering::Relaxed);

        // Nothing on the record yet: the first pass must build.
        rebuild_once(&state);
        assert!(is_current(&state), "the first pass must build — nothing is recorded yet");

        // Move the cache key the way ingest does, and put an expensive pass on the record.
        state.lock_timed().data_version += 1;
        set_record(Some((Instant::now(), Duration::from_secs(60))));
        rebuild_once(&state);
        assert!(
            !is_current(&state),
            "the loop rebuilt inside the back-off window — this is the back-to-back churn the card removed"
        );

        // A reader waiting on a rebuild that cannot land inside its budget changes nothing: it is
        // served stale either way, and yielding here would rebuild once per dashboard poll.
        READER_WAITING.store(true, Ordering::Relaxed);
        rebuild_once(&state);
        assert!(!is_current(&state), "a reader waiting on a 60 s rebuild must not override the back-off");
        assert!(READER_WAITING.load(Ordering::Relaxed), "a skipped pass must not consume the reader's flag");

        // The same reader waiting on a rebuild that CAN land inside its budget is honoured, and the
        // pass consumes the flag.
        set_record(Some((Instant::now(), Duration::from_millis(10))));
        rebuild_once(&state);
        assert!(is_current(&state), "a reader waiting on a 10 ms rebuild must override the back-off");
        assert!(!READER_WAITING.load(Ordering::Relaxed), "the pass that answers a waiting reader consumes its flag");

        // Clear the window and the SAME tick must build: that is what shows the skips above were the
        // back-off and not a version compare, an empty window, or a poisoned gate.
        state.lock_timed().data_version += 1;
        set_record(Some((Instant::now(), Duration::from_secs(60))));
        rebuild_once(&state);
        assert!(!is_current(&state), "sanity: inside the window, no reader waiting, must skip");
        set_record(None);
        rebuild_once(&state);
        assert!(is_current(&state), "with the window cleared the loop must rebuild");
        set_record(None);
    }

    /// Removes its directory on drop, so a failing assertion still cleans up (pattern of the TRDD-R36S0PS9 test).
    struct RemoveOnDrop(std::path::PathBuf);
    impl Drop for RemoveOnDrop {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A fresh temp dir unique per call (pid plus counter) and its cleanup guard. Declare the guard BEFORE the
    /// state that opens the dir, so the state drops first and the removal runs after its files are closed.
    fn unique_dir(tag: &str) -> (std::path::PathBuf, RemoveOnDrop) {
        static N: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = N.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("al-{}-{}-{}", tag, std::process::id(), n));
        std::fs::create_dir_all(&dir).unwrap();
        (dir.clone(), RemoveOnDrop(dir))
    }

    /// TRDD-735Q3JF4 item 1: the loop must not pre-build for nobody. A fresh state that no reader has
    /// asked about stays unbuilt across a pass, even with the back-off record empty (the boot condition).
    ///
    /// MUTATION CHECK: delete the `summary_asked` early return in `rebuild_once` and this MUST fail.
    #[test]
    fn the_rebuild_loop_builds_nothing_before_a_reader_has_asked() {
        let _serial = serial();
        let (dir, _cleanup) = unique_dir("unasked");
        let state = Arc::new(Mutex::new(CoreState::open(&dir)));
        rebuild_gate().lock().unwrap_or_else(|e| e.into_inner()).last = None;
        state.lock_timed().data_version += 1;

        rebuild_once(&state);
        let mut st = state.lock_timed();
        let version = st.data_version;
        assert!(st.summary_cache.current(version).is_none(), "the loop built a summary no reader had asked for");
    }

    /// TRDD-735Q3JF4 item 1, other half: one `summary_now` call releases the loop, which then builds
    /// the next version exactly as before.
    ///
    /// MUTATION CHECK: delete the `summary_asked = true` write in `summary_now` and this MUST fail.
    #[test]
    fn after_one_reader_has_asked_the_rebuild_loop_builds() {
        let _serial = serial();
        let (dir, _cleanup) = unique_dir("asked");
        let state = Arc::new(Mutex::new(CoreState::open(&dir)));
        rebuild_gate().lock().unwrap_or_else(|e| e.into_inner()).last = None;
        summary_now(&state, crate::now_ms() as f64);
        state.lock_timed().data_version += 1;

        rebuild_once(&state);
        let mut st = state.lock_timed();
        let version = st.data_version;
        assert!(st.summary_cache.current(version).is_some(), "the loop must build once a reader has asked");
    }

    /// TRDD-735Q3JF4 item 2 check: PINS CURRENT BEHAVIOUR at boot. Rebuilder active, nothing ever cached, no reader
    /// has asked yet. `stale` is None so the REBUILDER_ACTIVE wait block is skipped (it needs a stale value) and the
    /// first reader falls through to the inline build: with the gate free it wins it and returns the REAL summary for
    /// the current version (it carries the seeded session), building on the request path (the cold-boot exception).
    /// Only the stale = None case is tested. The gate-held case (the reader polls for up to 500 ms, then blocks on
    /// rebuild_gate().lock() until the rebuilder's in-flight build finishes, and the re-check under the gate avoids
    /// a second build) is reasoned from code, not tested here.
    #[test]
    fn at_boot_with_the_rebuilder_active_and_nothing_cached_the_first_reader_builds_inline() {
        let _active = RebuilderActive::on();
        let (dir, _cleanup) = unique_dir("boot-inline");
        let state = Arc::new(Mutex::new(CoreState::open(&dir)));
        // Seed one session so an empty summary tagged with the current version cannot pass.
        state.lock_timed().put_log_session(serde_json::json!({ "sessionId": "boot-seed-session", "startTime": "2026-08-01T10:00:00.000Z", "durationMs": 1000.0, "timeline": [] }));
        rebuild_gate().lock().unwrap_or_else(|e| e.into_inner()).last = None;
        assert!(!state.lock_timed().summary_asked, "precondition: no reader has asked");
        assert!(rebuild_gate().try_lock().is_ok(), "the gate must be free — that is the case under test");
        let (served_version, summary) = summary_now(&state, crate::now_ms() as f64);
        let listed = summary.get("sessions").and_then(|v| v.as_array()).map(|a| a.iter().any(|s| s["sessionId"] == "boot-seed-session"));
        assert_eq!(listed, Some(true), "the served summary must contain the seeded session, got {summary}");

        let mut st = state.lock_timed();
        let current = st.data_version;
        assert_eq!(served_version, current, "the first boot reader must get the real current summary, not a stale or empty one");
        assert!(st.summary_cache.current(current).is_some(), "the inline build must have stored the summary");
        assert!(st.summary_asked, "summary_now must release the rebuild loop");
    }

    /// THE FIX FOR THE GATE WINNER (TRDD-2R36W8Q1). With a background rebuilder owning rebuilds,
    /// a reader whose cache missed must NOT build even when the gate is completely free — it waits
    /// out its budget and serves the last good summary.
    ///
    /// MUTATION CHECK: delete the `REBUILDER_ACTIVE` early-return block in `summary_now` and this
    /// test MUST fail — the reader wins the free gate, rebuilds, and returns `current` instead of
    /// `warm_version`. That is precisely the request that measured 10.53 s and 13.25 s in the
    /// fleet soak while its five siblings, which lost the gate, came back in ~0.5 s.
    ///
    /// No rebuilder is actually spawned here, so the wait always runs to the full budget and the
    /// stale value is what gets served. That is the pessimistic end of the behaviour; in the
    /// server the task lands the fresh version within ~30 ms, which is what keeps read-your-writes
    /// intact and is covered by `tests/ui.rs`.
    #[test]
    fn a_reader_never_rebuilds_when_the_background_rebuilder_owns_it() {
        let _active = RebuilderActive::on();
        let (state, warm_version) = state_with_a_warm_summary("owned");

        state.lock_timed().data_version += 1;
        let current = state.lock_timed().data_version;
        assert_ne!(current, warm_version, "the cache key must have moved, or this proves nothing");

        // Deliberately NOT holding the gate: the winner is the case the budget cannot fix.
        assert!(rebuild_gate().try_lock().is_ok(), "the gate must be free — that is the case under test");

        READER_WAITING.store(false, Ordering::Relaxed);
        let began = Instant::now();
        let (served_version, _) = summary_now(&state, crate::now_ms() as f64);
        let waited = began.elapsed();

        assert_eq!(
            served_version, warm_version,
            "the reader rebuilt on the request path — with a rebuilder active it must serve the last good summary"
        );
        // The producer half of the back-off override (TRDD-7RM5YW2T): this reader's only source of
        // fresh data is the loop, so entering the wait MUST raise the flag the loop consults. The
        // wiring test sets the flag by hand and so cannot see this line go missing.
        assert!(
            READER_WAITING.load(Ordering::Relaxed),
            "a reader entering the budget wait must raise READER_WAITING, or the loop's back-off starves it"
        );
        assert!(
            waited < Duration::from_secs(2),
            "reader took {waited:?} — it is doing rebuild-shaped work instead of serving"
        );
        assert!(
            waited >= Duration::from_millis(STALE_BUDGET_MS / 2),
            "gave up after only {waited:?} — it must wait for the rebuilder before serving stale, or read-your-writes breaks"
        );
    }

    /// The cold-boot carve-out: with nothing ever built there is nothing to serve stale, so
    /// waiting is correct. Asserted so a future "never block" simplification cannot quietly start
    /// returning an empty summary on the very first request.
    #[test]
    fn cold_boot_has_no_stale_value_to_serve() {
        let dir = std::env::temp_dir().join(format!("al-admission-cold-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut st = CoreState::open(&dir);
        assert!(st.summary_cache.is_empty(), "a fresh CoreState has no summary yet");
        assert!(st.summary_cache.cached_any().is_none(), "nothing to serve stale before the first store");
    }

    /// TRDD-QE114936's acceptance criterion, made EXECUTABLE. Every MCP tool handler and REST
    /// route in this file must reach the summary through `summary_now` / `burn_status_now` (off
    /// the lock); rebuilding it inline under a guard is an O(window) hold that measured 12.6 s,
    /// 30.1 s and 64.5 s on the live server and stalls every ingest and read path behind it. The
    /// pattern reached eighteen sites while `build_session_summary`'s own doc comment said not to
    /// write it — a comment cannot stop it, a failing test can.
    ///
    /// EVERY method that rebuilds is listed, not just the one the defect was named after. The
    /// first version of this test carried a single needle and PASSED while two live routes still
    /// held the lock through a rebuild two hops down (`burn_risk_report` → `live_burn_status` →
    /// `build_session_summary`) — a guard that only sees the spelling it was written for is worse
    /// than none, because it certifies the file clean. Keep this list in step with `CoreState`.
    ///
    /// Needles are assembled at runtime and matched in CALL form (`.name(`) so this test's own
    /// source is not a match for itself; comment lines are skipped so prose may name the methods;
    /// the receiver is not part of the needle, so renaming `st` cannot hide an occurrence.
    #[test]
    fn mcp_handlers_never_rebuild_the_summary_under_the_lock() {
        let rebuilders = ["build_session_summary", "live_burn_status", "session_summary"];
        let needles: Vec<String> = rebuilders.iter().map(|n| format!(".{n}(")).collect();
        let hits: Vec<String> = include_str!("ui.rs")
            .lines()
            .enumerate()
            .filter(|(_, l)| !l.trim_start().starts_with("//"))
            .filter(|(_, l)| needles.iter().any(|n| l.contains(n.as_str())))
            .map(|(i, l)| format!("{}: {}", i + 1, l.trim()))
            .collect();
        assert!(hits.is_empty(), "ui.rs must reach the summary off the lock, never rebuild it under a guard:\n{hits:#?}");
    }

    /// The test above can only see the names it was given, so it is only as complete as that list —
    /// this pins the list's other half. `burn_risk_report` reached a rebuild TWO hops down
    /// (`live_burn_status` → `build_session_summary`) and was therefore invisible to a needle scan
    /// of `ui.rs`; that is precisely how the first version of this pair certified the file clean
    /// while two live routes still held the state lock through a whole-window rebuild.
    ///
    /// So: pin the number of `CoreState` methods that wrap a rebuild. Adding one fails HERE, and
    /// the failure is the prompt — either keep it off the serving path, or add it to `rebuilders`
    /// above so `ui.rs` is checked against it too.
    #[test]
    fn no_new_core_state_method_wraps_a_summary_rebuild() {
        // Known wrapper: `live_burn_status`. (`session_summary` is a rebuilder that reaches
        // `summary_over` directly, and is already in the list above.)
        let needle = format!("self.build_{}(", "session_summary");
        let hits: Vec<String> = include_str!("lib.rs")
            .lines()
            .enumerate()
            .filter(|(_, l)| !l.trim_start().starts_with("//"))
            .filter(|(_, l)| l.contains(needle.as_str()))
            .map(|(i, l)| format!("{}: {}", i + 1, l.trim()))
            .collect();
        assert_eq!(hits.len(), 1, "a CoreState method that wraps a summary rebuild was added or removed; keep `rebuilders` in the test above in step with it:\n{hits:#?}");
    }

    /// The third of the pair's blind spots, and the one that found site 21. The two tests above
    /// cover `ui.rs` and `lib.rs`; a rebuild can just as easily sit in a THIRD file that takes a
    /// `&mut CoreState` from a caller who is holding the lock — which is exactly what
    /// `hook_events::ingest_hook_event` does, called with the guard live from `ui.rs`.
    ///
    /// So: scan every other source file in the crate, and name the one site that is known and
    /// still open. Naming it is the point. An allowlist entry is a debt the test forces someone to
    /// look at; silence is a debt nobody can see — and silence is what let site 20 through.
    #[test]
    fn no_other_file_rebuilds_the_summary_from_a_caller_holding_the_lock() {
        let rebuilders = ["build_session_summary", "live_burn_status", "session_summary"];
        // BOTH spellings. Method-call form is what the code uses today; UFCS
        // (`CoreState::build_session_summary(&mut st, …)`) is the same call and would otherwise
        // walk straight past a needle that only knows the dot.
        let needles: Vec<String> =
            rebuilders.iter().flat_map(|n| [format!(".{n}("), format!("CoreState::{n}(")]).collect();
        // THE ONE KNOWN, STILL-OPEN SITE — pinned to its exact line text, not skipped by filename.
        // Skipping the FILE would blind this test to a second rebuild appearing in it, which is the
        // same "the guard could not see it" failure this whole card is about. TRDD-QE114936 carried
        // it forward rather than fixing it: it is on the INGEST path (POST /api/hook-events →
        // `ingest_hook_event`, StopFailure branch), not the MCP read path this card covers, and
        // moving it changes where capacity calibration reads its sessions. DELETE THIS when it
        // lands — the assertion below then requires the count to be 0 and fails until you do.
        // Assembled at runtime for the same reason the needles are: spelled out in full, this pin
        // is itself a `.build_session_summary(` occurrence in ui.rs, and the test above rightly
        // fails on it. (It did — which is a free demonstration that that test is live.)
        let known_open = ("hook_events.rs", format!("let sessions = st.build_{}(now_ms as f64);", "session_summary"));
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let (mut hits, mut known_seen): (Vec<String>, usize) = (Vec::new(), 0);
        let mut stack = vec![src];
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(&dir).expect("the crate's own src dir is readable") {
                let path = entry.expect("readable dir entry").path();
                if path.is_dir() {
                    stack.push(path);
                    continue;
                }
                let name = path.file_name().unwrap_or_default().to_string_lossy().into_owned();
                // ui.rs and lib.rs have their own, stricter assertions above.
                if path.extension().is_none_or(|e| e != "rs") || matches!(name.as_str(), "ui.rs" | "lib.rs") {
                    continue;
                }
                let text = std::fs::read_to_string(&path).expect("source file is utf-8");
                for (i, line) in text.lines().enumerate() {
                    let trimmed = line.trim();
                    if trimmed.starts_with("//") || !needles.iter().any(|n| line.contains(n.as_str())) {
                        continue;
                    }
                    if (name.as_str(), trimmed) == (known_open.0, known_open.1.as_str()) {
                        known_seen += 1;
                        continue;
                    }
                    hits.push(format!("{name}:{}: {trimmed}", i + 1));
                }
            }
        }
        assert!(hits.is_empty(), "a summary rebuild appeared in a file that can be called with the state lock held:\n{hits:#?}");
        assert_eq!(known_seen, 1, "the one allowed rebuild ({known_open:?}) is no longer where this test expects it — if it was FIXED, delete the `known_open` entry; if it MOVED, this test must be re-pinned");
    }
}

/// The cost back-off's arithmetic (TRDD-7RM5YW2T), tested as PURE arithmetic: every `Instant` here
/// is built by adding to one `now`, so these assertions never sleep, never race a real clock, and
/// state the gap in numbers a reader can check against the constant.
#[cfg(test)]
mod rebuild_backoff_tests {
    use std::time::{Duration, Instant};

    use super::{should_rebuild, REBUILD_COST_FACTOR, STALE_BUDGET_MS};

    #[test]
    fn a_rebuild_waits_out_four_times_its_own_cost() {
        let finished = Instant::now();
        let took = Duration::from_millis(10);
        let gap = took * REBUILD_COST_FACTOR;
        assert_eq!(gap, Duration::from_millis(40), "the literals below are written for factor 4");

        assert!(!should_rebuild(finished, took, finished), "another pass may not start the instant one ends");
        assert!(!should_rebuild(finished, took, finished + Duration::from_millis(39)), "39 ms is inside the gap");
        assert!(should_rebuild(finished, took, finished + Duration::from_millis(40)), "the gap ends at exactly 4 × the cost");
    }

    /// The property that makes ONE constant enough at every window size: the back-off is a fixed
    /// FRACTION of the wall clock, so nothing needs retuning as the window grows. A ~20 s rebuild —
    /// what the live collector measured at ~1M spans — is held off for 80 s, which is the 84%-of-a-
    /// core steady state turned into a fifth of one.
    #[test]
    fn the_gap_scales_with_the_rebuild_not_with_a_tuned_period() {
        let finished = Instant::now();
        let slow = Duration::from_secs(20);
        assert!(!should_rebuild(finished, slow, finished + Duration::from_secs(79)));
        assert!(should_rebuild(finished, slow, finished + Duration::from_secs(80)));
    }

    /// READ-YOUR-WRITES, and the reason there is no minimum-gap floor. With a background rebuilder
    /// active a reader that misses the cache cannot build — it waits up to `STALE_BUDGET_MS` for
    /// THIS loop — so the loop's gap after a millisecond-scale rebuild has to be far inside that
    /// budget, and at 4 ms it is by two orders of magnitude. A 250 ms floor would instead eat half
    /// the budget on every skip, for a window size at which there is no churn left to ration.
    #[test]
    fn a_millisecond_rebuild_is_waved_through_well_inside_the_stale_budget() {
        let finished = Instant::now();
        let took = Duration::from_millis(1);
        assert!(should_rebuild(finished, took, finished + Duration::from_millis(5)));
        assert!(
            took * REBUILD_COST_FACTOR < Duration::from_millis(STALE_BUDGET_MS),
            "the gap after a 1 ms rebuild must be far inside the budget a waiting reader has"
        );
    }

    /// A rebuild too fast to measure must impose no gap at all — otherwise an idle server with a
    /// trivial window would answer the first write of the day from the summary before it.
    #[test]
    fn a_zero_cost_rebuild_imposes_no_gap() {
        let finished = Instant::now();
        assert!(should_rebuild(finished, Duration::ZERO, finished));
    }

    /// The two ways this arithmetic could misbehave rather than merely delay: `Duration * u32`
    /// PANICS on overflow (that panic would kill the rebuild task, not slow it), and a naive
    /// `now - finished` panics if the clock moved back. Both are saturated, so an absurd input
    /// reads as "not due" instead.
    #[test]
    fn an_absurd_cost_saturates_instead_of_panicking() {
        let finished = Instant::now();
        assert!(!should_rebuild(finished, Duration::MAX, finished + Duration::from_secs(86_400)));
        assert!(!should_rebuild(finished + Duration::from_secs(60), Duration::from_millis(1), finished));
    }

    /// Nothing built yet is ALWAYS due. Pinned as the caller spells it, because the opposite
    /// reading of `None` ("no record ⇒ not due") would leave a fresh process with no summary at all
    /// and no way to get one.
    #[test]
    fn nothing_built_yet_is_always_due() {
        let never: Option<(Instant, Duration)> = None;
        assert!(never.is_none_or(|(finished, took)| should_rebuild(finished, took, Instant::now())));
    }
}

#[cfg(test)]
mod shell_tests {
    use super::substitute_tokens;

    #[test]
    fn a_value_carrying_a_token_is_never_rescanned() {
        assert_eq!(substitute_tokens("a=@@A@@;b=@@B@@", &[("@@A@@", "\"@@B@@\""), ("@@B@@", "INJECTED")]), "a=\"@@B@@\";b=INJECTED");
        assert_eq!(substitute_tokens("@@NOPE@@ @@P@@/a @@P@@/b", &[("@@P@@", "/lens")]), "@@NOPE@@ /lens/a /lens/b");
        assert_eq!(substitute_tokens("x=@@V@@", &[("@@V@@", "$& $1 $$")]), "x=$& $1 $$");
    }
}

#[cfg(test)]
mod composition_project_map_tests {
    use std::sync::Arc;

    use super::compositions_in_scope;
    use crate::call_body_registry::{CallBodyPointer, CallBodyRegistry};
    use crate::{composition_project_map_builds, CoreState};

    /// A pointer with no body — the composition builder then has nothing to parse, so the
    /// scope pass exercises the MAP path without needing body files on disk.
    fn pointer() -> CallBodyPointer {
        CallBodyPointer {
            kind: "request",
            body_ref: None,
            inline_body: Some("{}".to_owned()),
            request_id: None,
            span_id: None,
            model: None,
            query_source: None,
            request_body_id: None,
            message_id: None,
            message_uuid: None,
            ts: 0,
        }
    }

    /// TRDD-9VX3WTGU: a scope pass over N sessions must build the `sessionId → project` map
    /// ONCE. The pre-fix shape rebuilt it once per session — O(sessions²) map probes per
    /// pass — and the live profile put 14,071 of 14,071 samples in exactly that shape
    /// (`composition_project_map` → `IndexMap::get_index_of` → `_platform_memcmp`).
    ///
    /// The counter is thread-local, and this test runs on a single-threaded tokio runtime, so
    /// the delta is exactly this pass's own build count — no other test can contribute to it.
    #[tokio::test]
    async fn a_scope_pass_builds_the_project_map_once_not_once_per_session() {
        const N: usize = 12;
        let dir = std::env::temp_dir().join(format!("al-compscope-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut st = CoreState::open(&dir);
        let mut registry = CallBodyRegistry::new(64, 16);
        for i in 0..N {
            registry.record(&format!("sess-{i:04}"), pointer());
        }
        st.bodies = registry;
        let state = Arc::new(std::sync::Mutex::new(st));

        let before = composition_project_map_builds();
        let _ = compositions_in_scope(&state, None, crate::now_ms() as f64).await;
        let builds = composition_project_map_builds() - before;

        assert!(
            builds <= 1,
            "a scope pass over {N} sessions must build the project map ONCE, not once per session: {builds} builds"
        );
    }
}

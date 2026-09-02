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
/// Returns the data version the summary was built for, so a derived view (the stripped body)
/// memoizes against the SAME version rather than whatever `data_version` reads afterwards.
///
/// SINGLE-FLIGHT: at most one rebuild runs at a time. This gate was review F1 of `5e7f455`, was
/// assigned to an agent that stalled before landing it, and its absence was measured on 2026-08-29
/// as the process's dominant memory holder (TRDD-YU8QPU89).
///
/// The comment this replaces said two readers computing the same version was "wasted CPU, never a
/// stalled ingest". The CPU half was right and the cost was wrong: each in-flight rebuild holds its
/// own `SummaryInputs` snapshot (a `Vec<Arc<Value>>` over the whole window plus a clone of
/// `log_sessions`) AND the per-session card set it is building, while the previous summary stays
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
/// ponytail (TRDD-2R36W8Q1): admission is now `try_lock`, so readers never block — but rebuilds
/// still run BACK-TO-BACK under sustained ingest, because the moment one finishes the next
/// cache-missing request starts another. That is a steady 100% of ONE core (measured: 101.9%) and
/// it is the allocation churn behind the 17 GB plateau. It is deliberately NOT fixed here: a duty
/// cycle knob would be a second tunable in front of the same O(whole window) rebuild. The upgrade
/// is still the incremental summarizer named above, which removes the cost rather than rationing
/// it. Responsiveness was the failure; CPU share is a known, bounded ceiling.
/// How long a reader waits for an in-flight rebuild before serving stale (TRDD-2R36W8Q1).
///
/// Sized against BOTH failure modes rather than picked. Long enough that an ordinary rebuild
/// (milliseconds at normal window sizes) is WAITED FOR, so `POST /v1/traces` then `GET
/// /api/summary` still sees its own write. Short enough that the pathological case — a rebuild
/// over ~1M spans, measured at over 20 s — cannot hold a reader long enough to time out its HTTP
/// client, which is what made the server look dead while ingest was healthy.
const STALE_BUDGET_MS: u64 = 500;

fn rebuild_gate() -> &'static Mutex<()> {
    static GATE: std::sync::OnceLock<Mutex<()>> = std::sync::OnceLock::new();
    GATE.get_or_init(|| Mutex::new(()))
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
        let Ok(mut st) = state.lock_timed() else { return };
        let version = st.data_version;
        if st.summary_cache.current(version).is_some() {
            return;
        }
    }
    let _flight = match rebuild_gate().try_lock() {
        Ok(g) => g,
        // Someone is already rebuilding (a cold-boot reader, or a previous pass that outran the
        // tick). Skipping is correct: the in-flight rebuild produces the same value.
        Err(std::sync::TryLockError::WouldBlock) => return,
        Err(std::sync::TryLockError::Poisoned(e)) => e.into_inner(),
    };
    let inputs = {
        let Ok(mut st) = state.lock_timed() else { return };
        let version = st.data_version;
        if st.summary_cache.current(version).is_some() {
            return;
        }
        st.summary_snapshot()
    };
    let (summary, attribution) = CoreState::summary_from(&inputs, crate::now_ms() as f64);
    if let Ok(mut st) = state.lock_timed() {
        st.store_summary(inputs.version, summary, attribution);
    }
}

pub fn summary_now(state: &Arc<Mutex<CoreState>>, now_ms: f64) -> Result<(u64, Arc<Value>), String> {
    // Fast path: a warm cache never queues behind a rebuild. Under sustained ingest this misses
    // essentially always (see `cached_any`), so `stale` is what actually answers the request.
    let stale = {
        let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
        let version = st.data_version;
        if let Some(cached) = st.summary_cache.current(version) {
            return Ok((version, cached));
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
            loop {
                std::thread::sleep(std::time::Duration::from_millis(2));
                {
                    let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                    let version = st.data_version;
                    if let Some(cached) = st.summary_cache.current(version) {
                        return Ok((version, cached));
                    }
                }
                if std::time::Instant::now() >= deadline {
                    // Budget spent. Serve the freshest value that EXISTS — re-read rather than
                    // reusing the pre-wait snapshot, since a newer one may have landed meanwhile
                    // and serving it is free.
                    let newest = {
                        let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                        st.summary_cache.cached_any()
                    };
                    return Ok(newest.unwrap_or(stale_pair));
                }
            }
        }
    }

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
                    let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                    let version = st.data_version;
                    if let Some(cached) = st.summary_cache.current(version) {
                        return Ok((version, cached));
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
                        let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                        st.summary_cache.cached_any()
                    };
                    if let Some(pair) = newest.or(stale) {
                        return Ok(pair);
                    }
                    // COLD BOOT ONLY: no summary has ever been built, so there is nothing to
                    // serve and waiting is the only correct answer. It can happen at most once per
                    // process — after the first store `cached_any` always succeeds.
                    break rebuild_gate().lock().unwrap_or_else(|e| e.into_inner());
                }
            }
        }
    };

    let inputs = {
        let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
        let version = st.data_version;
        // Re-check under the gate — the rebuild we waited for very likely stored this version.
        if let Some(cached) = st.summary_cache.current(version) {
            return Ok((version, cached));
        }
        st.summary_snapshot()
    };
    let (summary, attribution) = CoreState::summary_from(&inputs, now_ms);
    let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
    Ok((inputs.version, st.store_summary(inputs.version, summary, attribution)))
}

/// `/api/summary`'s body and the shell's inlined copy: strip_session_detail over `summary_now`,
/// memoized on the summary's OWN version and — like the summary — computed off the lock. The
/// strip clones every card, so doing it under the lock was the same stall one layer down.
pub fn stripped_now(state: &Arc<Mutex<CoreState>>, now_ms: f64) -> Result<Arc<Value>, String> {
    let (version, summary) = summary_now(state, now_ms)?;
    {
        let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
        if let Some(cached) = st.stripped_cache.current(version) {
            return Ok(cached);
        }
    }
    let stripped = strip_session_detail(&summary);
    let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
    Ok(st.stripped_cache.store_if_newer(version, stripped))
}

/// pushUpdate — ONE full rebuild broadcast to every client. Called from the coalesced timer.
pub fn push_update(state: &Arc<Mutex<CoreState>>, hub: &SseHub, now_ms: f64) {
    if hub.client_count() == 0 {
        return;
    }
    let Ok((_, summary)) = summary_now(state, now_ms) else { return };
    // The lock covers ONLY the three cheap reads; the payload assembly (which walks every span
    // and re-strips every card) runs after it is released.
    let Ok((spans, gaps, build_id)) = state.lock_timed().map(|st| {
        let gaps = crate::collector_lifecycle::compute_gaps(&st.lifecycle, crate::collector_lifecycle::MIN_GAP_MS);
        (st.window.spans.clone(), gaps, st.build_id.clone())
    }) else {
        return;
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
pub fn strip_session_detail(summary: &Value) -> Value {
    let Some(obj) = summary.as_object() else { return summary.clone() };
    let mut out = obj.clone();
    if let Some(sessions) = obj.get("sessions").and_then(Value::as_array) {
        let stripped: Vec<Value> = sessions
            .iter()
            .map(|s| {
                let mut c = s.as_object().cloned().unwrap_or_default();
                c.insert("timeline".into(), Value::Array(Vec::new()));
                for k in ["fileOps", "generatedFiles", "generatedFilesTruncated"] {
                    c.shift_remove(k);
                }
                Value::Object(c)
            })
            .collect();
        out.insert("sessions".into(), Value::Array(stripped));
    }
    Value::Object(out)
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
async fn composition_for(state: &Arc<Mutex<CoreState>>, session_id: &str, now: f64) -> Result<Value, String> {
    let cached = {
        let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
        st.composition.get_cached(session_id)
    };
    if let Some(c) = cached {
        return Ok(c);
    }
    let (refs, project) = {
        let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
        let refs = crate::context_composition_index::resolve_refs(&st.bodies, session_id);
        // The project HINT is load-bearing, not decoration: it fills every composition's `project`
        // and is what a `scope` string is matched against. Omitting it (as this route did until
        // P4x.2c) makes every composition read `project: "unknown"` and every project-scoped query
        // match nothing — while still answering 200.
        let project = st.composition_project_map(now).get(session_id).cloned();
        (refs, project)
    };
    let sid = session_id.to_owned();
    let built = tokio::task::spawn_blocking(move || {
        crate::context_composition_index::build_session_composition(&sid, &refs, project.as_deref(), now)
    })
    .await
    .map_err(|e| format!("composition build join failed: {e}"))?;
    let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
    st.composition.put(session_id, built.clone());
    Ok(built)
}

/// `sessionsInScope` — the scoped set of compositions plus the coverage block that describes it.
/// Sequential by design: each `composition_for` may parse multi-MB bodies, and the cap (25) is what
/// bounds the work — fanning them out would just make the same bounded work concurrent while
/// multiplying peak memory.
pub(crate) async fn compositions_in_scope(state: &Arc<Mutex<CoreState>>, scope: Option<&str>, now: f64) -> Result<(Vec<Value>, Value), String> {
    let (ids, coverage) = {
        let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
        let projects = st.composition_project_map(now);
        let ids: Vec<String> = st.bodies.session_ids().iter().map(|s| (*s).to_owned()).collect();
        let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
        crate::context_composition_index::resolve_scope(
            &refs,
            scope,
            &|id| projects.get(id).cloned(),
            crate::context_composition_index::DEFAULT_SCOPE_CAP,
        )
    };
    let mut comps = Vec::with_capacity(ids.len());
    for id in ids {
        comps.push(composition_for(state, &id, now).await?);
    }
    Ok((comps, coverage))
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
fn resolve_session_card(st: &mut CoreState, session_id: &str, now: i64) -> Option<Value> {
    let summary = st.build_session_summary(now as f64);
    let mut session: Option<Value> = summary
        .get("sessions")
        .and_then(Value::as_array)
        .and_then(|ss| ss.iter().find(|s| s.get("sessionId").and_then(Value::as_str) == Some(session_id)))
        .cloned();
    drop(summary);
    let timeline_empty = session
        .as_ref()
        .is_some_and(|s| s.get("timeline").and_then(Value::as_array).is_none_or(Vec::is_empty));
    if timeline_empty && st.log_sessions.contains_key(session_id) {
        if let Some(scanned) = crate::log_reader::reparse_session(&st.log_env, session_id, now) {
            if let Some(mut card) = scanned.cards.into_iter().next() {
                // ingest_scanned's accountId stamp — the TS parser stamps it natively inside
                // _buildCard, so the reparsed card must carry it here too.
                if let Some(obj) = card.as_object_mut() {
                    let acct = obj.get("sessionId").and_then(Value::as_str).and_then(|sid| st.accounts.account_for(sid)).map(str::to_owned);
                    if let Some(a) = acct {
                        obj.insert("accountId".into(), Value::from(a));
                    }
                }
                st.put_log_session(card.clone());
                session = Some(card);
            }
        }
    }
    if let Some(s) = session.as_mut() {
        let claude_log = s.get("source").and_then(Value::as_str) == Some("claude_code")
            && s.get("dataSource").and_then(Value::as_str) == Some("log");
        if claude_log {
            if let Some(entries) = st.otel_attribution.get(session_id).filter(|e| !e.is_empty()) {
                let log_tl: Vec<Value> = s.get("timeline").and_then(Value::as_array).cloned().unwrap_or_default();
                let grafted = crate::feed_merge::graft_otel_attribution(&log_tl, Some(entries));
                if let Some(obj) = s.as_object_mut() {
                    obj.insert("timeline".into(), Value::Array(grafted));
                }
            }
        }
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
        let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
        let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
        let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
fn sse_response(state: &Arc<Mutex<CoreState>>, hub: &SseHub, now_ms: f64) -> Result<Response<SseBody>, String> {
    use http_body_util::BodyExt;
    let (_, summary) = summary_now(state, now_ms)?;
    let (spans, gaps, build_id) = {
        let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
    Ok(resp)
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
    v.to_string().replace("</", "<\\/").replace("<!--", "<\\!--").replace("${", "\\${")
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
    let (_, summary) = summary_now(state, now)?;
    let stripped = stripped_now(state, now)?;
    let (spans, build_id) = {
        let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
        // The SAME build_id the update frames carry — the dashboard reloads on a mismatch, so a
        // different fingerprint here (the TS's bundle mtimes) would reload it on first connect.
        (st.window.spans.clone(), st.build_id.clone())
    };
    let sidebar = if summary.is_null() {
        serde_json::json!({ "isActive": false, "lastActivityMs": 0, "sessionCount": 0, "agentSources": [], "currentSession": null, "burnRate": null })
    } else {
        crate::update_payload::compute_sidebar_payload(&summary, &spans, now)
    };
    let (summary_json, sidebar_json) = (safe_json(&stripped), safe_json(&sidebar));
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
        let key = state.lock_timed().map_err(|_| "state poisoned".to_owned())?.embed_key.clone();
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
            let data_dir = state.lock_timed().map_err(|_| "state poisoned".to_owned())?.data_dir.clone();
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

    // TRDD-HFV4AIT7 — refresh the memoized summary HERE, off the lock. Two dozen read routes
    // below reach it through `CoreState::build_session_summary`, which rebuilds INLINE under the
    // state lock; at 13.5k cards that is ~1s of `summarize_spans` with every ingest POST queued
    // behind it. Warming the memo first turns each of those calls into a pointer clone.
    // A PREFIX, not a per-route allowlist, for the reason the method gate above gives: an
    // allowlist always misses the NEXT route. The cost on a route that never reads the summary is
    // one version compare (a hit) or one off-lock rebuild — never a held lock.
    let reads_summary = (method == Method::GET || method == Method::HEAD)
        && (path == "/" || path == "/events" || path.starts_with("/api/"))
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
        sse_response(&state, &hub, crate::now_ms() as f64)?
    } else if method == Method::GET && path == "/api/summary" {
        json_response(StatusCode::OK, stripped_now(&state, crate::now_ms() as f64)?.to_string())
    } else if method == Method::GET && path == "/api/server-stats" {
        let body = {
            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
        let key_loaded = state.lock_timed().map_err(|_| "state poisoned".to_owned())?.embed_key.is_some();
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
            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
            let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
            let next = crate::server_stats::save_hook_runtime_config(&st.data_dir, st.hook_runtime, &patch)?;
            st.hook_runtime = next;
            println!(
                "alcore: hook config updated: gate={} capture={} advisor={}",
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
            let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
                    let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                    st.clear_spans();
                }
                push_update(&state, &hub, crate::now_ms() as f64);
            }
            Ok(_) => {}
            Err(e) => eprintln!("alcore: malformed /action body: {e}"),
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
                        let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                        let now = crate::now_ms();
                        st.statusline.append(payload, stream, now as f64);
                        st.persist.statusline_samples += 1;
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
                let (status, body) = {
                    let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                    crate::hook_events::ingest_hook_event(&mut st, &payload, crate::now_ms())
                };
                json_response(StatusCode::from_u16(status).unwrap_or(StatusCode::OK), body.to_string())
            }
        }
    } else if method == Method::GET && path == "/api/hook-events" {
        let q = query_of(&req);
        let num = |k: &str| q.get(k).filter(|v| !v.is_empty()).and_then(|v| v.parse::<i64>().ok());
        let events = {
            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
                        let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
            Ok(file) => println!("alcore: prompt written to {}", file.display()),
            Err(e) => eprintln!("alcore: write-prompts-file error: {e}"),
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
            println!("alcore: branch-dump: {} file(s) → {}", paths.len(), dump_root.display());
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
            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
            let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
            serde_json::json!({ "lastIngestActivityAt": st.last_ingest_activity_ms }).to_string()
        };
        json_response(StatusCode::OK, body)
    } else if method == Method::GET && path == "/api/debug/requests" {
        // Row 26: the recent-request ring + heap pressure. No V8 ⇒ the heap object is honest
        // zeros (over: false), as /api/server-stats reports; rssMb per row carries the story.
        let body = {
            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
            serde_json::json!({
                "heap": { "heapUsedMb": 0, "limitMb": 0, "hwmMb": 0, "over": false },
                "requests": st.requests.recent(200),
            })
            .to_string()
        };
        json_response(StatusCode::OK, body)
    } else if method == Method::GET && path == "/api/debug/log-scan-stats" {
        let body = {
            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
            let s = st.log_scan;
            let (sh, sm) = st.summary_cache.stats();
            let (th, tm) = st.stripped_cache.stats();
            let (readdirs, lhits, cached) = crate::generated_files::scratch_listing_stats();
            // NOT PORTED: the sidebar/analytics caches (those views are built inside the update
            // payload here, not as separate routes) — idle zeros.
            serde_json::json!({
                "incrementalReads": s.incremental_reads,
                "fullReads": s.full_reads,
                "filesStatted": s.files_statted,
                "dataVersion": st.data_version,
                "derivedCaches": {
                    "summary": { "hits": sh, "misses": sm },
                    "stripped": { "hits": th, "misses": tm },
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
        let body = {
            let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
            let status = st.live_burn_status(now);
            let account = st.burn.current_account(now);
            crate::burn::runtime::enrich_burn_status(&status, &account, &st.latest_resident_blobs).to_string()
        };
        json_response(StatusCode::OK, body)
    } else if method == Method::GET && path == "/api/burn-risk" {
        // Row 12 (server.ts:3519): checkBurnRisk over the three feeds + the verbatim spawning
        // calls behind an active fan-out. The TS 500-on-throw path is unreachable here (the
        // Rust compute cannot throw); every feed absence is reported in `sources`, not as an error.
        let body = {
            let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
            st.burn_risk_report(crate::now_ms() as f64, None, None).to_string()
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
            let Ok(mut st) = state.lock_timed() else { return no_content() };
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
            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
                let body = {
                    let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                    let summary = st.build_session_summary(crate::now_ms() as f64);
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
        let data_dir = { state.lock_timed().map_err(|_| "state poisoned".to_owned())?.data_dir.clone() };
        let (status, body) = tokio::task::spawn_blocking(move || crate::body_archive::bodies_export(&data_dir, &buf))
            .await
            .map_err(|e| e.to_string())?;
        json_response(StatusCode::from_u16(status).unwrap_or(StatusCode::OK), body.to_string())
    } else if method == Method::POST && path == "/api/bodies/purge" {
        // Row 15 (server.ts:3711): the request body is never read (the TS handler does not
        // consume it either); destruction is per-volume verify-before-delete (TRDD-K3WDPR7M).
        let data_dir = { state.lock_timed().map_err(|_| "state poisoned".to_owned())?.data_dir.clone() };
        let (status, body) = tokio::task::spawn_blocking(move || crate::body_archive::bodies_purge(&data_dir))
            .await
            .map_err(|e| e.to_string())?;
        json_response(StatusCode::from_u16(status).unwrap_or(StatusCode::OK), body.to_string())
    } else if method == Method::GET && path == "/api/collector-gaps" {
        // Row 29 (server.ts:4038, TRDD-PJC8N1HO spec 2): the lifecycle-derived downtime windows.
        // The TS wraps computeCollectorGaps in a catch → []; the Rust compute cannot throw.
        let body = {
            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
            serde_json::json!({ "collectorGaps": crate::collector_lifecycle::compute_gaps(&st.lifecycle, crate::collector_lifecycle::MIN_GAP_MS) })
                .to_string()
        };
        json_response(StatusCode::OK, body)
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
            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
                        let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                        let status = st.live_burn_status(now);
                        let account = st.burn.current_account(now);
                        let payload = crate::burn::runtime::label_burn_status_accounts(&status, Some(&account));
                        drop(st);
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_session_status" => {
                        // Pass-through: `computeSessionStatus` IS the payload, there is no shaper.
                        // Its no-match branch is a `{message, matchedBy:'none'}` object, NOT an
                        // error — a caller who mistypes a session id gets an honest answer.
                        let now = crate::now_ms() as f64;
                        let (sid, ws) = (s("sessionId"), s("workspace"));
                        let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                        let payload = st.live_session_status(sid.as_deref(), ws.as_deref(), now);
                        drop(st);
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_window_budget" => {
                        let now = crate::now_ms() as f64;
                        let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                        let status = st.live_burn_status(now);
                        let account = st.burn.current_account(now);
                        drop(st);
                        let payload = crate::mcp_tools::get_window_budget(Some(&status), Some(&account), s("accountId").as_deref());
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_recent_sessions" | "get_workspace_patterns" | "find_relevant_context" | "get_efficiency_report"
                    | "get_instruction_suggestions" => {
                        let now = crate::now_ms() as f64;
                        let (sessions, gaps) = {
                            let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                            let summary = st.build_session_summary(now);
                            let sessions: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                            drop(summary);
                            let gaps = crate::collector_lifecycle::compute_gaps(&st.lifecycle, crate::collector_lifecycle::MIN_GAP_MS);
                            (sessions, gaps)
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
                            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
                        let sessions = {
                            let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                            let summary = st.build_session_summary(now as f64);
                            summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default()
                        };
                        let (a, st2) = (args.clone(), state.clone());
                        let payload = tokio::task::spawn_blocking(move || {
                            let timeline_of = |c: &Value| -> Vec<Value> {
                                let Some(sid) = c.get("sessionId").and_then(Value::as_str) else { return Vec::new() };
                                // Re-locked PER SESSION, never held across the pool: resolution can
                                // reparse a multi-MB transcript and one held lock would stall every
                                // other request for the whole scan.
                                let Ok(mut st) = st2.lock_timed() else { return Vec::new() };
                                resolve_session_card(&mut st, sid, now)
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
                        let (sessions, timelines) = {
                            let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                            let summary = st.build_session_summary(now as f64);
                            let sessions: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                            drop(summary);
                            // The matched card is not known until the shaper runs, so resolve only
                            // the ONE id the query can possibly name — the normalized equivalence
                            // class is a pure string test, so it is safe to precompute here.
                            let q = args.get("agentId").and_then(Value::as_str).unwrap_or("").trim().to_lowercase();
                            let q_bare = q.strip_prefix("agent-").unwrap_or(&q).to_owned();
                            let mut timelines: std::collections::HashMap<String, Vec<Value>> = std::collections::HashMap::new();
                            let ids: Vec<String> = sessions
                                .iter()
                                .filter_map(|s| s.get("sessionId").and_then(Value::as_str))
                                .filter(|id| {
                                    let lower = id.to_lowercase();
                                    lower.strip_prefix("agent-").unwrap_or(&lower) == q_bare
                                })
                                .map(str::to_owned)
                                .collect();
                            for id in ids {
                                let tl = resolve_session_card(&mut st, &id, now)
                                    .and_then(|c| c.get("timeline").and_then(Value::as_array).cloned())
                                    .unwrap_or_default();
                                timelines.insert(id, tl);
                            }
                            (sessions, timelines)
                        };
                        let timeline_of = |c: &Value| -> Vec<Value> {
                            timelines.get(c.get("sessionId").and_then(Value::as_str).unwrap_or("")).cloned().unwrap_or_default()
                        };
                        let payload = crate::mcp_tools::get_agent_tokens(&sessions, &timeline_of, &args, now as f64);
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_account_state_at" => {
                        let path = {
                            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                            crate::account_state_timeline::account_state_timeline_path(&st.data_dir)
                        };
                        let payload = crate::mcp_tools::get_account_state_at(&args, &path);
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_context_inflation_report" => {
                        // Composition AND (single-session only) full history — both are transcript
                        // parses, so the whole thing runs on spawn_blocking with the lock released.
                        let now = crate::now_ms() as f64;
                        let (sessions, env) = {
                            let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                            let summary = st.build_session_summary(now);
                            let sessions: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                            drop(summary);
                            (sessions, st.log_env.clone())
                        };
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
                        let (sessions, env) = {
                            let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                            let summary = st.build_session_summary(now);
                            let sessions: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                            drop(summary);
                            (sessions, st.log_env.clone())
                        };
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
                        // One lock: the cards AND the resolved timeline (the same reparse-on-demand
                        // + OTEL graft path row 30 uses), then straight into the pure shaper.
                        let (card, timeline) = {
                            let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                            let summary = st.build_session_summary(now as f64);
                            let card = summary
                                .get("sessions")
                                .and_then(Value::as_array)
                                .and_then(|v| v.iter().find(|c| c.get("sessionId").and_then(Value::as_str) == Some(session_id.as_str())).cloned());
                            drop(summary);
                            let timeline: Vec<Value> = resolve_session_card(&mut st, &session_id, now)
                                .and_then(|c| c.get("timeline").and_then(Value::as_array).cloned())
                                .unwrap_or_default();
                            (card, timeline)
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
                        let sessions = {
                            let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                            let summary = st.build_session_summary(now);
                            summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default()
                        };
                        let payload = crate::mcp_tools::get_subagent_tree(&sessions, &s("sessionId").unwrap_or_default(), now);
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_loaded_plugin_versions" => {
                        // Same P4s choreography as get_skill_attribution: roots under the lock,
                        // then UNLOCK before the disk walk — this one reads every transcript AND
                        // stats the whole plugin cache.
                        let now = crate::now_ms() as f64;
                        let (dirs, cache_root) = {
                            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
                        let sessions = {
                            let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                            let summary = st.build_session_summary(now);
                            summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default()
                        };
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
                        // Under ONE lock: the summary cards, the RESOLVED timeline (the same
                        // resolveSessionCard row 30 uses — reparse-on-demand + OTEL graft), and the
                        // fork-ancestor walk for the composition. The multi-GB transcript parse
                        // then runs with the lock RELEASED.
                        let (sessions, timeline, env, ancestor) = {
                            let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                            let summary = st.build_session_summary(now as f64);
                            let sessions: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                            drop(summary);
                            let timeline: Vec<Value> = resolve_session_card(&mut st, &session_id, now)
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
                            (sessions, timeline, st.log_env.clone(), ancestor)
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
                        let (sessions, dir, home) = {
                            let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                            let summary = st.build_session_summary(now);
                            let sessions: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                            drop(summary);
                            let dir = crate::burn::guard::default_bodies_dir(&st.data_dir);
                            let home = st.burn.home_dir.to_string_lossy().into_owned();
                            (sessions, dir, home)
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
                            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
                            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
                            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
                            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
                        let dirs = {
                            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                            agentlens_logscan::discovery::claude_projects_dirs(&st.log_env)
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
                            let seismic = match agentlens_store::transcript_sql::DuckSession::open_in_memory() {
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
                            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
                            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
                        let dirs = {
                            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                            agentlens_logscan::discovery::claude_projects_dirs(&st.log_env)
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
                            };
                            agentlens_store::transcript_sql::run_transcript_sql(&opts, crate::now_ms() as f64)
                        })
                        .await
                        .map_err(|e| format!("transcript sql join failed: {e}"))?;
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_subscription_usage" => {
                        // The one tool here that talks to the network. Blocking transport + file
                        // locks, so it runs on spawn_blocking with the state lock released first.
                        let (data_dir, home) = {
                            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
                            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
                        let rl_scope = crate::burn::guard::resolve_bodies_read_scope(&rl_data_dir, &std::env::vars().collect());
                        let rl_scope_dirs: Vec<String> =
                            rl_scope.dirs.iter().map(|p| p.to_string_lossy().into_owned()).collect();
                        let rl_scope_missing: Vec<String> =
                            rl_scope.missing.iter().map(|p| p.to_string_lossy().into_owned()).collect();
                        let rl_capture_on = rl_scope.capture_on;
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
                                        capture_on: rl_capture_on,
                                    },
                                    hook_events_dir: hook_dir.clone(),
                                    home: home.clone(),
                                    window_hours: Some(hours),
                                    until_ms: Some(until),
                                    max_files: Some(max_files),
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
                            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                            (
                                st.data_dir.clone(),
                                st.data_dir.join("hook-events"),
                                st.log_env.home.to_string_lossy().into_owned(),
                                agentlens_logscan::discovery::claude_projects_dirs(&st.log_env),
                            )
                        };
                        // The full multi-dir scope (captureConfig.resolveBodiesReadScope): during a
                        // drain the live spool AND the legacy dir both hold bodies, so reading one
                        // under-counts and windowEstCostUsd comes back low.
                        let scope = crate::burn::guard::resolve_bodies_read_scope(&data_dir, &std::env::vars().collect());
                        let opts = crate::burn::investigator_scan::InvestigateOptions {
                            scope: crate::burn::investigator_scan::BodiesScope {
                                dirs: scope.dirs.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
                                missing: scope.missing.iter().map(|p| p.to_string_lossy().into_owned()).collect(),
                                capture_on: scope.capture_on,
                            },
                            hook_events_dir: hook_dir,
                            home: home.clone(),
                            window_hours: args.get("windowHours").and_then(Value::as_f64),
                            until_ms,
                            max_files: args.get("maxFiles").and_then(Value::as_f64),
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
                            let (bodies_dir, sessions) = {
                                let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                                let dir = crate::burn::guard::default_bodies_dir(&st.data_dir);
                                let summary = st.build_session_summary(now);
                                let sessions: Vec<Value> =
                                    summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                                (dir, sessions)
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
                        let (bodies_dir, spans_dir) = {
                            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                            (crate::burn::guard::default_bodies_dir(&st.data_dir), st.data_dir.join("spans"))
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
                            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
                        let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                        let timeline_path = crate::account_state_timeline::account_state_timeline_path(&st.data_dir);
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
                                    let summary = st.build_session_summary(now);
                                    let sessions: Vec<Value> =
                                        summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                                    drop(summary);
                                    let events = crate::burn::monitor::gather_consumption_events(&sessions, &[], now);
                                    let rate_window_ms =
                                        args.get("rate_window_min").and_then(Value::as_f64).unwrap_or(30.0).max(1.0) * 60_000.0;
                                    let observed = st.burn.config.observed.clone();
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
                        drop(st);
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_account_burners" => {
                        // Pure once the inputs are gathered (no transcript reparse), so it runs
                        // under the lock like the other burn routes rather than on spawn_blocking.
                        //
                        // Every early return is an ERROR THAT NAMES ITSELF: an empty timeline and
                        // an unmatched account produce different messages, and the unmatched one
                        // lists the accounts it DOES know — a bare null would send the caller
                        // hunting for a bug in the tool instead of fixing the argument.
                        let now = crate::now_ms() as f64;
                        let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                        let timeline_path = crate::account_state_timeline::account_state_timeline_path(&st.data_dir);
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
                                            let summary = st.build_session_summary(now);
                                            let sessions: Vec<Value> =
                                                summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                                            drop(summary);
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
                                            let home = st.burn.home_dir.to_string_lossy().into_owned();
                                            let observed = st.burn.config.observed.clone();
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
                        drop(st);
                        crate::mcp_tools::tool_ok_lean(&id, &payload, &args)
                    }
                    "get_cache_risk_costs" => {
                        // Two transcript SCANS (slash commands + effort transitions) over the whole
                        // history, then up to 40 pooled sessions each costing a reparse plus a
                        // composition rebuild — all of it disk-bound, so it goes on spawn_blocking
                        // with the state lock released and re-locked PER SESSION inside
                        // `timeline_of` (the P4s rule).
                        let now = crate::now_ms();
                        let (sessions, env) = {
                            let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                            let summary = st.build_session_summary(now as f64);
                            let sessions: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                            drop(summary);
                            (sessions, st.log_env.clone())
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
                                let Ok(mut st) = st2.lock_timed() else { return Vec::new() };
                                resolve_session_card(&mut st, sid, now)
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
                        let (sessions, env) = {
                            let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                            let summary = st.build_session_summary(now as f64);
                            let sessions: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                            drop(summary);
                            (sessions, st.log_env.clone())
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
                                let Ok(mut st) = st2.lock_timed() else { return Vec::new() };
                                resolve_session_card(&mut st, sid, now)
                                    .and_then(|c| c.get("timeline").and_then(Value::as_array).cloned())
                                    .unwrap_or_default()
                            };
                            crate::mcp_tools::get_cache_break_report(
                                &sessions,
                                &file_ids,
                                &a,
                                Some(&get_comp),
                                &timeline_of,
                                now as f64,
                                20_000.0,
                            )
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
                        let (sessions, ttl) = {
                            let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                            let summary = st.build_session_summary(now as f64);
                            let sessions: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                            drop(summary);
                            let ttl = st.burn.ttl_context(now as f64);
                            (sessions, ttl)
                        };
                        let (a, st2) = (args.clone(), state.clone());
                        // TRDD-CXPLAT01: the bounded last-request resolver (standalone/server.ts:1536).
                        // Cloned OUT of the state before spawn_blocking — the closure must be 'static,
                        // and holding the state lock across a 256KB read per candidate would block
                        // every other reader for the whole scan.
                        let log_env = state.lock_timed().map_err(|_| "state poisoned".to_owned())?.log_env.clone();
                        let payload = tokio::task::spawn_blocking(move || {
                            let timeline_of = |c: &Value| -> Vec<Value> {
                                let Some(sid) = c.get("sessionId").and_then(Value::as_str) else { return Vec::new() };
                                let Ok(mut st) = st2.lock_timed() else { return Vec::new() };
                                resolve_session_card(&mut st, sid, now)
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
                            let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                            let status = st.live_burn_status(now);
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
                        let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                        let payload = st.burn_risk_report(now, n("fanoutThreshold"), n("spikeTokensPerMin"));
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
                            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
                        let (env, card_model) = {
                            let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
                            let model = if name == "get_context_history" {
                                st.build_session_summary(crate::now_ms() as f64)
                                    .get("sessions")
                                    .and_then(Value::as_array)
                                    .and_then(|ss| ss.iter().find(|c| c.get("sessionId").and_then(Value::as_str) == Some(session_id.as_str())))
                                    .and_then(|c| c.get("model").and_then(Value::as_str))
                                    .map(str::to_owned)
                            } else {
                                None
                            };
                            (st.log_env.clone(), model)
                        };
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
            let st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
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
        let comp = composition_for(&state, &session_id, now).await?;
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
        let body = {
            let mut st = state.lock_timed().map_err(|_| "state poisoned".to_owned())?;
            let session = resolve_session_card(&mut st, &session_id, now);
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
        let media_dir = state.lock_timed().map_err(|_| "state poisoned".to_owned())?.media_dir.clone();
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
        if let Ok(mut st) = state.lock_timed() {
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
        let Ok((_, tick_summary)) = summary_now(&state, crate::now_ms() as f64) else { continue };
        // Declared OUTSIDE the lock block (uninitialized — the only path that skips the assignment
        // is the `continue` below, which also skips every read): the rotation edge is detected
        // under the lock, and the capture it triggers runs after the lock is released.
        let rotation_capture: Option<(
            std::path::PathBuf,
            std::path::PathBuf,
            std::collections::HashMap<String, String>,
        )>;
        {
            let Ok(mut st) = state.lock_timed() else { continue };
            let now = crate::now_ms() as f64;
            // The bodies watcher's poll cadence (the TS runs a dedicated 5s timer; folding it
            // into this 4s tick keeps the same ≤5s staleness with one fewer task). The gate's
            // buildGateState reads the report WITHOUT polling — a poll landing on new multi-MB
            // response files costs 100-400ms of parsing, the TRDD-9CNHP8CN request-latency
            // outlier — so this tick is what keeps its snapshot fresh.
            st.burn.bodies.poll(now);
            // The statusline WAL flush (the TS runs a dedicated 5s timer; this 4s tick gives
            // the same ≤5s durability window with one fewer task). Sealing is NOT here — it
            // runs DuckDB over whole WALs and lives on alcore's own 60s task, outside the lock.
            st.statusline.flush(None);
            let status = st.burn_status_over(&tick_summary, now);
            st.burn.last_status = Some(status.clone());
            let account = st.burn.current_account(now);
            // TRDD-YQZ9P8IL: sample the subscription state onto the change-detected timeline.
            // `record` only enqueues on a discrete change (account/mode/plan/ttl), so this 4s call
            // is a key comparison in the common case and a real write a few times an hour — which
            // is what makes it safe on the hot tick. The flush is a 60s chore, never here.
            let ttl_ctx = st.burn.ttl_context(now);
            let sample = crate::account_state_timeline::build_account_state_record(Some(&account), Some(&ttl_ctx), now);
            st.account_timeline.record(sample);
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
                eprintln!("alcore: usage refresh (account changed): {reason}");
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
        let version = match state.lock_timed() {
            Ok(st) => st.data_version,
            Err(_) => continue,
        };
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
    use std::sync::{Arc, Mutex};
    use std::time::{Duration, Instant};

    use super::{rebuild_gate, summary_now, REBUILDER_ACTIVE, STALE_BUDGET_MS};
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
        let (version, _) = summary_now(&state, crate::now_ms() as f64).expect("warm the cache");
        (state, version)
    }

    /// The fix. With the gate held by someone else, a cache-missing reader is answered from the
    /// last good summary instead of queueing — promptly, and with the version that summary was
    /// actually built for (never the current `data_version`, which is what keeps `stripped_cache`
    /// keyed to inputs it really derives from).
    #[test]
    fn reader_does_not_block_behind_an_in_flight_rebuild() {
        let (state, warm_version) = state_with_a_warm_summary("nonblock");

        // Force the fast path to miss exactly the way sustained ingest does: bump the key.
        state.lock_timed().unwrap().data_version += 1;
        let current = state.lock_timed().unwrap().data_version;
        assert_ne!(current, warm_version, "the cache key must have moved, or this proves nothing");

        // Stand in for a 20-second rebuild.
        let held = rebuild_gate().lock().unwrap_or_else(|e| e.into_inner());

        let began = Instant::now();
        let (served_version, _summary) = summary_now(&state, crate::now_ms() as f64).expect("served");
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
        state.lock_timed().unwrap().data_version += 1;
        let current = state.lock_timed().unwrap().data_version;

        // Nobody holds the gate here — the reader must rebuild rather than serve the warm value.
        let (served_version, _) = summary_now(&state, crate::now_ms() as f64).expect("served");
        assert_eq!(served_version, current, "an uncontended reader must serve the CURRENT version");
        assert_ne!(served_version, warm_version, "serving the pre-bump summary is the read-your-writes bug");
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

        state.lock_timed().unwrap().data_version += 1;
        let current = state.lock_timed().unwrap().data_version;
        assert_ne!(current, warm_version, "the cache key must have moved, or this proves nothing");

        // Deliberately NOT holding the gate: the winner is the case the budget cannot fix.
        assert!(rebuild_gate().try_lock().is_ok(), "the gate must be free — that is the case under test");

        let began = Instant::now();
        let (served_version, _) = summary_now(&state, crate::now_ms() as f64).expect("served");
        let waited = began.elapsed();

        assert_eq!(
            served_version, warm_version,
            "the reader rebuilt on the request path — with a rebuilder active it must serve the last good summary"
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

//! agentlens-core — the Rust server surface (TRDD-DMWOBWFH P4).
//!
//! P4c slice: the OTLP listener behind the FROZEN wire contract (the P4a freeze report §2 is
//! the spec — reports/p4-wire-freeze/, mirrored from standalone/server.ts:4413):
//!   - `GET /agentlens/standalone` (raw path+query, exact) → 200 `{"agentlens":true,"kind":"standalone"}`
//!   - any other non-POST → 200, empty body, no headers
//!   - `POST <any path>`: 64MB cap (overflow → the connection is ABORTED, no response); body is
//!     parsed as JSON (no Content-Type inspection); routed by PATH first (`/v1/traces|logs|metrics`)
//!     then by payload classification; metrics accepted and DISCARDED; parse failure is counted
//!     and still answered 200. **Always 200, empty body, no Content-Type.**
//!
//! Behind the wire: the P3b-ported pure transforms (agentlens-ingest) feed the P3-ported
//! span-store writer. NOT in this slice (recorded in the TRDD STATE): admission-control 503s,
//! the in-memory span window + summarizer (so gen_ai injection is a no-op here), account/body
//! registries, and the dropped-log-event sink — the TS server still owns port 4318.

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::service::service_fn;
use hyper::{Method, Request, Response};
use indexmap::IndexMap;
use serde_json::Value;

use agentlens_ingest::IngestState;
use agentlens_spanstore::writer::SpanStoreWriter;

pub mod delta_log;
pub mod feed_merge;
pub mod log_reader;
pub mod pricing;
pub mod retention_config;
pub mod server_stats;
pub mod session_store;
pub mod span_window;
pub mod summarize;
pub mod ui;
pub mod update_payload;

pub const MAX_BODY_BYTES: usize = 64 * 1024 * 1024;

/// Port of src/otlpParser.ts::classifyOtlpPayload — the fallback discriminator when the POST
/// path is not one of the /v1/* names.
pub fn classify(payload: &Value) -> &'static str {
    let Some(obj) = payload.as_object() else { return "unknown" };
    if obj.get("resourceSpans").is_some_and(Value::is_array) {
        return "traces";
    }
    if obj.get("resourceLogs").is_some_and(Value::is_array) {
        return "logs";
    }
    if obj.get("resourceMetrics").is_some_and(Value::is_array) {
        return "metrics";
    }
    "unknown"
}

#[derive(Default)]
pub struct Counters {
    pub traces_payloads: u64,
    pub logs_payloads: u64,
    pub metrics_payloads: u64,
    pub parse_errors: u64,
    pub spans_appended: u64,
}

pub struct CoreState {
    pub ingest: IngestState,
    pub writer: SpanStoreWriter,
    pub counters: Counters,
    /// The summarization window (server.ts `spans` + `effectiveWindowMs`, P4h): loaded from the
    /// span store for the last summaryWindowHours at boot, appended by every ingested span,
    /// pruned by time on the flush tick. Every derived view is computed over it.
    pub window: span_window::SpanWindow,
    /// Bumped on every data change; the coalesced SSE pusher rebuilds only when it moved
    /// (server.ts dataVersion).
    pub data_version: u64,
    /// The dashboard live-reload fingerprint carried in every update frame (server.ts BUILD_ID —
    /// bundle mtimes there; here the process start, the same "changes on restart" contract).
    pub build_id: String,
    /// Log-derived session cards keyed by sessionId (server.ts `logSessions`), merged into the
    /// served summary under the feed-collision doctrine (feed_merge.rs). Fed by the log reader
    /// (log_reader.rs); `put_log_session` is the one write path and bumps data_version. An
    /// IndexMap: insertion order kept like the JS Map, O(1) upsert (a 13k-card boot would be
    /// quadratic on a Vec).
    pub log_sessions: IndexMap<String, Value>,
    /// The data dir this process owns (server.ts DATA_DIR) — the sidecar paths `/api/server-stats`
    /// measures hang off it.
    pub data_dir: std::path::PathBuf,
    /// server.ts SERVER_STARTED_AT.
    pub started_at_ms: i64,
    /// The bound listeners; alcore overwrites the defaults with what it actually bound.
    pub ports: server_stats::Ports,
    /// server.ts persistStats — every byte this process writes, counted where it is written.
    pub persist: server_stats::PersistStats,
}

impl CoreState {
    /// putLogSession — upsert by sessionId.
    pub fn put_log_session(&mut self, card: Value) {
        let id = card.get("sessionId").and_then(Value::as_str).unwrap_or("").to_owned();
        self.log_sessions.insert(id, card);
        self.data_version += 1;
    }

    /// demoteColdTimelines (server.ts, TRDD-66IXMIGN fifth repro): per-card bounds are not
    /// sufficient on a ~13k-session machine — only the `hot_cards` most-recently-active cards
    /// keep their timelines in RAM; every colder card keeps headers only.
    pub fn demote_cold_timelines(&mut self, hot_cards: usize) {
        if self.log_sessions.len() <= hot_cards {
            return;
        }
        let mut order: Vec<(f64, usize)> =
            self.log_sessions.values().enumerate().map(|(i, c)| (log_reader::last_active_ms(c), i)).collect();
        // Newest first; a stable sort keeps insertion order among ties, as the JS sort does.
        order.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        for (_, i) in order.into_iter().skip(hot_cards) {
            if let Some(obj) = self.log_sessions.get_index_mut(i).and_then(|(_, c)| c.as_object_mut()) {
                log_reader::strip_timeline_value(obj);
            }
        }
    }

    /// A sweep's output into the card map (server.ts runLogScan's loop): every card through
    /// put_log_session, then the global timeline tier. The data_version bump is what the
    /// coalesced SSE pusher watches.
    pub fn ingest_scanned(&mut self, scanned: Vec<log_reader::ScannedFile>) {
        if scanned.is_empty() {
            return;
        }
        for s in scanned {
            for card in s.cards {
                self.put_log_session(card);
            }
        }
        self.demote_cold_timelines(summarize::retention::timeline_hot_cards());
    }

    /// computeSessionSummary (server.ts:2240) — summarizeSpans over the live window, then, when
    /// any log session exists, the feed-collision merge + the subagent link, sorted newest-first.
    pub fn session_summary(&self, now_ms: f64) -> Value {
        let _ = now_ms;
        let mut summary = summarize::summarizer::summarize_spans(&self.window.spans, &|_| None);
        if !self.log_sessions.is_empty() {
            let otel: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
            let logs: Vec<Value> = self.log_sessions.iter().map(|(_, c)| c.clone()).collect();
            let mut merged = feed_merge::link_subagent_transcripts(feed_merge::merge_otel_and_log_sessions(otel, logs));
            // Date.parse(b.startTime || '0') - Date.parse(a.startTime || '0'), newest first.
            merged.sort_by(|a, b| {
                let k = |c: &Value| {
                    let st = c.get("startTime").and_then(Value::as_str).unwrap_or("");
                    if st.is_empty() { -62_167_219_200_000.0 } else { summarize::helpers::parse_iso_ms(st).unwrap_or(f64::NAN) }
                };
                k(b).partial_cmp(&k(a)).unwrap_or(std::cmp::Ordering::Equal)
            });
            summary.as_object_mut().expect("summary object").insert("sessions".into(), Value::Array(merged));
        }
        summary
    }
}

impl CoreState {
    /// Open the store under `<data_dir>/spans` and load the summary window from it — the TS boot
    /// load (server.ts:422): only the segments overlapping the window, nothing evicted.
    pub fn open(data_dir: &std::path::Path) -> CoreState {
        let now = now_ms();
        let mut writer = SpanStoreWriter::open(&data_dir.join("spans"));
        let mut window = span_window::SpanWindow::new(span_window::summary_window_ms(data_dir));
        window.boot_load(&mut writer, now);
        CoreState {
            ingest: IngestState::default(),
            writer,
            counters: Counters::default(),
            window,
            data_version: 0,
            build_id: now.to_string(),
            log_sessions: IndexMap::new(),
            data_dir: data_dir.to_path_buf(),
            started_at_ms: now,
            ports: server_stats::Ports::default(),
            persist: server_stats::PersistStats::default(),
        }
    }

    /// The flush tick's prune (server.ts flushSpanAppends): the window shrank ⇒ every derived
    /// view must be rebuilt.
    pub fn prune_window(&mut self, now_ms: i64) {
        if self.window.prune(now_ms) {
            self.data_version += 1;
        }
    }

    /// The ONE span flush path (server.ts flushSpanAppends): a flush that appended counts as one
    /// write of that many bytes — the persistence row `/api/server-stats` reports. Every flush
    /// site (per payload, the 5s tick, shutdown) goes through here so the counter cannot miss one.
    pub fn flush_spans(&mut self) {
        let r = self.writer.flush();
        if r.appended_spans > 0 {
            self.persist.span_append_writes += 1;
            self.persist.span_append_bytes += r.appended_bytes;
        }
    }
}

pub fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// One POST body through the transforms into the store. Never fails toward the wire — the
/// frozen contract answers 200 whatever happens; failures are counted, not surfaced.
pub fn ingest_post(state: &mut CoreState, path: &str, body: &[u8]) {
    let Ok(text) = std::str::from_utf8(body) else {
        state.counters.parse_errors += 1;
        return;
    };
    let Ok(payload) = serde_json::from_str::<Value>(text) else {
        // Counted like the TS collector's otlpIngestError fallback (a protobuf export lands
        // here) — and still 200 on the wire.
        state.counters.parse_errors += 1;
        return;
    };
    let now = now_ms();
    let kind = match path {
        "/v1/traces" => "traces",
        "/v1/logs" => "logs",
        "/v1/metrics" => "metrics",
        _ => classify(&payload),
    };
    let spans: Vec<Value> = match kind {
        "traces" => {
            state.counters.traces_payloads += 1;
            state.ingest.process_traces(&payload, path)
        }
        "logs" => {
            state.counters.logs_payloads += 1;
            // gen_ai injection needs the live span window (a later P4 slice) — never inject here.
            state.ingest.process_logs(&payload, now, |_, _, _| false).spans
        }
        "metrics" => {
            // Accepted and DISCARDED — the frozen behavior.
            state.counters.metrics_payloads += 1;
            Vec::new()
        }
        _ => Vec::new(),
    };
    for span in &spans {
        state.writer.append(span, now);
        state.counters.spans_appended += 1;
    }
    if !spans.is_empty() {
        state.data_version += 1;
    }
    for span in spans {
        state.window.add(span, now);
    }
    if state.writer.pending_appends() > 0 {
        // Flush per payload for now: durable and deterministic for tests; batching cadence is
        // internal (not wire-frozen) and can move to a timer when rates justify it.
        state.flush_spans();
    }
}

async fn handle(
    req: Request<Incoming>,
    state: Arc<Mutex<CoreState>>,
) -> Result<Response<Full<Bytes>>, String> {
    // The discovery probe matches the RAW url (path+query, no strip) — server.ts:4414 compares
    // req.url exactly, so a query string must NOT match.
    let raw_url = req.uri().path_and_query().map(|pq| pq.as_str().to_owned()).unwrap_or_else(|| req.uri().path().to_owned());
    if req.method() == Method::GET && raw_url == "/agentlens/standalone" {
        let mut resp = Response::new(Full::new(Bytes::from_static(br#"{"agentlens":true,"kind":"standalone"}"#)));
        resp.headers_mut().insert("Content-Type", hyper::header::HeaderValue::from_static("application/json"));
        return Ok(resp);
    }
    if req.method() != Method::POST {
        return Ok(Response::new(Full::new(Bytes::new())));
    }

    let path = req.uri().path().to_owned();
    let mut body = req.into_body();
    let mut buf: Vec<u8> = Vec::new();
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|e| format!("body read: {e}"))?;
        if let Some(data) = frame.data_ref() {
            if buf.len() + data.len() > MAX_BODY_BYTES {
                // Overflow ABORTS the connection with no response (the Err propagates out of the
                // service and hyper drops the socket) — the frozen twin of req.socket.destroy().
                return Err("body over 64MB cap — connection aborted".to_owned());
            }
            buf.extend_from_slice(data);
        }
    }

    {
        let mut st = state.lock().map_err(|_| "state poisoned".to_owned())?;
        ingest_post(&mut st, &path, &buf);
    }
    Ok(Response::new(Full::new(Bytes::new())))
}

/// Serve the OTLP contract on `addr` until the process ends. Returns the BOUND address (for
/// ephemeral test ports) via the callback before blocking on accept.
pub async fn serve_otlp(
    addr: SocketAddr,
    state: Arc<Mutex<CoreState>>,
    on_bound: impl FnOnce(SocketAddr),
) -> std::io::Result<()> {
    let listener = tokio::net::TcpListener::bind(addr).await?;
    on_bound(listener.local_addr()?);
    loop {
        let (stream, _) = listener.accept().await?;
        let io = hyper_util::rt::TokioIo::new(stream);
        let state = state.clone();
        tokio::spawn(async move {
            let svc = service_fn(move |req| handle(req, state.clone()));
            // An Err from the service aborts this connection — exactly the overflow contract.
            let _ = hyper::server::conn::http1::Builder::new().serve_connection(io, svc).await;
        });
    }
}

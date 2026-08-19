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
use serde_json::Value;

use agentlens_ingest::IngestState;
use agentlens_spanstore::writer::SpanStoreWriter;

pub mod pricing;
pub mod session_store;
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
    /// The 5-minute live window the UI summary is computed over (P4e) — fed by every ingested
    /// span, exactly as the TS collector's addSpan feeds SessionStore.
    pub store: session_store::SessionStore,
    /// Bumped on every data change; the coalesced SSE pusher rebuilds only when it moved
    /// (server.ts dataVersion).
    pub data_version: u64,
    /// The dashboard live-reload fingerprint carried in every update frame (server.ts BUILD_ID —
    /// bundle mtimes there; here the process start, the same "changes on restart" contract).
    pub build_id: String,
}

impl CoreState {
    pub fn open(spans_dir: &std::path::Path) -> CoreState {
        let now = now_ms();
        CoreState {
            ingest: IngestState::default(),
            writer: SpanStoreWriter::open(spans_dir),
            counters: Counters::default(),
            store: session_store::SessionStore::new(now as f64),
            data_version: 0,
            build_id: now.to_string(),
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
        state.store.add_span(span, now as f64);
    }
    if state.writer.pending_appends() > 0 {
        // Flush per payload for now: durable and deterministic for tests; batching cadence is
        // internal (not wire-frozen) and can move to a timer when rates justify it.
        state.writer.flush();
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

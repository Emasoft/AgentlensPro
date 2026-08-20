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
//!   - fallback → 404, NO Content-Type, body `Not found`.
//! Deferred (documented, not silently dropped): admission-control 503s, base-path strip.

use std::sync::{Arc, Mutex};

use bytes::Bytes;
use http_body_util::{Full, StreamBody};
use hyper::body::Frame;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use serde_json::{Map, Value};
use tokio::sync::broadcast;

use crate::update_payload::build_update_payload;
use crate::CoreState;

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

/// pushUpdate — ONE full rebuild broadcast to every client. Called from the coalesced timer.
pub fn push_update(state: &Arc<Mutex<CoreState>>, hub: &SseHub, now_ms: f64) {
    if hub.client_count() == 0 {
        return;
    }
    let payload = {
        let mut st = match state.lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        let summary = st.build_session_summary(now_ms);
        let gaps = crate::collector_lifecycle::compute_gaps(&st.lifecycle, crate::collector_lifecycle::MIN_GAP_MS);
        build_update_payload(&summary, &st.window.spans, &st.build_id, gaps, now_ms).to_string()
    };
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
    let first = {
        let mut st = state.lock().map_err(|_| "state poisoned".to_owned())?;
        let summary = st.build_session_summary(now_ms);
        let gaps = crate::collector_lifecycle::compute_gaps(&st.lifecycle, crate::collector_lifecycle::MIN_GAP_MS);
        build_update_payload(&summary, &st.window.spans, &st.build_id, gaps, now_ms).to_string()
    };
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

fn error_json(msg: &str) -> String {
    let mut m = Map::new();
    m.insert("error".into(), msg.into());
    Value::Object(m).to_string()
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
    let viewer_header_present = req.headers().contains_key("x-agentlens-viewer");
    let method = req.method().clone();

    let mut resp = if method != Method::GET && method != Method::HEAD && disallowed {
        json_response(StatusCode::FORBIDDEN, error_json("cross-origin request refused"))
    } else if viewer_header_present {
        json_response(StatusCode::FORBIDDEN, error_json("unverifiable viewer assertion — rejected (AgentlensPro#4 §B5)"))
    } else if path == "/events" {
        sse_response(&state, &hub, crate::now_ms() as f64)?
    } else if method == Method::GET && path == "/api/summary" {
        let body = {
            let mut st = state.lock().map_err(|_| "state poisoned".to_owned())?;
            st.build_stripped_summary(crate::now_ms() as f64).to_string()
        };
        json_response(StatusCode::OK, body)
    } else if method == Method::GET && path == "/api/server-stats" {
        let body = {
            let st = state.lock().map_err(|_| "state poisoned".to_owned())?;
            crate::server_stats::server_stats(&st, crate::now_ms()).to_string()
        };
        json_response(StatusCode::OK, body)
    } else if method == Method::GET && path == "/api/embed-status" {
        // The wiring probe (TRDD-1ZH1D5EG). NOT PORTED: the embed key (src/embedAuth.ts) — with
        // no key loaded every viewer is `standalone` (a present header already 403'd above) and
        // keyLoaded is false, exactly what the TS server reports on a machine without the key.
        let mut r = json_response(StatusCode::OK, r#"{"mode":"standalone","role":null,"keyLoaded":false}"#.to_owned());
        r.headers_mut().insert("Vary", hyper::header::HeaderValue::from_static("X-Agentlens-Viewer"));
        r
    } else if method == Method::GET && path == "/api/hook-config" {
        let body = {
            let st = state.lock().map_err(|_| "state poisoned".to_owned())?;
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
            let mut st = state.lock().map_err(|_| "state poisoned".to_owned())?;
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
            let mut st = state.lock().map_err(|_| "state poisoned".to_owned())?;
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
                    let mut st = state.lock().map_err(|_| "state poisoned".to_owned())?;
                    st.clear_spans();
                }
                push_update(&state, &hub, crate::now_ms() as f64);
            }
            Ok(_) => {}
            Err(e) => eprintln!("alcore: malformed /action body: {e}"),
        }
        Response::new(boxed_full(Bytes::new()))
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
                    let mut st = state.lock().map_err(|_| "state poisoned".to_owned())?;
                    crate::hook_events::ingest_hook_event(&mut st, &payload, crate::now_ms())
                };
                json_response(StatusCode::from_u16(status).unwrap_or(StatusCode::OK), body.to_string())
            }
        }
    } else if method == Method::GET && path == "/api/hook-events" {
        let q = query_of(&req);
        let num = |k: &str| q.get(k).filter(|v| !v.is_empty()).and_then(|v| v.parse::<i64>().ok());
        let events = {
            let st = state.lock().map_err(|_| "state poisoned".to_owned())?;
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
            let st = state.lock().map_err(|_| "state poisoned".to_owned())?;
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
                        let mut st = state.lock().map_err(|_| "state poisoned".to_owned())?;
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
            let st = state.lock().map_err(|_| "state poisoned".to_owned())?;
            let mut ids: Vec<&str> = st
                .window
                .spans
                .iter()
                .filter_map(Value::as_object)
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
            let mut st = state.lock().map_err(|_| "state poisoned".to_owned())?;
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
    } else if method == Method::GET && path == "/api/debug/requests" {
        // Row 26: the recent-request ring + heap pressure. No V8 ⇒ the heap object is honest
        // zeros (over: false), as /api/server-stats reports; rssMb per row carries the story.
        let body = {
            let st = state.lock().map_err(|_| "state poisoned".to_owned())?;
            serde_json::json!({
                "heap": { "heapUsedMb": 0, "limitMb": 0, "hwmMb": 0, "over": false },
                "requests": st.requests.recent(200),
            })
            .to_string()
        };
        json_response(StatusCode::OK, body)
    } else if method == Method::GET && path == "/api/debug/log-scan-stats" {
        let body = {
            let st = state.lock().map_err(|_| "state poisoned".to_owned())?;
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
            let mut st = state.lock().map_err(|_| "state poisoned".to_owned())?;
            let status = st.live_burn_status(now);
            let account = st.burn.current_account(now);
            crate::burn::runtime::enrich_burn_status(&status, &account).to_string()
        };
        json_response(StatusCode::OK, body)
    } else if method == Method::GET && path == "/api/collector-gaps" {
        // Row 29 (server.ts:4038, TRDD-PJC8N1HO spec 2): the lifecycle-derived downtime windows.
        // The TS wraps computeCollectorGaps in a catch → []; the Rust compute cannot throw.
        let body = {
            let st = state.lock().map_err(|_| "state poisoned".to_owned())?;
            serde_json::json!({ "collectorGaps": crate::collector_lifecycle::compute_gaps(&st.lifecycle, crate::collector_lifecycle::MIN_GAP_MS) })
                .to_string()
        };
        json_response(StatusCode::OK, body)
    } else if method == Method::GET && path.starts_with("/api/timeline/") {
        // Row 30 (server.ts:4044): the lazy per-session detail — resolveSessionCard's
        // reparse-on-demand for a disk-restored stripped card, plus the TRDD-5GFSFX0Q graft of
        // the OTEL api_request attribution a log-winning Claude card lacks. Always 200; an
        // unknown id serves the empty shape. generatedFiles rides THIS payload only —
        // strip_session_detail drops it from /api/summary (TRDD-ZS1GDXVY).
        let session_id = percent_decode(&path["/api/timeline/".len()..]);
        let now = crate::now_ms();
        let body = {
            let mut st = state.lock().map_err(|_| "state poisoned".to_owned())?;
            let summary = st.build_session_summary(now as f64);
            let mut session: Option<Value> = summary
                .get("sessions")
                .and_then(Value::as_array)
                .and_then(|ss| ss.iter().find(|s| s.get("sessionId").and_then(Value::as_str) == Some(session_id.as_str())))
                .cloned();
            // resolveSessionCard: an empty (or absent) timeline on a session a log file backs ⇒
            // one fresh full parse of that file, re-stored (put_log_session bumps data_version,
            // as the TS putLogSession does). NOT PORTED: statuslineReader.overlay on the
            // reparsed card (the statusline store is unported — the P4m note).
            let timeline_empty = session
                .as_ref()
                .is_some_and(|s| s.get("timeline").and_then(Value::as_array).is_none_or(Vec::is_empty));
            if timeline_empty && st.log_sessions.contains_key(&session_id) {
                if let Some(scanned) = crate::log_reader::reparse_session(&st.log_env, &session_id, now) {
                    if let Some(mut card) = scanned.cards.into_iter().next() {
                        // ingest_scanned's accountId stamp — the TS parser stamps it natively
                        // inside _buildCard, so the reparsed card must carry it here too.
                        if let Some(obj) = card.as_object_mut() {
                            let acct =
                                obj.get("sessionId").and_then(Value::as_str).and_then(|sid| st.accounts.account_for(sid)).map(str::to_owned);
                            if let Some(a) = acct {
                                obj.insert("accountId".into(), Value::from(a));
                            }
                        }
                        st.put_log_session(card.clone());
                        session = Some(card);
                    }
                }
            }
            // TRDD-5GFSFX0Q: graft the displaced OTEL twin's api_request entries onto the
            // SERVED copy only — the graft runs AFTER put_log_session, so the stored card stays
            // pure (the TS grafts onto a shallow copy for the same reason).
            if let Some(s) = session.as_mut() {
                let claude_log = s.get("source").and_then(Value::as_str) == Some("claude_code")
                    && s.get("dataSource").and_then(Value::as_str) == Some("log");
                if claude_log {
                    if let Some(entries) = st.otel_attribution.get(&session_id).filter(|e| !e.is_empty()) {
                        let log_tl: Vec<Value> = s.get("timeline").and_then(Value::as_array).cloned().unwrap_or_default();
                        let grafted = crate::feed_merge::graft_otel_attribution(&log_tl, Some(entries));
                        if let Some(obj) = s.as_object_mut() {
                            obj.insert("timeline".into(), Value::Array(grafted));
                        }
                    }
                }
            }
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
        let mut r = Response::new(boxed_full(Bytes::from_static(b"Not found")));
        *r.status_mut() = StatusCode::NOT_FOUND;
        r
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
        if let Ok(mut st) = state.lock() {
            let dur = t0.elapsed().as_millis() as i64;
            st.requests.record(method.as_str(), &path, resp.status().as_u16(), dur, bytes, crate::now_ms());
        }
    }
    Ok(resp)
}

/// Serve the UI/API contract on `addr` until the process ends. `hub` is the SSE fan-out the
/// coalesced pusher (`push_update`) broadcasts into.
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
/// (`firedBurnAlerts` dedupe). NOT PORTED: macNotify (opt-in osascript) and the
/// account-state-timeline sampler (TRDD-YQZ9P8IL — its store is unported).
pub async fn run_burn_tick(state: Arc<Mutex<CoreState>>, hub: Arc<SseHub>) {
    let mut fired: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut tick = tokio::time::interval(std::time::Duration::from_secs(4));
    loop {
        tick.tick().await;
        let mut frames: Vec<String> = Vec::new();
        {
            let Ok(mut st) = state.lock() else { continue };
            let now = crate::now_ms() as f64;
            let status = st.live_burn_status(now);
            st.burn.last_status = Some(status.clone());
            let account = st.burn.current_account(now);
            let enriched = crate::burn::runtime::enrich_burn_status(&status, &account);
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
                    }
                }
            }
            // Clear fired keys whose condition cleared so the alert can re-fire if it returns.
            fired.retain(|id| active.contains(id));
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
        let version = match state.lock() {
            Ok(st) => st.data_version,
            Err(_) => continue,
        };
        if version != last_pushed {
            last_pushed = version;
            push_update(&state, &hub, crate::now_ms() as f64);
        }
    }
}

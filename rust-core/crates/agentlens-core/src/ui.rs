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
                        let mut st = state.lock().map_err(|_| "state poisoned".to_owned())?;
                        st.statusline.append(payload, stream, crate::now_ms() as f64);
                        st.persist.statusline_samples += 1;
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
    } else if method == Method::GET && path == "/api/burn-risk" {
        // Row 12 (server.ts:3519): checkBurnRisk over the three feeds + the verbatim spawning
        // calls behind an active fan-out. The TS 500-on-throw path is unreachable here (the
        // Rust compute cannot throw); every feed absence is reported in `sources`, not as an error.
        let body = {
            let mut st = state.lock().map_err(|_| "state poisoned".to_owned())?;
            st.burn_risk_report(crate::now_ms() as f64).to_string()
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
            let Ok(mut st) = state.lock() else { return no_content() };
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
            let st = state.lock().map_err(|_| "state poisoned".to_owned())?;
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
                    let mut st = state.lock().map_err(|_| "state poisoned".to_owned())?;
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
        let data_dir = { state.lock().map_err(|_| "state poisoned".to_owned())?.data_dir.clone() };
        let (status, body) = tokio::task::spawn_blocking(move || crate::body_archive::bodies_export(&data_dir, &buf))
            .await
            .map_err(|e| e.to_string())?;
        json_response(StatusCode::from_u16(status).unwrap_or(StatusCode::OK), body.to_string())
    } else if method == Method::POST && path == "/api/bodies/purge" {
        // Row 15 (server.ts:3711): the request body is never read (the TS handler does not
        // consume it either); destruction is per-volume verify-before-delete (TRDD-K3WDPR7M).
        let data_dir = { state.lock().map_err(|_| "state poisoned".to_owned())?.data_dir.clone() };
        let (status, body) = tokio::task::spawn_blocking(move || crate::body_archive::bodies_purge(&data_dir))
            .await
            .map_err(|e| e.to_string())?;
        json_response(StatusCode::from_u16(status).unwrap_or(StatusCode::OK), body.to_string())
    } else if method == Method::GET && path == "/api/collector-gaps" {
        // Row 29 (server.ts:4038, TRDD-PJC8N1HO spec 2): the lifecycle-derived downtime windows.
        // The TS wraps computeCollectorGaps in a catch → []; the Rust compute cannot throw.
        let body = {
            let st = state.lock().map_err(|_| "state poisoned".to_owned())?;
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
            let st = state.lock().map_err(|_| "state poisoned".to_owned())?;
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
            let st = state.lock().map_err(|_| "state poisoned".to_owned())?;
            st.log_env.clone()
        };
        let history = tokio::task::spawn_blocking(move || {
            crate::context_history::build_context_history(&env, &session_id, parent.as_deref())
        })
        .await
        .map_err(|e| format!("history build join failed: {e}"))?;
        json_response(StatusCode::OK, serde_json::json!({ "history": history.unwrap_or(Value::Null) }).to_string())
    } else if method == Method::GET && path.starts_with("/api/conversation/") {
        // Row 34 (server.ts:4271). The narrative reconstruction — same streaming discipline and
        // same `{x: null}`-is-a-valid-200 contract as rows 32-33.
        let session_id = percent_decode(&path["/api/conversation/".len()..]);
        let parent = query_of(&req).get("parent").map(|s| s.to_owned()).filter(|s| !s.is_empty());
        let env = {
            let st = state.lock().map_err(|_| "state poisoned".to_owned())?;
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
        let cached = {
            let mut st = state.lock().map_err(|_| "state poisoned".to_owned())?;
            st.composition.get_cached(&session_id)
        };
        let comp = match cached {
            Some(c) => c,
            None => {
                let refs = {
                    let st = state.lock().map_err(|_| "state poisoned".to_owned())?;
                    crate::context_composition_index::resolve_refs(&st.bodies, &session_id)
                };
                let sid = session_id.clone();
                let built = tokio::task::spawn_blocking(move || {
                    crate::context_composition_index::build_session_composition(&sid, &refs, None, now)
                })
                .await
                .map_err(|e| format!("composition build join failed: {e}"))?;
                let mut st = state.lock().map_err(|_| "state poisoned".to_owned())?;
                st.composition.put(&session_id, built.clone());
                built
            }
        };
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
                let pointer = {
                    let st = state.lock().map_err(|_| "state poisoned".to_owned())?;
                    // requestPointers(session)[turn - 1] — 1-based turns.
                    let ptrs = st.bodies.request_pointers(&session_id);
                    let idx = t - 1.0;
                    if idx < 0.0 { None } else { ptrs.get(idx as usize).and_then(|p| p.body_ref.clone()) }
                };
                let block = match pointer.filter(|b| !b.is_empty()) {
                    // Two DISTINCT error shapes, both 200 (not an error status): the caller must be
                    // able to tell "no body captured for that turn" from "that block does not exist".
                    None => serde_json::json!({
                        "sessionId": session_id,
                        "turn": crate::summarize::helpers::num(t),
                        "message": format!("No raw body for call/turn {} of session {session_id} in the live registry (lazy — historical bodies are not indexed).", crate::summarize::helpers::fmt_js_num(t)),
                    }),
                    Some(body_ref) => {
                        let read = tokio::task::spawn_blocking(move || {
                            crate::context_composition_index::read_block_content(&body_ref, bi as i64, full)
                        })
                        .await
                        .map_err(|e| format!("block-content join failed: {e}"))?;
                        match read {
                            None => serde_json::json!({
                                "sessionId": session_id,
                                "turn": crate::summarize::helpers::num(t),
                                "blockIndex": crate::summarize::helpers::num(bi),
                                "message": format!("No block {} at turn {}.", crate::summarize::helpers::fmt_js_num(bi), crate::summarize::helpers::fmt_js_num(t)),
                            }),
                            Some(b) => {
                                // `{ sessionId, turn, ...block }` — the spread puts the block's own
                                // keys AFTER these two, in the block's order.
                                let mut m = serde_json::Map::new();
                                m.insert("sessionId".into(), Value::String(session_id.clone()));
                                m.insert("turn".into(), crate::summarize::helpers::num(t));
                                if let Some(o) = b.as_object() {
                                    for (k, v) in o {
                                        m.insert(k.clone(), v.clone());
                                    }
                                }
                                Value::Object(m)
                            }
                        }
                    }
                };
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

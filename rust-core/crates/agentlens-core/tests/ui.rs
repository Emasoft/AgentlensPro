//! The frozen UI/API wire contract, exercised over a REAL socket (TRDD-DMWOBWFH P4e; spec =
//! the P4a freeze report §1): the CORS echo rule, the viewer-role gate, the CSRF gate,
//! `GET /api/summary` over spans the OTLP listener ingested, and the 404 fallback.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};

fn start_servers() -> (std::net::SocketAddr, std::net::SocketAddr, Arc<Mutex<agentlens_core::CoreState>>) {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("al-core-ui-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    let spans = dir.join("spans");
    std::fs::create_dir_all(&spans).unwrap();
    let state = Arc::new(Mutex::new(agentlens_core::CoreState::open(&spans)));
    let (otx, orx) = std::sync::mpsc::channel();
    let (utx, urx) = std::sync::mpsc::channel();
    let (s1, s2, s3) = (state.clone(), state.clone(), state.clone());
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            let hub = Arc::new(agentlens_core::ui::SseHub::default());
            tokio::spawn(agentlens_core::ui::run_push_loop(s3, hub.clone()));
            let otlp = agentlens_core::serve_otlp("127.0.0.1:0".parse().unwrap(), s1, move |b| otx.send(b).unwrap());
            let ui = agentlens_core::ui::serve_ui("127.0.0.1:0".parse().unwrap(), s2, hub, move |b| utx.send(b).unwrap());
            let _ = tokio::join!(otlp, ui);
        });
    });
    (orx.recv().unwrap(), urx.recv().unwrap(), state)
}

fn request(addr: std::net::SocketAddr, raw: &str) -> String {
    let mut s = TcpStream::connect(addr).unwrap();
    s.write_all(raw.as_bytes()).unwrap();
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    out
}

fn get(addr: std::net::SocketAddr, path: &str, extra_headers: &str) -> String {
    request(addr, &format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:3000\r\n{extra_headers}Connection: close\r\n\r\n"))
}

fn body_of(resp: &str) -> &str {
    resp.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("")
}

/// Decode a (possibly partial) chunked transfer-encoded body into the raw byte stream — both
/// engines stream SSE with `Transfer-Encoding: chunked` (Node's res.write without a
/// Content-Length does the same), and the freeze describes the DECODED stream an EventSource
/// sees.
fn dechunk(body: &str) -> String {
    let mut out = String::new();
    let mut rest = body;
    loop {
        let Some((size_line, after)) = rest.split_once("\r\n") else { break };
        let Ok(size) = usize::from_str_radix(size_line.trim(), 16) else { break };
        if size == 0 || after.len() < size {
            break;
        }
        out.push_str(&after[..size]);
        rest = after[size..].strip_prefix("\r\n").unwrap_or("");
    }
    out
}

fn trace_payload() -> String {
    serde_json::json!({
        "resourceSpans": [{ "scopeSpans": [{ "spans": [
            {
                "name": "claude_code.interaction",
                "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "spanId": "aaaaaaaaaaaaaaaa",
                "startTimeUnixNano": "1755600000000000000", "endTimeUnixNano": "1755600010000000000",
                "attributes": [
                    { "key": "session.id", "value": { "stringValue": "sess-ui-1" } },
                    { "key": "user_prompt", "value": { "stringValue": "Fix the bug" } }
                ]
            },
            {
                "name": "claude_code.llm_request",
                "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "spanId": "bbbbbbbbbbbbbbbb", "parentSpanId": "aaaaaaaaaaaaaaaa",
                "startTimeUnixNano": "1755600001000000000", "endTimeUnixNano": "1755600002000000000",
                "attributes": [
                    { "key": "gen_ai.request.model", "value": { "stringValue": "claude-opus-5" } },
                    { "key": "input_tokens", "value": { "intValue": "100" } },
                    { "key": "output_tokens", "value": { "intValue": 40 } },
                    { "key": "stop_reason", "value": { "stringValue": "end_turn" } }
                ]
            }
        ] }] }]
    })
    .to_string()
}

#[test]
fn summary_serves_the_stripped_summarizer_output_over_ingested_spans() {
    let (otlp, ui, _state) = start_servers();
    // Empty window first: the frozen shape with no sessions.
    let empty = get(ui, "/api/summary", "");
    assert!(empty.starts_with("HTTP/1.1 200"), "{empty}");
    assert!(empty.contains("content-type: application/json"), "{empty}");
    let v: serde_json::Value = serde_json::from_str(body_of(&empty)).unwrap();
    assert_eq!(v["sessions"], serde_json::json!([]));
    assert_eq!(v["efficiency"]["totalLlmCalls"], 0);

    let body = trace_payload();
    let r = request(otlp, &format!("POST /v1/traces HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()));
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");

    let full = get(ui, "/api/summary", "");
    let v: serde_json::Value = serde_json::from_str(body_of(&full)).unwrap();
    let sessions = v["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1, "one session from the ingested trace: {v}");
    let s = &sessions[0];
    assert_eq!(s["sessionId"], "sess-ui-1");
    assert_eq!(s["source"], "claude_code");
    assert_eq!(s["model"], "claude-opus-5");
    assert_eq!(s["inputTokens"], 100);
    // stripSessionDetail: the timeline is EMPTIED (the session still counted its LLM call) and
    // the heavy optional keys are absent.
    assert_eq!(s["timeline"], serde_json::json!([]));
    assert_eq!(s["totalLlmCalls"], 1);
    assert!(s.get("fileOps").is_none() && s.get("generatedFiles").is_none());
    assert_eq!(v["efficiency"]["totalInputTokens"], 100);
}

#[test]
fn cors_echoes_only_same_origin_or_loopback_and_never_a_wildcard() {
    let (_otlp, ui, _state) = start_servers();
    let same = get(ui, "/api/summary", "Origin: http://127.0.0.1:3000\r\n");
    assert!(same.contains("access-control-allow-origin: http://127.0.0.1:3000"), "{same}");
    assert!(same.contains("vary: Origin"), "{same}");
    let loopback = get(ui, "/api/summary", "Origin: http://localhost:9999\r\n");
    assert!(loopback.contains("access-control-allow-origin: http://localhost:9999"), "{loopback}");
    let v6 = get(ui, "/api/summary", "Origin: http://[::1]:5\r\n");
    assert!(v6.contains("access-control-allow-origin: http://[::1]:5"), "IPv6 loopback (brackets stripped): {v6}");
    let foreign = get(ui, "/api/summary", "Origin: https://evil.example\r\n");
    assert!(foreign.starts_with("HTTP/1.1 200"), "a GET still answers: {foreign}");
    assert!(!foreign.contains("access-control-allow-origin"), "no ACAO for a foreign origin: {foreign}");
    let none = get(ui, "/api/summary", "");
    assert!(!none.contains("access-control-allow-origin"), "no Origin ⇒ no ACAO: {none}");
    assert!(!same.contains("access-control-allow-origin: *"), "never the wildcard");
}

#[test]
fn csrf_gate_refuses_non_get_from_a_foreign_origin_and_viewer_header_is_unverifiable() {
    let (_otlp, ui, _state) = start_servers();
    let csrf = request(ui, "POST /api/import HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nOrigin: https://evil.example\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    assert!(csrf.starts_with("HTTP/1.1 403"), "{csrf}");
    assert!(csrf.contains("content-type: application/json"), "{csrf}");
    assert_eq!(body_of(&csrf), r#"{"error":"cross-origin request refused"}"#);

    // No embed key loaded ⇒ any present viewer assertion is unverifiable ⇒ 403 (embedAuth rule).
    let viewer = get(ui, "/api/summary", "x-agentlens-viewer: v1.deadbeef\r\n");
    assert!(viewer.starts_with("HTTP/1.1 403"), "{viewer}");
    assert_eq!(body_of(&viewer), r#"{"error":"unverifiable viewer assertion — rejected (AgentlensPro#4 §B5)"}"#);
}

#[test]
fn events_streams_the_ping_then_update_frames_on_connect_and_on_the_coalesced_push() {
    let (otlp, ui, _state) = start_servers();
    let mut s = TcpStream::connect(ui).unwrap();
    s.set_read_timeout(Some(std::time::Duration::from_secs(8))).unwrap();
    // POST (no method check) also opens a stream — the frozen quirk.
    s.write_all(b"POST /events HTTP/1.1\r\nHost: x\r\n\r\n").unwrap();
    let mut buf = Vec::new();
    let read_until = |s: &mut TcpStream, buf: &mut Vec<u8>, needle: &str| {
        let mut chunk = [0u8; 65536];
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        while !String::from_utf8_lossy(buf).contains(needle) {
            assert!(std::time::Instant::now() < deadline, "timed out waiting for {needle:?}: {}", String::from_utf8_lossy(buf));
            let n = s.read(&mut chunk).unwrap();
            assert!(n > 0, "stream closed before {needle:?}");
            buf.extend_from_slice(&chunk[..n]);
        }
    };
    read_until(&mut s, &mut buf, "\"type\":\"update\"");
    let text = String::from_utf8_lossy(&buf).into_owned();
    assert!(text.starts_with("HTTP/1.1 200"), "{text}");
    let lower = text.to_lowercase();
    assert!(lower.contains("content-type: text/event-stream"), "{text}");
    assert!(lower.contains("cache-control: no-cache"), "{text}");
    assert!(lower.contains("connection: keep-alive"), "{text}");
    assert!(lower.contains("transfer-encoding: chunked"), "streamed like Node's res.write: {text}");
    let body = dechunk(body_of(&text));
    // First bytes: the ping, then the on-connect update frame — no event: names, no ids.
    assert!(body.starts_with(":\n\ndata: {\"type\":\"update\""), "frame preamble: {body:?}");
    let first = body.split("\n\n").nth(1).unwrap().strip_prefix("data: ").unwrap();
    let v: serde_json::Value = serde_json::from_str(first).unwrap();
    for k in ["buildId", "summary", "sessionSummary", "sidebar", "analyticsData", "collectorGaps",
              "isActive", "lastActivityMs", "sessionCount", "agentSources", "currentSession", "burnRate",
              "avgInputTokens", "avgOutputTokens"] {
        assert!(v.get(k).is_some(), "update frame carries {k}: {first}");
    }
    assert_eq!(v["summary"], serde_json::json!({"toolCalls": {}}));
    assert_eq!(v["sessionCount"], 0);

    // Ingest → the coalesced push (≤ PUSH_COALESCE_MS later) broadcasts a second update frame
    // that now carries the session.
    let payload = trace_payload();
    let r = request(otlp, &format!("POST /v1/traces HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len()));
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    read_until(&mut s, &mut buf, "sess-ui-1");
    let text = String::from_utf8_lossy(&buf).into_owned();
    let decoded = dechunk(body_of(&text));
    let frames: Vec<&str> = decoded.split("\n\n").filter(|f| f.starts_with("data: ")).collect();
    assert!(frames.len() >= 2, "a pushed update frame followed the connect frame: {}", frames.len());
    let last: serde_json::Value = serde_json::from_str(frames.last().unwrap().strip_prefix("data: ").unwrap()).unwrap();
    assert_eq!(last["sessionCount"], 1);
    assert_eq!(last["sessionSummary"]["sessions"][0]["sessionId"], "sess-ui-1");
    assert_eq!(last["sessionSummary"]["sessions"][0]["timeline"], serde_json::json!([]), "stripped in the frame too");
    assert_eq!(last["currentSession"]["model"], "claude-opus-5");
}

#[test]
fn summary_merges_log_sessions_under_the_feed_doctrine() {
    let (otlp, ui, state) = start_servers();
    let payload = trace_payload();
    let r = request(otlp, &format!("POST /v1/traces HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len()));
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    // A log transcript card for the SAME Claude session (log wins) + a log-only codex card.
    state.lock().unwrap().put_log_session(serde_json::json!({
        "sessionId": "sess-ui-1", "source": "claude_code", "dataSource": "log", "startTime": "2025-08-19T10:40:00.000Z",
        "inputTokens": 9999, "outputTokens": 1, "cacheReadTokens": 0, "cacheCreateTokens": 0, "timeline": [{"type":"llm"}],
        "model": "claude-opus-5", "userRequest": "from the transcript", "totalLlmCalls": 4, "totalToolCalls": 0, "errors": 0,
        "cacheHitRate": 0, "durationMs": 1, "filesChanged": [], "filesRead": [], "filesSearched": [], "filesWritten": [],
        "toolCounts": {}, "outcome": "unknown", "backgroundSpans": [], "loopSignals": []
    }));
    state.lock().unwrap().put_log_session(serde_json::json!({
        "sessionId": "codex-log-only", "source": "codex", "dataSource": "log", "startTime": "2025-08-19T11:00:00.000Z",
        "inputTokens": 3, "outputTokens": 1, "cacheReadTokens": 0, "cacheCreateTokens": 0, "timeline": []
    }));
    let full = get(ui, "/api/summary", "");
    let v: serde_json::Value = serde_json::from_str(body_of(&full)).unwrap();
    let sessions = v["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2, "OTEL twin displaced, codex log-only kept: {v}");
    // Newest first.
    assert_eq!(sessions[0]["sessionId"], "codex-log-only");
    assert_eq!(sessions[0]["tokensSource"], "log");
    let claude = &sessions[1];
    assert_eq!(claude["sessionId"], "sess-ui-1");
    assert_eq!(claude["dataSource"], "log", "the LOG card serves for Claude");
    assert_eq!(claude["inputTokens"], 9999);
    assert_eq!(claude["tokensSource"], "log");
    assert!(claude["coverageNote"].as_str().unwrap().contains("displaced"), "{claude}");
    assert_eq!(claude["timeline"], serde_json::json!([]), "still stripped on the wire");
}

#[test]
fn unknown_routes_and_options_fall_through_to_the_bare_404() {
    let (_otlp, ui, _state) = start_servers();
    for raw in [
        "GET /api/nope HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
        "OPTIONS /api/summary HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
    ] {
        let r = request(ui, raw);
        assert!(r.starts_with("HTTP/1.1 404"), "{r}");
        assert!(!r.to_lowercase().contains("content-type"), "404 carries NO Content-Type: {r}");
        assert_eq!(body_of(&r), "Not found");
    }
}

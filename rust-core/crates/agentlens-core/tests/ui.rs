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
    std::fs::create_dir_all(&dir).unwrap();
    let state = Arc::new(Mutex::new(agentlens_core::CoreState::open(&dir)));
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

fn post(addr: std::net::SocketAddr, path: &str, body: &str) -> String {
    request(addr, &format!("POST {path} HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()))
}

/// The small frozen routes (freeze §1 rows 1, 10, 11, 16, 22, 25): exact status, headers, bodies.
#[test]
fn small_routes_embed_status_hook_config_clear_action_and_log_scan_stats() {
    let (otlp, ui, state) = start_servers();
    let data_dir = state.lock().unwrap().data_dir.clone();

    // Row 1: the wiring probe, standalone with no key, Vary on the viewer header.
    let r = get(ui, "/api/embed-status", "");
    assert!(r.starts_with("HTTP/1.1 200") && r.contains("vary: X-Agentlens-Viewer"), "{r}");
    assert_eq!(body_of(&r), r#"{"mode":"standalone","role":null,"keyLoaded":false}"#);

    // Row 10: defaults + the file path; row 11: a patch is merged, persisted (2-space JSON +
    // newline, atomic), unknown keys ignored, a junk gateMode keeps the current one.
    let r = get(ui, "/api/hook-config", "");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v["config"], serde_json::json!({ "captureEnabled": true, "gateEnabled": true, "gateMode": "enforce", "advisorEnabled": true, "cacheGuardEnabled": true }));
    assert_eq!(v["file"], data_dir.join("hook-config.json").to_string_lossy().as_ref());
    let r = post(ui, "/api/hook-config", r#"{"gateMode":"warn","advisorEnabled":false,"bogus":1}"#);
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v["applied"], true);
    assert_eq!(v["config"]["gateMode"], "warn");
    assert_eq!(v["config"]["advisorEnabled"], false);
    assert!(v["config"].get("bogus").is_none());
    let on_disk = std::fs::read_to_string(data_dir.join("hook-config.json")).unwrap();
    assert!(on_disk.starts_with("{\n  \"captureEnabled\": true,\n") && on_disk.ends_with("}\n"), "{on_disk}");
    let r = post(ui, "/api/hook-config", r#"{"gateMode":"loud"}"#);
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v["config"]["gateMode"], "warn", "junk gateMode keeps the current");
    let r = post(ui, "/api/hook-config", "not json");
    assert!(r.starts_with("HTTP/1.1 400"), "{r}");
    assert!(body_of(&r).starts_with(r#"{"error":"#));

    // Row 25: the reader counters + dataVersion (no sweeper in this harness → zeros) and the
    // derived-cache counters: two /api/summary reads with nothing changed = ONE rebuild + one
    // hit; a data change + a read = a second rebuild (server.ts strippedCache by dataVersion).
    get(ui, "/api/summary", "");
    get(ui, "/api/summary", "");
    let r = get(ui, "/api/debug/log-scan-stats", "");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v["incrementalReads"], 0);
    assert_eq!(v["derivedCaches"]["stripped"], serde_json::json!({ "hits": 1, "misses": 1 }));
    assert_eq!(v["derivedCaches"]["sidebar"], serde_json::json!({ "hits": 0, "misses": 0 }));
    assert!(v["dataVersion"].is_u64());
    state.lock().unwrap().put_log_session(serde_json::json!({ "sessionId": "bump", "source": "codex", "timeline": [] }));
    get(ui, "/api/summary", "");
    let r = get(ui, "/api/debug/log-scan-stats", "");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v["derivedCaches"]["stripped"], serde_json::json!({ "hits": 1, "misses": 2 }));
    {
        let mut st = state.lock().unwrap();
        st.log_sessions.clear();
        st.data_version += 1;
    }

    // Rows 22 + 16: ingest a span and a log card, then clear. /action clearAll drops the spans
    // (window + the on-disk store) and keeps the cards; /api/clear drops both. Both answer 200
    // with an empty body and no Content-Type.
    let body = trace_payload();
    request(otlp, &format!("POST /v1/traces HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()));
    state.lock().unwrap().put_log_session(serde_json::json!({ "sessionId": "log-1", "source": "codex", "timeline": [] }));
    {
        let st = state.lock().unwrap();
        assert_eq!(st.window.spans.len(), 2, "the payload's two spans");
        assert_eq!(st.writer.stats().1, 2);
        assert!(data_dir.join("spans").join("index.json").exists());
    }
    let r = post(ui, "/action", r#"{"type":"clearAll"}"#);
    assert!(r.starts_with("HTTP/1.1 200") && !r.to_ascii_lowercase().contains("content-type") && body_of(&r).is_empty(), "{r}");
    {
        let st = state.lock().unwrap();
        assert_eq!(st.window.spans.len(), 0);
        assert_eq!(st.writer.stats(), (0, 0, 0));
        assert!(!data_dir.join("spans").join("index.json").exists(), "the store forgot");
        assert_eq!(st.log_sessions.len(), 1, "clearAll keeps the log cards");
    }
    let r = post(ui, "/action", "garbage");
    assert!(r.starts_with("HTTP/1.1 200"), "malformed body is still 200: {r}");
    let r = post(ui, "/api/clear", "");
    assert!(r.starts_with("HTTP/1.1 200") && body_of(&r).is_empty(), "{r}");
    assert!(state.lock().unwrap().log_sessions.is_empty());
}

/// Freeze row 3 — POST /api/import: buildImportCardStandalone's defaults (transcribed from
/// server.ts — the builder is private to that file, so there is no executable oracle), the
/// dropped/skipped/imported accounting, and the two 400 shapes.
#[test]
fn import_builds_log_cards_with_the_ts_defaults_and_counts_exactly() {
    use agentlens_core::import_card::build_import_card;
    let now = 1_785_578_400_000i64;
    // A minimal record: every default visible. startTime = new Date(now).toISOString().
    let raw = serde_json::json!({ "sessionId": "imp-1", "source": "codex" });
    let card = build_import_card(raw.as_object().unwrap(), now);
    assert_eq!(card, serde_json::json!({
        "sessionId": "imp-1", "traceId": "", "source": "codex", "dataSource": "log",
        "workspace": "", "userRequest": "", "model": "",
        "turns": 0, "totalLlmCalls": 0, "totalToolCalls": 0,
        "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheCreateTokens": 0, "cacheHitRate": 0,
        "durationMs": 0, "startTime": "2026-08-01T10:00:00.000Z",
        "filesRead": [], "filesChanged": [], "filesSearched": [], "filesWritten": [],
        "toolCounts": {}, "errors": 0, "outcome": "unknown", "timeline": [], "backgroundSpans": [], "loopSignals": [],
    }));
    // Key order is the TS literal's (a consumer diffing exports sees the same shape).
    let keys: Vec<&str> = card.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys[0..4], ["sessionId", "traceId", "source", "dataSource"]);
    assert_eq!(keys[keys.len() - 3..], ["timeline", "backgroundSpans", "loopSignals"]);
    // A full record: numbers/strings pass, wrong types fall to defaults, arrays keep only
    // strings, turns feeds totalLlmCalls, a valid tokensSource/coverageNote is carried,
    // an invalid tokensSource is dropped, a non-null outcome passes through as-is.
    let raw = serde_json::json!({
        "sessionId": "imp-2", "source": "claude_code", "turns": 4, "totalToolCalls": "9", "inputTokens": 1.5,
        "filesRead": ["a", 1, "b"], "toolCounts": { "Read": 2 }, "outcome": "success", "startTime": "2026-01-01T00:00:00.000Z",
        "tokensSource": "merged", "coverageNote": "partial", "loopSignals": [{ "k": 1 }], "workspace": 7,
    });
    let card = build_import_card(raw.as_object().unwrap(), now);
    assert_eq!(card["turns"], 4);
    assert_eq!(card["totalLlmCalls"], 4);
    assert_eq!(card["totalToolCalls"], 0, "a string is not a number");
    assert_eq!(card["inputTokens"], 1.5);
    assert_eq!(card["filesRead"], serde_json::json!(["a", "b"]));
    assert_eq!(card["toolCounts"], serde_json::json!({ "Read": 2 }));
    assert_eq!(card["outcome"], "success");
    assert_eq!(card["startTime"], "2026-01-01T00:00:00.000Z");
    assert_eq!(card["tokensSource"], "merged");
    assert_eq!(card["coverageNote"], "partial");
    assert_eq!(card["loopSignals"], serde_json::json!([{ "k": 1 }]));
    assert_eq!(card["workspace"], "");
    let raw = serde_json::json!({ "sessionId": "imp-3", "source": "opencode", "tokensSource": "guess" });
    assert!(build_import_card(raw.as_object().unwrap(), now).get("tokensSource").is_none());

    // The handler over the socket: 2 valid (one a duplicate of a card already present → skipped),
    // 1 bad source + 1 non-object + 1 missing id dropped (counted in total only).
    let (_otlp, ui, state) = start_servers();
    state.lock().unwrap().put_log_session(serde_json::json!({ "sessionId": "dup", "source": "codex", "timeline": [] }));
    let body = serde_json::json!({ "sessions": [
        { "sessionId": "new-1", "source": "copilot", "turns": 2 },
        { "sessionId": "dup", "source": "codex" },
        { "sessionId": "bad", "source": "gemini" },
        "not an object",
        { "source": "codex" },
    ] })
    .to_string();
    let r = post(ui, "/api/import", &body);
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    assert_eq!(body_of(&r), r#"{"imported":1,"skipped":1,"failed":0,"total":5}"#);
    {
        let st = state.lock().unwrap();
        assert_eq!(st.log_sessions.len(), 2);
        assert_eq!(st.log_sessions["new-1"]["totalLlmCalls"], 2);
        assert_eq!(st.log_sessions["dup"]["source"], "codex", "the existing card is untouched");
    }
    let r = post(ui, "/api/import", r#"{"sessions":"nope"}"#);
    assert!(r.starts_with("HTTP/1.1 400"), "{r}");
    assert_eq!(body_of(&r), r#"{"error":"sessions array required"}"#);
    let r = post(ui, "/api/import", "{broken");
    assert!(r.starts_with("HTTP/1.1 400") && body_of(&r).starts_with(r#"{"error":"SyntaxError"#), "{r}");
}

/// Freeze rows 6–8 — the hook-event store: ingest taxonomy, newest-first bounded reads, the
/// lifecycle mapping (STOP/SESSION_END excluded by default, kinds= opt-in), persistence counters.
#[test]
fn hook_events_ingest_read_and_lifecycle_mapping() {
    let (_otlp, ui, state) = start_servers();
    let data_dir = state.lock().unwrap().data_dir.clone();
    let ev = |name: &str, extra: &str| format!(r#"{{"hook_event_name":"{name}","session_id":"sess-hooks"{extra}}}"#);

    // Row 6: the four answer shapes.
    let r = post(ui, "/api/hook-events", &ev("SessionStart", r#","source":"clear""#));
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    assert_eq!(body_of(&r), r#"{"ok":true}"#);
    let r = post(ui, "/api/hook-events", &ev("StatusLineSample", ""));
    assert_eq!(body_of(&r), r#"{"ok":true,"routed":"statusline"}"#);
    let r = post(ui, "/api/hook-events", r#"{"no_name":1}"#);
    assert!(r.starts_with("HTTP/1.1 400"), "{r}");
    assert_eq!(body_of(&r), r#"{"error":"payload must be a JSON object with hook_event_name"}"#);
    let r = post(ui, "/api/hook-events", "broken{");
    assert!(r.starts_with("HTTP/1.1 400"), "{r}");
    post(ui, "/api/hook-events", &ev("Stop", ""));
    post(ui, "/api/hook-events", &ev("StopFailure", r#","error_type":"rate_limit"#).replace("rate_limit", r#"rate_limit""#));
    post(ui, "/api/hook-events", &ev("PreCompact", r#","trigger":"manual""#));
    post(ui, "/api/hook-events", r#"{"hook_event_name":"Notification"}"#);
    // captureEnabled=false: accepted and DROPPED (a non-2xx would look like an outage).
    post(ui, "/api/hook-config", r#"{"captureEnabled":false}"#);
    let r = post(ui, "/api/hook-events", &ev("SessionEnd", r#","reason":"exit""#));
    assert_eq!(body_of(&r), r#"{"ok":true,"dropped":"captureEnabled=false"}"#);
    post(ui, "/api/hook-config", r#"{"captureEnabled":true}"#);

    // The persisted records: verbatim payload, `session` lifted, one daily bucket.
    let buckets: Vec<_> = std::fs::read_dir(data_dir.join("hook-events")).unwrap().flatten().collect();
    assert_eq!(buckets.len(), 1, "one UTC day bucket");
    let stats = get(ui, "/api/server-stats", "");
    let v: serde_json::Value = serde_json::from_str(body_of(&stats)).unwrap();
    assert_eq!(v["hookEvents"]["receivedSinceBoot"], 5, "the statusline route, the 400s and the drop never counted");
    assert_eq!(v["hookEvents"]["files"], 1);
    assert_eq!(v["persistence"]["hookEventWrites"], 5);
    assert!(v["persistence"]["hookEventBytes"].as_u64().unwrap() > 0);

    // Row 7: newest-first, filters, the frozen record shape.
    let r = get(ui, "/api/hook-events", "");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v["count"], 5);
    let events = v["events"].as_array().unwrap();
    assert_eq!(events[0]["ev"], "Notification", "newest first");
    assert_eq!(events[4]["ev"], "SessionStart");
    assert_eq!(events[4]["session"], "sess-hooks");
    assert_eq!(events[4]["payload"], serde_json::json!({ "hook_event_name": "SessionStart", "session_id": "sess-hooks", "source": "clear" }));
    let keys: Vec<&str> = events[4].as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["ts", "ev", "session", "payload"]);
    let r = get(ui, "/api/hook-events?ev=PreCompact", "");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v["count"], 1);
    let r = get(ui, "/api/hook-events?session=nope", "");
    assert_eq!(serde_json::from_str::<serde_json::Value>(body_of(&r)).unwrap()["count"], 0);
    let r = get(ui, "/api/hook-events?limit=2", "");
    assert_eq!(serde_json::from_str::<serde_json::Value>(body_of(&r)).unwrap()["count"], 2);

    // Row 8: STOP excluded by default; Notification never a lifecycle event; kinds= is exact;
    // the event shape is {ts, session?, kind, detail?, ev}.
    let r = get(ui, "/api/lifecycle-events", "");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v["dirExists"], true);
    assert_eq!(v["hookEventsDir"], data_dir.join("hook-events").to_string_lossy().as_ref());
    let kinds: Vec<&str> = v["events"].as_array().unwrap().iter().map(|e| e["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["PRE_COMPACT", "STOP_FAILURE", "CLEAR"], "newest-first; STOP dropped; Notification unmapped");
    let clear_ev = &v["events"][2];
    assert_eq!(clear_ev["detail"], "clear");
    assert_eq!(clear_ev["ev"], "SessionStart");
    let keys: Vec<&str> = clear_ev.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["ts", "session", "kind", "detail", "ev"]);
    let r = get(ui, "/api/lifecycle-events?kinds=STOP,SESSION_END", "");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    let kinds: Vec<&str> = v["events"].as_array().unwrap().iter().map(|e| e["kind"].as_str().unwrap()).collect();
    assert_eq!(kinds, ["STOP"], "the SessionEnd was dropped at capture-off — kinds= re-admits what exists");
}

/// Freeze rows 17–18 — POST /api/write-prompts-file (always 200 empty; the cwd markdown journal)
/// and POST /api/branch-dump (slug gates, sanitized single-segment names, {dir,paths}).
#[test]
fn write_prompts_file_and_branch_dump() {
    let (_otlp, ui, _state) = start_servers();

    // write-prompts-file: first entry creates the header; a second appends; a malformed body is
    // logged and STILL 200 empty. The file lands in the server's cwd.
    let r = post(ui, "/api/write-prompts-file", r#"{"agent":"claude_code","label":"test label","prompt":"the prompt body"}"#);
    assert!(r.starts_with("HTTP/1.1 200") && body_of(&r).is_empty(), "{r}");
    let file = std::env::current_dir().unwrap().join("agentlens-prompts-claude.md");
    let text = std::fs::read_to_string(&file).unwrap();
    assert!(text.starts_with("# AgentLens Prompts — Claude\n\n## "), "{text}");
    assert!(text.contains(" — test label\n\nthe prompt body\n\n---\n\n"), "{text}");
    let r = post(ui, "/api/write-prompts-file", r#"{"agent":"claude_code","label":"second","prompt":"p2"}"#);
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    let text2 = std::fs::read_to_string(&file).unwrap();
    assert!(text2.starts_with(&text) && text2.contains(" — second\n\np2\n\n---\n\n"), "appended");
    assert_eq!(text2.matches("# AgentLens Prompts").count(), 1, "header once");
    let r = post(ui, "/api/write-prompts-file", "not json");
    assert!(r.starts_with("HTTP/1.1 200") && body_of(&r).is_empty(), "fire-and-forget: {r}");
    // The test wrote into the real cwd — stage it out of the tree, never leave repo litter.
    let _ = std::fs::rename(&file, std::env::temp_dir().join("agentlens-prompts-claude.md"));

    // branch-dump: a fixture HOME with one project dir; CLAUDE_CONFIG_DIR steers discovery.
    let home = std::env::temp_dir().join(format!("al-branchdump-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&home);
    let proj = home.join("projects").join("-Users-someone-proj");
    std::fs::create_dir_all(&proj).unwrap();
    std::env::set_var("CLAUDE_CONFIG_DIR", &home);
    let body = serde_json::json!({ "slug": "-Users-someone-proj", "sessionId": "sess/one:two",
        "dumps": [ { "id": "dump_1", "name": "tool output", "content": "hello" },
                   { "id": "bad/id", "name": "x", "content": "never written" },
                   { "id": "dump_2", "content": "no name" } ] })
    .to_string();
    let r = post(ui, "/api/branch-dump", &body);
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    let dump_root = proj.join("agentlens-branch-dumps");
    assert_eq!(v["dir"], dump_root.to_string_lossy().as_ref());
    let paths = v["paths"].as_object().unwrap();
    assert_eq!(paths.len(), 2, "the malformed id was skipped: {v}");
    let p1 = std::path::PathBuf::from(paths["dump_1"].as_str().unwrap());
    assert_eq!(std::fs::read_to_string(&p1).unwrap(), "hello");
    let n1 = p1.file_name().unwrap().to_str().unwrap();
    assert!(n1.starts_with("sess-one-two-") && n1.ends_with("-tool-output-dump_1.txt"), "sanitized single segment: {n1}");
    assert!(std::path::PathBuf::from(paths["dump_2"].as_str().unwrap()).file_name().unwrap().to_str().unwrap().ends_with("-output-dump_2.txt"), "name defaults to 'output'");
    // The gates: a traversal-shaped slug is 400 invalid; a well-formed but non-existent one is
    // 400 unknown; a parse failure is the TS's whole-handler 500.
    let r = post(ui, "/api/branch-dump", r#"{"slug":"a/b","sessionId":"s","dumps":[]}"#);
    assert!(r.starts_with("HTTP/1.1 400"), "{r}");
    assert_eq!(body_of(&r), r#"{"error":"invalid project slug"}"#);
    let r = post(ui, "/api/branch-dump", r#"{"slug":"no-such-project-dir","sessionId":"s","dumps":[]}"#);
    assert!(r.starts_with("HTTP/1.1 400"), "{r}");
    assert_eq!(body_of(&r), r#"{"error":"unknown project slug (no matching Claude project dir)"}"#);
    let r = post(ui, "/api/branch-dump", "broken{");
    assert!(r.starts_with("HTTP/1.1 500"), "{r}");
    std::env::remove_var("CLAUDE_CONFIG_DIR");
}

/// Freeze row 26 — /api/debug/requests: the ring records every request (itself included on the
/// NEXT read), rows carry the frozen fields, rssMb is real, heap is the honest no-V8 zeros.
#[test]
fn debug_requests_serves_the_ring() {
    let (_otlp, ui, _state) = start_servers();
    get(ui, "/api/summary", "");
    get(ui, "/api/summary?x=1", "");
    get(ui, "/no-such-route", "");
    let r = get(ui, "/api/debug/requests", "");
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v["heap"], serde_json::json!({ "heapUsedMb": 0, "limitMb": 0, "hwmMb": 0, "over": false }));
    let rows = v["requests"].as_array().unwrap();
    assert_eq!(rows.len(), 3, "the serving request itself is not yet in its own answer");
    let keys: Vec<&str> = rows[0].as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["ts", "method", "path", "status", "durationMs", "bytes", "heapUsedMb", "rssMb"]);
    assert_eq!((rows[0]["method"].as_str(), rows[0]["path"].as_str(), rows[0]["status"].as_u64()), (Some("GET"), Some("/api/summary"), Some(200)));
    assert_eq!(rows[1]["path"], "/api/summary", "query-stripped");
    assert_eq!(rows[2]["status"], 404);
    assert!(rows[0]["bytes"].as_u64().unwrap() > 0);
    assert!(rows[0]["rssMb"].as_f64().unwrap() > 0.0);
    assert!(rows[0]["ts"].as_str().unwrap().ends_with('Z'));
}

/// The two debug seams: codex-store-groups (the STORE-level codex grouping) and span-attr (the
/// gen_ai overlay observable over the wire — the whole point of P4l's read-time merge).
#[test]
fn debug_seams_codex_groups_and_span_attr() {
    let (otlp, ui, state) = start_servers();
    let now = agentlens_core::now_ms();
    let nano = |ms: i64| (ms as i128 * 1_000_000).to_string();

    // Two codex spans on one trace + one on another + a claude span (never listed).
    let mk = |name: &str, trace: &str, span: &str| serde_json::json!({
        "name": name, "traceId": trace, "spanId": span,
        "startTimeUnixNano": nano(now), "attributes": [] });
    let payload = serde_json::json!({ "resourceSpans": [{ "scopeSpans": [{ "spans": [
        mk("codex.turn", "codex-b", "0000000000000001"),
        mk("codex.turn", "codex-a", "0000000000000002"),
        mk("codex.tool", "codex-b", "0000000000000003"),
        mk("claude_code.api_request", "not-codex", "0000000000000004"),
    ] }] }] }).to_string();
    request(otlp, &format!("POST /v1/traces HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len()));
    let r = get(ui, "/api/debug/codex-store-groups", "");
    assert_eq!(body_of(&r), r#"{"codexTraceIds":["codex-a","codex-b"]}"#, "distinct, sorted, codex.* only");

    // span-attr: the overlay lands via a gen_ai.choice log event; the fresh read shows it.
    let choice = serde_json::json!({ "resourceLogs": [{ "scopeLogs": [{ "logRecords": [{
        "timeUnixNano": nano(now), "traceId": "codex-a", "spanId": "0000000000000002",
        "attributes": [ { "key": "event.name", "value": { "stringValue": "gen_ai.choice" } },
                        { "key": "gen_ai.event.content", "value": { "stringValue": "{\"content\":\"ok\"}" } } ]
    }] }] }] }).to_string();
    request(otlp, &format!("POST /v1/logs HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{choice}", choice.len()));
    let r = get(ui, "/api/debug/span-attr?traceId=codex-a&spanId=0000000000000002", "");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v["found"], true);
    assert_eq!(v["value"], r#"[{"role":"assistant","content":[{"type":"text","text":"ok"}]}]"#);
    // An explicit key, a missing attribute on a found span, and a span outside the window.
    let r = get(ui, "/api/debug/span-attr?traceId=codex-a&spanId=0000000000000002&key=nope", "");
    assert_eq!(body_of(&r), r#"{"found":true,"value":null}"#);
    let r = get(ui, "/api/debug/span-attr?traceId=zzz&spanId=zzz", "");
    assert_eq!(body_of(&r), r#"{"found":false,"value":null}"#);
    let _ = state;
}

#[test]
fn collector_gaps_route_serves_lifecycle_downtime_windows() {
    let (_otlp, ui, state) = start_servers();
    {
        // CoreState::open = recordCollectorStart: the boot run marker exists in memory AND on disk.
        let st = state.lock().unwrap();
        assert_eq!(st.lifecycle.runs.len(), 1, "the boot run marker");
        assert!(st.data_dir.join("collector-lifecycle.json").exists());
    }
    // A single run has no inter-run gap.
    let r = get(ui, "/api/collector-gaps", "");
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    assert_eq!(body_of(&r), r#"{"collectorGaps":[]}"#);
    // Crafted history: a clean 30s gap (shutdown), a crash 20s gap, a 5s gap under the floor.
    state.lock().unwrap().lifecycle.runs = vec![
        serde_json::json!({"startedAt":"2026-08-20T10:00:00.000Z","lastHeartbeat":"2026-08-20T10:00:30.000Z","stoppedAt":"2026-08-20T10:00:30.000Z"}),
        serde_json::json!({"startedAt":"2026-08-20T10:01:00.000Z","lastHeartbeat":"2026-08-20T10:02:00.000Z"}),
        serde_json::json!({"startedAt":"2026-08-20T10:02:20.000Z","lastHeartbeat":"2026-08-20T10:02:25.000Z"}),
        serde_json::json!({"startedAt":"2026-08-20T10:02:30.000Z","lastHeartbeat":"2026-08-20T10:02:35.000Z"}),
    ];
    let r = get(ui, "/api/collector-gaps", "");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(
        v["collectorGaps"],
        serde_json::json!([
            { "startedAt": "2026-08-20T10:00:30.000Z", "endedAt": "2026-08-20T10:01:00.000Z", "durationMs": 30000, "reason": "shutdown" },
            { "startedAt": "2026-08-20T10:02:00.000Z", "endedAt": "2026-08-20T10:02:20.000Z", "durationMs": 20000, "reason": "crash" },
        ]),
        "{v}"
    );
}

#[test]
fn timeline_route_serves_the_lazy_detail_with_the_otel_graft() {
    let (otlp, ui, state) = start_servers();
    // Unknown id → the frozen empty shape, still 200 (freeze row 30).
    let r = get(ui, "/api/timeline/nope", "");
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    assert_eq!(body_of(&r), r#"{"timeline":[],"fileOps":[],"generatedFiles":[],"generatedFilesTruncated":false}"#);

    // An OTEL claude trace whose session ALSO carries an api_request span; a log card with the
    // same id then displaces the OTEL twin (feed doctrine) — the drill grafts the attribution
    // back onto the served copy only (TRDD-5GFSFX0Q).
    let payload = serde_json::json!({
        "resourceSpans": [{ "scopeSpans": [{ "spans": [
            {
                "name": "claude_code.interaction",
                "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "spanId": "aaaaaaaaaaaaaaaa",
                "startTimeUnixNano": "1755600000000000000", "endTimeUnixNano": "1755600010000000000",
                "attributes": [ { "key": "session.id", "value": { "stringValue": "sess-ui-1" } },
                                { "key": "user_prompt", "value": { "stringValue": "Fix the bug" } } ]
            },
            {
                "name": "claude_code.api_request",
                "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "spanId": "cccccccccccccccc", "parentSpanId": "aaaaaaaaaaaaaaaa",
                "startTimeUnixNano": "1755600001000000000", "endTimeUnixNano": "1755600002000000000",
                "attributes": [ { "key": "session.id", "value": { "stringValue": "sess-ui-1" } },
                                { "key": "gen_ai.request.model", "value": { "stringValue": "claude-opus-5" } },
                                { "key": "input_tokens", "value": { "intValue": "70" } } ]
            }
        ] }] }]
    })
    .to_string();
    let r = request(otlp, &format!("POST /v1/traces HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{payload}", payload.len()));
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    state.lock().unwrap().put_log_session(serde_json::json!({
        "sessionId": "sess-ui-1", "source": "claude_code", "dataSource": "log", "startTime": "2025-08-19T10:40:00.000Z",
        "timeline": [{"type":"llm","timestamp":"2025-08-19T10:40:00.500Z"}],
        "fileOps": [{"file":"loader.ts","edits":1}],
        "generatedFiles": [{"path":"/tmp/scratch/report.md"}], "generatedFilesTruncated": true
    }));
    let r = get(ui, "/api/timeline/sess-ui-1", "");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    let tl = v["timeline"].as_array().unwrap();
    assert_eq!(tl.len(), 2, "the transcript entry + the grafted OTEL api_request: {v}");
    assert_eq!(tl[0]["type"], "llm");
    assert_eq!(tl[1]["type"], "api_request");
    assert_eq!(tl[1]["spanId"], "cccccccccccccccc");
    // The lazy payload carries the detail /api/summary strips (TRDD-ZS1GDXVY).
    assert_eq!(v["fileOps"], serde_json::json!([{"file":"loader.ts","edits":1}]));
    assert_eq!(v["generatedFiles"], serde_json::json!([{"path":"/tmp/scratch/report.md"}]));
    assert_eq!(v["generatedFilesTruncated"], true);
    // The STORED card stays pure — the graft lands on the served copy only.
    let st = state.lock().unwrap();
    assert_eq!(st.log_sessions["sess-ui-1"]["timeline"].as_array().unwrap().len(), 1);
}

#[test]
fn burn_status_route_serves_the_enriched_monitor_output() {
    let (_otlp, ui, state) = start_servers();
    let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let now = agentlens_core::now_ms();
    let iso = |off_ms: i64| agentlens_core::summarize::helpers::iso_from_ms((now - off_ms) as f64);
    {
        let mut st = state.lock().unwrap();
        // Never read THIS machine's account/config: scrub the env snapshot and point the burn
        // runtime at the committed fixture home (a stripe_subscription account, acct-aaaa).
        st.burn.vars.clear();
        st.burn.set_home_dir(fixtures.join("ttl-home-a"));
        st.put_log_session(serde_json::json!({
            "sessionId": "burn-1", "source": "claude_code", "dataSource": "log",
            "startTime": iso(60_000), "accountId": "acct-aaaa",
            "timeline": [{ "type": "api_request", "timestamp": iso(30_000), "spanId": "b1",
                "costUsd": 0.2, "inputTokens": 100, "outputTokens": 20,
                "cacheReadTokens": 1000, "cacheCreateTokens": 50 }]
        }));
    }
    let r = get(ui, "/api/burn-status", "");
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v["activeSessions"], 1, "{v}");
    assert_eq!(v["topSessions"][0]["sessionId"], "burn-1");
    assert!(v["topSessions"][0].get("keepWarm").is_some(), "keepWarm decoration: {v}");
    // No capacity configured on the scrubbed env → honest nulls, source none.
    assert_eq!(v["window"]["capacitySource"], "none");
    assert_eq!(v["window"]["fiveHour"]["pctConsumed"], serde_json::Value::Null);
    // Enrichment: the fixture account labels its own window; residentBlobs is the unported-scan
    // idle value; currentAccount is the fixture identity, token-free.
    assert_eq!(v["accountWindows"][0]["accountUuid"], "acct-aaaa");
    assert_eq!(v["accountWindows"][0]["accountLabel"], "fixture-user@example.com");
    assert_eq!(v["residentBlobs"], serde_json::json!([]));
    assert_eq!(v["currentAccount"]["email"], "fixture-user@example.com");
    assert_eq!(v["currentAccount"]["billingType"], "stripe_subscription");
    assert!(v["currentAccount"].get("accessToken").is_none() && !body_of(&r).contains("Token\":\""), "no secret-shaped fields");
    // Alerts: default thresholds — this tiny session crosses none.
    assert_eq!(v["alerts"], serde_json::json!([]));
}

#[test]
fn timeline_route_reparses_a_stripped_card_from_disk() {
    let (_otlp, ui, state) = start_servers();
    // A fixture home with ONE Claude transcript. Timestamps must be FRESH: the reparse applies
    // the same parse-time hot-age strip as TS, so a cold transcript reparses to a stripped card.
    let home = std::env::temp_dir().join(format!("al-ui-reparse-home-{}", std::process::id()));
    let proj = home.join(".claude").join("projects").join("-x-proj");
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&proj).unwrap();
    let sid = "dddddddd-1111-2222-3333-444444444444";
    let now = agentlens_core::now_ms();
    let iso = |off_ms: i64| agentlens_core::summarize::helpers::iso_from_ms((now - off_ms) as f64);
    let transcript = format!(
        "{}\n{}\n",
        serde_json::json!({"type":"user","timestamp":iso(10_000),"cwd":"/x/proj","message":{"role":"user","content":"drill me"}}),
        serde_json::json!({"type":"assistant","timestamp":iso(9_000),"message":{"id":"msg_1","model":"claude-opus-5",
            "usage":{"input_tokens":10,"output_tokens":2,"cache_read_input_tokens":0,"cache_creation_input_tokens":0},
            "content":[{"type":"text","text":"done"}]}}),
    );
    std::fs::write(proj.join(format!("{sid}.jsonl")), transcript).unwrap();
    {
        let mut st = state.lock().unwrap();
        // Point discovery at the fixture home (no process-env race), and store the card as the
        // durable restore would: STRIPPED — the offset resume never re-read its file.
        st.log_env = agentlens_logscan::discovery::Env {
            home: home.clone(),
            platform: agentlens_logscan::discovery::Platform::Other,
            vars: std::collections::HashMap::new(),
        };
        st.put_log_session(serde_json::json!({
            "sessionId": sid, "source": "claude_code", "dataSource": "log",
            "startTime": iso(10_000), "timeline": []
        }));
    }
    let r = get(ui, &format!("/api/timeline/{sid}"), "");
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    let tl = v["timeline"].as_array().unwrap();
    assert!(!tl.is_empty(), "reparsed from disk: {v}");
    assert!(tl.iter().any(|e| e["type"] == "llm"), "the assistant turn's llm entry: {v}");
    // resolveSessionCard re-stores the reparsed card (putLogSession) — the map now holds the
    // full timeline, not the stripped one.
    let st = state.lock().unwrap();
    assert!(!st.log_sessions[sid]["timeline"].as_array().unwrap().is_empty());
    drop(st);
    let _ = std::fs::remove_dir_all(&home);
}

/// Freeze row 13 (P4r.5) — POST /api/agent-gate over a real socket: the FAIL-OPEN contract
/// (malformed body → 204; allow → 204 empty), a ring-fed RUNAWAY_FANOUT deny with its exact
/// response shape, the realtime hook-config switches (mode downgrade, gate off, cache-guard
/// off, advisor off), the IMG_RESIDENT + advisory per-session dedupes, and the counters both
/// /api/server-stats sites serve.
#[test]
fn agent_gate_route_fail_open_deny_warn_advisory_and_dedupe() {
    let (_otlp, ui, state) = start_servers();
    {
        let mut st = state.lock().unwrap();
        // Never read THIS machine's account/config: scrub the env snapshot and point the burn
        // runtime at the committed fixture home.
        st.burn.vars.clear();
        st.burn.set_home_dir(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ttl-home-a"));
    }
    // Pin every runtime switch — the process env (AGENTLENS_GATE_MODE) must not steer the test.
    let r = post(ui, "/api/hook-config", r#"{"gateEnabled":true,"gateMode":"enforce","advisorEnabled":true,"cacheGuardEnabled":true,"captureEnabled":true}"#);
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");

    // Malformed JSON → 204 empty (fail-open; the TS catch). Not counted as a check.
    let r = post(ui, "/api/agent-gate", "{not json");
    assert!(r.starts_with("HTTP/1.1 204"), "{r}");
    assert_eq!(body_of(&r), "");

    // A quiet PreToolUse launch → 204 (allow is silent).
    let quiet = serde_json::json!({
        "hook_event_name": "PreToolUse", "tool_name": "Agent", "session_id": "sess-gate-1",
        "cwd": "/tmp/gate-proj", "tool_input": { "subagent_type": "explore", "prompt": "scan" }
    })
    .to_string();
    let r = post(ui, "/api/agent-gate", &quiet);
    assert!(r.starts_with("HTTP/1.1 204"), "{r}");

    // Feed 8 SubagentStarts through the REAL ingest (disk bucket + in-memory ring) — the gate's
    // runaway trigger AND its own-project attribution (same session_id + cwd as the caller).
    for i in 0..8 {
        let ev = serde_json::json!({
            "hook_event_name": "SubagentStart", "session_id": "sess-gate-1", "cwd": "/tmp/gate-proj",
            "agent_id": format!("ag-{i}"), "agent_type": "explore"
        })
        .to_string();
        let r = post(ui, "/api/hook-events", &ev);
        assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    }
    let r = post(ui, "/api/agent-gate", &quiet);
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v["hookSpecificOutput"]["hookEventName"], "PreToolUse");
    assert_eq!(v["hookSpecificOutput"]["permissionDecision"], "deny");
    let reason = v["hookSpecificOutput"]["permissionDecisionReason"].as_str().unwrap();
    assert!(reason.contains("8 subagent launches in the last 60s"), "{reason}");
    assert!(reason.contains("From this project: explore"), "{reason}");
    assert!(v["systemMessage"].as_str().unwrap().contains("blocked an agent launch (RUNAWAY_FANOUT)"), "{v}");

    // gateMode=warn downgrades the same deny — applied INSTANTLY via the hook-config route.
    post(ui, "/api/hook-config", r#"{"gateMode":"warn"}"#);
    let r = post(ui, "/api/agent-gate", &quiet);
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert!(v.get("hookSpecificOutput").is_none(), "warn carries no permissionDecision: {v}");
    assert!(v["systemMessage"].as_str().unwrap().starts_with("[deny downgraded to warning: AGENTLENS_GATE_MODE=warn]"), "{v}");

    // Gate off → 204 even under the runaway state (the check still counts — the TS increments
    // before the enabled branch).
    post(ui, "/api/hook-config", r#"{"gateEnabled":false}"#);
    let r = post(ui, "/api/agent-gate", &quiet);
    assert!(r.starts_with("HTTP/1.1 204"), "{r}");
    post(ui, "/api/hook-config", r#"{"gateEnabled":true,"gateMode":"enforce"}"#);

    // The image cache-guard: a fat parent (transcript usage 120,100 tokens) + a .png read →
    // the IMG_RESIDENT warning, then the per-session 10-min dedupe → 204, then the guard's own
    // switch → 204.
    let tdir = std::env::temp_dir().join(format!("al-gate-transcripts-{}", std::process::id()));
    std::fs::create_dir_all(&tdir).unwrap();
    let tpath = tdir.join("sess-img.jsonl");
    std::fs::write(
        &tpath,
        "{\"type\":\"assistant\",\"message\":{\"usage\":{\"input_tokens\":100,\"cache_read_input_tokens\":120000,\"cache_creation_input_tokens\":0}}}\n",
    )
    .unwrap();
    let img = serde_json::json!({
        "hook_event_name": "PreToolUse", "tool_name": "Read", "session_id": "sess-img",
        "transcript_path": tpath.to_string_lossy(), "tool_input": { "file_path": "/tmp/shot.png" }
    })
    .to_string();
    let r = post(ui, "/api/agent-gate", &img);
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert!(v["systemMessage"].as_str().unwrap().contains("reading shot.png into a ~120k-token session"), "{v}");
    let r = post(ui, "/api/agent-gate", &img);
    assert!(r.starts_with("HTTP/1.1 204"), "IMG_RESIDENT dedupe: {r}");
    post(ui, "/api/hook-config", r#"{"cacheGuardEnabled":false}"#);
    let r = post(ui, "/api/agent-gate", &img);
    assert!(r.starts_with("HTTP/1.1 204"), "cache-guard off: {r}");

    // PostToolUse advisory: 8 own launches ≥ fanoutWarn2min → ONE in-band injection, then the
    // session+code dedupe → 204, then the advisor switch → 204.
    let post_ev = serde_json::json!({
        "hook_event_name": "PostToolUse", "tool_name": "Agent", "session_id": "sess-gate-1", "cwd": "/tmp/gate-proj"
    })
    .to_string();
    let r = post(ui, "/api/agent-gate", &post_ev);
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v["hookSpecificOutput"]["hookEventName"], "PostToolUse");
    let ctx = v["hookSpecificOutput"]["additionalContext"].as_str().unwrap();
    assert!(ctx.contains("8 agent launches from this project in the last 2min (explore)"), "{ctx}");
    let r = post(ui, "/api/agent-gate", &post_ev);
    assert!(r.starts_with("HTTP/1.1 204"), "advisory dedupe: {r}");
    post(ui, "/api/hook-config", r#"{"advisorEnabled":false}"#);
    let r = post(ui, "/api/agent-gate", &post_ev);
    assert!(r.starts_with("HTTP/1.1 204"), "advisor off: {r}");

    // The counters, on BOTH server-stats surfaces: 10 parsed checks (the malformed body never
    // built a state), 1 deny, 2 warns (the downgraded deny + the image), 1 advisory.
    let r = get(ui, "/api/server-stats", "");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v["gate"]["checks"], 10, "{}", v["gate"]);
    assert_eq!(v["gate"]["denies"], 1);
    assert_eq!(v["gate"]["warns"], 2);
    assert_eq!(v["gate"]["advisories"], 1);
    assert_eq!(v["persistence"]["gateChecks"], 10);
    assert_eq!(v["persistence"]["gateDenies"], 1);
    let _ = std::fs::remove_dir_all(&tdir);
}

/// Freeze rows 14–15 — the bodies admin routes over a real socket: export's combined
/// archive+store shape with skip-existing, its 400 guards, and purge's per-volume
/// verify-before-delete (the proven volume removed, the unproven one KEPT with named
/// failures, `.idx` sidecars always retained).
#[test]
fn bodies_export_and_purge_routes() {
    let (_otlp, ui, state) = start_servers();
    let data_dir = { state.lock().unwrap().data_dir.clone() };
    // Copy the committed TS-written archive fixture into this server's data dir — purge
    // DELETES volumes, so it must never point at the committed tree.
    let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bodyarchive-tree/otel-bodies-archive");
    let arch = data_dir.join("otel-bodies-archive");
    std::fs::create_dir_all(&arch).unwrap();
    for e in std::fs::read_dir(&src).unwrap().flatten() {
        std::fs::copy(e.path(), arch.join(e.file_name())).unwrap();
    }
    // Seed the store with the JULY lumps (exact bytes + capture ts) plus ONE store-only body,
    // then FLUSH — the delete gate trusts only durable parquet. The AUGUST lump is deliberately
    // NOT ingested: its volume must be KEPT by purge with its failure named.
    let entries = agentlens_core::body_archive::list_archive_entries(&arch);
    let mut store = agentlens_store::open_store(&data_dir.join("store"), agentlens_store::DEFAULT_MEMORY_LIMIT, 4).unwrap();
    let mut july_ts = 0i64;
    for e in &entries {
        if !e.volume.to_string_lossy().ends_with("bodies-2026-07.wad") {
            continue;
        }
        let raw = String::from_utf8_lossy(&agentlens_core::body_archive::read_archive_entry(e).unwrap()).into_owned();
        july_ts = e.mtime_ms as i64;
        agentlens_store::ingest_body(&mut store, &e.name, &raw, july_ts).unwrap();
    }
    agentlens_store::ingest_body(&mut store, "dddd4444.request.json", "{\"store\":\"only\",\"note\":\"never archived\"}", july_ts).unwrap();
    agentlens_store::flush_detailed(&mut store).unwrap();
    drop(store);

    // Export guards: missing / relative destDir, and a destDir inside the archive.
    let r = post(ui, "/api/bodies/export", r#"{"sinceMs":0}"#);
    assert!(r.starts_with("HTTP/1.1 400"), "{r}");
    assert!(body_of(&r).contains("destDir (absolute path) is required"));
    let r = post(ui, "/api/bodies/export", r#"{"destDir":"relative/x"}"#);
    assert!(r.starts_with("HTTP/1.1 400"), "{r}");
    let inside = serde_json::json!({ "destDir": arch.join("sub").to_string_lossy() }).to_string();
    let r = post(ui, "/api/bodies/export", &inside);
    assert!(r.starts_with("HTTP/1.1 400"), "{r}");
    assert!(body_of(&r).contains("must not be inside the archive itself"));

    // The full export: 3 archive lumps + the 1 store-only body; the July bodies also live in
    // the store but their files exist by the time the store half runs → skip-existing keeps
    // fromStore at exactly 1.
    let dest = std::env::temp_dir().join(format!("al-bodies-export-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dest);
    let req = serde_json::json!({ "destDir": dest.to_string_lossy() }).to_string();
    let r = post(ui, "/api/bodies/export", &req);
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v["fromArchive"], 3, "{v}");
    assert_eq!(v["fromStore"], 1, "{v}");
    assert_eq!(v["files"], 4);
    assert_eq!(v["failed"], serde_json::json!([]));
    assert_eq!(v["destDir"].as_str().unwrap(), dest.to_string_lossy());
    let store_only = std::fs::read_to_string(dest.join("dddd4444.request.json")).unwrap();
    assert_eq!(store_only, "{\"store\":\"only\",\"note\":\"never archived\"}");
    let _ = std::fs::remove_dir_all(&dest);

    // Purge: July proven lump-by-lump → removed (bytes freed, .idx retained); August has no
    // store rows → kept, failures named, nothing deleted.
    let r = post(ui, "/api/bodies/purge", "");
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v["removed"], serde_json::json!(["bodies-2026-07.wad"]), "{v}");
    assert_eq!(v["kept"][0]["volume"], "bodies-2026-08.wad");
    assert_eq!(v["kept"][0]["entries"], 1);
    assert_eq!(v["kept"][0]["verified"], 0);
    assert_eq!(v["kept"][0]["failedSample"].as_array().unwrap().len(), 1);
    assert!(v["freedBytes"].as_u64().unwrap() > 0);
    assert!(!arch.join("bodies-2026-07.wad").exists(), "verified volume deleted");
    assert!(arch.join("bodies-2026-07.wad.idx").exists(), ".idx sidecar retained");
    assert!(arch.join("bodies-2026-08.wad").exists(), "unproven volume kept");
}

/// Freeze rows 19–21 — the instruction routes over a real socket: the bare-array responses,
/// the shared workspace 400, the advisor consuming BOTH the live summary and the workspace's
/// existing instruction text, and apply's allowlist + append (creating the file).
#[test]
fn instruction_routes_suggestions_files_and_apply() {
    let (_otlp, ui, state) = start_servers();
    let ws = std::env::temp_dir().join(format!("al-insws-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&ws);
    std::fs::create_dir_all(&ws).unwrap();
    let ws_s = ws.to_string_lossy().to_string();
    {
        // Five sessions in this workspace, all reading the same file → a 100% hot-file
        // suggestion once the advisor sees them through the live summary.
        let mut st = state.lock().unwrap();
        for i in 0..5 {
            st.put_log_session(serde_json::json!({
                "sessionId": format!("ins-{i}"), "source": "claude_code", "dataSource": "log",
                "workspace": ws_s, "startTime": "2026-08-20T06:00:00.000Z",
                "model": "claude-opus-5", "inputTokens": 1000, "cacheReadTokens": 0,
                "cacheCreateTokens": 0, "outputTokens": 1000,
                "filesRead": ["src/db/schema.ts"], "filesChanged": [],
                "userRequest": "add feature", "toolCounts": { "Bash": 1, "Read": 5 },
                "timeline": []
            }));
        }
    }
    // The shared 400 (missing / empty workspace), on both GET routes.
    for p in ["/api/instruction-suggestions", "/api/instruction-files?workspace=%20"] {
        let r = get(ui, p, "");
        assert!(r.starts_with("HTTP/1.1 400"), "{p}: {r}");
        assert!(body_of(&r).contains("workspace query param is required"));
    }
    let q = format!("/api/instruction-suggestions?workspace={}", ws_s.replace('/', "%2F"));
    let r = get(ui, &q, "");
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    let arr = v.as_array().expect("bare array");
    assert_eq!(arr[0]["id"], "hot_file:src_db_schema_ts", "{v}");
    assert!(arr[0]["evidence"].as_str().unwrap().contains("5 of 5 sessions (100%)"));

    // Apply: field/allowlist 400s, then a real append that CREATES the file with the marker.
    let r = post(ui, "/api/instructions/apply", r#"{"workspace":"x"}"#);
    assert!(r.starts_with("HTTP/1.1 400"), "{r}");
    let bad = serde_json::json!({ "workspace": ws_s, "targetFile": "../evil.md", "appliedText": "t", "id": "i" }).to_string();
    let r = post(ui, "/api/instructions/apply", &bad);
    assert!(r.starts_with("HTTP/1.1 400"), "{r}");
    assert!(body_of(&r).contains("recognized instruction file"));
    let ok = serde_json::json!({ "workspace": ws_s, "targetFile": "CLAUDE.md", "appliedText": "Always read `src/db/schema.ts` first.", "id": "hot_file:src_db_schema_ts" }).to_string();
    let r = post(ui, "/api/instructions/apply", &ok);
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    assert_eq!(body_of(&r), r#"{"ok":true}"#);
    let written = std::fs::read_to_string(ws.join("CLAUDE.md")).unwrap();
    assert!(written.contains("<!-- AgentLens suggestion applied "), "{written}");
    assert!(written.contains("id:hot_file:src_db_schema_ts -->\nAlways read `src/db/schema.ts` first.\n"), "{written}");

    // The advisor now sees the applied text through readAllInstructionContent → the mention
    // filter absorbs the suggestion (the whole feedback loop, end to end).
    let r = get(ui, &q, "");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v, serde_json::json!([]), "applied text absorbs the suggestion");

    // instruction-files: CLAUDE.md now exists with content; the other two report their create
    // affordance (primary path, exists:false).
    let r = get(ui, &format!("/api/instruction-files?workspace={}", ws_s.replace('/', "%2F")), "");
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    let files = v.as_array().unwrap();
    assert_eq!(files.len(), 3);
    assert_eq!(files[0]["agent"], "claude_code");
    assert_eq!(files[0]["exists"], true);
    assert!(files[0]["content"].as_str().unwrap().contains("Always read"));
    assert_eq!(files[1]["exists"], false);
    assert_eq!(files[2]["relativePath"], "AGENTS.md");
    let _ = std::fs::remove_dir_all(&ws);
}

/// Freeze row 5 — POST /api/statusline-samples over a real socket: the object-only 400s, the
/// stream routing, the legacy hook-events divert landing in the SAME store, and the real
/// counters on both server-stats surfaces.
#[test]
fn statusline_samples_route_and_legacy_divert() {
    let (_otlp, ui, state) = start_servers();
    // Parse failure and non-object payloads → 400 {error}.
    let r = post(ui, "/api/statusline-samples", "{broken");
    assert!(r.starts_with("HTTP/1.1 400"), "{r}");
    let r = post(ui, "/api/statusline-samples", "[1,2]");
    assert!(r.starts_with("HTTP/1.1 400"), "{r}");
    assert!(body_of(&r).contains("payload must be a JSON object"));
    // Main + subagent samples through the dedicated endpoint.
    let r = post(ui, "/api/statusline-samples", r#"{"session_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","model":{"id":"claude-opus-5"}}"#);
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    assert_eq!(body_of(&r), r#"{"ok":true}"#);
    let r = post(ui, "/api/statusline-samples", r#"{"statusline_stream":"subagent","session_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa","tasks":[{"name":"x"}]}"#);
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    // The version-skew bridge: an older CLI posting the sample as a hook event must land in the
    // SAME store (routed answer frozen), or a skew would split the history in two.
    let r = post(ui, "/api/hook-events", r#"{"hook_event_name":"StatusLineSample","session_id":"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"}"#);
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    assert!(body_of(&r).contains("\"routed\":\"statusline\""), "{r}");
    let r = get(ui, "/api/server-stats", "");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v["persistence"]["statuslineSamples"], 3, "{}", v["persistence"]);
    assert_eq!(v["statusline"]["bufferedRows"], 3, "{}", v["statusline"]);
    assert_eq!(v["statusline"]["receivedSinceBoot"], 3);
    // Flush drains the buffer into the day's WAL — visible as walBytes on the next stats read.
    {
        let mut st = state.lock().unwrap();
        st.statusline.flush(None);
    }
    let r = get(ui, "/api/server-stats", "");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v["statusline"]["bufferedRows"], 0);
    assert!(v["statusline"]["walBytes"].as_u64().unwrap() > 0, "{}", v["statusline"]);
}

/// Freeze rows 9 + 31 — cache-risk commands over a fixture home, and the scratch-file leaf's
/// realpath containment (the raw-string traversal MUST answer the containment refusal, never
/// file bytes — the UI is browser-reachable).
#[test]
fn cache_risk_commands_and_generated_file_routes() {
    let (_otlp, ui, state) = start_servers();
    // A fixture home whose .claude/projects tree holds one fresh command transcript.
    let home = std::env::temp_dir().join(format!("al-crc-home-{}", std::process::id()));
    let proj = home.join(".claude/projects/slug-x");
    let _ = std::fs::remove_dir_all(&home);
    std::fs::create_dir_all(&proj).unwrap();
    let now = agentlens_core::now_ms();
    let iso = agentlens_core::summarize::helpers::iso_from_ms((now - 60_000) as f64);
    std::fs::write(
        proj.join("t.jsonl"),
        format!(
            "{{\"type\":\"user\",\"sessionId\":\"aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa\",\"timestamp\":\"{iso}\",\"message\":{{\"role\":\"user\",\"content\":\"<command-name>/reload-plugins</command-name><command-args></command-args>\"}}}}\n"
        ),
    )
    .unwrap();
    {
        let mut st = state.lock().unwrap();
        st.log_env = agentlens_logscan::discovery::Env { home: home.clone(), ..agentlens_logscan::discovery::Env::from_process() };
    }
    let r = get(ui, "/api/cache-risk-commands", "");
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v["windowHours"], 168, "{v}");
    assert_eq!(v["total"], 1);
    assert_eq!(v["truncated"], false);
    assert_eq!(v["byKind"], serde_json::json!({ "PLUGINS_RELOADED": 1 }));
    assert_eq!(v["commands"][0]["command"], "/reload-plugins");
    assert_eq!(v["commands"][0]["mutation"], "certain");
    assert!(v["commands"][0].get("args").is_none(), "empty args stays absent: {v}");
    // kinds filter excludes it; window param survives.
    let r = get(ui, "/api/cache-risk-commands?kinds=CLEAR&window=2", "");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v["windowHours"], 2);
    assert_eq!(v["total"], 0);

    // generated-file: a real scratch file under /tmp/claude-<x>/ answers content; the
    // traversal-shaped path and a foreign path answer the containment refusal.
    let scratch = std::path::Path::new("/tmp").join(format!("claude-tst{}", std::process::id())).join("proj/sess");
    std::fs::create_dir_all(&scratch).unwrap();
    std::fs::write(scratch.join("out.txt"), "generated!").unwrap();
    let enc = |s: &str| s.replace('/', "%2F");
    let r = get(ui, &format!("/api/generated-file?path={}", enc(&scratch.join("out.txt").to_string_lossy())), "");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v["exists"], true, "{v}");
    assert_eq!(v["content"], "generated!");
    assert_eq!(v["truncated"], false);
    let traversal = format!("{}/../../../etc/hosts", scratch.to_string_lossy());
    let r = get(ui, &format!("/api/generated-file?path={}", enc(&traversal)), "");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v["exists"], false, "realpath containment: {v}");
    assert!(v.get("content").is_none());
    let r = get(ui, "/api/generated-file?path=%2Fetc%2Fhosts", "");
    let v: serde_json::Value = serde_json::from_str(body_of(&r)).unwrap();
    assert_eq!(v, serde_json::json!({ "exists": false, "error": "path not under a Claude scratch tree" }));
    let _ = std::fs::remove_dir_all(&home);
    let _ = std::fs::remove_dir_all(scratch.parent().unwrap().parent().unwrap());
}

/// Rows 36-37 over a real socket: the composition summary and the block drill.
///
/// The empty-session case is the one that matters most in practice — a session with no captured
/// raw bodies must serve an HONEST empty summary with a coverageNote, never an error and never a
/// spinner, because "lazy" means historical bodies legitimately are not indexed.
#[test]
fn composition_index_and_block_content_routes() {
    let (_otlp, ui, state) = start_servers();
    let bodies = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bodies");
    {
        let mut st = state.lock().unwrap();
        st.bodies.record(
            "ui-comp",
            agentlens_core::call_body_registry::CallBodyPointer {
                kind: "request",
                body_ref: Some(bodies.join("comp.request.json").to_string_lossy().into_owned()),
                inline_body: None,
                request_id: None,
                span_id: Some("sp1".into()),
                model: None,
                query_source: None,
                ts: 1000,
            },
        );
    }

    // 36 — a session WITH bodies.
    let body = body_of(&get(ui, "/api/composition-index/ui-comp", "")).to_owned();
    let v: serde_json::Value = serde_json::from_str(&body).expect("composition-index must be JSON");
    let s = &v["summary"];
    assert_eq!(s["sessionId"], "ui-comp");
    assert_eq!(s["callsTotal"], 1, "one recorded request pointer = one ref");
    assert!(s["peakCall"]["contextTokens"].as_f64().unwrap() > 0.0, "peak call must be populated: {s}");
    assert!(s.get("coverageNote").is_none(), "a session WITH bodies must carry no coverageNote: {s}");

    // 36 — an unknown session: honest empty summary, still 200.
    let body = body_of(&get(ui, "/api/composition-index/nobody-here", "")).to_owned();
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["summary"]["callsTotal"], 0);
    assert!(
        v["summary"]["coverageNote"].as_str().is_some_and(|n| n.contains("OTEL_LOG_RAW_API_BODIES")),
        "the empty state must SAY why it is empty and how to fix it: {v}"
    );

    // 37 — drill a real block.
    let body = body_of(&get(ui, "/api/block-content/ui-comp/1/0", "")).to_owned();
    let v: serde_json::Value = serde_json::from_str(&body).unwrap();
    assert_eq!(v["block"]["sessionId"], "ui-comp");
    assert_eq!(v["block"]["turn"], 1);
    assert_eq!(v["block"]["index"], 0);
    assert!(v["block"]["text"].is_string(), "a text block carries its content: {v}");

    // 37 — the IMAGE block: metadata + ref, and NO text key. Pointer-only is a privacy contract.
    let img = (0..12)
        .map(|i| {
            let b = body_of(&get(ui, &format!("/api/block-content/ui-comp/1/{i}"), "")).to_owned();
            serde_json::from_str::<serde_json::Value>(&b).unwrap()
        })
        .find(|v| v["block"]["isImage"] == serde_json::Value::Bool(true))
        .expect("the fixture body carries an image block");
    assert!(img["block"].get("text").is_none(), "image drill must NEVER carry text: {img}");
    assert!(img["block"]["bodyRef"].is_string(), "image drill still carries its ref: {img}");

    // 37 — the two DISTINCT not-found shapes, both 200 so a caller can tell them apart.
    let resp = get(ui, "/api/block-content/ui-comp/99/0", "");
    assert!(resp.starts_with("HTTP/1.1 200"), "a missing turn is 200, not an error: {resp}");
    let v: serde_json::Value = serde_json::from_str(body_of(&resp)).unwrap();
    assert!(v["block"]["message"].as_str().unwrap().contains("No raw body for call/turn 99"), "{v}");
    assert!(v["block"].get("blockIndex").is_none(), "the no-pointer shape carries NO blockIndex: {v}");

    let v: serde_json::Value = serde_json::from_str(body_of(&get(ui, "/api/block-content/ui-comp/1/999", ""))).unwrap();
    assert_eq!(v["block"]["blockIndex"], 999, "the no-block shape DOES carry blockIndex: {v}");
    assert!(v["block"]["message"].as_str().unwrap().contains("No block 999 at turn 1"), "{v}");

    // 37 — a non-numeric turn is the ONLY 400 here.
    let resp = get(ui, "/api/block-content/ui-comp/abc/0", "");
    assert!(resp.starts_with("HTTP/1.1 400"), "a non-numeric turn must 400: {resp}");
    assert!(body_of(&resp).contains("bad sessionId/turn/blockIndex"));
}

/// Row 32 over a real socket. The `?parent=` fallback is the point: a fork has no log of its own,
/// and `{composition: null}` must stay a legitimate 200 answer rather than an error.
#[test]
fn composition_route_streams_the_transcript_and_honours_the_parent_fallback() {
    let (_otlp, ui, state) = start_servers();
    let home = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude-home");
    {
        // Clear the inherited env: this machine's real CLAUDE_CONFIG_DIR would otherwise point the
        // route at the developer's own transcripts.
        let mut st = state.lock().unwrap();
        st.log_env.vars.clear();
        st.log_env.vars.insert("CLAUDE_CONFIG_DIR".into(), home.to_string_lossy().into_owned());
    }

    let v: serde_json::Value = serde_json::from_str(body_of(&get(ui, "/api/composition/comp-own", ""))).unwrap();
    let c = &v["composition"];
    assert_eq!(c["sessionId"], "comp-own");
    assert_eq!(c["estimated"], true);
    assert!(c["turns"].as_array().unwrap().len() >= 3, "the fixture transcript has three turns: {c}");
    assert!(c.get("reconstructedFrom").is_none(), "an own log is NOT tagged: {c}");

    // A fork: no own log, reconstructed from the parent named in ?parent=.
    let v: serde_json::Value = serde_json::from_str(body_of(&get(ui, "/api/composition/forky?parent=comp-parent", ""))).unwrap();
    assert_eq!(v["composition"]["reconstructedFrom"], "comp-parent");
    assert!(!v["composition"]["turns"].as_array().unwrap().is_empty());

    // No log, no parent → null composition, still 200.
    let resp = get(ui, "/api/composition/nothing-here", "");
    assert!(resp.starts_with("HTTP/1.1 200"), "a null composition is still 200: {resp}");
    let v: serde_json::Value = serde_json::from_str(body_of(&resp)).unwrap();
    assert!(v["composition"].is_null(), "{v}");
}

/// Row 33 over a real socket, including the per-step diff the UI's cache bars read.
#[test]
fn history_route_serves_steps_with_diffs_and_the_parent_fallback() {
    let (_otlp, ui, state) = start_servers();
    let home = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude-home");
    {
        let mut st = state.lock().unwrap();
        st.log_env.vars.clear();
        st.log_env.vars.insert("CLAUDE_CONFIG_DIR".into(), home.to_string_lossy().into_owned());
    }

    let v: serde_json::Value = serde_json::from_str(body_of(&get(ui, "/api/history/hist-main", ""))).unwrap();
    let h = &v["history"];
    assert_eq!(h["sessionId"], "hist-main");
    let steps = h["steps"].as_array().unwrap();
    assert_eq!(steps.len(), 3, "a duplicate message.id must NOT open a fourth step: {h}");
    // The FIRST step has no baseline, so every block is "added" and nothing is "changed".
    assert!(steps[0]["diff"]["changed"].as_array().unwrap().is_empty(), "{}", steps[0]["diff"]);
    assert_eq!(
        steps[0]["diff"]["added"].as_array().unwrap().len(),
        steps[0]["blocks"].as_array().unwrap().len(),
        "first step: every block added"
    );
    // A later step must report real churn, or the diff overlay is useless.
    assert!(!steps[1]["diff"]["removed"].as_array().unwrap().is_empty(), "{}", steps[1]["diff"]);

    let v: serde_json::Value = serde_json::from_str(body_of(&get(ui, "/api/history/forked?parent=hist-main", ""))).unwrap();
    assert_eq!(v["history"]["reconstructedFrom"], "hist-main");

    let resp = get(ui, "/api/history/nothing-here", "");
    assert!(resp.starts_with("HTTP/1.1 200"), "a null history is still 200: {resp}");
    assert!(serde_json::from_str::<serde_json::Value>(body_of(&resp)).unwrap()["history"].is_null());
}

/// Row 34 over a real socket: the narrative view, its tier split, and the parent fallback.
#[test]
fn conversation_route_serves_the_narrative_with_the_ttl_tier_split() {
    let (_otlp, ui, state) = start_servers();
    let home = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude-home");
    {
        let mut st = state.lock().unwrap();
        st.log_env.vars.clear();
        st.log_env.vars.insert("CLAUDE_CONFIG_DIR".into(), home.to_string_lossy().into_owned());
    }

    let v: serde_json::Value = serde_json::from_str(body_of(&get(ui, "/api/conversation/conv-main", ""))).unwrap();
    let c = &v["conversation"];
    assert_eq!(c["sessionId"], "conv-main");
    assert_eq!(c["title"], "final title", "the LATEST ai-title wins: {c}");
    // The ephemeral 5m/1h split is the signal this parser exists for — 5m and 1h writes bill at
    // different rates, so losing the split makes cost attribution wrong, not just less detailed.
    assert_eq!(c["totals"]["usage"]["tier5m"], 10, "{}", c["totals"]);
    assert_eq!(c["totals"]["usage"]["tier1h"], 30, "{}", c["totals"]);
    assert!(!c["compactions"].as_array().unwrap().is_empty(), "compact_boundary records are harvested: {c}");

    let v: serde_json::Value = serde_json::from_str(body_of(&get(ui, "/api/conversation/forked?parent=conv-main", ""))).unwrap();
    assert_eq!(v["conversation"]["reconstructedFrom"], "conv-main");

    let resp = get(ui, "/api/conversation/nothing-here", "");
    assert!(resp.starts_with("HTTP/1.1 200"), "a null conversation is still 200: {resp}");
    assert!(serde_json::from_str::<serde_json::Value>(body_of(&resp)).unwrap()["conversation"].is_null());
}

/// Row 35 over a real socket — the LAST HTTP row. Also pins the TRDD-BURNWDGT account backfill,
/// which is the reason this route writes to state at all.
#[test]
fn callcontext_route_resolves_a_body_and_backfills_the_account() {
    let (_otlp, ui, state) = start_servers();
    let bodies = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bodies");
    {
        let mut st = state.lock().unwrap();
        st.bodies.record(
            "cc-sess",
            agentlens_core::call_body_registry::CallBodyPointer {
                kind: "request",
                body_ref: Some(bodies.join("cc-model.request.json").to_string_lossy().into_owned()),
                inline_body: None,
                request_id: Some("req-ptr".into()),
                span_id: Some("sp-1".into()),
                model: None,
                query_source: None,
                ts: 1,
            },
        );
        assert!(st.accounts.account_for("cc-sess").is_none(), "account is unknown before the drill");
    }

    // /:sessionId/:requestId — the sel requestId wins over the pointer's.
    let v: serde_json::Value = serde_json::from_str(body_of(&get(ui, "/api/callcontext/cc-sess/req-sel", ""))).unwrap();
    let c = &v["callContext"];
    assert_eq!(c["sessionId"], "cc-sess", "sessionId is OVERWRITTEN with the requested one: {c}");
    assert_eq!(c["requestId"], "req-sel");
    assert!(!c["blocks"].as_array().unwrap().is_empty(), "{c}");

    // The backfill makes account attribution work for sessions whose OTEL events never carried it.
    {
        let st = state.lock().unwrap();
        assert_eq!(st.accounts.account_for("cc-sess"), Some("cc-acct"), "the drill must backfill the account");
    }

    // ?span= selects the same pointer, and with no sel requestId the POINTER's is used.
    let v: serde_json::Value = serde_json::from_str(body_of(&get(ui, "/api/callcontext/cc-sess?span=sp-1", ""))).unwrap();
    assert_eq!(v["callContext"]["requestId"], "req-ptr");

    // An unknown session is a null context on a 200 — "not captured" is an answer, not an error.
    let resp = get(ui, "/api/callcontext/no-such-session", "");
    assert!(resp.starts_with("HTTP/1.1 200"), "{resp}");
    assert!(serde_json::from_str::<serde_json::Value>(body_of(&resp)).unwrap()["callContext"].is_null());
}

/// P4x — the MCP endpoint. tools/list must serve all 53 FROZEN schemas byte-identically to the TS
/// (they are generated from it, not transcribed), and an unimplemented tool must SAY SO rather
/// than answering emptily, which would read as a working tool that found nothing.
#[test]
fn mcp_endpoint_serves_the_frozen_tool_schemas_and_names_unported_tools() {
    let (_otlp, ui, _state) = start_servers();
    let rpc = |method: &str, params: &str| -> serde_json::Value {
        let body = format!(r#"{{"jsonrpc":"2.0","id":1,"method":"{method}","params":{params}}}"#);
        serde_json::from_str(body_of(&post(ui, "/mcp", &body))).expect("mcp must answer JSON")
    };

    let init = rpc("initialize", "{}");
    assert_eq!(init["result"]["protocolVersion"], "2024-11-05", "{init}");

    let listed = rpc("tools/list", "{}");
    let tools = listed["result"]["tools"].as_array().expect("tools array");
    assert_eq!(tools.len(), 53, "the frozen surface is 53 tools");
    // Compare against the generated asset itself: the schemas must cross the wire unchanged.
    let asset: serde_json::Value =
        serde_json::from_str(include_str!("../assets/mcp-tools.json")).unwrap();
    assert_eq!(&listed["result"], &asset, "tools/list must serve the generated asset VERBATIM");
    assert!(
        tools.iter().all(|t| t.get("name").is_some() && t.get("inputSchema").is_some()),
        "every tool carries a name and an inputSchema"
    );

    // A REAL tool with no Rust implementation yet: an explicit error naming the tool.
    let called = rpc("tools/call", r#"{"name":"get_recent_sessions","arguments":{}}"#);
    let msg = called["error"]["message"].as_str().unwrap_or("");
    assert!(msg.contains("get_recent_sessions") && msg.contains("not yet implemented"), "{called}");

    // A tool that does not exist at all is a DIFFERENT error — the caller must be able to tell
    // "you typo'd" from "we have not ported that yet".
    let bogus = rpc("tools/call", r#"{"name":"no_such_tool","arguments":{}}"#);
    assert!(bogus["error"]["message"].as_str().unwrap_or("").contains("unknown tool"), "{bogus}");

    let bad = rpc("nope/nope", "{}");
    assert_eq!(bad["error"]["code"], -32601, "{bad}");
}

/// P4x.2 — the first real MCP tool end-to-end: schema → dispatch → engine → shaper → envelope.
#[test]
fn mcp_get_call_context_tool_answers_through_the_full_chain() {
    let (_otlp, ui, state) = start_servers();
    let bodies = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bodies");
    {
        let mut st = state.lock().unwrap();
        st.bodies.record(
            "mcp-sess",
            agentlens_core::call_body_registry::CallBodyPointer {
                kind: "request",
                body_ref: Some(bodies.join("cc-model.request.json").to_string_lossy().into_owned()),
                inline_body: None,
                request_id: Some("req-ptr".into()),
                span_id: None,
                model: None,
                query_source: None,
                ts: 1,
            },
        );
    }
    let call = |args: &str| -> serde_json::Value {
        let body = format!(r#"{{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{{"name":"get_call_context","arguments":{args}}}}}"#);
        let env: serde_json::Value = serde_json::from_str(body_of(&post(ui, "/mcp", &body))).unwrap();
        // The CLI unwraps content[0].text and JSON-parses it — do exactly that.
        let text = env["result"]["content"][0]["text"].as_str().unwrap_or_else(|| panic!("no content text: {env}"));
        serde_json::from_str(text).unwrap()
    };

    let p = call(r#"{"sessionId":"mcp-sess"}"#);
    assert_eq!(p["sessionId"], "mcp-sess");
    assert_eq!(p["requestId"], "req-ptr", "the pointer's requestId is used when none was asked for");
    assert_eq!(p["estimated"], true);
    assert!(p["blockCount"].as_u64().unwrap() > 0, "{p}");
    assert!(p["blocks"][0].get("tokenSource").is_none(), "the tool projection drops tokenSource: {p}");

    // A session with no captured body gets the HONEST message, not an error and not empty blocks.
    let p = call(r#"{"sessionId":"ghost","requestId":"r9"}"#);
    assert_eq!(p["requestId"], "r9", "the caller's own ids come back: {p}");
    assert!(p["message"].as_str().unwrap_or("").contains("not captured"), "{p}");
    assert!(p.get("blocks").is_none(), "the no-body shape carries no blocks at all: {p}");
}

/// `get_burn_status` must serve the LABELLED status, NOT the enriched one — enrich adds
/// `currentAccount` + `residentBlobs`, which belong to the HTTP row-24 payload only. Reusing enrich
/// here because it is "the burn status function" would ship two fields this tool never had, so the
/// difference is asserted directly against the HTTP route's own body.
#[test]
fn mcp_get_burn_status_serves_the_labelled_not_the_enriched_status() {
    let (_otlp, ui, state) = start_servers();
    let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let now = agentlens_core::now_ms();
    let iso = |off: i64| agentlens_core::summarize::helpers::iso_from_ms((now - off) as f64);
    {
        let mut st = state.lock().unwrap();
        st.burn.vars.clear();
        st.burn.set_home_dir(fixtures.join("ttl-home-a"));
        st.put_log_session(serde_json::json!({
            "sessionId": "burn-mcp", "source": "claude_code", "dataSource": "log",
            "startTime": iso(60_000), "accountId": "acct-aaaa",
            "timeline": [{ "type": "api_request", "timestamp": iso(30_000), "spanId": "b1",
                "costUsd": 0.2, "inputTokens": 100, "outputTokens": 20,
                "cacheReadTokens": 1000, "cacheCreateTokens": 50 }]
        }));
    }
    let body = r#"{"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"get_burn_status","arguments":{}}}"#;
    let env: serde_json::Value = serde_json::from_str(body_of(&post(ui, "/mcp", body))).unwrap();
    let text = env["result"]["content"][0]["text"].as_str().unwrap_or_else(|| panic!("{env}"));
    let tool: serde_json::Value = serde_json::from_str(text).unwrap();

    assert!(tool["accountWindows"].is_array(), "the labelled status keeps its windows: {tool}");
    for w in tool["accountWindows"].as_array().unwrap() {
        assert!(w["accountLabel"].is_string(), "every window is labelled: {w}");
    }
    assert!(tool.get("currentAccount").is_none(), "enrich-only field must NOT appear: {tool}");
    assert!(tool.get("residentBlobs").is_none(), "enrich-only field must NOT appear: {tool}");

    // The HTTP route DOES carry them — proving the two payloads are genuinely different rather
    // than both missing the fields for some unrelated reason.
    let http: serde_json::Value = serde_json::from_str(body_of(&get(ui, "/api/burn-status", ""))).unwrap();
    assert!(http.get("currentAccount").is_some(), "row 24 carries currentAccount: {http}");
}

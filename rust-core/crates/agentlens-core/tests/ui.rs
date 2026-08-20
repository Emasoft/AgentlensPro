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

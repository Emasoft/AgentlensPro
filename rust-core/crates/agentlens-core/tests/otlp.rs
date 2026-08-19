//! The frozen OTLP wire contract, exercised over a REAL socket (TRDD-DMWOBWFH P4c; spec =
//! the P4a freeze report §2). Raw std TcpStream clients on purpose: the overflow case must
//! observe the connection DYING without a response, which an HTTP client library would
//! paper over with its own error taxonomy.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};

fn start_server() -> (std::net::SocketAddr, Arc<Mutex<agentlens_core::CoreState>>, tempdir::Dir) {
    let dir = tempdir::make();
    let state = Arc::new(Mutex::new(agentlens_core::CoreState::open(&dir.path)));
    let (tx, rx) = std::sync::mpsc::channel();
    let st = state.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            let _ = agentlens_core::serve_otlp("127.0.0.1:0".parse().unwrap(), st, move |bound| {
                tx.send(bound).unwrap();
            })
            .await;
        });
    });
    let addr = rx.recv().expect("server binds");
    (addr, state, dir)
}

/// std-only temp dirs, same pattern as the sibling crates (no tempfile dependency).
mod tempdir {
    pub struct Dir {
        pub path: std::path::PathBuf,
    }
    pub fn make() -> Dir {
        static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!("al-core-{}-{n}", std::process::id()));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).unwrap();
        Dir { path }
    }
}

fn request(addr: std::net::SocketAddr, raw: &str) -> String {
    let mut s = TcpStream::connect(addr).unwrap();
    s.write_all(raw.as_bytes()).unwrap();
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    out
}

fn post(addr: std::net::SocketAddr, path: &str, body: &str) -> String {
    request(
        addr,
        &format!("POST {path} HTTP/1.1\r\nHost: x\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()),
    )
}

fn trace_payload(session: &str) -> String {
    serde_json::json!({
        "resourceSpans": [{
            "scopeSpans": [{
                "spans": [{
                    "name": "claude_code.api_request",
                    "traceId": "0123456789abcdef0123456789abcdef",
                    "spanId": "0123456789abcdef",
                    "startTimeUnixNano": "1755504000000000000",
                    "attributes": [
                        { "key": "session.id", "value": { "stringValue": session } },
                        { "key": "event.timestamp", "value": { "stringValue": "2025-08-18T08:00:00.000Z" } },
                        { "key": "input_tokens", "value": { "intValue": "100" } }
                    ]
                }]
            }]
        }]
    })
    .to_string()
}

#[test]
fn discovery_probe_matches_the_raw_url_exactly() {
    let (addr, _state, _dir) = start_server();
    let ok = request(addr, "GET /agentlens/standalone HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    assert!(ok.starts_with("HTTP/1.1 200"), "probe answers 200: {ok}");
    assert!(ok.contains(r#"{"agentlens":true,"kind":"standalone"}"#), "probe body is the frozen JSON: {ok}");
    assert!(ok.contains("content-type: application/json"), "probe carries the JSON content type: {ok}");
    // server.ts compares the RAW req.url — a query string must fall through to the bare-200 path.
    let with_query = request(addr, "GET /agentlens/standalone?x=1 HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    assert!(with_query.starts_with("HTTP/1.1 200"), "still 200: {with_query}");
    assert!(!with_query.contains("agentlens"), "query-string probe must NOT get the probe body: {with_query}");
}

#[test]
fn any_non_post_is_a_bare_200() {
    let (addr, _state, _dir) = start_server();
    for req in ["GET /v1/traces HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n",
                "DELETE /anything HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n"] {
        let r = request(addr, req);
        assert!(r.starts_with("HTTP/1.1 200"), "bare 200: {r}");
        assert!(!r.to_lowercase().contains("content-type"), "no content type on the bare 200: {r}");
    }
}

#[test]
fn post_traces_lands_spans_in_the_store_and_answers_empty_200() {
    let (addr, state, dir) = start_server();
    let r = post(addr, "/v1/traces", &trace_payload("sess-core-1"));
    assert!(r.starts_with("HTTP/1.1 200"), "POST answers 200: {r}");
    assert!(r.ends_with("\r\n\r\n") || r.contains("content-length: 0"), "empty body: {r}");
    // Flushed per payload — the day segment holds the span, keyed on the span's own startTime
    // (1755504000000000000 ns = 2025-08-18T08:00:00Z).
    let seg = dir.path.join("spans").join("2025-08-18.ndjson");
    let text = std::fs::read_to_string(&seg).expect("segment written");
    assert!(text.contains("sess-core-1"), "span persisted: {text}");
    assert_eq!(state.lock().unwrap().counters.spans_appended, 1);
}

#[test]
fn classification_routes_when_the_path_names_nothing() {
    let (addr, state, _dir) = start_server();
    let r = post(addr, "/collector", &trace_payload("sess-core-2"));
    assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    let st = state.lock().unwrap();
    assert_eq!(st.counters.traces_payloads, 1, "classified as traces by payload shape");
}

#[test]
fn garbage_and_metrics_still_answer_200() {
    let (addr, state, _dir) = start_server();
    let g = post(addr, "/v1/traces", "\x08garbage-protobuf-not-json");
    assert!(g.starts_with("HTTP/1.1 200"), "parse failure is still 200 (the frozen contract): {g}");
    let m = post(addr, "/v1/metrics", r#"{"resourceMetrics":[]}"#);
    assert!(m.starts_with("HTTP/1.1 200"), "{m}");
    let st = state.lock().unwrap();
    assert_eq!(st.counters.parse_errors, 1);
    assert_eq!(st.counters.metrics_payloads, 1);
    assert_eq!(st.counters.spans_appended, 0, "metrics are accepted and DISCARDED");
}

#[test]
fn a_body_over_the_cap_kills_the_connection_with_no_response() {
    let (addr, _state, _dir) = start_server();
    let mut s = TcpStream::connect(addr).unwrap();
    let claimed = agentlens_core::MAX_BODY_BYTES + 16;
    s.write_all(format!("POST /v1/traces HTTP/1.1\r\nHost: x\r\nContent-Length: {claimed}\r\n\r\n").as_bytes()).unwrap();
    let chunk = vec![b'x'; 1 << 20];
    let mut sent = 0usize;
    let died = loop {
        match s.write_all(&chunk) {
            Ok(()) => {
                sent += chunk.len();
                if sent > claimed { break false; }
            }
            Err(_) => break true, // the server dropped the socket mid-body
        }
    };
    // Whether the write errored or completed into a dead socket, the read side must see the
    // connection END with NO HTTP response ever arriving.
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    assert!(out.is_empty(), "no response on overflow (got: {out:.60})");
    assert!(died || sent >= agentlens_core::MAX_BODY_BYTES, "the cap actually engaged");
}

/// S3-F3b: the gen_ai read-time overlay — the response content arrives as a SEPARATE log event
/// (before OR after its span, different request) and reaches the span on load_range, never by
/// rewriting a persisted segment. Mirrors server.ts processLogs' gen_ai branch +
/// segmentedSpanStore.injectSpanAttribute/applyOverlay (observable in TS via /api/debug/span-attr).
#[test]
fn gen_ai_overlay_reaches_the_stored_span_on_read_in_either_arrival_order() {
    let dir = tempdir::make().path;
    let mut st = agentlens_core::CoreState::open(&dir);
    let now = agentlens_core::now_ms();
    let nano = |ms: i64| (ms as i128 * 1_000_000).to_string();
    let span_body = |sid: &str| serde_json::json!({ "resourceSpans": [{ "scopeSpans": [{ "spans": [{
        "name": "claude_code.llm_request", "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "spanId": sid,
        "startTimeUnixNano": nano(now), "endTimeUnixNano": nano(now + 1000),
        "attributes": [ { "key": "session.id", "value": { "stringValue": "sess-genai" } } ]
    }] }] }] }).to_string();
    let choice_body = |sid: &str| serde_json::json!({ "resourceLogs": [{ "scopeLogs": [{ "logRecords": [{
        "timeUnixNano": nano(now), "traceId": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "spanId": sid,
        "attributes": [ { "key": "event.name", "value": { "stringValue": "gen_ai.choice" } },
                        { "key": "gen_ai.event.content", "value": { "stringValue": "{\"message\":{\"role\":\"assistant\",\"content\":\"hi there\"}}" } } ]
    }] }] }] }).to_string();
    let expected = r#"[{"role":"assistant","content":[{"type":"text","text":"hi there"}]}]"#;
    let attr_of = |span: &serde_json::Value, key: &str| -> Option<String> {
        span["attributes"].as_array()?.iter().find(|a| a["key"] == key).map(|a| a["value"]["stringValue"].as_str().unwrap_or("").to_owned())
    };

    // Span first, choice after (the dominant order).
    agentlens_core::ingest_post(&mut st, "/v1/traces", span_body("00000000000000a1").as_bytes());
    agentlens_core::ingest_post(&mut st, "/v1/logs", choice_body("00000000000000a1").as_bytes());
    // Choice first, span after: the overlay was recorded before the span existed anywhere.
    agentlens_core::ingest_post(&mut st, "/v1/logs", choice_body("00000000000000a2").as_bytes());
    agentlens_core::ingest_post(&mut st, "/v1/traces", span_body("00000000000000a2").as_bytes());

    let read = st.writer.load_range(now - 60_000, i64::MAX, now);
    let by_id = |sid: &str| read.iter().find(|s| s["spanId"] == sid).expect("stored span").clone();
    assert_eq!(attr_of(&by_id("00000000000000a1"), "gen_ai.output.messages").as_deref(), Some(expected));
    let s2 = by_id("00000000000000a2");
    assert_eq!(attr_of(&s2, "gen_ai.output.messages").as_deref(), Some(expected), "order-independent");
    // The LIVE-window copy does NOT carry it — in BOTH engines: injectSpanAttribute on the
    // segmented store always returns true, so the ingest buffer is consumed at the choice event
    // and a span arriving later finds nothing to merge; the content is read-time-only (which is
    // exactly why TS needed /api/debug/span-attr to observe it — /api/summary folds it away).
    let live = st.window.spans.iter().find(|s| s["spanId"] == "00000000000000a2").unwrap();
    assert_eq!(attr_of(live, "gen_ai.output.messages"), None, "live copies stay bare; the overlay is a read-time merge");
    st.writer.flush();
    let mut fresh = agentlens_spanstore::writer::SpanStoreWriter::open(&dir.join("spans"));
    let bare = fresh.load_range(now - 60_000, i64::MAX, now);
    let a1 = bare.iter().find(|s| s["spanId"] == "00000000000000a1").unwrap();
    assert_eq!(attr_of(a1, "gen_ai.output.messages"), None, "the overlay never touched the persisted line");
    // clear() drops the overlay with everything else.
    st.writer.clear();
    assert!(st.writer.load_range(0, i64::MAX, now).is_empty());
}

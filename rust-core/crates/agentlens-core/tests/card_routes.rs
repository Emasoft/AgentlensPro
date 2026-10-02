//! TRDD-9VX3WTGU Phase C — the DuckDB-paginated card routes and the key-column stats route, over a
//! REAL socket: `GET /api/cards/page`, `/api/cards/children`, `/api/cards/by-ids`,
//! `GET /api/stats/overview`.

use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

fn start_ui() -> (std::net::SocketAddr, Arc<Mutex<agentlens_core::CoreState>>) {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let dir = std::env::temp_dir().join(format!("al-core-cards-{}-{n}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let state = Arc::new(Mutex::new(agentlens_core::CoreState::open(&dir)));
    let (utx, urx) = std::sync::mpsc::channel();
    let s = state.clone();
    std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async move {
            let hub = Arc::new(agentlens_core::ui::SseHub::default());
            let ui = agentlens_core::ui::serve_ui("127.0.0.1:0".parse().unwrap(), s, hub, move |b| utx.send(b).unwrap());
            let _ = ui.await;
        });
    });
    (urx.recv().unwrap(), state)
}

fn get(addr: std::net::SocketAddr, path: &str) -> (u16, Value) {
    let mut s = TcpStream::connect(addr).unwrap();
    s.write_all(format!("GET {path} HTTP/1.1\r\nHost: 127.0.0.1:3000\r\nConnection: close\r\n\r\n").as_bytes()).unwrap();
    let mut out = String::new();
    let _ = s.read_to_string(&mut out);
    let status: u16 = out.split_whitespace().nth(1).unwrap().parse().unwrap();
    let body = out.split_once("\r\n\r\n").map(|(_, b)| b).unwrap_or("");
    (status, serde_json::from_str(body).unwrap_or_else(|e| panic!("{path}: body is not JSON ({e}): {body}")))
}

fn card(id: &str, source: &str, minute: u32, parent: Option<&str>) -> Value {
    let mut c = json!({
        "sessionId": id, "source": source, "startTime": format!("2026-08-01T10:{minute:02}:00.000Z"), "durationMs": 0.0,
        "fileOps": [{ "path": "a" }], "timeline": [{ "type": "api_request" }],
    });
    if let Some(p) = parent {
        c["parentSessionId"] = json!(p);
    }
    c
}

fn seed(state: &Arc<Mutex<agentlens_core::CoreState>>) {
    let mut st = state.lock().unwrap();
    for i in 0..5 {
        st.put_log_session(card(&format!("r{i}"), "claude_code", i, None));
    }
    st.put_log_session(card("kid1", "claude_code", 10, Some("r0")));
    st.put_log_session(card("kid2", "claude_code", 11, Some("r0")));
    st.put_log_session(card("cx", "codex", 20, None));
}

#[test]
fn page_walks_the_roots_with_a_cursor_and_serves_stripped_cards() {
    let (ui, state) = start_ui();
    seed(&state);
    let (status, p1) = get(ui, "/api/cards/page?limit=3");
    assert_eq!(status, 200);
    let ids = |p: &Value| -> Vec<String> { p["sessions"].as_array().unwrap().iter().map(|s| s["sessionId"].as_str().unwrap().to_owned()).collect() };
    assert_eq!(ids(&p1), ["cx", "r4", "r3"], "roots only, newest first; children are not listed");
    assert_eq!((p1["hasMore"].clone(), p1["total"].clone()), (json!(true), json!(6)));
    // stripSessionDetail's per-card contract: timeline emptied, fileOps dropped.
    assert_eq!(p1["sessions"][0]["timeline"], json!([]));
    assert!(p1["sessions"][0].get("fileOps").is_none());
    let cursor = p1["nextCursor"].as_str().expect("a cursor while there is more").to_owned();
    assert!(cursor.contains(':'), "{cursor}");

    let (_, p2) = get(ui, &format!("/api/cards/page?limit=3&cursor={cursor}"));
    assert_eq!(ids(&p2), ["r2", "r1", "r0"]);
    assert_eq!((p2["hasMore"].clone(), p2["nextCursor"].clone()), (json!(false), Value::Null));
}

#[test]
fn page_rejects_a_malformed_cursor_or_limit_instead_of_restarting_the_walk() {
    let (ui, state) = start_ui();
    seed(&state);
    for bad in ["cursor=nope", "cursor=1:x", "cursor=NaN:1", "limit=0", "limit=201", "limit=abc"] {
        let (status, body) = get(ui, &format!("/api/cards/page?{bad}"));
        assert_eq!(status, 400, "{bad}: {body}");
        assert!(body["error"].is_string());
    }
    let (status, body) = get(ui, "/api/cards/page");
    assert_eq!((status, body["sessions"].as_array().unwrap().len()), (200, 6), "default limit covers the corpus");
}

#[test]
fn children_and_by_ids_serve_stripped_cards() {
    let (ui, state) = start_ui();
    seed(&state);
    let (status, kids) = get(ui, "/api/cards/children?parentId=r0");
    assert_eq!(status, 200);
    let ids: Vec<&str> = kids["sessions"].as_array().unwrap().iter().map(|s| s["sessionId"].as_str().unwrap()).collect();
    assert_eq!((ids, kids["total"].clone()), (vec!["kid1", "kid2"], json!(2)));
    assert_eq!(kids["sessions"][0]["timeline"], json!([]));
    let (_, none) = get(ui, "/api/cards/children?parentId=r4");
    assert_eq!((none["sessions"].clone(), none["total"].clone()), (json!([]), json!(0)));
    assert_eq!(get(ui, "/api/cards/children").0, 400, "parentId is required");

    let (status, found) = get(ui, "/api/cards/by-ids?ids=cx,kid2,missing");
    assert_eq!(status, 200);
    let ids: Vec<&str> = found["sessions"].as_array().unwrap().iter().map(|s| s["sessionId"].as_str().unwrap()).collect();
    assert_eq!(ids, ["kid2", "cx"], "first-insert order, unknown ids absent");
    assert_eq!(get(ui, "/api/cards/by-ids").1["sessions"], json!([]));
    assert_eq!(get(ui, "/api/cards/nope").0, 404);
}

#[test]
fn stats_overview_aggregates_key_columns_only() {
    let (ui, state) = start_ui();
    let (_, empty) = get(ui, "/api/stats/overview");
    assert_eq!((empty["total"].clone(), empty["activeSessionId"].clone()), (json!(0), Value::Null));
    seed(&state);
    let (status, s) = get(ui, "/api/stats/overview");
    assert_eq!(status, 200);
    assert_eq!((s["total"].clone(), s["roots"].clone(), s["subagents"].clone()), (json!(8), json!(6), json!(2)));
    assert_eq!(s["bySource"], json!({ "claude_code": 7, "codex": 1 }));
    assert_eq!(s["activeSessionId"], "cx", "newest-activity root");
    assert_eq!(s["lastReceivedAtMs"], Value::Null, "needs Phase E's maintained field");
}

//! Cross-engine parity for the raw-body pointer registry (TRDD-DMWOBWFH P4w.1): ONE scripted
//! op/query sequence (callbodyregistry-expected.json, from the compiled rawBodyContext.js)
//! replays through both engines. Small caps (3 sessions × 4 pointers) so BOTH eviction paths
//! run — and they interact: S1's per-session overflow evicts the very pointers a later query
//! looks for, so several answers are the FALLBACK, not the obvious match. That interaction is
//! exactly what a hand-written test would have gotten wrong.
//! After any TS change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-callbodyregistry-expected.mjs

use agentlens_core::call_body_registry::{CallBodyPointer, CallBodyRegistry};
use serde_json::Value;

fn fixtures() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

#[test]
fn registry_reproduces_the_ts_oracle_exactly() {
    let o: Value = serde_json::from_str(&std::fs::read_to_string(fixtures().join("callbodyregistry-expected.json")).unwrap()).unwrap();
    let mut reg = CallBodyRegistry::new(3, 4);
    let s = |v: &Value| v.as_str().map(str::to_owned);
    for op in o["ops"].as_array().unwrap() {
        let f = |i: usize| op[i].clone();
        reg.record(
            f(0).as_str().unwrap_or(""),
            CallBodyPointer {
                kind: if f(1).as_str() == Some("request") { "request" } else { "response" },
                body_ref: s(&f(2)),
                inline_body: None,
                request_id: s(&f(5)),
                span_id: s(&f(4)),
                model: None,
                query_source: None,
                ts: f(3).as_i64().unwrap(),
                ..Default::default()
            },
        );
    }

    // MRU-first session order after both evictions.
    let ids: Vec<&str> = reg.session_ids();
    let want: Vec<&str> = o["sessionIds"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert_eq!(ids, want, "session_ids (MRU first)");

    // The resolve/response query gauntlet — each answer is a bodyRef or null.
    let id = |p: Option<&CallBodyPointer>| p.and_then(|p| p.body_ref.clone()).map_or(Value::Null, Value::from);
    for (q, exp) in o["queries"].as_array().unwrap().iter().zip(o["results"].as_array().unwrap()) {
        let kind = q[0].as_str().unwrap();
        let session = q[1].as_str().unwrap();
        let (a, b) = (s(&q[2]), s(&q[3]));
        let got = match kind {
            "resolveRequest" => id(reg.resolve_request(session, a.as_deref(), b.as_deref())),
            _ => id(reg.response_for(session, a.as_deref(), b.as_deref(), None)),
        };
        assert_eq!(&got, exp, "{kind}({}, {a:?}, {b:?})", &session[..8.min(session.len())]);
    }

    // requestPointers per session, oldest→newest (the 1-based turn mapping the composition
    // index builds on — order IS a contract here).
    for (session, exp) in o["requestPointers"].as_object().unwrap() {
        let got: Vec<Value> = reg.request_pointers(session).iter().map(|p| p.body_ref.clone().map_or(Value::Null, Value::from)).collect();
        assert_eq!(&Value::Array(got), exp, "request_pointers({})", &session[..8]);
    }
}

/// The WIRING, which the parity test above cannot see: a registry that is never fed answers
/// every drill-down with an empty result and looks exactly like "this session has no bodies".
/// The transform has returned `body_pointers` since P3b while nothing consumed them, so this
/// asserts the ingest→registry edge itself, through the REAL `ingest_post`.
#[test]
fn the_logs_ingest_actually_populates_the_registry() {
    let dir = std::env::temp_dir().join(format!("al-cbr-ingest-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut st = agentlens_core::CoreState::open(&dir);
    assert!(st.bodies.is_empty(), "fresh state");

    let sid = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    let event = |name: &str, body_ref: &str, span: &str, req_id: Option<&str>| {
        let mut attrs = vec![
            serde_json::json!({ "key": "event.name", "value": { "stringValue": name } }),
            serde_json::json!({ "key": "session.id", "value": { "stringValue": sid } }),
            serde_json::json!({ "key": "body_ref", "value": { "stringValue": body_ref } }),
            serde_json::json!({ "key": "user.account_uuid", "value": { "stringValue": "acct-aaaa" } }),
            serde_json::json!({ "key": "model", "value": { "stringValue": "claude-opus-5" } }),
        ];
        if let Some(r) = req_id {
            attrs.push(serde_json::json!({ "key": "request_id", "value": { "stringValue": r } }));
        }
        serde_json::json!({ "spanId": span, "timeUnixNano": "1787000000000000000", "attributes": attrs })
    };
    let payload = serde_json::json!({ "resourceLogs": [{ "scopeLogs": [{ "logRecords": [
        event("claude_code.api_request_body", "/tmp/bodies/one.request.json", "span-1", None),
        event("claude_code.api_response_body", "/tmp/bodies/one.response.json", "span-1", Some("req-1")),
    ] }] }] });
    agentlens_core::ingest_post(&mut st, "/v1/logs", payload.to_string().as_bytes());

    assert_eq!(st.bodies.len(), 1, "one session recorded");
    assert_eq!(st.bodies.session_ids(), vec![sid]);
    let reqs = st.bodies.request_pointers(sid);
    assert_eq!(reqs.len(), 1, "the request pointer landed");
    assert_eq!(reqs[0].body_ref.as_deref(), Some("/tmp/bodies/one.request.json"));
    assert_eq!(reqs[0].model.as_deref(), Some("claude-opus-5"));
    // The response half is what makes EXACT per-call usage readable — joined on the shared span.
    let resp = st.bodies.response_for(sid, Some("span-1"), None, None).expect("response paired by spanId");
    assert_eq!(resp.body_ref.as_deref(), Some("/tmp/bodies/one.response.json"));
    // …and the request-id hop back to the request (the drill-down's own entry point).
    let back = st.bodies.resolve_request(sid, Some("req-1"), None).expect("hop response→request");
    assert_eq!(back.body_ref.as_deref(), Some("/tmp/bodies/one.request.json"));
    // The account half still lands in its own registry — one fact, one source.
    assert_eq!(st.accounts.account_for(sid), Some("acct-aaaa"));
    let _ = std::fs::remove_dir_all(&dir);
}

/// TRDD-ZQQYRYBO I12a — two agents of ONE session interleave: agent A's request, then agent
/// B's request, then A's response (no shared spanId, as with separate subagent processes). The
/// nearest-preceding-ts guess pairs A's response with B's request; CC ≥2.1.274's
/// request_body_id, carried by both body events, pairs it exactly.
#[test]
fn request_body_id_pairs_interleaved_agents_that_the_timestamp_guess_mispairs() {
    let sid = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    let ptr = |kind: &'static str, body: &str, ts: i64, req_id: Option<&str>, rbid: Option<&str>| CallBodyPointer {
        kind,
        body_ref: Some(body.into()),
        request_id: req_id.map(str::to_owned),
        request_body_id: rbid.map(str::to_owned),
        ts,
        ..Default::default()
    };
    let mut reg = CallBodyRegistry::default();
    reg.record(sid, ptr("request", "/b/agentA.request.json", 1, None, Some("rb-A")));
    reg.record(sid, ptr("request", "/b/agentB.request.json", 2, None, Some("rb-B")));
    reg.record(sid, ptr("response", "/b/agentA.response.json", 3, Some("req-A"), Some("rb-A")));

    let got = reg.resolve_request(sid, Some("req-A"), None).expect("resolved");
    assert_eq!(got.body_ref.as_deref(), Some("/b/agentA.request.json"), "exact pair by request_body_id");
    let resp = reg.response_for(sid, None, None, Some("rb-A")).expect("response by request_body_id");
    assert_eq!(resp.body_ref.as_deref(), Some("/b/agentA.response.json"));
    assert!(reg.response_for(sid, None, None, Some("rb-B")).is_none(), "B has no response yet");

    // The same interleaving WITHOUT the id (a pre-2.1.274 capture) still resolves through the
    // old fallback — and shows the mispairing the id exists to prevent.
    let mut old = CallBodyRegistry::default();
    old.record(sid, ptr("request", "/b/agentA.request.json", 1, None, None));
    old.record(sid, ptr("request", "/b/agentB.request.json", 2, None, None));
    old.record(sid, ptr("response", "/b/agentA.response.json", 3, Some("req-A"), None));
    let guessed = old.resolve_request(sid, Some("req-A"), None).expect("fallback still resolves");
    assert_eq!(guessed.body_ref.as_deref(), Some("/b/agentB.request.json"), "the ts guess picks the wrong agent");
}

/// The ingest half: the three CC 2.1.274 attributes actually reach the registry through the
/// REAL `ingest_post`, under their documented names (`request_body_id`, `message.id`,
/// `message.uuid`) — monitoring-usage docs, api_request_body / api_response_body events.
#[test]
fn the_logs_ingest_carries_request_body_id_and_message_ids() {
    let dir = std::env::temp_dir().join(format!("al-cbr-rbid-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut st = agentlens_core::CoreState::open(&dir);
    let sid = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    let kv = |k: &str, v: &str| serde_json::json!({ "key": k, "value": { "stringValue": v } });
    let req = serde_json::json!({ "timeUnixNano": "1787000000000000000", "attributes": [
        kv("event.name", "claude_code.api_request_body"), kv("session.id", sid),
        kv("body_ref", "/tmp/bodies/x.request.json"), kv("request_body_id", "rb-X"),
    ] });
    let resp = serde_json::json!({ "timeUnixNano": "1787000000000000001", "attributes": [
        kv("event.name", "claude_code.api_response_body"), kv("session.id", sid),
        kv("body_ref", "/tmp/bodies/req-X.response.json"), kv("request_id", "req-X"),
        kv("request_body_id", "rb-X"), kv("message.id", "msg-X"), kv("message.uuid", "uuid-X"),
    ] });
    let payload = serde_json::json!({ "resourceLogs": [{ "scopeLogs": [{ "logRecords": [req, resp] }] }] });
    agentlens_core::ingest_post(&mut st, "/v1/logs", payload.to_string().as_bytes());

    let reqs = st.bodies.request_pointers(sid);
    assert_eq!(reqs[0].request_body_id.as_deref(), Some("rb-X"));
    let r = st.bodies.response_for(sid, None, None, Some("rb-X")).expect("response by request_body_id");
    assert_eq!(r.message_id.as_deref(), Some("msg-X"));
    assert_eq!(r.message_uuid.as_deref(), Some("uuid-X"));
    let back = st.bodies.resolve_request(sid, Some("req-X"), None).expect("hop by request_body_id");
    assert_eq!(back.body_ref.as_deref(), Some("/tmp/bodies/x.request.json"));
    let _ = std::fs::remove_dir_all(&dir);
}

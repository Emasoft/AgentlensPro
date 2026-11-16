//! TRDD-735Q3JF4 item 3: `compositions_in_scope` takes its `sessionId → project` map from the cards table
//! and the burn subset (`ui::composition_projects`) instead of `summary_now`. These tests pin that the map
//! equals `composition_project_map` over the full summary for every bodies id, and that the scope pass
//! never starts the whole-summary path.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use serde_json::{json, Value};

use crate::call_body_registry::CallBodyPointer;
use crate::ui::{composition_projects, compositions_in_scope};
use crate::{composition_project_map, BurnInputs, CoreState, LockTimed};

/// A fixed clock: the OTEL span times are built from it, so no run depends on the wall clock.
const NOW: f64 = 1_790_000_000_000.0;

/// The fixture's ids and the project each must map to. `None` means the id must be absent from the map: a
/// placeholder the full merge collapses into its `agent-` transcript.
const EXPECTED: [(&str, Option<&str>); 12] = [
    ("c-proj", Some("/proj/a")),
    ("c-ws", Some("/ws/only")),
    ("c-empty", Some("")),
    ("c-none", Some("unknown")),
    ("c-demoted", Some("/proj/demoted")),
    ("otel-only", Some("")),
    ("otel-displaced", Some("/ws/displaced")),
    ("otel-nonclaude", Some("")),
    ("ph-collapse", None),
    ("agent-ph-collapse", Some("/ws/ph")),
    ("ph-kept", Some("/ws/kept")),
    ("agent-ph-kept", Some("/ws/t")),
];

fn pointer() -> CallBodyPointer {
    CallBodyPointer {
        kind: "request",
        body_ref: None,
        inline_body: Some("{}".to_owned()),
        request_id: None,
        span_id: None,
        model: None,
        query_source: None,
        request_body_id: None,
        message_id: None,
        message_uuid: None,
        ts: 0,
    }
}

/// An OTEL `claude_code.api_request` span for `session`: an OTEL window session with no card of its own.
fn otel_post(session: &str, now: f64) -> String {
    // One id per session: with a shared id the third post's session was missing from the OTEL window in the first
    // run of this test. The store's keying behind that is not checked here.
    let hash = session.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |h, b| (h ^ u64::from(b)).wrapping_mul(0x0100_0000_01b3));
    let trace_id = format!("{hash:016x}{hash:016x}");
    let span_id = format!("{hash:016x}");
    let nanos = format!("{}", (now as i64 - 120_000) * 1_000_000);
    json!({ "resourceSpans": [{ "scopeSpans": [{ "spans": [{
        "name": "claude_code.api_request",
        "traceId": trace_id, "spanId": span_id,
        "startTimeUnixNano": nanos,
        "attributes": [
            { "key": "session.id", "value": { "stringValue": session } },
            { "key": "input_tokens", "value": { "intValue": "9000" } },
            { "key": "cost_usd", "value": { "doubleValue": 7.5 } }
        ]
    }] }] }] })
    .to_string()
}

/// A Claude log card: every field the feed merge reads is present, and `fields` overrides or adds to them.
fn log_card(id: &str, fields: Value) -> Value {
    let mut card = json!({
        "sessionId": id, "source": "claude_code", "dataSource": "log",
        "startTime": "2026-09-21T00:00:00.000Z", "timeline": [],
        "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0, "cacheCreateTokens": 0,
    });
    for (key, value) in fields.as_object().expect("the fields of a card are an object") {
        card[key.as_str()] = value.clone();
    }
    card
}

/// One state holding every case the item-3 mapping has to get right. Each card goes through `put_log_session`,
/// so the cards table holds it exactly as the resident layer does.
fn fixture(dir: &std::path::Path) -> Arc<Mutex<CoreState>> {
    let state = Arc::new(Mutex::new(CoreState::open(dir)));
    {
        let mut st = state.lock_timed();
        // OTEL-only session: a window session with no card row at all.
        crate::ingest_post(&mut st, "/v1/traces", otel_post("otel-only", NOW).as_bytes());
        // OTEL twin displaced by a claude card whose workspace differs from the OTEL project ("").
        crate::ingest_post(&mut st, "/v1/traces", otel_post("otel-displaced", NOW).as_bytes());
        st.put_log_session(log_card("otel-displaced", json!({ "workspace": "/ws/displaced" })));
        // OTEL twin under a NON-claude card: the OTEL side survives and the card is dropped.
        crate::ingest_post(&mut st, "/v1/traces", otel_post("otel-nonclaude", NOW).as_bytes());
        st.put_log_session(log_card("otel-nonclaude", json!({ "source": "codex", "workspace": "/ws/codex" })));
        // Card projections: projectPath first, then workspace, an empty string kept, nothing at all -> unknown.
        st.put_log_session(log_card("c-proj", json!({ "projectPath": "/proj/a", "workspace": "/ws/x" })));
        st.put_log_session(log_card("c-ws", json!({ "workspace": "/ws/only" })));
        st.put_log_session(log_card("c-empty", json!({ "projectPath": "", "workspace": "/ws/y" })));
        st.put_log_session(log_card("c-none", json!({})));
        // A demoted card: its timeline is empty, its projectPath is what the map reads.
        st.put_log_session(log_card("c-demoted", json!({ "projectPath": "/proj/demoted", "timelineTruncatedCount": 4 })));
        // A placeholder with NO traffic under a transcript WITH traffic: the full merge collapses them.
        st.put_log_session(log_card("ph-collapse", json!({ "parentSessionId": "c-proj", "workspace": "/ws/ph", "inputTokens": 0 })));
        st.put_log_session(log_card("agent-ph-collapse", json!({ "parentSessionId": "c-proj", "workspace": "", "inputTokens": 8000 })));
        // A placeholder WITH traffic under a transcript with none: the full merge keeps both.
        st.put_log_session(log_card("ph-kept", json!({ "parentSessionId": "c-proj", "workspace": "/ws/kept", "inputTokens": 4000 })));
        st.put_log_session(log_card("agent-ph-kept", json!({ "parentSessionId": "c-proj", "workspace": "/ws/t", "inputTokens": 0 })));
        for id in EXPECTED.iter().map(|(id, _)| *id) {
            st.bodies.record(id, pointer());
        }
    }
    state
}

/// The oracle: `composition_project_map` over `summary_over` of the corpus. The snapshot is taken under the
/// lock and the summary is built after the guard drops, so the oracle itself never holds the lock.
fn full_projects(state: &Arc<Mutex<CoreState>>) -> HashMap<String, String> {
    let BurnInputs { spans, cards, accounts } = state.lock_timed().burn_snapshot();
    composition_project_map(&CoreState::summary_over(&spans, &cards, &accounts, NOW).0)
}

fn bodies_ids(state: &Arc<Mutex<CoreState>>) -> Vec<String> {
    state.lock_timed().bodies.session_ids().iter().map(|s| (*s).to_owned()).collect()
}

/// PARITY, the whole fixture: the subset map equals `composition_project_map` over the full summary for every
/// bodies id, and each case of `EXPECTED` maps as the full merge does. The literal check is what catches a
/// wrong projection that the oracle would share (the oracle and the subset both call `composition_project_map`).
///
/// MUTATION CHECKS (each makes this fail): the nullish fallthrough in `composition_project_map` (an empty
/// `projectPath` falls through to `workspace`); dropping the OTEL-only side of the merge in `composition_projects`;
/// putting the OTEL side after the card rows, so an OTEL twin overrides the card that displaces it.
#[tokio::test]
async fn the_composition_projects_equal_the_full_summary_for_every_bodies_id() {
    let (dir, _cleanup) = temp("parity");
    let state = fixture(&dir);
    let ids = bodies_ids(&state);
    let full = full_projects(&state);
    let subset = composition_projects(&state, &ids).await.expect("the subset projects");
    for id in &ids {
        assert_eq!(subset.get(id), full.get(id), "project of {id}: subset vs full summary");
    }
    for (id, want) in EXPECTED {
        assert_eq!(subset.get(id).map(String::as_str), want, "project of {id}");
    }
}

/// CLOSURE: each bodies id on its own gives the same project as the full summary. Alone, a placeholder's
/// transcript or a transcript's placeholder is absent from the bodies, so this fails if the card read does not
/// fetch the `agent-` twin and the placeholder that the merge needs.
#[tokio::test]
async fn each_bodies_id_alone_maps_as_in_the_full_summary() {
    let (dir, _cleanup) = temp("closure");
    let state = fixture(&dir);
    let full = full_projects(&state);
    for id in bodies_ids(&state) {
        let alone = composition_projects(&state, std::slice::from_ref(&id)).await.expect("the projects of one bodies id");
        assert_eq!(alone.get(&id), full.get(&id), "project of {id} alone");
    }
}

/// Asking for the scope pass must not start the whole-summary path: no `summary_asked`, no cached summary. And
/// neither the scope pass, its helper nor the resident-blob scan that calls it may name `summary_now` as a call.
#[tokio::test]
async fn the_composition_scope_never_asks_for_the_full_summary() {
    let (dir, _cleanup) = temp("unasked");
    let state = fixture(&dir);
    let _ = compositions_in_scope(&state, None, NOW).await.expect("the scope pass");
    // Every check runs before any is asserted, so one failing check cannot hide another.
    let mut failures: Vec<String> = Vec::new();
    {
        let mut st = state.lock_timed();
        let version = st.data_version;
        if st.summary_asked {
            failures.push("the scope pass set summary_asked, so it released the rebuild loop".to_owned());
        }
        if st.summary_cache.current(version).is_some() {
            failures.push("the scope pass left a cached full summary".to_owned());
        }
    }
    let ui = include_str!("ui.rs");
    let chores = include_str!("chores.rs");
    let scans = [
        ("ui.rs compositions_in_scope", fn_body(ui, "pub(crate) async fn compositions_in_scope")),
        ("ui.rs composition_projects", fn_body(ui, "pub(crate) async fn composition_projects")),
        ("chores.rs resident_blob_scan", fn_body(chores, "async fn resident_blob_scan")),
    ];
    for (name, body) in scans {
        let hits: Vec<&str> = body.lines().filter(|l| !l.trim_start().starts_with("//") && bare_summary_now_call(l)).collect();
        if !hits.is_empty() {
            failures.push(format!("{name} must not call summary_now: {hits:?}"));
        }
    }
    assert!(failures.is_empty(), "the scope pass asks for the full summary:\n{failures:#?}");
}

/// The text of the function whose header starts with `start`, up to its closing brace at column 0.
fn fn_body<'a>(src: &'a str, start: &str) -> &'a str {
    let from = src.find(start).unwrap_or_else(|| panic!("{start} is in the source"));
    let rest = &src[from..];
    let end = rest.find("\n}\n").unwrap_or_else(|| panic!("{start} closes"));
    &rest[..end]
}

/// A bare `summary_now(` call, not a longer name that ends in it (`burn_summary_now(` is the replacement).
fn bare_summary_now_call(line: &str) -> bool {
    line.match_indices("summary_now(").any(|(i, _)| !line[..i].ends_with(|c: char| c.is_alphanumeric() || c == '_'))
}

struct Cleanup(std::path::PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn temp(tag: &str) -> (std::path::PathBuf, Cleanup) {
    let dir = std::env::temp_dir().join(format!("al-compsubset-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    (dir.clone(), Cleanup(dir))
}

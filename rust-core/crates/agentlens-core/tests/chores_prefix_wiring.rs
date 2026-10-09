//! QSFYIHUO step 2, round-2 spec S6: the PRODUCTION path provably threads the prefix extractor.
//!
//! The chain under test is the real one — `bodies_pass` (chores.rs) constructs the extractor
//! (`extract_turn_prefix` → `to_prefix_json`, v:1 envelope) and passes it through
//! `ingest_pass_observed_with` → `ingest_body_with` → the api_call row's `prefix_json` column.
//! Asserting at the construction site per the fsync-barrier precedent closes the silent-NULL
//! future-caller failure mode: a caller that bypasses chores.rs writes NULL rows, and this test's
//! sibling (the store read path in agentlens-store) treats NULL exactly as "fall back to the body
//! scan" — so a wiring regression would be INVISIBLE to every other test.
//!
//! MUTATION CHECK: revert chores.rs's `ingest_pass_observed_with(..., Some(&mut prefix_extractor))`
//! to `ingest_pass_observed(..., observer)` (extractor dropped) and `production_pass_persists_the_prefix`
//! MUST fail with prefix_json NULL.

use std::sync::{Arc, Mutex};

use agentlens_core::{chores::bodies_pass, CoreState};

// Same heavy-DuckDB slot discipline as chores_bodies_spool_drain.rs: bodies_pass takes the
// process-wide heavy slot and skips its tick when busy, so these tests run one at a time.
static SLOT: Mutex<()> = Mutex::new(());

fn request_body(tag: &str) -> String {
    format!(
        r#"{{"model":"claude-opus-5","system":[{{"type":"text","text":"rules block {tag}"}}],"tools":[{{"name":"Bash"}}],"messages":[{{"role":"user","content":[{{"type":"text","text":"hello {tag}","cache_control":{{"type":"ephemeral"}}}}]}}]}}"#
    )
}

fn write_aged(p: &std::path::Path, raw: &str, age_secs: u64) {
    std::fs::write(p, raw).unwrap();
    let t = std::time::SystemTime::now() - std::time::Duration::from_secs(age_secs);
    std::fs::OpenOptions::new().write(true).open(p).unwrap().set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
}

/// The production chain persists a v:1 prefix on the request row.
#[test]
fn production_pass_persists_the_prefix() {
    let _serial = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = std::env::temp_dir().join(format!("al-prefix-wiring-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let data_dir = tmp.join("data");
    let bodies_dir = data_dir.join("otel-bodies");
    std::fs::create_dir_all(&bodies_dir).unwrap();

    let name = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.request.json";
    write_aged(&bodies_dir.join(name), &request_body("w1"), 15);

    let state = Arc::new(Mutex::new(CoreState::open(&data_dir)));
    bodies_pass(&state, agentlens_core::now_ms() as f64);
    assert!(!bodies_dir.join(name).exists(), "the body must be ingested and reclaimed");

    // Flush is internal to the pass's settle; open the store and read the row back from the
    // durable parts (parquet_scan covers parts + staging, so either state reads).
    let store_dir = data_dir.join("store");
    let rows = agentlens_store::bodies_evidence::list_prefix_rows(&store_dir, None, 100).expect("prefix query must succeed");
    assert_eq!(rows.len(), 1, "one request row: {rows:?}");
    let raw = rows[0].prefix_json.as_deref().expect("prefix_json MUST be persisted by the production wiring (S6): got NULL");
    let v: serde_json::Value = serde_json::from_str(raw).expect("prefix_json must be JSON");
    assert_eq!(v["v"], 1, "the envelope version must be the current PREFIX_VERSION: {v}");
    assert!(v["p"].is_object(), "the envelope carries the prefix at 'p': {v}");
    // The inner object is the TurnPrefix wire shape — spot the load-bearing keys.
    assert!(v["p"]["messageBlocks"].is_array(), "prefix carries messageBlocks: {v}");
    assert!(v["p"]["systemBlocks"].is_array(), "prefix carries systemBlocks: {v}");

    // And the S1 round-trip through the reader: the persisted value classifies.
    let prefix = agentlens_core::turn_prefix_codec::from_prefix_json(Some(raw));
    assert!(prefix.is_some(), "the persisted prefix must parse under the S1 policy");

    let _ = std::fs::remove_dir_all(&tmp);
}

/// A response row carries NO prefix (it is request-only) and a non-JSON body gets no api_call row
/// at all — the pre-existing append_body_row contract, re-pinned here because the wiring now runs
/// the extractor over every file the pass reads.
#[test]
fn response_rows_and_unparseable_bodies_stay_null_free() {
    let _serial = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = std::env::temp_dir().join(format!("al-prefix-nulls-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let data_dir = tmp.join("data");
    let bodies_dir = data_dir.join("otel-bodies");
    std::fs::create_dir_all(&bodies_dir).unwrap();

    write_aged(&bodies_dir.join("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.response.json"), r#"{"id":"msg_01x","usage":{"input_tokens":1}}"#, 15);
    write_aged(&bodies_dir.join("bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee.request.json"), "this is not json", 15);

    let state = Arc::new(Mutex::new(CoreState::open(&data_dir)));
    bodies_pass(&state, agentlens_core::now_ms() as f64);

    let store_dir = data_dir.join("store");
    // The request-only read: the non-JSON request got no api_call row and the response is filtered
    // out by kind, so the prefix listing is empty.
    let rows = agentlens_store::bodies_evidence::list_prefix_rows(&store_dir, None, 100).expect("prefix query must succeed");
    assert!(rows.is_empty(), "no REQUEST row exists here: {rows:?}");

    // The response row itself exists in the relation and its prefix_json is NULL — the write
    // boundary (append_api_call_row nulls the column for non-request rows), read directly with a
    // plain in-memory DuckDB over the parts (the same fileless pattern bodies_evidence uses).
    let scan = agentlens_store::parquet_scan(&store_dir, agentlens_store::API_CALLS_DIR).expect("api_call parts exist after the pass");
    let con = agentlens_store::duckdb::Connection::open_in_memory().expect("duck open");
    let mut stmt = con.prepare(&format!("SELECT kind, prefix_json FROM {scan}")).expect("prepare");
    let mut got: Vec<(String, Option<String>)> = Vec::new();
    let mut qrows = stmt.query([]).expect("query");
    while let Some(r) = qrows.next().expect("row") {
        let kind: String = r.get(0).expect("kind");
        let prefix_json: Option<String> = r.get(1).expect("prefix_json");
        got.push((kind, prefix_json));
    }
    assert_eq!(got, vec![("response".to_owned(), None)], "response row carries NO prefix (write-boundary guard)");

    let _ = std::fs::remove_dir_all(&tmp);
}

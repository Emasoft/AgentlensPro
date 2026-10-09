//! QSFYIHUO step 2, round-2 spec S4 + F2: the per-cause verdict MATRIX through BOTH paths.
//!
//! Every case in the TS parity oracle (52 body pairs/triples covering 29 distinct causes) is run
//! through `classify_cache_break` TWICE:
//!   1. BODY path  — prefixes from `extract_turn_prefix(raw_body)` (today's read path);
//!   2. STORE path — prefixes from `from_prefix_json(to_prefix_json(body_path_prefix))`, i.e. the
//!      serialized form the api_call row will carry after ingest.
//!
//! The two full verdict objects must be DEEP-EQUAL per case. A divergence means the persisted
//! prefix loses facts the classifier needs — the exact regression the card's parity bar forbids.
//!
//! This is the test S3's round-trip protects: F2 (mixed-provenance classification soundness) is
//! load-bearing, and this file proves it END TO END over the real classifier, not just the codec.
//!
//! The oracle cases carry the special shapes S4 names: SUBAGENT_INTERLEAVE is an A→B→A TRIPLE
//! (prev2 present), TTL_EXPIRY arrives through the controlled ts/gap channel (`gapMs` in the
//! timing, metadata rather than body-derived), COMPACTION rides the inference path (no hook
//! fixture at this layer — the hook-corroborated variant is the timeline layer's, out of scope
//! here by the same note the design records).

use agentlens_core::cache_break_timeline::{classify_cache_break, extract_turn_prefix, BreakTiming, TurnPrefix};
use agentlens_core::turn_prefix_codec::{from_prefix_json, to_prefix_json};
use serde_json::Value;
fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cbverdict-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn prefix_of(v: &Value) -> Option<TurnPrefix> {
    extract_turn_prefix(Some(v))
}

fn store_path_prefix(body_prefix: &Option<TurnPrefix>) -> Option<TurnPrefix> {
    let p = body_prefix.as_ref()?;
    from_prefix_json(Some(&to_prefix_json(p)))
}

fn timing_of(t: &Value) -> BreakTiming {
    let num = |k: &str| t.get(k).and_then(Value::as_f64);
    BreakTiming {
        gap_ms: num("gapMs"),
        cache_read_tokens: num("cacheReadTokens").unwrap_or(0.0),
        cache_create_tokens: num("cacheCreateTokens").unwrap_or(0.0),
        ephemeral_5m_tokens: num("ephemeral5mTokens").unwrap_or(0.0),
        ephemeral_1h_tokens: num("ephemeral1hTokens").unwrap_or(0.0),
        blocks_added_since_last_write: num("blocksAddedSinceLastWrite"),
    }
}

#[test]
fn every_oracle_cause_classifies_identically_through_the_store_path() {
    let o = oracle();
    let cases = o["cases"].as_object().expect("cases");
    let mut causes_covered = std::collections::HashSet::new();
    let mut store_fed = 0usize;
    for (name, c) in cases {
        // Path 1 — the body path, exactly as cbverdict_parity runs it.
        let prev_body = prefix_of(&c["prev"]);
        let prev2_body = prefix_of(&c["prev2"]);
        let cur_body = prefix_of(&c["cur"]).unwrap_or_else(|| panic!("{name}: cur body must parse"));
        let body_verdict = classify_cache_break(prev_body.as_ref(), &cur_body, &timing_of(&c["timing"]), prev2_body.as_ref()).to_value();
        causes_covered.insert(body_verdict["cause"].as_str().unwrap_or("?").to_owned());

        // Path 2 — the store path: the SAME bodies' prefixes serialized + re-parsed.
        // ABSENCE round-trips as absence: a body with no prefix (COLD_START's no-prev case) has
        // no prefix on the store path either — a NULL prefix_json row falls back to the body
        // scan, which is exactly the body verdict this case already produced above. But whenever
        // a body prefix EXISTS, the codec must carry it (a None here is a failure: the codec
        // must serve all 29 causes), so we assert is_some rather than falling back — a fallback
        // would silently re-run the body path and prove nothing about the store path.
        assert_eq!(
            store_path_prefix(&prev_body).is_some(),
            prev_body.is_some(),
            "{name}: prev prefix must round-trip whenever it exists"
        );
        assert_eq!(
            store_path_prefix(&prev2_body).is_some(),
            prev2_body.is_some(),
            "{name}: prev2 prefix must round-trip whenever it exists"
        );
        let prev_store = store_path_prefix(&prev_body);
        let prev2_store = store_path_prefix(&prev2_body);
        let cur_store = store_path_prefix(&Some(cur_body)).unwrap_or_else(|| panic!("{name}: cur prefix must round-trip"));
        let store_verdict = classify_cache_break(prev_store.as_ref(), &cur_store, &timing_of(&c["timing"]), prev2_store.as_ref()).to_value();
        assert_eq!(
            store_verdict, body_verdict,
            "{name}: store-path verdict diverges from body-path verdict\n  body={body_verdict}\n  store={store_verdict}"
        );
        // The is_some asserts above PANIC on any populated slot that failed to round-trip, so
        // reaching this line means every slot went through the SERIALIZED prefix — `store_fed
        // >= 52` below therefore asserts the store path classified every case, not a silent
        // body-path fallback.
        store_fed += 1;
    }
    assert!(causes_covered.len() >= 29, "the matrix must cover the full cause ladder; got {causes_covered:?}");
    assert!(store_fed >= 52, "every oracle case through the store path; got {store_fed}");
}

// ── F1 (review round 1): the scan-level store-first branch, end to end ───────────
//
// MUTATION TARGET: `scan_sessions_and_responses`'s store-prefix pass + the store-covered dedup
// (agentlens-core/src/cache_break_timeline.rs, the QSFYIHUO store-first block). Deleting the
// store pass, the dedup, or the NULL-fall-through must fail this test.
//
// Fixture: a REAL Parquet store written through the REAL ingest path (`ingest_pass_observed_with`
// with a prefix-extracting observer for two of the three requests, without for the third — the
// pre-extractor NULL row), sealed by the pass's own settle, plus a spool dir holding a plain copy
// of ONE ingested request (the store+spool overlap) and one spool-only request. One response row
// feeds the classifier its usage.
//
// Assertions: every turn classifies exactly once (no double-count of the overlapping stem —
// turnsInSession == 4), the NULL-prefix row still classifies via the body scan (its turn exists
// and its verdict matches the body-path verdict for the same body), and the coverage note reports
// the store-fed prefixes.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use agentlens_core::cache_break_timeline::CacheBreakTimelineOptions;
use agentlens_store::pass::{ingest_pass_observed_with, PassOptions as StorePassOptions};

fn matrix_fixture(tag: &str) -> (PathBuf, PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("al-matrix-{tag}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&root);
    let data = root.join("data");
    let spool = data.join("otel-bodies");
    let store = data.join("store");
    fs::create_dir_all(&spool).unwrap();
    (data, spool, store)
}

fn write_aged(p: &Path, raw: &str, age_ms: u64) {
    fs::write(p, raw).unwrap();
    let t = std::time::SystemTime::now() - std::time::Duration::from_millis(age_ms);
    fs::OpenOptions::new().write(true).open(p).unwrap().set_times(fs::FileTimes::new().set_modified(t)).unwrap();
}

/// A realistic request body whose prefix extract_turn_prefix can derive (billing header, system
/// blocks, one user message with a breakpoint) and whose session id rides metadata.user_id.
fn req_body(session: &str, prev_req: &str, user_text: &str) -> String {
    let pad = "r".repeat(400);
    serde_json::json!({
        "model": "claude-opus-5",
        "metadata": { "user_id": format!("{{\"session_id\":\"{session}\"}}") },
        "system": [
            { "type": "text", "text": format!("x-anthropic-billing-header: cc_version=2.1.258.c18; cc_entrypoint=cli; cc_is_subagent=true; cc_prev_req={prev_req};") },
            { "type": "text", "text": format!("stable rules block {pad}"), "cache_control": {"type":"ephemeral"} }
        ],
        "tools": [ {"name":"Bash"}, {"name":"Read"} ],
        "messages": [ { "role":"user", "content": [ {"type":"text","text":user_text, "cache_control": {"type":"ephemeral"}} ] } ]
    })
    .to_string()
}

fn resp_body(id: &str, prev_req: &str, create: i64) -> String {
    serde_json::json!({
        "id": id,
        "type": "message",
        "model": "claude-opus-5",
        "stop_reason": "end_turn",
        "content": [ {"type":"text","text":"an answer"} ],
        "usage": { "input_tokens": 10, "output_tokens": 20,
                   "cache_read_input_tokens": 8000, "cache_creation_input_tokens": create },
        "diagnostics": { "previous_request_id": prev_req }
    })
    .to_string()
}

#[test]
fn scan_seeds_store_prefixes_without_double_counting_or_dropping_turns() {
    let (data, spool, store) = matrix_fixture("scan");

    // Three requests: sess-s turns 1 and 2 ingested WITH the extractor; turn 3 WITHOUT (the
    // pre-extractor NULL row). One spool-only request exists for the same session (the
    // body-scan-only turn) — it is written only AFTER pass 1 so it never gets a prefix.
    let t1 = req_body("sess-s", "req_s1", "first user turn");
    let t2 = req_body("sess-s", "req_s2", "second user turn");
    let t3 = req_body("sess-s", "req_s3", "third user turn");
    let t4 = req_body("sess-s", "req_s4", "fourth user turn, spool only");
    write_aged(&spool.join("c0fefefe-0000-4000-8000-000000000001.request.json"), &t1, 240_000);
    write_aged(&spool.join("c0fefefe-0000-4000-8000-000000000002.request.json"), &t2, 180_000);
    write_aged(&spool.join("c0fefefe-0000-4000-8000-000000000003.request.json"), &t3, 120_000);
    write_aged(&spool.join("req_s1.response.json"), &resp_body("msg_s1", "req_s1", 9000), 200_000);
    write_aged(&spool.join("req_s2.response.json"), &resp_body("msg_s2", "req_s2", 11000), 140_000);
    write_aged(&spool.join("req_s3.response.json"), &resp_body("msg_s3", "req_s3", 13000), 80_000);

    // Pass 1 — WITH the prefix extractor: t1..t3 (+ the three responses). The pass's own settle
    // seals the parts, so the rows are durable parquet before the read below.
    let mut store_con = agentlens_store::open_store(&store, agentlens_store::DEFAULT_MEMORY_LIMIT, 4).expect("open");
    let opts = StorePassOptions { bodies_dir: spool.clone(), ..Default::default() };
    let (mut skip, mut stranded, mut fsynced) = (HashSet::new(), HashSet::new(), HashSet::new());
    let mut extractor = |parsed: Option<&serde_json::Value>| -> Option<String> {
        agentlens_core::cache_break_timeline::extract_turn_prefix(parsed).map(|p| to_prefix_json(&p))
    };
    let r = ingest_pass_observed_with(&mut store_con, &opts, &mut skip, &mut stranded, &mut fsynced, None, Some(&mut extractor));
    assert!(r.failed.is_empty(), "pass 1 failed: {:?}", r.failed);

    // Pass 2 — WITHOUT the extractor, on a spool holding ONLY the new t4 (pass 1 deleted what it
    // ingested). t4 ingests NULL-prefix — exactly the mixed-generation store the read path must
    // survive. THEN the store+spool overlap is created: t1's file re-appears in the spool but is
    // NEVER re-ingested; the evidence union must skip it (the store holds that src_name), so the
    // scan sees one row for the stem, not two.
    write_aged(&spool.join("c0fefefe-0000-4000-8000-000000000004.request.json"), &t4, 60_000);
    let (mut skip2, mut stranded2, mut fsynced2) = (HashSet::new(), HashSet::new(), HashSet::new());
    let r2 = ingest_pass_observed_with(&mut store_con, &opts, &mut skip2, &mut stranded2, &mut fsynced2, None, None);
    assert_eq!(r2.ingested, 1, "pass 2 ingests only t4: {:?}", r2.failed);
    drop(store_con);
    write_aged(&spool.join("c0fefefe-0000-4000-8000-000000000001.request.json"), &t1, 240_000); // the overlap copy
    let rows = agentlens_store::bodies_evidence::list_prefix_rows(&store, None, 100).expect("prefix rows");
    assert_eq!(rows.len(), 4, "four request rows: t1..t3 store-fed + t4 NULL: {rows:?}");
    assert_eq!(rows.iter().filter(|x| x.prefix_json.is_some()).count(), 3, "three v1 prefixes");
    assert_eq!(rows.iter().filter(|x| x.prefix_json.is_none()).count(), 1, "one NULL row (t4)");

    // THE SCAN — the public entry over the real store + spool.
    let mut o = CacheBreakTimelineOptions::new(data.clone());
    o.bodies_dir = Some(spool.clone());
    o.store_dir = Some(store.clone());
    o.session_id = Some("sess-s".to_owned());
    o.min_tokens = Some(1000.0);
    let report = agentlens_core::cache_break_timeline::build_cache_break_timeline(&o);

    // No double-count: 4 turns (t1..t4), not 5 (t1 counted twice via the spool copy) — and no
    // dropped turns (the NULL-prefix t4 must still be scanned via the body path).
    assert_eq!(report["turnsInSession"], serde_json::json!(4), "store-fed t1..t3 once each + t4 via body scan: {}", report["turnsInSession"]);
    assert_eq!(report["sessionId"], serde_json::json!("sess-s"));
    // The coverage note is honest about provenance.
    let note = report["coverage"]["note"].as_str().unwrap_or("");
    assert!(note.contains("3 turn prefix(es) came from the durable api_call store"), "note must report store-fed prefixes: {note}");
    let _ = fs::remove_dir_all(root_dir_of(&data));
}

fn root_dir_of(data: &Path) -> PathBuf {
    data.parent().unwrap().to_path_buf()
}

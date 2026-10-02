//! TRDD-9VX3WTGU Phase C — the resident parsed layer, the incremental summary rebuild, and the
//! DuckDB keyset-pagination primitives.
//!
//! The parity tests compare the NEW path (`summary_snapshot` → `summary_from`, which reads shared
//! `Arc<Value>` pointers) against an INDEPENDENT re-statement of the OLD path: the cards are read
//! back out of the DuckDB table (`cards()`, i.e. parsed from the stored text exactly as the old
//! `summary_from` did) and run through the same public merge/link/sort steps. Any drift between
//! the resident layer and the table — or any byte the Arc flow changes — fails here.

use std::sync::Arc;

use agentlens_core::{feed_merge, ingest_post, now_ms, CoreState};
use indexmap::IndexMap;
use serde_json::{json, Value};

fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("al-cardpage-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// A claude_code OTEL `api_request` span for `session` — becomes an OTEL card with an
/// `api_request` timeline entry, which is what the attribution capture reads.
fn otel_trace(session: &str, span_id: &str) -> String {
    // The traceId is derived from the spanId so two sessions never share a trace (one trace is one
    // session to the summarizer).
    json!({ "resourceSpans": [{ "scopeSpans": [{ "spans": [{
        "name": "claude_code.api_request",
        "traceId": format!("{span_id}{span_id}"), "spanId": span_id,
        "startTimeUnixNano": (now_ms() as i128 * 1_000_000).to_string(),
        "attributes": [
            { "key": "session.id", "value": { "stringValue": session } },
            { "key": "input_tokens", "value": { "intValue": "100" } }
        ]
    }] }] }] })
    .to_string()
}

fn log_card(id: &str, source: &str, start: &str, parent: Option<&str>, timeline: usize) -> Value {
    let mut c = json!({
        "sessionId": id, "source": source, "dataSource": "log", "startTime": start, "durationMs": 1000.0,
        "inputTokens": 10, "outputTokens": 5, "cacheReadTokens": 0, "cacheCreateTokens": 0,
        "timeline": (0..timeline).map(|i| json!({ "type": "api_request", "spanId": format!("{id}-{i}"), "timestamp": format!("2026-08-01T10:00:0{i}.000Z") })).collect::<Vec<_>>(),
    });
    if let Some(p) = parent {
        c["parentSessionId"] = json!(p);
    }
    c
}

/// The OLD path, restated: cards parsed out of the TABLE, same public steps `summary_over` ran.
fn reference(st: &CoreState) -> (Value, Value) {
    let accounts = st.accounts.snapshot();
    let mut summary = agentlens_core::summarize::summarizer::summarize_spans(&st.window.spans, &|sid| accounts.get(sid).cloned());
    let mut attribution = IndexMap::<String, Vec<Value>>::new();
    for s in summary["sessions"].as_array().unwrap() {
        if s["source"] != "claude_code" {
            continue;
        }
        let e: Vec<Value> = s["timeline"].as_array().unwrap().iter().filter(|e| e["type"] == "api_request").cloned().collect();
        if !e.is_empty() {
            attribution.insert(s["sessionId"].as_str().unwrap().to_owned(), e);
        }
    }
    let log = st.cards.cards();
    if !log.is_empty() {
        let otel = summary["sessions"].as_array().cloned().unwrap_or_default();
        let mut merged = feed_merge::link_subagent_transcripts(feed_merge::merge_otel_and_log_sessions(otel, log));
        merged.sort_by(|a, b| {
            let k = |c: &Value| {
                let st = c.get("startTime").and_then(Value::as_str).unwrap_or("");
                if st.is_empty() { -62_167_219_200_000.0 } else { agentlens_core::summarize::helpers::parse_iso_ms(st).unwrap_or(f64::NAN) }
            };
            k(b).partial_cmp(&k(a)).unwrap_or(std::cmp::Ordering::Equal)
        });
        summary["sessions"] = Value::Array(merged);
    }
    (summary, serde_json::to_value(attribution).unwrap())
}

fn rebuilt(st: &mut CoreState) -> (Value, Value) {
    // The real flow: snapshot (takes the caches previous outputs), build, store.
    let mut inputs = st.summary_snapshot();
    let build = CoreState::summary_from(&mut inputs, now_ms() as f64);
    let attribution = build.attribution.clone();
    let summary = (*st.store_summary(inputs.version, build)).clone();
    (summary, serde_json::to_value(attribution).unwrap())
}

/// A corpus that exercises every branch of the merge: a collision (log wins), an OTEL-only card,
/// a subagent placeholder + its `agent-` transcript twin (the link), a child, and non-Claude cards.
fn seed(st: &mut CoreState) {
    ingest_post(st, "/v1/traces", otel_trace("dup", "aaaaaaaaaaaaaaa1").as_bytes());
    ingest_post(st, "/v1/traces", otel_trace("otel-only", "aaaaaaaaaaaaaaa2").as_bytes());
    st.put_log_session(log_card("dup", "claude_code", "2026-08-01T10:00:00.000Z", None, 3));
    st.put_log_session(log_card("child", "claude_code", "2026-08-01T10:05:00.000Z", Some("dup"), 1));
    st.put_log_session(log_card("X", "claude_code", "2026-08-01T10:06:00.000Z", Some("dup"), 0));
    st.put_log_session(log_card("agent-X", "claude_code", "2026-08-01T10:06:00.000Z", None, 2));
    st.put_log_session(log_card("cx", "codex", "2026-08-01T09:00:00.000Z", None, 1));
    st.put_log_session(log_card("oc", "opencode", "2026-08-01T08:00:00.000Z", None, 0));
}

#[test]
fn summary_and_attribution_are_byte_identical_to_the_table_derived_reference() {
    let mut st = CoreState::open(&tmp("parity"));
    seed(&mut st);
    let (want_s, want_a) = reference(&st);
    let (got_s, got_a) = rebuilt(&mut st);
    assert_eq!(serde_json::to_string(&got_s).unwrap(), serde_json::to_string(&want_s).unwrap(), "summary bytes");
    assert_eq!(serde_json::to_string(&got_a).unwrap(), serde_json::to_string(&want_a).unwrap(), "otel_attribution bytes");
    // The corpus is not vacuous: the collision displaced the OTEL twin (its entries were MOVED
    // into the attribution map), the OTEL-only card survived, and the placeholder was linked away.
    assert!(want_a.get("dup").is_some_and(|e| !e.as_array().unwrap().is_empty()), "attribution captured the displaced twin: {want_a}");
    let ids: Vec<&str> = got_s["sessions"].as_array().unwrap().iter().map(|s| s["sessionId"].as_str().unwrap()).collect();
    assert!(ids.contains(&"otel-only") && ids.contains(&"dup") && ids.contains(&"agent-X") && !ids.contains(&"X"), "{ids:?}");
}

#[test]
fn replacing_the_sessions_key_keeps_the_summary_key_order() {
    // With log cards the OTEL sessions are MOVED out of the summary and the merged list is put
    // back under the same key, so the key order of the summary must be unchanged.
    let mut st = CoreState::open(&tmp("keyorder"));
    ingest_post(&mut st, "/v1/traces", otel_trace("only", "bbbbbbbbbbbbbbb1").as_bytes());
    let (no_log, _) = rebuilt(&mut st);
    let keys_before: Vec<String> = no_log.as_object().unwrap().keys().cloned().collect();
    st.put_log_session(log_card("only", "claude_code", "2026-08-01T10:00:00.000Z", None, 1));
    let (with_log, _) = rebuilt(&mut st);
    let keys_after: Vec<String> = with_log.as_object().unwrap().keys().cloned().collect();
    assert_eq!(keys_before, keys_after);
}

#[test]
fn interleaved_puts_and_rebuilds_equal_a_full_rebuild_every_step() {
    let mut st = CoreState::open(&tmp("incremental"));
    seed(&mut st);
    let check = |st: &mut CoreState, step: &str| {
        let (ws, wa) = reference(st);
        let (gs, ga) = rebuilt(st);
        assert_eq!(gs, ws, "summary after {step}");
        assert_eq!(ga, wa, "attribution after {step}");
    };
    check(&mut st, "seed");
    // An UPSERT (same id, new content) keeps its slot and replaces the resident card.
    st.put_log_session(log_card("cx", "codex", "2026-08-02T09:00:00.000Z", None, 4));
    check(&mut st, "upsert");
    // A NEW card.
    st.put_log_session(log_card("fresh", "claude_code", "2026-08-03T09:00:00.000Z", None, 2));
    check(&mut st, "insert");
    // Demotion strips timelines in the table AND the resident layer.
    st.demote_cold_timelines(2);
    check(&mut st, "demote");
    // A put AFTER demotion re-arms a timeline on a demoted card.
    st.put_log_session(log_card("dup", "claude_code", "2026-08-01T10:00:00.000Z", None, 5));
    check(&mut st, "re-put after demote");
    st.cards.clear();
    check(&mut st, "clear");
}

#[test]
fn the_resident_layer_tracks_the_table_through_put_upsert_demote_and_clear() {
    let mut st = CoreState::open(&tmp("layer"));
    for i in 0..6 {
        st.put_log_session(log_card(&format!("c{i}"), "claude_code", &format!("2026-08-0{}T10:00:00.000Z", i + 1), None, 3));
    }
    st.put_log_session(log_card("c0", "claude_code", "2026-08-09T10:00:00.000Z", None, 1)); // upsert keeps slot
    let same = |st: &CoreState| {
        let layer: Vec<Value> = st.cards.parsed_cards().iter().map(|a| (**a).clone()).collect();
        assert_eq!(layer, st.cards.cards(), "the Arc layer equals the table, in the same order");
    };
    same(&st);
    assert_eq!(st.cards.parsed_cards()[0]["sessionId"], "c0", "an upsert keeps its first-insert slot");

    // Demotion invalidation: a snapshot taken BEFORE the demotion keeps the timelines it saw
    // (copy-on-write), and the layer afterwards matches the stripped table.
    let before = st.cards.parsed_cards();
    st.demote_cold_timelines(2);
    same(&st);
    let demoted = st.cards.get("c1").unwrap();
    assert_eq!(demoted["timeline"], json!([]), "c1 is cold");
    assert_eq!(demoted["timelineTruncatedCount"], 3);
    assert_eq!(before[1]["timeline"].as_array().unwrap().len(), 3, "the pre-demotion pointer is untouched");
    assert_eq!(st.cards.parsed_cards()[0]["timeline"].as_array().unwrap().len(), 1, "the hot card kept its timeline");

    st.cards.clear();
    assert!(st.cards.parsed_cards().is_empty());
}

#[test]
fn parent_and_source_are_extracted_into_key_columns_and_non_claude_sources_are_roots() {
    let mut st = CoreState::open(&tmp("keys"));
    st.put_log_session(log_card("root", "claude_code", "2026-08-01T10:00:00.000Z", None, 0));
    st.put_log_session(log_card("kid1", "claude_code", "2026-08-01T10:01:00.000Z", Some("root"), 0));
    st.put_log_session(log_card("kid2", "claude_code", "2026-08-01T10:02:00.000Z", Some("root"), 0));
    // The spawn-placeholder shape with an EMPTY parent: link_subagent_transcripts treats "" as no
    // parent, so the key column must too (a root, not a child of "").
    st.put_log_session(log_card("emptyparent", "claude_code", "2026-08-01T10:03:00.000Z", Some(""), 0));
    st.put_log_session(log_card("cx", "codex", "2026-08-01T10:04:00.000Z", None, 0));
    st.put_log_session(log_card("oc", "opencode", "2026-08-01T10:05:00.000Z", None, 0));
    st.put_log_session(log_card("cp", "copilot", "2026-08-01T10:06:00.000Z", None, 0));
    st.put_log_session(json!({ "sessionId": "nosource", "startTime": "2026-08-01T10:07:00.000Z" }));

    let ids = |v: Vec<Value>| -> Vec<String> { v.iter().map(|c| c["sessionId"].as_str().unwrap().to_owned()).collect() };
    assert_eq!(ids(st.cards.children("root")), ["kid1", "kid2"], "children, first-insert order");
    assert_eq!(st.cards.child_count("root"), 2);
    assert_eq!(st.cards.child_count("cx"), 0);
    assert_eq!(ids(st.cards.by_ids(&["kid2", "cx", "missing"])), ["kid2", "cx"], "unknown ids are absent");
    assert!(st.cards.by_ids(&[]).is_empty());

    let stats = st.cards.stats_key();
    assert_eq!((stats["total"].as_i64(), stats["roots"].as_i64(), stats["subagents"].as_i64()), (Some(8), Some(6), Some(2)));
    assert_eq!(stats["bySource"], json!({ "claude_code": 4, "codex": 1, "copilot": 1, "opencode": 1, "unknown": 1 }));

    // An upsert that CHANGES the parent moves the card between the child and root views.
    st.put_log_session(log_card("kid2", "claude_code", "2026-08-01T10:02:00.000Z", None, 0));
    assert_eq!(ids(st.cards.children("root")), ["kid1"]);
    assert_eq!(st.cards.stats_key()["roots"], 7);
}

fn walk(st: &CoreState, limit: usize) -> Vec<String> {
    let mut seen = Vec::new();
    let mut cursor = None;
    loop {
        let page = st.cards.page(cursor, limit);
        seen.extend(page.sessions.iter().map(|c| c["sessionId"].as_str().unwrap().to_owned()));
        if !page.has_more {
            assert!(page.next_cursor.is_none(), "a last page carries no cursor");
            return seen;
        }
        cursor = page.next_cursor;
        assert!(cursor.is_some(), "has_more implies a cursor");
    }
}

#[test]
fn keyset_pages_walk_the_roots_newest_first_with_ties_in_insert_order() {
    let mut st = CoreState::open(&tmp("walk"));
    // Ten roots with strictly increasing activity, plus a tie group, plus a child (excluded).
    for i in 0..10 {
        st.put_log_session(log_card(&format!("r{i}"), "claude_code", &format!("2026-08-01T10:{i:02}:00.000Z"), None, 0));
    }
    st.put_log_session(log_card("tieA", "claude_code", "2026-08-01T10:09:00.000Z", None, 0));
    st.put_log_session(log_card("tieB", "claude_code", "2026-08-01T10:09:00.000Z", None, 0));
    st.put_log_session(log_card("kid", "claude_code", "2026-08-01T12:00:00.000Z", Some("r0"), 0));

    let first = st.cards.page(None, 4);
    assert_eq!((first.total, first.has_more, first.sessions.len()), (12, true, 4));
    let all = walk(&st, 4);
    // r9 / tieA / tieB share one last_active_ms: insertion order breaks the tie.
    assert_eq!(all, ["r9", "tieA", "tieB", "r8", "r7", "r6", "r5", "r4", "r3", "r2", "r1", "r0"], "children absent");
    assert_eq!(walk(&st, 100), all, "one big page equals the paged walk");
    assert_eq!(st.cards.page(None, 0).sessions.len(), 0);
}

/// POINT-IN-TIME semantics, asserted: a walk interleaved with INSERTS and UPSERTS never returns the
/// same sessionId twice (activity only moves forward, so a touched card jumps ahead of the cursor),
/// and the cards it does not return are exactly the ones touched mid-walk — documented on
/// `CardPage`, not a bug.
#[test]
fn a_walk_interleaved_with_inserts_and_upserts_never_repeats_a_card() {
    let mut st = CoreState::open(&tmp("interleave"));
    for i in 0..12 {
        st.put_log_session(log_card(&format!("r{i:02}"), "claude_code", &format!("2026-08-01T10:{i:02}:00.000Z"), None, 0));
    }
    let mut step = 0;
    let mut cursor = None;
    let mut seen: Vec<String> = Vec::new();
    loop {
        let page = st.cards.page(cursor, 3);
        seen.extend(page.sessions.iter().map(|c| c["sessionId"].as_str().unwrap().to_owned()));
        if !page.has_more {
            break;
        }
        cursor = page.next_cursor;
        step += 1;
        // Mid-walk: an INSERT (brand-new, newest), an UPSERT of an ALREADY-DELIVERED card (moves
        // forward), and an UPSERT of a NOT-YET-DELIVERED card (moves forward past the cursor).
        st.put_log_session(log_card(&format!("new{step}"), "claude_code", &format!("2026-09-0{step}T10:00:00.000Z"), None, 0));
        let delivered = seen[0].clone();
        st.put_log_session(log_card(&delivered, "claude_code", &format!("2026-09-1{step}T10:00:00.000Z"), None, 0));
        st.put_log_session(log_card("r00", "claude_code", "2026-09-20T10:00:00.000Z", None, 0));
    }
    let mut dedup = seen.clone();
    dedup.sort();
    dedup.dedup();
    assert_eq!(dedup.len(), seen.len(), "no sessionId twice in one walk: {seen:?}");
    assert!(!seen.contains(&"r00".to_owned()), "r00 was touched before its page: it jumped ahead of the cursor and THIS walk misses it");
    assert!(!seen.iter().any(|s| s.starts_with("new")), "inserts newer than the cursor are not in an in-flight walk");
    // A fresh walk sees the final state, each card once.
    let fresh = walk(&st, 5);
    assert_eq!(fresh.len(), 12 + step, "12 originals + one insert per mid-walk step");
    assert_eq!(fresh[0], "r00");
}

#[test]
fn bulk_upserts_inside_one_transaction_keep_the_indexes_consistent() {
    // The boot restore replays every card inside begin()/commit(); the key columns are indexed, so
    // an upsert there must update the index rather than trip a duplicate-key error.
    let mut st = CoreState::open(&tmp("txn"));
    st.cards.begin();
    for round in 0..3 {
        for i in 0..50 {
            let parent = (i % 5 == 0 && i != 0).then_some("s0");
            st.put_log_session(log_card(&format!("s{i}"), "claude_code", &format!("2026-08-0{}T10:00:00.000Z", round + 1), parent, 0));
        }
    }
    st.cards.commit();
    assert_eq!(st.cards.len(), 50);
    assert_eq!(st.cards.page(None, 100).total, 41, "9 children of s0 (i = 5,10,…,45), 41 roots");
    assert_eq!(st.cards.child_count("s0"), 9);
}

#[test]
fn snapshots_share_the_resident_cards_instead_of_copying_them() {
    let mut st = CoreState::open(&tmp("share"));
    seed(&mut st);
    let a = st.summary_snapshot();
    let b = st.summary_snapshot();
    assert_eq!(a.log_cards.len(), st.cards.len());
    assert!(a.log_cards.iter().zip(&b.log_cards).all(|(x, y)| Arc::ptr_eq(x, y)), "two snapshots point at the SAME card trees");
}

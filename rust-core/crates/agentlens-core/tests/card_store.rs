//! TRDD-XTFDRTH2 — the session cards live in a DuckDB table, not a 32k-entry `IndexMap`.
//!
//! These tests pin the ONLY properties the rest of the server depends on, because every one of
//! them was previously supplied for free by `IndexMap` and is now the store's own job:
//!
//! * **first-insert order is the iteration order** — `summary_over` feeds the merged card list to
//!   a STABLE sort by `startTime`, so two cards with the same `startTime` come out in the order
//!   they were first inserted. Lose that and the wire shape of `/api/summary` changes for ties.
//! * **an upsert keeps the original position** — `IndexMap::insert` on an existing key does; a
//!   naive `DELETE`+`INSERT` would not, and would silently re-order the tie group.
//! * **the demotion order is `last_active DESC`, first-insert ASC on ties** — the Rust original
//!   used a STABLE sort over `values().enumerate()`, so ties fell back to insertion order.
//! * **a JSON round-trip through the table is lossless**, including object key order (serde_json's
//!   `preserve_order`) and float round-tripping (`float_roundtrip`).

use agentlens_core::card_store::CardStore;
use serde_json::{json, Value};

fn card(id: &str, start: &str, duration_ms: f64, timeline: usize) -> Value {
    json!({
        "sessionId": id,
        "source": "claude_code",
        "startTime": start,
        "durationMs": duration_ms,
        "timeline": (0..timeline).map(|i| json!({ "type": "api_request", "i": i })).collect::<Vec<_>>(),
    })
}

fn ids(cards: &[Value]) -> Vec<String> {
    cards.iter().map(|c| c["sessionId"].as_str().unwrap_or_default().to_owned()).collect()
}

/// One data dir per test (TRDD-TOIM26HP — the store is a DuckDB FILE now). Sharing a dir would
/// mean two live stores over one database path, which is exactly what `CardStore::open` deletes
/// the previous file to avoid; `tests/card_store_file.rs` covers that case deliberately, and
/// these tests should not be exercising it by accident.
fn store(name: &str) -> CardStore {
    CardStore::open(&std::env::temp_dir().join(format!("al-cardstore-{name}-{}", std::process::id())))
}

#[test]
fn put_then_get_round_trips_the_card_verbatim() {
    let mut s = store("roundtrip");
    // Key order is deliberately NOT alphabetical: serde_json's `preserve_order` keeps it, and the
    // wire shape is byte-compared against the TS server, so a round-trip that sorted keys would
    // change every response.
    let c = json!({ "zeta": 1, "sessionId": "a", "alpha": [1, 2, 3], "f": 0.18181818181818182, "n": null });
    s.put(&c);
    let back = s.get("a").expect("the card just put");
    assert_eq!(back, c, "the stored card must come back equal");
    assert_eq!(
        serde_json::to_string(&back).unwrap(),
        serde_json::to_string(&c).unwrap(),
        "and byte-identical once serialized — key order and float precision included"
    );
}

#[test]
fn iteration_is_first_insert_order_and_an_upsert_keeps_its_slot() {
    let mut s = store("order");
    s.put(&card("a", "2026-08-01T10:00:00.000Z", 0.0, 0));
    s.put(&card("b", "2026-08-01T10:00:00.000Z", 0.0, 0));
    s.put(&card("c", "2026-08-01T10:00:00.000Z", 0.0, 0));
    assert_eq!(ids(&s.cards()), ["a", "b", "c"]);

    // Re-putting `a` must NOT move it to the end — `IndexMap::insert` on an existing key keeps the
    // slot, and the tie group's order is part of the served `sessions` array.
    let mut updated = card("a", "2026-08-01T10:00:00.000Z", 0.0, 0);
    updated["marker"] = json!("second write");
    s.put(&updated);
    assert_eq!(ids(&s.cards()), ["a", "b", "c"], "an upsert keeps the original position");
    assert_eq!(s.get("a").unwrap()["marker"], "second write", "and the newest body wins");
    assert_eq!(s.len(), 3, "an upsert is not an insert");
}

#[test]
fn cards_json_matches_cards_element_for_element() {
    // `summary_snapshot` takes the RAW strings under the state lock and parses them off it; the
    // two accessors must agree or the off-lock rebuild would see a different corpus.
    let mut s = store("cardsjson");
    for id in ["a", "b", "c"] {
        s.put(&card(id, "2026-08-01T10:00:00.000Z", 0.0, 1));
    }
    let parsed: Vec<Value> = s.cards_json().iter().map(|j| serde_json::from_str(j).unwrap()).collect();
    assert_eq!(parsed, s.cards());
}

#[test]
fn contains_and_len_and_clear() {
    let mut s = store("contains");
    assert!(s.is_empty());
    assert!(!s.contains("a"));
    s.put(&card("a", "", 0.0, 0));
    assert!(s.contains("a"));
    assert_eq!(s.len(), 1);
    assert!(s.get("missing").is_none());
    s.clear();
    assert!(s.is_empty(), "clear empties the table");
    assert!(!s.contains("a"));
    // After a clear the sequence restarts, so a fresh corpus is ordered by its own inserts.
    s.put(&card("z", "", 0.0, 0));
    s.put(&card("y", "", 0.0, 0));
    assert_eq!(ids(&s.cards()), ["z", "y"]);
}

#[test]
fn demote_cold_strips_all_but_the_hottest_and_accumulates_the_counter() {
    // Mirrors tests/log_reader_parity.rs::demote_cold_timelines_keeps_only_the_hottest_cards —
    // same fixture, asserted directly on the store so the ordering rule has its own guard.
    let mut s = store("demote");
    s.put(&card("old", "2026-08-01T10:00:00.000Z", 1000.0, 3));
    s.put(&card("newest", "2026-08-01T10:00:00.000Z", 7_200_000.0, 2)); // start+duration wins
    s.put(&card("mid", "2026-08-01T11:00:00.000Z", 0.0, 4));
    s.put(&card("nostart", "", 5.0, 1)); // unparseable start → 0 → coldest

    s.demote_cold(4);
    assert_eq!(s.get("old").unwrap()["timeline"].as_array().unwrap().len(), 3, "under the cap nothing moves");

    s.demote_cold(2);
    let tl = |id: &str| s.get(id).unwrap()["timeline"].as_array().unwrap().len();
    assert_eq!((tl("newest"), tl("mid"), tl("old"), tl("nostart")), (2, 4, 0, 0));
    assert_eq!(s.get("old").unwrap()["timelineTruncatedCount"], 3);
    assert_eq!(s.get("old").unwrap()["timelineRetainedBytes"], 0);
    assert!(s.get("newest").unwrap().get("timelineTruncatedCount").is_none());

    // Idempotent: a second pass over already-stripped cards must not double the counter.
    s.demote_cold(2);
    assert_eq!(s.get("old").unwrap()["timelineTruncatedCount"], 3);
}

#[test]
fn demote_cold_breaks_ties_on_first_insert_order() {
    // Four cards with the SAME last-active instant. The Rust original sorted stably over
    // `values().enumerate()`, so a tie kept insertion order and the LAST-inserted cards were the
    // ones demoted. `ORDER BY last_active_ms DESC` alone would leave the tie group unordered.
    let mut s = store("ties");
    for id in ["first", "second", "third", "fourth"] {
        s.put(&card(id, "2026-08-01T10:00:00.000Z", 0.0, 2));
    }
    s.demote_cold(2);
    let tl = |id: &str| s.get(id).unwrap()["timeline"].as_array().unwrap().len();
    assert_eq!((tl("first"), tl("second")), (2, 2), "the two earliest-inserted keep their timelines");
    assert_eq!((tl("third"), tl("fourth")), (0, 0), "the two latest-inserted are demoted");
}

#[test]
fn persist_records_are_stripped_and_in_first_insert_order() {
    let mut s = store("persist");
    let mut a = card("a", "2026-08-01T10:00:00.000Z", 0.0, 2);
    a["fileOps"] = json!([{ "path": "x" }]);
    a["generatedFiles"] = json!(["y"]);
    a["backgroundSpans"] = json!([{ "id": "s" }]);
    s.put(&a);
    s.put(&card("b", "2026-08-01T10:00:00.000Z", 0.0, 1));

    let recs = s.persist_records();
    assert_eq!(recs.keys().cloned().collect::<Vec<_>>(), ["a", "b"]);
    let ra = &recs["a"];
    assert_eq!(ra["timeline"], json!([]));
    assert_eq!(ra["backgroundSpans"], json!([]));
    assert!(ra.get("fileOps").is_none());
    assert!(ra.get("generatedFiles").is_none());
    assert_eq!(ra["sessionId"], "a", "headers survive");
    // The STORED card is untouched — persist strips a copy, it is not a mutation.
    assert_eq!(s.get("a").unwrap()["timeline"].as_array().unwrap().len(), 2);
}

#[test]
fn a_card_without_a_session_id_is_keyed_by_the_empty_string() {
    // `put_log_session` has always done `unwrap_or("")`. Two such cards therefore COLLIDE — that
    // is the pre-existing contract (an IndexMap keyed on "" holds one), and the table must not
    // quietly grow a second row for them.
    let mut s = store("nosessionid");
    s.put(&json!({ "source": "codex" }));
    s.put(&json!({ "source": "claude_code" }));
    assert_eq!(s.len(), 1);
    assert_eq!(s.get("").unwrap()["source"], "claude_code");
}

/// The store's contract as `CoreState` drives it — the three write paths that used to mutate the
/// `IndexMap` in place, now going through the table: `put_log_session` (upsert + data_version
/// bump), `demote_cold_timelines`, and `clear_all`.
///
/// This test was written during the migration as a dual-write agreement check (the table had to
/// hold exactly what the map held, in the same order — that is what licensed moving readers one
/// file per phase). The map is gone, so it now asserts the same invariants against the one
/// remaining container.
#[test]
fn core_state_write_paths_keep_the_table_ordered_and_current() {
    let dir = std::env::temp_dir().join(format!("al-cardstore-dual-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut st = agentlens_core::CoreState::open(&dir);

    let v0 = st.data_version;
    for id in ["a", "b", "c", "d", "e"] {
        st.put_log_session(card(id, "2026-08-01T10:00:00.000Z", 0.0, 2));
    }
    assert_eq!(ids(&st.cards.cards()), ["a", "b", "c", "d", "e"]);
    assert!(st.data_version > v0, "put_log_session bumps data_version");

    // An upsert replaces the body and keeps the slot.
    st.put_log_session(card("a", "2026-08-01T12:00:00.000Z", 0.0, 1));
    assert_eq!(ids(&st.cards.cards()), ["a", "b", "c", "d", "e"], "an upsert does not re-order");
    assert_eq!(st.cards.len(), 5);
    assert_eq!(st.cards.get("a").unwrap()["startTime"], "2026-08-01T12:00:00.000Z");

    // `a` is now the most recently active, so it and one other keep their timelines.
    st.demote_cold_timelines(2);
    let hot = st.cards.cards().iter().filter(|c| !c["timeline"].as_array().unwrap().is_empty()).count();
    assert_eq!(hot, 2, "exactly hot_cards keep a timeline");
    assert_eq!(st.cards.get("a").unwrap()["timeline"].as_array().unwrap().len(), 1, "the hottest is one of them");

    st.clear_all();
    assert!(st.cards.is_empty(), "clear_all empties the table");

    let _ = std::fs::remove_dir_all(&dir);
}

/// The reason `seq` exists, asserted through the SERVED shape rather than the store's own API.
///
/// `summary_over` sorts the merged card list by `startTime` with a STABLE `sort_by`, so a group of
/// cards sharing one `startTime` comes out in the order the corpus yielded them — first-insert
/// order. Nothing else in the suite covers that: every other fixture has distinct start times, so
/// an unordered scan would pass them all and change `/api/summary` for the tie group only.
#[test]
fn cards_sharing_a_start_time_are_served_in_first_insert_order() {
    let dir = std::env::temp_dir().join(format!("al-cardstore-tie-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut st = agentlens_core::CoreState::open(&dir);

    for id in ["tie-1", "tie-2", "tie-3", "tie-4"] {
        st.put_log_session(card(id, "2026-08-01T10:00:00.000Z", 0.0, 0));
    }
    // An upsert in the middle must not promote its card to the end of the tie group.
    st.put_log_session(card("tie-2", "2026-08-01T10:00:00.000Z", 0.0, 1));

    let summary = st.session_summary(agentlens_core::now_ms() as f64);
    let served: Vec<String> = summary["sessions"]
        .as_array()
        .expect("sessions array")
        .iter()
        .map(|c| c["sessionId"].as_str().unwrap_or_default().to_owned())
        .collect();
    assert_eq!(served, ["tie-1", "tie-2", "tie-3", "tie-4"]);

    let _ = std::fs::remove_dir_all(&dir);
}

/// TRDD-5JZQFVO8 — a restore-sized bulk load must stay inside the store's 256 MiB pool when it is
/// committed in bounded chunks. On 2026-09-08 the real corpus (35,258 cards / 64 MB of card text)
/// was loaded inside ONE transaction and `put` panicked at card_store.rs:168 (`upsert a session
/// card`) with DuckDB's Out of Memory Error at every boot. N is ~1.7× that corpus so the mutation
/// check is not a coin flip (80k ran 493 s on a loaded machine; 60k ran 510 s under heavier load —
/// this is a 🐌 slow test, single-row upserts into a file-backed store).
/// MUTATION CHECK: wrap the whole loop in a single `begin()` … `commit()` and this test panics at
/// `upsert a session card` — that is the pre-fix shape.
#[test]
fn a_restore_sized_bulk_load_stays_inside_the_memory_limit() {
    const N: usize = 60_000;
    const CHUNK: usize = 500;
    let mut store = store("bulk-restore");
    let filler = "x".repeat(1_700); // ~ the real corpus's average card
    let whale = "x".repeat(310_000); // > DuckDB's 256 KiB block: forces overflow blocks
    store.begin();
    for i in 0..N {
        let body = if i % 5_000 == 0 { &whale } else { &filler };
        store.put(&json!({
            "sessionId": format!("s{i:06}"),
            "source": "claude_code",
            "startTime": "2026-09-08T00:00:00.000Z",
            "durationMs": 1.0,
            "timeline": [],
            "filler": body,
        }));
        if (i + 1) % CHUNK == 0 {
            store.commit();
            store.begin();
        }
    }
    store.commit();
    assert_eq!(store.len(), N);
}

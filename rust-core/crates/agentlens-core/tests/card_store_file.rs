//! TRDD-TOIM26HP — the card store is a DuckDB FILE under the data dir, and that file is a SPILL
//! file, not a durable store.
//!
//! `tests/card_store.rs` pins WHAT the store holds; this file pins WHERE it holds it and what a
//! second boot over the same data dir sees. Both properties have callers that cannot be changed
//! from inside `card_store.rs`:
//!
//! * **the file exists under the data dir** — that is the whole point of the card: the corpus is
//!   on disk and DuckDB's buffer pool decides what is resident.
//! * **a database left by a previous boot is REPLACED, never reused.** `DurableState::restore`
//!   treats a stale `LOG_INGEST_VERSION` as "restore nothing, cold-rescan" and does not clear the
//!   store, because until now a fresh `CoreState` always had an empty one. A store that survived
//!   the process would keep serving cards built under the OLD ingest semantics, with the version
//!   stamp — the only mechanism that exists to invalidate them — silently doing nothing.
//! * **two stores over ONE data dir in ONE process do not interfere.** That is not hypothetical:
//!   `tests/log_reader_parity.rs::durable_state_round_trips_offsets_and_stripped_cards_and_skips_the_cold_rescan`
//!   opens four `CoreState`s over one data dir with the earlier ones still alive.

use agentlens_core::card_store::{CardStore, CARD_DB_FILE};
use serde_json::json;

fn data_dir(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("al-cardfile-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create the test data dir");
    dir
}

#[test]
fn open_puts_the_database_on_disk_under_the_data_dir() {
    let dir = data_dir("ondisk");
    let mut s = CardStore::open(&dir);
    let path = dir.join(CARD_DB_FILE);
    assert!(path.exists(), "the database file must be created at {}", path.display());
    s.put(&json!({ "sessionId": "a", "timeline": [] }));
    // A file with a header only would also "exist"; the corpus has to be IN it, so the file grows
    // once a card is committed. `put` is autocommit, so no explicit commit is needed here.
    assert!(std::fs::metadata(&path).expect("stat the database").len() > 0);
    assert_eq!(s.len(), 1);
}

#[test]
fn a_database_left_by_a_previous_boot_is_replaced_not_reused() {
    let dir = data_dir("reboot");
    {
        let mut first = CardStore::open(&dir);
        for id in ["a", "b", "c"] {
            first.put(&json!({ "sessionId": id, "timeline": [] }));
        }
        assert_eq!(first.len(), 3);
    }
    assert!(dir.join(CARD_DB_FILE).exists(), "the previous boot left a database behind");

    let mut second = CardStore::open(&dir);
    assert!(second.is_empty(), "a boot starts from an empty corpus and replays the delta log into it");
    assert!(!second.contains("a"), "and none of the previous boot's cards are still addressable");
    // The replay then refills it — the ordinals restart with the corpus, so first-insert order is
    // the order THIS boot inserted in, not a continuation of a dead boot's numbering.
    for id in ["x", "y"] {
        second.put(&json!({ "sessionId": id, "timeline": [] }));
    }
    let ids: Vec<String> =
        second.cards().iter().map(|c| c["sessionId"].as_str().unwrap_or_default().to_owned()).collect();
    assert_eq!(ids, ["x", "y"]);
}

#[test]
fn two_stores_over_one_data_dir_in_one_process_do_not_interfere() {
    let dir = data_dir("two");
    let mut first = CardStore::open(&dir);
    first.put(&json!({ "sessionId": "a", "timeline": [] }));

    // Opened while `first` is still alive — the shape `log_reader_parity.rs` drives, where a test
    // boots a second `CoreState` over the same dir to simulate a restart.
    let mut second = CardStore::open(&dir);
    assert!(second.is_empty(), "the second store starts empty");
    second.put(&json!({ "sessionId": "b", "timeline": [] }));

    // Neither one saw the other's write, and both still work.
    assert_eq!(second.len(), 1);
    assert!(second.contains("b") && !second.contains("a"));
    assert_eq!(first.len(), 1, "the first store is unaffected by the second one's open");
    assert!(first.contains("a") && !first.contains("b"));
    first.put(&json!({ "sessionId": "c", "timeline": [] }));
    assert_eq!(first.len(), 2, "and it can still write after the second store took over the path");
}

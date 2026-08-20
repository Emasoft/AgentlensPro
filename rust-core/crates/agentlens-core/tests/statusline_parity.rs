//! Cross-engine parity + round-trip for the statusline store (TRDD-DMWOBWFH row 5).
//!
//! The committed statusline-tree fixture was WRITTEN AND SEALED by the compiled TS
//! statuslineStore.js (gen-statusline-expected.mjs) — reading it here proves the cross-engine
//! law both directions matter for: a TS-sealed parquet part + a live TS WAL answer the same
//! rows through the Rust query path, per-file VARCHAR session_id repair included (the WAL
//! carries only UUID-shaped ids, the part a non-UUID one — the union crashes without the
//! repair). The round-trip half proves the Rust WRITE path: append → flush → seal →
//! query, the inference-collapse refusal, and the retention purge's malformed-name gate.
//! After any TS change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-statusline-expected.mjs

use std::collections::HashMap;

use agentlens_core::statusline_store::{day_key, flatten_sample, maybe_seal, purge, query_statusline, StatuslineStore};
use serde_json::{json, Map, Value};

fn fixtures() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn oracle() -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join("statusline-expected.json")).unwrap()).unwrap()
}

#[test]
fn pure_halves_match_the_ts_oracle() {
    let o = oracle();
    for (c, exp) in o["flattenCases"].as_array().unwrap().iter().zip(o["pure"]["flatten"].as_array().unwrap()) {
        let got = Value::Object(flatten_sample(c["v"].as_object().unwrap(), ""));
        assert_eq!(&got, exp, "{}", c["name"]);
    }
    let now = o["now"].as_f64().unwrap();
    assert_eq!(Value::from(day_key(now)), o["pure"]["dayKey"][0]);
    assert_eq!(Value::from(day_key(0.0)), o["pure"]["dayKey"][1]);
}

#[test]
fn ts_written_store_answers_the_same_rows_through_the_rust_reader() {
    let o = oracle();
    let root = fixtures().join("statusline-tree");
    let vars: HashMap<String, String> = HashMap::new();
    let now = o["now"].as_f64().unwrap();

    let rows = |v: Option<Vec<Map<String, Value>>>| -> Value {
        v.map(|r| Value::Array(r.into_iter().map(Value::Object).collect())).unwrap_or(Value::Null)
    };
    let main = query_statusline(&root, "main", o["mainSql"].as_str().unwrap(), None, None, &vars).unwrap();
    assert_eq!(rows(main), o["queries"]["main"], "main stream (part + WAL union, UUID repair)");
    let sub = query_statusline(&root, "subagent", o["subSql"].as_str().unwrap(), None, None, &vars).unwrap();
    assert_eq!(rows(sub), o["queries"]["subagent"], "subagent stream (tasks stays a LIST)");
    let win = query_statusline(&root, "main", "SELECT count(*) AS c FROM samples", Some(now - 55_000.0), None, &vars).unwrap();
    assert_eq!(rows(win), o["queries"]["windowed"]);
    // BLIND — no data must answer None, never an empty success.
    let blind = query_statusline(&fixtures().join("no-such-tree"), "main", "SELECT 1", None, None, &vars).unwrap();
    assert!(blind.is_none());
}

#[test]
fn rust_write_path_round_trips_and_the_seal_refuses_collapsed_inference() {
    let root = std::env::temp_dir().join(format!("al-statusline-rt-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let mut store = StatuslineStore::new(root.clone());
    let vars: HashMap<String, String> = HashMap::from([("AGENTLENS_STATUSLINE_SEAL_ROWS".to_owned(), "10".to_owned())]);
    let now = agentlens_core::now_ms() as f64;
    // 40 samples across two sessions (one id deliberately non-UUID) → flush → seal at 10 rows.
    for i in 0..40 {
        let sid = if i % 2 == 0 { "cccccccc-cccc-cccc-cccc-cccccccccccc" } else { "plain-session-name" };
        let payload = json!({ "session_id": sid, "model": { "id": "claude-opus-5" }, "i": i });
        store.append(payload.as_object().unwrap(), "main", now - 1000.0 + i as f64);
    }
    store.flush(None);
    let sealed = maybe_seal(&root, &store.counters, &vars, now);
    assert!(sealed >= 1, "the full WAL seals (rotation path)");
    // Two more samples land in a fresh live WAL — the union must see sealed + live.
    store.append(json!({ "session_id": "plain-session-name", "i": 100 }).as_object().unwrap(), "main", now);
    store.flush(None);
    let rows = query_statusline(&root, "main", "SELECT count(*) AS c, count(DISTINCT session_id) AS s FROM samples", None, None, &vars)
        .unwrap()
        .expect("data present");
    assert_eq!(Value::Object(rows[0].clone()), json!({ "c": 41, "s": 2 }));

    // Inference collapse: a past-day WAL holding a bare scalar line reads as ONE `json` column;
    // sealing it would write all-NULL rows and destroy the raw JSON — it must be REFUSED,
    // counted, and kept on disk.
    let past = root.join("main/2020-01-02");
    std::fs::create_dir_all(&past).unwrap();
    let bad_wal = past.join("wal-1.ndjson");
    std::fs::write(&bad_wal, "42\n").unwrap();
    let before = store.counters.corrupt_wals.load(std::sync::atomic::Ordering::Relaxed);
    maybe_seal(&root, &store.counters, &vars, now);
    assert!(bad_wal.exists(), "the raw JSON is the only readable copy — kept");
    assert_eq!(store.counters.corrupt_wals.load(std::sync::atomic::Ordering::Relaxed), before + 1);

    // Retention: the ancient partition goes whole; a malformed directory name is IGNORED,
    // never deleted (deleting an unrecognised dir is how a store eats something not its own).
    let foreign = root.join("main/not-a-day");
    std::fs::create_dir_all(&foreign).unwrap();
    std::fs::write(foreign.join("keep.txt"), "x").unwrap();
    let (removed, freed) = purge(&root, 90.0, now);
    assert_eq!(removed, vec!["main/2020-01-02".to_owned()]);
    assert!(freed > 0);
    assert!(foreign.join("keep.txt").exists());
    let _ = std::fs::remove_dir_all(&root);
}

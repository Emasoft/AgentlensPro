//! forensicsIndex SLICE B1 parity + the behaviours that have no TS oracle (TRDD-DMWOBWFH).
//!
//! Two halves, deliberately separated:
//!   - `*_reproduces_the_ts_oracle_exactly` — billableWeight / tierClassify against
//!     forensicsdb-expected.json, generated from the compiled TS.
//!   - the rest — real-SQLite behaviour the TS CANNOT oracle, because the TS runs sql.js in memory
//!     where `PRAGMA journal_mode = WAL` is inert. These are the reason B1 does not port
//!     `openReadonlyForensicsSnapshot` literally.

use std::path::PathBuf;

use agentlens_core::forensics_db::{
    billable_weight, default_forensics_db, default_main_db, open_forensics_db,
    open_readonly_snapshot, read_index_state, tier_classify, write_index_state,
};
use serde_json::Value;

/// A fixed clock. The models in the fixture are all free of `scheduledChange`, so the value is not
/// load-bearing — passing one anyway keeps the test independent of the day it runs.
const NOW_MS: f64 = 1_760_000_000_000.0;

fn fixture() -> Value {
    let p = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/forensicsdb-expected.json");
    serde_json::from_str(&std::fs::read_to_string(&p).expect("fixture missing — run gen-forensicsdb-expected.mjs")).unwrap()
}

/// Decode the generator's tagged encoding. JSON cannot carry NaN or ±Infinity, and writing them as
/// null would make them indistinguishable from a real null, so they travel as strings.
fn num_arg(v: &Value) -> f64 {
    match v {
        Value::Number(n) => n.as_f64().unwrap(),
        Value::String(s) => match s.as_str() {
            "NaN" => f64::NAN,
            "Infinity" => f64::INFINITY,
            "-Infinity" => f64::NEG_INFINITY,
            other => panic!("unexpected tagged number {other}"),
        },
        other => panic!("unexpected bucket value {other}"),
    }
}

fn opt_num_arg(v: &Value) -> Option<f64> {
    match v {
        Value::Null => None,
        Value::String(s) if s == "undefined" => None,
        other => Some(num_arg(other)),
    }
}

#[test]
fn billable_weight_reproduces_the_ts_oracle_exactly() {
    let fx = fixture();
    let cases = fx["billableWeight"].as_array().unwrap();
    assert!(!cases.is_empty());
    for c in cases {
        let label = c["case"].as_str().unwrap();
        let model = c["model"].as_str();
        let got = billable_weight(
            num_arg(&c["cc5m"]),
            num_arg(&c["cc1h"]),
            num_arg(&c["cread"]),
            num_arg(&c["out"]),
            num_arg(&c["input"]),
            model,
            NOW_MS,
        );
        let want = c["value"].as_f64().unwrap();
        // Bit-exact, not approximate: the oracle carries 6.250000000000001, and a port that
        // reassociated the multiplication would land on 6.25 and be "close enough" while being a
        // different computation.
        assert_eq!(got.to_bits(), want.to_bits(), "{label}: got {got}, want {want}");
    }
}

#[test]
fn tier_classify_reproduces_the_ts_oracle_exactly() {
    let fx = fixture();
    let cases = fx["tierClassify"].as_array().unwrap();
    assert!(!cases.is_empty());
    for c in cases {
        let got = tier_classify(opt_num_arg(&c["input"]));
        assert_eq!(got, c["out"].as_str().unwrap(), "input {:?}", c["input"]);
    }
}

// ── real-SQLite behaviour (no TS oracle — see the module header) ────────────────

fn tmp_dir(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("al-fdb-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn default_paths_are_resolved_from_the_data_dir_not_frozen() {
    let a = default_forensics_db(&PathBuf::from("/fixture/one"));
    let b = default_forensics_db(&PathBuf::from("/fixture/two"));
    assert_ne!(a, b);
    assert!(a.ends_with("forensics.db"));
    assert!(default_main_db(&PathBuf::from("/fixture/one")).ends_with("agentlens.db"));
}

#[test]
fn schema_applies_and_index_state_round_trips() {
    let dir = tmp_dir("schema");
    let db = default_forensics_db(&dir);
    let conn = open_forensics_db(&db, NOW_MS).unwrap();

    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .unwrap()
        .query_map([], |r| r.get(0))
        .unwrap()
        .map(Result::unwrap)
        .collect();
    assert_eq!(tables, vec!["api_calls", "call_content", "call_injections", "index_state"]);

    assert_eq!(read_index_state(&conn, "missing"), None);
    write_index_state(&conn, "last_run_ms", "1234").unwrap();
    assert_eq!(read_index_state(&conn, "last_run_ms").as_deref(), Some("1234"));
    // INSERT OR REPLACE, not INSERT — a second write of the same key must overwrite, since the
    // indexer rewrites every key on every run.
    write_index_state(&conn, "last_run_ms", "5678").unwrap();
    assert_eq!(read_index_state(&conn, "last_run_ms").as_deref(), Some("5678"));

    // Re-opening applies the schema again; CREATE TABLE IF NOT EXISTS must not wipe the row.
    drop(conn);
    let conn2 = open_forensics_db(&db, NOW_MS).unwrap();
    assert_eq!(read_index_state(&conn2, "last_run_ms").as_deref(), Some("5678"));
}

/// THE FALSIFICATION FOR THE ONE DELIBERATE DEVIATION FROM THE TS.
///
/// `openReadonlyForensicsSnapshot` reads the DB's file bytes and opens a copy. Under sql.js that is
/// exact. Under real SQLite the schema's `PRAGMA journal_mode = WAL` takes effect, so a just-
/// committed row can still live in the `-wal` sidecar and a byte-copy of `forensics.db` alone would
/// not contain it — answering a diagnostics query from a database missing its newest facts, with no
/// error anywhere. This test writes a row, then asserts the read-only handle sees it.
///
/// To confirm it actually bites: replacing `open_readonly_snapshot` with a byte-copy
/// (`Connection::open_in_memory` + deserialize of `fs::read(db)`) fails this test, and the WAL file
/// asserted below is why.
#[test]
fn the_readonly_snapshot_sees_rows_that_a_byte_copy_would_miss() {
    let dir = tmp_dir("wal");
    let db = default_forensics_db(&dir);
    let conn = open_forensics_db(&db, NOW_MS).unwrap();
    conn.execute(
        "INSERT INTO api_calls (call_id, response_ref, ts, spawn_resolution, indexed_at) VALUES ('c1', 'r1', 1, 'unresolved', 1)",
        [],
    )
    .unwrap();

    // The schema really did switch this file to WAL — otherwise the trap this guards is imaginary
    // and the deviation would be unjustified.
    let mode: String = conn.query_row("PRAGMA journal_mode", [], |r| r.get(0)).unwrap();
    assert_eq!(mode, "wal");
    assert!(db.with_extension("db-wal").exists() || dir.join("forensics.db-wal").exists());

    let snap = open_readonly_snapshot(&db, NOW_MS).expect("snapshot should open");
    let n: i64 = snap.query_row("SELECT COUNT(*) FROM api_calls", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 1, "the snapshot missed a committed row");
}

#[test]
fn the_readonly_snapshot_refuses_writes_and_is_absent_before_first_index() {
    let dir = tmp_dir("ro");
    let db = default_forensics_db(&dir);
    // Absent DB → None, the TS's "no facts indexed yet" state, not an error.
    assert!(open_readonly_snapshot(&db, NOW_MS).is_none());

    let conn = open_forensics_db(&db, NOW_MS).unwrap();
    drop(conn);
    let snap = open_readonly_snapshot(&db, NOW_MS).unwrap();
    // run_diagnostics_sql hands RAW caller SQL to this handle; a write must be refused by the
    // engine, which is the guarantee the TS bought by querying a throwaway copy.
    assert!(snap
        .execute("INSERT INTO index_state (k, v) VALUES ('x', 'y')", [])
        .is_err());
}

#[test]
fn the_custom_fns_are_callable_from_sql_and_coerce_like_js() {
    let dir = tmp_dir("fns");
    let conn = open_forensics_db(&default_forensics_db(&dir), NOW_MS).unwrap();

    let one_m = 1_000_000.0_f64;
    let w: f64 = conn
        .query_row("SELECT billable_weight(0, 0, ?1, 0, 0, 'gpt-4o')", [one_m], |r| r.get(0))
        .unwrap();
    assert_eq!(w, 0.25, "cache read is 0.1x the INPUT rate, not the cacheRead column");

    // NULL model → 0, never a throw and never a guessed rate.
    let w0: f64 = conn
        .query_row("SELECT billable_weight(1, 1, 1, 1, 1, NULL)", [], |r| r.get(0))
        .unwrap();
    assert_eq!(w0, 0.0);

    // A TEXT bucket is NOT a JS number, so `num()` makes it 0 — it is NOT parsed. rusqlite would
    // happily coerce '1000000' to 1000000.0, which is exactly the disagreement this pins.
    let wt: f64 = conn
        .query_row("SELECT billable_weight(0, 0, '1000000', 0, 0, 'gpt-4o')", [], |r| r.get(0))
        .unwrap();
    assert_eq!(wt, 0.0, "TEXT is not a JS number; num() yields 0");

    // tier_classify is the ONE fn that calls Number(), so there a string IS converted — and JS's
    // Number('') is 0, which lands in BREAK rather than COLD.
    for (sql, want) in [
        ("SELECT tier_classify(NULL)", "COLD"),
        ("SELECT tier_classify(-1)", "COLD"),
        ("SELECT tier_classify(4.5)", "TTL_5m"),
        ("SELECT tier_classify(65)", "MID"),
        ("SELECT tier_classify(65.0001)", "TTL_1h"),
        ("SELECT tier_classify('12')", "MID"),
        ("SELECT tier_classify('120')", "TTL_1h"),
        ("SELECT tier_classify('')", "BREAK"),
        ("SELECT tier_classify('nonsense')", "COLD"),
    ] {
        let got: String = conn.query_row(sql, [], |r| r.get(0)).unwrap();
        assert_eq!(got, want, "{sql}");
    }

    let c: f64 = conn
        .query_row("SELECT cost_usd(1000000, 0, 0, 0, 'claude-opus-5')", [], |r| r.get(0))
        .unwrap();
    assert_eq!(c, 5.0);
    let c0: f64 = conn
        .query_row("SELECT cost_usd(1000000, 0, 0, 0, NULL)", [], |r| r.get(0))
        .unwrap();
    assert_eq!(c0, 0.0);

    for (sql, want) in [
        ("SELECT spike(10, 5, 2)", 1),
        ("SELECT spike(9.99, 5, 2)", 0),
        ("SELECT spike(0, 0, 0)", 1),
    ] {
        let got: i64 = conn.query_row(sql, [], |r| r.get(0)).unwrap();
        assert_eq!(got, want, "{sql}");
    }
}

/// The manual cascade in the TS indexer exists because "sql.js does not reliably honor ON DELETE
/// CASCADE". Under rusqlite with `PRAGMA foreign_keys = ON` it genuinely fires. Pinned so a later
/// slice does not "simplify away" the manual DELETE on the belief the FK is inert here too.
#[test]
fn foreign_keys_are_enforced_so_the_cascade_really_fires() {
    let dir = tmp_dir("fk");
    let conn = open_forensics_db(&default_forensics_db(&dir), NOW_MS).unwrap();
    let on: i64 = conn.query_row("PRAGMA foreign_keys", [], |r| r.get(0)).unwrap();
    assert_eq!(on, 1);

    conn.execute("INSERT INTO api_calls (call_id, response_ref, ts, spawn_resolution, indexed_at) VALUES ('c1','r1',1,'unresolved',1)", []).unwrap();
    conn.execute("INSERT INTO call_content (call_id, tag, tokens, count) VALUES ('c1','image',10,1)", []).unwrap();
    // A child row with no parent must be refused, or the cascade guarantee is hollow.
    assert!(conn
        .execute("INSERT INTO call_content (call_id, tag) VALUES ('ghost','x')", [])
        .is_err());

    conn.execute("DELETE FROM api_calls WHERE call_id = 'c1'", []).unwrap();
    let n: i64 = conn.query_row("SELECT COUNT(*) FROM call_content", [], |r| r.get(0)).unwrap();
    assert_eq!(n, 0, "ON DELETE CASCADE did not fire");
}

//! forensicsIndex SLICE B4 parity — indexApiCalls / ensureFreshIndex (TRDD-DMWOBWFH).
//!
//! The oracle compares what LANDS IN THE TABLES, not a return value: the indexer's whole product is
//! the fact rows the last two tools query. `indexed_at` and `last_run_ms` are Date.now() in the TS
//! and are deliberately excluded — they are the only non-deterministic values written, and pinning
//! them would expire the fixture immediately.
//!
//! The main agentlens.db is BUILT HERE rather than committed: it is a binary whose only content is
//! one sessions row, and the row is what matters, not the bytes.

use std::path::PathBuf;

use agentlens_core::forensics_db::{default_forensics_db, open_forensics_db, read_index_state};
use agentlens_core::forensics_scan::{ensure_fresh_index, index_api_calls, ScanApiCallOptions};
use serde_json::{json, Value};

const NOW_MS: f64 = 1_760_000_000_000.0;

const DUMP_SQL: &str = "SELECT call_id, request_ref IS NOT NULL AS has_request_ref, ts, session_id, account_uuid, model, effort,
      spawn_kind, subagent_type, spawn_model_override, spawn_isolation, is_sidechain, parent_session, spawn_resolution,
      input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, tier_5m_tokens, tier_1h_tokens,
      break_cause, culprit_fingerprint, gap_minutes, frontmatter_fp, cost_usd, billable_weight
    FROM api_calls ORDER BY call_id";

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/forensicsindexer")
}

fn oracle() -> Value {
    let p = fixtures().with_file_name("forensicsindexer-expected.json");
    let raw = std::fs::read_to_string(&p).expect("fixture missing — run gen-forensicsindexer-expected.mjs");
    serde_json::from_str(&raw.replace("<FIX>", &fixtures().to_string_lossy())).unwrap()
}

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("al-fidx-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Stamp the spool mtimes — a spool row carries no ts_ms, so mtime IS the capture time, and git does
/// not preserve it.
fn spool(o: &Value) -> PathBuf {
    let dir = fixtures().join("spool");
    for (name, ms) in o["mtimes"].as_object().unwrap() {
        let ms = ms.as_f64().unwrap();
        let ft = filetime::FileTime::from_unix_time((ms / 1000.0) as i64, ((ms % 1000.0) * 1e6) as u32);
        filetime::set_file_mtime(dir.join(name), ft).unwrap();
    }
    dir
}

/// The one sessions row the oracle was generated against. It makes msg_aaaa resolve 'direct' with
/// EVERY spawn column populated — which is what catches a column-order slip in the 28-placeholder
/// INSERT. With an empty spawn map every spawn column would be null and a swap would be invisible.
fn main_db(dir: &std::path::Path) -> PathBuf {
    let p = dir.join("agentlens.db");
    let c = rusqlite::Connection::open(&p).unwrap();
    c.execute_batch(
        "CREATE TABLE sessions (session_id TEXT, spawn_kind TEXT, spawn_model_override TEXT,
            spawn_isolation TEXT, is_sidechain INTEGER, parent_session_id TEXT, model TEXT,
            spawn_subagent_type TEXT);
         INSERT INTO sessions VALUES ('aaaaaaaa-1111-2222-3333-444444444444','task','claude-opus-5','worktree',1,'eeeeeeee','claude-opus-5','spark');",
    )
    .unwrap();
    p
}

fn dump(conn: &rusqlite::Connection, sql: &str) -> Value {
    let mut stmt = conn.prepare(sql).unwrap();
    let cols: Vec<String> = stmt.column_names().iter().map(|s| (*s).to_owned()).collect();
    let rows = stmt
        .query_map([], |r| {
            let mut m = serde_json::Map::new();
            for (i, c) in cols.iter().enumerate() {
                m.insert(
                    c.clone(),
                    match r.get_ref(i)? {
                        rusqlite::types::ValueRef::Null => Value::Null,
                        rusqlite::types::ValueRef::Integer(v) => json!(v),
                        rusqlite::types::ValueRef::Real(v) => json!(v),
                        rusqlite::types::ValueRef::Text(b) => Value::String(String::from_utf8_lossy(b).into_owned()),
                        rusqlite::types::ValueRef::Blob(_) => Value::Null,
                    },
                );
            }
            Ok(Value::Object(m))
        })
        .unwrap()
        .map(Result::unwrap)
        .collect::<Vec<_>>();
    Value::Array(rows)
}

fn opts_for(spool_dir: &std::path::Path) -> ScanApiCallOptions {
    let mut o = ScanApiCallOptions::new(spool_dir.to_path_buf(), fixtures().join("no-such-store"));
    o.with_content = false;
    o
}

fn same(got: &Value, want: &Value, path: &str) {
    match (got, want) {
        (Value::Object(g), Value::Object(w)) => {
            let gk: Vec<&String> = g.keys().collect();
            let wk: Vec<&String> = w.keys().collect();
            assert_eq!(gk, wk, "key set/order differs at {path}");
            for k in wk {
                same(&g[k], &w[k], &format!("{path}.{k}"));
            }
        }
        (Value::Array(g), Value::Array(w)) => {
            assert_eq!(g.len(), w.len(), "array length differs at {path}");
            for (i, (a, b)) in g.iter().zip(w.iter()).enumerate() {
                same(a, b, &format!("{path}[{i}]"));
            }
        }
        // JSON numbers compare structurally: an integer 0 and a float 0.0 are different Values, and
        // sql.js writes whichever the column's affinity produced. Compare numerically when both are
        // numbers so a REAL 0.0 matches the oracle's 0, but keep everything else exact.
        (Value::Number(a), Value::Number(b)) => {
            assert_eq!(a.as_f64(), b.as_f64(), "value differs at {path}")
        }
        _ => assert_eq!(got, want, "value differs at {path}"),
    }
}

#[test]
fn index_api_calls_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let spool = spool(&o);
    let dir = tmp("parity");
    let main = main_db(&dir);
    let mut conn = open_forensics_db(&default_forensics_db(&dir), NOW_MS).unwrap();

    let res = index_api_calls(&mut conn, &opts_for(&spool), &main, true, NOW_MS).unwrap();
    assert_eq!(res.inserted as u64, o["inserted"].as_u64().unwrap());

    same(&dump(&conn, DUMP_SQL), &o["apiCalls"], "apiCalls");
    same(
        &dump(&conn, "SELECT call_id, kind, name, tokens FROM call_injections ORDER BY call_id, kind, name"),
        &o["callInjections"],
        "callInjections",
    );
    same(
        &dump(&conn, "SELECT k, v FROM index_state WHERE k <> 'last_run_ms' ORDER BY k"),
        &o["indexState"],
        "indexState",
    );
}

/// A response carrying a FLAT cache_creation total with no tier sub-object leaves both tiers 0. The
/// weight must attribute that flat total to the 5-MINUTE tier or the priciest bucket is dropped and
/// billable_weight disagrees with cost_usd, which already counts it — every "worst config" ranking
/// then undercounts exactly the cache-write-heavy configs it exists to find. The STORED
/// tier_5m_tokens column must stay 0: only the weight sees the synthesized value.
#[test]
fn a_flat_cache_creation_total_is_weighted_as_the_5m_tier_but_not_stored_as_one() {
    let o = oracle();
    let spool = spool(&o);
    let dir = tmp("flat");
    let main = main_db(&dir);
    let mut conn = open_forensics_db(&default_forensics_db(&dir), NOW_MS).unwrap();
    index_api_calls(&mut conn, &opts_for(&spool), &main, true, NOW_MS).unwrap();

    let (cc, t5m, cost, weight): (f64, f64, f64, f64) = conn
        .query_row(
            "SELECT cache_creation_tokens, tier_5m_tokens, cost_usd, billable_weight FROM api_calls WHERE call_id = 'msg_bbbb'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .unwrap();
    assert_eq!(cc, 5000.0);
    assert_eq!(t5m, 0.0, "the stored tier column must NOT absorb the synthesized value");
    assert!(weight > 0.0);
    // Equal here precisely because the flat total is counted on both sides; a port that skipped the
    // synthesis would leave weight far below cost.
    assert_eq!(weight, cost, "weight dropped the flat cache_creation total");
}

/// Idempotent on call_id via INSERT OR REPLACE, so a re-index neither duplicates rows nor leaves
/// stale children. The parent is REPLACED rather than deleted, so ON DELETE CASCADE never fires for
/// it — the manual DELETE of the child rows is what keeps them from accumulating.
#[test]
fn re_indexing_replaces_rather_than_duplicates_and_leaves_no_stale_children() {
    let o = oracle();
    let spool = spool(&o);
    let dir = tmp("idem");
    let main = main_db(&dir);
    let mut conn = open_forensics_db(&default_forensics_db(&dir), NOW_MS).unwrap();

    index_api_calls(&mut conn, &opts_for(&spool), &main, true, NOW_MS).unwrap();
    let n1: i64 = conn.query_row("SELECT COUNT(*) FROM api_calls", [], |r| r.get(0)).unwrap();
    let i1: i64 = conn.query_row("SELECT COUNT(*) FROM call_injections", [], |r| r.get(0)).unwrap();

    index_api_calls(&mut conn, &opts_for(&spool), &main, true, NOW_MS).unwrap();
    let n2: i64 = conn.query_row("SELECT COUNT(*) FROM api_calls", [], |r| r.get(0)).unwrap();
    let i2: i64 = conn.query_row("SELECT COUNT(*) FROM call_injections", [], |r| r.get(0)).unwrap();
    assert_eq!((n1, i1), (n2, i2), "a re-index duplicated rows");
}

/// The high-water mark advances MONOTONICALLY toward the present: a later, shallower run must never
/// roll back a prior deeper one.
#[test]
fn the_high_water_mark_never_moves_backwards() {
    let o = oracle();
    let spool = spool(&o);
    let dir = tmp("hw");
    let main = main_db(&dir);
    let db = default_forensics_db(&dir);
    let mut conn = open_forensics_db(&db, NOW_MS).unwrap();

    let full = index_api_calls(&mut conn, &opts_for(&spool), &main, true, NOW_MS).unwrap();
    assert!(full.high_water_ms > 0.0);

    // A run that sees nothing (a spool that does not exist) must leave the mark where it was.
    let empty_opts = opts_for(&fixtures().join("nope"));
    let shallow = index_api_calls(&mut conn, &empty_opts, &main, true, NOW_MS).unwrap();
    assert_eq!(shallow.inserted, 0);
    assert_eq!(shallow.high_water_ms, full.high_water_ms, "the mark rolled back");
    assert_eq!(
        read_index_state(&conn, "high_water_mtime_ms").unwrap(),
        // Stored as a JS number string — "1759999700000", never "1759999700000.0".
        format!("{}", full.high_water_ms as i64)
    );
}

#[test]
fn ensure_fresh_index_skips_inside_the_window_and_reindexes_outside_it() {
    let o = oracle();
    let spool = spool(&o);
    let dir = tmp("fresh");
    let main = main_db(&dir);
    let db = default_forensics_db(&dir);
    let opts = opts_for(&spool);
    let max_age = 5.0 * 60_000.0;

    // No DB yet → indexes.
    assert!(ensure_fresh_index(&db, &opts, &main, true, max_age, false, NOW_MS).unwrap().is_some());
    // Inside the window → skips.
    assert!(ensure_fresh_index(&db, &opts, &main, true, max_age, false, NOW_MS + 1000.0).unwrap().is_none());
    // Outside it → re-indexes.
    assert!(ensure_fresh_index(&db, &opts, &main, true, max_age, false, NOW_MS + max_age + 1.0).unwrap().is_some());
    // force ignores the window entirely.
    assert!(ensure_fresh_index(&db, &opts, &main, true, max_age, true, NOW_MS + 1000.0).unwrap().is_some());
}

/// A DB that exists but has never completed a run must NOT count as fresh: `last_run_ms` of 0 means
/// no run, and treating it as recent would cache a failed first index as success for a whole window.
#[test]
fn a_db_that_never_completed_a_run_is_not_fresh() {
    let o = oracle();
    let spool = spool(&o);
    let dir = tmp("neverran");
    let main = main_db(&dir);
    let db = default_forensics_db(&dir);
    drop(open_forensics_db(&db, NOW_MS).unwrap()); // schema only, no run
    assert!(db.exists());
    assert!(
        ensure_fresh_index(&db, &opts_for(&spool), &main, true, 5.0 * 60_000.0, false, NOW_MS)
            .unwrap()
            .is_some(),
        "an un-run DB was treated as fresh"
    );
}

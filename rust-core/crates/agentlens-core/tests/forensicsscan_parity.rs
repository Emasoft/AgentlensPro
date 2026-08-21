//! forensicsIndex SLICE B2 parity — scanApiCallEvents (TRDD-DMWOBWFH).
//!
//! Mtimes are STAMPED from the oracle's manifest before every run. Not ceremony: a spool
//! EvidenceRow carries `ts_ms: None`, so `resolve_ts` falls back to the file's mtime, and git does
//! not preserve mtimes — an unstamped fixture would carry whatever time the clone happened and
//! select a different set of rows. Every stamp writes the same fixed values, so concurrent tests
//! stamping the shared fixture cannot race to a different answer.
//!
//! The oracle stores its paths as a `<FIX>` token, substituted here before parsing. That keeps the
//! comparison byte-exact while keeping this machine's home directory out of a committed file.

use std::path::{Path, PathBuf};

use agentlens_core::forensics_scan::{scan_api_call_events, ScanApiCallOptions};
use serde_json::Value;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/forensicsscan")
}

fn oracle() -> Value {
    let p = fixtures().with_file_name("forensicsscan-expected.json");
    let raw = std::fs::read_to_string(&p).expect("fixture missing — run gen-forensicsscan-expected.mjs");
    serde_json::from_str(&raw.replace("<FIX>", &fixtures().to_string_lossy())).unwrap()
}

/// Key SET **and ORDER**, recursively — a port emitting the right keys in the wrong order has
/// changed the wire shape.
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
        _ => assert_eq!(got, want, "value differs at {path}"),
    }
}

fn stamp(o: &Value, dir: &Path) {
    for (name, ms) in o["mtimes"].as_object().unwrap() {
        let ms = ms.as_f64().unwrap();
        let ft = filetime::FileTime::from_unix_time((ms / 1000.0) as i64, ((ms % 1000.0) * 1e6) as u32);
        filetime::set_file_mtime(dir.join(name), ft).unwrap_or_else(|e| panic!("stamp {name}: {e}"));
    }
}

fn run(spool: &Path, cap: Option<usize>, window_hours: Option<f64>, now_ms: f64) -> (Value, Value) {
    let mut opts = ScanApiCallOptions::new(spool.to_path_buf(), fixtures().join("no-such-store"));
    opts.with_content = false;
    opts.window_hours = window_hours;
    if let Some(c) = cap {
        opts.scan_cap = c;
    }
    let (events, coverage) = scan_api_call_events(&opts, now_ms);
    (Value::Array(events.iter().map(|e| e.to_value()).collect()), coverage.to_value())
}

fn in_place(o: &Value) -> PathBuf {
    let spool = fixtures().join("spool");
    stamp(o, &spool);
    spool
}

#[test]
fn scan_api_call_events_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let spool = in_place(&o);
    let now = o["nowMs"].as_f64().unwrap();
    for r in o["runs"].as_array().unwrap() {
        let label = r["label"].as_str().unwrap();
        let (events, coverage) = run(&spool, r["scanCap"].as_u64().map(|c| c as usize), None, now);
        same(&events, &r["events"], &format!("{label}.events"));
        same(&coverage, &r["coverage"], &format!("{label}.coverage"));
    }
}

/// THE WINDOW HAS NO TS ORACLE — scanApiCallEvents computes it from `Date.now()` with no seam, so a
/// windowed run pinned in a fixture would compare rows selected against the generator's wall clock
/// against rows selected against the test's (generated that way it returned 0 events, these mtimes
/// being ~10 months old). Here `now_ms` IS a parameter, so the window is pinned directly.
///
/// This also guards the bug the TS records: an earlier shape exempted spool rows from the window on
/// the assumption the drain keeps the spool young — false whenever the server is stopped, so a
/// windowHours scan indexed days-old calls while its note claimed otherwise. `old.response` sits 48h
/// back and MUST drop out.
#[test]
fn the_window_excludes_old_spool_rows_and_is_measured_from_now_ms() {
    let o = oracle();
    let spool = in_place(&o);
    let now = o["nowMs"].as_f64().unwrap();

    let (all, _) = run(&spool, None, None, now);
    assert_eq!(all.as_array().unwrap().len(), 5);

    let (windowed, cov) = run(&spool, None, Some(1.0), now);
    let ids: Vec<&str> = windowed.as_array().unwrap().iter().map(|e| e["callId"].as_str().unwrap()).collect();
    assert_eq!(ids.len(), 4, "the 48h-old row must drop out: {ids:?}");
    assert!(!ids.contains(&"msg_dddd"));
    // The TS interpolates the NUMBER, so it reads "1h" — not "1.0h".
    assert!(cov["note"].as_str().unwrap().contains("in the last 1h"), "note: {}", cov["note"]);

    // A window of 0 is FALSY in the TS, so it means no window rather than an empty one.
    let (zero, cov0) = run(&spool, None, Some(0.0), now);
    assert_eq!(zero.as_array().unwrap().len(), 5, "windowHours 0 must mean no window");
    assert!(!cov0["note"].as_str().unwrap().contains("in the last"));
}

#[test]
fn a_body_without_a_usage_block_is_scanned_but_yields_no_event() {
    let o = oracle();
    let (events, cov) = run(&in_place(&o), None, None, o["nowMs"].as_f64().unwrap());
    // Six response FILES scanned, five carrying usage. Coverage counts files, events count
    // usage-bearing bodies; conflating them would make the note lie.
    assert_eq!(cov["responseFilesScanned"].as_u64().unwrap(), 6);
    let ids: Vec<&str> = events.as_array().unwrap().iter().map(|e| e["callId"].as_str().unwrap()).collect();
    assert_eq!(ids.len(), 5);
    assert!(!ids.contains(&"msg_cccc"), "a usage-less body produced an event: {ids:?}");
}

#[test]
fn an_unattributed_call_omits_its_link_keys_rather_than_nulling_them() {
    let o = oracle();
    let (events, _) = run(&in_place(&o), None, None, o["nowMs"].as_f64().unwrap());
    let un = events
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["callId"] == Value::String("msg_bbbb".into()))
        .expect("msg_bbbb");
    for k in ["requestRef", "requestContentTags", "sessionId", "accountUuid", "frontmatterFp"] {
        assert!(un.get(k).is_none(), "{k} should be OMITTED, not null — JSON.stringify drops undefined");
    }
    assert_eq!(un["effort"], Value::String("none".into()));
    assert_eq!(un["attributed"], Value::Bool(false));
}

/// call_id hashes the SRC_NAME, never the ref. The TS records that hashing the location-dependent
/// ref gave one physical call two primary keys across a drain, so INSERT OR REPLACE kept both rows
/// and every aggregate double-counted its tokens and dollars. Running from a DIFFERENT directory is
/// exactly that scenario: the ref changes, the src_name does not, and the id must not move.
#[test]
fn the_synthesized_call_id_is_stable_across_a_relocation() {
    let o = oracle();
    let want = o["runs"][0]["events"]
        .as_array()
        .unwrap()
        .iter()
        .find_map(|e| e["callId"].as_str().filter(|s| s.starts_with("sha1:")))
        .expect("the oracle should carry one synthesized id")
        .to_owned();

    let moved = std::env::temp_dir().join(format!("al-fscan-moved-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&moved);
    std::fs::create_dir_all(&moved).unwrap();
    for name in o["mtimes"].as_object().unwrap().keys() {
        std::fs::copy(fixtures().join("spool").join(name), moved.join(name)).unwrap();
    }
    stamp(&o, &moved);

    let (events, _) = run(&moved, None, None, o["nowMs"].as_f64().unwrap());
    let ids: Vec<&str> = events.as_array().unwrap().iter().filter_map(|e| e["callId"].as_str()).collect();
    assert!(ids.contains(&want.as_str()), "synthesized id moved after relocation: {ids:?}");
    let _ = std::fs::remove_dir_all(&moved);
}

#[test]
fn no_spool_and_no_store_is_a_complete_empty_scan_not_an_error() {
    let o = oracle();
    let (events, cov) = run(&fixtures().join("nope"), None, None, o["nowMs"].as_f64().unwrap());
    assert!(events.as_array().unwrap().is_empty());
    assert_eq!(cov["dirExists"], Value::Bool(false));
    // `complete: true` is deliberate — nothing was missed, because there was nothing.
    assert_eq!(cov["complete"], Value::Bool(true));
    same(&cov, &o["absent"]["coverage"], "absent.coverage");
}

//! Cross-engine parity for `store/bodiesEvidence` (TRDD-DMWOBWFH P4x.2h) — the unported
//! prerequisite `cacheBreakTimeline` was blocked on. Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-store/tests/fixtures/gen-evidence-expected.mjs
//!
//! THIS ORACLE IS DIFFERENT IN KIND from the others in this repo. The fixture is a REAL Parquet
//! store written by the TYPESCRIPT store, and this test reads it with the Rust reader. So it does
//! not merely check that two implementations agree on logic — it checks the ON-DISK COMPATIBILITY
//! BOUNDARY the store's module doc claims. A Rust-written store would make this pass while proving
//! nothing about that claim.
//!
//! Row ORDER is deliberately NOT part of the contract (store rows follow the parquet scan, spool
//! rows the readdir), so both sides sort by src_name. Everything else is compared exactly.

use std::path::{Path, PathBuf};

use agentlens_store::bodies_evidence::{list_body_evidence, load_body_texts, EvidenceFilter, EvidenceRow};
use serde_json::{json, Value};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}
fn store_dir() -> PathBuf {
    fixtures().join("evidence-store")
}
fn spool_dir() -> PathBuf {
    fixtures().join("evidence-spool")
}

fn oracle() -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join("evidence-expected.json")).unwrap()).unwrap()
}

/// The TS wire shape, so the comparison is against the oracle verbatim rather than a hand-mapped
/// subset — a field the port forgot would otherwise simply not be compared.
/// serde_json Number equality does NOT bridge PosInt vs Float, so an integral f64 must be emitted
/// as an integer or `1786582800000.0` compares unequal to `1786582800000` with every digit matching.
fn num(x: f64) -> Value {
    if x.is_finite() && x.fract() == 0.0 && x.abs() < 9.007_199_254_740_992e15 {
        json!(x as i64)
    } else {
        json!(x)
    }
}

fn row_json(r: &EvidenceRow) -> Value {
    json!({
        "srcName": r.src_name,
        "bodyId": r.body_id,
        "sessionId": r.session_id,
        "tsMs": r.ts_ms.map(num),
        "rawBytes": num(r.raw_bytes),
        "kind": r.kind,
        "location": r.location,
    })
}

fn list(f: &EvidenceFilter, with_spool: bool) -> Vec<EvidenceRow> {
    let spool = spool_dir();
    let mut rows =
        list_body_evidence(&store_dir(), if with_spool { Some(spool.as_path()) } else { None }, f).unwrap();
    rows.sort_by(|a, b| a.src_name.cmp(&b.src_name));
    rows
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

fn same(got: &Value, exp: &Value, label: &str) {
    assert_eq!(keys(got), keys(exp), "{label}: key set/ORDER differs\n  got={got}\n  exp={exp}");
    match exp {
        Value::Object(o) => {
            for (k, ev) in o {
                same(&got[k], ev, &format!("{label}.{k}"));
            }
        }
        Value::Array(ea) => {
            let ga = got.as_array().cloned().unwrap_or_default();
            assert_eq!(ga.len(), ea.len(), "{label}: length\n  got={got}\n  exp={exp}");
            for (i, (g, e)) in ga.iter().zip(ea).enumerate() {
                same(g, e, &format!("{label}[{i}]"));
            }
        }
        _ => assert_eq!(got, exp, "{label}"),
    }
}

#[test]
fn list_body_evidence_reproduces_the_ts_oracle_over_a_ts_written_store() {
    let o = oracle();
    let t0 = o["t0"].as_f64().unwrap();
    let t1 = o["t1"].as_f64().unwrap();
    let cases: Vec<(&str, EvidenceFilter, bool)> = vec![
        ("all", EvidenceFilter::default(), true),
        ("storeOnly", EvidenceFilter::default(), false),
        ("bySessionA", EvidenceFilter { session_id: Some("sess-A".into()), ..Default::default() }, true),
        ("byKindResponse", EvidenceFilter { kind: Some("response".into()), ..Default::default() }, true),
        ("byTsFrom", EvidenceFilter { ts_from_ms: Some(t1), ..Default::default() }, true),
        (
            "byTsRange",
            EvidenceFilter { ts_from_ms: Some(t0), ts_to_ms: Some(t1), ..Default::default() },
            true,
        ),
    ];
    for (name, f, with_spool) in cases {
        let got = Value::Array(list(&f, with_spool).iter().map(row_json).collect());
        same(&got, &o["cases"][name], name);
    }
}

/// THE VANISHED-TURN REGRESSION this module exists to prevent: the drain deleted aaa's spool file
/// once the store provably held it. A reader whose evidence base is the spool would silently lose
/// that turn — and would look correct, because nothing errors.
#[test]
fn a_body_the_drain_deleted_is_still_evidence_and_still_reconstructs() {
    assert!(!spool_dir().join("aaa.request.json").exists(), "the fixture's drain must have run");
    let rows = list(&EvidenceFilter::default(), true);
    let aaa = rows.iter().find(|r| r.src_name == "aaa.request.json").expect("drained body is still evidence");
    assert_eq!(aaa.location, "store");
    assert_eq!(aaa.session_id.as_deref(), Some("sess-A"), "the store knows what the spool no longer can");

    let o = oracle();
    let mut sel = rows.clone();
    let texts = load_body_texts(&store_dir(), Some(&spool_dir()), &mut sel, 32).unwrap();
    // Byte-identical to the ORIGINAL raw, not merely to whatever the store returns: the body_id is
    // the sha256 of the original, so a round trip that agreed with itself would still be caught.
    assert_eq!(texts["aaa.request.json"], o["raws"]["aaa.request.json"].as_str().unwrap());
}

/// A body present in BOTH spool and store must yield exactly ONE row, or a caller double-counts a
/// turn for as long as the drain lag lasts.
#[test]
fn a_body_in_both_places_yields_one_row_from_the_store() {
    let rows = list(&EvidenceFilter::default(), true);
    for name in ["bbb.request.json", "ccc.response.json"] {
        assert!(spool_dir().join(name).exists(), "{name} must still be in the spool");
        let hits: Vec<&EvidenceRow> = rows.iter().filter(|r| r.src_name == name).collect();
        assert_eq!(hits.len(), 1, "{name}: exactly one row");
        assert_eq!(hits[0].location, "store", "{name}: the store row wins — richer metadata, proven bytes");
    }
}

/// A spool-only body carries NO metadata: its name is an opaque uuid, and reading it to learn the
/// session is precisely the read-everything cost this module removes. Callers must keep these null
/// rows and filter them after parsing.
#[test]
fn a_spool_only_body_is_listed_with_null_metadata_and_loads_from_disk() {
    let rows = list(&EvidenceFilter::default(), true);
    let ddd = rows.iter().find(|r| r.src_name == "ddd.request.json").expect("spool-only body is evidence");
    assert_eq!(ddd.location, "spool");
    assert_eq!(ddd.body_id, None);
    assert_eq!(ddd.session_id, None);
    assert_eq!(ddd.ts_ms, None);
    assert!(ddd.raw_bytes > 0.0, "the size is known — it is the one thing a stat gives for free");

    let o = oracle();
    let mut sel = rows.clone();
    let texts = load_body_texts(&store_dir(), Some(&spool_dir()), &mut sel, 32).unwrap();
    assert_eq!(texts["ddd.request.json"], o["raws"]["ddd.request.json"].as_str().unwrap());
}

/// SURPRISING, AND CORRECT: `inStore` is built from the rows the filter KEPT, so a body excluded
/// from the store half can reappear from the spool. Under sessionId='sess-A', ccc (sess-B) is
/// filtered out of the store half and its spool copy is appended — a row the caller's own filter
/// excluded. Pinned because it looks like a bug and "fixing" it would diverge from the TS.
#[test]
fn a_store_row_the_filter_excluded_can_reappear_as_a_spool_row() {
    let rows = list(&EvidenceFilter { session_id: Some("sess-A".into()), ..Default::default() }, true);
    let ccc = rows.iter().find(|r| r.src_name == "ccc.response.json").expect("ccc reappears from the spool");
    assert_eq!(ccc.location, "spool", "excluded from the store half, so not in inStore");
    assert_eq!(ccc.session_id, None, "and as a spool row it carries no session at all");
    // The pushdown itself still works: ddd is spool-only and therefore unfilterable by session,
    // while aaa/bbb ARE sess-A store rows.
    assert!(rows.iter().any(|r| r.src_name == "ddd.request.json"));
    assert_eq!(rows.iter().filter(|r| r.location == "store").count(), 2);
}

/// Every load must reconstruct byte-identically, and the chunk size is a MEMORY bound, not a
/// semantic one — chunk=1 and chunk=32 must agree exactly.
#[test]
fn every_body_round_trips_and_chunking_changes_nothing() {
    let o = oracle();
    let rows = list(&EvidenceFilter::default(), true);
    let mut a = rows.clone();
    let mut b = rows.clone();
    let big = load_body_texts(&store_dir(), Some(&spool_dir()), &mut a, 32).unwrap();
    let one = load_body_texts(&store_dir(), Some(&spool_dir()), &mut b, 1).unwrap();
    assert_eq!(big, one, "chunking is a memory bound, not a semantic one");

    let exp = o["loaded"].as_object().unwrap();
    assert_eq!(big.len(), exp.len());
    for (name, text) in exp {
        assert_eq!(&big[name], text.as_str().unwrap(), "{name}");
    }
    // And the oracle's own two loads agreed, so the fixture is not asserting a self-consistent lie.
    assert_eq!(o["loaded"], o["loadedChunk1"]);
}

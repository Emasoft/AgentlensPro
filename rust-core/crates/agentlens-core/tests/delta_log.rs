//! DeltaLog (P5e): the on-disk format is the TS engine's — proven by loading files the compiled
//! TS DeltaLog wrote (fixtures/delta-log/, gen-delta-log-expected.mjs) — plus the write-side
//! contract: zero bytes on an unchanged save, tombstones, compaction with its from-disk verify,
//! torn-tail tolerance and the refusal of a corrupt mid-file line.

use std::path::{Path, PathBuf};

use agentlens_core::delta_log::{DeltaLog, COMPACT_MIN_BYTES};
use indexmap::IndexMap;
use serde_json::{json, Value};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests").join("fixtures")
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("al-deltalog-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn as_map(v: &Value) -> IndexMap<String, Value> {
    v.as_object().unwrap().iter().map(|(k, v)| (k.clone(), v.clone())).collect()
}

#[test]
fn loads_what_the_ts_engine_wrote() {
    let expected: Value = serde_json::from_str(&std::fs::read_to_string(fixtures().join("delta-log-expected.json")).unwrap()).unwrap();
    let dir = fixtures().join("delta-log");
    // An update, a tombstone and a torn trailing line in the delta — replay matches TS's own load.
    let small = DeltaLog::new(&dir, "small").load().unwrap();
    assert_eq!(small, as_map(&expected["small"]));
    assert_eq!(small["a"]["inputTokens"], 11);
    assert!(!small.contains_key("b"));
    // A compacted snapshot + a fresh delta holding one tombstone.
    let big = DeltaLog::new(&dir, "compacted").load().unwrap();
    assert_eq!(big, as_map(&expected["compacted"]));
    assert_eq!(big.len(), 399);
    assert!(!big.contains_key("s-7"));
}

#[test]
fn save_appends_only_changes_and_tombstones_removals() {
    let dir = tmp("save");
    let mut log = DeltaLog::new(&dir, "t");
    let mut recs: IndexMap<String, Value> = IndexMap::new();
    recs.insert("a".into(), json!({"sessionId":"a","n":1}));
    recs.insert("b".into(), json!({"sessionId":"b","n":2}));
    let r = log.save(&recs).unwrap();
    assert_eq!((r.appended, r.deleted, r.compacted), (2, 0, false));
    assert!(r.bytes > 0);
    // Nothing changed ⇒ ZERO bytes written — the whole point.
    let r = log.save(&recs).unwrap();
    assert_eq!((r.appended, r.deleted, r.bytes), (0, 0, 0));
    // One update + one removal ⇒ one record line + one tombstone, nothing else.
    recs.insert("a".into(), json!({"sessionId":"a","n":3}));
    recs.shift_remove("b");
    let r = log.save(&recs).unwrap();
    assert_eq!((r.appended, r.deleted), (1, 1));
    let delta = std::fs::read_to_string(dir.join("t.delta.ndjson")).unwrap();
    let lines: Vec<&str> = delta.lines().collect();
    assert_eq!(lines.len(), 4);
    assert_eq!(lines[2], r#"{"k":"a","v":{"sessionId":"a","n":3}}"#);
    assert_eq!(lines[3], r#"{"k":"b","d":1}"#);
    // A fresh instance replays to the same state and seeds its hashes: the next save is a no-op.
    let mut again = DeltaLog::new(&dir, "t");
    let loaded = again.load().unwrap();
    assert_eq!(loaded, recs);
    assert_eq!(again.save(&recs).unwrap().bytes, 0);
}

#[test]
fn compaction_writes_a_verified_snapshot_and_drops_the_delta() {
    let dir = tmp("compact");
    let mut log = DeltaLog::new(&dir, "c");
    let mut recs: IndexMap<String, Value> = IndexMap::new();
    let pad = "x".repeat(1024);
    for i in 0..(COMPACT_MIN_BYTES / 1024 + 50) {
        recs.insert(format!("s-{i}"), json!({"sessionId": format!("s-{i}"), "pad": pad, "n": i}));
    }
    let r = log.save(&recs).unwrap();
    assert!(r.compacted, "{r:?}");
    assert!(dir.join("c.snapshot.ndjson").exists());
    assert!(!dir.join("c.delta.ndjson").exists(), "the delta is dropped only after the verified rename");
    assert!(!dir.join("c.snapshot.ndjson.tmp").exists());
    recs.shift_remove("s-3");
    let r = log.save(&recs).unwrap();
    assert!(!r.compacted && r.deleted == 1);
    assert_eq!(DeltaLog::new(&dir, "c").load().unwrap(), recs);
}

#[test]
fn a_torn_tail_is_tolerated_but_a_corrupt_middle_line_is_refused() {
    let dir = tmp("torn");
    std::fs::write(dir.join("x.delta.ndjson"), "{\"k\":\"a\",\"v\":{\"n\":1}}\n{\"k\":\"b\",\"v\":{\"n\":2}}\n{\"k\":\"c\",\"v\":{\"ha").unwrap();
    let m = DeltaLog::new(&dir, "x").load().unwrap();
    assert_eq!(m.len(), 2);
    std::fs::write(dir.join("y.delta.ndjson"), "{\"k\":\"a\",\"v\":{\"n\":1}}\nGARBAGE\n{\"k\":\"b\",\"v\":{\"n\":2}}\n").unwrap();
    let err = DeltaLog::new(&dir, "y").load().unwrap_err();
    assert!(err.contains("corrupt line 2"), "{err}");
}

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

/// TRDD-0R0NGVK6 — append raw bytes to a file, the way a kill mid-append leaves a fragment.
fn append_raw(path: &Path, bytes: &[u8]) {
    use std::io::Write;
    std::fs::OpenOptions::new().append(true).open(path).unwrap().write_all(bytes).unwrap();
}

fn recs(pairs: &[(&str, Value)]) -> IndexMap<String, Value> {
    pairs.iter().map(|(k, v)| (k.to_string(), v.clone())).collect()
}

/// TRDD-0R0NGVK6 — save()'s append branch heals a torn tail instead of gluing onto it.
#[test]
fn save_after_a_torn_tail_does_not_glue_onto_it() {
    let dir = tmp("heal-save");
    let mut log = DeltaLog::new(&dir, "h");
    let ab = recs(&[("a", json!({"n":1})), ("b", json!({"n":2}))]);
    log.save(&ab).unwrap();
    let delta = dir.join("h.delta.ndjson");
    append_raw(&delta, b"{\"k\":\"c\",\"v\":{\"ha");
    let abd = recs(&[("a", json!({"n":1})), ("b", json!({"n":2})), ("d", json!({"n":4}))]);
    let r = log.save(&abd).unwrap();
    // Tiny data, far under COMPACT_MIN_BYTES: the APPEND branch ran (compaction would drop the delta).
    assert!(!r.compacted && delta.exists(), "{r:?}");
    assert_eq!(DeltaLog::new(&dir, "h").load().unwrap(), abd);
}

/// TRDD-0R0NGVK6 — append_changed() heals a torn tail instead of gluing onto it.
#[test]
fn append_changed_after_a_torn_tail_does_not_glue_onto_it() {
    let dir = tmp("heal-append");
    let mut log = DeltaLog::new(&dir, "h");
    let ab = recs(&[("a", json!({"n":1})), ("b", json!({"n":2}))]);
    log.save(&ab).unwrap();
    let delta = dir.join("h.delta.ndjson");
    append_raw(&delta, b"{\"k\":\"c\",\"v\":{\"ha");
    log.append_changed(&recs(&[("d", json!({"n":4}))])).unwrap();
    assert!(delta.exists());
    let abd = recs(&[("a", json!({"n":1})), ("b", json!({"n":2})), ("d", json!({"n":4}))]);
    assert_eq!(DeltaLog::new(&dir, "h").load().unwrap(), abd);
}

/// TRDD-0R0NGVK6 — a torn multi-byte UTF-8 char at the tail drops only the torn line, never the file.
#[test]
fn a_torn_utf8_tail_keeps_every_complete_record() {
    let dir = tmp("heal-utf8");
    let mut log = DeltaLog::new(&dir, "u");
    let ab = recs(&[("a", json!({"t":"héllo €"})), ("b", json!({"t":"日本語"}))]);
    log.save(&ab).unwrap();
    let delta = dir.join("u.delta.ndjson");
    // 0xE2 is the first byte of the 3-byte '€' — the file is no longer valid UTF-8.
    append_raw(&delta, b"{\"k\":\"z\",\"v\":{\"t\":\"\xE2");
    let mut again = DeltaLog::new(&dir, "u");
    assert_eq!(again.load().unwrap(), ab, "every complete record survives a torn UTF-8 tail");
    again.append_changed(&recs(&[("c", json!({"t":"ça"}))])).unwrap();
    let abc = recs(&[("a", json!({"t":"héllo €"})), ("b", json!({"t":"日本語"})), ("c", json!({"t":"ça"}))]);
    assert_eq!(DeltaLog::new(&dir, "u").load().unwrap(), abc);
}

/// TRDD-0R0NGVK6 — a non-UTF-8 line in the MIDDLE is damage, not a torn tail: load() refuses it.
#[test]
fn a_non_utf8_middle_line_is_refused() {
    let dir = tmp("mid-utf8");
    std::fs::write(dir.join("m.delta.ndjson"), b"{\"k\":\"a\",\"v\":{\"n\":1}}\n\xFF\xFE\n{\"k\":\"b\",\"v\":{\"n\":2}}\n").unwrap();
    let err = DeltaLog::new(&dir, "m").load().unwrap_err();
    assert!(err.contains("corrupt line 2"), "{err}");
}

/// TRDD-0R0NGVK6 — a read error other than not-found is an Err, never a silently empty file.
#[test]
fn a_non_notfound_read_error_is_an_error() {
    let dir = tmp("eisdir");
    std::fs::create_dir_all(dir.join("e.delta.ndjson")).unwrap();
    assert!(DeltaLog::new(&dir, "e").load().is_err());
}


/// TRDD-0R0NGVK6 round 2 — a complete last record missing only its '\n' is KEPT (a '\n' is
/// appended), never truncated: replay returned it and `written` holds its hash, so nothing would
/// ever re-append it.
#[test]
fn a_complete_last_line_without_newline_is_kept() {
    let dir = tmp("heal-complete");
    let mut log = DeltaLog::new(&dir, "k");
    log.save(&recs(&[("a", json!({"n":1})), ("b", json!({"n":2}))])).unwrap();
    append_raw(&dir.join("k.delta.ndjson"), b"{\"k\":\"c\",\"v\":{\"n\":3}}");
    let mut again = DeltaLog::new(&dir, "k");
    assert_eq!(again.load().unwrap().len(), 3);
    again.append_changed(&recs(&[("d", json!({"n":4}))])).unwrap();
    let all = recs(&[("a", json!({"n":1})), ("b", json!({"n":2})), ("c", json!({"n":3})), ("d", json!({"n":4}))]);
    assert_eq!(DeltaLog::new(&dir, "k").load().unwrap(), all);
}

/// TRDD-0R0NGVK6 round 2 — a torn fragment longer than one 64 KiB scan block: the backwards scan
/// must cross blocks to find the last '\n' instead of truncating the whole delta.
#[test]
fn a_torn_fragment_longer_than_one_block_is_cut_at_its_own_start() {
    let dir = tmp("heal-multiblock");
    let mut log = DeltaLog::new(&dir, "m");
    let ab = recs(&[("a", json!({"n":1})), ("b", json!({"n":2}))]);
    log.save(&ab).unwrap();
    let delta = dir.join("m.delta.ndjson");
    let mut frag = b"{\"k\":\"c\",\"v\":{\"pad\":\"".to_vec();
    frag.extend(std::iter::repeat_n(b'x', 70 * 1024)); // > 64 KiB, unterminated ⇒ torn
    append_raw(&delta, &frag);
    let abd = recs(&[("a", json!({"n":1})), ("b", json!({"n":2})), ("d", json!({"n":4}))]);
    let r = log.save(&abd).unwrap();
    // ~70 KiB total, far under COMPACT_MIN_BYTES: the APPEND branch ran.
    assert!(!r.compacted && delta.exists(), "{r:?}");
    assert_eq!(DeltaLog::new(&dir, "m").load().unwrap(), abd);
}

/// TRDD-0R0NGVK6 round 2 — a delta holding ONLY a torn fragment (no '\n' at all) is truncated to
/// zero before the append, so load() returns exactly the appended record.
#[test]
fn a_delta_that_is_only_a_torn_fragment_is_replaced_by_the_append() {
    let dir = tmp("heal-only-frag");
    let delta = dir.join("o.delta.ndjson");
    std::fs::write(&delta, b"{\"k\":\"c\",\"v\":{\"ha").unwrap();
    let mut log = DeltaLog::new(&dir, "o");
    assert!(log.load().unwrap().is_empty());
    let d = recs(&[("d", json!({"n":4}))]);
    log.append_changed(&d).unwrap();
    assert_eq!(DeltaLog::new(&dir, "o").load().unwrap(), d);
}

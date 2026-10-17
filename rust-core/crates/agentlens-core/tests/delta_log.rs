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


/// TRDD-AJGTQ007 — every live record for_each_live visits, collected into a map (its own visit
/// order is file/line order of the winning lines, so compare as sets of (key, value)).
fn visit_all(log: &DeltaLog) -> Result<std::collections::BTreeMap<String, Value>, String> {
    let mut seen = std::collections::BTreeMap::new();
    let n = log.for_each_live(|k, v| {
        assert!(seen.insert(k.to_owned(), v).is_none(), "{k} visited twice");
        Ok(())
    })?;
    assert_eq!(n, seen.len());
    Ok(seen)
}

fn sorted(m: &IndexMap<String, Value>) -> std::collections::BTreeMap<String, Value> {
    m.iter().map(|(k, v)| (k.clone(), v.clone())).collect()
}

/// TRDD-AJGTQ007 — the streaming replay keeps the old map's rules: the LAST line of a key wins
/// (across snapshot then delta), and a tombstone deletes; for_each_live sees the same records.
#[test]
fn streaming_replay_last_line_wins_and_a_tombstone_deletes() {
    let dir = tmp("stream-rules");
    std::fs::write(dir.join("r.snapshot.ndjson"), "{\"k\":\"a\",\"v\":{\"n\":1}}\n{\"k\":\"b\",\"v\":{\"n\":2}}\n{\"k\":\"c\",\"v\":{\"n\":3}}\n").unwrap();
    std::fs::write(dir.join("r.delta.ndjson"), "{\"k\":\"a\",\"v\":{\"n\":10}}\n{\"k\":\"b\",\"d\":1}\n{\"k\":\"a\",\"v\":{\"n\":11}}\n").unwrap();
    let log = DeltaLog::new(&dir, "r");
    let m = DeltaLog::new(&dir, "r").load().unwrap();
    assert_eq!(m, recs(&[("a", json!({"n":11})), ("c", json!({"n":3}))]));
    assert_eq!(visit_all(&log).unwrap(), sorted(&m));
}

/// TRDD-AJGTQ007 — order is the old IndexMap's: an updated key KEEPS its first position, a key
/// re-inserted after its tombstone moves to the END. Not the file order of the winning lines
/// (that would put "a" after "b" here).
#[test]
fn streaming_replay_preserves_the_old_map_order() {
    let dir = tmp("stream-order");
    std::fs::write(dir.join("o.snapshot.ndjson"), "{\"k\":\"a\",\"v\":1}\n{\"k\":\"b\",\"v\":2}\n{\"k\":\"c\",\"v\":3}\n").unwrap();
    std::fs::write(dir.join("o.delta.ndjson"), "{\"k\":\"b\",\"v\":20}\n{\"k\":\"a\",\"d\":1}\n{\"k\":\"d\",\"v\":4}\n{\"k\":\"a\",\"v\":5}\n{\"k\":\"c\",\"v\":30}\n").unwrap();
    let m = DeltaLog::new(&dir, "o").load().unwrap();
    let order: Vec<&str> = m.keys().map(String::as_str).collect();
    assert_eq!(order, ["b", "c", "d", "a"]);
    assert_eq!(m, recs(&[("b", json!(20)), ("c", json!(30)), ("d", json!(4)), ("a", json!(5))]));
}

/// TRDD-AJGTQ007 — the per-line rules the old replay applied to an odd line: no string `k` is
/// ignored, `d` must be the integer 1 to delete (1.0 is not), a `v` of null IS a record, and a
/// duplicate field takes its last value (the `Value` parse's own rule).
#[test]
fn streaming_replay_keeps_the_odd_line_rules() {
    let dir = tmp("stream-odd");
    std::fs::write(
        dir.join("q.delta.ndjson"),
        "{\"k\":\"a\",\"v\":1}\n{\"k\":\"b\",\"v\":2}\n[1,2]\n7\n{\"v\":9}\n{\"k\":5,\"v\":9}\n{\"k\":\"a\",\"d\":1.0}\n{\"k\":\"n\",\"v\":null}\n{\"k\":\"x\",\"v\":1,\"v\":2}\n{\"k\":\"b\",\"d\":2}\n",
    )
    .unwrap();
    let m = DeltaLog::new(&dir, "q").load().unwrap();
    assert_eq!(m, recs(&[("a", json!(1)), ("b", json!(2)), ("n", Value::Null), ("x", json!(2))]));
    assert_eq!(visit_all(&DeltaLog::new(&dir, "q")).unwrap(), sorted(&m));
}

/// TRDD-AJGTQ007 — a torn trailing line in EITHER file is tolerated (per file, as before), and
/// for_each_live tolerates it too.
#[test]
fn streaming_replay_tolerates_a_torn_tail_in_each_file() {
    let dir = tmp("stream-torn");
    std::fs::write(dir.join("t.snapshot.ndjson"), "{\"k\":\"a\",\"v\":1}\n{\"k\":\"b\",\"v\":{\"ha\n\n").unwrap();
    std::fs::write(dir.join("t.delta.ndjson"), "{\"k\":\"c\",\"v\":3}\n{\"k\":\"d\",\"v\":4}").unwrap();
    // The delta's last line is COMPLETE without its '\n': it is a record, not a torn tail.
    let m = DeltaLog::new(&dir, "t").load().unwrap();
    assert_eq!(m, recs(&[("a", json!(1)), ("c", json!(3)), ("d", json!(4))]));
    assert_eq!(visit_all(&DeltaLog::new(&dir, "t")).unwrap(), sorted(&m));
}

/// TRDD-AJGTQ007 — a corrupt line that is NOT the last non-blank one is an Err naming the line,
/// in the snapshot too, and for_each_live refuses it before visiting any record.
#[test]
fn streaming_replay_refuses_a_corrupt_middle_line_before_visiting_anything() {
    let dir = tmp("stream-corrupt");
    std::fs::write(dir.join("c.snapshot.ndjson"), "{\"k\":\"a\",\"v\":1}\n\n{\"k\":\"b\",\"v\":\nGARBAGE\n{\"k\":\"c\",\"v\":3}\n").unwrap();
    let err = DeltaLog::new(&dir, "c").load().unwrap_err();
    assert!(err.contains("corrupt line 3"), "{err}");
    let mut visited = 0;
    let err = DeltaLog::new(&dir, "c").for_each_live(|_, _| {
        visited += 1;
        Ok(())
    });
    assert!(err.unwrap_err().contains("corrupt line 3"));
    assert_eq!(visited, 0, "pass 1 validates every line before pass 2 hands over a record");
}

/// TRDD-AJGTQ007 — an Err from the visitor stops the visit and is returned as is.
#[test]
fn for_each_live_propagates_the_visitor_error() {
    let dir = tmp("stream-err");
    std::fs::write(dir.join("e.delta.ndjson"), "{\"k\":\"a\",\"v\":1}\n{\"k\":\"b\",\"v\":2}\n").unwrap();
    let mut calls = 0;
    let err = DeltaLog::new(&dir, "e").for_each_live(|_, _| {
        calls += 1;
        Err("appender failed".into())
    });
    assert_eq!(err.unwrap_err(), "appender failed");
    assert_eq!(calls, 1);
}

/// TRDD-AJGTQ007 — for_each_live matches load() on the TS engine's own files.
#[test]
fn for_each_live_matches_load_on_the_ts_fixtures() {
    let dir = fixtures().join("delta-log");
    for name in ["small", "compacted"] {
        let m = DeltaLog::new(&dir, name).load().unwrap();
        assert_eq!(visit_all(&DeltaLog::new(&dir, name)).unwrap(), sorted(&m), "{name}");
    }
}

/// TRDD-AJGTQ007 — load() seeds `written` with hash_json(to_string(v)) for every record, whoever
/// wrote it. `written` is private, so this proves it through the two things that read it: an
/// unchanged save after load() writes ZERO bytes (every hash equals what changed_lines computes),
/// and save(empty) tombstones EVERY loaded key (the TRDD-6B7VV2Z7 B' fix relies on exactly that).
fn assert_load_seeds_written(dir: &Path, name: &str, expected: &IndexMap<String, Value>) {
    let mut log = DeltaLog::new(dir, name);
    assert_eq!(&log.load().unwrap(), expected);
    let r = log.save(expected).unwrap();
    assert_eq!((r.appended, r.deleted, r.bytes), (0, 0, 0), "unchanged save after load() writes nothing");
    let r = log.save(&IndexMap::new()).unwrap();
    assert_eq!(r.deleted, expected.len(), "save(empty) tombstones every key load() seeded");
    assert!(DeltaLog::new(dir, name).load().unwrap().is_empty());
}

/// Records whose serialization exercises key order, floats, escapes and non-ASCII text.
fn awkward_records() -> IndexMap<String, Value> {
    recs(&[
        ("z", json!({"b": 1, "a": [1.5, -0.0, 1e300, 12345678901234567u64], "s": "q\"\\\n\t€日本"})),
        ("y", json!({"nested": {"k": null, "t": true}, "ts_ms": 1760000000000i64})),
        ("x", json!("plain")),
    ])
}

/// TRDD-AJGTQ007 — seeding after records written by append_changed.
#[test]
fn load_seeds_written_for_records_append_changed_wrote() {
    let dir = tmp("seed-append");
    let r = awkward_records();
    DeltaLog::new(&dir, "s").append_changed(&r).unwrap();
    assert!(dir.join("s.delta.ndjson").exists() && !dir.join("s.snapshot.ndjson").exists());
    assert_load_seeds_written(&dir, "s", &r);
}

/// TRDD-AJGTQ007 — seeding after records written by compaction (the snapshot path).
#[test]
fn load_seeds_written_for_records_compaction_wrote() {
    let dir = tmp("seed-compact");
    let mut r = awkward_records();
    let pad = "x".repeat(1024);
    for i in 0..(COMPACT_MIN_BYTES / 1024 + 50) {
        r.insert(format!("p-{i}"), json!({"pad": pad, "n": i}));
    }
    let res = DeltaLog::new(&dir, "s").save(&r).unwrap();
    assert!(res.compacted && !dir.join("s.delta.ndjson").exists(), "{res:?}");
    assert_load_seeds_written(&dir, "s", &r);
}

/// TRDD-AJGTQ007 — seeding after a record heal_torn_tail completed (a complete last line that only
/// lacked its '\n', which the heal keeps and terminates).
#[test]
fn load_seeds_written_for_a_record_heal_torn_tail_completed() {
    let dir = tmp("seed-heal");
    let mut log = DeltaLog::new(&dir, "s");
    log.save(&recs(&[("a", json!({"n":1}))])).unwrap();
    append_raw(&dir.join("s.delta.ndjson"), b"{\"k\":\"c\",\"v\":{\"t\":\"\xC3\xA7a\",\"f\":0.1}}");
    let mut again = DeltaLog::new(&dir, "s");
    again.load().unwrap();
    again.append_changed(&recs(&[("d", json!({"n":4}))])).unwrap(); // heals: appends the '\n'
    let all = recs(&[("a", json!({"n":1})), ("c", json!({"t":"ça","f":0.1})), ("d", json!({"n":4}))]);
    assert_load_seeds_written(&dir, "s", &all);
}


/// TRDD-1RJBOEI1 — a log with every replay case compaction must fold: updates (one keeps its
/// position), a tombstone, a re-insert after its tombstone (moves to the end), a number spelled
/// differently from what to_string prints, key order the parser keeps, and a torn delta tail.
/// Replay order is a, c, d, b; the winning lines' file order is c, a, d, b.
fn write_mixed_log(dir: &Path, name: &str) {
    std::fs::write(
        dir.join(format!("{name}.snapshot.ndjson")),
        "{\"k\":\"a\",\"v\":{\"n\":1}}\n{\"k\":\"b\",\"v\":{\"n\":2}}\n{\"k\":\"c\",\"v\":{\"y\":1.50,\"x\":\"q\\u00e9\"}}\n",
    )
    .unwrap();
    std::fs::write(
        dir.join(format!("{name}.delta.ndjson")),
        "{\"k\":\"a\",\"v\":{\"n\":10,\"f\":1e3}}\n{\"k\":\"b\",\"d\":1}\n\n{\"k\":\"d\",\"v\":null}\n{\"k\":\"b\",\"v\":[true,\"€\"]}\n{\"k\":\"e\",\"v\":{\"ha",
    )
    .unwrap();
}

/// The snapshot bytes the pre-TRDD-1RJBOEI1 compact() wrote for `records`, inlined as the oracle.
fn old_snapshot_bytes(records: &IndexMap<String, Value>) -> Vec<u8> {
    let mut body = String::new();
    for (k, v) in records {
        body.push_str(&serde_json::to_string(&json!({ "k": k, "v": v })).unwrap());
        body.push('\n');
    }
    body.into_bytes()
}

/// TRDD-1RJBOEI1 — both streaming compactions (boot's compact_from_disk and the records-driven
/// compact behind save/compact_now) write exactly the bytes the old compact() wrote.
#[test]
fn streaming_compaction_writes_the_old_snapshot_byte_for_byte() {
    let dir = tmp("compact-bytes");
    write_mixed_log(&dir, "m");
    let map = DeltaLog::new(&dir, "m").load().unwrap();
    assert_eq!(map.keys().collect::<Vec<_>>(), ["a", "c", "d", "b"], "replay order, not file order");
    let expected = old_snapshot_bytes(&map);
    let snap = dir.join("m.snapshot.ndjson");

    let bytes = DeltaLog::new(&dir, "m").compact_from_disk().unwrap();
    assert_eq!(std::fs::read(&snap).unwrap(), expected, "compact_from_disk");
    assert_eq!(bytes, expected.len() as u64);
    assert!(!dir.join("m.delta.ndjson").exists() && !dir.join("m.snapshot.ndjson.tmp").exists());
    assert_eq!(DeltaLog::new(&dir, "m").load().unwrap(), map);

    write_mixed_log(&dir, "n");
    let mut log = DeltaLog::new(&dir, "n");
    let m = log.load().unwrap();
    let bytes = log.compact_now(&m).unwrap();
    assert_eq!(std::fs::read(dir.join("n.snapshot.ndjson")).unwrap(), expected, "compact_now(records)");
    assert_eq!(bytes, expected.len() as u64);
    assert!(!dir.join("n.delta.ndjson").exists() && !dir.join("n.snapshot.ndjson.tmp").exists());
}

/// What load() seeds into `written`, proved through its two readers (see assert_load_seeds_written)
/// on a log whose `written` was seeded by something else.
fn assert_seeded(log: &mut DeltaLog, dir: &Path, name: &str, expected: &IndexMap<String, Value>) {
    let r = log.save(expected).unwrap();
    assert_eq!((r.appended, r.deleted, r.bytes), (0, 0, 0), "unchanged save writes nothing");
    let r = log.save(&IndexMap::new()).unwrap();
    assert_eq!(r.deleted, expected.len(), "save(empty) tombstones every seeded key");
    assert!(DeltaLog::new(dir, name).load().unwrap().is_empty());
}

/// TRDD-1RJBOEI1 — compact_from_disk seeds `written` as load() did, with a delta (it compacts)
/// and without one (it only seeds and leaves the snapshot untouched, as compact_now no-oped).
#[test]
fn compact_from_disk_seeds_written_like_load() {
    let dir = tmp("compact-seed");
    write_mixed_log(&dir, "m");
    let map = DeltaLog::new(&dir, "m").load().unwrap();
    let mut log = DeltaLog::new(&dir, "m");
    assert!(log.compact_from_disk().unwrap() > 0);
    assert_seeded(&mut log, &dir, "m", &map);

    let r = awkward_records();
    std::fs::write(dir.join("s.snapshot.ndjson"), old_snapshot_bytes(&r)).unwrap();
    let mut log = DeltaLog::new(&dir, "s");
    assert_eq!(log.compact_from_disk().unwrap(), 0, "empty delta: no compaction");
    assert_eq!(std::fs::read(dir.join("s.snapshot.ndjson")).unwrap(), old_snapshot_bytes(&r));
    assert_seeded(&mut log, &dir, "s", &r);
}

/// TRDD-1RJBOEI1 — a corrupt source fails before anything is replaced or seeded, like load().
#[test]
fn compact_from_disk_refuses_a_corrupt_source() {
    let dir = tmp("compact-corrupt-src");
    std::fs::write(dir.join("x.snapshot.ndjson"), "{\"k\":\"a\",\"v\":1}\nGARBAGE\n{\"k\":\"b\",\"v\":2}\n").unwrap();
    std::fs::write(dir.join("x.delta.ndjson"), "{\"k\":\"c\",\"v\":3}\n").unwrap();
    let err = DeltaLog::new(&dir, "x").compact_from_disk().unwrap_err();
    assert!(err.contains("corrupt line 2"), "{err}");
    assert!(dir.join("x.delta.ndjson").exists() && !dir.join("x.snapshot.ndjson.tmp").exists());
}

/// TRDD-1RJBOEI1 — the from-disk verify is real: `<snapshot>.tmp` is pre-created as a symlink to
/// /dev/null, so the write "succeeds" and the read-back is empty. Both compactions must refuse,
/// keep the old snapshot and the delta byte for byte, and remove the bad tmp. Without the verify,
/// the rename would install the empty file as the snapshot.
#[cfg(unix)]
#[test]
fn a_corrupted_temp_snapshot_fails_verification_and_keeps_the_old_snapshot() {
    let dir = tmp("compact-bad-tmp");
    for name in ["m", "n"] {
        write_mixed_log(&dir, name);
        let snap = dir.join(format!("{name}.snapshot.ndjson"));
        let delta = dir.join(format!("{name}.delta.ndjson"));
        let tmp_path = dir.join(format!("{name}.snapshot.ndjson.tmp"));
        let (snap_before, delta_before) = (std::fs::read(&snap).unwrap(), std::fs::read(&delta).unwrap());
        std::os::unix::fs::symlink("/dev/null", &tmp_path).unwrap();
        let mut log = DeltaLog::new(&dir, name);
        let map = DeltaLog::new(&dir, name).load().unwrap();
        let err = if name == "m" { log.compact_from_disk().unwrap_err() } else { log.compact_now(&map).unwrap_err() };
        assert!(err.contains("compaction verify failed") && err.contains("expected 4"), "{name}: {err}");
        assert_eq!(std::fs::read(&snap).unwrap(), snap_before, "{name}: old snapshot kept");
        assert_eq!(std::fs::read(&delta).unwrap(), delta_before, "{name}: delta kept");
        assert!(std::fs::symlink_metadata(&tmp_path).is_err(), "{name}: the bad tmp is removed");
        assert_eq!(DeltaLog::new(&dir, name).load().unwrap(), map, "{name}: nothing lost");
        if name == "m" {
            // As load() succeeding then compact_now failing: `written` is still seeded.
            let r = log.append_changed(&map).unwrap();
            assert_eq!((r.appended, r.bytes), (0, 0), "written seeded despite the failed compaction");
        }
    }
}


/// TRDD-1RJBOEI1 — a write error inside the record loop (TmpSnapshot::push, not create and not the
/// final flush) stops the compaction at once and removes `<snapshot>.tmp`. `<snapshot>.tmp` is
/// pre-created as a FIFO whose only reader opens it and closes it at once, so the create succeeds
/// and the first write that reaches the OS fails with EPIPE (Rust ignores SIGPIPE). The `big`
/// record is larger than TmpSnapshot's 64 KiB buffer, so BufWriter hands it to the OS inside push.
/// Both compactions must keep the old snapshot and the delta byte for byte, and leave no tmp.
#[cfg(unix)]
#[test]
fn a_failed_write_stops_compaction_and_removes_the_temp_snapshot() {
    use std::os::unix::ffi::OsStrExt;
    let dir = tmp("compact-write-fail");
    let big = "x".repeat(256 * 1024);
    for name in ["m", "n"] {
        let snap = dir.join(format!("{name}.snapshot.ndjson"));
        let delta = dir.join(format!("{name}.delta.ndjson"));
        let tmp_path = dir.join(format!("{name}.snapshot.ndjson.tmp"));
        std::fs::write(&snap, "{\"k\":\"a\",\"v\":1}\n").unwrap();
        std::fs::write(&delta, format!("{{\"k\":\"big\",\"v\":\"{big}\"}}\n{{\"k\":\"b\",\"v\":2}}\n")).unwrap();
        let (snap_before, delta_before) = (std::fs::read(&snap).unwrap(), std::fs::read(&delta).unwrap());
        let map = DeltaLog::new(&dir, name).load().unwrap();
        let fifo = std::ffi::CString::new(tmp_path.as_os_str().as_bytes()).unwrap();
        // SAFETY: a valid NUL-terminated path; mkfifo only creates the node.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0, "{name}: mkfifo");
        let reader_path = tmp_path.clone();
        // Blocks until the compaction opens the FIFO for writing, then closes: every write after is EPIPE.
        let reader = std::thread::spawn(move || drop(std::fs::File::open(reader_path).unwrap()));
        let mut log = DeltaLog::new(&dir, name);
        let err = if name == "m" { log.compact_from_disk().unwrap_err() } else { log.compact_now(&map).unwrap_err() };
        reader.join().unwrap();
        assert!(err.contains(&format!("{name}.snapshot.ndjson.tmp")) && !err.contains("verify"), "{name}: a write error, not a verify: {err}");
        assert!(std::fs::symlink_metadata(&tmp_path).is_err(), "{name}: no stray tmp is left");
        assert_eq!(std::fs::read(&snap).unwrap(), snap_before, "{name}: old snapshot kept");
        assert_eq!(std::fs::read(&delta).unwrap(), delta_before, "{name}: delta kept");
        assert_eq!(DeltaLog::new(&dir, name).load().unwrap(), map, "{name}: nothing lost");
        if name == "m" {
            // The pass stopped at the failed write, so `written` was never seeded: all 3 re-append.
            let r = log.append_changed(&map).unwrap();
            assert_eq!(r.appended, 3, "written untouched after the failed write");
        }
    }
}

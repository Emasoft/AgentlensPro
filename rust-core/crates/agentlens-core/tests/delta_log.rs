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

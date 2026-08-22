//! Writer round-trip pins (TRDD-DMWOBWFH P3): a store written by SpanStoreWriter must read back
//! through scan_call_events with nothing lost, seal identically, and survive crash shapes
//! (index behind disk, interrupted compress, late append after seal).

use std::fs;
use std::path::PathBuf;

use agentlens_spanstore::writer::{SpanStoreWriter, INDEX_FILE};
use agentlens_spanstore::{scan_call_events, segment_day_ms};

fn fixture_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("al-writer-{}-{}", std::process::id(), tag));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("mkdir");
    dir
}

fn api_span(req: &str, iso: &str, received_ms: i64) -> serde_json::Value {
    serde_json::json!({
        "traceId": format!("t-{req}"), "spanId": format!("s-{req}"),
        "name": "claude_code.api_request",
        "startTime": "0", "receivedAt": received_ms,
        "attributes": [
            { "key": "session.id", "value": { "stringValue": "sess-w" } },
            { "key": "event.timestamp", "value": { "stringValue": iso } },
            { "key": "request_id", "value": { "stringValue": req } },
            { "key": "input_tokens", "value": { "intValue": "42" } },
        ],
    })
}

const DAY18: &str = "2026-08-18";
const DAY17: &str = "2026-08-17";
fn day_ms(day: &str) -> i64 {
    segment_day_ms(&format!("{day}.ndjson")).expect("day")
}

#[test]
fn written_store_reads_back_through_the_scanner_and_the_index_is_true() {
    let dir = fixture_dir("roundtrip");
    let now = day_ms(DAY18) + 3_600_000;
    let mut w = SpanStoreWriter::open(&dir);
    w.append(&api_span("req-1", "2026-08-18T08:00:00Z", now), now);
    w.append(&api_span("req-2", "2026-08-18T09:00:00Z", now + 1000), now);
    // A span whose receivedAt names yesterday buckets into yesterday's segment.
    w.append(&api_span("req-old", "2026-08-17T23:00:00Z", day_ms(DAY17) + 1000), now);
    let flushed = w.flush();
    assert_eq!(flushed.appended_spans, 3);
    assert!(dir.join(format!("{DAY18}.ndjson")).exists());
    assert!(dir.join(format!("{DAY17}.ndjson")).exists());

    let r = scan_call_events(&dir, 0, i64::MAX).expect("scan");
    let ids: Vec<_> = r.events.iter().filter_map(|e| e.request_id.as_deref()).collect();
    assert_eq!(ids, ["req-old", "req-1", "req-2"], "everything written must read back, time-ordered");
    assert_eq!(r.events[1].input_tokens, 42);

    let idx: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(dir.join(INDEX_FILE)).expect("index")).expect("json");
    assert_eq!(idx["version"], 1);
    assert_eq!(idx["segments"][DAY18]["count"], 2);
    assert_eq!(idx["segments"][DAY17]["count"], 1);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn reopen_reconciles_an_index_left_behind_by_a_crash() {
    let dir = fixture_dir("reconcile");
    let now = day_ms(DAY18);
    let mut w = SpanStoreWriter::open(&dir);
    w.append(&api_span("req-a", "2026-08-18T01:00:00Z", now), now);
    w.flush();
    // Crash shape: bytes hit the segment but the index write never happened — simulate by
    // appending a raw line behind the index's back.
    let seg = dir.join(format!("{DAY18}.ndjson"));
    let extra = format!("{}\n", api_span("req-b", "2026-08-18T02:00:00Z", now + 1));
    fs::OpenOptions::new().append(true).open(&seg).and_then(|mut f| {
        use std::io::Write;
        f.write_all(extra.as_bytes())
    }).expect("raw append");

    let _w2 = SpanStoreWriter::open(&dir); // reopen must recount the disagreeing segment
    let idx: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(dir.join(INDEX_FILE)).expect("index")).expect("json");
    assert_eq!(idx["segments"][DAY18]["count"], 2, "the stale-low count must be recounted from disk");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn sealing_compresses_verifies_and_the_scanner_still_reads_the_gz() {
    let dir = fixture_dir("seal");
    let yesterday = day_ms(DAY17);
    let today = day_ms(DAY18) + 1000;
    let mut w = SpanStoreWriter::open(&dir);
    w.append(&api_span("req-sealed", "2026-08-17T12:00:00Z", yesterday + 1000), today);
    w.flush();

    let r = w.compress_sealed_segments(today, usize::MAX, &|| false);
    assert_eq!(r.compressed, [DAY17], "yesterday seals");
    assert!(r.warnings.is_empty(), "clean seal: {:?}", r.warnings);
    assert_eq!(r.remaining, 0);
    assert!(!r.paused_for_pressure);
    assert!(!dir.join(format!("{DAY17}.ndjson")).exists(), "plain form deleted after verify");
    assert!(dir.join(format!("{DAY17}.ndjson.gz")).exists());

    let scan = scan_call_events(&dir, 0, i64::MAX).expect("scan");
    assert_eq!(scan.events.len(), 1, "the gz form must read identically");
    assert_eq!(scan.events[0].request_id.as_deref(), Some("req-sealed"));

    // Late append after seal: both forms coexist, flush warns, the reader dedupes by identity.
    w.append(&api_span("req-late", "2026-08-17T13:00:00Z", yesterday + 2000), today);
    let f2 = w.flush();
    assert!(f2.warnings.iter().any(|m| m.contains("already compressed")), "the late-append path must be LOUD");
    let scan2 = scan_call_events(&dir, 0, i64::MAX).expect("scan2");
    let ids: Vec<_> = scan2.events.iter().filter_map(|e| e.request_id.as_deref()).collect();
    assert_eq!(ids, ["req-sealed", "req-late"], "both forms merge on read, nothing double-counted");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn todays_segment_is_never_compressed() {
    let dir = fixture_dir("today");
    let now = day_ms(DAY18) + 1000;
    let mut w = SpanStoreWriter::open(&dir);
    w.append(&api_span("req-today", "2026-08-18T00:30:00Z", now), now);
    w.flush();
    let r = w.compress_sealed_segments(now, usize::MAX, &|| false);
    assert!(r.compressed.is_empty());
    assert!(dir.join(format!("{DAY18}.ndjson")).exists(), "the active day stays plain");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn compress_max_segments_bounds_one_slice_and_reports_remaining() {
    let dir = fixture_dir("slice");
    let now = day_ms(DAY18) + 1000;
    let mut w = SpanStoreWriter::open(&dir);
    // Three sealed days behind "today", one segment must be left for a second slice.
    w.append(&api_span("req-1", "2026-08-15T00:00:00Z", day_ms("2026-08-15") + 1), now);
    w.append(&api_span("req-2", "2026-08-16T00:00:00Z", day_ms("2026-08-16") + 1), now);
    w.append(&api_span("req-3", "2026-08-17T00:00:00Z", day_ms(DAY17) + 1), now);
    w.flush();

    let r = w.compress_sealed_segments(now, 2, &|| false);
    assert_eq!(r.compressed.len(), 2, "only the budgeted slice compresses this call");
    assert_eq!(r.remaining, 1, "the third sealed segment is left for the next sweep");
    assert!(!r.paused_for_pressure);

    let r2 = w.compress_sealed_segments(now, usize::MAX, &|| false);
    assert_eq!(r2.compressed.len(), 1, "the remaining segment compresses on the next slice");
    assert_eq!(r2.remaining, 0);
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn compress_pauses_under_pressure_and_compresses_nothing() {
    let dir = fixture_dir("pressure");
    let now = day_ms(DAY18) + 1000;
    let mut w = SpanStoreWriter::open(&dir);
    w.append(&api_span("req-sealed", "2026-08-17T12:00:00Z", day_ms(DAY17) + 1), now);
    w.flush();

    let r = w.compress_sealed_segments(now, usize::MAX, &|| true);
    assert!(r.compressed.is_empty(), "under pressure, nothing compresses");
    assert_eq!(r.remaining, 1);
    assert!(r.paused_for_pressure);
    assert!(dir.join(format!("{DAY17}.ndjson")).exists(), "plain segment left untouched");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn retention_deletes_expired_segments_but_never_a_foreign_file() {
    let dir = fixture_dir("retention");
    let now = day_ms(DAY18) + 1000;
    let mut w = SpanStoreWriter::open(&dir);
    w.append(&api_span("req-old", "2026-08-01T00:00:00Z", day_ms("2026-08-01") + 1), now);
    w.append(&api_span("req-recent", "2026-08-17T12:00:00Z", day_ms(DAY17) + 1), now);
    w.flush();
    // A foreign file in the same dir must survive retention untouched.
    fs::write(dir.join("spans.json.bak"), b"not a segment").expect("write foreign file");

    let deleted = w.run_retention(5.0, now as f64);
    assert_eq!(deleted.len(), 1, "only the segment older than the 5-day window is deleted");
    assert_eq!(deleted[0].segment, "2026-08-01.ndjson");
    assert_eq!(deleted[0].spans, 1);
    assert!(!dir.join("2026-08-01.ndjson").exists());
    assert!(dir.join(format!("{DAY17}.ndjson")).exists(), "within the window — survives");
    assert!(dir.join("spans.json.bak").exists(), "a foreign file is never touched by retention");

    let idx: serde_json::Value =
        serde_json::from_str(&fs::read_to_string(dir.join(INDEX_FILE)).expect("index")).expect("json");
    assert!(idx["segments"]["2026-08-01"].is_null(), "the index no longer references the deleted segment");
    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn retention_zero_days_floors_to_one_day_not_everything() {
    let dir = fixture_dir("retention-floor");
    let now = day_ms(DAY18) + 1000;
    let mut w = SpanStoreWriter::open(&dir);
    // YESTERDAY's segment is the one that DISCRIMINATES. Today's does not: the cutoff is
    // truncated to a UTC day and compared with `>=`, so at retention 0 the cutoff IS today's
    // midnight and today's segment compares equal and survives WITH OR WITHOUT the floor.
    // An earlier version of this test asserted only that, named itself after the floor, and
    // passed with `retention_days.max(1.0)` deleted outright — proven by mutation. A test that
    // cannot fail on a broken port is documentation, not a gate.
    //   floored (1 day) -> cutoff = yesterday 00:00 -> yesterday compares equal -> KEPT
    //   unfloored (0)   -> cutoff = today 00:00     -> yesterday is older       -> DELETED
    w.append(&api_span("req-today", "2026-08-18T00:30:00Z", now), now);
    w.append(&api_span("req-yesterday", "2026-08-17T12:00:00Z", day_ms(DAY17) + 1), now);
    w.flush();

    let deleted = w.run_retention(0.0, now as f64);
    assert!(deleted.is_empty(), "retentionDays=0 must behave as 1 day, not delete everything");
    assert!(
        dir.join(format!("{DAY17}.ndjson")).exists(),
        "yesterday survives ONLY because run_retention floors 0 to 1 day — this is the assertion \
         that actually gates the floor"
    );
    assert!(dir.join(format!("{DAY18}.ndjson")).exists());
    let _ = fs::remove_dir_all(&dir);
}

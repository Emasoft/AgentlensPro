//! TRDD-GR6WHHK5 — the ingest path stamps `receivedAt` BEFORE the store append, so a span whose
//! own timestamps are unresolvable still carries its ARRIVAL time on disk.
//!
//! `"0"` is the wire value, not a parse failure: it is the protobuf default for an unset field,
//! and the Codex exporter emits `codex.api_request` spans with no timestamps at all (602 of
//! 432,335 spans in the 2026-09-05 segment). While `receivedAt` was stamped only by
//! `SpanWindow::add` — i.e. AFTER `writer.append` — the disk copy carried no timestamp of any
//! kind, `load_range` admitted it on boot via the `now_ms` fallback, and the first 5 s prune tick
//! evicted it, because since TRDD-YILE6N3T an unresolvable age resolves to `i64::MIN`.

use agentlens_core::span_window::{SpanWindow, SUMMARY_WINDOW_FLOOR_MS};
use agentlens_core::CoreState;
use agentlens_spanstore::writer::{span_timestamp_ms, SpanStoreWriter};
use serde_json::{json, Value};

fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("al-received-at-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// One `codex.api_request` trace span in the shape the exporter really sends: both timestamps
/// present on the wire and both the protobuf default `"0"`.
fn timestampless_payload() -> Value {
    json!({ "resourceSpans": [{ "scopeSpans": [{ "spans": [{
        "name": "codex.api_request",
        "traceId": "0123456789abcdef0123456789abcdef",
        "spanId": "0123456789abcdef",
        "startTimeUnixNano": "0",
        "endTimeUnixNano": "0",
        "attributes": [{ "key": "session.id", "value": { "stringValue": "codex-sess-1" } }]
    }] }] }] })
}

/// Every record persisted under `<data>/spans`, whichever day segment it landed in.
fn segment_records(spans_dir: &std::path::Path) -> Vec<Value> {
    let mut out = Vec::new();
    for entry in std::fs::read_dir(spans_dir).expect("the span store dir exists").flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.ends_with(".ndjson") {
            continue;
        }
        let text = std::fs::read_to_string(entry.path()).expect("segment readable");
        out.extend(text.lines().filter(|l| !l.is_empty()).map(|l| serde_json::from_str::<Value>(l).expect("segment line is JSON")));
    }
    out
}

/// Ingest one timestamp-less span through the REAL path and flush it, returning the arrival ms
/// the in-memory window recorded — the value the disk copy has to agree with.
fn ingest_and_flush(dir: &std::path::Path) -> (CoreState, i64) {
    let mut st = CoreState::open(dir);
    agentlens_core::ingest_parsed(&mut st, "traces", timestampless_payload(), "/v1/traces");
    st.flush_spans();
    assert_eq!(st.counters.spans_appended, 1, "the span reached the store append");
    assert_eq!(st.window.spans.len(), 1, "…and the in-memory window");
    let arrived = st.window.spans[0]["receivedAt"].as_i64().expect("SpanWindow::add stamps receivedAt");
    (st, arrived)
}

#[test]
fn a_timestampless_span_carries_its_arrival_time_on_disk() {
    let dir = tmp("disk");
    let t0 = agentlens_core::now_ms();
    let (st, arrived) = ingest_and_flush(&dir);
    let t1 = agentlens_core::now_ms();
    drop(st); // release the writer before the segment is read back

    let records = segment_records(&dir.join("spans"));
    assert_eq!(records.len(), 1, "exactly one span persisted: {records:?}");
    let on_disk = records[0]
        .get("receivedAt")
        .and_then(Value::as_i64)
        .expect("the DISK copy must carry receivedAt — stamped before writer.append, not after it");
    assert_eq!(on_disk, arrived, "the disk copy and the window agree on the arrival time");
    assert!((t0..=t1).contains(&on_disk), "receivedAt is the ingest clock: {t0} <= {on_disk} <= {t1}");
    // The span's OWN timestamps are untouched — this stamps arrival, it does not invent a start.
    assert_eq!(records[0]["startTime"], "0", "the wire value is preserved verbatim");
    assert_eq!(records[0]["endTime"], "0");
}

#[test]
fn a_timestampless_span_read_back_from_disk_survives_the_first_prune_tick() {
    let dir = tmp("prune");
    let (st, arrived) = ingest_and_flush(&dir);
    drop(st); // restart

    // TRDD-FSMISF5K deleted `SpanWindow::boot_load`, so the record is read back the way every
    // remaining reader gets it — `load_range` — and put in the window through the ingest door.
    // `add` re-stamps only when `receivedAt` is ABSENT, so the disk copy's arrival time is what
    // the prune below is judged against, which is exactly the invariant under test.
    let mut w = SpanStoreWriter::open(&dir.join("spans"));
    let mut window = SpanWindow::new(SUMMARY_WINDOW_FLOOR_MS);
    let loaded = w.load_range(arrived - SUMMARY_WINDOW_FLOOR_MS, i64::MAX, arrived);
    assert_eq!(loaded.len(), 1, "load_range admits the span");
    for s in loaded {
        window.add(s, arrived + 999_999);
    }

    // The invariant the prune depends on: the loaded record resolves to its arrival time BY
    // ITSELF. `i64::MIN` is the fallback `prune` passes since TRDD-YILE6N3T, so a record with no
    // resolvable timestamp lands at `i64::MIN` and loses every cutoff.
    let resolved = span_timestamp_ms(window.spans[0].as_object().expect("span object"), i64::MIN);
    assert_eq!(resolved, arrived, "resolves on its own, not through a now fallback");

    assert!(!window.prune(arrived), "the first chores tick after boot evicts nothing");
    assert_eq!(window.spans.len(), 1, "still in the window");
    assert!(!window.prune(arrived + SUMMARY_WINDOW_FLOOR_MS - 1), "…and for the whole window");
    assert_eq!(window.spans.len(), 1);
    // It ages out on time like any other span — the fix restores honest timing, not immortality.
    assert!(window.prune(arrived + SUMMARY_WINDOW_FLOOR_MS + 1), "past the cutoff it goes");
    assert!(window.spans.is_empty());
}

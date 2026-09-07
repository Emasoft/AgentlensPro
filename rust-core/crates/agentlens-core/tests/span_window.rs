//! The summarization window (P4h): appended by ingest, pruned by time on the flush tick — the
//! standalone server's `spans` array, not the 5-minute collector window.
//!
//! TRDD-FSMISF5K deleted the BOOT LOAD, so this file no longer asserts one. The two claims it was
//! carrying are both still live and are asserted separately, because they were never really about
//! the window: the DAY/WINDOW FILTER belongs to `writer.load_range` (still the read path behind
//! `/api/timeline`'s on-demand reparse), and the PRUNE belongs here. The claim that DID die with
//! the boot load — "a fresh `CoreState` already has the last 24h resident" — is replaced by its
//! negation, which is the point of the card.

use agentlens_core::span_window::{summary_window_ms, SUMMARY_WINDOW_FLOOR_MS};
use agentlens_core::CoreState;
use agentlens_spanstore::writer::SpanStoreWriter;
use serde_json::{json, Value};

fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("al-window-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn span(id: &str, start_ms: i64) -> Value {
    json!({ "traceId": "t", "spanId": id, "name": "claude_code.api_request",
            "startTime": (start_ms as i128 * 1_000_000).to_string(), "endTime": (start_ms as i128 * 1_000_000 + 1_000_000).to_string(),
            "attributes": [] })
}

#[test]
fn a_fresh_core_state_boots_with_an_empty_window_and_prunes_what_ingest_adds() {
    let data = tmp("boot");
    // Real clock: the store buckets by real dates, and the prune is relative to now_ms().
    let now = agentlens_core::now_ms();
    let day = 86_400_000;
    {
        let mut w = SpanStoreWriter::open(&data.join("spans"));
        // Three days back, 30 hours back (outside 24h), 2 hours back, 1 minute back.
        for (id, at) in [("old3", now - 3 * day), ("old30h", now - 30 * 3_600_000), ("h2", now - 2 * 3_600_000), ("m1", now - 60_000)] {
            w.append(&span(id, at), at);
        }
        w.flush();
        assert!(w.stats().0 >= 3, "four spans over at least three UTC days");
    }

    // THE CARD'S POINT (TRDD-FSMISF5K): a store holding four spans, two of them inside the 24-hour
    // window, boots with ZERO resident. On the live collector the same load was 528,219 spans and
    // a 13.2 GB peak that produced 1 of 23,274 served cards.
    let mut st = CoreState::open(&data);
    assert!(st.window.spans.is_empty(), "no boot replay — the window starts empty");
    assert!(st.writer.stats().1 >= 4, "…and nothing was evicted from disk to achieve that");

    // The window still fills from INGEST and still prunes by age. `add`'s second argument IS the
    // arrival clock and `span_timestamp_ms` PREFERS the `receivedAt` it stamps, so a two-hour-old
    // span has to be added with the arrival time it really had — passing `now` here would stamp it
    // as fresh and it would never age out (the shape of the TRDD-YILE6N3T freeze).
    st.window.add(span("h2", now - 2 * 3_600_000), now - 2 * 3_600_000);
    st.window.add(span("live", now), now);
    assert_eq!(st.window.spans[1]["receivedAt"], now, "add stamps arrival when the span has none");
    let v = st.data_version;
    st.prune_window(now);
    assert_eq!(st.window.spans.len(), 2, "nothing is older than the 24h window yet");
    assert_eq!(st.data_version, v, "no shrink → no bump");
    st.prune_window(now + 23 * 3_600_000);
    let ids: Vec<&str> = st.window.spans.iter().map(|s| s["spanId"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["live"], "h2 falls out of the 24h window");
    assert_eq!(st.data_version, v + 1);
    st.prune_window(now + 23 * 3_600_000);
    assert_eq!(st.data_version, v + 1, "no shrink → no bump");
}

/// The day/window filter the boot load used to exercise still exists — it is `load_range`'s, and
/// it is the read path `/api/timeline`'s on-demand reparse goes through (`ui.rs:1637`). Asserted
/// here rather than deleted with the caller that used to be its only in-repo witness.
#[test]
fn load_range_reads_only_the_segments_overlapping_the_window() {
    let data = tmp("range");
    let now = agentlens_core::now_ms();
    let day = 86_400_000;
    {
        let mut w = SpanStoreWriter::open(&data.join("spans"));
        for (id, at) in [("old3", now - 3 * day), ("old30h", now - 30 * 3_600_000), ("h2", now - 2 * 3_600_000), ("m1", now - 60_000)] {
            w.append(&span(id, at), at);
        }
        w.flush();
    }
    let mut w = SpanStoreWriter::open(&data.join("spans"));
    let got = w.load_range(now - 24 * 3_600_000, i64::MAX, now);
    let ids: Vec<&str> = got.iter().map(|s| s["spanId"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["h2", "m1"], "day order, then file order — 30h and 3d are outside");
}

#[test]
fn summary_window_hours_resolves_env_then_file_then_default_with_the_floor() {
    let data = tmp("knob");
    // Default 24h (the env is not set in the test process).
    std::env::remove_var("AGENTLENS_SUMMARY_WINDOW_HOURS");
    assert_eq!(summary_window_ms(&data), 24 * 3_600_000);
    // The data dir's config.json wins over the default; min 1 hour.
    std::fs::write(data.join("config.json"), r#"{"retention":{"summaryWindowHours":6}}"#).unwrap();
    assert_eq!(summary_window_ms(&data), 6 * 3_600_000);
    std::fs::write(data.join("config.json"), r#"{"retention":{"summaryWindowHours":0.01}}"#).unwrap();
    assert_eq!(summary_window_ms(&data), 3_600_000);
    // Both sides are constants, so this is a compile-time claim, not a test assertion: the
    // 1-hour clamp above is only meaningful while the floor sits strictly below it.
    const { assert!(SUMMARY_WINDOW_FLOOR_MS < 3_600_000) };
}

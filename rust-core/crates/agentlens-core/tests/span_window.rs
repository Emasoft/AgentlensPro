//! The summarization window (P4h): boot-loaded from the span store for the last
//! summaryWindowHours only, appended by ingest, pruned by time on the flush tick — the
//! standalone server's `spans` array, not the 5-minute collector window.

use agentlens_core::span_window::{summary_window_ms, SpanWindow, SUMMARY_WINDOW_FLOOR_MS};
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
fn boot_loads_only_the_window_and_prunes_by_time() {
    let data = tmp("boot");
    // Real clock: CoreState::open loads relative to now_ms(), so the fixture spans are placed
    // around the real now (day keys are then real dates; the store does not care).
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
    let mut window = SpanWindow::new(24 * 3_600_000);
    let mut w = SpanStoreWriter::open(&data.join("spans"));
    assert_eq!(window.boot_load(&mut w, now), 2);
    let ids: Vec<&str> = window.spans.iter().map(|s| s["spanId"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["h2", "m1"], "day order, then file order");

    // Ingest appends (receivedAt stamped), and the prune drops by the span's own timestamp.
    window.add(span("live", now), now);
    assert_eq!(window.spans[2]["receivedAt"], now);
    assert!(!window.prune(now), "nothing older than the window yet");
    assert!(window.prune(now + 23 * 3_600_000), "h2 falls out");
    let ids: Vec<&str> = window.spans.iter().map(|s| s["spanId"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["m1", "live"]);

    // CoreState::open does the same boot load and bumps data_version on a prune.
    let mut st = CoreState::open(&data);
    assert_eq!(st.window.spans.len(), 2);
    let v = st.data_version;
    st.prune_window(now + 23 * 3_600_000);
    assert_eq!(st.window.spans.len(), 1);
    assert_eq!(st.data_version, v + 1);
    st.prune_window(now + 23 * 3_600_000);
    assert_eq!(st.data_version, v + 1, "no shrink → no bump");
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
    assert!(SUMMARY_WINDOW_FLOOR_MS < 3_600_000);
}

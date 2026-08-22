//! The log-event SINK end to end (TRDD-DMWOBWFH C2(b), porting TRDD-AMEA4O4Z): an OTEL log event
//! the rich-event gate REJECTS must land in `<data>/log-events/<day>.ndjsonl` instead of being
//! counted and thrown away, and the bytes must reach `/api/server-stats`.
//!
//! The record's SHAPE is oracled against the TS in `logeventsink_parity.rs`; this file only
//! asserts the plumbing — that the built record reaches disk, that the counters follow it, and
//! that a sink failure loses the event WITHOUT taking the payload's spans down with it.

use agentlens_core::{ingest_post, now_ms, server_stats::server_stats, CoreState};
use serde_json::{json, Value};

fn tmp(tag: &str) -> std::path::PathBuf {
    // PID *and* tag: cargo runs the tests in this file as parallel THREADS of one process, so a
    // PID-only path lets siblings delete each other's fixtures mid-run.
    let d = std::env::temp_dir().join(format!("al-logsink-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// `<data>/log-events/<UTC day>.ndjsonl` — built from the SAME helper `hook_events::bucket_path`
/// uses, deliberately. A second day-math implementation here could only drift and fail the test
/// for the wrong reason; the day math has its own parity coverage, and what this file asserts is
/// that the sink wrote to the day bucket at all.
fn bucket(data: &std::path::Path, ts_ms: i64) -> std::path::PathBuf {
    let day = agentlens_core::summarize::helpers::iso_from_ms(ts_ms as f64);
    data.join("log-events").join(format!("{}.ndjsonl", &day[..10]))
}

/// One payload carrying a gated-OUT log event next to a real span: the span still lands, and the
/// dropped event is now PERSISTED rather than only tallied.
fn payload(events: &[&str]) -> String {
    let records: Vec<Value> = events
        .iter()
        .map(|ev| {
            json!({
                "timeUnixNano": (now_ms() as i128 * 1_000_000).to_string(),
                "traceId": "0123456789abcdef0123456789abcdef",
                "spanId": "0123456789abcdef",
                "severityText": "INFO",
                "attributes": [
                    { "key": "event.name", "value": { "stringValue": ev } },
                    { "key": "session.id", "value": { "stringValue": "sess-sink" } }
                ]
            })
        })
        .collect();
    json!({ "resourceLogs": [{ "scopeLogs": [{ "logRecords": records }] }] }).to_string()
}

#[test]
fn gated_out_log_events_are_persisted_and_counted() {
    let data = tmp("write");
    let mut st = CoreState::open(&data);
    let before = server_stats(&st, now_ms());
    assert_eq!(before["logEvents"]["persistedSinceBoot"], 0);
    assert_eq!(before["logEvents"]["persistedBytesSinceBoot"], 0);
    assert_eq!(before["logEvents"]["files"], 0, "no bucket exists before the first drop");

    ingest_post(&mut st, "/v1/logs", payload(&["claude_code.user_prompt", "claude_code.tool_decision"]).as_bytes());

    let file = bucket(&data, now_ms());
    let text = std::fs::read_to_string(&file).unwrap_or_else(|e| panic!("bucket {} unreadable: {e}", file.display()));
    let lines: Vec<&str> = text.lines().collect();
    assert_eq!(lines.len(), 2, "one NDJSON line per dropped event");
    let recs: Vec<Value> = lines.iter().map(|l| serde_json::from_str(l).expect("each line is JSON")).collect();
    assert_eq!(recs[0]["name"], "claude_code.user_prompt");
    assert_eq!(recs[0]["ev"], "user_prompt", "the bare name is the gate's comparison key");
    assert_eq!(recs[1]["name"], "claude_code.tool_decision");
    // The whole event survives, not just its name — this is the data the drop used to lose.
    assert_eq!(recs[0]["session"], "sess-sink");
    assert_eq!(recs[0]["severity"], "INFO");
    assert_eq!(recs[0]["attrs"]["session.id"], "sess-sink");
    assert!(recs[0]["tsEvent"].is_i64(), "the event's own emit time, distinct from `ts` (receive time)");

    let after = server_stats(&st, now_ms());
    assert_eq!(after["logEvents"]["persistedSinceBoot"], 2);
    assert_eq!(
        after["logEvents"]["persistedBytesSinceBoot"].as_u64().unwrap(),
        text.len() as u64,
        "the counted bytes are the bytes on disk, newlines included"
    );
    assert_eq!(after["logEvents"]["files"], 1);
    assert_eq!(after["logEvents"]["bytes"], text.len() as u64);
    // The SAME counters appear twice on the wire: the TS spreads the whole persistStats object
    // into `persistence` (`...p`) as well. Wiring only the `logEvents` row leaves a second,
    // adjacent field reporting 0 for a subsystem that is demonstrably writing — which is how the
    // stale "NOT PORTED" comment on this pair survived the C2(a) pass.
    assert_eq!(after["persistence"]["logEventWrites"], 2);
    assert_eq!(after["persistence"]["logEventBytes"].as_u64().unwrap(), text.len() as u64);
    // Still tallied as before — the sink ADDS persistence, it does not replace the counter.
    assert_eq!(after["otlpDroppedLogEvents"], json!({ "claude_code.user_prompt": 1, "claude_code.tool_decision": 1 }));
}

/// A failing sink must not take the payload down with it. The TS chose best-effort here on
/// purpose: rejecting the OTLP request would ALSO lose its spans, trading a disk problem for
/// data loss somewhere that was working. So: the event is lost, the counters stay flat, and the
/// span in the same payload still lands.
#[test]
fn a_sink_failure_loses_the_event_but_never_the_spans() {
    let data = tmp("fail");
    // A regular FILE where the bucket directory must be ⇒ create_dir_all fails on every append.
    std::fs::write(data.join("log-events"), b"not a directory").unwrap();
    let mut st = CoreState::open(&data);

    let span = json!({ "resourceSpans": [{ "scopeSpans": [{ "spans": [{
        "name": "claude_code.api_request",
        "traceId": "0123456789abcdef0123456789abcdef", "spanId": "0123456789abcdef",
        "startTimeUnixNano": (now_ms() as i128 * 1_000_000).to_string(),
        "attributes": [{ "key": "session.id", "value": { "stringValue": "sess-sink" } }]
    }] }] }] })
    .to_string();
    ingest_post(&mut st, "/v1/traces", span.as_bytes());
    ingest_post(&mut st, "/v1/logs", payload(&["claude_code.user_prompt", "claude_code.user_prompt"]).as_bytes());

    let body = server_stats(&st, now_ms());
    assert_eq!(body["logEvents"]["persistedSinceBoot"], 0, "nothing was written");
    assert_eq!(body["logEvents"]["persistedBytesSinceBoot"], 0);
    assert_eq!(body["spans"]["store"]["totalSpans"], 1, "the span in the OTHER payload is untouched");
    // The tally is what makes the loss visible: it climbs while persistedSinceBoot stays flat.
    assert_eq!(body["otlpDroppedLogEvents"], json!({ "claude_code.user_prompt": 2 }));
}

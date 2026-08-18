//! Fixtures-based parity pins for the segment extraction (TRDD-DMWOBWFH P1).
//!
//! The live-store diff proved zero divergence on 240k real events, but a live store cannot pin
//! the EDGE shapes deliberately (string-int OTLP values, a corrupt tail, mid-compression dual
//! segments). These golden fixtures do, so a refactor that quietly changes one of them fails
//! here instead of surfacing as a silent count drift on the next live diff.

use std::fs;
use std::io::Write;
use std::path::PathBuf;

use agentlens_spanstore::{scan_call_events, segment_day_ms};

fn fixture_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("al-parity-{}-{}", std::process::id(), tag));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("mkdir fixture dir");
    dir
}

fn span_line(name: &str, session: &str, attrs: &[(&str, serde_json::Value)]) -> String {
    let mut a: Vec<serde_json::Value> = vec![serde_json::json!({
        "key": "session.id", "value": { "stringValue": session }
    })];
    for (k, v) in attrs {
        a.push(serde_json::json!({ "key": k, "value": v }));
    }
    serde_json::json!({ "name": name, "startTime": "1755504000000000000", "attributes": a })
        .to_string()
}

/// 2026-08-18T08:00:00Z, inside the 2026-08-18 UTC segment. Derived from the lib test's pinned
/// anchor (2026-06-01T00:00:00Z = 1_780_272_000_000) + 78 days + 8h — never hand-guessed.
const TS_ATTR: &str = "2026-08-18T08:00:00.000Z";
const TS_MS: i64 = 1_780_272_000_000 + 78 * 86_400_000 + 8 * 3_600_000;

#[test]
fn golden_extraction_covers_the_known_edge_shapes() {
    let dir = fixture_dir("golden");
    let day = dir.join("2026-08-18.ndjson");
    let lines = [
        // 1) string-int OTLP values — intValue arrives as a STRING; cost in micros preferred.
        span_line("claude_code.api_request", "sess-a", &[
            ("event.timestamp", serde_json::json!({ "stringValue": TS_ATTR })),
            ("request_id", serde_json::json!({ "stringValue": "req-1" })),
            ("model", serde_json::json!({ "stringValue": "claude-opus-5" })),
            ("input_tokens", serde_json::json!({ "intValue": "1234" })),
            ("output_tokens", serde_json::json!({ "intValue": 56 })),
            ("cache_read_tokens", serde_json::json!({ "intValue": "78000" })),
            ("cache_creation_tokens", serde_json::json!({ "intValue": 0 })),
            ("cost_usd_micros", serde_json::json!({ "intValue": "1250000" })),
            ("cost_usd", serde_json::json!({ "doubleValue": 9.99 })),
            ("query_source", serde_json::json!({ "stringValue": "repl_main_thread" })),
            ("speed", serde_json::json!({ "stringValue": "fast" })),
            ("effort", serde_json::json!({ "stringValue": "high" })),
            ("agent.name", serde_json::json!({ "stringValue": "lean-worker" })),
        ]),
        // 2) no event.timestamp, no receivedAt → startTime ns / 1e6.
        span_line("claude_code.api_request", "sess-b", &[
            ("request_id", serde_json::json!({ "stringValue": "req-2" })),
            ("input_tokens", serde_json::json!({ "intValue": 10 })),
        ]),
        // 3) a compaction with string-int token counts.
        span_line("claude_code.compaction", "sess-a", &[
            ("event.timestamp", serde_json::json!({ "stringValue": TS_ATTR })),
            ("trigger", serde_json::json!({ "stringValue": "auto" })),
            ("pre_tokens", serde_json::json!({ "intValue": "500000" })),
            ("post_tokens", serde_json::json!({ "intValue": 12000 })),
        ]),
        // 4) missing session.id → dropped after parse, never a panic.
        r#"{"name":"claude_code.api_request","attributes":[{"key":"request_id","value":{"stringValue":"req-orphan"}}]}"#.to_string(),
        // 5) a foreign span sharing the prefilter substring in an attr — name check must drop it.
        r#"{"name":"other.span","attributes":[{"key":"note","value":{"stringValue":"mentions claude_code.api_request"}}]}"#.to_string(),
    ];
    let mut body = lines.join("\n");
    body.push('\n');
    // 6) corrupt tail line (truncated write) — everything above must still extract.
    body.push_str(r#"{"name":"claude_code.api_request","attributes":[{"key":"sess"#);
    fs::write(&day, body).expect("write segment");

    let r = scan_call_events(&dir, 0, i64::MAX).expect("scan");
    assert_eq!(r.segments_visited, 1);
    assert_eq!(r.events.len(), 2, "orphan + foreign + corrupt tail all dropped");
    assert_eq!(r.compactions.len(), 1);

    let e1 = r.events.iter().find(|e| e.request_id.as_deref() == Some("req-1")).expect("req-1");
    assert_eq!(e1.ts, TS_MS, "event.timestamp attr wins the time precedence");
    assert_eq!(e1.session_id, "sess-a");
    assert_eq!(e1.input_tokens, 1234, "string intValue parses");
    assert_eq!(e1.output_tokens, 56, "numeric intValue parses");
    assert_eq!(e1.cache_read_tokens, 78000);
    assert_eq!(e1.cost_usd, Some(1.25), "cost_usd_micros/1e6 preferred over cost_usd");
    assert_eq!(e1.model.as_deref(), Some("claude-opus-5"));
    assert_eq!(e1.query_source.as_deref(), Some("repl_main_thread"));
    assert_eq!(e1.speed.as_deref(), Some("fast"));
    assert_eq!(e1.effort.as_deref(), Some("high"));
    assert_eq!(e1.agent_name.as_deref(), Some("lean-worker"), "agent.name attr → agent_name field");

    let e2 = r.events.iter().find(|e| e.request_id.as_deref() == Some("req-2")).expect("req-2");
    assert_eq!(e2.ts, 1_755_504_000_000, "startTime ns/1e6 is the fallback clock");

    let c = &r.compactions[0];
    assert_eq!((c.trigger.as_deref(), c.pre_tokens, c.post_tokens), (Some("auto"), Some(500_000), Some(12_000)));

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn gz_segment_extracts_identically_to_plain() {
    let dir_plain = fixture_dir("gz-plain");
    let dir_gz = fixture_dir("gz-sealed");
    let line = span_line("claude_code.api_request", "sess-z", &[
        ("event.timestamp", serde_json::json!({ "stringValue": TS_ATTR })),
        ("request_id", serde_json::json!({ "stringValue": "req-gz" })),
        ("input_tokens", serde_json::json!({ "intValue": "77" })),
    ]);
    fs::write(dir_plain.join("2026-08-18.ndjson"), format!("{line}\n")).expect("plain");
    let gz_file = fs::File::create(dir_gz.join("2026-08-18.ndjson.gz")).expect("gz create");
    let mut enc = flate2::write::GzEncoder::new(gz_file, flate2::Compression::default());
    writeln!(enc, "{line}").expect("gz write");
    enc.finish().expect("gz finish");

    let a = scan_call_events(&dir_plain, 0, i64::MAX).expect("plain scan");
    let b = scan_call_events(&dir_gz, 0, i64::MAX).expect("gz scan");
    assert_eq!(a.events, b.events, "sealed gz and plain segments must extract byte-identically");
    assert_eq!(a.events.len(), 1);
    assert_eq!(a.events[0].input_tokens, 77);

    let _ = fs::remove_dir_all(&dir_plain);
    let _ = fs::remove_dir_all(&dir_gz);
}

#[test]
fn mid_compression_dual_segment_dedupes_by_request_identity() {
    let dir = fixture_dir("dual");
    let line = span_line("claude_code.api_request", "sess-d", &[
        ("event.timestamp", serde_json::json!({ "stringValue": TS_ATTR })),
        ("request_id", serde_json::json!({ "stringValue": "req-dup" })),
    ]);
    fs::write(dir.join("2026-08-18.ndjson"), format!("{line}\n")).expect("plain");
    let gz_file = fs::File::create(dir.join("2026-08-18.ndjson.gz")).expect("gz create");
    let mut enc = flate2::write::GzEncoder::new(gz_file, flate2::Compression::default());
    writeln!(enc, "{line}").expect("gz write");
    enc.finish().expect("gz finish");

    let r = scan_call_events(&dir, 0, i64::MAX).expect("scan");
    assert_eq!(r.segments_visited, 2, "both physical files are visited");
    assert_eq!(r.events.len(), 1, "the same request must not be double-counted mid-compression");

    let _ = fs::remove_dir_all(&dir);
}

#[test]
fn windowing_selects_segments_by_day_and_events_by_their_own_ts() {
    let dir = fixture_dir("window");
    let mk = |req: &str, iso: &str| {
        span_line("claude_code.api_request", "sess-w", &[
            ("event.timestamp", serde_json::json!({ "stringValue": iso })),
            ("request_id", serde_json::json!({ "stringValue": req })),
        ])
    };
    fs::write(dir.join("2026-08-17.ndjson"), format!("{}\n", mk("req-early", "2026-08-17T23:00:00Z"))).expect("d1");
    fs::write(
        dir.join("2026-08-18.ndjson"),
        format!("{}\n{}\n", mk("req-in", "2026-08-18T08:00:00Z"), mk("req-late", "2026-08-18T22:00:00Z")),
    ).expect("d2");
    // Foreign files in the dir are never segments.
    fs::write(dir.join("index.json"), "{}").expect("foreign");

    let day18 = segment_day_ms("2026-08-18.ndjson").expect("day");
    let r = scan_call_events(&dir, day18, day18 + 12 * 3_600_000).expect("scan");
    let ids: Vec<_> = r.events.iter().filter_map(|e| e.request_id.as_deref()).collect();
    assert_eq!(ids, ["req-in"], "day slack may read neighbors, but the event's own ts decides");

    let _ = fs::remove_dir_all(&dir);
}

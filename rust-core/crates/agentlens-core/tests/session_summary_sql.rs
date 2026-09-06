//! TRDD-FSMISF5K phase 1 — the SQL session aggregates must reproduce what the Rust summarizer
//! computes for the SAME spans, before anything that produces them today is deleted.
//!
//! THE COMPARISON IS AGAINST THE ENGINE, NOT AGAINST CONSTANTS. `summarize_spans` is run here on
//! the very fixture the TS-oracle parity test uses (`summarize-spans.json`), and its `claude_code`
//! cards are diffed field-by-field against the rows DuckDB produces from the same spans written as
//! a segment. A hand-copied expected table would pass while both engines drifted together; this
//! fails the moment either side changes.
//!
//! The second test pins the SQL against the TS oracle's own numbers (`summarize-expected.json`),
//! so a change that broke BOTH Rust engines identically still reddens.
//!
//! MUTATION-VERIFIED, both ways, 2026-09-06 — a green suite here is not decoration:
//!
//! | mutation in `session_summary_sql.rs` | what reddened |
//! |---|---|
//! | `arg_min(val, idx)` → `arg_max` (last duplicate attribute wins) | `sql_mirrors_the_attribute_reader_rules`: `"second-model"` vs `"first-model"` |
//! | `total_llm_calls` counts `claude_code.api_request` too | BOTH fixture tests: `sessB totalLlmCalls` 2 vs 1 |

use std::path::PathBuf;
use std::sync::Arc;

use agentlens_core::session_summary_sql::{recent_segment_files, SessionSummarySql};
use serde_json::Value;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn fixture_spans() -> Vec<Value> {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join("summarize-spans.json")).expect("read the fixture"))
        .expect("the fixture parses")
}

/// Write the spans as a segment the reader will accept: one JSON object per line.
fn write_segment(name: &str, spans: &[Value]) -> (PathBuf, PathBuf) {
    let dir = std::env::temp_dir().join(format!("al-sessionsql-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create the segment dir");
    let file = dir.join("2025-08-19.ndjson");
    let body: String = spans.iter().map(|s| format!("{s}\n")).collect();
    std::fs::write(&file, body).expect("write the segment");
    (dir, file)
}

fn f(card: &Value, key: &str) -> f64 {
    card.get(key).and_then(Value::as_f64).unwrap_or(0.0)
}

fn s(card: &Value, key: &str) -> String {
    card.get(key).and_then(Value::as_str).unwrap_or("").to_owned()
}

#[test]
fn sql_aggregates_reproduce_the_rust_summarizer_on_the_parity_fixture() {
    let spans = fixture_spans();
    let (dir, file) = write_segment("engine", &spans);

    let mut sql = SessionSummarySql::new();
    let rows = sql.refresh(&[file]);
    assert!(rows > 0, "the fixture segment must produce at least one session row");

    // The Rust side, over exactly the same spans.
    let shared: Vec<Arc<Value>> = spans.into_iter().map(Arc::new).collect();
    let summary = agentlens_core::summarize::summarizer::summarize_spans(&shared, &|_| None);
    let claude: Vec<&Value> = summary
        .get("sessions")
        .and_then(Value::as_array)
        .expect("sessions array")
        .iter()
        .filter(|c| c.get("source").and_then(Value::as_str) == Some("claude_code"))
        .collect();
    assert!(!claude.is_empty(), "the fixture must contain claude_code sessions");
    assert_eq!(
        claude.len(),
        sql.len(),
        "one SQL row per claude_code session card — got {:?} vs {:?}",
        sql.rows().iter().map(|r| r.session_id.clone()).collect::<Vec<_>>(),
        claude.iter().map(|c| s(c, "sessionId")).collect::<Vec<_>>()
    );

    for card in claude {
        let id = s(card, "sessionId");
        let row = sql.get(&id).unwrap_or_else(|| panic!("no SQL row for session {id}"));
        assert_eq!(row.model, s(card, "model"), "{id} model");
        assert_eq!(row.input_tokens, f(card, "inputTokens"), "{id} inputTokens");
        assert_eq!(row.output_tokens, f(card, "outputTokens"), "{id} outputTokens");
        assert_eq!(row.cache_read_tokens, f(card, "cacheReadTokens"), "{id} cacheReadTokens");
        assert_eq!(row.cache_create_tokens, f(card, "cacheCreateTokens"), "{id} cacheCreateTokens");
        assert_eq!(row.total_llm_calls, f(card, "totalLlmCalls"), "{id} totalLlmCalls");
        assert_eq!(row.total_tool_calls, f(card, "totalToolCalls"), "{id} totalToolCalls");
        assert_eq!(row.errors, f(card, "errors"), "{id} errors");
        // The card carries the ISO rendering; the row carries the instant it is rendered from.
        let iso = s(card, "startTime");
        let expected_ms = chrono_parse_ms(&iso);
        assert_eq!(row.start_ms, expected_ms, "{id} startTime ({iso})");
    }
    let _ = std::fs::remove_dir_all(dir);
}

/// `Date.parse` for the ISO strings the summarizer emits (`…Z`, millisecond precision).
fn chrono_parse_ms(iso: &str) -> f64 {
    if iso.is_empty() {
        return 0.0;
    }
    chrono::DateTime::parse_from_rfc3339(iso).expect("the card's startTime is RFC3339").timestamp_millis() as f64
}

#[test]
fn sql_aggregates_match_the_ts_oracle_numbers() {
    let spans = fixture_spans();
    let (dir, file) = write_segment("oracle", &spans);
    let mut sql = SessionSummarySql::new();
    sql.refresh(&[file]);

    let expected: Value =
        serde_json::from_str(&std::fs::read_to_string(fixtures().join("summarize-expected.json")).expect("read"))
            .expect("the oracle parses");
    let sessions = expected.get("full").and_then(|f| f.get("sessions")).and_then(Value::as_array).expect("sessions");
    let mut checked = 0;
    for card in sessions.iter().filter(|c| c.get("source").and_then(Value::as_str) == Some("claude_code")) {
        let id = s(card, "sessionId");
        let row = sql.get(&id).unwrap_or_else(|| panic!("no SQL row for oracle session {id}"));
        assert_eq!(row.model, s(card, "model"), "{id} model");
        assert_eq!(row.input_tokens, f(card, "inputTokens"), "{id} inputTokens");
        assert_eq!(row.output_tokens, f(card, "outputTokens"), "{id} outputTokens");
        assert_eq!(row.cache_read_tokens, f(card, "cacheReadTokens"), "{id} cacheReadTokens");
        assert_eq!(row.cache_create_tokens, f(card, "cacheCreateTokens"), "{id} cacheCreateTokens");
        assert_eq!(row.total_llm_calls, f(card, "totalLlmCalls"), "{id} totalLlmCalls");
        assert_eq!(row.total_tool_calls, f(card, "totalToolCalls"), "{id} totalToolCalls");
        checked += 1;
    }
    assert_eq!(checked, 2, "the oracle fixture carries exactly two claude_code sessions");
    let _ = std::fs::remove_dir_all(dir);
}

/// The attribute reader's rules, which are where a "clever" query silently diverges: the FIRST
/// attribute with a given key wins, a number is read intValue → doubleValue → stringValue, an
/// `input_tokens: 0` falls THROUGH to the next key in `first_nonzero`'s order, and a negative
/// count clamps to zero.
#[test]
fn sql_mirrors_the_attribute_reader_rules() {
    let spans = vec![
        serde_json::json!({
            "traceId": "tz", "spanId": "root", "name": "claude_code.interaction",
            "startTime": "1755600000000000000",
            "attributes": [{ "key": "session.id", "value": { "stringValue": "sessZ" } }]
        }),
        serde_json::json!({
            "traceId": "tz", "spanId": "c1", "parentSpanId": "root", "name": "claude_code.llm_request",
            "startTime": "1755600001000000000",
            "attributes": [
                // duplicate key: the FIRST one wins (helpers::attr_value uses find, not last)
                { "key": "gen_ai.request.model", "value": { "stringValue": "first-model" } },
                { "key": "gen_ai.request.model", "value": { "stringValue": "second-model" } },
                // a zero in the leading key must fall through to `input_tokens`
                { "key": "gen_ai.usage.input_tokens", "value": { "intValue": 0 } },
                { "key": "input_tokens", "value": { "stringValue": "7" } },
                // intValue is preferred over a stringValue twin by get_attr_num
                { "key": "output_tokens", "value": { "intValue": "11" } },
                // negative counts clamp to 0
                { "key": "cache_read_tokens", "value": { "intValue": -5 } },
                // unparseable → Number(x) is NaN → 0
                { "key": "cache_creation_tokens", "value": { "stringValue": "abc" } }
            ]
        }),
        serde_json::json!({
            "traceId": "tz", "spanId": "c2", "parentSpanId": "root", "name": "claude_code.tool",
            "startTime": "1755600002000000000",
            "status": { "code": 2 },
            "attributes": [{ "key": "tool_name", "value": { "stringValue": "Read" } }]
        }),
    ];
    let (dir, file) = write_segment("rules", &spans);
    let mut sql = SessionSummarySql::new();
    sql.refresh(&[file]);
    let row = sql.get("sessZ").expect("the session row");

    // The Rust engine on the same spans, as the oracle for every one of these rules.
    let shared: Vec<Arc<Value>> = spans.into_iter().map(Arc::new).collect();
    let summary = agentlens_core::summarize::summarizer::summarize_spans(&shared, &|_| None);
    let card = summary.get("sessions").and_then(Value::as_array).expect("sessions")[0].clone();

    assert_eq!(row.model, s(&card, "model"), "first duplicate key wins");
    assert_eq!(row.model, "first-model");
    assert_eq!(row.input_tokens, f(&card, "inputTokens"), "zero falls through first_nonzero");
    assert_eq!(row.input_tokens, 7.0);
    assert_eq!(row.output_tokens, f(&card, "outputTokens"), "intValue-as-string coerces");
    assert_eq!(row.output_tokens, 11.0);
    assert_eq!(row.cache_read_tokens, f(&card, "cacheReadTokens"), "negative clamps");
    assert_eq!(row.cache_read_tokens, 0.0);
    assert_eq!(row.cache_create_tokens, f(&card, "cacheCreateTokens"), "NaN clamps");
    assert_eq!(row.cache_create_tokens, 0.0);
    assert_eq!(row.total_tool_calls, f(&card, "totalToolCalls"), "tool spans counted");
    assert_eq!(row.errors, f(&card, "errors"), "status.code 2 is an error");
    assert_eq!(row.errors, 1.0);
    let _ = std::fs::remove_dir_all(dir);
}

/// `recent_segment_files` names today's and yesterday's segments in either form, and NEVER the
/// whole store — the 24-hour boot replay is exactly what this card removes.
#[test]
fn recent_segment_files_picks_two_days_in_either_form() {
    let dir = std::env::temp_dir().join(format!("al-sessionsql-days-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create");
    // 2026-09-06T00:00:00Z — 20,702 days since the epoch, the same split `civil_from_days` does.
    let now = 20_702 * 86_400_000i64;
    for name in ["2026-09-04.ndjson", "2026-09-05.ndjson.gz", "2026-09-06.ndjson", "index.json"] {
        std::fs::write(dir.join(name), "").expect("write");
    }
    let got: Vec<String> =
        recent_segment_files(&dir, now).iter().map(|p| p.file_name().unwrap().to_string_lossy().into_owned()).collect();
    assert_eq!(got, vec!["2026-09-05.ndjson.gz".to_owned(), "2026-09-06.ndjson".to_owned()]);
    let _ = std::fs::remove_dir_all(dir);
}

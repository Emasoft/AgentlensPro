//! Parity pins for summarize::helpers (TRDD-DMWOBWFH P4d). Every expected value below was
//! COMPUTED BY NODE (the exact expressions the TS helpers evaluate), not reasoned about —
//! JS coercion is precisely where reasoning goes wrong.

use agentlens_core::summarize::helpers as h;
use serde_json::{json, Value};

fn span(attrs: Value) -> Value {
    json!({ "name": "x", "attributes": attrs })
}

#[test]
fn js_string_and_number_coercions_match_node() {
    assert_eq!(h::js_string(&json!(2.0)), "2", "String(2.0) === '2'");
    assert_eq!(h::js_string(&json!(2.5)), "2.5");
    assert_eq!(h::js_number(&json!("1.5")), 1.5, "Number('1.5') === 1.5");
    assert_eq!(h::js_number(&json!("abc")), 0.0, "Number('abc')||0 === 0");
    assert_eq!(h::js_number(&json!("")), 0.0, "Number('')||0 === 0");
}

#[test]
fn attr_accessors_follow_the_nullish_and_first_nonzero_rules() {
    let s = span(json!([
        { "key": "a", "value": { "intValue": "100" } },
        { "key": "b", "value": { "doubleValue": 2.0 } },
        { "key": "c", "value": { "stringValue": "hello" } },
        { "key": "zero", "value": { "intValue": 0 } },
        { "key": "frac", "value": { "stringValue": "1.5" } }
    ]));
    assert_eq!(h::get_attr_str(&s, "a"), "100");
    assert_eq!(h::get_attr_str(&s, "b"), "2", "double 2.0 stringifies bare");
    assert_eq!(h::get_attr_num(&s, "a"), 100.0, "string intValue coerces numerically");
    assert_eq!(h::get_attr_num(&s, "frac"), 1.5);
    assert_eq!(h::get_attr_num(&s, "missing"), 0.0);
    // First-NON-ZERO chain: a zero standard key falls through to the codex split sum.
    let t = span(json!([
        { "key": "output_tokens", "value": { "intValue": 0 } },
        { "key": "output_token_count", "value": { "intValue": 7 } },
        { "key": "reasoning_token_count", "value": { "intValue": 5 } }
    ]));
    let counts = h::extract_token_counts(&t);
    assert_eq!(counts.output, 12.0, "outputStd==0 → split-counter sum");
}

#[test]
fn nano_and_timestamp_conversions_match_node() {
    assert_eq!(h::nano_to_ms("1755504000123456789"), 1755504000123.0, "BigInt division truncates");
    assert_eq!(h::nano_to_ms("-1755504000123456789"), -1755504000123.0);
    assert_eq!(h::nano_to_ms("12.5"), 0.000012, "BigInt throws → parseInt prefix / 1e6");
    assert_eq!(h::nano_to_ms("99x"), 0.000099);
    assert_eq!(h::nano_to_ms(""), 0.0);
    assert_eq!(h::timestamp_to_ms(Some(&json!("2025-08-18T08:00:00.000Z"))), 1755504000000.0);
    assert_eq!(h::timestamp_to_ms(Some(&json!("2026-08-19T05:30:00+0200"))), 1787110200000.0);
    assert_eq!(h::timestamp_to_ms(Some(&json!("2025-08-18T08:00:00.12Z"))), 1755504000120.0, "2-digit fraction pads");
    assert_eq!(h::timestamp_to_ms(Some(&json!(42.0))), 42.0);
    assert_eq!(h::timestamp_to_ms(Some(&json!("1755504000123456789"))), 1755504000123.0, "digit string → nanos");
    assert_eq!(h::timestamp_to_ms(None), 0.0);
}

#[test]
fn extract_user_request_takes_each_branch() {
    assert_eq!(h::extract_user_request("  <userRequest> fix the bug </userRequest> tail"), "fix the bug");
    assert_eq!(h::extract_user_request("intro\n## My request for review:\ndo the thing\n"), "do the thing");
    assert_eq!(
        h::extract_user_request("<ide_selection>ctx</ide_selection> the actual ask"),
        "the actual ask",
        "IDE tags strip"
    );
    assert_eq!(h::extract_user_request("plain prompt"), "plain prompt");
}

#[test]
fn tool_arg_and_result_summaries_match_node() {
    assert_eq!(
        h::summarize_tool_args("read_file", r#"{"filePath":"/a/b/c.ts"}"#),
        "c.ts Lundefined-undefined",
        "missing lines interpolate the LITERAL 'undefined' — Node-verified"
    );
    assert_eq!(h::summarize_tool_args("grep_search", r#"{"query":"foo"}"#), "\"foo\" in *");
    assert_eq!(
        h::summarize_tool_args("manage_todo_list", r#"{"todoList":[{"status":"done"},{"status":"open"},{"status":"done"}]}"#),
        "3 items (2 done, 1 open)",
        "insertion-order status counts"
    );
    assert_eq!(h::summarize_tool_args("apply_patch", "{\"patch\":\"*** Update File: /x/y.rs\\n+line\"}"), "y.rs");
    assert_eq!(h::summarize_tool_args("bogus_tool", "not json at all"), "not json at all");
    assert_eq!(h::summarize_tool_result("t", ""), "empty");
    assert_eq!(h::summarize_tool_result("t", "short"), "short");
    assert_eq!(h::summarize_tool_result("grep_search", &format!("{} match{}", 12, "x".repeat(60))), "12 matches");
    assert_eq!(h::summarize_tool_result("t", &"x".repeat(52301)), "51.1KB", "toFixed(1) pin from Node");
    assert_eq!(h::summarize_tool_result("t", &"x".repeat(600)), "600 chars");
}

#[test]
fn path_helpers_match_the_ts_shapes() {
    assert_eq!(
        h::common_path_prefix(&["/a/b/c/d.ts".into(), "/a/b/e/f.ts".into()]),
        "/a/b"
    );
    assert_eq!(
        h::common_path_prefix(&["/a/b/file.ts".into(), "/a/b/file.ts".into()]),
        "/a/b",
        "a file-looking last segment pops"
    );
    assert_eq!(h::common_path_prefix(&["rel/x".into()]), "", "non-absolute paths are ignored");
}

#[test]
fn response_text_and_output_action_match() {
    let msgs = r#"[{"role":"assistant","content":[{"type":"text","text":"hi"},{"type":"text","text":"there"}]}]"#;
    assert_eq!(h::extract_response_text(msgs).as_deref(), Some("hi\nthere"));
    assert_eq!(h::detect_output_action(r#"[{"type":"tool_call","name":"Bash"}]"#), "called Bash");
    assert_eq!(h::detect_output_action("plain"), "text response");
    assert_eq!(h::detect_output_action(""), "unknown");
}

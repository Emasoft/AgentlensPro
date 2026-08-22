//! Cross-engine parity for the log-event sink record builder (TRDD-DMWOBWFH C2(b)): 19 cases
//! from the shared matrix (tests/fixtures/c2b-log-event-sink-case-matrix.md), each replayed through
//! both engines. Key ORDER is load-bearing (it is what JSON.stringify writes), so the assertion
//! compares serialized strings, not order-insensitive `serde_json::Value` equality.
//! After any TS change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-logeventsink-expected.mjs

use serde_json::{Map, Value};

const EXPECTED_IDS: &[&str] = &[
    "full",
    "session-fallback",
    "no-session",
    "session-empty",
    "tun-number",
    "tun-nonnumeric",
    "tun-zero",
    "tun-absent",
    "ids-empty",
    "body-kvlist",
    "body-plain-string",
    "attr-array-kvlist-bytes",
    "attr-unknown-wrapper",
    "attr-multi-wrapper",
    "attr-bad-shape",
    "attr-duplicate-key",
    "attrs-empty",
    "attr-order",
    "body-empty-string",
];

fn fixtures() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

#[test]
fn build_dropped_log_event_record_reproduces_the_ts_oracle_exactly() {
    let o: Value = serde_json::from_str(
        &std::fs::read_to_string(fixtures().join("logeventsink-expected.json")).unwrap(),
    )
    .unwrap();
    let cases = o["cases"].as_array().unwrap();

    assert_eq!(cases.len(), EXPECTED_IDS.len(), "case count must match the matrix");
    let ids: Vec<&str> = cases.iter().map(|c| c["id"].as_str().unwrap()).collect();
    assert_eq!(ids, EXPECTED_IDS, "case ids must appear in the matrix's exact order");

    for case in cases {
        let id = case["id"].as_str().unwrap();
        let name = case["name"].as_str().unwrap();
        let bare = case["bare"].as_str().unwrap();
        let attrs: Vec<Map<String, Value>> = case["attrs"]
            .as_array()
            .unwrap()
            .iter()
            .map(|a| a.as_object().unwrap().clone())
            .collect();
        let rec = case["rec"].as_object().cloned().unwrap_or_default();
        let ts = case["ts"].as_i64().unwrap();

        let got = agentlens_ingest::build_dropped_log_event_record(name, bare, &attrs, &rec, ts);
        let expected = case["expected"].as_object().unwrap();

        // Key vectors FIRST: on an order bug they name the key that moved, where the serialized
        // comparison would only print two long strings. (Ordered deliberately — the serialized
        // assert below subsumes them, so putting it first would make these two dead code.)
        let got_keys: Vec<&String> = got.keys().collect();
        let expected_keys: Vec<&String> = expected.keys().collect();
        assert_eq!(got_keys, expected_keys, "case `{id}`: top-level key order mismatch");

        if let (Some(got_attrs), Some(expected_attrs)) =
            (got.get("attrs").and_then(Value::as_object), expected.get("attrs").and_then(Value::as_object))
        {
            let got_attr_keys: Vec<&String> = got_attrs.keys().collect();
            let expected_attr_keys: Vec<&String> = expected_attrs.keys().collect();
            assert_eq!(got_attr_keys, expected_attr_keys, "case `{id}`: attrs key order mismatch");
        }

        // Then the serialized form — the assertion that also catches a VALUE difference, and the
        // only one that would notice `attrs` disappearing entirely (the key-vector check above
        // silently skips when either side has no `attrs` object).
        let got_str = serde_json::to_string(&got).unwrap();
        let expected_str = serde_json::to_string(expected).unwrap();
        assert_eq!(got_str, expected_str, "case `{id}`: serialized record mismatch (order or content)");
    }
}

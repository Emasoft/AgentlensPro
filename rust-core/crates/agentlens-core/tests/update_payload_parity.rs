//! Cross-engine parity for the update-payload derivations (TRDD-DMWOBWFH P4f): expected by the
//! COMPILED TS src/updatePayload.ts over the summarize fixture with a pinned clock
//! (tests/fixtures/gen-update-payload-expected.mjs). Regenerate after any change there:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-update-payload-expected.mjs

use agentlens_core::summarize::summarizer::summarize_spans;
use agentlens_core::update_payload::{compute_analytics_data, compute_sidebar_data, compute_sidebar_payload};
use serde_json::Value;

fn check(kind: &str, got: &Value, exp: &Value) {
    if got == exp {
        return;
    }
    let (go, eo) = (got.as_object().unwrap(), exp.as_object().unwrap());
    for (k, ev) in eo {
        assert_eq!(go.get(k), Some(ev), "{kind}.{k}");
    }
    for k in go.keys() {
        assert!(eo.contains_key(k), "{kind}: extra key {k}");
    }
    panic!("{kind} diverges but no field diff fired");
}

#[test]
fn update_payload_derivations_reproduce_the_ts_oracle_exactly() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let expected: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("update-payload-expected.json")).unwrap()).unwrap();
    let now = expected["nowMs"].as_f64().unwrap();
    // Shared spans, as the live window holds them (TRDD-HFV4AIT7).
    let spans: Vec<std::sync::Arc<Value>> =
        expected["spans"].as_array().unwrap().iter().cloned().map(std::sync::Arc::new).collect();
    let summary = summarize_spans(&spans, &|_| None);
    let sessions: Vec<Value> = summary["sessions"].as_array().unwrap().clone();

    check("full.sidebarPayload", &compute_sidebar_payload(&summary, &spans, now), &expected["full"]["sidebarPayload"]);
    check("full.sidebarData", &compute_sidebar_data(&summary), &expected["full"]["sidebarData"]);
    check("full.analyticsData", &compute_analytics_data(&sessions), &expected["full"]["analyticsData"]);

    let crafted = &expected["crafted"]["summary"];
    let crafted_spans: Vec<std::sync::Arc<Value>> =
        expected["crafted"]["spans"].as_array().unwrap().iter().cloned().map(std::sync::Arc::new).collect();
    let crafted_sessions: Vec<Value> = crafted["sessions"].as_array().unwrap().clone();
    check("crafted.sidebarPayload", &compute_sidebar_payload(crafted, &crafted_spans, now), &expected["crafted"]["sidebarPayload"]);
    check("crafted.sidebarData", &compute_sidebar_data(crafted), &expected["crafted"]["sidebarData"]);
    check("crafted.analyticsData", &compute_analytics_data(&crafted_sessions), &expected["crafted"]["analyticsData"]);

    let empty = serde_json::json!({ "sessions": [] });
    check("empty.sidebarPayload", &compute_sidebar_payload(&empty, &[], now), &expected["empty"]["sidebarPayload"]);
    check("empty.sidebarData", &compute_sidebar_data(&empty), &expected["empty"]["sidebarData"]);
    check("empty.analyticsData", &compute_analytics_data(&[]), &expected["empty"]["analyticsData"]);
}

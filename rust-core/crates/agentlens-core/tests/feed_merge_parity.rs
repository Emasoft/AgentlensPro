//! Cross-engine parity for the feed-collision doctrine (TRDD-DMWOBWFH P4g): expected by the
//! COMPILED TS feedMergePolicy.ts over crafted cards covering every branch
//! (tests/fixtures/gen-feed-merge-expected.mjs). Regenerate after any change there:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-feed-merge-expected.mjs

use agentlens_core::feed_merge::*;
use serde_json::Value;

fn arr(v: &Value) -> Vec<Value> {
    v.as_array().unwrap().clone()
}

fn check_list(kind: &str, got: &[Value], exp: &[Value]) {
    assert_eq!(got.len(), exp.len(), "{kind} length");
    for (i, (g, e)) in got.iter().zip(exp.iter()).enumerate() {
        if g == e {
            continue;
        }
        let (go, eo) = (g.as_object().unwrap(), e.as_object().unwrap());
        for (k, ev) in eo {
            assert_eq!(go.get(k), Some(ev), "{kind}[{i}].{k}");
        }
        for k in go.keys() {
            assert!(eo.contains_key(k), "{kind}[{i}]: extra key {k}");
        }
        panic!("{kind}[{i}] diverges but no field diff fired");
    }
}

#[test]
fn feed_merge_doctrine_reproduces_the_ts_oracle_exactly() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let e: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("feed-merge-expected.json")).unwrap()).unwrap();

    check_list("merged", &merge_otel_and_log_sessions(arr(&e["otel"]), arr(&e["log"])), &arr(&e["merged"]));
    check_list("mergedEmptyLog", &merge_otel_and_log_sessions(arr(&e["otel"]), vec![]), &arr(&e["mergedEmptyLog"]));
    check_list("linked", &link_subagent_transcripts(arr(&e["linkInput"])), &arr(&e["linked"]));
    let noop_in = vec![serde_json::json!({"sessionId":"x","source":"codex","dataSource":"otel","inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheCreateTokens":0,"timeline":[]})];
    check_list("linkedNoop", &link_subagent_transcripts(noop_in), &arr(&e["linkedNoop"]));

    let (log_tl, otel_tl) = (arr(&e["logTl"]), arr(&e["otelTl"]));
    check_list("grafted", &graft_otel_attribution(&log_tl, Some(&otel_tl)), &arr(&e["grafted"]));
    let none = vec![serde_json::json!({"type":"llm","spanId":"z"})];
    check_list("graftedNone", &graft_otel_attribution(&log_tl, Some(&none)), &arr(&e["graftedNone"]));
    check_list("graftedUndef", &graft_otel_attribution(&log_tl, None), &arr(&e["graftedUndef"]));

    let mut w1 = serde_json::json!({"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheCreateTokens":0,"timeline":[],"sessionId":"w","dataSource":"otel","tokensSource":"otel"});
    stamp_identity_merge(&mut w1, "log");
    assert_eq!(w1, e["identityCross"], "identity merge across feeds");
    let mut w2 = serde_json::json!({"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheCreateTokens":0,"timeline":[],"sessionId":"w","dataSource":"log","tokensSource":"log","coverageNote":"keep"});
    stamp_identity_merge(&mut w2, "log");
    assert_eq!(w2, e["identitySame"], "same-feed absorption leaves the stamp");
}

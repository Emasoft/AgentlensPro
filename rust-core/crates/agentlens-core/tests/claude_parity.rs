//! Cross-engine parity for the claude builder (TRDD-DMWOBWFH P4d): the expected output was
//! produced by the COMPILED TS builder itself (tests/fixtures/gen-claude-expected.mjs — the
//! oracle), JSON-round-tripped so undefined-valued fields are dropped exactly as the wire drops
//! them. Value equality is key-order-insensitive. Regenerate after any TS builder change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-claude-expected.mjs

use serde_json::Value;
use std::collections::HashMap;

#[test]
fn claude_builder_reproduces_the_ts_oracle_exactly() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let spans: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(dir.join("claude-spans.json")).unwrap()).unwrap();
    let expected: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("claude-expected.json")).unwrap()).unwrap();

    // Mirror spanSummarizer.ts grouping (input order preserved).
    let mut interactions: Vec<&Value> = Vec::new();
    let mut spans_by_trace_id: HashMap<String, Vec<&Value>> = HashMap::new();
    for s in &spans {
        if s.get("name").and_then(Value::as_str) == Some("claude_code.interaction") {
            interactions.push(s);
        }
        if let Some(t) = s.get("traceId").and_then(Value::as_str).filter(|t| !t.is_empty()) {
            spans_by_trace_id.entry(t.to_owned()).or_default().push(s);
        }
    }

    // The oracle ran in a fresh Node process whose callBodyRegistry is empty — |_| None mirrors it.
    let got = Value::Array(agentlens_core::summarize::claude::build_claude_sessions(
        &interactions,
        &spans_by_trace_id,
        &|_| None,
    ));
    if got != expected {
        // Name the first diverging card/field instead of dumping two blobs.
        let (g, e) = (got.as_array().unwrap(), expected.as_array().unwrap());
        assert_eq!(g.len(), e.len(), "card count");
        for (i, (gc, ec)) in g.iter().zip(e.iter()).enumerate() {
            if gc == ec {
                continue;
            }
            let (go, eo) = (gc.as_object().unwrap(), ec.as_object().unwrap());
            for key in eo.keys() {
                assert!(go.contains_key(key), "card {i}: missing key {key}");
            }
            for key in go.keys() {
                assert!(eo.contains_key(key), "card {i}: extra key {key}");
            }
            for (k, ev) in eo {
                let gv = go.get(k).expect("key checked");
                if k == "timeline" {
                    let (gt, et) = (gv.as_array().unwrap(), ev.as_array().unwrap());
                    assert_eq!(gt.len(), et.len(), "card {i} timeline length");
                    for (j, (ge, ee)) in gt.iter().zip(et.iter()).enumerate() {
                        assert_eq!(ge, ee, "card {i} timeline[{j}]");
                    }
                } else {
                    assert_eq!(gv, ev, "card {i} field {k}");
                }
            }
        }
        panic!("cards diverge but no field-level diff fired — key order artifact?");
    }
}

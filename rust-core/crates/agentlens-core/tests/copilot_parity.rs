//! Cross-engine parity for the copilot builder (TRDD-DMWOBWFH P4d): the expected output was
//! produced by the COMPILED TS builder itself (tests/fixtures/gen-copilot-expected.mjs — the
//! oracle), JSON-round-tripped so undefined-valued fields are dropped exactly as the wire drops
//! them. Value equality is key-order-insensitive, so serde map order cannot mask or fake a
//! divergence. Regenerate the expectation after any TS builder change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-copilot-expected.mjs

use serde_json::Value;
use std::collections::HashMap;

#[test]
fn copilot_builder_reproduces_the_ts_oracle_exactly() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let spans: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(dir.join("copilot-spans.json")).unwrap()).unwrap();
    let expected: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("copilot-expected.json")).unwrap()).unwrap();

    // Mirror spanSummarizer.ts grouping (input order preserved).
    let mut children_of: HashMap<String, Vec<&Value>> = HashMap::new();
    let mut invoke_agent_spans: Vec<&Value> = Vec::new();
    for s in &spans {
        if s.get("name").and_then(Value::as_str).unwrap_or("").starts_with("invoke_agent") {
            invoke_agent_spans.push(s);
        }
        if let Some(p) = s.get("parentSpanId").and_then(Value::as_str) {
            children_of.entry(p.to_owned()).or_default().push(s);
        }
    }

    let got = Value::Array(agentlens_core::summarize::copilot::build_copilot_sessions(&invoke_agent_spans, &children_of));
    if got != expected {
        // Name the first diverging card/field instead of dumping two blobs.
        let (g, e) = (got.as_array().unwrap(), expected.as_array().unwrap());
        assert_eq!(g.len(), e.len(), "card count");
        for (i, (gc, ec)) in g.iter().zip(e.iter()).enumerate() {
            if gc != ec {
                let (go, eo) = (gc.as_object().unwrap(), ec.as_object().unwrap());
                for key in eo.keys() {
                    assert!(go.contains_key(key), "card {i}: missing key {key}");
                }
                for key in go.keys() {
                    assert!(eo.contains_key(key), "card {i}: extra key {key}");
                }
                for (k, ev) in eo {
                    assert_eq!(go.get(k), Some(ev), "card {i} field {k}");
                }
            }
        }
        panic!("cards diverge but no field-level diff fired — key order artifact?");
    }
}

//! Cross-engine parity for the MCP tool SHAPERS (TRDD-DMWOBWFH P4x.2).
//!
//! The oracle feeds each shaper the SERIALIZED context the TS shaper received, so this tests the
//! SHAPER alone — the builder that produced the context is already covered by rawbodyctx_parity.
//!
//! After any TS change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-mcptools-expected.mjs

use agentlens_core::mcp_tools::get_call_context;
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcptools-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

#[test]
fn get_call_context_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, exp) in o["cases"].as_array().unwrap().iter().zip(o["results"].as_array().unwrap()) {
        let name = case["name"].as_str().unwrap();
        let args = &case["args"];
        let got = get_call_context(
            Some(&case["ctx"]),
            args["sessionId"].as_str().unwrap(),
            args.get("requestId").and_then(Value::as_str),
            args.get("spanId").and_then(Value::as_str),
        );
        assert_eq!(keys(&got), keys(exp), "{name}: key set/ORDER differs (an undefined field must be OMITTED, never null)");
        for (k, ev) in exp.as_object().unwrap() {
            assert_eq!(&got[k], ev, "{name}.{k}");
        }
    }
}

/// The block projection is a RE-PROJECTION, not a pass-through: it drops `tokenSource` and imposes
/// its own key order. Shipping the context's blocks unchanged would be a different wire shape on a
/// frozen surface, and it is the obvious "simplification" a later refactor would reach for.
#[test]
fn the_block_projection_drops_token_source_and_keeps_its_own_order() {
    let o = oracle();
    let full = o["cases"].as_array().unwrap().iter().position(|c| c["name"] == "full-context").unwrap();
    let ctx = &o["cases"][full]["ctx"];
    assert!(
        ctx["blocks"][0].get("tokenSource").is_some(),
        "the SOURCE context carries tokenSource — otherwise this test proves nothing"
    );
    let got = get_call_context(Some(ctx), "s1", Some("req-1"), None);
    let b0 = &got["blocks"][0];
    assert!(b0.get("tokenSource").is_none(), "the projection must drop tokenSource: {b0}");
    assert_eq!(keys(b0), vec!["id", "kind", "label", "tokens", "bytes", "role", "text"], "{b0}");
    // totalTokens sums the context's OWN per-block estimates rather than recounting.
    let sum: f64 = ctx["blocks"].as_array().unwrap().iter().map(|b| b["tokens"].as_f64().unwrap()).sum();
    assert_eq!(got["totalTokens"].as_f64().unwrap(), sum, "{got}");
}

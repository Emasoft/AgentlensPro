//! Cross-engine parity for the SessionStore window (TRDD-DMWOBWFH P4d): the expected output
//! was produced by the COMPILED TS class itself with a pinned clock (gen-session-store-
//! expected.mjs). Regenerate after any TS sessionStore.ts change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-session-store-expected.mjs

use agentlens_core::session_store::SessionStore;
use serde_json::Value;

const FIXED_NOW: f64 = 1_755_610_000_000.0;

#[test]
fn session_store_reproduces_the_ts_oracle_exactly() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let spans: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(dir.join("session-store-spans.json")).unwrap()).unwrap();
    let expected: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("session-store-expected.json")).unwrap()).unwrap();

    let mut store = SessionStore::new(FIXED_NOW);
    for s in &spans {
        store.add_span(s.clone(), FIXED_NOW);
    }
    let inject = vec![
        store.inject_span_attribute("t2", "s2", "gen_ai.output.messages", "[]"),
        store.inject_span_attribute("t2", "s2", "gen_ai.output.messages", "[1]"),
        store.inject_span_attribute("zz", "zz", "k", "v"),
    ];
    assert_eq!(Value::from(inject), *expected.get("inject").unwrap(), "inject results");

    let got = store.export();
    let exp = expected.get("export").unwrap();
    if &got != exp {
        assert_eq!(got.get("summary"), exp.get("summary"), "summary");
        let (gs, es) = (
            got.get("spans").unwrap().as_array().unwrap(),
            exp.get("spans").unwrap().as_array().unwrap(),
        );
        assert_eq!(gs.len(), es.len(), "retained span count");
        for (i, (g, e)) in gs.iter().zip(es.iter()).enumerate() {
            assert_eq!(g, e, "span {i}");
        }
        panic!("export diverges but no field-level diff fired");
    }
}

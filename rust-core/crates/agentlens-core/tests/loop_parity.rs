//! Cross-engine parity for the loop detector (TRDD-DMWOBWFH P4d): the expected output was
//! produced by the COMPILED TS detector itself (tests/fixtures/gen-loop-expected.mjs — the
//! oracle). Regenerate after any TS detector change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-loop-expected.mjs

use serde_json::Value;

#[test]
fn loop_detector_reproduces_the_ts_oracle_exactly() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let cards: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(dir.join("loop-cards.json")).unwrap()).unwrap();
    let expected: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(dir.join("loop-expected.json")).unwrap()).unwrap();
    assert_eq!(cards.len(), expected.len(), "fixture/expected length");

    for (i, (card, exp)) in cards.iter().zip(expected.iter()).enumerate() {
        let got = Value::Array(agentlens_core::summarize::loop_detector::detect_loop_signals(card));
        if &got != exp {
            let (g, e) = (got.as_array().unwrap(), exp.as_array().unwrap());
            assert_eq!(g.len(), e.len(), "card {i} signal count");
            for (j, (gs, es)) in g.iter().zip(e.iter()).enumerate() {
                if gs == es {
                    continue;
                }
                let (go, eo) = (gs.as_object().unwrap(), es.as_object().unwrap());
                for (k, ev) in eo {
                    assert_eq!(go.get(k), Some(ev), "card {i} signal {j} field {k}");
                }
                for key in go.keys() {
                    assert!(eo.contains_key(key), "card {i} signal {j}: extra key {key}");
                }
            }
            panic!("card {i} signals diverge but no field-level diff fired");
        }
    }
}

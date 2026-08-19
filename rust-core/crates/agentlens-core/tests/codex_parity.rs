//! Cross-engine parity for the codex builder (TRDD-DMWOBWFH P4d): the expected output was
//! produced by the COMPILED TS builder itself (tests/fixtures/gen-codex-expected.mjs — the
//! oracle), JSON-round-tripped so undefined-valued fields are dropped exactly as the wire drops
//! them. Value equality is key-order-insensitive. Regenerate after any TS builder change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-codex-expected.mjs

use serde_json::Value;

#[test]
fn codex_builder_reproduces_the_ts_oracle_exactly() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let spans: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(dir.join("codex-spans.json")).unwrap()).unwrap();
    let expected: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("codex-expected.json")).unwrap()).unwrap();

    // buildCodexSessions takes the whole span list — grouping is its own job.
    let got = Value::Array(agentlens_core::summarize::codex::build_codex_sessions(&spans));
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
                if k == "timeline" || k == "backgroundSpans" {
                    let (gt, et) = (gv.as_array().unwrap(), ev.as_array().unwrap());
                    assert_eq!(gt.len(), et.len(), "card {i} {k} length");
                    for (j, (ge, ee)) in gt.iter().zip(et.iter()).enumerate() {
                        assert_eq!(ge, ee, "card {i} {k}[{j}]");
                    }
                } else {
                    assert_eq!(gv, ev, "card {i} field {k}");
                }
            }
        }
        panic!("cards diverge but no field-level diff fired — key order artifact?");
    }
}

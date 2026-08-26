//! Cross-engine parity for the pricing logic (TRDD-DMWOBWFH P4f): calcTokenCostUsd over every
//! model in the ONE table × a bucket matrix + the id/prefix/scheduled-change edges, expected by
//! the COMPILED TS module (tests/fixtures/gen-pricing-expected.mjs). Exact f64 equality — the
//! arithmetic order is ported verbatim, so any ulp drift is a real divergence. Regenerate after
//! any pricing.ts change (and re-run `node scripts/export-pricing.js` first):
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-pricing-expected.mjs

use serde_json::Value;

#[test]
fn calc_token_cost_usd_reproduces_the_ts_oracle_exactly() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let expected: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("pricing-expected.json")).unwrap()).unwrap();
    let now_ms = expected["fixedNowMs"].as_f64().unwrap();
    let cases = expected["cases"].as_array().unwrap();
    assert!(cases.len() > 300, "the matrix covers every model: {}", cases.len());
    for c in cases {
        let f = |k: &str| c[k].as_f64().unwrap();
        let model = c["model"].as_str().unwrap();
        let at = c["at"].as_str();
        let got = agentlens_core::pricing::calc_token_cost_usd(f("i"), f("r"), f("w"), f("o"), model, f("w1h"), at, now_ms);
        let exp = f("cost");
        assert!(
            got.to_bits() == exp.to_bits() || (got == 0.0 && exp == 0.0),
            "model={model} at={at:?} i={} r={} w={} o={} w1h={}: got {got:?} expected {exp:?}",
            f("i"), f("r"), f("w"), f("o"), f("w1h")
        );
    }
}

#[test]
fn the_embedded_table_is_the_generated_artifact() {
    // A regenerated export must equal the committed file — the Rust side never carries its own
    // rates (the build's check-pricing-export enforces the same from the TS side).
    assert_eq!(agentlens_core::pricing::pricing_last_updated(), "2026-08-26");
    assert!(agentlens_core::pricing::lookup_rates("claude-opus-5", None, 0.0).is_some());
    assert!(agentlens_core::pricing::lookup_rates("no-such-model", None, 0.0).is_none());
}

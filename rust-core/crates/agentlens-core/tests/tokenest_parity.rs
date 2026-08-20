//! Cross-engine parity for the token estimator (TRDD-DMWOBWFH P4w.1b / TRDD-IQENK7JM): the
//! committed case list drives both engines. The cases are chosen as DISCRIMINATORS, not
//! coverage — `'a🎉b'` = 3 only if the walk is over UTF-16 CODE UNITS (chars() would see one
//! scalar and answer differently), and `calibrate([1,1,1], 1)` = [1,0,0] only if JS
//! `Math.round` semantics and the fold-into-largest residual both hold.
//! After any TS change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-tokenest-expected.mjs

use agentlens_core::token_estimator::{calibrate_tokens, count_tokens, estimate_tokens_from_bytes};
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/tokenest-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

#[test]
fn count_tokens_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, exp) in o["countCases"].as_array().unwrap().iter().zip(o["counts"].as_array().unwrap()) {
        let text = case.as_str().unwrap();
        assert_eq!(count_tokens(text), exp.as_f64().unwrap(), "countTokens({text:?})");
    }
}

#[test]
fn calibrate_tokens_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, exp) in o["calibrateCases"].as_array().unwrap().iter().zip(o["calibrations"].as_array().unwrap()) {
        let raw: Vec<f64> = case["raw"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        // `exact: undefined` serializes away entirely — absent means None, which is the
        // no-anchor refusal path, distinct from an explicit 0.
        let exact = case.get("exact").and_then(Value::as_f64);
        let opts = &case["opts"];
        let got = calibrate_tokens(&raw, exact, opts.get("minScale").and_then(Value::as_f64), opts.get("maxScale").and_then(Value::as_f64));
        assert_eq!(got.source, exp["source"].as_str().unwrap(), "source for {case}");
        let want: Vec<f64> = exp["tokens"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
        assert_eq!(got.tokens, want, "tokens for {case}");
    }
}

#[test]
fn bytes_estimator_matches() {
    let o = oracle();
    // The TS takes negatives; the Rust one is u64-typed by its byte-count callers, so the
    // negative case is unrepresentable there — assert the non-negative ones and note why the
    // -5 row is skipped rather than silently dropping it.
    let inputs: [i64; 7] = [0, -5, 1, 3, 4, 5, 4096];
    for (i, exp) in o["bytes"].as_array().unwrap().iter().enumerate() {
        let b = inputs[i];
        if b < 0 {
            assert_eq!(exp.as_f64().unwrap(), 0.0, "TS answers 0 for negative bytes");
            continue;
        }
        assert_eq!(estimate_tokens_from_bytes(b as u64) as f64, exp.as_f64().unwrap(), "bytes={b}");
    }
}

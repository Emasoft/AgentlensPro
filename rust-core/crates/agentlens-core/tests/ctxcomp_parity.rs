//! Cross-engine parity for the context-composition core (TRDD-DMWOBWFH P4w.1c(ii)a).
//!
//! TIME IS PINNED to the oracle's own `generatedAtMs`: the TS resolves rates with atIso undefined
//! ("today's rate"), so a future scheduled rate change would otherwise make this test start failing
//! on a day nobody touched the code.
//!
//! After any TS change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-ctxcomp-expected.mjs

use agentlens_core::context_composition_index::{
    build_call_composition, read_block_content, read_response_usage, window_size_for,
};
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ctxcomp-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn bodies_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bodies")
}

/// The oracle stores every absolute fixture path as a bare filename (committing the real one would
/// bake this machine's home directory into the repo). Apply the identical rewrite to what Rust
/// produced before comparing.
fn strip_paths(v: &Value) -> Value {
    let base = format!("{}/", bodies_dir().to_string_lossy());
    let text = serde_json::to_string(v).unwrap().replace(&base, "");
    serde_json::from_str(&text).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Compare against the oracle with an EXPLICIT key-order check: under `preserve_order` a
/// `Value::Object` is an IndexMap whose `PartialEq` ignores order, so `assert_eq!` alone would pass
/// on a reordered wire object and leave the ordering contract untested.
fn cmp(got: &Value, exp: &Value, ctx: &str) {
    if exp.is_null() {
        assert!(got.is_null(), "{ctx}: TS returned null, Rust returned {got}");
        return;
    }
    assert!(!got.is_null(), "{ctx}: TS returned a value, Rust returned null");
    if exp.is_object() {
        assert_eq!(keys(got), keys(exp), "{ctx}: key set/ORDER differs (an `undefined` field must be OMITTED, never null)");
        for (k, ev) in exp.as_object().unwrap() {
            cmp(&got[k], ev, &format!("{ctx}.{k}"));
        }
        return;
    }
    if let (Some(ga), Some(ea)) = (got.as_array(), exp.as_array()) {
        assert_eq!(ga.len(), ea.len(), "{ctx}: array length differs");
        for (i, (g, e)) in ga.iter().zip(ea).enumerate() {
            cmp(g, e, &format!("{ctx}[{i}]"));
        }
        return;
    }
    assert_eq!(got, exp, "{ctx}");
}

#[test]
fn window_size_for_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let now = o["generatedAtMs"].as_f64().unwrap();
    for (case, exp) in o["windowCases"].as_array().unwrap().iter().zip(o["windows"].as_array().unwrap()) {
        let model = case.get("model").and_then(Value::as_str);
        let betas = case.get("betas").and_then(Value::as_array);
        assert_eq!(
            window_size_for(model, betas, now),
            exp.as_f64().unwrap(),
            "windowSizeFor({model:?}, {:?}) — the 1M beta is PROOF, but its ABSENCE proves nothing; \
             the pricing table decides that case",
            case.get("betas")
        );
    }
}

#[test]
fn read_response_usage_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, exp) in o["usageCases"].as_array().unwrap().iter().zip(o["usages"].as_array().unwrap()) {
        let name = case.as_str().unwrap();
        let got = read_response_usage(bodies_dir().join(name).to_str());
        cmp(&got.unwrap_or(Value::Null), exp, &format!("readResponseUsage({name})"));
    }
}

#[test]
fn build_call_composition_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let now = o["generatedAtMs"].as_f64().unwrap();
    for (i, (case, exp)) in o["compCases"].as_array().unwrap().iter().zip(o["comps"].as_array().unwrap()).enumerate() {
        let file = case["file"].as_str().unwrap();
        let opts = &case["opts"];
        let path = bodies_dir().join(file);
        let got = build_call_composition(
            path.to_str().unwrap(),
            case["turn"].as_f64().unwrap(),
            case["ts"].as_f64().unwrap(),
            opts.get("projectHint").and_then(Value::as_str),
            opts.get("exact"),
            opts.get("modelHint").and_then(Value::as_str),
            None,
            now,
        );
        cmp(&strip_paths(&got.unwrap_or(Value::Null)), exp, &format!("buildCallComposition[{i}]({file})"));
    }
}

#[test]
fn read_block_content_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (i, (case, exp)) in o["blockCases"].as_array().unwrap().iter().zip(o["blocks"].as_array().unwrap()).enumerate() {
        let file = case["file"].as_str().unwrap();
        let path = bodies_dir().join(file);
        let got = read_block_content(
            path.to_str().unwrap(),
            case["index"].as_i64().unwrap(),
            case["full"].as_bool().unwrap(),
        );
        cmp(&strip_paths(&got.unwrap_or(Value::Null)), exp, &format!("readBlockContent[{i}]({file})"));
    }
}

/// The image drill must return metadata + a ref and NO `text` key at all — the base64 was never
/// stored and the response keeps it that way. Asserted directly rather than left implicit in the
/// oracle, because "pointer-only" is a privacy contract, not a formatting detail.
#[test]
fn image_block_drill_never_carries_text() {
    let o = oracle();
    let imgs: Vec<&Value> = o["blocks"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|b| b.get("isImage").and_then(Value::as_bool) == Some(true))
        .collect();
    assert!(!imgs.is_empty(), "oracle carries no image-block case — the contract would go untested");
    for b in imgs {
        assert!(b.get("text").is_none(), "image drill leaked a text field: {b}");
        assert!(b.get("bodyRef").is_some(), "image drill must still carry its ref: {b}");
    }
}

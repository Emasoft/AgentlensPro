//! Cross-engine parity for the session half of the composition index (TRDD-DMWOBWFH P4w.1c(ii)b):
//! buildSessionComposition, the resident/image aggregation it drives, and the registry-backed
//! sessionCompositionSummary.
//!
//! TIME IS PINNED to the oracle's `generatedAtMs` — the TS prices at "today's rate", so an
//! announced rate change would otherwise fail this test on a day nobody touched the code.
//!
//! After any TS change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-ctxsession-expected.mjs

use agentlens_core::call_body_registry::{CallBodyPointer, CallBodyRegistry};
use agentlens_core::context_composition_index::{
    build_session_composition, resolve_refs, session_composition_summary,
};
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ctxsession-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn bodies_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bodies")
}

/// The oracle stores fixture paths as bare filenames; re-absolutise for input, and strip again
/// before comparing output.
fn abs(rel: &str) -> String {
    bodies_dir().join(rel).to_string_lossy().into_owned()
}

fn strip_paths(v: &Value) -> Value {
    let base = format!("{}/", bodies_dir().to_string_lossy());
    serde_json::from_str(&serde_json::to_string(v).unwrap().replace(&base, "")).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// EXPLICIT key-order comparison: under `preserve_order` a `Value::Object` is an IndexMap whose
/// `PartialEq` ignores order, so `assert_eq!` alone would pass on a reordered wire object.
fn cmp(got: &Value, exp: &Value, ctx: &str) {
    if exp.is_null() {
        assert!(got.is_null(), "{ctx}: TS null, Rust {got}");
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

/// Rebuild the oracle's refs with absolute paths restored.
fn refs_of(case: &Value) -> Vec<Value> {
    case["refs"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| {
            let mut m = r.as_object().cloned().unwrap();
            for k in ["bodyRef", "responseRef"] {
                if let Some(s) = m.get(k).and_then(Value::as_str).map(abs) {
                    m.insert(k.into(), Value::String(s));
                }
            }
            Value::Object(m)
        })
        .collect()
}

#[test]
fn build_session_composition_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let now = o["generatedAtMs"].as_f64().unwrap();
    for (case, exp) in o["sessionCases"].as_array().unwrap().iter().zip(o["sessions"].as_array().unwrap()) {
        let id = case["sessionId"].as_str().unwrap();
        let got = build_session_composition(
            id,
            &refs_of(case),
            case.get("projectHint").and_then(Value::as_str),
            now,
        );
        cmp(&strip_paths(&got), exp, &format!("buildSessionComposition({id})"));
    }
}

/// `callsTotal` counts REFS while `calls` holds only what parsed. The gap IS the coverage-honesty
/// signal — a port that "fixed" it to `calls.len()` would silently report full coverage over a
/// session whose bodies had been purged.
#[test]
fn an_unreadable_body_is_skipped_but_still_counted() {
    let o = oracle();
    let gap = o["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|s| s["sessionId"] == "sess-gap")
        .expect("oracle lost the sess-gap case");
    assert_eq!(gap["callsTotal"], 3, "callsTotal must count refs");
    assert_eq!(gap["calls"].as_array().unwrap().len(), 2, "only parseable bodies become calls");
}

#[test]
fn session_composition_summary_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let now = o["generatedAtMs"].as_f64().unwrap();
    for (case, exp) in o["registryCases"].as_array().unwrap().iter().zip(o["summaries"].as_array().unwrap()) {
        let id = case["sessionId"].as_str().unwrap();
        // Rebuild the same registry state the generator recorded into the TS singleton.
        let mut reg = CallBodyRegistry::default();
        for p in case["pointers"].as_array().unwrap() {
            let body_ref = p.get("bodyRef").and_then(Value::as_str).unwrap_or("");
            reg.record(
                id,
                CallBodyPointer {
                    // `kind` is a &'static str on the Rust side, so map the two legal values
                    // rather than leaking the fixture's lifetime into the registry.
                    kind: if p["kind"] == "response" { "response" } else { "request" },
                    body_ref: (!body_ref.is_empty()).then(|| abs(body_ref)),
                    inline_body: None,
                    request_id: p.get("requestId").and_then(Value::as_str).map(str::to_owned),
                    span_id: p.get("spanId").and_then(Value::as_str).map(str::to_owned),
                    model: p.get("model").and_then(Value::as_str).map(str::to_owned),
                    query_source: None,
                    ts: p["ts"].as_i64().unwrap(),
                },
            );
        }
        let comp = build_session_composition(id, &resolve_refs(&reg, id), None, now);
        cmp(&strip_paths(&session_composition_summary(&comp)), exp, &format!("sessionCompositionSummary({id})"));
    }
}

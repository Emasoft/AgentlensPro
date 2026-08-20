//! Cross-engine parity for the MCP token-economy choke point (TRDD-DMWOBWFH P4x.2c).
//!
//! The expected output was produced by the COMPILED src/leanResponse.ts. Regenerate after any TS
//! change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-lean-expected.mjs
//!
//! This one is load-bearing beyond its own module: EVERY ported MCP tool's wire shape is whatever
//! this function returns. The Rust core served nine tools RAW before it landed, so each of them was
//! a different — and materially more expensive — payload than the TS it replaces.

use agentlens_core::lean_response::leanify;
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/lean-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// Point at the FIRST diverging path instead of dumping two multi-KB trees, and compare key ORDER
/// explicitly — `Value`'s PartialEq is an IndexMap comparison that IGNORES order, and order is the
/// wire contract (shapeGeneric's three passes exist only to produce it).
fn assert_deep_eq(got: &Value, exp: &Value, path: &str) {
    match (got, exp) {
        (Value::Object(g), Value::Object(e)) => {
            let gk: Vec<&String> = g.keys().collect();
            let ek: Vec<&String> = e.keys().collect();
            assert_eq!(gk, ek, "{path}: key set/ORDER differs");
            for (k, ev) in e {
                assert_deep_eq(&g[k], ev, &format!("{path}.{k}"));
            }
        }
        (Value::Array(g), Value::Array(e)) => {
            assert_eq!(g.len(), e.len(), "{path}: array length");
            for (i, (gv, ev)) in g.iter().zip(e).enumerate() {
                assert_deep_eq(gv, ev, &format!("{path}[{i}]"));
            }
        }
        _ => assert_eq!(got, exp, "{path}"),
    }
}

#[test]
fn leanify_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, exp) in o["cases"].as_array().unwrap().iter().zip(o["results"].as_array().unwrap()) {
        let name = case["name"].as_str().unwrap();
        let opts = case.get("opts").cloned().unwrap_or(Value::Null);
        let got = leanify(
            &case["result"],
            opts.get("verbosity").and_then(Value::as_str) == Some("full"),
            opts.get("maxTokens").and_then(Value::as_f64),
        );
        assert_deep_eq(&got, exp, name);
    }
}

/// The ONE ceiling note, rewritten in place. The per-iteration version was wrong twice over: the
/// intermediate lines are FALSE by the time a loop settles ("arrays → 3" when they ended at 1), and
/// a payload degraded against a 60-token ceiling came out at 203 tokens of which 7 notes WERE
/// essentially the whole payload — the function breaching its own promise with the text explaining
/// that it had not.
#[test]
fn the_ceiling_emits_exactly_one_note_and_still_fits() {
    let o = oracle();
    let idx = o["cases"].as_array().unwrap().iter().position(|c| c["name"] == "ceiling-emits-exactly-one-note").unwrap();
    let case = &o["cases"][idx];
    let got = leanify(&case["result"], false, case["opts"]["maxTokens"].as_f64());
    let notes: Vec<&str> = got["_truncated"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    let ceiling: Vec<&&str> = notes.iter().filter(|n| n.starts_with("payload exceeded")).collect();
    assert_eq!(ceiling.len(), 1, "exactly one ceiling note, not one per degradation step: {notes:?}");

    // MEASURED, and it corrects the TS comment's absolute claim ("a tool can never blow the
    // caller's context, no matter what the data looks like"). At a 60-token ceiling this payload
    // settles at 89 — the DISCLOSURE TEXT is the floor, and it cannot shrink itself. The property
    // that actually holds is: everything degradable IS degraded (arrays to 1 row, nesting elided,
    // width to 1 field), and the residue is the notes. Asserting the absolute claim would have
    // meant weakening the port to make a false statement true.
    let approx = |v: &Value| (v.to_string().chars().map(char::len_utf16).sum::<usize>() as f64 / 4.0).ceil();
    assert_eq!(got["rows"].as_array().unwrap().len(), 1, "arrays degraded as far as they go: {got}");
    assert!(got.get("_elidedKeys").is_some(), "width degraded as far as it goes: {got}");
    let notes_cost = approx(&got["_truncated"]);
    assert!(
        approx(&got) - notes_cost <= case["opts"]["maxTokens"].as_f64().unwrap(),
        "the overshoot must be the notes, not undegraded data: {got}"
    );
    // At a REALISTIC ceiling the promise does hold, which is what the backstop is actually for.
    let dflt = leanify(&case["result"], false, None);
    assert!(approx(&dflt) <= 1200.0, "default ceiling: {} tokens", approx(&dflt));
}

/// A note from an EARLIER phase (the shaper's own array-truncation line) must survive the ceiling's
/// rewrite — the ceiling replaces only its OWN line. Losing the earlier note would turn a disclosed
/// cut back into a silent one.
#[test]
fn an_earlier_phase_note_survives_the_ceiling_rewrite() {
    let o = oracle();
    let idx = o["cases"].as_array().unwrap().iter().position(|c| c["name"] == "ceiling-preserves-an-earlier-phase-note").unwrap();
    let case = &o["cases"][idx];
    let got = leanify(&case["result"], false, case["opts"]["maxTokens"].as_f64());
    let notes: Vec<&str> = got["_truncated"].as_array().unwrap().iter().filter_map(Value::as_str).collect();
    assert!(notes.iter().any(|n| n.starts_with("payload exceeded")), "{notes:?}");
    assert!(notes.iter().any(|n| n.contains("showing top")), "the shaper's own cut is still disclosed: {notes:?}");
}

/// DROP_KEYS is a DENY-list and `remediation` is deliberately NOT in it. Four tool descriptions
/// advertise remediation as part of the answer; an allow-list once deleted it silently, which is
/// precisely the failure mode deny-by-default exists to prevent.
#[test]
fn drop_keys_removes_derivation_and_keeps_remediation() {
    let o = oracle();
    let idx = o["cases"].as_array().unwrap().iter().position(|c| c["name"] == "drop-keys-removes-breakdown-but-keeps-remediation").unwrap();
    let got = leanify(&o["cases"][idx]["result"], false, None);
    assert!(got["window"].get("breakdown").is_none(), "derivation is dropped: {got}");
    assert!(got["window"].get("pctConsumed").is_some(), "its all-scalar PEER at the same depth is not: {got}");
    assert!(got.get("remediation").is_some(), "remediation is part of the answer: {got}");
}

/// `verbosity: "full"` is the escape hatch and must be byte-identical to the input — a "harmless"
/// clip there would make the deep drill unable to see what it was opened to see.
#[test]
fn verbosity_full_is_the_untouched_payload() {
    let o = oracle();
    let idx = o["cases"].as_array().unwrap().iter().position(|c| c["name"] == "verbosity-full-is-untouched").unwrap();
    let input = &o["cases"][idx]["result"];
    assert_deep_eq(&leanify(input, true, None), input, "full");
    // and the same input under the default verbosity is genuinely reduced, so the test is not
    // passing because the payload was small enough to be a no-op either way.
    let summary = leanify(input, false, None);
    assert_ne!(summary, *input, "the summary path must actually shape it");
}

//! Cross-engine parity for contextComposition.ts (TRDD-DMWOBWFH P4w.2, freeze row 32).
//!
//! Both engines read the SAME committed transcripts under fixtures/claude-home/projects/, pointed
//! at by CLAUDE_CONFIG_DIR — the one override both `claudeProjectsDirs()` implementations honour
//! identically.
//!
//! After any TS change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-ctxcomposition-expected.mjs

use agentlens_core::context_composition::{
    build_context_composition, classify_attachment, find_session_file, list_session_file_ids,
};
use agentlens_logscan::discovery::Env;
use serde_json::{Map, Value};

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ctxcomposition-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// An Env with the REAL process vars CLEARED. Inheriting them would let this machine's own
/// AGENTLENS_COMPOSITION_TEXT_BUDGET_MB (or a real CLAUDE_CONFIG_DIR) change the answer, so the
/// test would pass or fail based on the developer's shell rather than the code.
fn fixture_env() -> Env {
    let home = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/claude-home");
    let mut env = Env::from_process();
    env.vars.clear();
    env.vars.insert("CLAUDE_CONFIG_DIR".into(), home.to_string_lossy().into_owned());
    env
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// EXPLICIT key-order comparison — under `preserve_order` a `Value::Object` is an IndexMap whose
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
        assert_eq!(ga.len(), ea.len(), "{ctx}: array length differs\n  got: {got}\n  exp: {exp}");
        for (i, (g, e)) in ga.iter().zip(ea).enumerate() {
            cmp(g, e, &format!("{ctx}[{i}]"));
        }
        return;
    }
    assert_eq!(got, exp, "{ctx}");
}

#[test]
fn classify_attachment_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, exp) in o["classifyCases"].as_array().unwrap().iter().zip(o["classified"].as_array().unwrap()) {
        let got = classify_attachment(case).map_or(Value::Null, |c| {
            // Rebuild the TS return literal in ITS key order.
            let mut m = Map::new();
            m.insert("label".into(), Value::String(c.label));
            m.insert("kind".into(), Value::String(c.kind.to_owned()));
            m.insert("bytes".into(), Value::from(c.bytes));
            m.insert("text".into(), Value::String(c.text));
            Value::Object(m)
        });
        cmp(&got, exp, &format!("classifyAttachment({case})"));
    }
}

#[test]
fn build_context_composition_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let env = fixture_env();
    for (case, exp) in o["compCases"].as_array().unwrap().iter().zip(o["comps"].as_array().unwrap()) {
        let id = case["sessionId"].as_str().unwrap();
        let got = build_context_composition(&env, id, case.get("parent").and_then(Value::as_str))
            .unwrap_or(Value::Null);
        cmp(&got, exp, &format!("buildContextComposition({id})"));
    }
}

#[test]
fn session_file_resolution_matches() {
    let o = oracle();
    let env = fixture_env();
    for (id, exp) in ["comp-own", "comp-parent", "comp-many", "nope"].iter().zip(o["found"].as_array().unwrap()) {
        assert_eq!(
            find_session_file(&env, id).is_some(),
            exp.as_bool().unwrap(),
            "findSessionFile({id}) — only PRESENCE is compared; the path itself is this machine's \
             home directory and must never enter a committed fixture"
        );
    }
    let mut ids: Vec<String> = list_session_file_ids(&env).into_iter().collect();
    ids.sort();
    let want: Vec<String> = o["sessionFileIds"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_owned()).collect();
    // NOTE this indexes the WHOLE shared fixture tree, so ANY slice that adds a transcript under
    // claude-home/ changes the expected set. That is not a defect in either engine — it means the
    // oracle is stale. Regenerate BOTH gen-ctxcomposition-expected.mjs and the oracle of whichever
    // slice added the file.
    assert_eq!(
        ids, want,
        "listSessionFileIds must index every .jsonl stem and nothing else. If a slice just ADDED a \
         fixture transcript, this is a STALE ORACLE, not a port bug — re-run \
         gen-ctxcomposition-expected.mjs"
    );
}

/// The no-own-log fallback is the whole reason this module has a `reconstructedFrom` field, and
/// each of its three outcomes is a DIFFERENT product decision, so they are asserted by name rather
/// than left to blend into the bulk comparison:
///   own log present            → reconstruct from it, NO tag (even when a parent was supplied)
///   no own log, parent HAS one → reconstruct from the parent, TAGGED
///   neither, but parent known  → HONEST EMPTY, still TAGGED (a terminal truth, not a spinner)
///   neither and no parent      → null (pure OTEL/synth card)
#[test]
fn no_own_log_fallback_distinguishes_all_four_outcomes() {
    let env = fixture_env();
    let own = build_context_composition(&env, "comp-parent", Some("comp-own")).unwrap();
    assert!(own.get("reconstructedFrom").is_none(), "an own log wins and is NOT tagged: {own}");
    assert!(!own["turns"].as_array().unwrap().is_empty(), "own log must yield turns: {own}");

    let fork = build_context_composition(&env, "comp-fork", Some("comp-parent")).unwrap();
    assert_eq!(fork["reconstructedFrom"], "comp-parent");
    assert!(!fork["turns"].as_array().unwrap().is_empty(), "a fork inherits the parent's turns: {fork}");

    let known = build_context_composition(&env, "comp-known-parent", Some("no-such-parent")).unwrap();
    assert_eq!(known["reconstructedFrom"], "no-such-parent", "a known parent is a terminal truth worth returning");
    assert!(known["turns"].as_array().unwrap().is_empty());

    assert!(build_context_composition(&env, "comp-orphan", None).is_none(), "no file and no parent is the ONLY null");
}

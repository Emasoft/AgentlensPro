//! Cross-engine parity for contextHistory.ts (TRDD-DMWOBWFH P4w.2b, freeze row 33).
//!
//! After any TS change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-ctxhistory-expected.mjs

use agentlens_core::context_history::build_context_history;
use agentlens_logscan::discovery::Env;
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ctxhistory-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

/// Process vars CLEARED — this machine's real CLAUDE_CONFIG_DIR or
/// AGENTLENS_HISTORY_TEXT_BUDGET_MB would otherwise decide the answer.
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
fn build_context_history_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let env = fixture_env();
    for (case, exp) in o["cases"].as_array().unwrap().iter().zip(o["histories"].as_array().unwrap()) {
        let id = case["sessionId"].as_str().unwrap();
        let got = build_context_history(&env, id, case.get("parent").and_then(Value::as_str)).unwrap_or(Value::Null);
        cmp(&got, exp, &format!("buildContextHistory({id})"));
    }
}

/// The calibration ASYMMETRY is the module's core design decision, so it is asserted by name rather
/// than left to blend into the bulk comparison. OUTPUT blocks fully account for the turn's output
/// and calibrate at any scale; INPUT blocks exclude the cached prefix and the implicit system
/// prompt, so outside a [0.5, 2] band they must KEEP their raw estimate — scaling there would
/// misattribute invisible tokens onto visible blocks.
#[test]
fn calibration_is_asymmetric_between_input_and_output_blocks() {
    let env = fixture_env();
    let h = build_context_history(&env, "hist-main", None).unwrap();
    let step1 = &h["steps"][0];
    assert!(step1["usage"].is_object(), "the fixture's turn 1 carries usage: {step1}");
    let mut saw_input = false;
    let mut saw_output = false;
    for b in step1["blocks"].as_array().unwrap() {
        match b["role"].as_str().unwrap() {
            "input" => {
                saw_input = true;
                assert_eq!(
                    b["tokenSource"], "estimated",
                    "input blocks are structurally incomplete vs the usage total here (scale outside \
                     [0.5,2]), so they MUST keep the raw estimate: {b}"
                );
            }
            "output" => {
                saw_output = true;
                assert_eq!(b["tokenSource"], "calibrated", "output blocks calibrate at any scale: {b}");
            }
            other => panic!("unexpected role {other}"),
        }
    }
    assert!(saw_input && saw_output, "the fixture must exercise BOTH roles");

    // With no usage at all, nothing calibrates.
    let n = build_context_history(&env, "hist-nousage", None).unwrap();
    for s in n["steps"].as_array().unwrap() {
        assert!(s.get("usage").is_none(), "fixture has no usage: {s}");
        for b in s["blocks"].as_array().unwrap() {
            assert_eq!(b["tokenSource"], "estimated", "no usage ⇒ no calibration: {b}");
        }
    }
}

/// isMeta records are NOT compaction summaries. Conflating them (the old
/// `isCompactSummary || isMeta` branch) mislabeled 300+ per-turn cron pings as one ~268k-token
/// postCompact aggregate and made every turn look like a compaction boundary to the residency
/// model (TRDD-W0RRL2FZ). postCompact marks the eviction boundary; metas do not.
#[test]
fn harness_metas_are_never_labelled_post_compact() {
    let env = fixture_env();
    let h = build_context_history(&env, "hist-main", None).unwrap();
    let ids: Vec<&str> = h["steps"]
        .as_array()
        .unwrap()
        .iter()
        .flat_map(|s| s["blocks"].as_array().unwrap())
        .map(|b| b["id"].as_str().unwrap())
        .collect();
    assert!(ids.contains(&"cron:scheduled task: nightly-report"), "a fire is labelled per TASK: {ids:?}");
    assert!(ids.contains(&"cron:local-command caveat"), "{ids:?}");
    assert!(ids.contains(&"harness:meta"), "an unrecognised meta is still surfaced, never dropped: {ids:?}");
    // Exactly ONE postCompact block, from the REAL compact summary — not from any of the four metas.
    assert_eq!(
        ids.iter().filter(|i| i.starts_with("postCompact:")).count(),
        1,
        "only a real compaction summary is postCompact: {ids:?}"
    );
}

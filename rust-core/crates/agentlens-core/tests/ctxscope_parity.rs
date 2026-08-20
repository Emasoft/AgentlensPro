//! Cross-engine parity for the three SCOPED composition tools (TRDD-DMWOBWFH P4x.2c) and the
//! `resolveScope` they all sit on. Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-ctxscope-expected.mjs
//!
//! The builders are pure over a list of compositions, so the oracle feeds both engines the SAME
//! compositions — `buildSessionComposition` is already covered by ctxcomp_parity, and rebuilding it
//! here would test the engine twice and the reports not at all.

use agentlens_core::context_composition_index::{find_resident_blobs, image_report, query_blocks, resolve_scope, DEFAULT_SCOPE_CAP};
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/ctxscope-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Compare against the oracle with the key ORDER checked explicitly — `Value`'s PartialEq is an
/// IndexMap comparison that IGNORES order, and order is the wire contract.
fn assert_same(got: &Value, exp: &Value, name: &str) {
    assert_eq!(keys(got), keys(exp), "{name}: key set/ORDER differs (an absent `note` must be OMITTED, never null)");
    for (k, ev) in exp.as_object().unwrap() {
        assert_eq!(&got[k], ev, "{name}.{k}");
    }
}

fn comps_and_projects() -> (Vec<Value>, std::collections::HashMap<String, String>) {
    let o = oracle();
    let comps: Vec<Value> = o["comps"].as_array().unwrap().clone();
    let projects = comps
        .iter()
        .map(|c| (c["sessionId"].as_str().unwrap().to_owned(), c["project"].as_str().unwrap().to_owned()))
        .collect();
    (comps, projects)
}

/// `resolveScope` checks the EXACT session-id match FIRST, and that ordering is the test's point:
/// an id is also a valid `startsWith` prefix of itself, so with the checks reversed a single-session
/// drill silently widens to every session whose id shares its prefix — visible here as `sess-alpha`
/// returning both sessions instead of one.
#[test]
fn resolve_scope_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let (comps, projects) = comps_and_projects();
    let ids: Vec<&str> = comps.iter().map(|c| c["sessionId"].as_str().unwrap()).collect();
    for (case, exp) in o["scopeCases"].as_array().unwrap().iter().zip(o["scopeResults"].as_array().unwrap()) {
        let scope = case.as_str();
        let (got_ids, got_cov) = resolve_scope(&ids, scope, &|id| projects.get(id).cloned(), DEFAULT_SCOPE_CAP);
        let got_ids: Vec<Value> = got_ids.into_iter().map(Value::String).collect();
        assert_eq!(Value::Array(got_ids), exp["ids"], "resolveScope({case}).ids");
        assert_same(&got_cov, &exp["coverage"], &format!("resolveScope({case}).coverage"));
    }
    // The prefix trap, named: 'sess-' matches BOTH, 'sess-alpha' matches exactly one.
    let (wide, _) = resolve_scope(&ids, Some("sess-"), &|id| projects.get(id).cloned(), DEFAULT_SCOPE_CAP);
    let (exact, _) = resolve_scope(&ids, Some("sess-alpha"), &|id| projects.get(id).cloned(), DEFAULT_SCOPE_CAP);
    assert_eq!(wide.len(), 2, "a prefix scope is a prefix scope");
    assert_eq!(exact, vec!["sess-alpha".to_owned()], "an exact id is a SINGLE-session scope, not a prefix");
}

/// Coverage is a CLAIM the caller acts on, so a capped scan must say so IN WORDS. A `complete:
/// false` that read like a complete answer is the failure this block exists to prevent.
#[test]
fn a_capped_scope_says_sample_in_words() {
    let ids: Vec<String> = (0..40).map(|i| format!("s{i:02}")).collect();
    let refs: Vec<&str> = ids.iter().map(String::as_str).collect();
    let (scanned, cov) = resolve_scope(&refs, None, &|_| None, DEFAULT_SCOPE_CAP);
    assert_eq!(scanned.len(), DEFAULT_SCOPE_CAP, "the cap bounds the work");
    assert_eq!(cov["sessionsMatched"], 40, "and the coverage still reports the FULL match count");
    assert_eq!(cov["complete"], false);
    assert!(cov["note"].as_str().unwrap().starts_with("SAMPLE:"), "{cov}");
}

#[test]
fn image_report_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let (comps, projects) = comps_and_projects();
    let ids: Vec<&str> = comps.iter().map(|c| c["sessionId"].as_str().unwrap()).collect();
    for (case, exp) in o["imageCases"].as_array().unwrap().iter().zip(o["imageResults"].as_array().unwrap()) {
        let name = case["name"].as_str().unwrap();
        let scope = case["scope"].as_str();
        let (sel, cov) = resolve_scope(&ids, scope, &|id| projects.get(id).cloned(), DEFAULT_SCOPE_CAP);
        let picked: Vec<Value> = sel.iter().filter_map(|id| comps.iter().find(|c| c["sessionId"] == *id.as_str()).cloned()).collect();
        assert_same(&image_report(&picked, scope, cov), exp, name);
    }
}

#[test]
fn find_resident_blobs_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let (comps, projects) = comps_and_projects();
    let ids: Vec<&str> = comps.iter().map(|c| c["sessionId"].as_str().unwrap()).collect();
    for (case, exp) in o["blobCases"].as_array().unwrap().iter().zip(o["blobResults"].as_array().unwrap()) {
        let name = case["name"].as_str().unwrap();
        let scope = case["scope"].as_str();
        let fl = &case["filters"];
        let (sel, cov) = resolve_scope(&ids, scope, &|id| projects.get(id).cloned(), DEFAULT_SCOPE_CAP);
        let picked: Vec<Value> = sel.iter().filter_map(|id| comps.iter().find(|c| c["sessionId"] == *id.as_str()).cloned()).collect();
        let got = find_resident_blobs(
            &picked,
            scope,
            cov,
            fl.get("kind").and_then(Value::as_str),
            fl.get("minTokens").and_then(Value::as_f64),
            fl.get("minResidentTurns").and_then(Value::as_f64),
            fl.get("topN").and_then(Value::as_f64),
        );
        assert_same(&got, exp, name);
    }
}

/// `topN` is CLAMPED to [1, 100]. Both ends matter: 0 would return an EMPTY list that reads as "no
/// resident blobs" (the opposite of the truth), and an unbounded high value is a caller pulling an
/// arbitrarily large list into their own transcript — the cost the whole lean layer exists to bound.
#[test]
fn top_n_is_clamped_at_both_ends() {
    let (comps, _) = comps_and_projects();
    let cov = Value::Object(serde_json::Map::new());
    let n = |top: f64| {
        find_resident_blobs(&comps, None, cov.clone(), None, None, None, Some(top))["blobs"].as_array().unwrap().len()
    };
    assert_eq!(n(0.0), 1, "0 clamps UP to 1 — an empty list would read as 'nothing resident'");
    assert_eq!(n(-5.0), 1, "and so does a negative");
    let all = n(9999.0);
    assert_eq!(all, n(100.0), "9999 clamps DOWN to 100 (the fixture has fewer, so both return everything)");
}

#[test]
fn query_blocks_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let (comps, projects) = comps_and_projects();
    let ids: Vec<&str> = comps.iter().map(|c| c["sessionId"].as_str().unwrap()).collect();
    for (case, exp) in o["queryCases"].as_array().unwrap().iter().zip(o["queryResults"].as_array().unwrap()) {
        let name = case["name"].as_str().unwrap();
        let filter = &case["filter"];
        // The TS scopes queryBlocks by `sessionId ?? project`.
        let scope = filter.get("sessionId").and_then(Value::as_str).or_else(|| filter.get("project").and_then(Value::as_str));
        let (sel, cov) = resolve_scope(&ids, scope, &|id| projects.get(id).cloned(), DEFAULT_SCOPE_CAP);
        let picked: Vec<Value> = sel.iter().filter_map(|id| comps.iter().find(|c| c["sessionId"] == *id.as_str()).cloned()).collect();
        let got = query_blocks(&picked, filter, case["groupBy"].as_str().unwrap(), cov, 1_760_000_000_000.0);
        assert_same(&got, exp, name);
    }
}

/// `model` is matched by SUBSTRING. The obvious query is "opus", and an equality check against the
/// full model id would return NOTHING for it while still answering successfully — a wrong answer
/// that looks like a correct empty one.
#[test]
fn the_model_filter_is_a_substring_match() {
    let (comps, _) = comps_and_projects();
    let cov = Value::Object(serde_json::Map::new());
    let q = |m: &str| {
        let f = serde_json::json!({ "model": m });
        query_blocks(&comps, &f, "session", cov.clone(), 1_760_000_000_000.0)["groups"].as_array().unwrap().len()
    };
    assert_eq!(q("opus"), 1, "the short name selects the opus session");
    assert_eq!(q("claude-opus-5"), 1, "and so does the full id");
    assert_eq!(q("claude"), 2, "a shared substring selects both");
    assert_eq!(q("gpt"), 0, "and a non-match selects none");
}

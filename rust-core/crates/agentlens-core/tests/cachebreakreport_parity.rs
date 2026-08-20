//! Cross-engine parity for `get_cache_break_report` (TRDD-DMWOBWFH P4x.2d). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-cachebreakreport-expected.mjs

use std::collections::HashSet;

use agentlens_core::mcp_tools::get_cache_break_report;
use serde_json::{json, Value};

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cachebreakreport-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract `assert_eq!` cannot see (`preserve_order` makes `Value::Object` an
/// IndexMap whose `PartialEq` ignores order). It matters twice here: `block` is a `?? null` key that
/// must be PRESENT while the engine's `breakSourceLabel` is absent, and `topOffenders` is built by a
/// spread whose overwrite of an existing key must keep that key's ORIGINAL position.
fn same(got: &Value, exp: &Value, label: &str) {
    assert_eq!(keys(got), keys(exp), "{label}: key set/ORDER differs\n  got={got}\n  exp={exp}");
    match exp {
        Value::Object(o) => {
            for (k, ev) in o {
                same(&got[k], ev, &format!("{label}.{k}"));
            }
        }
        Value::Array(ea) => {
            let ga = got.as_array().cloned().unwrap_or_default();
            assert_eq!(ga.len(), ea.len(), "{label}: length\n  got={got}");
            for (i, (g, e)) in ga.iter().zip(ea).enumerate() {
                same(g, e, &format!("{label}[{i}]"));
            }
        }
        _ => assert_eq!(got, exp, "{label}"),
    }
}

/// Hardcoded rather than scanned, so this suite is not coupled to every OTHER fixture transcript
/// under claude-home/ (adding one there already breaks ctxcomposition_parity). Only ids that appear
/// as session cards can affect the pool, so the two unused transcripts there are irrelevant.
fn file_ids() -> HashSet<String> {
    ["comp-many", "comp-own", "conv-main", "comp-parent"].iter().map(|s| (*s).to_owned()).collect()
}

const BUDGET_MS: f64 = 20_000.0;

fn run(o: &Value, args: Value, accessor: bool) -> Value {
    let sessions = o["sessions"].as_array().cloned().unwrap_or_default();
    let now = 0.0; // only reaches lookupRates' scheduled-change branch; the oracle froze the clock
    let comp = |id: &str| o["compositions"].get(id).filter(|v| !v.is_null()).cloned();
    let timeline_of = |c: &Value| -> Vec<Value> {
        let id = c.get("sessionId").and_then(Value::as_str).unwrap_or_default();
        o["timelines"].get(id).and_then(Value::as_array).cloned().unwrap_or_default()
    };
    get_cache_break_report(&sessions, &file_ids(), &args, accessor.then_some(&comp as &dyn Fn(&str) -> Option<Value>), &timeline_of, now, BUDGET_MS)
}

#[test]
fn get_cache_break_report_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    same(&run(&o, json!({}), false), &o["noAccessor"], "noAccessor");
    for (case, args) in [
        ("bySession", json!({"sessionId": "comp-many"})),
        ("bySessionMissing", json!({"sessionId": "nope"})),
        ("bySessionNoComposition", json!({"sessionId": "conv-main"})),
        ("bySessionSingleTurn", json!({"sessionId": "comp-own"})),
        ("all", json!({})),
        ("scoped", json!({"workspace": "/w/alpha"})),
        ("blankScope", json!({"workspace": "   "})),
        ("noMatch", json!({"workspace": "/w/nowhere"})),
        ("byIdFragment", json!({"workspace": "comp-many"})),
    ] {
        same(&run(&o, args, true), &o[case], case);
    }
}

/// THE SECOND DOUBLE-GUARD VARIANT. One argument, one TRIMMED value, used as BOTH the truthy filter
/// guard and the `?? 'all'` echo — so `"   "` narrows nothing and reports `""`. Not `"all"` (that is
/// what an ABSENT arg gives) and not `"   "` (that is what get_context_inflation_report gives for
/// the very same input, because it echoes the RAW arg). Three call sites, three answers, one input.
#[test]
fn a_blank_workspace_filters_nothing_and_echoes_the_trimmed_empty_string() {
    let o = oracle();
    let blank = run(&o, json!({"workspace": "   "}), true);
    assert_eq!(blank["scope"], "", "TRIMMED echo — not 'all', and not the raw '   '");
    let all = run(&o, json!({}), true);
    assert_eq!(all["scope"], "all", "only an ABSENT workspace reads 'all'");
    assert_eq!(blank["sessionsConsidered"], all["sessionsConsidered"], "the truthy guard narrows nothing");
    assert_eq!(blank["sessionsAnalyzed"], all["sessionsAnalyzed"]);
}

/// The pool matches a workspace PREFIX ONLY — no sessionId substring, unlike find_context_hogs, and
/// capped at 20 rather than 25. A shared hardcoded predicate silently over-matches: a session would
/// be reparsed merely because its id happened to contain the workspace string.
#[test]
fn the_scope_matches_a_workspace_prefix_only() {
    let o = oracle();
    assert_eq!(run(&o, json!({"workspace": "comp-many"}), true)["sessionsConsidered"], 0);
    assert_eq!(run(&o, json!({"workspace": "/w/alpha"}), true)["sessionsConsidered"], 4);
}

/// The three pool counts answer three different questions, and conflating them is what makes a 0
/// result unexplainable: `considered` is every scope-matched card, `withLog` only those with a local
/// transcript, `analyzed` only those that actually produced a report. A single-turn session and a
/// session with no composition are both pooled and scanned but NOT analyzed — that gap is the
/// diagnosis, so it has to survive into the payload rather than being smoothed away.
#[test]
fn considered_with_log_and_analyzed_are_three_different_numbers() {
    let o = oracle();
    let all = run(&o, json!({}), true);
    assert_eq!(all["sessionsConsidered"], 5, "every card, including the one with no .jsonl");
    assert_eq!(all["sessionsWithLog"], 4, "no-log-here is dropped by the file-backed filter");
    assert_eq!(all["sessionsAnalyzed"], 2, "comp-own (1 turn) and conv-main (no composition) yield no report");
}

/// `block: t.breakSourceLabel ?? null` KEEPS its key as null, while the ENGINE's own
/// `breakSourceLabel` is DROPPED when absent. Same datum, two deliberately different wire contracts
/// — a port that reuses one rule for both silently changes the shape the janitor CLI consumes.
#[test]
fn the_break_row_keeps_a_null_block_key() {
    let o = oracle();
    let one = run(&o, json!({"sessionId": "comp-many"}), true);
    let b = &one["breaks"][0];
    assert_eq!(keys(b), ["turn", "cause", "block", "wastedTokens", "wastedCostUsd", "remediation"], "{b}");
    assert!(!b["remediation"].as_str().unwrap().is_empty());
}

/// `{...o, wastedCostUsd: +o.wastedCostUsd.toFixed(4)}` — overwriting an EXISTING key keeps that
/// key's original position, so the offender must stay in engine order. Appending the rounded value
/// instead would move `wastedCostUsd` to the end and still compare equal by value.
#[test]
fn rounding_an_offender_does_not_reorder_it() {
    let o = oracle();
    let one = run(&o, json!({"sessionId": "comp-many"}), true);
    let off = &one["topOffenders"][0];
    assert_eq!(keys(off), ["label", "kind", "cause", "occurrences", "wastedTokens", "wastedCostUsd"], "{off}");
    // A NUMBER, not the string `toFixed` returns.
    assert!(off["wastedCostUsd"].is_number(), "{off}");
}

/// An ALREADY-ELAPSED budget stops before the first pooled session: nothing analyzed, and the
/// payload SAYS it is a sample instead of presenting an empty leaderboard as a finding.
///
/// PARITY GAP, stated rather than hidden: the TS handler hardcodes `DRILL_SCAN_TIME_BUDGET_MS`
/// internally (it is not a parameter), so this branch cannot be driven from the oracle and the note
/// text below is checked against the TS source line, not against a generated fixture. The Rust side
/// takes the budget as an argument precisely so the caller — and this test — can reach it.
#[test]
fn an_elapsed_scan_budget_stops_before_the_first_session() {
    let o = oracle();
    let sessions = o["sessions"].as_array().cloned().unwrap_or_default();
    let comp = |id: &str| o["compositions"].get(id).filter(|v| !v.is_null()).cloned();
    let timeline_of = |c: &Value| -> Vec<Value> {
        let id = c.get("sessionId").and_then(Value::as_str).unwrap_or_default();
        o["timelines"].get(id).and_then(Value::as_array).cloned().unwrap_or_default()
    };
    let got = get_cache_break_report(&sessions, &file_ids(), &json!({}), Some(&comp), &timeline_of, 0.0, -1.0);
    assert_eq!(got["sessionsAnalyzed"], 0, "{got}");
    assert_eq!(got["scanStoppedEarly"], true);
    assert_eq!(
        got["scanNote"],
        "SAMPLE: the -0.001s scan budget stopped after 0 of 4 pooled sessions — retry to widen (reparsed timelines are cached)."
    );
    // The counts still tell the truth about what WAS in the pool — a stopped scan is not an empty one.
    assert_eq!(got["sessionsConsidered"], 5);
    assert_eq!(got["sessionsWithLog"], 4);
    // The key stays in its literal position: after sessionsAnalyzed, before topOffenders.
    assert_eq!(
        keys(&got),
        ["scope", "sessionsConsidered", "sessionsWithLog", "sessionsAnalyzed", "scanStoppedEarly", "scanNote", "topOffenders"],
        "{got}"
    );
}

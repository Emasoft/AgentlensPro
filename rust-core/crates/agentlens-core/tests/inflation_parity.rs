//! Cross-engine parity for `get_context_inflation_report` (TRDD-DMWOBWFH P4x.2d). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-inflation-expected.mjs

use std::collections::HashSet;

use agentlens_core::mcp_tools::get_context_inflation_report;
use serde_json::{json, Value};

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/inflation-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract `assert_eq!` cannot see (`preserve_order` makes `Value::Object` an
/// IndexMap whose `PartialEq` ignores order). Asserted explicitly, recursing into nested objects and
/// arrays so every row and every topBlock's field order is covered.
fn same(got: &Value, exp: &Value, label: &str) {
    assert_eq!(keys(got), keys(exp), "{label}: key set/ORDER differs");
    if let Some(o) = exp.as_object() {
        for (k, ev) in o {
            if ev.is_object() {
                same(&got[k], ev, &format!("{label}.{k}"));
            } else if let Some(ea) = ev.as_array() {
                let ga = got[k].as_array().cloned().unwrap_or_default();
                assert_eq!(ga.len(), ea.len(), "{label}.{k}: length");
                for (i, (g, e)) in ga.iter().zip(ea).enumerate() {
                    if e.is_object() {
                        same(g, e, &format!("{label}.{k}[{i}]"));
                    } else {
                        assert_eq!(g, e, "{label}.{k}[{i}]");
                    }
                }
            } else {
                assert_eq!(&got[k], ev, "{label}.{k}");
            }
        }
    }
}

/// Hardcoded rather than scanned, so this suite is not coupled to every OTHER fixture transcript
/// under claude-home/ (adding one there already breaks ctxcomposition_parity).
fn file_ids() -> HashSet<String> {
    ["comp-many", "comp-own", "comp-parent"].iter().map(|s| (*s).to_owned()).collect()
}

fn run(o: &Value, args: Value) -> Value {
    let sessions = o["sessions"].as_array().cloned().unwrap_or_default();
    let comp = |id: &str| o["compositions"].get(id).filter(|v| !v.is_null()).cloned();
    let hist = |id: &str| o["histories"].get(id).filter(|v| !v.is_null()).cloned();
    get_context_inflation_report(&sessions, &file_ids(), &args, &comp, &hist)
}

#[test]
fn get_context_inflation_report_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, args) in [
        ("all", json!({})),
        ("scoped", json!({"workspace": "/w/alpha"})),
        ("blankScope", json!({"workspace": "   "})),
        ("noMatch", json!({"workspace": "/w/nowhere"})),
        ("oneSession", json!({"sessionId": "comp-many"})),
        ("oneNoSteps", json!({"sessionId": "comp-own"})),
        ("oneNoComposition", json!({"sessionId": "comp-parent"})),
    ] {
        same(&run(&o, args), &o[case], case);
    }
}

/// THE THIRD DOUBLE-GUARD VARIANT, and the reason each site must be asserted rather than assumed.
/// One argument, two guards, different operators: the pool filter uses the TRIMMED value under a
/// truthy test (so "   " narrows nothing), while the echo is `args.workspace ?? 'all'` on the RAW,
/// UNTRIMMED arg (so it reports "   "). Not "all" — and not "" either, which is what
/// find_context_hogs returns for the very same input. Three call sites, three answers, one input.
#[test]
fn a_blank_workspace_filters_nothing_and_echoes_the_raw_untrimmed_value() {
    let o = oracle();
    let blank = run(&o, json!({"workspace": "   "}));
    assert_eq!(blank["scope"], "   ", "NULLISH echo of the RAW arg — not 'all', not ''");
    assert_eq!(blank["sessionsScanned"], run(&o, json!({}))["sessionsScanned"], "TRUTHY filter: it narrows nothing");
    assert_eq!(run(&o, json!({}))["scope"], "all", "only an ABSENT workspace reads 'all'");
}

/// The pool matches a workspace PREFIX ONLY here — no sessionId substring, unlike find_context_hogs
/// — and caps at 20, not 25. A shared hardcoded predicate silently over-matches: a session would be
/// scanned merely because its id happened to contain the workspace string.
#[test]
fn the_scope_matches_a_workspace_prefix_only() {
    let o = oracle();
    let by_id = run(&o, json!({"workspace": "comp-own"}));
    assert_eq!(by_id["sessionsConsidered"], 0, "a session-id fragment is NOT a scope here: {by_id}");
    assert_eq!(run(&o, json!({"workspace": "/w/alpha"}))["sessionsConsidered"], 3);
}

/// `runawaySources` requires BOTH halves — turnsPresent >= 5 AND peakTokens >= 1000 — because each
/// alone names the wrong thing. The fixture carries a decoy for each: `paste` is huge but appears in
/// ONE turn (a one-off, not a structural sink), and `ponytail` rides SIX turns at 200 tokens (not
/// worth moving). Only CLAUDE.md, which is both, is a runaway.
#[test]
fn a_runaway_needs_both_many_turns_and_a_heavy_peak() {
    let o = oracle();
    let got = run(&o, json!({}));
    let names: Vec<&str> = got["runawaySources"].as_array().unwrap().iter().map(|r| r["label"].as_str().unwrap()).collect();
    assert_eq!(names, vec!["CLAUDE.md"], "{names:?}");
    // Both decoys ARE present as contributors — they are excluded from runaway, not from the report.
    let top: Vec<&str> = got["topContributors"].as_array().unwrap().iter().map(|r| r["label"].as_str().unwrap()).collect();
    assert!(top.contains(&"paste") && top.contains(&"ponytail"), "{top:?}");
}

/// `peakTokens` folds with MAX across sessions and turns while cumulative and turnsPresent SUM.
/// Mixing them up turns a per-turn peak into a total — and the runaway threshold reads peakTokens,
/// so the error would silently reclassify every large-cumulative source as a runaway.
#[test]
fn peak_folds_with_max_while_cumulative_and_turns_sum() {
    let o = oracle();
    let got = run(&o, json!({}));
    let md = got["topContributors"].as_array().unwrap().iter().find(|r| r["label"] == "CLAUDE.md").unwrap();
    assert_eq!(md["peakTokens"], 9000, "the single 9,000 turn, NOT the sum: {md}");
    assert_eq!(md["cumulativeTokens"], 33000, "{md}");
    assert_eq!(md["turnsPresent"], 6, "5 turns in comp-many + 1 in comp-own: {md}");
}

/// `considered`/`withLog` DEFAULT TO 1 on the single-session path — a drill reports 1/1 rather than
/// claiming it considered nothing. And `residentCost` is SESSION-SCOPED ONLY: null on workspace
/// scope (deliberately not computed), an explicit {message} when there is no transcript to itemize,
/// and the full itemization otherwise. A silent null in the no-transcript case would read as
/// "nothing resident" instead of "not computable".
#[test]
fn resident_cost_is_session_scoped_and_states_its_absence() {
    let o = oracle();
    let ws = run(&o, json!({}));
    assert_eq!(ws["sessionsConsidered"], 4, "workspace scope counts the real pool");
    assert_eq!(ws["residentCost"], Value::Null, "not computed on workspace scope");

    let one = run(&o, json!({"sessionId": "comp-many"}));
    assert_eq!((one["sessionsConsidered"].as_f64(), one["sessionsWithLog"].as_f64()), (Some(1.0), Some(1.0)));
    assert!(one["residentCost"]["itemizedResidentTokens"].is_number(), "{}", one["residentCost"]);

    let no_steps = run(&o, json!({"sessionId": "comp-own"}));
    assert!(no_steps["residentCost"]["message"].as_str().unwrap().contains("No local transcript"), "{}", no_steps["residentCost"]);

    // No composition at all is the EARLY return — a two-key object, with no residentCost key at all.
    let none = run(&o, json!({"sessionId": "comp-parent"}));
    assert_eq!(keys(&none), ["sessionId", "message"], "{none}");
}

/// Each topBlock is `{...b, drill}` — the spread first, so `drill` appends LAST — and the drill
/// pointer is what makes the itemization actionable: it names the exact
/// get_context_history(sessionId, turn, blockId) call that returns the block's full text.
#[test]
fn each_top_block_carries_a_trailing_drill_pointer() {
    let o = oracle();
    let one = run(&o, json!({"sessionId": "comp-many"}));
    let b = &one["residentCost"]["topBlocks"][0];
    assert_eq!(*keys(b).last().unwrap(), "drill", "{:?}", keys(b));
    assert_eq!(b["drill"]["tool"], "get_context_history");
    assert_eq!(b["drill"]["sessionId"], "comp-many");
    assert_eq!(b["drill"]["turn"], b["firstSeenTurn"], "the drill points at the block's FIRST occurrence");
    assert_eq!(b["drill"]["blockId"], b["id"]);
}

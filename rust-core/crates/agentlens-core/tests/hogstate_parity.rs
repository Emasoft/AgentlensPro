//! Cross-engine parity for `find_context_hogs`, `get_account_state_at` and the shared
//! buildScanCoverage / resolveStateAt engines (TRDD-DMWOBWFH P4x.2d). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-hogstate-expected.mjs

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use agentlens_core::account_state_timeline::{read_timeline, resolve_state_at};
use agentlens_core::mcp_tools::{build_scan_coverage, find_context_hogs, get_account_state_at, HOG_SCAN_CAP};
use serde_json::{json, Value};

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn oracle() -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join("hogstate-expected.json")).unwrap()).unwrap()
}

fn state_log() -> PathBuf {
    fixtures().join("acct-state.ndjson")
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract `assert_eq!` cannot see (under `preserve_order` a `Value::Object` is
/// an IndexMap whose `PartialEq` ignores order), so it is asserted explicitly, one level deep.
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
                    same(g, e, &format!("{label}.{k}[{i}]"));
                }
            } else {
                assert_eq!(&got[k], ev, "{label}.{k}");
            }
        }
    }
}

/// The file-id set the TS gets from `listSessionFileIds()` over fixtures/claude-home. Hardcoding the
/// three ids the fixture cards name (rather than scanning) keeps this suite from being coupled to
/// every OTHER fixture transcript under claude-home/ — adding one there already breaks
/// ctxcomposition_parity, and it must not break this one too.
fn file_ids() -> HashSet<String> {
    ["comp-many", "comp-own", "comp-parent"].iter().map(|s| (*s).to_owned()).collect()
}

/// The same deterministic stand-in the oracle injects. `comp-parent` returns None, so it is pooled
/// and opened but NOT counted as scanned — which is exactly what turns coverage into a SAMPLE.
fn compositions(o: &Value) -> impl Fn(&str) -> Option<Value> + '_ {
    move |id: &str| o["compositions"].get(id).filter(|v| !v.is_null()).cloned()
}

fn run(o: &Value, args: Value) -> Value {
    let sessions = o["sessions"].as_array().cloned().unwrap_or_default();
    find_context_hogs(&sessions, &file_ids(), &args, &compositions(o))
}

#[test]
fn find_context_hogs_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    same(&run(&o, json!({})), &o["hogsAll"], "hogsAll");
    same(&run(&o, json!({"scope": "/w/alpha"})), &o["hogsScoped"], "hogsScoped");
    same(&run(&o, json!({"scope": "comp-own"})), &o["hogsById"], "hogsById");
    same(&run(&o, json!({"scope": "/w/nowhere"})), &o["hogsNoMatch"], "hogsNoMatch");
    assert_eq!(HOG_SCAN_CAP as f64, o["hogScanCap"].as_f64().unwrap());
}

/// THREE counts, three different facts: in scope, has a transcript ON DISK, and actually
/// reconstructible. The fixture makes all three differ (4 / 3 / 2) because collapsing any pair is
/// how a bounded scan starts reading as full history — a card with no local log is not a card that
/// was checked and found clean.
#[test]
fn considered_with_log_and_scanned_are_three_different_numbers() {
    let o = oracle();
    let got = run(&o, json!({}));
    assert_eq!(
        (got["sessionsConsidered"].as_f64(), got["sessionsWithLog"].as_f64(), got["sessionsScanned"].as_f64()),
        (Some(4.0), Some(3.0), Some(2.0)),
        "{got}"
    );
    // comp-parent is pooled and opened but yields no composition, so coverage is a SAMPLE.
    assert_eq!(got["coverage"]["complete"], false, "{}", got["coverage"]);
    assert!(got["coverage"]["note"].as_str().unwrap().starts_with("SAMPLE"), "{}", got["coverage"]);
}

/// A scope matches a workspace PREFIX **or** a sessionId SUBSTRING, so a bare id fragment is a valid
/// scope.
///
/// And `scope?.trim()` is guarded TWICE with DIFFERENT operators, which disagree on exactly the
/// whitespace case: the pool filter is TRUTHY (`scope ? … : null`, so "" is no scope at all) while
/// the echo is NULLISH (`scope ?? 'all'`, so "" survives as ""). An all-whitespace scope therefore
/// filters NOTHING yet reports itself as `""` — not as `"all"`. The oracle caught this; collapsing
/// the two guards into one Option (either way) is wrong.
#[test]
fn scope_matches_workspace_prefix_or_session_substring_and_blank_means_none() {
    let o = oracle();
    same(&run(&o, json!({"scope": "   "})), &o["hogsBlankScope"], "hogsBlankScope");
    let blank = run(&o, json!({"scope": "   "}));
    assert_eq!(blank["scope"], "", "NULLISH echo: the empty trim survives, it does not become 'all'");
    assert_eq!(run(&o, json!({}))["scope"], "all", "an ABSENT scope is the only one that reads 'all'");
    assert_eq!(blank["hogs"], run(&o, json!({}))["hogs"], "TRUTHY filter: whitespace must not narrow anything");
    let by_id = run(&o, json!({"scope": "comp-own"}));
    assert_eq!(by_id["sessionsConsidered"], 1, "a bare id fragment is a scope: {by_id}");
    assert_eq!(by_id["scope"], "comp-own");
}

/// One source is summed ACROSS the turns it persists in — that is the whole "turns × per-turn
/// weight" inflation view. `sessions` and `occurrences` must therefore DIVERGE: CLAUDE.md appears in
/// 2 sessions but 5 turns. A port that conflated them would look correct on a single-turn fixture.
#[test]
fn a_source_is_summed_across_turns_not_across_sessions() {
    let o = oracle();
    let got = run(&o, json!({}));
    let md = got["hogs"].as_array().unwrap().iter().find(|h| h["label"] == "CLAUDE.md").unwrap();
    assert_eq!((md["sessions"].as_f64(), md["occurrences"].as_f64()), (Some(2.0), Some(5.0)), "{md}");
    assert_eq!(md["cumulativeTokens"], 25000, "5 turns × 5,000: {md}");
}

/// `Math.min(topN ?? 15, 50)` is an UPPER clamp ONLY — a 0 returns nothing rather than flooring to
/// 1 (the opposite convention from loadedPluginVersions' `Math.max(1, topN)`, which is why each is
/// asserted rather than assumed). `hogsTruncated` is what tells the reader the list was cut.
#[test]
fn top_n_clamps_upward_only_and_truncation_is_labelled() {
    let o = oracle();
    same(&run(&o, json!({"topN": 1})), &o["hogsTop1"], "hogsTop1");
    same(&run(&o, json!({"topN": 0})), &o["hogsTop0"], "hogsTop0");
    same(&run(&o, json!({"topN": 999})), &o["hogsTop999"], "hogsTop999");
    let zero = run(&o, json!({"topN": 0}));
    assert_eq!(zero["returnedHogs"], 0, "0 is honoured, not floored to 1: {zero}");
    assert_eq!(zero["hogsTruncated"], true, "and the truncation is disclosed: {zero}");
    assert_eq!(run(&o, json!({"topN": 999}))["hogsTruncated"], false);
}

/// Three DIFFERENT notes — nothing-to-scan, complete, and SAMPLE. They are three different facts,
/// and collapsing them lets an empty result read as a clean bill of health.
#[test]
fn build_scan_coverage_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    same(&build_scan_coverage(3.0, 3.0, 3.0, 25.0), &o["coverageComplete"], "coverageComplete");
    same(&build_scan_coverage(4.0, 0.0, 0.0, 25.0), &o["coverageEmpty"], "coverageEmpty");
    same(&build_scan_coverage(40.0, 30.0, 25.0, 25.0), &o["coverageSample"], "coverageSample");
    assert!(o["coverageEmpty"]["complete"].as_bool().unwrap(), "nothing to scan IS complete coverage");
    assert!(o["coverageEmpty"]["note"].as_str().unwrap().contains("No log-backed sessions"));
}

/// The reader drops a TORN line and a record with a non-numeric `ts` INDIVIDUALLY — one bad record
/// must not discard the history around it, and the binary search below is only sound on a dated
/// list. A missing file is an EMPTY timeline, never an error: a first run is not a failure.
#[test]
fn read_timeline_skips_bad_records_individually() {
    let o = oracle();
    let got = read_timeline(&state_log());
    let exp = o["timeline"].as_array().unwrap();
    assert_eq!(got.len(), exp.len(), "the fixture has 6 lines, 4 valid records: {got:?}");
    for (i, (g, e)) in got.iter().zip(exp).enumerate() {
        same(g, e, &format!("timeline[{i}]"));
    }
    assert!(read_timeline(Path::new("/nonexistent/nope.ndjson")).is_empty(), "a missing file is empty, not an error");
}

/// `records[mid].ts <= ts` — the boundary is INCLUSIVE, so querying exactly a record's timestamp
/// resolves to that record rather than the one before it.
#[test]
fn resolve_state_at_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let at = |k: &str| crate_parse(o["isoCases"][k].as_str().unwrap());
    assert_eq!(resolve_state_at(at("mid"), &state_log()), o["resolveMid"].as_object().map(|_| o["resolveMid"].clone()));
    assert_eq!(resolve_state_at(at("before"), &state_log()), None, "before the timeline starts");
    let first = resolve_state_at(at("first"), &state_log()).expect("inclusive boundary");
    assert_eq!(first["ts"], 1785540000000i64, "exactly the first record's ts resolves TO it");
}

fn crate_parse(iso: &str) -> f64 {
    agentlens_core::summarize::helpers::parse_iso_ms(iso).unwrap()
}

/// A query before the timeline starts is `state: null` WITH a note — a coverage GAP, never an error
/// and never "no account was active". The timeline only reaches back to the server's first
/// observation, and conflating that with absence is what makes an automated reader draw the wrong
/// conclusion about a period it simply cannot see.
#[test]
fn get_account_state_at_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let iso = |k: &str| json!({ "iso": o["isoCases"][k].as_str().unwrap() });
    same(&get_account_state_at(&iso("before"), &state_log()), &o["stateBefore"], "stateBefore");
    same(&get_account_state_at(&iso("first"), &state_log()), &o["stateFirst"], "stateFirst");
    same(&get_account_state_at(&iso("mid"), &state_log()), &o["stateMid"], "stateMid");
    same(&get_account_state_at(&iso("last"), &state_log()), &o["stateLast"], "stateLast");
    let before = get_account_state_at(&iso("before"), &state_log());
    assert!(before.get("error").is_none(), "a gap is not an error: {before}");
    assert!(before["note"].as_str().unwrap().contains("may not extend that far back"), "{before}");
    // A resolvable state carries NO note — the key drops rather than emitting an empty one.
    assert!(get_account_state_at(&iso("mid"), &state_log()).get("note").is_none());
}

/// `ts` wins over `iso` when both are supplied, and an unresolvable timestamp is an explicit error
/// naming BOTH accepted arguments rather than a silent null state.
#[test]
fn ts_beats_iso_and_an_unresolvable_timestamp_is_an_error() {
    let o = oracle();
    let both = json!({ "ts": 1785547200000i64, "iso": o["isoCases"]["before"].as_str().unwrap() });
    same(&get_account_state_at(&both, &state_log()), &o["stateByTs"], "stateByTs");
    same(&get_account_state_at(&json!({}), &state_log()), &o["stateBadArgs"], "stateBadArgs");
    same(&get_account_state_at(&json!({"iso": "not-a-date"}), &state_log()), &o["stateBadIso"], "stateBadIso");
    let bad = get_account_state_at(&json!({}), &state_log());
    assert!(bad["error"].as_str().unwrap().contains("ts") && bad["error"].as_str().unwrap().contains("iso"), "{bad}");
}

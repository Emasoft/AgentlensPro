//! Cross-engine parity for `get_cache_risk_costs` / `reload-cost` (TRDD-DMWOBWFH P4x.2d). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-riskcosts-expected.mjs
//!
//! MTIME ORACLE: `scan_cache_risk_commands` skips a file whose mtime predates `since_ms`, and git
//! does not preserve mtimes — the generator stamps a fixed table and publishes it; this test
//! re-stamps from that same published table rather than keeping a second copy that can drift.

use std::collections::HashSet;
use std::path::PathBuf;

use agentlens_core::mcp_tools::{get_cache_risk_costs, CacheRiskCtx};
use serde_json::{json, Value};

fn fixtures() -> PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn oracle() -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join("riskcosts-expected.json")).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract `assert_eq!` cannot see (`preserve_order` makes `Value::Object` an
/// IndexMap whose `PartialEq` ignores order), and here half the payload's meaning is carried by
/// which optional keys are PRESENT: `scanStoppedEarly`/`scanNote`, `eventsNote`,
/// `unexplainedReloadTurns`/`unexplainedNote`, `note`, and on each row `args`/`note`/`model`.
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

/// Re-pin the fixture mtimes the oracle recorded. Checkout time is not fixture data.
fn repin(o: &Value) -> Vec<PathBuf> {
    let slug = fixtures().join("riskcost-home/projects/proj-a");
    for (name, ms) in o["mtimes"].as_object().unwrap() {
        let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(ms.as_f64().unwrap() as u64);
        let f = std::fs::OpenOptions::new().append(true).open(slug.join(name)).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
    }
    vec![fixtures().join("riskcost-home/projects")]
}

/// The five committed transcripts. Hardcoded rather than scanned so this suite is not coupled to
/// what any OTHER fixture home happens to contain.
fn file_ids() -> HashSet<String> {
    ["risk-a", "risk-b", "risk-c", "risk-old", "risk-noreport"].iter().map(|s| (*s).to_owned()).collect()
}

fn run(o: &Value, dirs: &[PathBuf], args: Value, accessor: bool) -> Value {
    let sessions = o["sessions"].as_array().cloned().unwrap_or_default();
    let comp = |id: &str| o["compositions"].get(id).filter(|v| !v.is_null()).cloned();
    let timeline_of = |c: &Value| -> Vec<Value> {
        let id = c.get("sessionId").and_then(Value::as_str).unwrap_or_default();
        o["timelines"].get(id).and_then(Value::as_array).cloned().unwrap_or_default()
    };
    let ids = file_ids();
    let ctx = CacheRiskCtx {
        file_ids: &ids,
        dirs,
        get_composition: accessor.then_some(&comp as &dyn Fn(&str) -> Option<Value>),
        timeline_of: &timeline_of,
        now_ms: o["nowMs"].as_f64().unwrap(),
        time_budget_ms: 20_000.0,
    };
    get_cache_risk_costs(&sessions, &args, &ctx)
}

#[test]
fn get_cache_risk_costs_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let dirs = repin(&o);
    same(&run(&o, &dirs, json!({}), false), &o["noAccessor"], "noAccessor");
    for (case, args) in [
        ("all", json!({})),
        ("scoped", json!({"workspace": "/w/alpha"})),
        ("blankScope", json!({"workspace": "   "})),
        ("windowZero", json!({"window": 0})),
        ("window2h", json!({"window": 2})),
        ("kindsNoEffort", json!({"kinds": ["PLUGINS_RELOADED", "SKILLS_RELOADED"]})),
        ("kindsWithEffort", json!({"kinds": ["EFFORT_CHANGED"]})),
        ("kindsEmpty", json!({"kinds": []})),
        ("topOne", json!({"topN": 1})),
        ("topZeroClampsToOne", json!({"topN": 0})),
        ("topHugeClampsTo200", json!({"topN": 9999})),
        ("minTokensHigh", json!({"minTokens": 100_000})),
        ("noMatch", json!({"workspace": "/w/nowhere"})),
    ] {
        same(&run(&o, &dirs, args, true), &o[case], case);
    }
}

/// ONE TURN IS ONE COST. `/reload-plugins` (10:01:00) and `/reload-skills` (10:01:10) both land
/// before turn 2, so they broke the prefix ONCE, TOGETHER: only the EARLIEST is charged and the
/// other is listed at 0 with the reason. Charging both the full turn is exactly the double-count
/// that made the old co-churn heuristic untrustworthy (102 counted vs 69 actual).
#[test]
fn two_commands_before_the_same_turn_are_charged_once() {
    let o = oracle();
    let dirs = repin(&o);
    let got = run(&o, &dirs, json!({}), true);
    let ev = got["events"].as_array().unwrap();
    let first = ev.iter().find(|e| e["command"] == "/reload-plugins").unwrap();
    let second = ev.iter().find(|e| e["command"] == "/reload-skills").unwrap();
    assert_eq!(first["turn"], 2);
    assert_eq!(second["turn"], 2, "both name the same turn — the sibling is not hidden");
    assert_eq!(first["cacheCreateTokens"], 9000, "the EARLIEST is charged");
    assert_eq!(second["cacheCreateTokens"], 0, "the later one is 0, not a second 9000");
    assert!(second["note"].as_str().unwrap().contains("already charged"), "{second}");
    assert!(first.get("note").is_none(), "a charged row carries no note: {first}");
}

/// THE JOIN ONLY EVER SEES BREAKING TURNS, and that is not obvious from the handler: `timed` filters
/// on `tsMs !== undefined`, and `tsMs` is written ONLY by the break path — the two "no break" turn
/// objects carry no timestamp at all. So a command followed by a QUIET turn is billed against the
/// next turn that actually broke, and the "menu opened and closed" note is reachable only through a
/// turn that broke while wasting ZERO tokens (a model switch with no cache_creation). risk-c is
/// built to be exactly that, because a fixture without it leaves the branch untested while every
/// case still passes.
#[test]
fn a_break_that_wasted_nothing_is_the_only_route_to_the_changed_nothing_note() {
    let o = oracle();
    let dirs = repin(&o);
    let got = run(&o, &dirs, json!({}), true);
    let row = got["events"].as_array().unwrap().iter().find(|e| e["sessionId"] == "risk-c").unwrap();
    assert_eq!(row["turn"], 2, "billed on the breaking turn: {row}");
    assert_eq!(row["cacheCreateTokens"], 0);
    assert!(row["note"].as_str().unwrap().contains("menu opened and closed"), "{row}");
    // risk-a's quiet turn 3 is INVISIBLE to the join — nothing is ever billed against it.
    assert!(
        !got["events"].as_array().unwrap().iter().any(|e| e["sessionId"] == "risk-a" && e["turn"] == 3),
        "a non-breaking turn carries no tsMs, so it cannot be a billing target"
    );
}

/// A command with NO turn at or after it is `turn: null` and says the cost is unattributable —
/// rather than being silently dropped, which would make a real invalidation vanish from the report.
#[test]
fn a_command_after_the_last_turn_is_listed_as_unattributable() {
    let o = oracle();
    let dirs = repin(&o);
    let got = run(&o, &dirs, json!({}), true);
    let login = got["events"].as_array().unwrap().iter().find(|e| e["command"] == "/login").unwrap();
    assert_eq!(login["turn"], Value::Null);
    assert_eq!(login["cacheCreateTokens"], 0);
    assert!(login["note"].as_str().unwrap().contains("unattributable"), "{login}");
}

/// EFFORT TRANSITIONS ARE A SECOND SOURCE, and they are NOT counted by
/// `commandsFoundInTranscripts` — that field counts typed slash commands only. So a window whose
/// only cause was an effort change reports 0 found AND emits the "no cache-risk commands" note
/// while `events` is non-empty. That is the TS's own wording; a port that "fixed" it here would
/// diverge on the number the janitor CLI consumes.
#[test]
fn an_effort_transition_is_an_event_but_not_a_command() {
    let o = oracle();
    let dirs = repin(&o);
    let only_effort = run(&o, &dirs, json!({"kinds": ["EFFORT_CHANGED"]}), true);
    assert_eq!(only_effort["commandsFoundInTranscripts"], 0, "the effort scan contributes no COMMANDS");
    assert_eq!(only_effort["eventsListed"], 1, "yet it produced an event");
    assert!(only_effort["note"].as_str().unwrap().contains("No cache-risk commands found"), "{}", only_effort["note"]);
    // A kinds list WITHOUT EFFORT_CHANGED skips the effort scan entirely.
    let no_effort = run(&o, &dirs, json!({"kinds": ["PLUGINS_RELOADED", "SKILLS_RELOADED"]}), true);
    assert!(
        !no_effort["events"].as_array().unwrap().iter().any(|e| e["kind"] == "EFFORT_CHANGED"),
        "{}",
        no_effort["events"]
    );
    // An EMPTY kinds array is falsy-LENGTH: "no filter", not "match nothing".
    let empty = run(&o, &dirs, json!({"kinds": []}), true);
    assert_eq!(empty["eventsListed"], run(&o, &dirs, json!({}), true)["eventsListed"]);
}

/// `windowHours` is `args.window ?? null` on the RAW arg while `sinceMs` is `args.window ? …` —
/// TRUTHY. So `window: 0` ECHOES 0 and filters NOTHING. The two guards read the same argument and
/// deliberately disagree; unifying them either loses the echo or applies a zero-hour window that
/// would exclude everything.
#[test]
fn a_zero_window_echoes_zero_and_filters_nothing() {
    let o = oracle();
    let dirs = repin(&o);
    let zero = run(&o, &dirs, json!({"window": 0}), true);
    let none = run(&o, &dirs, json!({}), true);
    assert_eq!(zero["windowHours"], 0, "echoed, not nulled");
    assert_eq!(none["windowHours"], Value::Null, "an ABSENT window is null");
    assert_eq!(zero["eventsListed"], none["eventsListed"], "and it filtered nothing");
    // A real window does filter: risk-old's transcript mtime and its startTime both predate it.
    let two_h = run(&o, &dirs, json!({"window": 2}), true);
    assert!(!two_h["events"].as_array().unwrap().iter().any(|e| e["sessionId"] == "risk-old"), "{}", two_h["events"]);
}

/// The residue is reported SEPARATELY and never summed into the totals. It exists because the
/// co-churn inference over-counts (102 vs 69 measured) — but discarding it would hide real breaks
/// in sessions whose transcript has been rotated away, so it ships labelled instead of dropped.
#[test]
fn unexplained_reload_turns_are_labelled_and_excluded_from_the_totals() {
    let o = oracle();
    let dirs = repin(&o);
    let got = run(&o, &dirs, json!({}), true);
    let residue = got["unexplainedReloadTurns"].as_array().unwrap();
    assert_eq!(residue.len(), 1, "{residue:?}");
    assert_eq!(residue[0]["turn"], 4);
    assert_eq!(residue[0]["evidence"], "inference");
    assert_eq!(residue[0]["cacheCreateTokens"], 40000);
    assert!(got["unexplainedNote"].as_str().unwrap().contains("NOT included in the totals"), "{}", got["unexplainedNote"]);
    // Proof, not just a claim: the 40,000 is absent from the exact totals.
    let total = got["totalCacheCreateTokens"].as_f64().unwrap();
    let summed: f64 = got["events"].as_array().unwrap().iter().map(|e| e["cacheCreateTokens"].as_f64().unwrap_or(0.0)).sum();
    assert_eq!(total, summed, "the totals are the sum of the EXACT rows only");
    assert!(total < 40_000.0, "the inferred 40,000 is not in there: {total}");
}

/// `minTokens` gates only a BREAK. A non-breaking invocation is still LISTED at 0, because
/// "I ran this and it cost nothing" must stay distinguishable from "no data for this command".
#[test]
fn min_tokens_filters_breaks_and_keeps_the_zero_cost_rows() {
    let o = oracle();
    let dirs = repin(&o);
    let got = run(&o, &dirs, json!({"minTokens": 100_000}), true);
    assert_eq!(got["eventsPriced"], 0, "every break is under the floor");
    assert_eq!(got["totalCacheCreateTokens"], 0);
    let ev = got["events"].as_array().unwrap();
    assert_eq!(ev.len(), 3, "the 0-cost rows survive the floor: {ev:?}");
    assert!(ev.iter().all(|e| e["cacheCreateTokens"] == 0));
}

/// `topN` clamps to [1, 200] — 0 does not mean "none" and 9999 does not mean "everything" — and
/// truncation ANNOUNCES itself with `eventsNote` rather than silently shortening the list.
#[test]
fn top_n_clamps_and_truncation_announces_itself() {
    let o = oracle();
    let dirs = repin(&o);
    let one = run(&o, &dirs, json!({"topN": 1}), true);
    assert_eq!(one["events"].as_array().unwrap().len(), 1);
    assert_eq!(one["eventsListed"], 7, "the FULL count is still reported");
    assert!(one["eventsNote"].as_str().unwrap().contains("Showing the most recent 1 of 7"), "{}", one["eventsNote"]);
    assert_eq!(run(&o, &dirs, json!({"topN": 0}), true)["events"].as_array().unwrap().len(), 1, "0 clamps UP to 1");
    let huge = run(&o, &dirs, json!({"topN": 9999}), true);
    assert!(huge.get("eventsNote").is_none(), "nothing was truncated, so no note: {huge}");
}

/// `byKind.costUsd` is re-rounded to 4dp on EVERY accumulation, not once at the end — the total is
/// a sum of rounded partials, and rounding only at the end drifts away from the TS.
#[test]
fn by_kind_rounds_on_every_accumulation() {
    let o = oracle();
    let dirs = repin(&o);
    let got = run(&o, &dirs, json!({}), true);
    same(&got["byKind"], &o["all"]["byKind"], "byKind");
    // Every kind that produced a row appears, including the ones that cost nothing.
    let kinds: Vec<&str> = got["byKind"].as_object().unwrap().keys().map(String::as_str).collect();
    assert!(kinds.contains(&"EFFORT_CHANGED") && kinds.contains(&"ACCOUNT_SWITCHED"), "{kinds:?}");
}

/// An ALREADY-ELAPSED budget stops before the first pooled session. The counts still describe the
/// real pool, so a stopped scan is visibly a sample rather than an empty finding.
#[test]
fn an_elapsed_scan_budget_stops_before_the_first_session() {
    let o = oracle();
    let dirs = repin(&o);
    let sessions = o["sessions"].as_array().cloned().unwrap_or_default();
    let comp = |id: &str| o["compositions"].get(id).filter(|v| !v.is_null()).cloned();
    let timeline_of = |c: &Value| -> Vec<Value> {
        let id = c.get("sessionId").and_then(Value::as_str).unwrap_or_default();
        o["timelines"].get(id).and_then(Value::as_array).cloned().unwrap_or_default()
    };
    let ids = file_ids();
    let ctx = CacheRiskCtx {
        file_ids: &ids,
        dirs: &dirs,
        get_composition: Some(&comp),
        timeline_of: &timeline_of,
        now_ms: o["nowMs"].as_f64().unwrap(),
        time_budget_ms: -1.0,
    };
    let got = get_cache_risk_costs(&sessions, &json!({}), &ctx);
    assert_eq!(got["sessionsAnalyzed"], 0, "{got}");
    assert_eq!(got["eventsListed"], 0);
    assert_eq!(got["scanStoppedEarly"], true);
    assert_eq!(got["sessionsConsidered"], 5, "the pool it did NOT scan is still reported honestly");
    assert!(got["scanNote"].as_str().unwrap().contains("stopped after 0 of 5"), "{}", got["scanNote"]);
}

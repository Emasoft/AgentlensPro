//! Cross-engine parity for `get_recent_sessions` and `get_workspace_patterns` (TRDD-DMWOBWFH
//! P4x.2c) — the two tools CLAUDE.md tells every agent to call before starting work, so their
//! answers are the first thing a session ever reads from this server. Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-sessionreports-expected.mjs

use agentlens_core::mcp_tools::{get_recent_sessions, get_workspace_patterns};
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/sessionreports-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER compared explicitly — `Value`'s PartialEq ignores it, and the optional fields
/// (`active`, `title`, `entrypoint`, `coverageNote`) keep their LITERAL positions rather than
/// appending, so an "obvious" reordering is invisible to `assert_eq!` alone.
fn assert_rows(got: &Value, exp: &Value, name: &str) {
    let (g, e) = (got.as_array().unwrap(), exp.as_array().unwrap());
    assert_eq!(g.len(), e.len(), "{name}: row count");
    for (i, (gv, ev)) in g.iter().zip(e).enumerate() {
        assert_eq!(keys(gv), keys(ev), "{name}[{i}]: key set/ORDER differs");
        for (k, evv) in ev.as_object().unwrap() {
            assert_eq!(&gv[k], evv, "{name}[{i}].{k}");
        }
    }
}

#[test]
fn get_recent_sessions_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let (sessions, now) = (o["sessions"].as_array().unwrap(), o["nowMs"].as_f64().unwrap());
    for (case, exp) in o["recentCases"].as_array().unwrap().iter().zip(o["recentResults"].as_array().unwrap()) {
        let name = case["name"].as_str().unwrap();
        let a = &case["args"];
        let got = get_recent_sessions(
            sessions,
            a.get("agent").and_then(Value::as_str),
            a.get("workspace").and_then(Value::as_str),
            a.get("limit").and_then(Value::as_f64),
            now,
        );
        assert_rows(&got, exp, name);
    }
}

/// "Recent" means recently ACTIVE, not recently STARTED. The fixture's oldest-starting session is
/// still emitting and must rank FIRST — the caller's list is start-date ordered, and trusting it
/// buried 4 actively-emitting sessions below fresh idle ones in the live incident this rank exists
/// for. This is the one place the order is recomputed, so it is the one place to assert it.
#[test]
fn recent_means_recently_active_not_recently_started() {
    let o = oracle();
    let (sessions, now) = (o["sessions"].as_array().unwrap(), o["nowMs"].as_f64().unwrap());
    let got = get_recent_sessions(sessions, None, None, None, now);
    assert_eq!(got[0]["sessionId"], "stale-start-live-now", "the oldest START is the newest ACTIVITY: {got}");
    // The input order must NOT be what produced that — otherwise the test proves nothing.
    assert_eq!(sessions[0]["sessionId"], "stale-start-live-now");
    let reversed: Vec<Value> = sessions.iter().rev().cloned().collect();
    let from_reversed = get_recent_sessions(&reversed, None, None, None, now);
    assert_eq!(from_reversed[0]["sessionId"], "stale-start-live-now", "the caller's order is never trusted: {from_reversed}");
}

/// `active` rides ONLY on live sessions and is ABSENT otherwise — never `false`. A false reads as a
/// measurement ("we checked, it is idle") on cards where the flag simply does not apply.
#[test]
fn the_active_flag_is_absent_rather_than_false() {
    let o = oracle();
    let (sessions, now) = (o["sessions"].as_array().unwrap(), o["nowMs"].as_f64().unwrap());
    let got = get_recent_sessions(sessions, None, None, None, now);
    let rows = got.as_array().unwrap();
    assert_eq!(rows[0]["active"], true, "the live one carries it: {}", rows[0]);
    for r in rows.iter().skip(1) {
        assert!(r.get("active").is_none(), "an idle row must OMIT it, not carry false: {r}");
    }
}

/// `limit` is `Math.min(x ?? 10, 50)` with NO low clamp, so a negative reaches
/// `Array.slice(0, -n)` — which drops the LAST n rows rather than returning none. `take()` would
/// silently return everything, and a `.max(0)` would return nothing; both are wrong in opposite
/// directions, which is exactly why this is asserted rather than assumed.
#[test]
fn a_negative_limit_drops_the_tail_the_way_js_slice_does() {
    let o = oracle();
    let (sessions, now) = (o["sessions"].as_array().unwrap(), o["nowMs"].as_f64().unwrap());
    let all = get_recent_sessions(sessions, None, None, None, now).as_array().unwrap().len();
    let minus_one = get_recent_sessions(sessions, None, None, Some(-1.0), now);
    assert_eq!(minus_one.as_array().unwrap().len(), all - 1, "-1 drops the LAST row: {minus_one}");
    let zero = get_recent_sessions(sessions, None, None, Some(0.0), now);
    assert!(zero.as_array().unwrap().is_empty(), "0 is 0, not the default 10: {zero}");
    let over = get_recent_sessions(sessions, None, None, Some(999.0), now);
    assert_eq!(over.as_array().unwrap().len(), all, "the cap is 50, above the fixture size");
}

#[test]
fn get_workspace_patterns_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let (sessions, now) = (o["sessions"].as_array().unwrap(), o["nowMs"].as_f64().unwrap());
    for (case, exp) in o["patternCases"].as_array().unwrap().iter().zip(o["patternResults"].as_array().unwrap()) {
        let name = case["name"].as_str().unwrap();
        let got = get_workspace_patterns(sessions, case["args"].get("days").and_then(Value::as_f64), now);
        assert_eq!(keys(&got), keys(exp), "{name}: key set/ORDER differs");
        for (k, ev) in exp.as_object().unwrap() {
            assert_eq!(&got[k], ev, "{name}.{k}");
        }
    }
}

/// The cache SLI averages ONLY cache-measured sessions, and the exclusion is LABELLED. A junk row
/// (no LLM calls, no token traffic) reads 0% and would drag the average toward 0 with no billing
/// behind it — so the average would describe the junk rather than the cache. The label is what lets
/// a reader see how many sessions actually back the number.
#[test]
fn the_cache_sli_excludes_junk_rows_and_says_so() {
    let o = oracle();
    let (sessions, now) = (o["sessions"].as_array().unwrap(), o["nowMs"].as_f64().unwrap());
    let got = get_workspace_patterns(sessions, None, now);
    assert_eq!(got["sessionCount"], 6, "every session is counted: {got}");
    assert_eq!(got["cacheMeasuredSessions"], 5, "but only five back the SLI: {got}");
    assert_eq!(got["cacheExcludedJunkSessions"], 1, "and the exclusion is named: {got}");
    // Recomputing over ALL rows would drag it down — prove the reported figure is not that.
    let measured_avg = got["avgCacheHitRate"].as_str().unwrap();
    assert_ne!(measured_avg, "n/a");
    let pct: f64 = measured_avg.trim_end_matches('%').parse().unwrap();
    let naive = 5.0 / 6.0 * pct;
    assert!((pct - naive).abs() > 1.0, "the junk row would have moved it: reported {pct}, junk-diluted {naive}");

    // Nothing measured at all is 'n/a', never a 0% that reads as a measurement.
    let junk_only: Vec<Value> = sessions.iter().filter(|s| s["sessionId"] == "junk-zero").cloned().collect();
    let none = get_workspace_patterns(&junk_only, None, now);
    assert_eq!(none["avgCacheHitRate"], "n/a", "{none}");
}

#[test]
fn find_relevant_context_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let (sessions, now) = (o["sessions"].as_array().unwrap(), o["nowMs"].as_f64().unwrap());
    for (case, exp) in o["relevantCases"].as_array().unwrap().iter().zip(o["relevantResults"].as_array().unwrap()) {
        let name = case["name"].as_str().unwrap();
        let got = agentlens_core::mcp_tools::find_relevant_context(sessions, case["args"]["task"].as_str().unwrap(), now);
        assert_eq!(keys(&got), keys(exp), "{name}: key set/ORDER differs");
        for (k, ev) in exp.as_object().unwrap() {
            assert_eq!(&got[k], ev, "{name}.{k}");
        }
    }
}

/// The task tokeniser has two rules that decide whether the tool answers anything useful. Words of
/// 3 characters or FEWER are dropped, because "the"/"for"/"and" match every session ever recorded
/// and would make every task look similar to everything. And `/`, `_`, `.` SURVIVE the blanking, so
/// `src/logReader.ts` stays ONE word — shattering it into `src`, `log`, `reader`, `ts` would match
/// on the extension.
#[test]
fn the_task_tokeniser_drops_short_words_and_keeps_paths_whole() {
    let o = oracle();
    let (sessions, now) = (o["sessions"].as_array().unwrap(), o["nowMs"].as_f64().unwrap());
    let short = agentlens_core::mcp_tools::find_relevant_context(sessions, "do it now", now);
    assert!(short["message"].as_str().unwrap().contains("too short"), "{short}");
    // A path matches the sessions that mention THAT path…
    let path = agentlens_core::mcp_tools::find_relevant_context(sessions, "fix src/logReader.ts parsing", now);
    assert_eq!(path["matchedSessions"], 2, "{path}");
    // …and punctuation around real words is blanked rather than glued on.
    let punct = agentlens_core::mcp_tools::find_relevant_context(sessions, "refactor!!! the... loader???", now);
    let plain = agentlens_core::mcp_tools::find_relevant_context(sessions, "refactor the loader", now);
    assert_eq!(punct["matchedSessions"], plain["matchedSessions"], "punctuation must not change the match: {punct} vs {plain}");
}

#[test]
fn get_efficiency_report_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let (sessions, now) = (o["sessions"].as_array().unwrap(), o["nowMs"].as_f64().unwrap());
    for (case, exp) in o["efficiencyCases"].as_array().unwrap().iter().zip(o["efficiencyResults"].as_array().unwrap()) {
        let name = case["name"].as_str().unwrap();
        let got = agentlens_core::mcp_tools::get_efficiency_report(sessions, case["args"].get("days").and_then(Value::as_f64), now);
        assert_eq!(keys(&got), keys(exp), "{name}: key set/ORDER differs");
        for (k, ev) in exp.as_object().unwrap() {
            assert_eq!(&got[k], ev, "{name}.{k}");
        }
    }
}

/// The cost trend has a ±15% DEAD BAND, and an empty first half is 'no data' rather than an
/// infinite increase. Both matter for the same reason: a trend line that moves on ordinary variance,
/// or that reports a rise when there was nothing to rise from, is noise a reader will act on.
#[test]
fn the_cost_trend_has_a_dead_band_and_refuses_to_divide_by_nothing() {
    let o = oracle();
    let (sessions, now) = (o["sessions"].as_array().unwrap(), o["nowMs"].as_f64().unwrap());
    // 30 days: the fixture's 20-day-old session fills the first half, so a real comparison happens.
    let real = agentlens_core::mcp_tools::get_efficiency_report(sessions, None, now);
    assert_ne!(real["costTrend"], "no data", "the fixture must exercise a real comparison: {real}");
    // 90 days: the midpoint moves to 45 days back, leaving the first half EMPTY.
    let no_first_half = agentlens_core::mcp_tools::get_efficiency_report(sessions, Some(90.0), now);
    assert_eq!(no_first_half["costTrend"], "no data", "no first half means no ratio: {no_first_half}");
    assert_eq!(real["sessionCount"], no_first_half["sessionCount"], "and the same sessions are in BOTH windows — only the split moved");
}

/// `n >= 2` keeps a single session out of the ranking: one run is an anecdote, not a measurement.
/// The order is ASCENDING by cost, because the question the ranking answers is "what should I use",
/// not "what was most expensive".
#[test]
fn the_agent_ranking_needs_two_sessions_and_ranks_cheapest_first() {
    let o = oracle();
    let (sessions, now) = (o["sessions"].as_array().unwrap(), o["nowMs"].as_f64().unwrap());
    let got = agentlens_core::mcp_tools::get_efficiency_report(sessions, None, now);
    let ranking = got["agentRanking"].as_array().unwrap();
    for row in ranking {
        assert!(row["sessions"].as_f64().unwrap() >= 2.0, "a single-session pair must not rank: {row}");
    }
    let costs: Vec<f64> = ranking.iter().map(|r| r["avgCostUsd"].as_f64().unwrap()).collect();
    let mut sorted = costs.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert_eq!(costs, sorted, "cheapest first: {ranking:?}");
    // The fixture must actually contain a pair that ranks, or this proves nothing.
    assert!(!ranking.is_empty(), "{got}");
}

#[test]
fn get_instruction_suggestions_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, exp) in o["instrCases"].as_array().unwrap().iter().zip(o["instrResults"].as_array().unwrap()) {
        let name = case["name"].as_str().unwrap();
        let sessions = case["sessions"].as_array().unwrap();
        let ws = case["args"].get("workspace").and_then(Value::as_str);
        // The fixture workspace does not exist, so both engines read '' — the oracle tests the
        // advisor and the shaper, not this machine's instruction files.
        let existing = ws
            .map(str::trim)
            .filter(|w| !w.is_empty())
            .map(agentlens_core::instruction_files::read_all_instruction_content)
            .unwrap_or_default();
        let got = agentlens_core::mcp_tools::get_instruction_suggestions(sessions, ws, &existing);
        match (got.as_array(), exp.as_array()) {
            (Some(g), Some(e)) => {
                assert_eq!(g.len(), e.len(), "{name}: suggestion count");
                for (i, (gv, ev)) in g.iter().zip(e).enumerate() {
                    assert_eq!(keys(gv), keys(ev), "{name}[{i}]: key set/ORDER differs");
                    assert_eq!(gv, ev, "{name}[{i}]");
                }
            }
            _ => {
                assert_eq!(keys(&got), keys(exp), "{name}: key set/ORDER differs");
                assert_eq!(got, *exp, "{name}");
            }
        }
    }
}

/// THREE different top-level SHAPES, and each says something the others cannot. `{error}` means the
/// caller gave no workspace (suggestions are project-scoped — machine-wide advice is usually wrong
/// advice). `{message, suggestions: []}` means there IS a workspace but not enough history yet — a
/// different fact from "nothing to suggest", which a bare empty array cannot distinguish. A bare
/// ARRAY means real suggestions.
#[test]
fn the_three_instruction_shapes_stay_tellable_apart() {
    let o = oracle();
    let cases = o["instrCases"].as_array().unwrap();
    let pick = |n: &str| -> &Value { cases.iter().find(|c| c["name"] == n).unwrap() };
    let run = |c: &Value| {
        let ws = c["args"].get("workspace").and_then(Value::as_str);
        agentlens_core::mcp_tools::get_instruction_suggestions(c["sessions"].as_array().unwrap(), ws, "")
    };
    let no_ws = run(pick("no-workspace-is-an-error"));
    assert!(no_ws.get("error").is_some(), "{no_ws}");
    let thin = run(pick("too-little-history"));
    assert!(thin.get("message").is_some() && thin["suggestions"].as_array().unwrap().is_empty(), "{thin}");
    assert!(thin.get("error").is_none(), "not enough history is not an error: {thin}");
    let ok = run(pick("enough-history"));
    assert!(ok.is_array(), "success is a BARE array: {ok}");

    // The appended cache-efficiency suggestion is the shaper's own, not the advisor's — and it
    // needs >= 5 CACHE-MEASURED sessions, so a pile of junk rows can neither trigger nor suppress
    // it. The fixture is all below the 0.8 target, so it must be present.
    let ids: Vec<&str> = ok.as_array().unwrap().iter().filter_map(|s| s["id"].as_str()).collect();
    assert!(ids.contains(&"cache-efficiency"), "{ids:?}");
    for s in ok.as_array().unwrap() {
        assert_eq!(
            keys(s),
            vec!["id", "category", "title", "evidence", "suggestedText", "targetAgents", "priority"],
            "every suggestion is RE-PROJECTED to the tool's own 7 fields: {s}"
        );
    }
}

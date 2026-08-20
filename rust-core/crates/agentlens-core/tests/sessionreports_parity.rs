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
    assert_eq!(got["sessionCount"], 5, "every session is counted: {got}");
    assert_eq!(got["cacheMeasuredSessions"], 4, "but only four back the SLI: {got}");
    assert_eq!(got["cacheExcludedJunkSessions"], 1, "and the exclusion is named: {got}");
    // Recomputing over ALL rows would drag it down — prove the reported figure is not that.
    let measured_avg = got["avgCacheHitRate"].as_str().unwrap();
    assert_ne!(measured_avg, "n/a");
    let pct: f64 = measured_avg.trim_end_matches('%').parse().unwrap();
    let naive = 4.0 / 5.0 * pct;
    assert!((pct - naive).abs() > 1.0, "the junk row would have moved it: reported {pct}, junk-diluted {naive}");

    // Nothing measured at all is 'n/a', never a 0% that reads as a measurement.
    let junk_only: Vec<Value> = sessions.iter().filter(|s| s["sessionId"] == "junk-zero").cloned().collect();
    let none = get_workspace_patterns(&junk_only, None, now);
    assert_eq!(none["avgCacheHitRate"], "n/a", "{none}");
}

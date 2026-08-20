//! Cross-engine parity for `get_window_eta` (TRDD-DMWOBWFH P4x.2d). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-windoweta-expected.mjs
//!
//! It shares the account-burners fixture on purpose: the two tools SHARE their attribution rule and
//! capacity resolver, and a second fixture here would let them drift apart in exactly the place the
//! TS says they must not.

use agentlens_core::account_burners::AccountSegment;
use agentlens_core::burn::monitor::ObservedAccountCapacity;
use agentlens_core::window_eta::{build_window_eta_report, human_eta, WindowEtaOpts};
use indexmap::IndexMap;
use serde_json::Value;

fn fixtures() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn load(name: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join(name)).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract `assert_eq!` cannot see (`preserve_order` makes `Value::Object` an
/// IndexMap whose `PartialEq` ignores order).
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

fn opt_str(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(str::to_owned)
}

fn seg_from(v: &Value) -> AccountSegment {
    AccountSegment {
        account_id: v["accountId"].as_str().unwrap_or("").to_owned(),
        email: opt_str(v, "email"),
        plan: opt_str(v, "plan"),
        start_ms: v["startMs"].as_f64().unwrap_or(0.0),
        end_ms: v.get("endMs").and_then(Value::as_f64),
    }
}

fn target_from(v: &Value) -> agentlens_core::account_burners::ResolvedAccount {
    agentlens_core::account_burners::ResolvedAccount {
        account_id: v["accountId"].as_str().unwrap_or("").to_owned(),
        email: opt_str(v, "email"),
        plan: opt_str(v, "plan"),
        segments: v["segments"].as_array().map(|a| a.iter().map(seg_from).collect()).unwrap_or_default(),
        last_active_ms: v["lastActiveMs"].as_f64().unwrap_or(0.0),
        is_current: v["isCurrent"].as_bool().unwrap_or(false),
    }
}

/// The same five capacity shapes the generator builds, keyed by the 5h/7d cost caps that decide
/// which etaReason each window lands in.
fn cap(h5: Option<f64>, d7: Option<f64>) -> IndexMap<String, ObservedAccountCapacity> {
    let mut m = IndexMap::new();
    m.insert(
        "aaaaaaaa-1111-1111-1111-111111111111".to_owned(),
        ObservedAccountCapacity {
            window5h_tokens: Some(5_000_000.0),
            window7d_tokens: Some(40_000_000.0),
            window5h_cost_usd: h5,
            window7d_cost_usd: d7,
            observed_at: Some("2026-07-30T00:00:00.000Z".to_owned()),
        },
    );
    m
}

fn run(observed: &IndexMap<String, ObservedAccountCapacity>, rate_window_ms: f64) -> Value {
    let burners = load("acctburners-expected.json");
    let events = burners["events"].as_array().cloned().unwrap_or_default();
    let segments: Vec<AccountSegment> = burners["readSegments"].as_array().unwrap().iter().map(seg_from).collect();
    let target = target_from(&burners["targets"]["current"]);
    build_window_eta_report(&WindowEtaOpts {
        events: &events,
        target: &target,
        all_segments: &segments,
        now_ms: burners["nowMs"].as_f64().unwrap(),
        rate_window_ms,
        observed,
    })
}

const HALF_HOUR: f64 = 30.0 * 60_000.0;

#[test]
fn build_window_eta_report_reproduces_the_ts_oracle_exactly() {
    let o = load("windoweta-expected.json");
    same(&run(&IndexMap::new(), HALF_HOUR), &o["noCapacity"], "noCapacity");
    same(&run(&cap(Some(500.0), Some(5000.0)), HALF_HOUR), &o["plateau"], "plateau");
    same(&run(&cap(Some(4.0), Some(5000.0)), HALF_HOUR), &o["projected"], "projected");
    same(&run(&cap(Some(1.0), Some(5000.0)), HALF_HOUR), &o["overLimit"], "overLimit");
    same(&run(&cap(Some(500.0), Some(5000.0)), 60_000.0), &o["idle"], "idle");
    same(&run(&cap(Some(0.0), Some(5000.0)), HALF_HOUR), &o["zeroCap"], "zeroCap");
    same(&run(&cap(Some(4.0), Some(5.0)), HALF_HOUR), &o["bothProjected"], "bothProjected");
}

#[test]
fn human_eta_reproduces_the_ts_oracle_exactly() {
    let o = load("windoweta-expected.json");
    for row in o["humanEta"].as_array().unwrap() {
        let m = row[0].as_f64();
        let reason = row[1].as_str().unwrap();
        assert_eq!(human_eta(m, reason), row[2].as_str().unwrap(), "humanEta({m:?}, {reason})");
    }
}

/// THE ROLLING-WINDOW PLATEAU — the whole reason this tool is not `remaining ÷ rate`. A rolling
/// window sheds consumption older than its length, so at a steady rate r it plateaus at
/// r × windowLength. Below the cap it can NEVER exhaust, however long it runs; a naive projection
/// would print a confident finite countdown for a window that will never fill.
#[test]
fn a_window_that_plateaus_below_its_cap_gets_no_eta() {
    let got = run(&cap(Some(500.0), Some(5000.0)), HALF_HOUR);
    for w in ["fiveHour", "sevenDay"] {
        assert_eq!(got[w]["etaReason"], "plateau", "{w}");
        assert_eq!(got[w]["etaMinutes"], Value::Null, "no countdown for a window that cannot fill");
        assert_eq!(got[w]["willExhaustAtCurrentRate"], false);
        assert!(got[w]["steadyStateFillUsd"].as_f64().unwrap() < got[w]["capacity"]["costUsd"].as_f64().unwrap());
    }
    assert_eq!(got["bindingWindow"], "none");
    assert!(got["verdict"].as_str().unwrap().contains("NEITHER window exhausts"), "{}", got["verdict"]);
    assert!(got["verdict"].as_str().unwrap().contains("plateaus at rate×length"), "{}", got["verdict"]);
}

/// The five reasons are DISTINCT outcomes, not shades of "unknown". Collapsing any two of them
/// loses the only information the caller can act on: "calibrate me" vs "you are over" vs "nothing
/// is burning" vs "this rate can never get there" vs "here is the countdown".
#[test]
fn every_eta_reason_is_reachable_and_says_something_different() {
    let cases = [
        (run(&IndexMap::new(), HALF_HOUR), "no-capacity"),
        (run(&cap(Some(500.0), Some(5000.0)), HALF_HOUR), "plateau"),
        (run(&cap(Some(4.0), Some(5000.0)), HALF_HOUR), "projected"),
        (run(&cap(Some(1.0), Some(5000.0)), HALF_HOUR), "over-limit"),
        (run(&cap(Some(500.0), Some(5000.0)), 60_000.0), "idle"),
    ];
    let mut humans: Vec<String> = Vec::new();
    for (got, reason) in &cases {
        assert_eq!(got["fiveHour"]["etaReason"], *reason);
        humans.push(got["fiveHour"]["etaHuman"].as_str().unwrap().to_owned());
    }
    let mut uniq = humans.clone();
    uniq.sort();
    uniq.dedup();
    assert_eq!(uniq.len(), humans.len(), "two reasons produced the same human string: {humans:?}");
}

/// An ALREADY-OVER window binds outright over a smaller positive ETA — "you are past the limit" is
/// not a countdown, and ranking it by minutes would let a 30-minute projection outrank it.
#[test]
fn an_over_limit_window_wins_the_binding_pick() {
    let got = run(&cap(Some(4.0), Some(5.0)), HALF_HOUR);
    assert_eq!(got["fiveHour"]["etaReason"], "projected");
    assert_eq!(got["fiveHour"]["etaMinutes"], 30.0);
    assert_eq!(got["sevenDay"]["etaReason"], "over-limit");
    assert_eq!(got["sevenDay"]["etaMinutes"], 0.0);
    assert_eq!(got["bindingWindow"], "7d", "the over-limit window binds despite the other having a finite ETA");
    assert!(got["verdict"].as_str().unwrap().contains("ALREADY at/over its cost limit"), "{}", got["verdict"]);
}

/// A cap of exactly 0 is NOT the same as no cap: `cap > 0` fails so `fillPct` is null (and renders
/// "undefined" in the text), while `remaining <= 0` makes the window over-limit. Two guards reading
/// the same number differently — a port that folded 0 into None would report 'no-capacity'.
#[test]
fn a_zero_cost_cap_is_over_limit_with_an_undetermined_fill() {
    let got = run(&cap(Some(0.0), Some(5000.0)), HALF_HOUR);
    assert_eq!(got["fiveHour"]["capacity"]["costUsd"], 0.0, "the cap is present and zero");
    assert_eq!(got["fiveHour"]["fillPct"], Value::Null, "cap > 0 fails ⇒ fill undetermined");
    assert_eq!(got["fiveHour"]["etaReason"], "over-limit", "remaining <= 0 ⇒ over, not 'no-capacity'");
    assert!(got["text"].as_str().unwrap().contains("(undefined%,"), "the template renders it literally: {}", got["text"]);
}

/// `humanEta` and `exhaustionEtaIso` read the UNROUNDED etaMinutes while the reported `etaMinutes`
/// field is `+x.toFixed(1)`. Rounding once up front would silently "fix" a discrepancy the TS
/// actually emits — and the ISO is the value a caller schedules against, so which one is rounded
/// matters.
#[test]
fn the_human_string_and_iso_read_the_unrounded_minutes() {
    let got = run(&cap(Some(4.0), Some(5000.0)), HALF_HOUR);
    let five = &got["fiveHour"];
    let iso = five["exhaustionEtaIso"].as_str().unwrap();
    let now = load("windoweta-expected.json")["nowMs"].as_f64().unwrap();
    let eta_ms = five["etaMinutes"].as_f64().unwrap() * 60_000.0;
    let iso_ms = agentlens_core::summarize::helpers::parse_iso_ms(iso).unwrap();
    // Within a minute of the rounded figure, but derived independently of it.
    assert!((iso_ms - (now + eta_ms)).abs() < 60_000.0, "iso={iso} etaMinutes={}", five["etaMinutes"]);
    assert_eq!(five["etaHuman"], "30m");
}

/// `Math.round(m % 60)` is half toward +∞ and runs INDEPENDENTLY of the `Math.floor(m / 60)` hour —
/// so 59.5 minutes renders "60m" and 1439.6 renders "23h 60m", not "1h 0m" and "24h 0m". Odd, and
/// exactly what the TS emits; a port that carried the rounded minutes into the hour would "fix" it.
#[test]
fn the_minute_rounding_does_not_carry_into_the_hour() {
    assert_eq!(human_eta(Some(59.5), "projected"), "60m");
    assert_eq!(human_eta(Some(1439.6), "projected"), "23h 60m");
    assert_eq!(human_eta(Some(60.0), "projected"), "1h 0m");
    assert_eq!(human_eta(Some(90.0), "projected"), "1h 30m");
    // A null with the 'projected' reason still renders, as 0m — the reason drives the branch.
    assert_eq!(human_eta(None, "projected"), "0m");
}

/// With no calibration anywhere the verdict must say WHY and how to fix it, rather than reporting a
/// blank ETA that reads like the windows are empty.
#[test]
fn no_capacity_explains_itself_and_names_the_remedy() {
    let got = run(&IndexMap::new(), HALF_HOUR);
    assert_eq!(got["bindingWindow"], "none");
    let v = got["verdict"].as_str().unwrap();
    assert!(v.contains("No cost capacity is calibrated"), "{v}");
    assert!(v.contains("AGENTLENS_WINDOW_5H_COST_USD"), "it names the env override: {v}");
    assert_eq!(got["fiveHour"]["etaHuman"], "unknown (no cost capacity calibrated for this account or a same-plan one)");
}

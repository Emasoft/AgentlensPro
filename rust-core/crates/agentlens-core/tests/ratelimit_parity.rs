//! Cross-engine parity for `get_rate_limit_report` (TRDD-DMWOBWFH P4x.2g). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-ratelimit-expected.mjs
//!
//! NO mtime oracle: hook events carry their own `ts` inside the ndjsonl line and the bucket is
//! selected by its FILENAME date, so nothing here depends on a file's mtime.
//!
//! The `investigate` seam is the TS's own, stubbed on both sides with the SAME investigation
//! object, so the report is a pure function of the fixture rather than of whatever bodies happen
//! to be on disk.

use std::path::PathBuf;

use agentlens_core::rate_limit_report::{build_rate_limit_report, RateLimitReportOptions};
use serde_json::Value;

fn fixtures() -> PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn oracle() -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join("ratelimit-expected.json")).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract `assert_eq!` cannot see, and the empty-window branch returns a
/// DIFFERENT key set (no `episodesTotal`, no `attributed`) — so a port that always emitted all six
/// with nulls would compare equal field by field and be wrong on the wire.
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

struct Case {
    name: &'static str,
    dir: &'static str,
    hours: Option<f64>,
    max_episodes: Option<f64>,
    throws: bool,
}

const CASES: &[Case] = &[
    Case { name: "main", dir: "ratelimit-hooks", hours: None, max_episodes: None, throws: false },
    Case { name: "maxEpisodes1", dir: "ratelimit-hooks", hours: None, max_episodes: Some(1.0), throws: false },
    Case { name: "clamped", dir: "ratelimit-hooks", hours: Some(9999.0), max_episodes: Some(999.0), throws: false },
    Case { name: "narrow", dir: "ratelimit-hooks", hours: Some(2.0), max_episodes: None, throws: false },
    Case { name: "empty", dir: "ratelimit-hooks-empty", hours: None, max_episodes: None, throws: false },
    Case { name: "threw", dir: "ratelimit-hooks", hours: None, max_episodes: None, throws: true },
];

fn run(c: &Case, o: &Value) -> Value {
    let inv = o["investigation"].clone();
    let investigate = |_h: f64, _u: f64, _m: f64| -> Result<Value, String> {
        if c.throws {
            // The TS stub throws `new Error('duckdb exploded')`; the port surfaces the message the
            // same way, through `attributed.error`.
            Err("duckdb exploded".to_owned())
        } else {
            Ok(inv.clone())
        }
    };
    build_rate_limit_report(
        &fixtures().join(c.dir),
        &RateLimitReportOptions {
            window_hours: c.hours,
            max_episodes: c.max_episodes,
            max_files: None,
        },
        o["nowMs"].as_f64().unwrap(),
        &investigate,
    )
}

#[test]
fn rate_limit_report_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for c in CASES {
        same(&run(c, &o), &o["cases"][c.name], c.name);
    }
}

/// THE TRAP, pinned so nobody "improves" it: `topFindings` reads `code`/`summary`/`detail`, and a
/// real BurnFinding carries NONE of them — so a realistic finding always comes out as a 160-char
/// JSON dump, not a readable label. The fixture holds both shapes so the two branches are
/// distinguished rather than assumed.
#[test]
fn top_findings_label_falls_back_to_a_json_dump_for_real_findings() {
    let o = oracle();
    let got = run(&CASES[0], &o);
    let tf = got["attributed"]["topFindings"].as_array().unwrap();
    assert_eq!(tf.len(), 4, "take(4) drops the fifth finding");
    assert_eq!(tf[0], "C1: a summary wins");
    // `summary ?? detail` is NULLISH, so an explicit null falls through to detail.
    assert_eq!(tf[1], "C2: detail is used when summary is nullish");
    // The realistic finding: no code/summary/detail ⇒ the dump.
    let dump = tf[2].as_str().unwrap();
    assert!(dump.starts_with("{\"cause\":\"FORK_STORM\""), "a real finding dumps as JSON: {dump}");
    assert!(agentlens_core::summarize::helpers::utf16_len(dump) <= 160, "dump is capped at 160 UTF-16 units");
    // A non-null NON-STRING summary suppresses detail AND fails the string filter, so only `code`
    // survives — neither "C4: 42" nor "C4: suppressed…".
    assert_eq!(tf[3], "C4");
}

/// One rate-limit incident kills many turns as sessions retry into the wall, so events ≤600s apart
/// are ONE episode. The fixture sits exactly ON the boundary in both directions.
#[test]
fn episode_grouping_is_inclusive_at_the_600s_boundary() {
    let o = oracle();
    let got = run(&CASES[0], &o);
    assert_eq!(got["episodesTotal"], 3, "600s apart joins, 601s splits");
    let eps = got["episodes"].as_array().unwrap();
    // `.slice(-max).reverse()` ⇒ NEWEST FIRST.
    assert_eq!(eps[0]["startIso"], "2026-08-20T14:00:00.000Z", "newest episode leads");
    assert_eq!(eps[2]["startIso"], "2026-08-20T10:00:00.000Z");
    assert_eq!(eps[2]["events"], 3, "e1+e2+e3 are one episode");

    // FIRST record per session wins: s1 died twice in episode 1 and must appear ONCE, with the
    // EARLIER error. Listing the later one would report a stale cause for the incident.
    let sessions = eps[2]["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 2, "s1 listed once despite dying twice");
    assert_eq!(sessions[0]["session"], "s1");
    assert_eq!(sessions[0]["error"], "rate limit reached, retry after 300s");

    // `.slice(0, 200)` is UTF-16: 125 emoji = 250 units, cut to 200 = 100 emoji, and the tail must
    // be gone. A byte-indexed cut would keep a different amount.
    let long = sessions[1]["error"].as_str().unwrap();
    assert_eq!(agentlens_core::summarize::helpers::utf16_len(long), 200);
    assert!(!long.contains("TAIL"), "truncated before the tail marker");
    assert_eq!(long.chars().count(), 100, "the cut lands between characters, never inside a pair");
}

/// An empty result is NOT proof no stall happened — it is equally "hook capture was never
/// installed". Both empty cases must say so, and must NOT carry an attribution.
#[test]
fn an_empty_window_says_it_might_be_blind_rather_than_all_clear() {
    let o = oracle();
    for name in ["narrow", "empty"] {
        let c = CASES.iter().find(|c| c.name == name).unwrap();
        let got = run(c, &o);
        assert_eq!(keys(&got), ["window", "stallEvents", "episodes", "note"], "{name}: reduced key set");
        assert_eq!(got["stallEvents"], 0);
        assert!(got["note"].as_str().unwrap().contains("hook capture is not installed"), "{name}");
    }
    // `narrow` proves it is the WINDOW filtering, not an empty store: the same dir yields 5 events
    // at 24h. Without that, a broken reader would look identical to a correctly-narrow window.
    assert_eq!(run(&CASES[0], &o)["stallEvents"], 5);
}

/// The attribution is a bounded scan that can fail; a failure must become an honest `error` field
/// on the report, never a lost report or a fabricated attribution.
#[test]
fn a_failed_attribution_scan_is_reported_not_swallowed() {
    let o = oracle();
    let got = run(CASES.iter().find(|c| c.name == "threw").unwrap(), &o);
    assert_eq!(keys(&got["attributed"]), ["episodeStartIso", "error"], "the error shape has no verdict");
    assert_eq!(got["attributed"]["error"], "attribution scan failed: duckdb exploded");
    // The episodes themselves still made it — a failed scan must not cost the caller the stalls.
    assert_eq!(got["episodesTotal"], 3);
}

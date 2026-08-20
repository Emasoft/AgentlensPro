//! Cross-engine parity for `get_session_burn_profile` (TRDD-DMWOBWFH P4x.2d). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-sbprofile-expected.mjs
//!
//! MTIME ORACLE: the gap histogram, the window filter and `lastCallMinutesAgo` are ALL functions of
//! the fixture's mtime spacing, and git does not preserve mtimes — the generator stamps a fixed
//! table and publishes it; this test re-stamps from it.
//!
//! Every absolute path is REDACTED to `<BODIES>` / `<MISSING>`; the Rust side applies the same
//! substitution before comparing.

use std::path::PathBuf;

use agentlens_core::session_burn_profile::{
    build_session_burn_profile, extract_tool_names, session_id_of, SessionBurnProfileOptions,
};
use serde_json::Value;

fn fixtures() -> PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}
fn bodies() -> PathBuf {
    fixtures().join("sbprofile-bodies")
}
fn missing_dir() -> PathBuf {
    fixtures().join("no-such-sbprofile-dir")
}

fn oracle() -> Value {
    let o: Value =
        serde_json::from_str(&std::fs::read_to_string(fixtures().join("sbprofile-expected.json")).unwrap()).unwrap();
    let dir = bodies();
    for (name, ms) in o["mtimes"].as_object().unwrap() {
        let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(ms.as_f64().unwrap() as u64);
        let f = std::fs::OpenOptions::new().append(true).open(dir.join(name)).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
    }
    o
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract `assert_eq!` cannot see (`preserve_order` makes `Value::Object` an
/// IndexMap whose `PartialEq` ignores order). The profile is 26 top-level keys with five nested
/// objects, so a port that assembled the same numbers in a different order would pass a naive
/// comparison while shipping a different payload.
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

fn strip(v: &Value) -> Value {
    let s = v
        .to_string()
        .replace(&bodies().to_string_lossy().into_owned(), "<BODIES>")
        .replace(&missing_dir().to_string_lossy().into_owned(), "<MISSING>");
    serde_json::from_str(&s).unwrap()
}

fn profile(o: &Value, session_id: &str, window_hours: Option<f64>) -> Value {
    let opts = SessionBurnProfileOptions { session_id: session_id.to_owned(), window_hours };
    strip(&build_session_burn_profile(&bodies(), &opts, o["nowMs"].as_f64().unwrap()))
}

fn names(v: &Value) -> Vec<String> {
    v.as_array().unwrap().iter().map(|s| s.as_str().unwrap().to_owned()).collect()
}

#[test]
fn extract_tool_names_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let e = &o["extractToolNames"];
    let raw_with_brackets =
        serde_json::json!({ "tools": [{ "name": "A", "description": "has ] and [ inside" }, { "name": "B" }], "x": 1 })
            .to_string();
    // A bracket inside a STRING must not end the bracket match — that is the whole reason the
    // scanner skips string bodies instead of counting brackets naively.
    assert_eq!(extract_tool_names(&raw_with_brackets), names(&e["withBracketsInString"]));
    let raw_nested = serde_json::json!({ "tools": [{ "name": "A", "input_schema": { "items": [{ "name": "nested" }] } }] })
        .to_string();
    // The nested name IS included: this is a cheap fingerprint, not a parser, and the fingerprint
    // it takes is what both engines must agree on.
    assert_eq!(extract_tool_names(&raw_nested), names(&e["nested"]));
    assert_eq!(extract_tool_names(r#"{"messages":[]}"#), names(&e["noToolsKey"]));
    assert_eq!(extract_tool_names(r#"{"tools":[]}"#), names(&e["emptyArray"]));
    // An unterminated array yields NOTHING rather than a partial fingerprint that would read as a
    // tool-set change on the next turn.
    assert_eq!(extract_tool_names(r#"{"tools":[{"name":"A"}"#), names(&e["unterminated"]));
}

#[test]
fn session_id_comes_from_user_id_never_from_conversation_text() {
    let o = oracle();
    let e = &o["sessionIdOf"];
    let sess_a = o["sessions"]["a"].as_str().unwrap();
    let other = o["sessions"]["other"].as_str().unwrap();
    let opt = |k: &str| e[k].as_str().map(str::to_owned);

    let ok = serde_json::json!({ "metadata": { "user_id": serde_json::json!({ "session_id": sess_a }).to_string() } })
        .to_string();
    assert_eq!(session_id_of(&ok), opt("ok"));

    // THE REGRESSION this function exists for: a body whose conversation text MENTIONS a different
    // session id must still resolve to its own. A naive scan for the first "session_id" returned
    // byte-identical profiles for two different queries.
    let mention = serde_json::json!({
        "messages": [{ "content": format!("see \"session_id\":\"{other}\"") }],
        "metadata": { "user_id": serde_json::json!({ "session_id": sess_a }).to_string() },
    })
    .to_string();
    assert_eq!(session_id_of(&mention), opt("textMention"));
    assert_eq!(session_id_of(&mention).as_deref(), Some(sess_a));
    assert_ne!(session_id_of(&mention).as_deref(), Some(other));

    // Fail-CLOSED: absent, unparseable, or present-without-the-field are all None, never a guess.
    assert_eq!(session_id_of(r#"{"messages":[]}"#), opt("noUserId"));
    assert_eq!(session_id_of(r#"{"metadata":{"user_id":"not-json"}}"#), opt("badBlob"));
    let no_field = serde_json::json!({ "metadata": { "user_id": r#"{"account_uuid":"x"}"# } }).to_string();
    assert_eq!(session_id_of(&no_field), opt("noSessionField"));
}

#[test]
fn session_burn_profile_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let sess_a = o["sessions"]["a"].as_str().unwrap().to_owned();
    let sess_b = o["sessions"]["b"].as_str().unwrap().to_owned();
    same(&profile(&o, &sess_a, None), &o["profileDefault"], "profileDefault");
    // A short unique PREFIX resolves the same session — `startsWith`, not equality.
    same(&profile(&o, "aaaaaaaa", None), &o["profileByPrefix"], "profileByPrefix");
    // The other session is a DIFFERENT profile, not a filtered view of the same one. (Before the
    // sessionIdOf fix, two different queries returned byte-identical profiles.)
    let b = profile(&o, &sess_b, None);
    same(&b, &o["profileSessionB"], "profileSessionB");
    assert_ne!(b["requests"], o["profileDefault"]["requests"]);
    same(&profile(&o, &sess_a, Some(0.5)), &o["profileNarrowWindow"], "profileNarrowWindow");
}

#[test]
fn the_diagnostic_branches_are_all_reached() {
    let o = oracle();
    let p = profile(&o, o["sessions"]["a"].as_str().unwrap(), None);
    // Every gap bucket fires — a green suite over a histogram that only ever filled one bucket
    // would gate almost nothing.
    for k in ["under10s", "s10to30", "s30to60", "m1to5", "over5m"] {
        assert!(p["gapHistogram"][k].as_f64().unwrap() > 0.0, "gap bucket {k} never fired: {}", p["gapHistogram"]);
    }
    // The chain is off by one BY DESIGN: turn i's usage sits on turn i+1's previous_message_id, so
    // the last request is unusable. 7 requests, 6 contributing creates.
    assert_eq!(p["requests"].as_f64().unwrap(), 7.0);
    assert_eq!(p["cacheCreateMedian"].as_f64().unwrap(), 14000.0);
    // The decisive diagnostic: a median BELOW the 20k floor with a p90 far above it is
    // stable-and-appending with the total concentrated in a few break events — not a per-turn
    // rewrite. Collapsing these two into one "average" is exactly what hides the difference.
    assert!(p["cacheCreateMedian"].as_f64().unwrap() < 20_000.0);
    assert!(p["cacheCreateP90"].as_f64().unwrap() > 100_000.0);
    assert!(p["createConcentrationPct"].as_f64().unwrap() > 90.0);
    // Weighted: raw reads outnumber writes 3.5:1, yet the WRITE term dominates the bill (1.25x vs
    // 0.1x). Ranking by raw tokens would name the wrong culprit.
    assert!(p["cacheReadTotal"].as_f64().unwrap() > 3.0 * p["cacheCreateTotal"].as_f64().unwrap());
    assert_eq!(p["weighted"]["dominantTerm"], "prefix-rewrite");
    // Cold calls exist but stay under the 50% floor, so the cold-loop remediation must NOT appear.
    assert!(p["coldCalls"].as_f64().unwrap() > 0.0 && p["coldPct"].as_f64().unwrap() < 50.0);
    let rem = p["remediation"].as_array().unwrap();
    assert!(!rem.iter().any(|r| r.as_str().unwrap().contains("never warms")), "cold remediation fired below the floor");
    // tools[] instability IS the finding here, and all four change shapes were seen.
    let stab = &p["toolStability"];
    assert_eq!(stab["turnsChanged"].as_f64().unwrap(), 4.0);
    let sources: Vec<&str> =
        stab["culpritSources"].as_array().unwrap().iter().map(|c| c["source"].as_str().unwrap()).collect();
    assert!(sources.contains(&"MCP: srv") && sources.contains(&"built-in"));
    // A pure REORDER of an identical set still invalidates the prefix, so it must be counted.
    assert!(sources.iter().any(|s| s.starts_with("(reorder")), "the reorder branch never fired: {sources:?}");
    assert!(rem[0].as_str().unwrap().starts_with("MAKE tools[] FIXED"));
    // A deferred BUILT-IN gets its own bySource bucket, which `sourceOf` in the stability diff
    // deliberately does not produce — the two classifiers answer different questions.
    let by_source: Vec<&str> =
        p["toolSurface"]["bySource"].as_array().unwrap().iter().map(|r| r["source"].as_str().unwrap()).collect();
    assert!(by_source.contains(&"built-in (deferred)"), "{by_source:?}");
    assert!(!sources.contains(&"built-in (deferred)"));
}

#[test]
fn the_empty_profiles_distinguish_a_missing_dir_from_a_missing_session() {
    let o = oracle();
    let none = profile(&o, "no-such-session", None);
    same(&none, &o["profileUnknownSession"], "profileUnknownSession");
    // The dir WAS there; the session was not. Reporting dirExists:false here would send the caller
    // to fix their capture config for a session that simply had no traffic.
    assert_eq!(none["coverage"]["dirExists"], true);
    assert_eq!(none["requests"].as_f64().unwrap(), 0.0);
    // `lastCallMinutesAgo: null` — there was no last call, which is NOT "0 minutes ago".
    assert!(none["lastCallMinutesAgo"].is_null());

    let opts = SessionBurnProfileOptions {
        session_id: o["sessions"]["a"].as_str().unwrap().to_owned(),
        window_hours: None,
    };
    let missing = strip(&build_session_burn_profile(&missing_dir(), &opts, o["nowMs"].as_f64().unwrap()));
    same(&missing, &o["profileMissingDir"], "profileMissingDir");
    assert_eq!(missing["coverage"]["dirExists"], false);
    assert!(missing["coverage"]["note"].as_str().unwrap().contains("OTEL_LOG_RAW_API_BODIES"));
}

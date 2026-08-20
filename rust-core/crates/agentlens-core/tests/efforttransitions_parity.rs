//! Cross-engine parity for the effort-transition detector (TRDD-DMWOBWFH P4x.2d). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-efforttransitions-expected.mjs
//!
//! MTIME ORACLE: `scan_effort_transitions` skips a file whose mtime predates `since_ms`, and git
//! does NOT preserve mtimes — a fresh clone stamps every fixture with checkout time, so the skip
//! would never fire. The generator stamps a fixed table and PUBLISHES it; this test re-stamps from
//! that same published table rather than hardcoding a second copy that could drift out of step.

use std::path::PathBuf;

use agentlens_core::effort_transitions::{
    effort_observation, effort_transition_as_risk_command, effort_transitions_of, scan_effort_transitions, Observation,
};
use agentlens_core::summarize::helpers::num;
use serde_json::{json, Value};

fn fixtures() -> PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn oracle() -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join("efforttransitions-expected.json")).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract `assert_eq!` cannot see (`preserve_order` makes `Value::Object` an
/// IndexMap whose `PartialEq` ignores order). It is load-bearing here because `model` (and `args`
/// on the risk-command projection) is assigned AFTER the object literal, so it must land LAST — and
/// must be ABSENT, not null, when the record carried none.
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
fn repin_mtimes(o: &Value) -> Vec<PathBuf> {
    let slug = fixtures().join("effort-home/projects/proj-a");
    for (name, ms) in o["mtimes"].as_object().unwrap() {
        let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(ms.as_f64().unwrap() as u64);
        let f = std::fs::OpenOptions::new().append(true).open(slug.join(name)).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
    }
    vec![fixtures().join("effort-home/projects")]
}

/// The oracle stores an observation as the JS object literal, where an absent `model` DROPS the key.
fn obs_value(o: &Observation) -> Value {
    let mut m = serde_json::Map::new();
    // `num`, not `json!` — JSON.stringify writes an integral epoch as `1754042400000`, and
    // serde_json's Number equality does NOT bridge PosInt and Float, so a bare f64 fails to match.
    m.insert("ts".into(), num(o.ts));
    m.insert("effort".into(), Value::String(o.effort.clone()));
    if let Some(x) = &o.model {
        m.insert("model".into(), Value::String(x.clone()));
    }
    Value::Object(m)
}

/// THE ABSENT-VALUE RULE, one case per rejection reason. Only an EXPLICIT non-empty string `effort`
/// yields an observation: a record predating CC 2.1.212 carries none, so absent→present is the
/// FIELD APPEARING rather than the user changing anything, and counting it would manufacture one
/// false invalidation per session at the exact upgrade boundary — across all history.
#[test]
fn effort_observation_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, v) in o["observations"].as_object().unwrap() {
        let got = effort_observation(&v["entry"]).as_ref().map_or(Value::Null, obs_value);
        same(&got, &v["out"], case);
    }
    // Spelled out, because the bulk loop above passes just as well if every case returns null.
    assert!(effort_observation(&o["observations"]["ok"]["entry"]).is_some());
    for reject in ["notAssistant", "effortAbsent", "effortEmpty", "effortNotString", "tsAbsent", "tsNotString", "tsUnparseable"] {
        assert!(effort_observation(&o["observations"][reject]["entry"]).is_none(), "{reject} must be rejected");
    }
}

#[test]
fn effort_transitions_of_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, v) in o["pure"].as_object().unwrap() {
        let records: Vec<(Value, Observation)> = v["records"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(|e| effort_observation(e).map(|obs| (e.clone(), obs)))
            .collect();
        same(&Value::Array(effort_transitions_of(&records)), &v["out"], case);
    }
}

#[test]
fn effort_transition_as_risk_command_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let with_model = json!({"ts": 1, "session": "s1", "from": "xhigh", "to": "low", "sidechain": false, "model": "claude-opus-5"});
    let no_model = json!({"ts": 1, "session": "s1", "from": "xhigh", "to": "low", "sidechain": false});
    same(&effort_transition_as_risk_command(&with_model), &o["asRiskCommand"], "asRiskCommand");
    same(&effort_transition_as_risk_command(&no_model), &o["asRiskCommandNoModel"], "asRiskCommandNoModel");
}

#[test]
fn scan_effort_transitions_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let dirs = repin_mtimes(&o);
    let since_mtime = o["sinceMtimeSkip"].as_f64().unwrap();
    let since_post = o["sincePostFilter"].as_f64().unwrap();
    for (case, since, limit, sidechain) in [
        ("scanAll", None, None, false),
        ("scanWithSidechain", None, None, true),
        ("scanSinceMtimeSkip", Some(since_mtime), None, false),
        ("scanSincePostFilter", Some(since_post), None, false),
        ("scanLimited", None, Some(2usize), false),
        ("scanSidechainAndLimit", None, Some(3usize), true),
    ] {
        same(&Value::Array(scan_effort_transitions(&dirs, since, limit, sidechain)), &o[case], case);
    }
}

/// THE FIRST OBSERVATION ESTABLISHES THE BASELINE AND EMITS NOTHING. A first sighting is not a
/// change; treating it as one manufactures exactly one false event per session, which across a
/// 12k-file history is thousands of invented cache breaks.
#[test]
fn the_first_observation_in_a_partition_emits_nothing() {
    let o = oracle();
    let out = o["pure"]["simple"]["out"].as_array().unwrap();
    assert_eq!(out.len(), 2, "4 records, 3 adjacent pairs, 2 of which differ: {out:?}");
    assert_eq!(out[0]["from"], "low");
    assert_eq!(out[0]["to"], "xhigh");
    // A single observation can never be a transition, whatever its value.
    let one: Vec<(Value, Observation)> = o["pure"]["simple"]["records"].as_array().unwrap()[..1]
        .iter()
        .filter_map(|e| effort_observation(e).map(|obs| (e.clone(), obs)))
        .collect();
    assert!(effort_transitions_of(&one).is_empty());
}

/// PARTITION BY (session, sidechain). A subagent runs at its OWN effort and its records interleave
/// into the parent's transcript, so differencing across the boundary invents TWO transitions per
/// subagent — one in, one out — that never happened. And `isSidechain === true` is STRICT: a truthy
/// non-boolean stays in the MAIN partition, because a coerced test would silently move a parent's
/// turn into the subagent bucket.
#[test]
fn sidechain_turns_are_a_separate_partition_and_the_test_is_strict() {
    let o = oracle();
    let part = o["pure"]["sidechainPartitioned"]["out"].as_array().unwrap();
    assert_eq!(part.len(), 1, "only the side-internal change; no main↔side crossings: {part:?}");
    assert_eq!(part[0]["sidechain"], true);
    assert_eq!((part[0]["from"].as_str(), part[0]["to"].as_str()), (Some("medium"), Some("high")));

    let truthy = o["pure"]["sidechainTruthyIsNotTrue"]["out"].as_array().unwrap();
    assert_eq!(truthy.len(), 1);
    assert_eq!(truthy[0]["sidechain"], false, "isSidechain: 1 is TRUTHY but not === true");
}

/// TIME order, not FILE order. `sess-resume.jsonl` holds a record timestamped BETWEEN two records of
/// `sess-main.jsonl` (one session can span several files — a resume writes a new one). File-order
/// differencing produces the same COUNT with different from/to pairs, so only comparing the values
/// catches it.
#[test]
fn a_bucket_is_differenced_in_time_order_across_files() {
    let o = oracle();
    let dirs = repin_mtimes(&o);
    let all = scan_effort_transitions(&dirs, None, None, false);
    let main: Vec<(&str, &str)> = all
        .iter()
        .filter(|t| t["session"] == "sess-main")
        .map(|t| (t["from"].as_str().unwrap(), t["to"].as_str().unwrap()))
        .collect();
    // Newest-first: 10:10 low→xhigh, 10:05 medium→low, 10:04 xhigh→medium. File order would have
    // given xhigh→low then low→medium — same count, wrong story.
    assert_eq!(main, vec![("low", "xhigh"), ("medium", "low"), ("xhigh", "medium")], "{main:?}");
}

/// `model` is appended AFTER the object literal, so it lands LAST — and is DROPPED when the record
/// carries none, or carries a non-string one. A `?? null` port would keep the key and change the
/// shape; a port that inserted it in declaration order would move it.
#[test]
fn the_model_key_is_appended_last_and_dropped_when_absent() {
    let o = oracle();
    let dirs = repin_mtimes(&o);
    let all = scan_effort_transitions(&dirs, None, None, false);
    let with_model = all.iter().find(|t| t["session"] == "sess-other").unwrap();
    assert_eq!(keys(with_model), ["ts", "session", "from", "to", "sidechain", "model"], "{with_model}");
    // The 10:10 record of sess-main has no `message` at all.
    let no_model = all.iter().find(|t| t["session"] == "sess-main" && t["to"] == "xhigh").unwrap();
    assert_eq!(keys(no_model), ["ts", "session", "from", "to", "sidechain"], "{no_model}");
    // sess-edge's later record carries `message.model: 123` — a non-string is not a model.
    let non_string = all.iter().find(|t| t["session"] == "sess-edge").unwrap();
    assert_eq!(keys(non_string), ["ts", "session", "from", "to", "sidechain"], "{non_string}");
}

/// Both post-filters run AFTER the differencing, never before. Dropping records first would
/// difference across the hole and report a transition between two turns that were never adjacent —
/// so `sinceMs` narrows the RESULT, while the mtime skip (a whole-file gate) narrows the INPUT.
#[test]
fn the_since_filters_are_a_file_gate_and_a_result_gate() {
    let o = oracle();
    let dirs = repin_mtimes(&o);
    let since_mtime = o["sinceMtimeSkip"].as_f64().unwrap();
    let since_post = o["sincePostFilter"].as_f64().unwrap();

    let all = scan_effort_transitions(&dirs, None, None, false);
    assert!(all.iter().any(|t| t["session"] == "sess-old"), "sess-old is present without a since");

    let gated = scan_effort_transitions(&dirs, Some(since_mtime), None, false);
    assert!(!gated.iter().any(|t| t["session"] == "sess-old"), "its mtime predates sinceMs ⇒ the FILE is skipped");
    assert_eq!(gated.len(), all.len() - 1, "nothing else changes: {gated:?}");

    let post = scan_effort_transitions(&dirs, Some(since_post), None, false);
    assert!(post.iter().all(|t| t["ts"].as_f64().unwrap() >= since_post), "{post:?}");
    // The surviving rows still carry the from/to they had in the full run — proof the filter ran on
    // the RESULT, not on the records (which would have differenced across the removed turns).
    let full_main = all.iter().find(|t| t["session"] == "sess-main" && t["ts"].as_f64().unwrap() >= since_post).unwrap();
    let post_main = post.iter().find(|t| t["session"] == "sess-main").unwrap();
    assert_eq!(post_main, full_main);
}

/// A file with no `"effort"` substring is skipped before any line of it is parsed — the cheap gate
/// that makes a 12k-file history scan affordable. Nothing from sess-noeffort can appear.
#[test]
fn a_file_without_the_effort_substring_is_never_parsed() {
    let o = oracle();
    let dirs = repin_mtimes(&o);
    let all = scan_effort_transitions(&dirs, None, None, true);
    assert!(!all.iter().any(|t| t["session"] == "sess-noeffort"), "{all:?}");
}

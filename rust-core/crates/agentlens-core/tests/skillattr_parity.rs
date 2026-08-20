//! Cross-engine parity for `get_skill_attribution` (TRDD-DMWOBWFH P4x.2d). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-skillattr-expected.mjs
//!
//! Both engines read the SAME committed transcripts under `tests/fixtures/skillattr-home/`, passed
//! as an explicit root, so no test touches the real `~/.claude`.

use std::path::PathBuf;

use agentlens_core::skill_attribution::{build_attribution_report, get_skill_attribution};
use serde_json::Value;

/// 2026-08-01T10:07:00Z — mid-fixture, splitting sess-a so `pack:alpha` keeps its later messages
/// and loses its duplicated one. MUST match the generator's own `windowed` boundary: driving the
/// two engines over different windows compares nothing while still looking like a parity test.
const SINCE: f64 = 1_785_578_820_000.0;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/skillattr-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn dirs() -> Vec<PathBuf> {
    vec![std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/skillattr-home")]
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract and `assert_eq!` cannot see it: with `preserve_order` a
/// `Value::Object` is an IndexMap whose `PartialEq` ignores order. Every comparison here asserts
/// the key list explicitly, at both the report and the per-rollup level.
fn same_report(got: &Value, exp: &Value, label: &str) {
    assert_eq!(keys(got), keys(exp), "{label}: report key set/ORDER differs");
    for list in ["bySkill", "byPlugin"] {
        let (g, e) = (got[list].as_array().unwrap(), exp[list].as_array().unwrap());
        assert_eq!(g.len(), e.len(), "{label}.{list}: length");
        for (i, (gr, er)) in g.iter().zip(e).enumerate() {
            assert_eq!(keys(gr), keys(er), "{label}.{list}[{i}]: rollup key set/ORDER differs");
            assert_eq!(gr, er, "{label}.{list}[{i}]");
        }
    }
    for (k, ev) in exp.as_object().unwrap() {
        assert_eq!(&got[k], ev, "{label}.{k}");
    }
}

#[test]
fn build_attribution_report_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let d = dirs();
    same_report(&build_attribution_report(&d, None, None, o["nowMs"].as_f64().unwrap()), &o["report"], "report");
    let since = SINCE; // 2026-08-01T10:07:00Z — mid-fixture, splitting sess-a.
    same_report(&build_attribution_report(&d, Some(since), None, o["nowMs"].as_f64().unwrap()), &o["windowed"], "windowed");
}

/// THE DEDUPE IS THE WHOLE REPORT'S CREDIBILITY. `msg_aaaa1111` is ONE message written as THREE
/// JSONL rows, each repeating the FULL usage — the shape Claude Code actually writes (one row per
/// content block). A per-row sum triples it, and does so worst on exactly the tool-heavy sessions
/// this report exists to explain. So: counted once, and the collapsed rows are REPORTED, because a
/// silent dedupe is indistinguishable from data loss.
#[test]
fn usage_is_counted_once_per_message_id_and_the_skipped_rows_are_reported() {
    let o = oracle();
    let got = build_attribution_report(&dirs(), None, None, o["nowMs"].as_f64().unwrap());
    assert_eq!(got["duplicateRowsSkipped"], 2, "the two extra rows of msg_aaaa1111 must be counted, not hidden");
    let alpha = got["bySkill"].as_array().unwrap().iter().find(|r| r["name"] == "pack:alpha").unwrap().clone();
    // 4 distinct messages, NOT the 6 attributed rows the file carries for this skill.
    assert_eq!(alpha["messages"], 4, "{alpha}");
    // The one deduped message contributes 1000+200+500 input, not 3000+200+500.
    assert_eq!(alpha["inputTokens"], 1700, "a per-ROW sum would read 3700 here: {alpha}");
    assert_eq!(alpha["cacheReadTokens"], 14000, "{alpha}");
}

/// The timestamp filter runs BEFORE the dedupe, so a windowed run that cuts all three rows of a
/// duplicated message reports ZERO skipped rows rather than still claiming 2. Ordering the two the
/// other way would leak out-of-window rows into the duplicate counter.
#[test]
fn the_window_filter_runs_before_the_dedupe() {
    let o = oracle();
    let since = SINCE;
    let got = build_attribution_report(&dirs(), Some(since), None, o["nowMs"].as_f64().unwrap());
    assert_eq!(got["duplicateRowsSkipped"], 0, "all 3 rows of msg_aaaa1111 are out of window: {got}");
}

/// An attributed message with no `usage` block is still ATTRIBUTED — counted, just not priced — so
/// `attributedMessages` never silently shrinks to only the priceable ones and the coverage ratio
/// (priced vs attributed) stays honest. `usage: 5` is the mirror case: truthy but not an object, so
/// the TS prices it at $0 rather than dropping it, and an `is_object()` port would disagree.
#[test]
fn an_unpriced_message_still_counts_as_attributed() {
    let o = oracle();
    let got = build_attribution_report(&dirs(), None, None, o["nowMs"].as_f64().unwrap());
    let (a, p) = (got["attributedMessages"].as_f64().unwrap(), got["pricedMessages"].as_f64().unwrap());
    assert!(a > p, "the fixture has unpriced attributed messages, so these must differ: {a} vs {p}");
    assert_eq!((a, p), (10.0, 7.0), "{got}");
    let gamma = got["bySkill"].as_array().unwrap().iter().find(|r| r["name"] == "other:gamma").unwrap();
    assert_eq!(gamma["costUsd"], 0, "a truthy non-object usage prices to zero, it is not dropped: {gamma}");
}

/// `models` is ranked most-used-first — that is what makes the field answer "what is this skill
/// actually running on". Insertion order alone would report whichever model happened to appear
/// first. `pack:alpha` is opus x3 / sonnet x1 in a file that mentions sonnet in the MIDDLE, so a
/// first-seen ordering is distinguishable from a count ordering.
#[test]
fn models_are_ranked_most_used_first() {
    let o = oracle();
    let got = build_attribution_report(&dirs(), None, None, o["nowMs"].as_f64().unwrap());
    let alpha = got["bySkill"].as_array().unwrap().iter().find(|r| r["name"] == "pack:alpha").unwrap();
    assert_eq!(alpha["models"], serde_json::json!(["claude-opus-5", "claude-sonnet-5"]), "{alpha}");
}

/// An EMPTY stamp is falsy in the TS, at both the guard and the accumulate site. Porting the guard
/// as `is_none()` would let `""` through and mint a rollup literally named "" — while the row's
/// PLUGIN, which is non-empty, must still count.
#[test]
fn an_empty_stamp_mints_no_rollup_but_its_plugin_still_counts() {
    let o = oracle();
    let got = build_attribution_report(&dirs(), None, None, o["nowMs"].as_f64().unwrap());
    assert!(got["bySkill"].as_array().unwrap().iter().all(|r| r["name"] != ""), "{got}");
    let other = got["byPlugin"].as_array().unwrap().iter().find(|r| r["name"] == "other").unwrap();
    // msg_cccc2222's 100 input tokens reach the plugin rollup even though its skill stamp is empty:
    // the plugin's 6 messages are beta x2, gamma, delta, epsilon — and this empty-skill one.
    assert_eq!(other["messages"], 6, "{other}");
    assert_eq!(other["inputTokens"], 3140, "3000 + 40 + this row's 100: {other}");
}

/// `firstTs`/`lastTs` are OMITTED, not nulled, when nothing parseable was seen — `other:epsilon`'s
/// only row has an unparseable timestamp. A `?? null` port would emit 0 or null there, which reads
/// as "1970" / "known to be absent" rather than "never observed".
#[test]
fn timestamps_are_omitted_when_none_parsed() {
    let o = oracle();
    let got = build_attribution_report(&dirs(), None, None, o["nowMs"].as_f64().unwrap());
    let eps = got["bySkill"].as_array().unwrap().iter().find(|r| r["name"] == "other:epsilon").unwrap();
    assert_eq!(keys(eps).last(), Some(&"models"), "firstTs/lastTs must be ABSENT, not null: {eps}");
    let beta = got["bySkill"].as_array().unwrap().iter().find(|r| r["name"] == "other:beta").unwrap();
    assert!(beta.get("firstTs").is_some() && beta.get("lastTs").is_some(), "{beta}");
}

/// `Math.max(1, topN)` — a 0 or negative cap floors to 1 rather than emptying the report, and there
/// is no upper clamp. An absent topN means UNCAPPED, not a default page size.
#[test]
fn top_n_floors_to_one_and_is_absent_by_default() {
    let o = oracle();
    let now = o["nowMs"].as_f64().unwrap();
    let d = dirs();
    same_report(&build_attribution_report(&d, None, Some(1.0), now), &o["capped1"], "capped1");
    same_report(&build_attribution_report(&d, None, Some(0.0), now), &o["capped0"], "capped0");
    same_report(&build_attribution_report(&d, None, Some(-5.0), now), &o["cappedNeg"], "cappedNeg");
}

/// A root that does not exist is skipped, not fatal. A machine with no transcripts is a real
/// answer; erroring there would read as "the probe failed" and hide a legitimate zero.
#[test]
fn a_missing_root_yields_an_empty_report_not_an_error() {
    let o = oracle();
    let missing = vec![std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/skillattr-home-does-not-exist")];
    same_report(&build_attribution_report(&missing, None, None, o["nowMs"].as_f64().unwrap()), &o["missingRoot"], "missingRoot");
}

/// The tool layer. `windowHours` keeps its ORIGINAL position (the spread already placed it) and the
/// two guards deliberately differ: sinceMs is derived under a TRUTHY test while windowHours is
/// assigned under a NULLISH one — so `window: 0` means "no window at all" AND `windowHours: 0`.
/// Collapsing them to one test would either lose the whole-history data or report null.
#[test]
fn get_skill_attribution_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let now = o["nowMs"].as_f64().unwrap();
    let d = dirs();
    same_report(&get_skill_attribution(&d, None, None, now), &o["toolFull"], "toolFull");
    same_report(&get_skill_attribution(&d, Some(1.0), None, now), &o["toolWindow1h"], "toolWindow1h");
    same_report(&get_skill_attribution(&d, Some(0.0), None, now), &o["toolZeroWindow"], "toolZeroWindow");
    same_report(&get_skill_attribution(&d, None, Some(1.0), now), &o["toolTop1"], "toolTop1");

    let zero = get_skill_attribution(&d, Some(0.0), None, now);
    assert_eq!(zero["windowHours"], 0, "nullish, so 0 survives as 0");
    assert_eq!(zero["attributedMessages"], o["report"]["attributedMessages"], "truthy, so 0 means NO window: {zero}");
    assert_eq!(keys(&zero).last(), Some(&"windowHours"), "the overwrite must not move the key: {zero}");
}

/// The mtime pre-filter, asserted as a PROPERTY rather than against the oracle: git does not
/// preserve mtimes, so a committed fixture cannot pin it. A freshly written file's mtime is ~now,
/// so a `since` in the future must skip the whole file — which is exactly the cheap filter that
/// makes a windowed scan over a full history affordable.
#[test]
fn a_file_older_than_the_window_is_skipped_by_mtime() {
    let root = std::env::temp_dir().join(format!("alens-skillattr-{}", std::process::id()));
    let slug = root.join("proj");
    std::fs::create_dir_all(&slug).unwrap();
    let f = slug.join("s.jsonl");
    std::fs::write(
        &f,
        r#"{"type":"assistant","attributionSkill":"pack:alpha","timestamp":"2026-08-01T10:00:00.000Z","message":{"id":"msg_aaaa9999","model":"claude-opus-5","usage":{"input_tokens":10,"cache_read_input_tokens":0,"cache_creation_input_tokens":0,"output_tokens":1}}}"#,
    )
    .unwrap();
    let now = 1_785_589_200_000.0;
    let d = vec![root.clone()];
    // The record's own timestamp is INSIDE this window, so anything excluded here was excluded by
    // the file's mtime and nothing else.
    let future = build_attribution_report(&d, Some(now + 3_600_000.0), None, now);
    let past = build_attribution_report(&d, Some(1_000_000_000_000.0), None, now);
    std::fs::remove_dir_all(&root).ok();
    assert_eq!(future["attributedMessages"], 0, "a file whose mtime predates the window is never read: {future}");
    assert_eq!(past["attributedMessages"], 1, "and is read when it does not: {past}");
}

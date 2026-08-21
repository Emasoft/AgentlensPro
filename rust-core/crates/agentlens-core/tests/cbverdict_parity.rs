//! Cross-engine parity for `classifyCacheBreak` — cacheBreakTimeline SLICE 2 (TRDD-DMWOBWFH
//! P4x.2j). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-cbverdict-expected.mjs
//!
//! Each case is a pair (or triple) of RAW BODIES plus a timing. The Rust side re-derives its own
//! prefixes with extract_turn_prefix, so this exercises slice 1 and slice 2 together and no
//! hand-built prefix can drift from the shape the TS actually saw.

use agentlens_core::cache_break_timeline::{classify_cache_break, extract_turn_prefix, BreakTiming, TurnPrefix};
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cbverdict-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER and key SET both matter: `ttlTier` / `rawDiffSummary` / `confidence` are OPTIONAL in
/// the TS, so a port that always emits them (as nulls) compares equal field-by-field and is wrong
/// on the wire.
fn same(got: &Value, exp: &Value, label: &str) {
    assert_eq!(keys(got), keys(exp), "{label}: key set/ORDER differs\n  got={got}\n  exp={exp}");
    match exp {
        Value::Object(o) => {
            for (k, ev) in o {
                same(&got[k], ev, &format!("{label}.{k}"));
            }
        }
        _ => assert_eq!(got, exp, "{label}"),
    }
}

fn prefix_of(v: &Value) -> Option<TurnPrefix> {
    extract_turn_prefix(Some(v))
}

fn timing_of(t: &Value) -> BreakTiming {
    let num = |k: &str| t.get(k).and_then(Value::as_f64);
    BreakTiming {
        gap_ms: num("gapMs"),
        cache_read_tokens: num("cacheReadTokens").unwrap_or(0.0),
        cache_create_tokens: num("cacheCreateTokens").unwrap_or(0.0),
        ephemeral_5m_tokens: num("ephemeral5mTokens").unwrap_or(0.0),
        ephemeral_1h_tokens: num("ephemeral1hTokens").unwrap_or(0.0),
        blocks_added_since_last_write: num("blocksAddedSinceLastWrite"),
    }
}

#[test]
fn verdicts_match_the_ts_engine() {
    let o = oracle();
    let cases = o["cases"].as_object().expect("cases");
    assert!(cases.len() >= 40, "the ladder needs broad coverage; got {} cases", cases.len());
    for (name, c) in cases {
        let prev = prefix_of(&c["prev"]);
        let prev2 = prefix_of(&c["prev2"]);
        let cur = prefix_of(&c["cur"]).unwrap_or_else(|| panic!("{name}: cur body must parse"));
        let got = classify_cache_break(prev.as_ref(), &cur, &timing_of(&c["timing"]), prev2.as_ref()).to_value();
        same(&got, &c["verdict"], &format!("classifyCacheBreak({name})"));
    }
}

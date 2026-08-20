//! Cross-engine parity for `get_context_growth`, `get_subagent_tree` and the shared spawnRollup
//! engine (TRDD-DMWOBWFH P4x.2d). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-spawntree-expected.mjs

use agentlens_core::mcp_tools::{get_context_growth, get_subagent_tree};
use agentlens_core::spawn_rollup::{build_spawn_rollup, detect_spawn_antipatterns};
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/spawntree-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn arr(o: &Value, k: &str) -> Vec<Value> {
    o[k].as_array().cloned().unwrap_or_default()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract `assert_eq!` cannot see — with `preserve_order` a `Value::Object` is
/// an IndexMap whose `PartialEq` ignores order — so it is asserted explicitly, recursing one level
/// into the nested objects that carry conditional keys.
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
                    if e.is_object() {
                        same(g, e, &format!("{label}.{k}[{i}]"));
                    } else {
                        assert_eq!(g, e, "{label}.{k}[{i}]");
                    }
                }
            } else {
                assert_eq!(&got[k], ev, "{label}.{k}");
            }
        }
    }
}

/// The oracle injects this pricer and so does the TS side, so what is compared is the ROLLUP, not
/// two independently-ported pricing tables (`session_cost` has its own parity suite).
fn cost_of(c: &Value) -> f64 {
    let f = |k: &str| c.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    (f("inputTokens") + f("outputTokens")) / 1_000_000.0 * 5.0
        + f("cacheReadTokens") / 1_000_000.0 * 0.5
        + f("cacheCreateTokens") / 1_000_000.0 * 6.25
}

fn children(o: &Value) -> Vec<Value> {
    arr(o, "sessions").into_iter().filter(|c| c.get("parentSessionId").and_then(Value::as_str) == Some("parent-1")).collect()
}

#[test]
fn build_spawn_rollup_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    same(&build_spawn_rollup(&children(&o), "claude-opus-5", &cost_of), &o["rollup"], "rollup");
    same(&build_spawn_rollup(&[], "claude-opus-5", &cost_of), &o["rollupEmpty"], "rollupEmpty");
}

/// FAIL-FAST on the kind mix: an ABSENT or unrecognized `spawnKind` counts as `unknown`, NEVER as
/// `fresh`. A mislabeled cold fork has to surface as unknown, or the mix stops being evidence and
/// starts being a guess that happens to look tidy.
#[test]
fn an_unknown_spawn_kind_is_never_counted_as_fresh() {
    let o = oracle();
    let mix = build_spawn_rollup(&children(&o), "claude-opus-5", &cost_of)["kindMix"].clone();
    assert_eq!(mix["unknown"], 1, "c6 carries no spawnKind: {mix}");
    assert_eq!(mix["fresh"], 1, "and must NOT be folded into fresh: {mix}");
}

/// FLEET-COLD is derived from the RECORDED BUCKETS, not from `spawnKind` — c3 is LABELLED `fork`
/// yet wrote 300k and read 5k, so it counts as cold. A spawnKind-based detector misses exactly the
/// case that matters: a fork that did not actually inherit the cache. The near-zero-read ratio is
/// the other half — c5 wrote 200k and READ 180k (a real fork) and must NOT be cold, or every large
/// child trips the detector and the signal is worthless.
#[test]
fn cold_is_measured_from_buckets_not_from_the_spawn_label() {
    let o = oracle();
    let d = build_spawn_rollup(&children(&o), "claude-opus-5", &cost_of)["detections"].clone();
    let fleet = d.as_array().unwrap().iter().find(|x| x["code"] == "FLEET-COLD").expect("FLEET-COLD");
    assert_eq!(fleet["childCount"], 4, "c1,c2,c3(labelled fork),c4 — but NOT the warm c5: {fleet}");
    assert_eq!(fleet["severity"], "HIGH");
}

/// MODEL-MIX reads `spawnModelOverride || model` — a FALSY-or, so an EMPTY override falls through to
/// the model. An `??` port would read `''` as the child's model and flag a child that in fact
/// matches the parent. And an UNKNOWN parent model DISABLES the check rather than comparing against
/// `''`, which would flag every child at once.
#[test]
fn model_mix_uses_falsy_or_and_is_disabled_without_a_parent_model() {
    let o = oracle();
    let mixed = arr(&o, "mixed");
    let got = detect_spawn_antipatterns(&mixed, "claude-opus-5", &cost_of);
    let exp = arr(&o, "detectionsMixed");
    assert_eq!(got.len(), exp.len(), "{got:?}");
    for (g, e) in got.iter().zip(&exp) {
        same(g, e, "detectionsMixed");
    }
    let mm = got.iter().find(|x| x["code"] == "MODEL-MIX").expect("MODEL-MIX");
    assert_eq!(mm["childCount"], 2, "m3's EMPTY override falls through to the parent model: {mm}");

    let none = detect_spawn_antipatterns(&mixed, "", &cost_of);
    assert!(none.iter().all(|x| x["code"] != "MODEL-MIX"), "an unknown parent model must not flag everything: {none:?}");
    for (g, e) in none.iter().zip(arr(&o, "detectionsNoParentModel").iter()) {
        same(g, e, "detectionsNoParentModel");
    }
}

/// `asyncUnreportedChildren` is OMITTED when zero, not emitted as 0. Async children report zero
/// buckets by data ABSENCE — their usage never reaches the parent transcript — so a literal 0 would
/// read identically to "checked, none found" and quietly turn a coverage gap into a measurement.
#[test]
fn async_unreported_children_is_omitted_when_zero() {
    let o = oracle();
    let full = build_spawn_rollup(&children(&o), "claude-opus-5", &cost_of);
    assert_eq!(full["asyncUnreportedChildren"], 1, "c6 is async: {full}");
    let empty = build_spawn_rollup(&[], "claude-opus-5", &cost_of);
    assert!(empty.get("asyncUnreportedChildren").is_none(), "must be ABSENT, not 0: {empty}");
    // And it keeps its LITERAL position when present — between totalCostUsd and kindMix.
    assert_eq!(keys(&full)[5..7], ["totalCostUsd", "asyncUnreportedChildren"], "{full}");
}

#[test]
fn get_subagent_tree_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let (sessions, now) = (arr(&o, "sessions"), o["nowMs"].as_f64().unwrap());
    same(&get_subagent_tree(&sessions, "parent-1", now), &o["tree"], "tree");
    same(&get_subagent_tree(&sessions, "solo-1", now), &o["treeSolo"], "treeSolo");
    same(&get_subagent_tree(&sessions, "nope", now), &o["treeMissing"], "treeMissing");
}

/// The tree always roots at the PARENT, so querying a CHILD answers about the whole family — a
/// fan-out's cost is never reported as one sibling's slice of it.
#[test]
fn querying_a_child_returns_the_whole_family() {
    let o = oracle();
    let (sessions, now) = (arr(&o, "sessions"), o["nowMs"].as_f64().unwrap());
    let from_child = get_subagent_tree(&sessions, "c1", now);
    same(&from_child, &o["treeFromChild"], "treeFromChild");
    assert_eq!(from_child["root"]["sessionId"], "parent-1", "{from_child}");
    assert_eq!(from_child, get_subagent_tree(&sessions, "parent-1", now), "and it is the SAME answer");
}

/// `note` is declared in the literal but assigned `undefined` when there ARE children, so the key
/// drops entirely — a family tree must not carry a "no children recorded" line.
#[test]
fn the_no_children_note_appears_only_when_there_are_none() {
    let o = oracle();
    let (sessions, now) = (arr(&o, "sessions"), o["nowMs"].as_f64().unwrap());
    assert!(get_subagent_tree(&sessions, "parent-1", now).get("note").is_none());
    assert!(get_subagent_tree(&sessions, "solo-1", now)["note"].as_str().unwrap().contains("No sub-agent children"));
}

/// An empty growth list returns a MESSAGE, not a zeroed report: a session with no turn indices (an
/// OTEL session, or an empty timeline) is UNDIAGNOSABLE, and a report of zeros would read as
/// "measured, and it was free".
#[test]
fn get_context_growth_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let card = &arr(&o, "sessions")[0];
    same(&get_context_growth(card, &arr(&o, "timeline")), &o["growth"], "growth");
    same(&get_context_growth(card, &[]), &o["growthEmpty"], "growthEmpty");
    let empty = get_context_growth(card, &[]);
    assert!(empty.get("turns").is_none(), "no zeroed metrics at all: {empty}");
}

/// A `background` timeline entry is EXCLUDED from turn growth — it is not part of the conversation
/// prefix, and the fixture's background row carries 999,999 input tokens precisely so that including
/// it would be unmissable. An entry with NO turn index is skipped outright.
#[test]
fn background_and_unindexed_entries_are_excluded_from_growth() {
    let o = oracle();
    let got = get_context_growth(&arr(&o, "sessions")[0], &arr(&o, "timeline"));
    assert_eq!(got["turns"], 3, "the unindexed row forms no turn of its own: {got}");
    assert_eq!(got["peakPromptTokens"], 120010, "the 999,999 background row is not in any turn: {got}");
}

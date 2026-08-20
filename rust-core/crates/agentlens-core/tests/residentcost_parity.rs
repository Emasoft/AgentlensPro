//! Cross-engine parity for `build_resident_cost_report` (TRDD-W0RRL2FZ). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-residentcost-expected.mjs

use agentlens_core::resident_cost::build_resident_cost_report;
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/residentcost-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract `assert_eq!` cannot see (under `preserve_order` a `Value::Object` is
/// an IndexMap whose `PartialEq` ignores order). Asserted explicitly, recursing into the `blocks`
/// array so every block's own field order is covered too.
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

#[test]
fn main_history_full_report_matches() {
    let o = oracle();
    // The oracle's own `main`/`noUsage`/`empty` entries ARE the buildResidentCostReport OUTPUT, not
    // an input+output pair — reconstruct the input inline (mirrors the generator's MAIN literal) so
    // the engine is exercised end-to-end rather than just re-serializing the oracle's own answer.
    let block = |id: &str, kind: &str, label: &str, tokens: f64| {
        serde_json::json!({"id": id, "kind": kind, "label": label, "tokens": tokens})
    };
    let main = serde_json::json!({
        "sessionId": "sess-main", "estimated": true, "truncated": false,
        "steps": [
            {"turn": 1, "usage": {"input": 10, "output": 5, "cacheRead": 0, "cacheCreate": 0},
             "blocks": [block("system:core", "system", "core", 100.0), block("userMsg:a", "userMsg", "a", 50.0)]},
            {"turn": 2, "usage": {"input": 12, "output": 6, "cacheRead": 100, "cacheCreate": 0},
             "blocks": [block("system:core", "system", "core", 100.0), block("toolOutput:ls", "toolOutput", "ls", 80.0)]},
            {"turn": 3,
             "blocks": [block("system:core", "system", "core", 100.0), block("postCompact:sum1", "postCompact", "sum1", 40.0)]},
            {"turn": 4, "usage": {"input": 9, "output": 4, "cacheRead": 100, "cacheCreate": 40},
             "blocks": [block("system:core", "system", "core", 100.0), block("reasoning:think", "reasoning", "think", 100.0)]},
            {"turn": 5, "usage": {"input": 11, "output": 7, "cacheRead": 100, "cacheCreate": 0},
             "blocks": [block("system:core", "system", "core", 100.0), block("postCompact:sum2", "postCompact", "sum2", 100.0)]},
        ],
    });
    same(&build_resident_cost_report(&main), &o["main"], "main");
}

#[test]
fn no_usage_history_uses_the_zero_ground_truth_note() {
    let o = oracle();
    let no_usage = serde_json::json!({
        "sessionId": "sess-nousage", "estimated": true, "truncated": true,
        "steps": [
            {"turn": 1, "blocks": [{"id": "system:core", "kind": "system", "label": "core", "tokens": 200}]},
            {"turn": 2, "blocks": [{"id": "userMsg:hi", "kind": "userMsg", "label": "hi", "tokens": 30}]},
        ],
    });
    same(&build_resident_cost_report(&no_usage), &o["noUsage"], "noUsage");
    assert_eq!(o["noUsage"]["totalContextTokens"], 0);
    assert!(o["noUsage"]["note"].as_str().unwrap().starts_with("No step carried exact usage buckets"));
}

#[test]
fn empty_history_yields_zero_last_turn_and_no_blocks() {
    let o = oracle();
    let empty = serde_json::json!({"sessionId": "sess-empty", "estimated": true, "truncated": false, "steps": []});
    same(&build_resident_cost_report(&empty), &o["empty"], "empty");
    assert_eq!(o["empty"]["lastTurn"], 0);
    assert_eq!(o["empty"]["blocks"].as_array().unwrap().len(), 0);
}

/// Two compaction boundaries (turns 3 and 5) — residencyEnd must scan FORWARD through
/// compactionTurns, not just consult the first or last one. `system:core` straddles both and its
/// residentCost is the sum over 5 occurrences, each with its OWN turns-resident multiplier.
#[test]
fn residency_end_scans_forward_through_multiple_compaction_boundaries() {
    let o = oracle();
    assert_eq!(o["main"]["compactionTurns"], serde_json::json!([3, 5]));
    let system = o["main"]["blocks"].as_array().unwrap().iter().find(|b| b["id"] == "system:core").unwrap();
    assert_eq!(system["occurrences"], 5);
    assert_eq!(system["residentCost"], 700);
    assert_eq!(system["turnsResident"], 5);
}

/// Three blocks tie at residentCost=100 and two tie at 80 — the ranked list keeps first-seen
/// (insertion) order within a tie, matching V8's guaranteed-stable Array.sort. A port using an
/// unstable sort would pass on most runs and flake on others.
#[test]
fn ranked_blocks_break_ties_by_first_seen_order() {
    let o = oracle();
    let ids: Vec<&str> = o["main"]["blocks"].as_array().unwrap().iter().map(|b| b["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["system:core", "userMsg:a", "reasoning:think", "postCompact:sum2", "toolOutput:ls", "postCompact:sum1"]);
}

/// The reconciliation remainder is SIGNED and never clamped — the fixture drives it NEGATIVE
/// (itemizedResidentTokens exceeds totalContextTokens), and a clamping port would silently report 0.
#[test]
fn unattributed_tokens_is_signed_and_negative_here() {
    let o = oracle();
    assert_eq!(o["main"]["unattributedTokens"], -778);
    assert_eq!(o["main"]["totalContextTokens"], 382);
    assert_eq!(o["main"]["itemizedResidentTokens"], 1160);
}

/// A step with NO `usage` field at all must not increment `stepsWithUsage` nor contribute to
/// `totalContextTokens` — 5 steps total, only 4 carry usage (turn 3 is compaction-only).
#[test]
fn a_step_with_no_usage_is_excluded_from_the_reconciliation_base() {
    let o = oracle();
    assert_eq!(o["main"]["stepCount"], 5);
    assert_eq!(o["main"]["stepsWithUsage"], 4);
}

/// Every `ContextBlockKind` gets its own one-line remediation hint verbatim from the TS `Record` —
/// a Rust `match` missing an arm falls through to the 'other' text and this test catches it.
#[test]
fn every_block_kind_has_its_own_distinct_remediation_text() {
    let o = oracle();
    let expected = o["remediations"].as_object().unwrap();
    for (kind, exp_text) in expected {
        let block = serde_json::json!({
            "sessionId": "s", "estimated": true, "truncated": false,
            "steps": [{"turn": 1, "blocks": [{"id": format!("{kind}:x"), "kind": kind, "label": "x", "tokens": 1}]}],
        });
        let got = build_resident_cost_report(&block);
        assert_eq!(&got["blocks"][0]["remediation"], exp_text, "kind={kind}");
    }
}

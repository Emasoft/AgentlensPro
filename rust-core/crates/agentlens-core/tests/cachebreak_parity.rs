//! Cross-engine parity for the cache-break classifier (TRDD-DMWOBWFH P4x.2d). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-cachebreak-expected.mjs

use agentlens_core::cache_break::{
    analyze_cache_breaks, build_cache_break_report, diff_turn_sources, AnalyzeCacheBreaksOpts, CacheTurnInput, Cause,
};
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cachebreak-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract `assert_eq!` cannot see (`preserve_order` makes `Value::Object` an
/// IndexMap whose `PartialEq` ignores order), and here it is load-bearing twice over: an
/// `undefined` property DROPS its key, so the presence AND the position of `breakSourceLabel`,
/// `idleGapMs`, `confidence`, `attribution`, `prevExcerpt` and `curExcerpt` all encode real
/// semantics. Recurses through objects and arrays so every turn and every diff row is covered.
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

fn arr(v: &Value, k: &str) -> Vec<Value> {
    v.get(k).and_then(Value::as_array).cloned().unwrap_or_default()
}

fn opt_f(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64)
}

/// The oracle stores each CacheTurnInput as the literal JS object the generator built, so an ABSENT
/// `model`/`hasFastMode`/`timestampMs` stays absent here — which is exactly the distinction the
/// truthy/presence guards in the classifier turn on.
fn turn_input(v: &Value) -> CacheTurnInput {
    CacheTurnInput {
        turn: opt_f(v, "turn").unwrap_or(0.0),
        sources: arr(v, "sources"),
        cache_read_tokens: opt_f(v, "cacheReadTokens").unwrap_or(0.0),
        cache_create_tokens: opt_f(v, "cacheCreateTokens").unwrap_or(0.0),
        input_tokens: opt_f(v, "inputTokens").unwrap_or(0.0),
        model: v.get("model").and_then(Value::as_str).map(str::to_owned),
        has_fast_mode: v.get("hasFastMode").and_then(Value::as_bool),
        timestamp_ms: opt_f(v, "timestampMs"),
    }
}

fn opts_of(v: &Value) -> AnalyzeCacheBreaksOpts {
    AnalyzeCacheBreaksOpts {
        write_rate_usd_per_mtok: opt_f(v, "writeRateUsdPerMTok"),
        input_rate_usd_per_mtok: opt_f(v, "inputRateUsdPerMTok"),
        cache_read_rate_usd_per_mtok: opt_f(v, "cacheReadRateUsdPerMTok"),
        idle_ttl_ms: opt_f(v, "idleTtlMs"),
    }
}

/// Run the RUST engine over an oracle case. Every named-behaviour test below goes through this
/// rather than reading the oracle's stored `out` — a test that only inspects `out` documents the
/// TS's semantics but gates nothing in the port, and would have stayed green through the
/// deliberately-broken reload threshold this suite was falsified against.
fn analyze_case(o: &Value, case: &str) -> Value {
    let v = &o["analyze"][case];
    let turns: Vec<CacheTurnInput> = arr(v, "turns").iter().map(turn_input).collect();
    analyze_cache_breaks(case, &turns, &opts_of(&v["opts"]))
}

fn build_case(o: &Value, case: &str) -> Option<Value> {
    let v = &o["build"][case];
    let now = o["nowMs"].as_f64().unwrap();
    build_cache_break_report("s1", &arr(v, "timeline"), v.get("composition").filter(|c| !c.is_null()), v["model"].as_str().unwrap(), now)
}

#[test]
fn diff_turn_sources_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, v) in o["diffs"].as_object().unwrap() {
        let got = Value::Array(diff_turn_sources(&arr(v, "prev"), &arr(v, "cur")));
        same(&got, &v["out"], case);
    }
}

#[test]
fn analyze_cache_breaks_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, v) in o["analyze"].as_object().unwrap() {
        let turns: Vec<CacheTurnInput> = arr(v, "turns").iter().map(turn_input).collect();
        same(&analyze_cache_breaks(case, &turns, &opts_of(&v["opts"])), &v["out"], case);
    }
}

#[test]
fn build_cache_break_report_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let now = o["nowMs"].as_f64().unwrap();
    for (case, v) in o["build"].as_object().unwrap() {
        let comp = v.get("composition").filter(|c| !c.is_null());
        let got = build_cache_break_report("s1", &arr(v, "timeline"), comp, v["model"].as_str().unwrap(), now);
        match got {
            None => assert!(v["out"].is_null(), "{case}: expected a report, got None"),
            Some(g) => same(&g, &v["out"], case),
        }
    }
}

/// Every cause's short label, checked against the TS `CAUSE_LABEL` record. The Rust side models the
/// taxonomy as an ENUM precisely so the compiler enforces what the TS `Record<CacheBreakCause,…>`
/// enforces there — a `&str` match with a `_` arm would silently ship an empty label for a cause
/// added later, and this test would not notice because it iterates the causes it already knows.
#[test]
fn every_cause_carries_the_ts_label_and_remediation() {
    let o = oracle();
    let labels = o["causeLabel"].as_object().unwrap();
    let all = [
        Cause::ToolsChanged,
        Cause::ToolsReordered,
        Cause::SystemPromptTimestamp,
        Cause::ModelSwitched,
        Cause::EffortChanged,
        Cause::FastMode,
        Cause::McpServerToggle,
        Cause::PluginsReloaded,
        Cause::SkillsReloaded,
        Cause::PluginChanged,
        Cause::AccountSwitched,
        Cause::ToolDeny,
        Cause::InjectedBlockChanged,
        Cause::Compaction,
        Cause::Upgrade,
        Cause::ResumeAfterUpgrade,
        Cause::IdleTtlExpiry,
        Cause::Unattributable,
        Cause::Unknown,
    ];
    assert_eq!(all.len(), labels.len(), "the TS table has {} causes, this test knows {}", labels.len(), all.len());
    for c in all {
        assert_eq!(labels[c.id()].as_str(), Some(c.label()), "{}", c.id());
        assert!(!c.remediation().is_empty(), "{}: empty remediation", c.id());
    }
}

/// The classification LADDER, asserted by name rather than left to the bulk comparison — each rung
/// exists because the rung below it would otherwise claim the turn, and a reordering keeps every
/// field shape valid while silently renaming the culprit.
#[test]
fn the_classification_ladder_keeps_its_order() {
    let o = oracle();
    let cause_at = |case: &str, i: usize| -> String {
        let turns = arr(&analyze_case(&o, case), "turns");
        turns[i]["cause"].as_str().unwrap_or_default().to_owned()
    };
    // A model switch dominates a block diff that is ALSO present on the same turn.
    assert_eq!(cause_at("modelSwitch", 1), "MODEL_SWITCHED");
    // …but only when BOTH models are non-empty: '' is falsy, so this falls through to the diff.
    assert_eq!(cause_at("emptyModelIsNotASwitch", 1), "INJECTED_BLOCK_CHANGED");
    // A ≥2-catalog churn is named as the reload, not collapsed into whichever catalog sorted first.
    assert_eq!(cause_at("reloadHigh", 1), "PLUGINS_RELOADED");
    // A catalog kind appearing for the FIRST time is warmup, so a 2-kind cold start is NOT a reload.
    assert_eq!(cause_at("firstTimeCatalogsAreWarmup", 1), "TOOLS_CHANGED");
    // The idle rung only fires when nothing in the diff can be blamed AND a real write happened.
    assert_eq!(cause_at("idleExpiry", 1), "IDLE_TTL_EXPIRY");
    assert_eq!(cause_at("idleGapWithoutWriteIsSilent", 1), "UNKNOWN");
}

/// PLUGINS_RELOADED confidence is a COUNT verdict — high at 3+, medium at exactly 2 — and the label
/// lists the kinds SORTED, not in the order the diff happened to surface them.
#[test]
fn reload_confidence_and_label_are_count_and_sort_derived() {
    let o = oracle();
    let turn = |case: &str| analyze_case(&o, case)["turns"][1].clone();
    let hi = turn("reloadHigh");
    assert_eq!(hi["confidence"], "high");
    assert_eq!(hi["breakSourceLabel"], "4 catalogs churned (agentCatalog, mcp, skill, toolCatalog)");
    assert_eq!(hi["breakSourceKind"], "catalog");
    let med = turn("reloadMedium");
    assert_eq!(med["confidence"], "medium");
    assert_eq!(med["breakSourceLabel"], "2 catalogs churned (mcp, skill)");
}

/// UNATTRIBUTABLE is a RATIO verdict, not a size one: a turn writing 9,000 against a 900,000 read is
/// ordinary suffix writing and must stay silent, while 5,000 against 100 is a real cold write with
/// nothing to blame. Reporting the latter as "no break" is what made the costliest event invisible.
#[test]
fn unattributable_is_decided_by_the_ratio_not_the_size() {
    let o = oracle();
    let turns = arr(&analyze_case(&o, "unattributable"), "turns");
    assert_eq!(turns[1]["cause"], "UNATTRIBUTABLE");
    assert_eq!(turns[1]["wastedTokens"], 5000);
    assert_eq!(turns[2]["broke"], false, "9,000 written against 900,000 read is not a break: {}", turns[2]);
    assert_eq!(turns[2]["wastedTokens"], 0, "a non-break reports ZERO waste, not its cache_creation");
}

/// The two "no break" shapes are DIFFERENT objects: turn 1 carries no `idleGapMs` key at all (there
/// is no previous turn to measure a gap against), while the step-5 fallthrough carries it whenever
/// both timestamps were known. A port emitting one shape for both would still pass a value-only
/// comparison.
#[test]
fn the_two_no_break_shapes_differ() {
    let o = oracle();
    let got = analyze_case(&o, "idleGapWithoutWriteIsSilent");
    let first = got["turns"][0].clone();
    assert_eq!(keys(&first), ["turn", "broke", "cause", "wastedTokens", "wastedCostUsd"], "{first}");
    let silent = got["turns"][1].clone();
    assert_eq!(keys(&silent), ["turn", "broke", "cause", "wastedTokens", "wastedCostUsd", "idleGapMs"], "{silent}");
    assert_eq!(silent["idleGapMs"], 120_000);
}

/// priceWaste credits back the model's REAL cache-read rate; absent that it falls back to 0.1×
/// input (correct for mainstream models, overstating waste for e.g. codex-mini at 0.25×). With no
/// write rate at all the cost is 0 while wastedTokens stays populated — an unpriced model must not
/// look like a free one.
#[test]
fn waste_pricing_credits_the_real_cache_read_rate() {
    let o = oracle();
    let waste = |case: &str| analyze_case(&o, case)["turns"][1]["wastedCostUsd"].as_f64().unwrap();
    let tokens = |case: &str| analyze_case(&o, case)["turns"][1]["wastedTokens"].as_f64().unwrap();
    // 4,000 × (6.25 − 0.5)/1e6
    assert!((waste("noRates") - 0.0).abs() < 1e-12);
    assert_eq!(tokens("noRates"), 4000.0, "an unpriced model still reports the TOKENS");
    // The explicit 0.5 read rate vs the 0.1×5 = 0.5 default happen to coincide here by construction,
    // so assert the arithmetic rather than the two being equal to each other.
    assert!((waste("defaultCacheReadRate") - 4000.0 * (6.25 - 0.5) / 1e6).abs() < 1e-12);
    // write 1 < credited read 10 ⇒ a negative spread, clamped to 0 rather than a negative cost.
    assert_eq!(waste("clampedNegativeSpread"), 0.0);
}

/// Offenders group by cause+kind+label, rank by cost then tokens, and — under a STABLE sort — keep
/// insertion order on a full tie. A break with no source label is grouped under a synthetic
/// `(CAUSE)` label with kind `-`, so an unnamed cold write still appears on the leaderboard.
#[test]
fn offenders_rank_by_cost_then_tokens_and_keep_ties_stable() {
    let o = oracle();
    let offenders = arr(&analyze_case(&o, "offenders"), "offenders");
    let labels: Vec<&str> = offenders.iter().map(|x| x["label"].as_str().unwrap()).collect();
    assert_eq!(labels, vec!["heavy", "(MODEL_SWITCHED)", "tieA", "tieB", "light"], "{labels:?}");
    assert_eq!(offenders[0]["occurrences"], 2, "heavy broke twice and its waste accumulates");
    assert_eq!(offenders[0]["wastedTokens"], 16000);
    assert_eq!(offenders[1]["kind"], "-", "an unnamed break gets kind '-'");
    // tieA and tieB are identical on both sort keys, so insertion order decides — and insertion
    // order is turn order, which is the only non-arbitrary answer.
    assert_eq!(offenders[2]["wastedCostUsd"], offenders[3]["wastedCostUsd"]);
    assert_eq!(offenders[2]["wastedTokens"], offenders[3]["wastedTokens"]);
}

/// buildCacheBreakReport returns NULL rather than an empty report when it cannot diff — the caller
/// has to tell "no breaks" apart from "not computable". It also skips `background` entries and
/// entries with no turn, and takes each turn's model + timestamp from the FIRST llm entry only.
#[test]
fn build_returns_null_when_it_cannot_diff_and_folds_the_timeline_correctly() {
    let o = oracle();
    assert!(build_case(&o, "noComposition").is_none(), "no composition ⇒ null");
    assert!(build_case(&o, "oneTurn").is_none(), "a single turn cannot break ⇒ null");
    let full = build_case(&o, "full").unwrap();
    let turns = arr(&full, "turns");
    assert_eq!(turns.len(), 3, "the background entry and the turn-less entry are both skipped");
    // Turn 2 read 100+4000+10 and wrote 50+9000+10 — the 999,999 background figures are absent.
    assert_eq!(turns[1]["wastedTokens"], 9060);
    // An unknown model is UNPRICED, so its costs are 0 while the token figures still stand.
    let unpriced = build_case(&o, "unpricedModel").unwrap();
    assert_eq!(unpriced["totalWastedCostUsd"], 0.0);
    assert_eq!(unpriced["totalWastedTokens"], full["totalWastedTokens"]);
}

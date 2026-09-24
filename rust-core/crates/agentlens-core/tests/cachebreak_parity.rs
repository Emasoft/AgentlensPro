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
        cache_create_tokens_1h: opt_f(v, "cacheCreateTokens1h"),
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
        Cause::IdleTtlPartialExpiry,
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
    assert_eq!(silent["idleGapMs"], 600_000);
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

/// TRDD-ZQQYRYBO I6c2: the idle-TTL step judges a gap by the MEASURED write-tier split of the
/// LAST TURN THAT ACTUALLY WROTE the cache — walking backward past pure-read turns — never just
/// `prev`. Turn 0 writes an all-1h entry; turn 1 is a pure read (cacheCreateTokens 0, so it
/// carries no tier data of its own); turn 2 re-writes after a 70-min gap. A naive "look only at
/// prev" implementation would see turn 1's cache_create_tokens_1h (unset, since it never wrote)
/// and wrongly fall back to 'assumed' — the backward walk must reach turn 0's real split instead.
#[test]
fn idle_gap_is_judged_by_the_last_writing_turns_measured_tier_not_just_prev() {
    let same_source = serde_json::json!([{"kind": "systemPrompt", "label": "sys", "tokens": 100}]);
    let turns = vec![
        CacheTurnInput {
            turn: 1.0,
            sources: vec![same_source.clone()],
            cache_create_tokens: 100.0,
            cache_create_tokens_1h: Some(100.0), // all-1h write
            timestamp_ms: Some(0.0),
            ..CacheTurnInput::default()
        },
        CacheTurnInput {
            turn: 2.0,
            sources: vec![same_source.clone()],
            cache_create_tokens: 0.0, // pure read — no write, no tier data of its own
            timestamp_ms: Some(60_000.0),
            ..CacheTurnInput::default()
        },
        CacheTurnInput {
            turn: 3.0,
            sources: vec![same_source.clone()],
            cache_create_tokens: 50.0, // real re-write, 70 min after turn 2 (>TTL_1H_MS)
            timestamp_ms: Some(60_000.0 + 70.0 * 60_000.0),
            ..CacheTurnInput::default()
        },
    ];
    let report = analyze_cache_breaks("s", &turns, &AnalyzeCacheBreaksOpts::default());
    let got = &report["turns"][2];
    assert_eq!(got["cause"], "IDLE_TTL_EXPIRY", "{got}");
    assert_eq!(got["ttlGapSource"], "measured", "the backward walk must reach turn 0's split, not turn 1's absence: {got}");
}

/// TRDD-ZQQYRYBO I6c2 (b): a modern-shaped fixture (real JSON timeline entries, going through
/// `build_cache_break_report`'s own field read of `cacheCreateTokens1h`, not a hand-built
/// `CacheTurnInput`) where every writing turn carries a tier split → every idle-gap verdict
/// reports 'measured'. Catches a wrong JSON field-path (e.g. a typo'd key) that a direct
/// `CacheTurnInput` literal in the test itself could never expose.
#[test]
fn build_cache_break_report_reads_the_real_json_field_path_for_the_tier_split() {
    let composition = serde_json::json!({
        "turns": [
            {"turn": 1, "sources": [{"kind": "systemPrompt", "label": "sys", "tokens": 100}]},
            {"turn": 2, "sources": [{"kind": "systemPrompt", "label": "sys", "tokens": 100}]},
            {"turn": 3, "sources": [{"kind": "systemPrompt", "label": "sys", "tokens": 100}]},
        ],
    });
    // All-5m writes (cacheCreateTokens1h: 0, an OBSERVED empty 1h slice) so every 10-min gap
    // below exceeds the write's own tier and reports a full IDLE_TTL_EXPIRY, sourced 'measured'.
    let timeline = serde_json::json!([
        {"type": "llm", "turn": 1, "cacheCreateTokens": 1000, "cacheCreateTokens1h": 0, "timestamp": "2026-01-01T00:00:00.000Z", "model": "claude-opus-5"},
        {"type": "llm", "turn": 2, "cacheCreateTokens": 500, "cacheCreateTokens1h": 0, "timestamp": "2026-01-01T00:10:00.000Z", "model": "claude-opus-5"},
        {"type": "llm", "turn": 3, "cacheCreateTokens": 500, "cacheCreateTokens1h": 0, "timestamp": "2026-01-01T00:20:00.000Z", "model": "claude-opus-5"},
    ]);
    let now = 1_800_000_000_000.0;
    let report = build_cache_break_report("s", timeline.as_array().unwrap(), Some(&composition), "claude-opus-5", now).unwrap();
    for t in report["turns"].as_array().unwrap().iter().skip(1) {
        assert_eq!(t.get("ttlGapSource").cloned().unwrap_or(Value::Null), Value::String("measured".to_owned()), "{t}");
    }
}

/// TRDD-ZQQYRYBO I6c2 (c): a SPLIT write (both a 5m and a 1h slice) with a 30-min gap — past the
/// 5-min slice's TTL, within the 1h slice's — must report the PARTIAL verdict, never collapse to
/// a full IDLE_TTL_EXPIRY (which would over-report) or silently pass (which would under-report the
/// 5m slice's real re-warm cost).
#[test]
fn a_split_write_with_a_30_minute_gap_reports_the_partial_expiry_verdict() {
    let same_source = serde_json::json!([{"kind": "systemPrompt", "label": "sys", "tokens": 100}]);
    let turns = vec![
        CacheTurnInput {
            turn: 1.0,
            sources: vec![same_source.clone()],
            cache_create_tokens: 1000.0,
            cache_create_tokens_1h: Some(400.0), // split: 600 five-min + 400 one-hour
            timestamp_ms: Some(0.0),
            ..CacheTurnInput::default()
        },
        CacheTurnInput {
            turn: 2.0,
            sources: vec![same_source.clone()],
            cache_create_tokens: 50.0, // real re-write, 30 min later
            timestamp_ms: Some(30.0 * 60_000.0),
            ..CacheTurnInput::default()
        },
    ];
    let report = analyze_cache_breaks("s", &turns, &AnalyzeCacheBreaksOpts::default());
    let got = &report["turns"][1];
    assert_eq!(got["cause"], "IDLE_TTL_PARTIAL_EXPIRY", "{got}");
    assert_eq!(got["ttlGapSource"], "measured", "{got}");
}

/// TRDD-ZQQYRYBO I6c2 (d): no tier split observed AT ALL on the last writing turn (an OTEL-only
/// session, or a pre-tier-split Claude Code build) → the fallback keeps the old conservative
/// 5-min floor (never guesses 1h from silence), and says so via `ttlGapSource: 'assumed'`.
#[test]
fn no_observed_tier_split_falls_back_to_the_assumed_5_minute_floor() {
    let same_source = serde_json::json!([{"kind": "systemPrompt", "label": "sys", "tokens": 100}]);
    let turns = vec![
        CacheTurnInput {
            turn: 1.0,
            sources: vec![same_source.clone()],
            cache_create_tokens: 100.0,
            cache_create_tokens_1h: None, // no tier sub-object ever observed
            timestamp_ms: Some(0.0),
            ..CacheTurnInput::default()
        },
        CacheTurnInput {
            turn: 2.0,
            sources: vec![same_source.clone()],
            cache_create_tokens: 50.0, // real re-write, 10 min later (>5-min floor)
            timestamp_ms: Some(10.0 * 60_000.0),
            ..CacheTurnInput::default()
        },
    ];
    let report = analyze_cache_breaks("s", &turns, &AnalyzeCacheBreaksOpts::default());
    let got = &report["turns"][1];
    assert_eq!(got["cause"], "IDLE_TTL_EXPIRY", "{got}");
    assert_eq!(got["ttlGapSource"], "assumed", "{got}");
}

// (e) Interleaved parent/subagent streams taking the tier from their OWN stream, not a shared
// history, is a KNOWN GAP — not implemented in this pass. `build_cache_break_report` operates on
// one session's own timeline already (a subagent's `timeline` is its own transcript, never the
// parent's), so a per-session call is stream-isolated by construction; what remains untested is a
// caller that hands `analyze_cache_breaks` a MERGED multi-stream turn list directly. No production
// caller does that today (grep confirms every `analyze_cache_breaks`/`build_cache_break_report`
// call site passes one session's own timeline), so this is flagged rather than fabricated.

//! Cross-engine parity for the MCP tool SHAPERS (TRDD-DMWOBWFH P4x.2).
//!
//! The oracle feeds each shaper the SERIALIZED context the TS shaper received, so this tests the
//! SHAPER alone — the builder that produced the context is already covered by rawbodyctx_parity.
//!
//! After any TS change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-mcptools-expected.mjs

use agentlens_core::mcp_tools::get_call_context;
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/mcptools-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

#[test]
fn get_call_context_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, exp) in o["cases"].as_array().unwrap().iter().zip(o["results"].as_array().unwrap()) {
        let name = case["name"].as_str().unwrap();
        let args = &case["args"];
        let got = get_call_context(
            Some(&case["ctx"]),
            args["sessionId"].as_str().unwrap(),
            args.get("requestId").and_then(Value::as_str),
            args.get("spanId").and_then(Value::as_str),
        );
        assert_eq!(keys(&got), keys(exp), "{name}: key set/ORDER differs (an undefined field must be OMITTED, never null)");
        for (k, ev) in exp.as_object().unwrap() {
            assert_eq!(&got[k], ev, "{name}.{k}");
        }
    }
}

/// The block projection is a RE-PROJECTION, not a pass-through: it drops `tokenSource` and imposes
/// its own key order. Shipping the context's blocks unchanged would be a different wire shape on a
/// frozen surface, and it is the obvious "simplification" a later refactor would reach for.
#[test]
fn the_block_projection_drops_token_source_and_keeps_its_own_order() {
    let o = oracle();
    let full = o["cases"].as_array().unwrap().iter().position(|c| c["name"] == "full-context").unwrap();
    let ctx = &o["cases"][full]["ctx"];
    assert!(
        ctx["blocks"][0].get("tokenSource").is_some(),
        "the SOURCE context carries tokenSource — otherwise this test proves nothing"
    );
    let got = get_call_context(Some(ctx), "s1", Some("req-1"), None);
    let b0 = &got["blocks"][0];
    assert!(b0.get("tokenSource").is_none(), "the projection must drop tokenSource: {b0}");
    assert_eq!(keys(b0), vec!["id", "kind", "label", "tokens", "bytes", "role", "text"], "{b0}");
    // totalTokens sums the context's OWN per-block estimates rather than recounting.
    let sum: f64 = ctx["blocks"].as_array().unwrap().iter().map(|b| b["tokens"].as_f64().unwrap()).sum();
    assert_eq!(got["totalTokens"].as_f64().unwrap(), sum, "{got}");
}

fn cmp_deep(got: &Value, exp: &Value, ctx: &str) {
    if exp.is_object() {
        assert_eq!(keys(got), keys(exp), "{ctx}: key set/ORDER differs (an undefined field must be OMITTED, never null)");
        for (k, ev) in exp.as_object().unwrap() {
            cmp_deep(&got[k], ev, &format!("{ctx}.{k}"));
        }
        return;
    }
    if let (Some(ga), Some(ea)) = (got.as_array(), exp.as_array()) {
        assert_eq!(ga.len(), ea.len(), "{ctx}: array length differs\n  got: {got}\n  exp: {exp}");
        for (i, (g, e)) in ga.iter().zip(ea).enumerate() {
            cmp_deep(g, e, &format!("{ctx}[{i}]"));
        }
        return;
    }
    assert_eq!(got, exp, "{ctx}");
}

/// The oracle pins `now` only through priced fields; the fixture models have no scheduled rate
/// change, so any stable clock reproduces them. Using the generation instant would be better still,
/// but this oracle predates that field — noted rather than silently assumed away.
const NOW_MS: f64 = 1_787_000_000_000.0;

#[test]
fn get_context_composition_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, exp) in o["compCases"].as_array().unwrap().iter().zip(o["compResults"].as_array().unwrap()) {
        let name = case["name"].as_str().unwrap();
        let args = &case["args"];
        let got = agentlens_core::mcp_tools::get_context_composition(
            Some(&case["comp"]),
            args["sessionId"].as_str().unwrap(),
            args.get("turn").and_then(Value::as_f64),
        );
        cmp_deep(&got, exp, &format!("get_context_composition[{name}]"));
    }
}

#[test]
fn get_context_history_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, exp) in o["histCases"].as_array().unwrap().iter().zip(o["histResults"].as_array().unwrap()) {
        let name = case["name"].as_str().unwrap();
        let args = &case["args"];
        let got = agentlens_core::mcp_tools::get_context_history(
            Some(&case["hist"]),
            case.get("cardModel").and_then(Value::as_str),
            args["sessionId"].as_str().unwrap(),
            args.get("turn").and_then(Value::as_f64),
            args.get("blockId").and_then(Value::as_str),
            NOW_MS,
        );
        cmp_deep(&got, exp, &format!("get_context_history[{name}]"));
    }
}

#[test]
fn get_conversation_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, exp) in o["convCases"].as_array().unwrap().iter().zip(o["convResults"].as_array().unwrap()) {
        let name = case["name"].as_str().unwrap();
        let args = &case["args"];
        let got = agentlens_core::mcp_tools::get_conversation(
            Some(&case["conv"]),
            args["sessionId"].as_str().unwrap(),
            args.get("turn").and_then(Value::as_f64),
            args.get("turnFrom").and_then(Value::as_f64),
            args.get("turnTo").and_then(Value::as_f64),
        );
        cmp_deep(&got, exp, &format!("get_conversation[{name}]"));
    }
}

/// Three bounding rules that a later "cleanup" would plausibly break, each asserted by name.
#[test]
fn the_drill_bounding_rules_hold() {
    let o = oracle();
    let case = |set: &str, name: &str| -> Value {
        o[set].as_array().unwrap().iter().find(|c| c["name"] == name).expect("case present").clone()
    };

    // 1. composition turnCount is the UNFILTERED total — it answers "how many turns does this
    //    session have", not "how many did you get back".
    let c = case("compCases", "one-turn-keeps-unfiltered-turnCount");
    let got = agentlens_core::mcp_tools::get_context_composition(Some(&c["comp"]), "comp-own", Some(2.0));
    assert_eq!(got["turnCount"], 3, "turnCount must not follow the filter: {got}");
    assert_eq!(got["turns"].as_array().unwrap().len(), 1, "{got}");

    // 2. the conversation range is CLAMPED to from+cap-1 — a caller cannot widen the window.
    let c = case("convCases", "range-clamped-to-cap");
    let got = agentlens_core::mcp_tools::get_conversation(Some(&c["conv"]), "conv-main", None, Some(1.0), Some(9999.0));
    assert_eq!(got["turnTo"], 20, "turnTo must clamp to the cap, not honour 9999: {got}");
    assert_eq!(got["rangeCap"], 20);

    // 3. the block drill spreads VERBATIM (keeps tokenSource) while the step projection DROPS it.
    let c = case("histCases", "one-block-verbatim");
    let drill = agentlens_core::mcp_tools::get_context_history(
        Some(&c["hist"]), Some("claude-opus-5"), "hist-main", Some(1.0), Some("userMsg:user"), NOW_MS);
    assert!(drill["block"]["tokenSource"].is_string(), "the block drill is verbatim: {drill}");
    let step = agentlens_core::mcp_tools::get_context_history(
        Some(&c["hist"]), Some("claude-opus-5"), "hist-main", Some(1.0), None, NOW_MS);
    assert!(step["blocks"][0].get("tokenSource").is_none(), "the step projection drops it: {step}");
}

/// Rebuild the oracle's AccountInfo. Hand-built rather than parsed because `AccountInfo` is a Rust
/// struct with no deserializer — and because writing the fields out makes it obvious when the
/// fixture and the struct drift apart.
fn oracle_account(v: &Value) -> agentlens_core::burn::account_info::AccountInfo {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    agentlens_core::burn::account_info::AccountInfo {
        account_uuid: s("accountUuid"),
        email: s("email"),
        organization_name: s("organizationName"),
        organization_uuid: s("organizationUuid"),
        billing_type: s("billingType"),
        has_extra_usage_enabled: v.get("hasExtraUsageEnabled").and_then(Value::as_bool).unwrap_or(false),
        organization_rate_limit_tier: s("organizationRateLimitTier"),
        user_rate_limit_tier: s("userRateLimitTier"),
        display_name: s("displayName"),
        plan_type: s("planType"),
        rate_limit_tier: s("rateLimitTier"),
        label: v.get("label").and_then(Value::as_str).unwrap_or("").to_owned(),
        source: "claude.json",
    }
}

#[test]
fn get_window_budget_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let status = &o["windowBudget"]["status"];
    let account = oracle_account(&o["windowBudget"]["account"]);
    for (case, exp) in o["wbCases"].as_array().unwrap().iter().zip(o["wbResults"].as_array().unwrap()) {
        let name = case["name"].as_str().unwrap();
        let got = agentlens_core::mcp_tools::get_window_budget(
            Some(status),
            Some(&account),
            case["args"].get("accountId").and_then(Value::as_str),
        );
        assert_eq!(keys(&got), keys(exp), "{name}: key set/ORDER differs");
        for (k, ev) in exp.as_object().unwrap() {
            assert_eq!(&got[k], ev, "{name}.{k}");
        }
    }
}

/// The three label branches must stay DISTINGUISHABLE. They collapse the moment someone
/// "simplifies" accountLabelFor: the current account resolves to its identity, a rotated-away one
/// only to its 8-char id, and the null (unknown) bucket takes the CURRENT label because the TS
/// `accountUuid == null` check is LOOSE. A fixture with one account would pass either way.
#[test]
fn the_three_account_label_branches_stay_distinct() {
    let o = oracle();
    let got = agentlens_core::mcp_tools::get_window_budget(
        Some(&o["windowBudget"]["status"]),
        Some(&oracle_account(&o["windowBudget"]["account"])),
        None,
    );
    let labels: Vec<(Option<&str>, &str)> = got["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| (w["accountUuid"].as_str(), w["accountLabel"].as_str().unwrap()))
        .collect();
    assert_eq!(
        labels,
        vec![(Some("acct-1111"), "Display A"), (Some("acct-2222"), "acct-222"), (None, "Display A")],
        "the current / rotated-away / unknown branches must not collapse into one another"
    );
}

/// `message` appears ONLY when an accountId was asked for and matched nothing. An unfiltered call
/// that legitimately has no windows is not an error and must not claim one — and the empty string
/// is FALSY in the TS, so it means "unfiltered", not "match the empty id".
#[test]
fn the_empty_result_message_is_scoped_to_an_actual_filter() {
    let o = oracle();
    let status = &o["windowBudget"]["status"];
    let account = oracle_account(&o["windowBudget"]["account"]);
    let ghost = agentlens_core::mcp_tools::get_window_budget(Some(status), Some(&account), Some("acct-ghost"));
    assert!(ghost.get("message").is_some(), "a filter that matched nothing explains itself: {ghost}");
    let empty_filter = agentlens_core::mcp_tools::get_window_budget(Some(status), Some(&account), Some(""));
    assert!(empty_filter.get("message").is_none(), "'' is falsy in the TS — unfiltered, not an empty match: {empty_filter}");
    assert_eq!(empty_filter["accounts"].as_array().unwrap().len(), 3, "'' must not filter anything out");
    // No burn monitor at all is a different answer again: a message and NOTHING else.
    let none = agentlens_core::mcp_tools::get_window_budget(None, Some(&account), None);
    assert_eq!(keys(&none), vec!["message"], "{none}");
}

/// `get_lifecycle_events` exists as a shaper for ONE reason: the note. An empty `events` list is
/// ambiguous on its own — it reads identically whether nothing happened or the hooks were never
/// installed — so the payload must say which, and the note text is a wire contract shared with the
/// TS. Both branches are driven so the text cannot drift on one side only.
#[test]
fn get_lifecycle_events_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, exp) in o["lcCases"].as_array().unwrap().iter().zip(o["lcResults"].as_array().unwrap()) {
        let name = case["name"].as_str().unwrap();
        let got = agentlens_core::mcp_tools::get_lifecycle_events(
            case["dir"].as_str().unwrap(),
            case["dirExists"].as_bool().unwrap(),
            case["events"].as_array().unwrap().clone(),
        );
        assert_eq!(keys(&got), keys(exp), "{name}: key set/ORDER differs — the note must be OMITTED, never null");
        for (k, ev) in exp.as_object().unwrap() {
            assert_eq!(&got[k], ev, "{name}.{k}");
        }
    }
    // "quiet" and "not installed" must be TELLABLE APART — that is the whole point of the field.
    let quiet = agentlens_core::mcp_tools::get_lifecycle_events("/data/hook-events", true, vec![]);
    let missing = agentlens_core::mcp_tools::get_lifecycle_events("/data/hook-events", false, vec![]);
    assert_eq!(quiet["count"], missing["count"], "both are empty — so the COUNT cannot be the discriminator");
    assert!(quiet.get("note").is_none() && missing.get("note").is_some(), "the note is: {quiet} vs {missing}");
}

fn ttl_of(v: &Value) -> Option<agentlens_core::burn::cache_ttl::TtlContext> {
    use agentlens_core::burn::cache_ttl::{AuthRegime, TtlContext};
    let o = v.as_object()?;
    Some(TtlContext {
        auth: match o.get("auth").and_then(Value::as_str) {
            Some("subscription") => AuthRegime::Subscription,
            Some("usage-credits") => AuthRegime::UsageCredits,
            Some("api-key") => AuthRegime::ApiKey,
            _ => AuthRegime::Unknown,
        },
        force5m: o.get("force5m").and_then(Value::as_bool).unwrap_or(false),
        enable1h: o.get("enable1h").and_then(Value::as_bool).unwrap_or(false),
    })
}

#[test]
fn get_account_status_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, exp) in o["asCases"].as_array().unwrap().iter().zip(o["asResults"].as_array().unwrap()) {
        let name = case["name"].as_str().unwrap();
        let acct = case["account"].as_object().map(|_| oracle_account(&case["account"]));
        // `source` is part of the fixture, not always "claude.json" — the unresolved-identity case
        // turns on exactly that field, so it must survive the rebuild.
        let acct = acct.map(|mut a| {
            a.source = if case["account"]["source"] == "none" { "none" } else { "claude.json" };
            a
        });
        let got = agentlens_core::mcp_tools::get_account_status(
            acct.as_ref(),
            case["burn"].as_object().map(|_| &case["burn"]),
            ttl_of(&case["ttl"]).as_ref(),
            case["rl"].as_object().map(|_| &case["rl"]),
        );
        assert_eq!(keys(&got), keys(exp), "{name}: key set/ORDER differs (the note must be OMITTED when absent)");
        for (k, ev) in exp.as_object().unwrap() {
            assert_eq!(&got[k], ev, "{name}.{k}");
        }
    }
}

/// `describePlan` / `describeAccountMode` are SHARED with the account-state sampler, so one
/// implementation must serve both or the plan string in a stored state record silently disagrees
/// with the one the tool reports. The `x` in the multiplier suffix is asserted by the table: writing
/// `Max 5` instead of `Max 5x` is the obvious off-by-one-character slip.
#[test]
fn the_shared_plan_and_mode_strings_match_the_ts() {
    let o = oracle();
    for (case, exp) in o["planCases"].as_array().unwrap().iter().zip(o["planResults"].as_array().unwrap()) {
        let got = agentlens_core::account_state_timeline::describe_plan(case[0].as_str(), case[1].as_str());
        assert_eq!(Value::String(got), *exp, "describePlan({case})");
    }
    for (case, exp) in o["modeCases"].as_array().unwrap().iter().zip(o["modeResults"].as_array().unwrap()) {
        let got = agentlens_core::account_state_timeline::describe_account_mode(case.as_str());
        assert_eq!(Value::String(got.to_owned()), *exp, "describeAccountMode({case})");
    }
}

/// `windowFillPct` is COST-first and NULL when the capacity was already passed. Both rules are the
/// difference between a number and a wrong number: raw tokens overstate the fill (~96% of volume is
/// cache reads billing at 0.1x), which is how one 7d window read 171.51% by tokens and 64.49% by
/// cost — and a percentage off a denominator that is proven wrong is noise wearing a number's
/// clothes, so it is reported as absent rather than as a figure.
#[test]
fn window_fill_pct_prefers_cost_and_nulls_a_passed_capacity() {
    let o = oracle();
    for (case, exp) in o["fillCases"].as_array().unwrap().iter().zip(o["fillResults"].as_array().unwrap()) {
        assert_eq!(agentlens_core::mcp_tools::window_fill_pct(case), *exp, "windowFillPct({case})");
    }
    // Named explicitly so a regression reads as what it is, not as an anonymous table row.
    let overstating = &o["fillCases"][2];
    assert_eq!(agentlens_core::mcp_tools::window_fill_pct(overstating), Value::from(64.49), "cost, not the 171.51 token figure");
}

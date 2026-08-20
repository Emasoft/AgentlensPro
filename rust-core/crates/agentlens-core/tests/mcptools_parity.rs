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

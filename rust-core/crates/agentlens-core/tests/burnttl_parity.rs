//! Cross-engine parity for the TTL machine-signal resolvers + account info (TRDD-DMWOBWFH
//! P4r.3): expected output produced by the COMPILED ttlContext.ts + accountInfo.ts
//! (tests/fixtures/gen-ttlaccount-expected.mjs — the oracle; its case tables are mirrored
//! here verbatim, and every zip asserts equal length so a table edit on one side fails loud).
//! Regenerate after any TS change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-ttlaccount-expected.mjs

use agentlens_core::burn::account_info::{account_label_for, get_current_account, parse_oauth_account, parse_subscription_type, AccountInfo};
use agentlens_core::burn::ttl_context::{detect_ttl_env_overrides, read_settings_env, resolve_auth_regime};
use serde_json::{json, Value};
use std::collections::HashMap;

fn fixtures_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn acct(billing: Option<&str>, extra: bool) -> AccountInfo {
    AccountInfo { billing_type: billing.map(str::to_owned), has_extra_usage_enabled: extra, ..AccountInfo::default() }
}

fn id_full() -> AccountInfo {
    AccountInfo {
        account_uuid: Some("acct-aaaa".into()),
        email: Some("fixture-user@example.com".into()),
        organization_name: Some("Fixture Org".into()),
        organization_uuid: Some("org-bbbb".into()),
        billing_type: Some("stripe_subscription".into()),
        has_extra_usage_enabled: true,
        organization_rate_limit_tier: Some("tier_alpha".into()),
        user_rate_limit_tier: Some("tier_beta".into()),
        display_name: Some("Fixture User".into()),
        ..AccountInfo::default()
    }
}

/// The 9 OauthIdentity keys of to_value (parseOauthAccount's oracle shape).
fn identity_value(a: &AccountInfo) -> Value {
    let v = a.to_value();
    let keys = ["accountUuid", "email", "organizationName", "organizationUuid", "billingType", "hasExtraUsageEnabled", "organizationRateLimitTier", "userRateLimitTier", "displayName"];
    Value::Object(keys.iter().map(|k| ((*k).to_owned(), v[*k].clone())).collect())
}

fn env_map(pairs: &[(&str, &str)]) -> HashMap<String, String> {
    pairs.iter().map(|(k, v)| ((*k).to_owned(), (*v).to_owned())).collect()
}

#[test]
fn ttl_signals_and_account_info_reproduce_the_ts_oracle_exactly() {
    let dir = fixtures_dir();
    let expected: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("ttlaccount-expected.json")).unwrap()).unwrap();

    // resolveAuthRegime — same table as the generator.
    let auth_cases: Vec<(Option<AccountInfo>, Option<f64>)> = vec![
        (None, Some(50.0)),
        (Some(acct(None, false)), None),
        (Some(acct(Some("stripe_subscription"), true)), Some(99.0)),
        (Some(acct(Some("stripe_subscription"), true)), Some(100.0)),
        (Some(acct(Some("SUBSCRIPTION"), false)), Some(150.0)),
        (Some(acct(Some("subscription"), true)), None),
        (Some(acct(Some("api"), false)), None),
    ];
    let exp_auth = expected["auth"].as_array().unwrap();
    assert_eq!(auth_cases.len(), exp_auth.len());
    for ((account, pct), e) in auth_cases.iter().zip(exp_auth) {
        assert_eq!(resolve_auth_regime(account.as_ref(), *pct).as_str(), e["regime"].as_str().unwrap(), "{}", e["name"]);
    }

    // detectTtlEnvOverrides — same table.
    let override_cases: Vec<(HashMap<String, String>, Option<Value>)> = vec![
        (env_map(&[]), None),
        (env_map(&[("FORCE_PROMPT_CACHING_5M", "1"), ("ENABLE_PROMPT_CACHING_1H", "true")]), None),
        (env_map(&[("FORCE_PROMPT_CACHING_5M", "0"), ("ENABLE_PROMPT_CACHING_1H", "false")]), None),
        (env_map(&[]), Some(json!({"FORCE_PROMPT_CACHING_5M": 1, "ENABLE_PROMPT_CACHING_1H": true}))),
        (env_map(&[]), Some(json!({"FORCE_PROMPT_CACHING_5M": "yes", "ENABLE_PROMPT_CACHING_1H": 0}))),
    ];
    let exp_ov = expected["overrides"].as_array().unwrap();
    assert_eq!(override_cases.len(), exp_ov.len());
    for ((process_env, settings), e) in override_cases.iter().zip(exp_ov) {
        let (f5, e1) = detect_ttl_env_overrides(process_env, settings.as_ref());
        assert_eq!(json!({"force5m": f5, "enable1h": e1}), e["out"], "{}", e["name"]);
    }

    // accountLabelFor — same table ('OMIT' ≡ null under the TS loose ==, both pinned).
    let id = id_full();
    let id_no_email = AccountInfo { email: None, ..id_full() };
    let id_bare = AccountInfo { email: None, display_name: None, ..id_full() };
    let label_cases: Vec<(Option<&AccountInfo>, Option<&str>)> = vec![
        (Some(&id), None),
        (Some(&id), None),
        (Some(&id), Some("acct-aaaa")),
        (Some(&id), Some("other-uuid-9999")),
        (Some(&id_no_email), None),
        (Some(&id_bare), None),
        (None, Some("zzzz-uuid-1234")),
        (None, None),
    ];
    let exp_labels = expected["labels"].as_array().unwrap();
    assert_eq!(label_cases.len(), exp_labels.len());
    for ((idv, uuid), e) in label_cases.iter().zip(exp_labels) {
        assert_eq!(account_label_for(*idv, *uuid), e["label"].as_str().unwrap(), "{}", e["name"]);
    }

    // parseOauthAccount — same texts.
    let oauth_texts = [
        r#"{"oauthAccount":{"accountUuid":"acct-aaaa","emailAddress":"fixture-user@example.com","organizationName":"Fixture Org","organizationUuid":"org-bbbb","billingType":"stripe_subscription","hasExtraUsageEnabled":true,"organizationRateLimitTier":"tier_alpha","userRateLimitTier":"tier_beta","displayName":"Fixture User"}}"#,
        r#"{"oauthAccount":{"accountUuid":"","emailAddress":"a@example.com"}}"#,
        r#"{"noAccount":true}"#,
        "{broken",
    ];
    let exp_oauth = expected["oauth"].as_array().unwrap();
    assert_eq!(oauth_texts.len(), exp_oauth.len());
    for (t, e) in oauth_texts.iter().zip(exp_oauth) {
        let got = parse_oauth_account(t).map_or(Value::Null, |a| identity_value(&a));
        assert_eq!(got, *e, "oauth text {t}");
    }

    // parseSubscriptionType — same texts.
    let sub_texts = [
        r#"{"claudeAiOauth":{"subscriptionType":"max","accessToken":"never-surfaced"}}"#,
        r#"{"subscriptionType":"pro"}"#,
        r#"{"claudeAiOauth":{"other":1}}"#,
        "nope",
    ];
    let exp_subs = expected["subs"].as_array().unwrap();
    assert_eq!(sub_texts.len(), exp_subs.len());
    for (t, e) in sub_texts.iter().zip(exp_subs) {
        assert_eq!(parse_subscription_type(t).map_or(Value::Null, Value::from), *e, "sub text {t}");
    }

    // getCurrentAccount over the fixture homes with an injected plan resolver.
    let account_cases: Vec<(&str, Option<&str>)> = vec![("ttl-home-a", Some("max")), ("ttl-home-a", None), ("ttl-home-bad", Some("max")), ("ttl-home-none", None)];
    let exp_accounts = expected["currentAccounts"].as_array().unwrap();
    assert_eq!(account_cases.len(), exp_accounts.len());
    for ((home, plan), e) in account_cases.iter().zip(exp_accounts) {
        let plan = plan.map(str::to_owned);
        let read: Box<dyn Fn() -> Option<String>> = Box::new(move || plan.clone());
        let got = get_current_account(&dir.join(home), &HashMap::new(), Some(read.as_ref()));
        assert_eq!(got.to_value(), e["account"], "{}", e["name"]);
    }

    // getTtlContext composed from the ported parts (auth × overrides × the settings env read).
    #[allow(clippy::type_complexity)] // the case-table tuple, mirrored from the generator
    let ttl_cases: Vec<(&str, Option<AccountInfo>, HashMap<String, String>, Option<f64>)> = vec![
        ("ttl-home-set", Some(id_full()), env_map(&[]), None),
        ("ttl-home-none", Some(acct(Some("api"), true)), env_map(&[("FORCE_PROMPT_CACHING_5M", "1")]), None),
        ("ttl-home-none", None, env_map(&[]), Some(120.0)),
    ];
    let exp_ttl = expected["ttlContexts"].as_array().unwrap();
    assert_eq!(ttl_cases.len(), exp_ttl.len());
    for ((home, account, process_env, pct), e) in ttl_cases.iter().zip(exp_ttl) {
        let settings = read_settings_env(&dir.join(home));
        let (force5m, enable1h) = detect_ttl_env_overrides(process_env, settings.as_ref());
        let auth = resolve_auth_regime(account.as_ref(), *pct);
        assert_eq!(json!({"auth": auth.as_str(), "force5m": force5m, "enable1h": enable1h}), e["ctx"], "{}", e["name"]);
    }
}

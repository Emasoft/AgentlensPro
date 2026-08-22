//! Cross-engine parity for `build_account_state_record` + the timeline's discrete change-detection
//! key (TRDD-DMWOBWFH C3, tests/fixtures/c3-account-state-timeline-case-matrix.md parts 1-2,
//! 14 cases).
//! Key ORDER is load-bearing (it is what JSON.stringify writes), so the record assertion compares
//! serialized strings, not order-insensitive `serde_json::Value` equality.
//! After any TS change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-acctstatetimeline-expected.mjs

use agentlens_core::account_state_timeline::{build_account_state_record, AccountStateTimeline};
use agentlens_core::burn::account_info::AccountInfo;
use agentlens_core::burn::cache_ttl::{AuthRegime, TtlContext};
use serde_json::Value;

const RECORD_IDS: &[&str] = &[
    "full-subscription",
    "no-account",
    "source-none",
    "email-falls-back-to-label",
    "email-empty-string-kept",
    "ttlctx-wins-over-billing",
    "no-ttlctx-api-billing",
    "unknown-plan-type-echoed",
];

const KEY_IDS: &[&str] = &[
    "key-ignores-email",
    "key-ignores-ttlsource",
    "key-ignores-ts",
    "key-null-account-is-sentinel",
    "key-mode-differs",
    "key-ttlminutes-differs",
];

fn fixtures() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn tmp(tag: &str) -> std::path::PathBuf {
    // PID *and* tag: cargo runs tests in this file as parallel THREADS of one process, so a
    // PID-only path lets siblings delete each other's fixtures mid-run.
    let d = std::env::temp_dir().join(format!("al-acctstate-key-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Rebuild the fixture's AccountInfo. Hand-built rather than parsed because `AccountInfo` has no
/// deserializer, and writing the fields out makes it obvious when the fixture and the struct drift.
/// Unlike the mcptools oracle helper, `source` itself comes from the fixture — case `source-none`
/// needs `"none"`, not the usual `"claude.json"`.
fn oracle_account(v: &serde_json::Map<String, Value>) -> AccountInfo {
    let s = |k: &str| v.get(k).and_then(Value::as_str).map(str::to_owned);
    AccountInfo {
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
        source: match v.get("source").and_then(Value::as_str) {
            Some("none") => "none",
            _ => "claude.json",
        },
    }
}

fn oracle_ttl_ctx(v: &serde_json::Map<String, Value>) -> TtlContext {
    let auth = match v.get("auth").and_then(Value::as_str) {
        Some("subscription") => AuthRegime::Subscription,
        Some("usage-credits") => AuthRegime::UsageCredits,
        Some("api-key") => AuthRegime::ApiKey,
        _ => AuthRegime::Unknown,
    };
    TtlContext {
        auth,
        force5m: v.get("force5m").and_then(Value::as_bool).unwrap_or(false),
        enable1h: v.get("enable1h").and_then(Value::as_bool).unwrap_or(false),
    }
}

#[test]
fn build_account_state_record_reproduces_the_ts_oracle_exactly() {
    let o: Value = serde_json::from_str(
        &std::fs::read_to_string(fixtures().join("acctstatetimeline-expected.json")).unwrap(),
    )
    .unwrap();
    let records = o["records"].as_array().unwrap();

    assert_eq!(records.len(), RECORD_IDS.len(), "case count must match the matrix");
    let ids: Vec<&str> = records.iter().map(|c| c["id"].as_str().unwrap()).collect();
    assert_eq!(ids, RECORD_IDS, "case ids must appear in the matrix's exact order");

    for case in records {
        let id = case["id"].as_str().unwrap();
        let account = case["account"].as_object().map(oracle_account);
        let ttl_ctx = case["ttlCtx"].as_object().map(oracle_ttl_ctx);
        let now = case["now"].as_f64().unwrap();
        let expected = case["expected"].as_object().unwrap();

        let got = build_account_state_record(account.as_ref(), ttl_ctx.as_ref(), now);

        // Key vectors FIRST: on an order bug they name the key that moved, where the serialized
        // comparison below would only print two long strings.
        let got_keys: Vec<&String> = got.keys().collect();
        let expected_keys: Vec<&String> = expected.keys().collect();
        assert_eq!(got_keys, expected_keys, "case `{id}`: key order mismatch");

        let got_str = serde_json::to_string(&got).unwrap();
        let expected_str = serde_json::to_string(expected).unwrap();
        assert_eq!(got_str, expected_str, "case `{id}`: serialized record mismatch (order or content)");
    }
}

/// `discrete_key` is private to the module, so the change-detection contract is driven exactly the
/// way the generator drives it: a fresh timeline, `record(a)` then `record(b)`, and `same` iff the
/// second `record` call returned false (no new discrete state).
#[test]
fn discrete_change_detection_reproduces_the_ts_oracle_exactly() {
    let o: Value = serde_json::from_str(
        &std::fs::read_to_string(fixtures().join("acctstatetimeline-expected.json")).unwrap(),
    )
    .unwrap();
    let keys = o["keys"].as_array().unwrap();

    assert_eq!(keys.len(), KEY_IDS.len(), "case count must match the matrix");
    let ids: Vec<&str> = keys.iter().map(|c| c["id"].as_str().unwrap()).collect();
    assert_eq!(ids, KEY_IDS, "case ids must appear in the matrix's exact order");

    for case in keys {
        let id = case["id"].as_str().unwrap();
        let a = case["a"].as_object().cloned().unwrap();
        let b = case["b"].as_object().cloned().unwrap();
        let same = case["same"].as_bool().unwrap();

        let path = tmp(id).join("account-state.ndjson");
        let mut timeline = AccountStateTimeline::open(path);
        assert!(timeline.record(a), "case `{id}`: the first record must always enqueue");
        let second_enqueued = timeline.record(b);
        assert_eq!(!second_enqueued, same, "case `{id}`: expected same={same}, got enqueued={second_enqueued}");
    }
}

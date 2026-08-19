//! Cross-engine parity for the TTL classifier + keep-warm measurement (TRDD-DMWOBWFH P4r.1):
//! the expected output was produced by the COMPILED TS modules themselves
//! (tests/fixtures/gen-keepwarm-expected.mjs — the oracle). Regenerate after any TS change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-keepwarm-expected.mjs

use agentlens_core::burn::cache_ttl::{classify_ttl_regime, session_ttl_kind_of, AuthRegime, SessionTtlKind, TtlContext};
use agentlens_core::burn::keep_warm::compute_keep_warm;
use serde_json::Value;

fn kind_of(v: &Value) -> Option<SessionTtlKind> {
    match v.as_str() {
        Some("main") => Some(SessionTtlKind::Main),
        Some("subagent") => Some(SessionTtlKind::Subagent),
        Some("fork") => Some(SessionTtlKind::Fork),
        _ => None,
    }
}

fn ctx_of(v: &Value) -> Option<TtlContext> {
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
fn ttl_classifier_and_keep_warm_reproduce_the_ts_oracle_exactly() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let cases: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("keepwarm-cases.json")).unwrap()).unwrap();
    let expected: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("keepwarm-expected.json")).unwrap()).unwrap();

    // sessionTtlKindOf over the card fixtures.
    let cards = cases["cards"].as_array().unwrap();
    let kinds = expected["kinds"].as_array().unwrap();
    assert_eq!(cards.len(), kinds.len(), "cards/kinds length");
    for (card, exp) in cards.iter().zip(kinds.iter()) {
        assert_eq!(session_ttl_kind_of(card).as_str(), exp.as_str().unwrap(), "kind for {card}");
    }

    // classifyTtlRegime + computeKeepWarm per case.
    let in_cases = cases["cases"].as_array().unwrap();
    let exp_cases = expected["cases"].as_array().unwrap();
    assert_eq!(in_cases.len(), exp_cases.len(), "cases/expected length");
    for (c, e) in in_cases.iter().zip(exp_cases.iter()) {
        let name = c["name"].as_str().unwrap();
        let regime = classify_ttl_regime(kind_of(&c["kind"]), ctx_of(&c["ctx"]).as_ref());
        assert_eq!(regime.to_value(), e["regime"], "regime diverges for case: {name}");
        let timeline = c["timeline"].as_array().unwrap();
        let report = compute_keep_warm(timeline, &regime).unwrap_or(Value::Null);
        assert_eq!(report, e["report"], "report diverges for case: {name}");
    }
}

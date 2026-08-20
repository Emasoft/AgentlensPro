//! Port of src/ttlContext.ts (TRDD-VY1IUVUM) — the machine-level, I/O half feeding the pure
//! classifier in burn/cache_ttl: which AUTH regime is this machine's Claude Code running
//! under, and are the prompt-caching env overrides set? All signals fail-soft — an
//! unresolvable signal yields Unknown/false so the classifier reports 'assumed', never a
//! guess. The measured falsifier (keep_warm) catches a wrong detection with evidence.

use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

use super::account_info::AccountInfo;
use super::cache_ttl::AuthRegime;

/// Truthy env-flag semantics: '1'/'true' (and JSON 1/true in the settings block) are on.
fn flag_on(v: Option<&Value>) -> bool {
    match v {
        Some(Value::String(s)) => s == "1" || s == "true",
        Some(Value::Number(n)) => n.as_f64() == Some(1.0),
        Some(Value::Bool(b)) => *b,
        _ => false,
    }
}

fn flag_on_str(v: Option<&String>) -> bool {
    matches!(v.map(String::as_str), Some("1") | Some("true"))
}

/// detectTtlEnvOverrides — over BOTH the process env and the settings.json `env` block.
pub fn detect_ttl_env_overrides(process_env: &HashMap<String, String>, settings_env: Option<&Value>) -> (bool, bool) {
    let s = |k: &str| settings_env.and_then(|e| e.get(k));
    (
        flag_on_str(process_env.get("FORCE_PROMPT_CACHING_5M")) || flag_on(s("FORCE_PROMPT_CACHING_5M")),
        flag_on_str(process_env.get("ENABLE_PROMPT_CACHING_1H")) || flag_on(s("ENABLE_PROMPT_CACHING_1H")),
    )
}

/// resolveAuthRegime — the stripe_subscription root-cause fix kept verbatim: any billingType
/// whose lowercased value CONTAINS 'subscription' is the subscription row (Anthropic prefixes
/// the payment processor); drawing usage credits needs BOTH the extra-usage opt-in AND
/// positive over-plan evidence (5h pct ≥ 100).
pub fn resolve_auth_regime(account: Option<&AccountInfo>, five_hour_pct_consumed: Option<f64>) -> AuthRegime {
    let Some(billing) = account.and_then(|a| a.billing_type.as_deref()) else {
        return AuthRegime::Unknown;
    };
    if billing.to_lowercase().contains("subscription") {
        if account.is_some_and(|a| a.has_extra_usage_enabled) && five_hour_pct_consumed.is_some_and(|p| p >= 100.0) {
            return AuthRegime::UsageCredits;
        }
        return AuthRegime::Subscription;
    }
    AuthRegime::ApiKey
}

/// The `env` block of ~/.claude/settings.json, fail-soft. READ-ONLY — config WRITES go
/// through safeConfigEdit; this never writes.
pub fn read_settings_env(home_dir: &Path) -> Option<Value> {
    let raw = std::fs::read_to_string(home_dir.join(".claude").join("settings.json")).ok()?;
    let parsed: Value = serde_json::from_str(&raw).ok()?;
    parsed.get("env").filter(|v| v.is_object()).cloned()
}

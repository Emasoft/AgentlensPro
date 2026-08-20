//! Port of the shared helpers in src/accountStateTimeline.ts (TRDD-YQZ9P8IL, ported under
//! TRDD-DMWOBWFH P4x.2c) — the human PLAN name, the human billing MODE, and the raw auth regime.
//!
//! They live in their own module for the same reason they do in TS: `get_account_status` and the
//! account-state sampler must produce the SAME plan and mode strings, and the way to guarantee that
//! is one implementation, not two that agree today.
//!
//! NOT PORTED YET: `resolveStateAt` / `buildAccountStateRecord` (the ndjson timeline itself) — they
//! are only needed by `get_account_state_at`, which is not ported.

use std::sync::OnceLock;

use regex::Regex;

use crate::burn::account_info::AccountInfo;
use crate::burn::cache_ttl::TtlContext;

/// `default_claude_max_5x` → "5". Hoisted: compiling a Regex inside a per-call function is the
/// clippy `regex_creation_in_loops` shape and pointless work on a hot path.
fn tier_multiplier_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"(\d+)x\b").unwrap())
}

/// The human plan name from planType + the rate-limit tier's multiplier.
///
/// The DEFAULT arm is not a catch-all "unknown": an unrecognised `planType` is echoed VERBATIM with
/// the multiplier, because a plan name this code has not heard of is still the truth about the
/// account, and replacing it with "unknown" would hide a real answer behind a placeholder.
pub fn describe_plan(plan_type: Option<&str>, rate_limit_tier: Option<&str>) -> String {
    let tier = rate_limit_tier.unwrap_or("").to_lowercase();
    let mult = tier_multiplier_re().captures(&tier).map(|c| c[1].to_owned());
    // ` 5x`, not ` 5` — the `x` belongs to the SUFFIX in the TS, so `Max` + suffix is "Max 5x".
    let suffix = mult.as_ref().map_or(String::new(), |m| format!(" {m}x"));
    match plan_type.unwrap_or("").to_lowercase().as_str() {
        "max" => format!("Max{suffix}"),
        "pro" => "Pro".to_owned(),
        "team" => "Team".to_owned(),
        "enterprise" => "Enterprise".to_owned(),
        "free" => "Free".to_owned(),
        _ => match plan_type.filter(|p| !p.is_empty()) {
            // TS truthiness: an EMPTY planType is falsy and falls to the multiplier branch.
            Some(p) => format!("{p}{suffix}"),
            None => mult.map_or_else(|| "unknown".to_owned(), |m| format!("Max {m}x")),
        },
    }
}

/// The billing MODE in human words from the resolved auth regime.
pub fn describe_account_mode(auth_regime: Option<&str>) -> &'static str {
    match auth_regime {
        Some("subscription") => "subscription (within plan)",
        Some("usage-credits") => "subscription drawing usage credits (over plan limit)",
        Some("api-key") => "API key (pay-per-token)",
        _ => "unresolved",
    }
}

/// The raw auth regime from ttlCtx (preferred) or a coarse billingType read.
///
/// The SUBSTRING match is load-bearing: the real value is `stripe_subscription`, and an equality
/// check against "subscription" misreads a paying subscriber as an api-key account — which flips
/// the whole cache-TTL model (1h tier vs 5m) and every cost number derived from it.
/// A null billingType yields null, never a guess.
pub fn resolve_auth_regime_label(account: Option<&AccountInfo>, ttl_ctx: Option<&TtlContext>) -> Option<String> {
    // `ttlCtx?.auth ?? …` — the TS TtlContext always carries an `auth`, so a present ctx always
    // wins, including its 'unknown'.
    if let Some(ctx) = ttl_ctx {
        return Some(ctx.auth.as_str().to_owned());
    }
    let billing = account?.billing_type.as_deref().filter(|b| !b.is_empty())?;
    Some(if billing.to_lowercase().contains("subscription") { "subscription" } else { "api-key" }.to_owned())
}

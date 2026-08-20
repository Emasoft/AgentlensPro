//! Port of src/shared/cacheTtl.ts (TRDD-VY1IUVUM) — THE ONE PLACE the prompt-cache TTL
//! numbers live. Every gate/diagnostic consumer imports its TTL from here; the hardcoded
//! 5-min assumption is exactly the bug this module removes (field evidence 2026-07-11:
//! subscription MAIN sessions ride a ~1-hour TTL, so a global 5-min constant misclassified
//! their 20-min gaps as cold).
//!
//! HONESTY CONTRACT (kept verbatim from the TS): classification NEVER silently guesses —
//! every regime carries a ttl_source ('doc-matrix' | 'config' | 'measured' | 'assumed') and a
//! ttl_basis sentence naming WHICH signal decided the number.

use serde_json::{Map, Value};

use crate::summarize::helpers;

/// The only two TTL tiers Anthropic enforces (doc fact). Everything else is derived.
pub const TTL_5M_MIN: f64 = 5.0;
pub const TTL_1H_MIN: f64 = 60.0;
pub const TTL_5M_MS: f64 = TTL_5M_MIN * 60_000.0;
pub const TTL_1H_MS: f64 = TTL_1H_MIN * 60_000.0;

/// Slack added on top of the TTL before the burn-gate calls a parent cache "cold" (mtime-based
/// idle measurement lags the real last-request time by seconds; an exact-TTL cutoff would flap).
pub const COLD_IDLE_SLACK_MS: f64 = 30_000.0;
pub const DEFAULT_COLD_IDLE_MS: f64 = TTL_5M_MS + COLD_IDLE_SLACK_MS;

/// Lineage kind for TTL purposes (sessionTtlKindOf).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SessionTtlKind {
    Main,
    Subagent,
    Fork,
}

impl SessionTtlKind {
    pub fn as_str(self) -> &'static str {
        match self {
            SessionTtlKind::Main => "main",
            SessionTtlKind::Subagent => "subagent",
            SessionTtlKind::Fork => "fork",
        }
    }
}

/// Auth regime resolved from the machine's live account signals. 'unknown' = signal absent.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AuthRegime {
    Subscription,
    UsageCredits,
    ApiKey,
    Unknown,
}

impl AuthRegime {
    pub fn as_str(self) -> &'static str {
        match self {
            AuthRegime::Subscription => "subscription",
            AuthRegime::UsageCredits => "usage-credits",
            AuthRegime::ApiKey => "api-key",
            AuthRegime::Unknown => "unknown",
        }
    }
}

/// Machine-level TTL signals, resolved by the caller and passed into this pure classifier.
#[derive(Clone, Copy, Debug)]
pub struct TtlContext {
    pub auth: AuthRegime,
    /// FORCE_PROMPT_CACHING_5M=1 detected. Wins over auth.
    pub force5m: bool,
    /// ENABLE_PROMPT_CACHING_1H=1 detected — opts an API-key session into the 1h tier.
    pub enable1h: bool,
}

/// A session's resolved TTL regime — what every TTL-aware consumer reads.
#[derive(Clone, Debug, PartialEq)]
pub struct TtlRegime {
    pub ttl_ms: f64,
    pub ttl_assumed_min: f64,
    pub ttl_source: &'static str,
    pub ttl_basis: String,
}

impl TtlRegime {
    /// The regime as the TS object literal (key order preserved) — embedded in burn wire
    /// payloads and compared against the oracle.
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("ttlMs".into(), helpers::num(self.ttl_ms));
        m.insert("ttlAssumedMin".into(), helpers::num(self.ttl_assumed_min));
        m.insert("ttlSource".into(), self.ttl_source.into());
        m.insert("ttlBasis".into(), self.ttl_basis.clone().into());
        Value::Object(m)
    }
}

/// ASSUMED_TTL_REGIME — the no-signals fallback: the conservative 5-min floor, labeled as the
/// assumption it is. A fn, not a const: the String field forbids a const literal.
pub fn assumed_ttl_regime() -> TtlRegime {
    TtlRegime {
        ttl_ms: TTL_5M_MS,
        ttl_assumed_min: TTL_5M_MIN,
        ttl_source: "assumed",
        ttl_basis: "no kind/auth signals — conservative 5-min floor assumed".to_owned(),
    }
}

/// sessionTtlKindOf — spawnKind is checked BEFORE parentSessionId because a fork IS a child
/// card (parentSessionId set) yet reads the PARENT's cache entry; classifying it 'subagent'
/// would wrongly pin it to the 5-min tier. `if (card.parentSessionId)` is TS truthiness — an
/// empty string does not make a subagent.
pub fn session_ttl_kind_of(card: &Value) -> SessionTtlKind {
    if card.get("spawnKind").and_then(Value::as_str) == Some("fork") {
        return SessionTtlKind::Fork;
    }
    if card.get("parentSessionId").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) {
        return SessionTtlKind::Subagent;
    }
    SessionTtlKind::Main
}

/// classifyTtlRegime — the doc matrix as code. Rule ORDER is load-bearing (see the TS header):
/// subagent first (auth-independent), then the no-signals fallback, then FORCE_PROMPT_CACHING_5M,
/// then main/fork by auth (a fork rides the parent-conversation regime).
pub fn classify_ttl_regime(kind: Option<SessionTtlKind>, ctx: Option<&TtlContext>) -> TtlRegime {
    if kind == Some(SessionTtlKind::Subagent) {
        return TtlRegime {
            ttl_ms: TTL_5M_MS,
            ttl_assumed_min: TTL_5M_MIN,
            ttl_source: "doc-matrix",
            ttl_basis: "subagent — own conversation, own 5-min cache (the 1h auto applies only to the main conversation)".to_owned(),
        };
    }
    let (Some(ctx), Some(kind)) = (ctx, kind) else {
        return assumed_ttl_regime();
    };
    if ctx.force5m {
        return TtlRegime {
            ttl_ms: TTL_5M_MS,
            ttl_assumed_min: TTL_5M_MIN,
            ttl_source: "config",
            ttl_basis: "FORCE_PROMPT_CACHING_5M=1 detected — forces the 5-min tier regardless of auth".to_owned(),
        };
    }
    let kind_label = if kind == SessionTtlKind::Fork { "fork (reads the PARENT conversation's cache entry)" } else { "main conversation" };
    match ctx.auth {
        AuthRegime::Subscription => TtlRegime {
            ttl_ms: TTL_1H_MS,
            ttl_assumed_min: TTL_1H_MIN,
            ttl_source: "doc-matrix",
            ttl_basis: format!("{kind_label} on a Claude subscription within plan — automatic 1-hour tier"),
        },
        AuthRegime::UsageCredits => TtlRegime {
            ttl_ms: TTL_5M_MS,
            ttl_assumed_min: TTL_5M_MIN,
            ttl_source: "doc-matrix",
            ttl_basis: format!("{kind_label} on a subscription drawing USAGE CREDITS (over plan limit) — dropped to the 5-min tier"),
        },
        AuthRegime::ApiKey => {
            if ctx.enable1h {
                TtlRegime {
                    ttl_ms: TTL_1H_MS,
                    ttl_assumed_min: TTL_1H_MIN,
                    ttl_source: "config",
                    ttl_basis: format!("{kind_label} on an API key with ENABLE_PROMPT_CACHING_1H=1 — opted into the 1-hour tier"),
                }
            } else {
                TtlRegime {
                    ttl_ms: TTL_5M_MS,
                    ttl_assumed_min: TTL_5M_MIN,
                    ttl_source: "doc-matrix",
                    ttl_basis: format!("{kind_label} on an API key / Bedrock / GCP / Foundry — 5-min default tier"),
                }
            }
        }
        AuthRegime::Unknown => assumed_ttl_regime(),
    }
}

/// ttlPhrase — "60-min TTL (doc-matrix)": every user-facing number carries provenance.
pub fn ttl_phrase(regime: &TtlRegime) -> String {
    format!("{}-min TTL ({})", helpers::fmt_js_num(regime.ttl_assumed_min), regime.ttl_source)
}

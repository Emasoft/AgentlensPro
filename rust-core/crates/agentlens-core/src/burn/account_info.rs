//! Port of src/accountInfo.ts (TRDD-BURNWDGT) — the CURRENTLY-active Claude Code OAuth
//! account (identity + plan) for the per-account window labels and "who am I / what plan".
//!
//! Two live-only sources, exactly as in TS: `~/.claude.json` `oauthAccount` (identity fields,
//! no secret) and — STRICTLY OPT-IN (`AGENTLENS_READ_KEYCHAIN_PLAN=1`), macOS-only, latched to
//! AT MOST ONCE per process — the keychain credential's `subscriptionType`. The credential
//! blob also holds the OAuth tokens; `parse_subscription_type` is the single choke-point and
//! returns only the plan string. Everything is fail-soft: nulls, never a throw, never a secret.

use serde_json::{Map, Value};
use std::path::Path;
use std::sync::OnceLock;

use crate::summarize::helpers::js_slice;

#[derive(Clone, Debug, Default)]
pub struct AccountInfo {
    pub account_uuid: Option<String>,
    pub email: Option<String>,
    pub organization_name: Option<String>,
    pub organization_uuid: Option<String>,
    /// e.g. "stripe_subscription" | "api" — any value CONTAINING 'subscription' is window-limited.
    pub billing_type: Option<String>,
    pub has_extra_usage_enabled: bool,
    pub organization_rate_limit_tier: Option<String>,
    pub user_rate_limit_tier: Option<String>,
    pub display_name: Option<String>,
    pub plan_type: Option<String>,
    pub rate_limit_tier: Option<String>,
    pub label: String,
    pub source: &'static str, // "claude.json" | "none"
}

impl AccountInfo {
    /// The TS AccountInfo object shape (identity spread first, then the four derived fields).
    pub fn to_value(&self) -> Value {
        let os = |v: &Option<String>| v.clone().map_or(Value::Null, Value::from);
        let mut m = Map::new();
        m.insert("accountUuid".into(), os(&self.account_uuid));
        m.insert("email".into(), os(&self.email));
        m.insert("organizationName".into(), os(&self.organization_name));
        m.insert("organizationUuid".into(), os(&self.organization_uuid));
        m.insert("billingType".into(), os(&self.billing_type));
        m.insert("hasExtraUsageEnabled".into(), Value::Bool(self.has_extra_usage_enabled));
        m.insert("organizationRateLimitTier".into(), os(&self.organization_rate_limit_tier));
        m.insert("userRateLimitTier".into(), os(&self.user_rate_limit_tier));
        m.insert("displayName".into(), os(&self.display_name));
        m.insert("planType".into(), os(&self.plan_type));
        m.insert("rateLimitTier".into(), os(&self.rate_limit_tier));
        m.insert("label".into(), self.label.clone().into());
        m.insert("source".into(), self.source.into());
        Value::Object(m)
    }
}

/// TS `str()` — a non-empty string, else null.
fn nes(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
}

/// parseOauthAccount — the identity half of AccountInfo from ~/.claude.json text. None on any
/// malformed input (a corrupt config never crashes the monitor). The derived fields (plan,
/// tier, label, source) are filled by `get_current_account`.
pub fn parse_oauth_account(claude_json_text: &str) -> Option<AccountInfo> {
    let root: Value = serde_json::from_str(claude_json_text).ok()?;
    let oa = root.get("oauthAccount").filter(|v| v.is_object())?;
    Some(AccountInfo {
        account_uuid: nes(oa.get("accountUuid")),
        email: nes(oa.get("emailAddress")),
        organization_name: nes(oa.get("organizationName")),
        organization_uuid: nes(oa.get("organizationUuid")),
        billing_type: nes(oa.get("billingType")),
        has_extra_usage_enabled: oa.get("hasExtraUsageEnabled") == Some(&Value::Bool(true)),
        organization_rate_limit_tier: nes(oa.get("organizationRateLimitTier")),
        user_rate_limit_tier: nes(oa.get("userRateLimitTier")),
        display_name: nes(oa.get("displayName")),
        ..AccountInfo::default()
    })
}

/// parseSubscriptionType — THE SECURITY CHOKE-POINT: from the keychain credential JSON (which
/// also holds the OAuth tokens) extract ONLY the plan string; never any token field.
pub fn parse_subscription_type(credential_json_text: &str) -> Option<String> {
    let o: Value = serde_json::from_str(credential_json_text).ok()?;
    let inner = o.get("claudeAiOauth").filter(|v| v.is_object()).unwrap_or(&o);
    nes(inner.get("subscriptionType"))
}

/// accountLabelFor — email, else display name, else short uuid, else 'unknown'; a DIFFERENT
/// (rotated-away) uuid resolves only to its short id.
pub fn account_label_for(id: Option<&AccountInfo>, account_uuid: Option<&str>) -> String {
    if let Some(id) = id {
        if account_uuid.is_none() || id.account_uuid.as_deref() == account_uuid {
            return id
                .email
                .clone()
                .or_else(|| id.display_name.clone())
                .or_else(|| id.account_uuid.as_deref().map(|u| js_slice(u, 8).to_owned()))
                .unwrap_or_else(|| "unknown".to_owned());
        }
    }
    account_uuid.map_or_else(|| "unknown".to_owned(), |u| js_slice(u, 8).to_owned())
}

/// The one-shot keychain latch (bug autopsy 2026-07-09, kept verbatim from TS): an un-ACL'd
/// read PROMPTS the user, so the read is opt-in AND attempted at most once per process —
/// any outcome latches. Process-global deliberately: the safety property must hold across
/// every BurnRuntime a test constructs.
static KEYCHAIN_PLAN: OnceLock<Option<String>> = OnceLock::new();

fn read_keychain_subscription_type(opted_in: bool) -> Option<String> {
    KEYCHAIN_PLAN
        .get_or_init(|| {
            if !cfg!(target_os = "macos") || !opted_in {
                return None;
            }
            let mut child = std::process::Command::new("security")
                .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::null())
                .spawn()
                .ok()?;
            // The TS uses a 3s execFile timeout; poll-wait the same ceiling, then kill.
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
            loop {
                match child.try_wait() {
                    Ok(Some(status)) => {
                        if !status.success() {
                            return None;
                        }
                        let mut out = String::new();
                        use std::io::Read;
                        child.stdout.take()?.read_to_string(&mut out).ok()?;
                        return parse_subscription_type(&out);
                    }
                    Ok(None) => {
                        if std::time::Instant::now() >= deadline {
                            let _ = child.kill();
                            return None;
                        }
                        std::thread::sleep(std::time::Duration::from_millis(50));
                    }
                    Err(_) => return None,
                }
            }
        })
        .clone()
}

/// getCurrentAccount (uncached — the 60s cache lives on BurnRuntime). `read_keychain` is the
/// injectable plan resolver, as in TS; None = the real latched keychain read.
pub fn get_current_account(home_dir: &Path, vars: &std::collections::HashMap<String, String>, read_keychain: Option<&dyn Fn() -> Option<String>>) -> AccountInfo {
    let identity = std::fs::read_to_string(home_dir.join(".claude.json")).ok().and_then(|t| parse_oauth_account(&t));
    let plan_type = match read_keychain {
        Some(f) => f(),
        None => read_keychain_subscription_type(vars.get("AGENTLENS_READ_KEYCHAIN_PLAN").map(String::as_str) == Some("1")),
    };
    match identity {
        Some(id) => {
            let label = account_label_for(Some(&id), None);
            AccountInfo {
                plan_type,
                rate_limit_tier: id.organization_rate_limit_tier.clone().or_else(|| id.user_rate_limit_tier.clone()),
                label,
                source: "claude.json",
                ..id
            }
        }
        None => AccountInfo { plan_type, label: "unknown".to_owned(), source: "none", ..AccountInfo::default() },
    }
}

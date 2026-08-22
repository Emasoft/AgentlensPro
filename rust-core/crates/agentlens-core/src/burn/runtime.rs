//! The burn subsystem's server-side plumbing (server.ts:1472–1680 + the mcpServer label
//! layer) — the stateful glue between the pure monitor and the live process: the loaded
//! BurnConfig, the 4s tick's `lastBurnStatus` cache, the 60s slow-signal cache
//! (account + TTL env overrides), and the enrichment `/api/burn-status` + the SSE
//! burnStatus frames serve.
//!
//! NOT PORTED here (each honest, none silent):
//!   - statuslineReader.getBillingEvents — the statusline store is unported; the gathered
//!     stream carries api_request events only (the rich source; statusline is the fallback).
//!   - latestResidentBlobs — the composition-index subsystem is unported; `residentBlobs: []`
//!     (the TS value while its slow scan has not landed).
//!   - macNotify — the opt-in macOS osascript notification.

use serde_json::{Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;

use super::account_info::{account_label_for, get_current_account, AccountInfo};
use super::cache_ttl::TtlContext;
use super::monitor::{load_burn_config, BurnConfig};
use super::ttl_context::{detect_ttl_env_overrides, read_settings_env, resolve_auth_regime};

/// The slow signals (settings.json read + account resolution) cache for ~60s — the burn tick
/// fires every 4s and (P4r.4) the gate sits on the PreToolUse hot path.
const SLOW_CACHE_MS: f64 = 60_000.0;

struct Slow {
    account: AccountInfo,
    force5m: bool,
    enable1h: bool,
    ts: f64,
}

pub struct BurnRuntime {
    pub home_dir: PathBuf,
    pub vars: HashMap<String, String>,
    pub config: BurnConfig,
    /// server.ts `lastBurnStatus` — the tick's latest computed status, reused by hot request
    /// paths and by the TTL resolver's usage-credit signal (a ≤4s-stale pct is fine).
    pub last_status: Option<Value>,
    /// server.ts bodiesActivityReport() — the incremental raw-bodies watcher behind
    /// HUGE_REQUEST_BURST + CACHE_THRASH. Polled on the burn tick (O(new files) per poll).
    pub bodies: super::bodies_activity::BodiesActivityTracker,
    /// server.ts `lastSeenAccountUuid` — the burn tick's rotation edge detector. ROTATION IS THE
    /// ONE MOMENT A NON-LIVE ACCOUNT CAN BE READ: rate limits are per account and the usage
    /// endpoint only ever answers for the credential currently installed, so the only chance to
    /// capture account B's windows is while B is live. Miss the edge and B stays `unreadable`
    /// until the next rotation, however long that is.
    pub last_seen_account_uuid: Option<String>,
    slow: Option<Slow>,
}

impl BurnRuntime {
    pub fn new(home_dir: PathBuf, vars: HashMap<String, String>, data_dir: &std::path::Path) -> BurnRuntime {
        let config = load_burn_config(&vars, &home_dir);
        let bodies = super::bodies_activity::BodiesActivityTracker::new(
            super::guard::default_bodies_dir(data_dir),
            super::bodies_activity::BodiesActivityOptions::default(),
        );
        // `None`, not the current account: the FIRST tick must count as an edge, so a server that
        // starts while an account is already live still captures that account's windows once.
        // That first edge IS the port of server.ts's `refreshAccountUsage('startup')` — the TS
        // fires it explicitly at boot; here it falls out of the seed, which is why the seed is a
        // decision and not an initialization detail (tests/burn_rotation.rs gates it).
        BurnRuntime { home_dir, vars, config, last_status: None, bodies, last_seen_account_uuid: None, slow: None }
    }

    /// Point the runtime at a different home (tests) — clears every cached slow signal and
    /// reloads the config so nothing from the previous home leaks through the 60s cache.
    pub fn set_home_dir(&mut self, home_dir: PathBuf) {
        self.home_dir = home_dir;
        self.config = load_burn_config(&self.vars, &self.home_dir);
        self.slow = None;
        self.last_status = None;
    }

    fn slow(&mut self, now_ms: f64) -> &Slow {
        let stale = self.slow.as_ref().is_none_or(|s| now_ms - s.ts >= SLOW_CACHE_MS);
        if stale {
            let account = get_current_account(&self.home_dir, &self.vars, None);
            let (force5m, enable1h) = detect_ttl_env_overrides(&self.vars, read_settings_env(&self.home_dir).as_ref());
            self.slow = Some(Slow { account, force5m, enable1h, ts: now_ms });
        }
        self.slow.as_ref().expect("just filled")
    }

    /// getCurrentAccount through the 60s cache.
    pub fn current_account(&mut self, now_ms: f64) -> AccountInfo {
        self.slow(now_ms).account.clone()
    }

    /// currentTtlContext (server.ts:1183) — the usage-credit overflow signal reads the LAST
    /// computed burn status's 5h fill rather than recomputing.
    pub fn ttl_context(&mut self, now_ms: f64) -> TtlContext {
        let pct = self
            .last_status
            .as_ref()
            .and_then(|s| s.get("window")?.get("fiveHour")?.get("pctConsumed")?.as_f64());
        let slow = self.slow(now_ms);
        TtlContext { auth: resolve_auth_regime(Some(&slow.account), pct), force5m: slow.force5m, enable1h: slow.enable1h }
    }
}

/// summarizeCurrentAccount — pointer-only identity + plan; null when no account resolves.
pub fn summarize_current_account(a: &AccountInfo) -> Value {
    if a.source == "none" {
        return Value::Null;
    }
    let os = |v: &Option<String>| v.clone().map_or(Value::Null, Value::from);
    let mut m = Map::new();
    m.insert("accountId".into(), os(&a.account_uuid));
    m.insert("label".into(), a.label.clone().into());
    m.insert("email".into(), os(&a.email));
    m.insert("organizationName".into(), os(&a.organization_name));
    m.insert("planType".into(), os(&a.plan_type));
    m.insert("billingType".into(), os(&a.billing_type));
    m.insert("hasExtraUsageEnabled".into(), Value::Bool(a.has_extra_usage_enabled));
    Value::Object(m)
}

/// labelBurnStatusAccounts (src/mcpServer.ts:3172) — `{...w, accountLabel}` on every
/// per-account window, immutably.
pub fn label_burn_status_accounts(status: &Value, account: Option<&AccountInfo>) -> Value {
    let mut out = status.as_object().cloned().unwrap_or_default();
    if let Some(windows) = status.get("accountWindows").and_then(Value::as_array) {
        let labeled: Vec<Value> = windows
            .iter()
            .map(|w| {
                let uuid = w.get("accountUuid").and_then(Value::as_str);
                let label = match account {
                    // accountLabelFor's `accountUuid == null` is LOOSE — the null (unknown)
                    // bucket takes the CURRENT account's label in TS; mirrored via None here.
                    Some(a) => account_label_for(Some(a), uuid),
                    None => uuid.filter(|u| !u.is_empty()).map_or_else(|| "unknown".to_owned(), |u| crate::summarize::helpers::js_slice(u, 8).to_owned()),
                };
                let mut o = w.as_object().cloned().unwrap_or_default();
                o.insert("accountLabel".into(), label.into());
                Value::Object(o)
            })
            .collect();
        out.insert("accountWindows".into(), Value::Array(labeled));
    }
    Value::Object(out)
}

/// enrichBurnStatus (server.ts:1514) — labels + the current account + the resident-blob flag.
///
/// `resident_blobs` is the 30s chore's CACHE (`CoreState::latest_resident_blobs`), passed in
/// rather than computed here: this runs on the 4s burn tick, and re-deriving every session's
/// composition four times a minute for a value that moves far more slowly is precisely what the
/// TS avoids by giving the scan its own 30s timer.
pub fn enrich_burn_status(status: &Value, account: &AccountInfo, resident_blobs: &[Value]) -> Value {
    let mut out = label_burn_status_accounts(status, Some(account)).as_object().cloned().unwrap_or_default();
    out.insert("currentAccount".into(), summarize_current_account(account));
    out.insert("residentBlobs".into(), Value::Array(resident_blobs.to_vec()));
    Value::Object(out)
}

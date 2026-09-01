//! Port of src/capacityCalibration.ts (P5) — turns a rate-limit hit into a MEASURED window
//! capacity. Anthropic does not publish the raw 5h/7d window caps, so an unconfigured machine
//! has no window budget at all (`capacitySource: none`). But the cap IS observable: the moment a
//! rate-limit-class StopFailure kills a turn BEFORE the account's 5h window rolled, the
//! consumption accumulated since the window started is a proven LOWER BOUND on the cap. This
//! module snapshots that figure into `~/.agentlens/burn-config.json` (`observed`), which
//! `burn::monitor::load_burn_config` / `compute_window_budget` already read.
//!
//! Hard rules (each guarded below AND covered by src/test/serverCalibration.test.ts):
//!   - only rate-limit-CLASS StopFailures calibrate (an auth/network turn death proves nothing);
//!   - NEVER clobber user-configured capacity — any manual cap (env or file) disables calibration;
//!   - a PREMATURE window end is a measurement, a natural 5h rollover is NOT (straddle guard);
//!   - later observations may RAISE an observed figure, never lower it (ratchet);
//!   - atomic write (temp+rename) and refuse-unparseable — a torn/corrupt config is never
//!     overwritten with a "fresh" one (the 2026-07-07 settings.json lesson).

use std::collections::HashMap;
use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::burn::monitor::{burn_config_path, load_burn_config, observe_capacity_from_premature_end, ObservedAccountCapacity};
use crate::summarize::helpers::iso_from_ms;

const FIVE_HOURS_MS: f64 = 5.0 * 60.0 * 60.0 * 1000.0;
const SEVEN_DAYS_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;
/// How far past the 5h boundary we look for earlier consumption. Activity in this margin BEFORE
/// (stall − 5h) means the rolling 5h sum straddles a window boundary — the account's real window
/// started >5h ago and rolled naturally, so the sum mixes two windows and is NOT a cap.
const ROLLOVER_LOOKBACK_MS: f64 = 30.0 * 60.0 * 1000.0;

/// Rate-limit-class signatures seen in real StopFailure payloads. Deliberately NOT matching
/// generic "error"/"timeout" — a network or auth turn death says nothing about window capacity.
fn rate_limit_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r"(?i)rate.?limit|usage.?limit|limit (?:reached|exceeded)|too many requests|overloaded|quota|\b(?:429|529)\b").unwrap()
    })
}

/// isRateLimitStopFailure — only the payload's dedicated error fields are scanned; matching the
/// whole payload would false-positive on paths/prompts that merely contain the words.
pub fn is_rate_limit_stop_failure(payload: &Value) -> bool {
    for key in ["error", "message", "reason"] {
        if let Some(v) = payload.get(key).and_then(Value::as_str) {
            if rate_limit_re().is_match(v) {
                return true;
            }
        }
    }
    false
}

pub struct CalibrationOutcome {
    pub calibrated: bool,
    /// Human-readable why (logged by the server; every skip names its guard).
    pub reason: String,
    pub account_uuid: Option<String>,
}

fn skip(reason: impl Into<String>) -> CalibrationOutcome {
    CalibrationOutcome { calibrated: false, reason: reason.into(), account_uuid: None }
}

fn skip_acct(reason: impl Into<String>, account_uuid: String) -> CalibrationOutcome {
    CalibrationOutcome { calibrated: false, reason: reason.into(), account_uuid: Some(account_uuid) }
}

fn ev_ts(e: &Value) -> f64 {
    e.get("ts").and_then(Value::as_f64).unwrap_or(0.0)
}

fn ev_account(e: &Value) -> Option<&str> {
    e.get("accountUuid").and_then(Value::as_str)
}

/// Field-wise ratchet: an observed figure only ever goes UP. A later window that consumed LESS
/// before limiting proves nothing about the cap; a window that consumed MORE proves the cap is at
/// least that.
fn ratchet(prev: Option<&ObservedAccountCapacity>, next: ObservedAccountCapacity) -> (ObservedAccountCapacity, bool) {
    let Some(prev) = prev else { return (next, true) };
    let up = |a: Option<f64>, b: Option<f64>| match (a, b) {
        (None, b) => b,
        (a, None) => a,
        (Some(a), Some(b)) => Some(a.max(b)),
    };
    let mut merged = ObservedAccountCapacity {
        window5h_tokens: up(prev.window5h_tokens, next.window5h_tokens),
        window7d_tokens: up(prev.window7d_tokens, next.window7d_tokens),
        window5h_cost_usd: up(prev.window5h_cost_usd, next.window5h_cost_usd),
        window7d_cost_usd: up(prev.window7d_cost_usd, next.window7d_cost_usd),
        observed_at: prev.observed_at.clone(),
    };
    let raised = merged.window5h_tokens != prev.window5h_tokens
        || merged.window7d_tokens != prev.window7d_tokens
        || merged.window5h_cost_usd != prev.window5h_cost_usd
        || merged.window7d_cost_usd != prev.window7d_cost_usd;
    if raised {
        merged.observed_at = next.observed_at; // the calibration date is the last RAISING observation
    }
    (merged, raised)
}

/// The wire shape `capacityCalibration.ts` merges into the `observed` map.
fn observed_to_value(v: &ObservedAccountCapacity) -> Value {
    let opt = |n: Option<f64>| n.map_or(Value::Null, Value::from);
    let mut m = Map::new();
    m.insert("window5hTokens".into(), opt(v.window5h_tokens));
    m.insert("window7dTokens".into(), opt(v.window7d_tokens));
    m.insert("window5hCostUsd".into(), opt(v.window5h_cost_usd));
    m.insert("window7dCostUsd".into(), opt(v.window7d_cost_usd));
    m.insert("observedAt".into(), v.observed_at.clone().map_or(Value::Null, Value::from));
    Value::Object(m)
}

/// The ingest-path hook: called for every StopFailure hook event. Applies all the guards,
/// measures the account's window consumption at the stall, and atomically persists the observed
/// capacity. Never panics — a write failure is reported in `reason`, matching the TS contract
/// that a calibration failure can never break hook ingestion (the caller only logs the outcome).
pub fn calibrate_from_stop_failure(
    rec: &Value,
    events: &[Value],
    sessions: &[Value],
    current_account_uuid: Option<&str>,
    vars: &HashMap<String, String>,
    home_dir: &Path,
) -> CalibrationOutcome {
    let ev = rec.get("ev").and_then(Value::as_str).unwrap_or("");
    if ev != "StopFailure" {
        return skip(format!("not a StopFailure event ({ev})"));
    }
    let payload = rec.get("payload").cloned().unwrap_or(Value::Null);
    if !is_rate_limit_stop_failure(&payload) {
        return skip("StopFailure error is not rate-limit-class — no capacity information");
    }

    // NEVER clobber user-configured capacity: any manual cap (env or file) disables calibration
    // entirely. Checked against a FRESH load, not a boot-time snapshot — the user may have
    // configured a cap while the server was running.
    let config = load_burn_config(vars, home_dir);
    if config.capacity_source == "env" || config.capacity_source == "config" {
        return skip(format!(
            "capacity is user-configured ({}) — auto-calibration never overrides it",
            config.capacity_source
        ));
    }

    // The HOT account: the stalled session's own OAuth account when attributed, else the live account.
    let session_id = rec.get("session").and_then(Value::as_str);
    let session_account = session_id
        .and_then(|sid| sessions.iter().find(|c| c.get("sessionId").and_then(Value::as_str) == Some(sid)))
        .and_then(|c| c.get("accountId"))
        .and_then(Value::as_str);
    let Some(account_uuid) = session_account.or(current_account_uuid) else {
        return skip("no OAuth account resolvable for the stalled session — nothing to key the observation by");
    };
    let account_uuid = account_uuid.to_owned();

    let stop_ts = rec.get("ts").and_then(Value::as_f64).unwrap_or(0.0);
    let account_events: Vec<&Value> = events.iter().filter(|e| ev_account(e) == Some(account_uuid.as_str())).collect();
    let in5h: Vec<&&Value> = account_events.iter().filter(|e| { let t = ev_ts(e); t >= stop_ts - FIVE_HOURS_MS && t <= stop_ts }).collect();
    if in5h.is_empty() {
        return skip_acct(
            format!("no consumption attributed to account {account_uuid} in the 5h before the stall — nothing to measure"),
            account_uuid,
        );
    }

    // Window-age guard: consumption in the lookback margin BEFORE the 5h boundary means the
    // account was already burning >5h ago — its real window started back then and rolled
    // naturally at some point inside our 5h sum. That sum mixes two windows: a rollover is NOT a
    // capacity measurement.
    let straddles = account_events.iter().any(|e| {
        let t = ev_ts(e);
        t >= stop_ts - FIVE_HOURS_MS - ROLLOVER_LOOKBACK_MS && t < stop_ts - FIVE_HOURS_MS
    });
    if straddles {
        return skip_acct(
            "consumption straddles the 5h boundary — the window rolled naturally, not a premature end",
            account_uuid,
        );
    }

    // The window START is the account's first event inside the 5h span: with the straddle guard
    // above, the account was idle for ≥30min before it, which is how a fresh Anthropic 5h window
    // begins (first message after the previous window lapsed).
    let window_start_ms = in5h.iter().fold(f64::INFINITY, |m, e| m.min(ev_ts(e)));
    let measured5h = observe_capacity_from_premature_end(events, Some(&account_uuid), window_start_ms, stop_ts);
    let m5_tokens = measured5h.get("tokens").and_then(Value::as_f64).unwrap_or(0.0);
    let m5_cost = measured5h.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0);
    if m5_tokens <= 0.0 && m5_cost <= 0.0 {
        return skip_acct("measured window consumption is zero — nothing to persist", account_uuid);
    }
    // The trailing-7d consumption at the stall is an observed FLOOR of the weekly cap too: the
    // account provably consumed this much within 7d (the limit that fired was the 5h one, so the
    // weekly cap is at least this). It ratchets upward across observations exactly like the 5h figure.
    let measured7d = observe_capacity_from_premature_end(events, Some(&account_uuid), stop_ts - SEVEN_DAYS_MS, stop_ts);
    let m7_tokens = measured7d.get("tokens").and_then(Value::as_f64).unwrap_or(0.0);
    let m7_cost = measured7d.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0);

    let next = ObservedAccountCapacity {
        window5h_tokens: (m5_tokens > 0.0).then_some(m5_tokens),
        window7d_tokens: (m7_tokens > 0.0).then_some(m7_tokens),
        window5h_cost_usd: (m5_cost > 0.0).then_some(m5_cost),
        window7d_cost_usd: (m7_cost > 0.0).then_some(m7_cost),
        observed_at: Some(iso_from_ms(stop_ts)),
    };
    let (merged, raised) = ratchet(config.observed.get(&account_uuid), next);
    if !raised {
        return skip_acct(
            "a prior observation is already ≥ this one on every figure — observed capacity never lowers",
            account_uuid,
        );
    }

    // Persist: merge into the RAW file (preserving thresholds/notify/any manual fields verbatim)
    // and write atomically. An existing-but-unparseable file is REFUSED, never replaced — silently
    // starting fresh is the exact pattern that wiped a user's settings.json on 2026-07-07.
    let config_path = burn_config_path(vars, home_dir);
    let mut raw: Map<String, Value> = Map::new();
    if config_path.exists() {
        let text = match std::fs::read_to_string(&config_path) {
            Ok(t) => t,
            Err(_) => {
                return skip_acct(
                    format!("refusing to write: {} exists but is unparseable — never clobber a corrupt config", config_path.display()),
                    account_uuid,
                )
            }
        };
        match serde_json::from_str::<Value>(&text) {
            Ok(Value::Object(m)) => raw = m,
            Ok(_) => {
                return skip_acct(format!("refusing to write: {} is not a JSON object", config_path.display()), account_uuid)
            }
            Err(_) => {
                return skip_acct(
                    format!("refusing to write: {} exists but is unparseable — never clobber a corrupt config", config_path.display()),
                    account_uuid,
                )
            }
        }
    }
    let mut observed_section = raw.get("observed").and_then(Value::as_object).cloned().unwrap_or_default();
    observed_section.insert(account_uuid.clone(), observed_to_value(&merged));
    raw.insert("observed".into(), Value::Object(observed_section));

    if let Some(parent) = config_path.parent() {
        if let Err(e) = std::fs::create_dir_all(parent) {
            return skip_acct(format!("failed to create {}: {e}", parent.display()), account_uuid);
        }
    }
    let body = match serde_json::to_string_pretty(&Value::Object(raw)) {
        Ok(s) => s + "\n",
        Err(e) => return skip_acct(format!("failed to serialize burn-config.json: {e}"), account_uuid),
    };
    let file_name = config_path.file_name().and_then(|n| n.to_str()).unwrap_or("burn-config.json");
    let tmp_path = config_path.with_file_name(format!("{file_name}.tmp-{}", std::process::id()));
    if let Err(e) = std::fs::write(&tmp_path, &body) {
        return skip_acct(format!("failed writing temp config: {e}"), account_uuid);
    }
    if let Err(e) = std::fs::rename(&tmp_path, &config_path) {
        return skip_acct(format!("failed renaming temp config into place: {e}"), account_uuid);
    }

    CalibrationOutcome {
        calibrated: true,
        reason: format!(
            "observed 5h capacity {} tokens / ${} for account {account_uuid} (window {} → {})",
            merged.window5h_tokens.map_or("—".to_owned(), |v| v.to_string()),
            merged.window5h_cost_usd.map_or("—".to_owned(), |v| v.to_string()),
            iso_from_ms(window_start_ms),
            iso_from_ms(stop_ts),
        ),
        account_uuid: Some(account_uuid),
    }
}

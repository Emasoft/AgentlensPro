//! src/retentionConfig.ts — the persistent retention knobs in `<data-dir>/config.json`
//! (TRDD-ZAV74M8Q). Precedence per knob, highest first: env var > `config.json`
//! `retention.<key>` > built-in default, with the `min` floor applied LAST (the server's old
//! `Math.max` floors). Reading must never fail boot: a missing/unreadable/invalid file or a
//! non-numeric value is simply "not set" and the next source takes over.
//!
//! One table (RETENTION_META) is the single source of the env names, keys, defaults and floors,
//! as in the TS — a changed default cannot drift between the window and the stats endpoint.

use std::path::Path;

use serde_json::Value;

pub struct Knob {
    pub key: &'static str,
    pub env: &'static str,
    pub def: f64,
    pub min: f64,
}

pub const SPANS_RETENTION_DAYS: Knob = Knob { key: "spansRetentionDays", env: "AGENTLENS_SPANS_RETENTION_DAYS", def: 30.0, min: 1.0 };
pub const SUMMARY_WINDOW_HOURS: Knob = Knob { key: "summaryWindowHours", env: "AGENTLENS_SUMMARY_WINDOW_HOURS", def: 24.0, min: 1.0 };
pub const BODIES_MAX_AGE_HOURS: Knob = Knob { key: "bodiesMaxAgeHours", env: "AGENTLENS_BODIES_MAX_AGE_HOURS", def: 72.0, min: 1.0 };
pub const BODIES_MAX_GB: Knob = Knob { key: "bodiesMaxGb", env: "AGENTLENS_BODIES_MAX_GB", def: 8.0, min: 0.5 };
pub const BODIES_RETENTION_DAYS: Knob = Knob { key: "bodiesRetentionDays", env: "AGENTLENS_BODIES_RETENTION_DAYS", def: 31.0, min: 1.0 };
pub const LOG_EVENTS_RETENTION_DAYS: Knob = Knob { key: "logEventsRetentionDays", env: "AGENTLENS_LOG_EVENTS_RETENTION_DAYS", def: 31.0, min: 1.0 };

pub const RETENTION_META: [&Knob; 6] = [
    &SPANS_RETENTION_DAYS,
    &SUMMARY_WINDOW_HOURS,
    &BODIES_MAX_AGE_HOURS,
    &BODIES_MAX_GB,
    &BODIES_RETENTION_DAYS,
    &LOG_EVENTS_RETENTION_DAYS,
];

/// `Number(envStr)` with the TS guards: unset or empty → not set; non-finite → not set.
fn env_number(name: &str) -> Option<f64> {
    let s = std::env::var(name).ok()?;
    if s.is_empty() {
        return None;
    }
    s.trim().parse::<f64>().ok().filter(|v| v.is_finite())
}

/// loadRetentionConfig: the `retention` object of `config.json`, finite numbers only.
fn file_number(data_dir: &Path, key: &str) -> Option<f64> {
    let raw = std::fs::read_to_string(data_dir.join("config.json")).ok()?;
    let v: Value = serde_json::from_str(&raw).ok()?;
    v.get("retention")?.get(key)?.as_f64().filter(|v| v.is_finite())
}

/// resolveKnob — env > file > default, floor last.
pub fn resolve_knob(data_dir: &Path, knob: &Knob) -> f64 {
    let v = env_number(knob.env).or_else(|| file_number(data_dir, knob.key)).unwrap_or(knob.def);
    v.max(knob.min)
}

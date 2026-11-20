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
pub const BODIES_MAX_GB: Knob = Knob { key: "bodiesMaxGb", env: "AGENTLENS_BODIES_MAX_GB", def: 8.0, min: 0.5 };
pub const BODIES_RETENTION_DAYS: Knob = Knob { key: "bodiesRetentionDays", env: "AGENTLENS_BODIES_RETENTION_DAYS", def: 31.0, min: 1.0 };
pub const LOG_EVENTS_RETENTION_DAYS: Knob = Knob { key: "logEventsRetentionDays", env: "AGENTLENS_LOG_EVENTS_RETENTION_DAYS", def: 31.0, min: 1.0 };
pub const API_CALLS_RETENTION_DAYS: Knob = Knob { key: "apiCallsRetentionDays", env: "AGENTLENS_API_CALLS_RETENTION_DAYS", def: 90.0, min: 1.0 };
// TRDD-ER88PXNB: the summary is built over the log cards whose last activity (startTime + durationMs) falls inside the
// last N UTC days; 0 = every resident card. WHY min 0: resolve_knob floors the value at `min`, so a min of 1 would turn 0
// into 1 day. Distinct from summaryWindowHours, which bounds the OTEL span replay (span_window.rs), not log cards.
pub const SUMMARY_CARD_DAYS: Knob = Knob { key: "summaryCardDays", env: "AGENTLENS_SUMMARY_CARD_DAYS", def: 14.0, min: 0.0 };

pub const RETENTION_META: [&Knob; 7] = [
    &SPANS_RETENTION_DAYS,
    &SUMMARY_WINDOW_HOURS,
    &BODIES_MAX_GB,
    &BODIES_RETENTION_DAYS,
    &LOG_EVENTS_RETENTION_DAYS,
    &API_CALLS_RETENTION_DAYS,
    &SUMMARY_CARD_DAYS,
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

// TRDD-OBJ4FK2T: the CLI validates keys from the TypeScript list and alcore reads the Rust one; a key or default present in one and not the other went unnoticed once (the TS list lacked apiCallsRetentionDays).
#[cfg(test)]
mod tests {
    use super::*;

    /// The text after `marker` in `line`, up to the next single quote.
    fn quoted_after<'a>(line: &'a str, marker: &str) -> &'a str {
        let rest = line.split_once(marker).unwrap_or_else(|| panic!("`{marker}` not in: {line}")).1;
        rest.split_once('\'').unwrap_or_else(|| panic!("unclosed quote after `{marker}` in: {line}")).0
    }

    /// The number after `marker` in `line`, up to the next comma.
    fn number_after(line: &str, marker: &str) -> f64 {
        let rest = line.split_once(marker).unwrap_or_else(|| panic!("`{marker}` not in: {line}")).1;
        let token = rest.split(',').next().unwrap_or_default().trim();
        token.parse::<f64>().unwrap_or_else(|e| panic!("`{marker}` value `{token}` is not a number in: {line}: {e}"))
    }

    #[test]
    fn rust_and_typescript_knob_lists_are_equal() {
        let ts_path = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../src/retentionConfig.ts");
        let ts = std::fs::read_to_string(ts_path).unwrap_or_else(|e| panic!("cannot read {ts_path}: {e}"));
        let section = ts
            .split_once("export const RETENTION_META")
            .expect("RETENTION_META is not declared in src/retentionConfig.ts")
            .1;
        let entries: Vec<&str> = section
            .lines()
            .take_while(|line| line.trim() != "]")
            .filter(|line| line.contains("key: '"))
            .collect();
        assert!(!entries.is_empty(), "no knob entries parsed from src/retentionConfig.ts");
        assert_eq!(entries.len(), RETENTION_META.len(), "src/retentionConfig.ts and RETENTION_META differ in knob count");
        for (ts_line, rust) in entries.iter().zip(RETENTION_META.iter()) {
            assert_eq!(quoted_after(ts_line, "key: '"), rust.key, "{}: key differs from src/retentionConfig.ts", rust.key);
            assert_eq!(quoted_after(ts_line, "env: '"), rust.env, "{}: env differs from src/retentionConfig.ts", rust.key);
            assert_eq!(number_after(ts_line, "def: "), rust.def, "{}: default differs from src/retentionConfig.ts", rust.key);
            assert_eq!(number_after(ts_line, "min: "), rust.min, "{}: min floor differs from src/retentionConfig.ts", rust.key);
        }
    }

    #[test]
    fn api_calls_retention_default_equals_the_status_line_retention_default() {
        let status_line_days = crate::statusline_store::retention_days(&std::collections::HashMap::new());
        assert_eq!(
            API_CALLS_RETENTION_DAYS.def,
            status_line_days,
            "apiCallsRetentionDays must default to the status-line retention: cache_turns joins status-line turns to api_calls with no api-side time filter (TRDD-OBJ4FK2T)"
        );
    }
}

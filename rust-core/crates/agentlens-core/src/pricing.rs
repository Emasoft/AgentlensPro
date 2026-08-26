//! Port of src/shared/pricing.ts's LOGIC (TRDD-DMWOBWFH P4f) — lookupRates (normalize, exact,
//! longest-prefix, scheduled change), cacheWrite1hRate, the >200K tiering, calcTokenCostUsd.
//!
//! The RATES TABLE IS NOT PORTED. It is embedded from `pricing.json`, which
//! `scripts/export-pricing.js` derives from pricing.ts — the ONE table — and which
//! `pnpm run check-pricing-export` (wired into compile/package) fails the build on when stale.
//! Rates still change in exactly one place; this crate can only ever read them.

use serde_json::Value;
use std::sync::OnceLock;

use crate::summarize::helpers::parse_iso_ms;

const PRICING_JSON: &str = include_str!("../pricing.json");

fn table() -> &'static Value {
    static T: OnceLock<Value> = OnceLock::new();
    T.get_or_init(|| serde_json::from_str(PRICING_JSON).expect("pricing.json is valid JSON (generated)"))
}

fn rates_map() -> &'static serde_json::Map<String, Value> {
    table().get("rates").and_then(Value::as_object).expect("pricing.json carries rates")
}

pub fn pricing_last_updated() -> &'static str {
    table().get("lastUpdated").and_then(Value::as_str).unwrap_or("")
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ModelRates {
    pub input_per_mtok: f64,
    pub cache_read_per_mtok: f64,
    pub cache_write_per_mtok: f64,
    pub cache_write_1h_per_mtok: Option<f64>,
    pub output_per_mtok: f64,
    pub context_window_tokens: f64,
    pub input_above_200k: Option<f64>,
    pub output_above_200k: Option<f64>,
    pub cache_read_above_200k: Option<f64>,
    pub cache_write_above_200k: Option<f64>,
    pub surcharge_threshold_tokens: Option<f64>,
}

fn num(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}

fn opt(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64)
}

fn rates_from(v: &Value) -> ModelRates {
    ModelRates {
        input_per_mtok: num(v, "inputPerMTok"),
        cache_read_per_mtok: num(v, "cacheReadPerMTok"),
        cache_write_per_mtok: num(v, "cacheWritePerMTok"),
        cache_write_1h_per_mtok: opt(v, "cacheWrite1hPerMTok"),
        output_per_mtok: num(v, "outputPerMTok"),
        context_window_tokens: num(v, "contextWindowTokens"),
        input_above_200k: opt(v, "inputAbove200kPerMTok"),
        output_above_200k: opt(v, "outputAbove200kPerMTok"),
        cache_read_above_200k: opt(v, "cacheReadAbove200kPerMTok"),
        cache_write_above_200k: opt(v, "cacheWriteAbove200kPerMTok"),
        surcharge_threshold_tokens: opt(v, "surchargeThresholdTokens"),
    }
}

/// normalizeModelId — lowercase, strip `-YYYY-MM-DD` or `-YYYYMMDD` suffix, trim.
fn normalize_model_id(model_id: &str) -> String {
    let lower = model_id.to_lowercase();
    let b = lower.as_bytes();
    let strip_date = |s: &str| -> Option<usize> {
        // -\d{4}-\d{2}-\d{2}$
        if s.len() >= 11 {
            let t = &s.as_bytes()[s.len() - 11..];
            if t[0] == b'-' && t[1..5].iter().all(u8::is_ascii_digit) && t[5] == b'-'
                && t[6..8].iter().all(u8::is_ascii_digit) && t[8] == b'-' && t[9..11].iter().all(u8::is_ascii_digit)
            {
                return Some(s.len() - 11);
            }
        }
        None
    };
    let mut cut = strip_date(&lower).unwrap_or(b.len());
    // -\d{8}$ (applied after the first strip, as the TS chain does)
    let s2 = &lower[..cut];
    if s2.len() >= 9 {
        let t = &s2.as_bytes()[s2.len() - 9..];
        if t[0] == b'-' && t[1..].iter().all(u8::is_ascii_digit) {
            cut = s2.len() - 9;
        }
    }
    lower[..cut].trim().to_owned()
}

/// applyScheduledChange — the CALL's timestamp decides; unparseable/absent ⇒ now.
fn apply_scheduled_change(entry: &Value, at_iso: Option<&str>, now_ms: f64) -> ModelRates {
    let base = rates_from(entry);
    let Some(change) = entry.get("scheduledChange") else { return base };
    let Some(effective) = change.get("from").and_then(Value::as_str).and_then(parse_iso_ms) else { return base };
    let at = at_iso.and_then(parse_iso_ms).unwrap_or(now_ms);
    if at >= effective {
        if let Some(over) = change.get("rates") {
            let mut merged = entry.as_object().cloned().unwrap_or_default();
            if let Some(o) = over.as_object() {
                for (k, v) in o {
                    merged.insert(k.clone(), v.clone());
                }
            }
            return rates_from(&Value::Object(merged));
        }
    }
    base
}

/// lookupRates — exact key, else the LONGEST key the normalized id starts with; None stays None.
pub fn lookup_rates(model_id: &str, at_iso: Option<&str>, now_ms: f64) -> Option<ModelRates> {
    if model_id.is_empty() {
        return None;
    }
    let normalized = normalize_model_id(model_id);
    let map = rates_map();
    if let Some(e) = map.get(&normalized) {
        return Some(apply_scheduled_change(e, at_iso, now_ms));
    }
    let mut best: Option<&str> = None;
    for key in map.keys() {
        if normalized.starts_with(key.as_str()) && best.is_none_or(|b| key.len() > b.len()) {
            best = Some(key);
        }
    }
    best.map(|k| apply_scheduled_change(&map[k], at_iso, now_ms))
}

/// cacheWrite1hRate — explicit wins; else 2× input ONLY for the Anthropic 1.25× shape.
pub fn cache_write_1h_rate(r: &ModelRates) -> f64 {
    if let Some(x) = r.cache_write_1h_per_mtok {
        return x;
    }
    let anthropic_shape = r.cache_write_per_mtok > 0.0 && (r.cache_write_per_mtok - r.input_per_mtok * 1.25).abs() < 1e-9;
    if anthropic_shape { r.input_per_mtok * 2.0 } else { r.cache_write_per_mtok }
}

/// calcTokenCostUsd — the write-time per-call path with the long-context surcharge: a
/// WHOLE-REQUEST STEP on total input size (input + cacheRead + cacheWrite), never marginal
/// per-bucket tiering — every provider that tiers keys the rate on the request's size
/// (TRDD-R4DHDK7L; sources in pricing.ts's ModelRates comment).
pub fn calc_token_cost_usd(
    input_tokens: f64,
    cache_read_tokens: f64,
    cache_write_tokens: f64,
    output_tokens: f64,
    model_id: &str,
    cache_write_1h_tokens: f64,
    at_iso: Option<&str>,
    now_ms: f64,
) -> f64 {
    let Some(r) = lookup_rates(model_id, at_iso, now_ms) else { return 0.0 };
    let w1h = cache_write_1h_tokens.min(cache_write_tokens).max(0.0);
    let w5m = cache_write_tokens - w1h;
    let rate_1h = cache_write_1h_rate(&r);
    let total_input = input_tokens + cache_read_tokens + cache_write_tokens;
    let threshold = r.surcharge_threshold_tokens.unwrap_or(200_000.0);
    if let (Some(input_above), true) = (r.input_above_200k, total_input > threshold) {
        // Whole-request step: every bucket at the premium rate. Premium 1h write derives 2x the
        // premium input only for the Anthropic 1.25x shape — mirrors cache_write_1h_rate and the
        // TS body exactly.
        let w_above = r.cache_write_above_200k.unwrap_or(0.0);
        let anthropic_shape = w_above > 0.0 && (w_above - input_above * 1.25).abs() < 1e-9;
        let w1h_above_rate = if anthropic_shape { input_above * 2.0 } else { w_above };
        return (input_tokens / 1_000_000.0) * input_above
            + (cache_read_tokens / 1_000_000.0) * r.cache_read_above_200k.unwrap_or(0.0)
            + (w5m / 1_000_000.0) * w_above
            + (w1h / 1_000_000.0) * w1h_above_rate
            + (output_tokens / 1_000_000.0) * r.output_above_200k.unwrap_or(0.0);
    }
    (input_tokens / 1_000_000.0) * r.input_per_mtok
        + (cache_read_tokens / 1_000_000.0) * r.cache_read_per_mtok
        + (w5m / 1_000_000.0) * r.cache_write_per_mtok
        + (w1h / 1_000_000.0) * rate_1h
        + (output_tokens / 1_000_000.0) * r.output_per_mtok
}

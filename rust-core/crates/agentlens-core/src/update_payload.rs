//! Port of src/updatePayload.ts (TRDD-DMWOBWFH P4f) — the three pure derivations of the
//! dashboard `update` frame: computeSidebarPayload (clock-reading: isActive / burnRate),
//! computeSidebarData, computeAnalyticsData — plus buildUpdatePayload's frame assembly.
//!
//! JS-semantics notes: `Date.parse(b.startTime || '0') - Date.parse(a.startTime || '0')` — '0'
//! parses to year 0 in V8 (a valid, very negative ms); an unparseable startTime yields NaN, and
//! a NaN comparator result leaves V8's sort unspecified but stable-ish; real cards carry ISO or
//! ''. `Math.round` is half-up toward +∞ (f64::round is half-away-from-zero; identical for the
//! non-negative values here). `toISOString().slice(0,10)` for the day key.

use serde_json::{Map, Value};

use crate::pricing::calc_token_cost_usd;
use crate::summarize::helpers::{self as h, iso_from_ms, num};
use crate::ui::strip_session_detail;

fn f(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}

fn sstr<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

/// `Date.parse(s || '0')` — '0' parses to 0000-01-01T00:00:00Z in V8.
fn start_key(s: &str) -> f64 {
    const YEAR_ZERO_MS: f64 = -62_167_219_200_000.0;
    if s.is_empty() {
        return YEAR_ZERO_MS;
    }
    h::parse_iso_ms(s).unwrap_or(f64::NAN)
}

/// JS `Math.round` — half toward +∞.
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

const AGENT_ORDER: [&str; 3] = ["copilot", "claude_code", "codex"];

fn agent_sources(ordered: &[&Value]) -> Vec<Value> {
    let mut seen: Vec<String> = Vec::new();
    for s in ordered {
        let src = sstr(s, "source");
        if !src.is_empty() && !seen.iter().any(|x| x == src) {
            seen.push(src.to_owned());
        }
    }
    let rank = |s: &str| AGENT_ORDER.iter().position(|a| *a == s).map_or(99, |i| i as i64);
    seen.sort_by_key(|s| rank(s)); // stable, like V8's sort
    seen.into_iter().map(Value::from).collect()
}

pub fn compute_sidebar_payload(summary: &Value, all_spans: &[std::sync::Arc<Value>], now_ms: f64) -> Value {
    let sessions: Vec<&Value> = summary.get("sessions").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default();
    let mut sorted = sessions.clone();
    sorted.sort_by(|a, b| {
        let (ka, kb) = (start_key(sstr(a, "startTime")), start_key(sstr(b, "startTime")));
        // b - a, newest first; NaN compares Equal (comparator NaN ⇒ V8 keeps order).
        kb.partial_cmp(&ka).unwrap_or(std::cmp::Ordering::Equal)
    });
    let latest = sorted.first().copied();

    let mut last_ms = 0.0f64;
    for span in all_spans {
        let ms = span.get("receivedAt").and_then(Value::as_f64).unwrap_or(0.0);
        if ms > last_ms {
            last_ms = ms;
        }
    }
    let is_active = last_ms > 0.0 && (now_ms - last_ms) < 20_000.0;

    let turn_input_tokens: Vec<Value> = latest
        .and_then(|l| l.get("timeline").and_then(Value::as_array))
        .map(|tl| {
            tl.iter()
                .filter(|e| e.get("type").and_then(Value::as_str) == Some("llm"))
                .map(|e| f(e, "inputTokens") + f(e, "cacheReadTokens") + f(e, "cacheCreateTokens"))
                .filter(|ctx| *ctx > 0.0)
                .map(num)
                .collect()
        })
        .unwrap_or_default();

    let burn_rate = match latest {
        Some(l) if is_active && f(l, "durationMs") > 10_000.0 => {
            let total = f(l, "inputTokens") + f(l, "outputTokens");
            let tpm = (total / f(l, "durationMs")) * 60_000.0;
            let mut b = Map::new();
            b.insert("tokensPerMinute".into(), num(js_round(tpm)));
            b.insert("costPerHour".into(), num(0.0));
            Value::Object(b)
        }
        _ => Value::Null,
    };

    let n = sorted.len() as f64;
    let avg_input = if n > 0.0 { sorted.iter().map(|x| f(x, "inputTokens")).sum::<f64>() / n } else { 1.0 };
    let avg_output = if n > 0.0 { sorted.iter().map(|x| f(x, "outputTokens")).sum::<f64>() / n } else { 1.0 };

    let current_session = match latest {
        Some(l) => {
            let mut c = Map::new();
            c.insert("source".into(), l.get("source").cloned().unwrap_or(Value::Null));
            c.insert("model".into(), sstr(l, "model").into());
            c.insert("userRequest".into(), sstr(l, "userRequest").into());
            c.insert("totalLlmCalls".into(), l.get("totalLlmCalls").cloned().unwrap_or(Value::Null));
            c.insert("totalToolCalls".into(), l.get("totalToolCalls").cloned().unwrap_or(Value::Null));
            c.insert("errors".into(), l.get("errors").cloned().unwrap_or(Value::Null));
            c.insert("cacheHitRate".into(), l.get("cacheHitRate").cloned().unwrap_or(Value::Null));
            c.insert("durationMs".into(), l.get("durationMs").cloned().unwrap_or(Value::Null));
            c.insert("startTime".into(), l.get("startTime").cloned().unwrap_or(Value::Null));
            c.insert("turnInputTokens".into(), Value::Array(turn_input_tokens));
            c.insert("inputTokens".into(), l.get("inputTokens").cloned().unwrap_or(Value::Null));
            c.insert("outputTokens".into(), l.get("outputTokens").cloned().unwrap_or(Value::Null));
            c.insert("cacheReadTokens".into(), l.get("cacheReadTokens").cloned().unwrap_or(Value::Null));
            c.insert("cacheCreateTokens".into(), l.get("cacheCreateTokens").cloned().unwrap_or(Value::Null));
            c.insert(
                "costUsd".into(),
                num(calc_token_cost_usd(
                    f(l, "inputTokens"),
                    f(l, "cacheReadTokens"),
                    f(l, "cacheCreateTokens"),
                    f(l, "outputTokens"),
                    sstr(l, "model"),
                    0.0,
                    None,
                    now_ms,
                )),
            );
            Value::Object(c)
        }
        None => Value::Null,
    };

    let mut out = Map::new();
    out.insert("isActive".into(), is_active.into());
    out.insert("lastActivityMs".into(), num(last_ms));
    out.insert("sessionCount".into(), Value::from(sessions.len()));
    out.insert("agentSources".into(), Value::Array(agent_sources(&sorted)));
    out.insert("currentSession".into(), current_session);
    out.insert("burnRate".into(), burn_rate);
    out.insert("avgInputTokens".into(), num(avg_input));
    out.insert("avgOutputTokens".into(), num(avg_output));
    Value::Object(out)
}

pub fn compute_sidebar_data(summary: &Value) -> Value {
    let sessions: Vec<&Value> = summary.get("sessions").and_then(Value::as_array).map(|a| a.iter().collect()).unwrap_or_default();
    let mut files: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut error_count = 0.0f64;
    for s in &sessions {
        if let Some(arr) = s.get("filesChanged").and_then(Value::as_array) {
            for fv in arr {
                files.insert(fv.to_string());
            }
        }
        error_count += f(s, "errors");
    }
    let n = sessions.len() as f64;
    let cache_hit_pct = if n > 0.0 { js_round(sessions.iter().map(|s| f(s, "cacheHitRate")).sum::<f64>() / n * 100.0) } else { 0.0 };
    let avg_turns = if n > 0.0 { js_round(sessions.iter().map(|s| f(s, "totalLlmCalls")).sum::<f64>() / n * 10.0) / 10.0 } else { 0.0 };
    let total_tool_calls: f64 = sessions.iter().map(|s| f(s, "totalToolCalls")).sum();
    let latest_session = match sessions.last() {
        Some(l) => {
            let mut c = Map::new();
            c.insert("source".into(), l.get("source").cloned().unwrap_or(Value::Null));
            c.insert("model".into(), sstr(l, "model").into());
            c.insert("totalLlmCalls".into(), l.get("totalLlmCalls").cloned().unwrap_or(Value::Null));
            c.insert("totalToolCalls".into(), l.get("totalToolCalls").cloned().unwrap_or(Value::Null));
            c.insert("durationMs".into(), l.get("durationMs").cloned().unwrap_or(Value::Null));
            c.insert("errors".into(), l.get("errors").cloned().unwrap_or(Value::Null));
            c.insert("cacheHitRate".into(), l.get("cacheHitRate").cloned().unwrap_or(Value::Null));
            Value::Object(c)
        }
        None => Value::Null,
    };
    let mut out = Map::new();
    out.insert("sessionCount".into(), Value::from(sessions.len()));
    out.insert("turnCount".into(), num(sessions.iter().map(|s| f(s, "totalLlmCalls")).sum()));
    out.insert("totalInputTokens".into(), num(sessions.iter().map(|s| f(s, "inputTokens")).sum()));
    out.insert("totalOutputTokens".into(), num(sessions.iter().map(|s| f(s, "outputTokens")).sum()));
    out.insert("filesChangedCount".into(), Value::from(files.len()));
    out.insert("errors".into(), num(error_count));
    out.insert("totalToolCalls".into(), num(total_tool_calls));
    out.insert("cacheHitPct".into(), num(cache_hit_pct));
    out.insert("avgTurns".into(), num(avg_turns));
    out.insert("agentSources".into(), Value::Array(agent_sources(&sessions)));
    out.insert("latestSession".into(), latest_session);
    Value::Object(out)
}

pub fn compute_analytics_data(sessions: &[Value]) -> Value {
    // Insertion-ordered day map, then sorted by day (localeCompare on YYYY-MM-DD = byte order).
    let mut days: Vec<(String, [f64; 6])> = Vec::new(); // totalTokens, output, cacheRead, cacheCreate, costUsd, sessionCount
    for s in sessions {
        let st = sstr(s, "startTime");
        if st.is_empty() {
            continue;
        }
        let Some(ms) = h::parse_iso_ms(st) else { continue };
        let day = iso_from_ms(ms)[..10].to_owned();
        let entry = match days.iter_mut().find(|(d, _)| *d == day) {
            Some((_, r)) => r,
            None => {
                days.push((day, [0.0; 6]));
                &mut days.last_mut().expect("just pushed").1
            }
        };
        entry[0] += f(s, "inputTokens");
        entry[1] += f(s, "outputTokens");
        entry[2] += f(s, "cacheReadTokens");
        entry[3] += f(s, "cacheCreateTokens");
        entry[5] += 1.0;
    }
    days.sort_by(|a, b| a.0.cmp(&b.0));
    let daily: Vec<Value> = days
        .into_iter()
        .map(|(day, r)| {
            let mut d = Map::new();
            d.insert("day".into(), day.into());
            d.insert("totalTokens".into(), num(r[0]));
            d.insert("outputTokens".into(), num(r[1]));
            d.insert("cacheReadTokens".into(), num(r[2]));
            d.insert("cacheCreateTokens".into(), num(r[3]));
            d.insert("costUsd".into(), num(r[4]));
            d.insert("sessionCount".into(), num(r[5]));
            Value::Object(d)
        })
        .collect();
    let total_tokens: f64 = sessions.iter().map(|s| f(s, "inputTokens") + f(s, "outputTokens")).sum();
    let (mut oldest, mut newest) = (0.0f64, 0.0f64);
    for s in sessions {
        let st = sstr(s, "startTime");
        let t = if st.is_empty() { 0.0 } else { h::parse_iso_ms(st).unwrap_or(0.0) };
        if t <= 0.0 {
            continue;
        }
        if oldest == 0.0 || t < oldest {
            oldest = t;
        }
        if t > newest {
            newest = t;
        }
    }
    let mut life = Map::new();
    life.insert("totalSessions".into(), Value::from(sessions.len()));
    life.insert("totalTokens".into(), num(total_tokens));
    life.insert("totalCostUsd".into(), num(0.0));
    life.insert("oldestSessionMs".into(), num(oldest));
    life.insert("newestSessionMs".into(), num(newest));
    let mut out = Map::new();
    out.insert("dailyStats".into(), Value::Array(daily));
    out.insert("lifetimeStats".into(), Value::Object(life));
    Value::Object(out)
}

/// buildUpdatePayload — the `update` SSE frame body. `collector_gaps` is the lifecycle-derived
/// downtime list (collector_lifecycle::compute_gaps — both frame sites pass it).
pub fn build_update_payload(summary: &Value, all_spans: &[std::sync::Arc<Value>], build_id: &str, collector_gaps: Vec<Value>, now_ms: f64) -> Value {
    let sessions: Vec<Value> = summary.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
    let mut p = Map::new();
    p.insert("type".into(), "update".into());
    p.insert("buildId".into(), build_id.into());
    {
        let mut s = Map::new();
        s.insert("toolCalls".into(), Value::Object(Map::new()));
        p.insert("summary".into(), Value::Object(s));
    }
    p.insert("sessionSummary".into(), strip_session_detail(summary));
    p.insert("sidebar".into(), compute_sidebar_data(summary));
    p.insert("analyticsData".into(), compute_analytics_data(&sessions));
    p.insert("collectorGaps".into(), Value::Array(collector_gaps));
    // ...(sidebarLive ?? {}) — top-level spread of computeSidebarPayload.
    if let Value::Object(live) = compute_sidebar_payload(summary, all_spans, now_ms) {
        for (k, v) in live {
            p.insert(k, v);
        }
    }
    Value::Object(p)
}

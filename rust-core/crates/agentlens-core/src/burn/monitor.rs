//! Port of src/burnMonitor.ts (TRDD-OG9PARZQ / TRDD-BURNWDGT / TRDD-H693VQLU) — the burn
//! "smoke detector": rolling tokens/min + $/min (per session + global), the 5h/7d
//! rate-limit-window budget model with observed-capacity calibration, threshold alerts, and
//! the get_burn_status / get_session_status shapes.
//!
//! PURE like the TS (the one I/O is load_burn_config reading the optional config file).
//! Events, cards and every wire-shaped output are `serde_json::Value` mirroring the TS object
//! literals (the P4d design law) — conditional keys mirror the `...(x ? {x} : {})` spreads and
//! JSON's undefined-drop; numbers go through num()/js_to_fixed_num/js_math_round so the wire
//! prints the same shapes V8 does.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use serde_json::{Map, Value};

use super::cache_ttl::{classify_ttl_regime, session_ttl_kind_of, TtlContext, TtlRegime};
use super::keep_warm::compute_keep_warm;
use crate::pricing::calc_token_cost_usd;
use crate::summarize::helpers::{js_math_round, js_slice, js_to_fixed_num, num, parse_iso_ms, to_locale_en, truthy};

pub const FIVE_HOURS_MS: f64 = 5.0 * 60.0 * 60.0 * 1000.0;
pub const SEVEN_DAYS_MS: f64 = 7.0 * 24.0 * 60.0 * 60.0 * 1000.0;
pub const ONE_MIN_MS: f64 = 60.0 * 1000.0;
pub const FIVE_MIN_MS: f64 = 5.0 * 60.0 * 1000.0;
/// "live" = activity within the last 10 minutes (session resolution).
pub const LIVE_MS: f64 = 10.0 * 60.0 * 1000.0;

/// BILLABLE_WEIGHTS — per-input-token-equivalent weights from Anthropic's PUBLIC price ratios.
pub const W_INPUT: f64 = 1.0;
pub const W_OUTPUT: f64 = 5.0;
pub const W_CACHE_READ: f64 = 0.1;
pub const W_CACHE_CREATE: f64 = 1.25;
pub const W_UNKNOWN: f64 = 1.0;

// ── Value accessors (events + cards live as Values; these are the ?? / !== undefined shapes) ──

/// `e.k ?? 0` — absent OR null → 0.
fn f(e: &Value, k: &str) -> f64 {
    e.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}

/// `e.k !== undefined` — key present (a JSON null still counts, as it does in TS).
fn has(e: &Value, k: &str) -> bool {
    e.get(k).is_some()
}

fn s<'a>(e: &'a Value, k: &str) -> Option<&'a str> {
    e.get(k).and_then(Value::as_str)
}

// ── Config ────────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, Default)]
pub struct BurnThresholds {
    pub tokens_per_min: f64,
    pub cost_per_hour: f64,
    pub window_pct: f64,
    pub cache_create_single_call: f64,
}

pub fn default_thresholds() -> BurnThresholds {
    BurnThresholds { tokens_per_min: 2_000_000.0, cost_per_hour: 50.0, window_pct: 80.0, cache_create_single_call: 200_000.0 }
}

#[derive(Clone, Debug, Default)]
pub struct ObservedAccountCapacity {
    pub window5h_tokens: Option<f64>,
    pub window7d_tokens: Option<f64>,
    pub window5h_cost_usd: Option<f64>,
    pub window7d_cost_usd: Option<f64>,
    pub observed_at: Option<String>,
}

#[derive(Clone, Debug)]
pub struct BurnConfig {
    pub window5h_tokens: Option<f64>,
    pub window7d_tokens: Option<f64>,
    pub window5h_cost_usd: Option<f64>,
    pub window7d_cost_usd: Option<f64>,
    pub capacity_source: &'static str, // 'env' | 'config' | 'observed' | 'none'
    /// Keyed by accountUuid — insertion order kept (Object.keys parity for the pooled test).
    pub observed: IndexMap<String, ObservedAccountCapacity>,
    pub notify: bool,
    pub thresholds: BurnThresholds,
}

impl BurnConfig {
    /// The config as the TS object (for the oracle + any wire embed).
    pub fn to_value(&self) -> Value {
        let opt = |v: Option<f64>| v.map_or(Value::Null, num);
        let mut m = Map::new();
        m.insert("window5hTokens".into(), opt(self.window5h_tokens));
        m.insert("window7dTokens".into(), opt(self.window7d_tokens));
        m.insert("window5hCostUsd".into(), opt(self.window5h_cost_usd));
        m.insert("window7dCostUsd".into(), opt(self.window7d_cost_usd));
        m.insert("capacitySource".into(), self.capacity_source.into());
        let mut obs = Map::new();
        for (k, v) in &self.observed {
            let mut o = Map::new();
            o.insert("window5hTokens".into(), opt(v.window5h_tokens));
            o.insert("window7dTokens".into(), opt(v.window7d_tokens));
            o.insert("window5hCostUsd".into(), opt(v.window5h_cost_usd));
            o.insert("window7dCostUsd".into(), opt(v.window7d_cost_usd));
            o.insert("observedAt".into(), v.observed_at.clone().map_or(Value::Null, Value::from));
            obs.insert(k.clone(), Value::Object(o));
        }
        m.insert("observed".into(), Value::Object(obs));
        m.insert("notify".into(), Value::Bool(self.notify));
        let t = &self.thresholds;
        let mut th = Map::new();
        th.insert("tokensPerMin".into(), num(t.tokens_per_min));
        th.insert("costPerHour".into(), num(t.cost_per_hour));
        th.insert("windowPct".into(), num(t.window_pct));
        th.insert("cacheCreateSingleCall".into(), num(t.cache_create_single_call));
        m.insert("thresholds".into(), Value::Object(th));
        Value::Object(m)
    }
}

/// numEnv — undefined/blank → None; else Number(v) kept only when finite and > 0.
fn num_env(vars: &HashMap<String, String>, k: &str) -> Option<f64> {
    let v = vars.get(k)?;
    if v.trim().is_empty() {
        return None;
    }
    let n: f64 = v.trim().parse().ok()?; // Number('12 ') trims; a non-numeric string is NaN → None
    (n.is_finite() && n > 0.0).then_some(n)
}

/// burnConfigPath — the ONE place the config path is resolved.
pub fn burn_config_path(vars: &HashMap<String, String>, home_dir: &Path) -> PathBuf {
    match vars.get("AGENTLENS_BURN_CONFIG").filter(|v| !v.is_empty()) {
        Some(p) => PathBuf::from(p),
        None => home_dir.join(".agentlens").join("burn-config.json"),
    }
}

/// parseObservedCapacities — keep only entries with at least one positive figure (a junk entry
/// must never flip capacitySource to 'observed').
fn parse_observed_capacities(raw: Option<&Value>) -> IndexMap<String, ObservedAccountCapacity> {
    let mut out = IndexMap::new();
    let Some(obj) = raw.and_then(Value::as_object) else { return out };
    let pos = |v: Option<&Value>| v.and_then(Value::as_f64).filter(|n| n.is_finite() && *n > 0.0);
    for (uuid, v) in obj {
        if uuid.is_empty() || !v.is_object() {
            continue;
        }
        let entry = ObservedAccountCapacity {
            window5h_tokens: pos(v.get("window5hTokens")),
            window7d_tokens: pos(v.get("window7dTokens")),
            window5h_cost_usd: pos(v.get("window5hCostUsd")),
            window7d_cost_usd: pos(v.get("window7dCostUsd")),
            observed_at: v.get("observedAt").and_then(Value::as_str).map(str::to_owned),
        };
        if entry.window5h_tokens.or(entry.window7d_tokens).or(entry.window5h_cost_usd).or(entry.window7d_cost_usd).is_some() {
            out.insert(uuid.clone(), entry);
        }
    }
    out
}

/// loadBurnConfig — env vars > ~/.agentlens/burn-config.json > defaults; capacity NEVER
/// invented; the `observed` section outranked by any manual cap.
pub fn load_burn_config(vars: &HashMap<String, String>, home_dir: &Path) -> BurnConfig {
    let file: Value = std::fs::read_to_string(burn_config_path(vars, home_dir))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        // Coerce any non-plain-object (the literal-`null` trap) to {} — the TS "never crash" note.
        .filter(|v: &Value| v.is_object())
        .unwrap_or_else(|| Value::Object(Map::new()));

    let fpos = |k: &str| file.get(k).and_then(Value::as_f64).filter(|n| *n > 0.0);
    let env5h = num_env(vars, "AGENTLENS_WINDOW_5H_TOKENS");
    let env7d = num_env(vars, "AGENTLENS_WINDOW_7D_TOKENS");
    let window5h_tokens = env5h.or(fpos("window5hTokens"));
    let window7d_tokens = env7d.or(fpos("window7dTokens"));
    let env5h_cost = num_env(vars, "AGENTLENS_WINDOW_5H_COST_USD");
    let env7d_cost = num_env(vars, "AGENTLENS_WINDOW_7D_COST_USD");
    let window5h_cost_usd = env5h_cost.or(fpos("window5hCostUsd"));
    let window7d_cost_usd = env7d_cost.or(fpos("window7dCostUsd"));

    let observed = parse_observed_capacities(file.get("observed"));

    let any_env = env5h.or(env7d).or(env5h_cost).or(env7d_cost).is_some();
    let any_file = fpos("window5hTokens").or(fpos("window7dTokens")).or(fpos("window5hCostUsd")).or(fpos("window7dCostUsd")).is_some();
    let capacity_source = if any_env {
        "env"
    } else if any_file {
        "config"
    } else if !observed.is_empty() {
        "observed"
    } else {
        "none"
    };

    let ft = file.get("thresholds").cloned().unwrap_or(Value::Object(Map::new()));
    let ftn = |k: &str| ft.get(k).and_then(Value::as_f64);
    let d = default_thresholds();
    let thresholds = BurnThresholds {
        tokens_per_min: num_env(vars, "AGENTLENS_BURN_TOKENS_PER_MIN").or(ftn("tokensPerMin")).unwrap_or(d.tokens_per_min),
        cost_per_hour: num_env(vars, "AGENTLENS_BURN_COST_PER_HOUR").or(ftn("costPerHour")).unwrap_or(d.cost_per_hour),
        window_pct: num_env(vars, "AGENTLENS_BURN_WINDOW_PCT").or(ftn("windowPct")).unwrap_or(d.window_pct),
        cache_create_single_call: num_env(vars, "AGENTLENS_BURN_CACHE_CREATE").or(ftn("cacheCreateSingleCall")).unwrap_or(d.cache_create_single_call),
    };

    BurnConfig {
        window5h_tokens,
        window7d_tokens,
        window5h_cost_usd,
        window7d_cost_usd,
        capacity_source,
        observed,
        notify: vars.get("AGENTLENS_NOTIFY").map(String::as_str) == Some("1") || file.get("notify") == Some(&Value::Bool(true)),
        thresholds,
    }
}

// ── Event extraction ──────────────────────────────────────────────────────────────

/// Normalize a possibly epoch-SECONDS timestamp (statusline) to epoch MILLISECONDS.
pub fn to_ms(ts: f64) -> f64 {
    if ts > 0.0 && ts < 1e12 {
        ts * 1000.0
    } else {
        ts
    }
}

/// attributionOf — the dominant-cause bucket for one api_request timeline entry.
fn attribution_of(e: &Value) -> String {
    if s(e, "querySource") == Some("compact") || e.get("compactionTrigger").is_some_and(truthy) {
        return "compaction".to_owned();
    }
    for (k, pre) in [("agentName", "agent:"), ("skillName", "skill:"), ("pluginName", "plugin:"), ("mcpServerName", "mcp:")] {
        if let Some(v) = s(e, k).filter(|v| !v.is_empty()) {
            return format!("{pre}{v}");
        }
    }
    match s(e, "querySource").filter(|v| !v.is_empty()) {
        Some(qs) if qs != "repl_main_thread" => qs.to_owned(),
        _ => "main".to_owned(),
    }
}

fn api_request_events(card: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    let empty = Vec::new();
    for e in card.get("timeline").and_then(Value::as_array).unwrap_or(&empty) {
        if s(e, "type") != Some("api_request") {
            continue;
        }
        let Some(ts) = parse_iso_ms(s(e, "timestamp").unwrap_or("")) else { continue };
        let (it, ot, cr, cc) = (f(e, "inputTokens"), f(e, "outputTokens"), f(e, "cacheReadTokens"), f(e, "cacheCreateTokens"));
        let mut m = Map::new();
        m.insert("ts".into(), num(ts));
        m.insert("sessionId".into(), s(card, "sessionId").unwrap_or("").into());
        if let Some(ws) = s(card, "workspace") {
            m.insert("workspace".into(), ws.into());
        }
        if let Some(a) = s(card, "accountId") {
            m.insert("accountUuid".into(), a.into());
        }
        m.insert("costUsd".into(), num(f(e, "costUsd")));
        m.insert("tokens".into(), num(it + ot + cr + cc));
        m.insert("source".into(), "api_request".into());
        m.insert("attribution".into(), attribution_of(e).into());
        m.insert("inputTokens".into(), num(it));
        m.insert("outputTokens".into(), num(ot));
        m.insert("cacheReadTokens".into(), num(cr));
        m.insert("cacheCreateTokens".into(), num(cc));
        out.push(Value::Object(m));
    }
    out
}

/// statuslineCostUsd — price ONE statusline turn from its own buckets × the model rate; fall
/// back to the raw cumulative delta (labeled an INTERVAL total, TRDD-H693VQLU) when no split
/// is present or the model is unpriced. `now_ms` stands in for the TS omitted `atIso` (price
/// at today's rate) — live callers pass the wall clock.
fn statusline_cost_usd(be: &Value, model: Option<&str>, now_ms: f64) -> (f64, bool) {
    let has_split = has(be, "deltaInput") || has(be, "deltaOutput") || has(be, "deltaCacheRead") || has(be, "deltaCacheCreate");
    let model = model.filter(|m| !m.is_empty()); // TS `!model` — '' is falsy
    let (Some(model), true) = (model, has_split) else {
        return (f(be, "deltaCostUsd"), true);
    };
    let derived = calc_token_cost_usd(f(be, "deltaInput"), f(be, "deltaCacheRead"), f(be, "deltaCacheCreate"), f(be, "deltaOutput"), model, 0.0, None, now_ms);
    if derived > 0.0 {
        (derived, false)
    } else {
        (f(be, "deltaCostUsd"), true)
    }
}

/// gatherConsumptionEvents — merge the two live sources DEDUPED per session: a session with
/// rich api_request events uses ONLY those; a session without falls back to its statusline
/// billing deltas. Prevents double-counting the same turn from both sources.
pub fn gather_consumption_events(sessions: &[Value], statusline_events: &[Value], now: f64) -> Vec<Value> {
    let mut events: Vec<Value> = Vec::new();
    let mut api_sessions: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut card_by: IndexMap<&str, &Value> = IndexMap::new();
    for c in sessions {
        card_by.insert(s(c, "sessionId").unwrap_or(""), c);
    }
    for card in sessions {
        let evs = api_request_events(card);
        if !evs.is_empty() {
            api_sessions.insert(s(card, "sessionId").unwrap_or(""));
            events.extend(evs);
        }
    }
    for be in statusline_events {
        let sid = s(be, "sessionId").unwrap_or("");
        if api_sessions.contains(sid) {
            continue;
        }
        if f(be, "deltaTokens") <= 0.0 && f(be, "deltaCostUsd") <= 0.0 {
            continue;
        }
        let card = card_by.get(sid).copied();
        let (cost_usd, is_interval_total) = statusline_cost_usd(be, card.and_then(|c| s(c, "model")), now);
        let mut m = Map::new();
        m.insert("ts".into(), num(to_ms(f(be, "ts"))));
        m.insert("sessionId".into(), sid.into());
        if let Some(ws) = s(be, "workspace") {
            m.insert("workspace".into(), ws.into());
        }
        if let Some(a) = card.and_then(|c| s(c, "accountId")) {
            m.insert("accountUuid".into(), a.into());
        }
        m.insert("costUsd".into(), num(cost_usd));
        m.insert("tokens".into(), num(f(be, "deltaTokens")));
        m.insert("source".into(), "statusline".into());
        // Per-bucket split from the statusline WHEN PRESENT (undefined keys drop, as JSON does).
        for (dst, src) in [("inputTokens", "deltaInput"), ("outputTokens", "deltaOutput"), ("cacheReadTokens", "deltaCacheRead"), ("cacheCreateTokens", "deltaCacheCreate")] {
            if let Some(v) = be.get(src).filter(|v| !v.is_null()) {
                m.insert(dst.into(), v.clone());
            }
        }
        if is_interval_total {
            m.insert("costIsIntervalTotal".into(), Value::Bool(true));
            if let Some(v) = be.get("intervalMs").filter(|v| !v.is_null()) {
                m.insert("intervalMs".into(), v.clone());
            }
        }
        events.push(Value::Object(m));
    }
    // `.sort((a, b) => a.ts - b.ts)` — stable, as Rust's sort_by is.
    events.sort_by(|a, b| f(a, "ts").partial_cmp(&f(b, "ts")).unwrap_or(std::cmp::Ordering::Equal));
    events
}

// ── Rolling-window math ───────────────────────────────────────────────────────────

struct WinSum {
    tokens: f64,
    cost: f64,
    count: f64,
    // input, output, cache_read, cache_create, unknown
    b: [f64; 5],
}

fn window_sum(events: &[Value], now: f64, window_ms: f64) -> WinSum {
    let from = now - window_ms;
    let mut w = WinSum { tokens: 0.0, cost: 0.0, count: 0.0, b: [0.0; 5] };
    for e in events {
        let ts = f(e, "ts");
        if ts < from || ts > now {
            continue;
        }
        w.tokens += f(e, "tokens");
        w.cost += f(e, "costUsd");
        w.count += 1.0;
        // Split on PRESENCE of the per-bucket fields, not the source.
        let has_split = has(e, "inputTokens") || has(e, "outputTokens") || has(e, "cacheReadTokens") || has(e, "cacheCreateTokens");
        if has_split {
            w.b[0] += f(e, "inputTokens");
            w.b[1] += f(e, "outputTokens");
            w.b[2] += f(e, "cacheReadTokens");
            w.b[3] += f(e, "cacheCreateTokens");
        } else {
            w.b[4] += f(e, "tokens");
        }
    }
    w
}

fn breakdown_value(b: &[f64; 5]) -> Value {
    let mut m = Map::new();
    m.insert("input".into(), num(b[0]));
    m.insert("output".into(), num(b[1]));
    m.insert("cacheRead".into(), num(b[2]));
    m.insert("cacheCreate".into(), num(b[3]));
    m.insert("unknown".into(), num(b[4]));
    Value::Object(m)
}

fn billable_weighted_tokens(b: &[f64; 5]) -> f64 {
    b[0] * W_INPUT + b[1] * W_OUTPUT + b[2] * W_CACHE_READ + b[3] * W_CACHE_CREATE + b[4] * W_UNKNOWN
}

/// rateWindow — rolling-window burn rate (per-minute normalization of the window's totals).
pub fn rate_window(events: &[Value], now: f64, window_ms: f64) -> Value {
    let w = window_sum(events, now, window_ms);
    let minutes = window_ms / ONE_MIN_MS;
    let mut m = Map::new();
    m.insert("windowMs".into(), num(window_ms));
    m.insert("tokens".into(), num(w.tokens));
    m.insert("costUsd".into(), num(js_to_fixed_num(w.cost, 6)));
    m.insert("events".into(), num(w.count));
    m.insert("tokensPerMin".into(), num(js_math_round(w.tokens / minutes)));
    m.insert("costPerMin".into(), num(js_to_fixed_num(w.cost / minutes, 6)));
    m.insert("breakdown".into(), breakdown_value(&w.b));
    m.insert("billableWeightedPerMin".into(), num(js_math_round(billable_weighted_tokens(&w.b) / minutes)));
    Value::Object(m)
}

// ── Burn series (spec 1) ──────────────────────────────────────────────────────────

/// dominantCause — top attribution bucket (by tokens) in the window; first-seen wins ties.
fn dominant_cause(events: &[Value], now: f64, window_ms: f64) -> Value {
    let from = now - window_ms;
    let mut tally: IndexMap<&str, f64> = IndexMap::new();
    for e in events {
        let ts = f(e, "ts");
        if ts < from || ts > now {
            continue;
        }
        let Some(attr) = s(e, "attribution").filter(|a| !a.is_empty()) else { continue };
        *tally.entry(attr).or_insert(0.0) += f(e, "tokens");
    }
    let mut top: Option<&str> = None;
    let mut max = -1.0;
    for (k, v) in &tally {
        if *v > max {
            max = *v;
            top = Some(k);
        }
    }
    top.map_or(Value::Null, Value::from)
}

/// computeBurnSeries — per-session rolling windows, hottest first, plus the global windows.
pub fn compute_burn_series(events: &[Value], now: f64) -> Value {
    let mut by_session: IndexMap<&str, Vec<&Value>> = IndexMap::new();
    for e in events {
        by_session.entry(s(e, "sessionId").unwrap_or("")).or_default().push(e);
    }
    let mut sessions: Vec<Value> = Vec::new();
    for (session_id, evs) in &by_session {
        let owned: Vec<Value> = evs.iter().map(|e| (*e).clone()).collect();
        let five_min = rate_window(&owned, now, FIVE_MIN_MS);
        if f(&five_min, "events") == 0.0 {
            continue; // not active in the last 5 min
        }
        let mut m = Map::new();
        m.insert("sessionId".into(), (*session_id).into());
        if let Some(ws) = s(evs[0], "workspace") {
            m.insert("workspace".into(), ws.into());
        }
        m.insert("oneMin".into(), rate_window(&owned, now, ONE_MIN_MS));
        m.insert("fiveMin".into(), five_min);
        m.insert("dominantCause".into(), dominant_cause(&owned, now, FIVE_MIN_MS));
        sessions.push(Value::Object(m));
    }
    // `b.oneMin.tokensPerMin - a.oneMin.tokensPerMin || b.fiveMin.tokens - a.fiveMin.tokens`
    sessions.sort_by(|a, b| {
        let k1 = f(&b["oneMin"], "tokensPerMin").partial_cmp(&f(&a["oneMin"], "tokensPerMin")).unwrap_or(std::cmp::Ordering::Equal);
        if k1 != std::cmp::Ordering::Equal {
            return k1;
        }
        f(&b["fiveMin"], "tokens").partial_cmp(&f(&a["fiveMin"], "tokens")).unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut m = Map::new();
    m.insert("now".into(), num(now));
    let mut g = Map::new();
    g.insert("oneMin".into(), rate_window(events, now, ONE_MIN_MS));
    g.insert("fiveMin".into(), rate_window(events, now, FIVE_MIN_MS));
    m.insert("global".into(), Value::Object(g));
    m.insert("sessions".into(), Value::Array(sessions));
    Value::Object(m)
}

// ── Window budget (spec 2) ────────────────────────────────────────────────────────

#[allow(clippy::too_many_arguments)]
fn window_consumption(
    events: &[Value],
    now: f64,
    window_ms: f64,
    label: &str,
    capacity: Option<f64>,
    projection_tokens_per_min: f64,
    capacity_cost: Option<f64>,
    capacity_is_lower_bound: bool,
) -> Value {
    let w = window_sum(events, now, window_ms);
    let pct = capacity.filter(|c| *c > 0.0).map(|c| js_to_fixed_num(w.tokens / c * 100.0, 2));
    let pct_cost = capacity_cost.filter(|c| *c > 0.0).map(|c| js_to_fixed_num(w.cost / c * 100.0, 2));
    let remaining = capacity.map(|c| c - w.tokens);
    // COST decides when a cost bound exists; the raw-token bound is only the fallback (raw
    // tokens systematically OVERSTATE fill — cache-read bills at 0.1× and is ~96% of volume).
    let capacity_exceeded = capacity_is_lower_bound
        && match capacity_cost.filter(|c| *c > 0.0) {
            Some(cc) => w.cost > cc,
            None => capacity.filter(|c| *c > 0.0).is_some_and(|c| w.tokens > c),
        };
    // An exceeded OBSERVED cap means the lower bound was too low — say null, never "0 minutes".
    let minutes_to_exhaustion = if capacity_exceeded {
        Value::Null
    } else {
        match remaining {
            Some(r) if r > 0.0 && projection_tokens_per_min > 0.0 => num(js_to_fixed_num(r / projection_tokens_per_min, 1)),
            Some(r) if r <= 0.0 => num(0.0),
            _ => Value::Null,
        }
    };
    let mut m = Map::new();
    m.insert("window".into(), label.into());
    m.insert("windowMs".into(), num(window_ms));
    m.insert("consumedTokens".into(), num(w.tokens));
    m.insert("consumedCostUsd".into(), num(js_to_fixed_num(w.cost, 4)));
    m.insert("consumedBillableWeighted".into(), num(js_math_round(billable_weighted_tokens(&w.b))));
    m.insert("breakdown".into(), breakdown_value(&w.b));
    m.insert("capacityTokens".into(), capacity.map_or(Value::Null, num));
    m.insert("pctConsumed".into(), pct.map_or(Value::Null, num));
    m.insert("capacityCostUsd".into(), capacity_cost.map_or(Value::Null, num));
    m.insert("pctConsumedCost".into(), pct_cost.map_or(Value::Null, num));
    m.insert("tokensPerMin".into(), num(projection_tokens_per_min));
    m.insert("minutesToExhaustion".into(), minutes_to_exhaustion);
    m.insert("capacityExceeded".into(), Value::Bool(capacity_exceeded));
    Value::Object(m)
}

/// observedCapacityFor — manual caps DISABLE observed entirely; the pooled budget
/// (account_uuid = None-as-undefined) applies observed only when exactly ONE account (the
/// calibrated one) burned in the WINDOW BEING REPORTED, unattributed counting as its own.
/// `account_uuid`: Rust spelling of the TS tri-state — `None` = the pooled budget (TS
/// `undefined`), `Some(None)` = the unknown bucket (TS `null`), `Some(Some(id))` = an account.
fn observed_capacity_for<'a>(
    config: &'a BurnConfig,
    account_uuid: Option<Option<&str>>,
    events: &[Value],
    now: f64,
    window_ms: f64,
) -> Option<&'a ObservedAccountCapacity> {
    let manual = config.window5h_tokens.is_some() || config.window7d_tokens.is_some() || config.window5h_cost_usd.is_some() || config.window7d_cost_usd.is_some();
    if manual {
        return None;
    }
    match account_uuid {
        None => {
            // Pooled budget: count who actually BURNED in this window.
            if config.observed.len() != 1 {
                return None;
            }
            let calibrated = config.observed.keys().next().expect("len 1");
            let mut active: std::collections::HashSet<&str> = std::collections::HashSet::new();
            let from = now - window_ms;
            for e in events {
                let ts = f(e, "ts");
                if ts < from || ts > now {
                    continue;
                }
                // The leading SPACE is load-bearing: it cannot collide with a real accountUuid
                // (hex-and-dashes, never whitespace) — the TS sentinel, kept verbatim.
                active.insert(s(e, "accountUuid").unwrap_or(" unattributed"));
            }
            if active.len() > 1 {
                return None;
            }
            if active.len() == 1 && !active.contains(calibrated.as_str()) {
                return None;
            }
            config.observed.get(calibrated)
        }
        Some(Some(id)) => config.observed.get(id),
        Some(None) => None,
    }
}

/// computeWindowBudget — rolling 5h + 7d consumption; observed capacities resolved PER WINDOW.
pub fn compute_window_budget(events: &[Value], config: &BurnConfig, projection_tokens_per_min: f64, now: f64, account_uuid: Option<Option<&str>>) -> Value {
    let obs5h = observed_capacity_for(config, account_uuid, events, now, FIVE_HOURS_MS);
    let obs7d = observed_capacity_for(config, account_uuid, events, now, SEVEN_DAYS_MS);
    let obs = obs5h.or(obs7d);
    let cap5h = config.window5h_tokens.or(obs5h.and_then(|o| o.window5h_tokens));
    let cap7d = config.window7d_tokens.or(obs7d.and_then(|o| o.window7d_tokens));
    let cap5h_cost = config.window5h_cost_usd.or(obs5h.and_then(|o| o.window5h_cost_usd));
    let cap7d_cost = config.window7d_cost_usd.or(obs7d.and_then(|o| o.window7d_cost_usd));
    let configured = cap5h.is_some() || cap7d.is_some() || cap5h_cost.is_some() || cap7d_cost.is_some();
    let manual = config.capacity_source == "env" || config.capacity_source == "config";
    let source = if manual {
        config.capacity_source
    } else if obs.is_some() {
        "observed"
    } else {
        "none"
    };
    let lower_bound_5h = !manual && obs5h.is_some();
    let lower_bound_7d = !manual && obs7d.is_some();
    let mut m = Map::new();
    m.insert("fiveHour".into(), window_consumption(events, now, FIVE_HOURS_MS, "5h", cap5h, projection_tokens_per_min, cap5h_cost, lower_bound_5h));
    m.insert("sevenDay".into(), window_consumption(events, now, SEVEN_DAYS_MS, "7d", cap7d, projection_tokens_per_min, cap7d_cost, lower_bound_7d));
    m.insert("capacitySource".into(), source.into());
    m.insert("capacityConfigured".into(), Value::Bool(configured));
    let observed_at = if source == "observed" { obs.and_then(|o| o.observed_at.clone()) } else { None };
    m.insert("capacityObservedAt".into(), observed_at.clone().map_or(Value::Null, Value::from));
    // `note: undefined` drops from JSON — the key appears only on the branches that set text.
    if configured {
        if source == "observed" {
            let when = obs.and_then(|o| o.observed_at.clone()).unwrap_or_else(|| "at an unknown time".to_owned());
            m.insert(
                "note".into(),
                format!("Capacity auto-calibrated from a rate-limit hit observed {when} — a PROVEN LOWER BOUND (the real cap may be higher; a later larger observation raises it, never lowers). Set AGENTLENS_WINDOW_5H_TOKENS / _7D_TOKENS (or burn-config.json) to override with the exact plan cap.").into(),
            );
        }
    } else {
        m.insert(
            "note".into(),
            "Window capacity not configured — set AGENTLENS_WINDOW_5H_TOKENS / AGENTLENS_WINDOW_7D_TOKENS (raw-token caps) or AGENTLENS_WINDOW_5H_COST_USD / AGENTLENS_WINDOW_7D_COST_USD (cost caps), or ~/.agentlens/burn-config.json, so % consumed and time-to-exhaustion can be computed. AgentlensPro also auto-calibrates an observed capacity the next time a rate limit ends a window prematurely (P5).".into(),
        );
    }
    Value::Object(m)
}

/// computeAccountWindowBudgets — the same event stream split per OAuth account, each with its
/// own budget + burn rate; unknown bucket pinned last, else heaviest 7d consumption first.
pub fn compute_account_window_budgets(events: &[Value], config: &BurnConfig, now: f64) -> Value {
    let mut by_account: IndexMap<Option<&str>, Vec<Value>> = IndexMap::new();
    for e in events {
        by_account.entry(s(e, "accountUuid")).or_default().push(e.clone());
    }
    let mut out: Vec<Value> = Vec::new();
    for (account_uuid, evs) in &by_account {
        let five_min = f(&rate_window(evs, now, FIVE_MIN_MS), "tokensPerMin");
        let mut m = Map::new();
        m.insert("accountUuid".into(), account_uuid.map_or(Value::Null, Value::from));
        m.insert("budget".into(), compute_window_budget(evs, config, five_min, now, Some(*account_uuid)));
        m.insert("fiveMinTokensPerMin".into(), num(five_min));
        m.insert("events".into(), num(window_sum(evs, now, SEVEN_DAYS_MS).count));
        out.push(Value::Object(m));
    }
    out.sort_by(|a, b| {
        // Unknown bucket pinned last; otherwise heaviest 7d consumption first.
        if a["accountUuid"].is_null() {
            return std::cmp::Ordering::Greater;
        }
        if b["accountUuid"].is_null() {
            return std::cmp::Ordering::Less;
        }
        let (ka, kb) = (f(&a["budget"]["sevenDay"], "consumedTokens"), f(&b["budget"]["sevenDay"], "consumedTokens"));
        kb.partial_cmp(&ka).unwrap_or(std::cmp::Ordering::Equal)
    });
    Value::Array(out)
}

/// observeCapacityFromPrematureEnd — the consumption an account accrued between its window
/// start and a PREMATURE (rate-limit) end: the empirically-observed capacity.
pub fn observe_capacity_from_premature_end(events: &[Value], account_uuid: Option<&str>, window_start_ms: f64, window_end_ms: f64) -> Value {
    let mut b = [0.0f64; 5];
    let (mut tokens, mut cost_usd, mut count) = (0.0f64, 0.0f64, 0.0f64);
    for e in events {
        if s(e, "accountUuid") != account_uuid {
            continue;
        }
        let ts = f(e, "ts");
        if ts < window_start_ms || ts > window_end_ms {
            continue;
        }
        tokens += f(e, "tokens");
        cost_usd += f(e, "costUsd");
        count += 1.0;
        let has_split = has(e, "inputTokens") || has(e, "outputTokens") || has(e, "cacheReadTokens") || has(e, "cacheCreateTokens");
        if has_split {
            b[0] += f(e, "inputTokens");
            b[1] += f(e, "outputTokens");
            b[2] += f(e, "cacheReadTokens");
            b[3] += f(e, "cacheCreateTokens");
        } else {
            b[4] += f(e, "tokens");
        }
    }
    let mut m = Map::new();
    m.insert("accountUuid".into(), account_uuid.map_or(Value::Null, Value::from));
    m.insert("windowStartMs".into(), num(window_start_ms));
    m.insert("windowEndMs".into(), num(window_end_ms));
    m.insert("tokens".into(), num(tokens));
    m.insert("costUsd".into(), num(js_to_fixed_num(cost_usd, 4)));
    m.insert("billableWeighted".into(), num(js_math_round(billable_weighted_tokens(&b))));
    m.insert("breakdown".into(), breakdown_value(&b));
    m.insert("events".into(), num(count));
    Value::Object(m)
}

// ── Alerts (spec 3) ───────────────────────────────────────────────────────────────

/// sessionLabel — `${id.slice(0,12)}${ws}${req}`; userRequest included only when it does not
/// start with '[' (a placeholder), workspace as its last path segment.
fn session_label(sessions: &[Value], session_id: Option<&str>) -> String {
    let Some(session_id) = session_id else { return "unknown session".to_owned() };
    let c = sessions.iter().find(|s2| s(s2, "sessionId") == Some(session_id));
    let req = c
        .and_then(|c| s(c, "userRequest"))
        .filter(|r| !r.is_empty() && !r.starts_with('['))
        .map(|r| format!(" — \"{}\"", js_slice(r, 60)))
        .unwrap_or_default();
    let ws = c
        .and_then(|c| s(c, "workspace"))
        .filter(|w| !w.is_empty())
        .map(|w| format!(" ({})", w.rsplit('/').next().unwrap_or("")))
        .unwrap_or_default();
    format!("{}{ws}{req}", js_slice(session_id, 12))
}

#[allow(clippy::too_many_arguments)] // the BurnAlert literal's own field list, in wire order
fn alert(id: String, rule: &str, severity: &str, label: String, detail: String, session_id: Option<&str>, cause: &Value, value: f64, threshold: f64, ts: f64) -> Value {
    let mut m = Map::new();
    m.insert("id".into(), id.into());
    m.insert("rule".into(), rule.into());
    m.insert("severity".into(), severity.into());
    m.insert("label".into(), label.into());
    m.insert("detail".into(), detail.into());
    m.insert("sessionId".into(), session_id.map_or(Value::Null, Value::from));
    m.insert("cause".into(), cause.clone());
    m.insert("value".into(), num(value));
    m.insert("threshold".into(), num(threshold));
    m.insert("ts".into(), num(ts));
    Value::Object(m)
}

/// evaluateBurnAlerts — the four threshold rules against the current series + budget.
pub fn evaluate_burn_alerts(series: &Value, budget: &Value, config: &BurnConfig, sessions: &[Value], events: &[Value], now: f64) -> Vec<Value> {
    let mut alerts: Vec<Value> = Vec::new();
    let th = &config.thresholds;
    let top = series["sessions"].as_array().and_then(|a| a.first());
    let top_id = top.and_then(|t| s(t, "sessionId"));
    let top_cause = top.map(|t| t["dominantCause"].clone()).unwrap_or(Value::Null);
    // `${cause ? ` · cause: ${cause}` : ''}` — TRUTHY, so an empty string adds no suffix.
    let cause_suffix = |cause: &Value| cause.as_str().filter(|c| !c.is_empty()).map(|c| format!(" · cause: {c}")).unwrap_or_default();

    // Rule 1 — global tokens/min (rolling 1-min).
    let one_min_tpm = f(&series["global"]["oneMin"], "tokensPerMin");
    if one_min_tpm > th.tokens_per_min {
        alerts.push(alert(
            format!("tokens_per_min:{}", top_id.unwrap_or("global")),
            "tokens_per_min",
            "error",
            "Token burn rate high".to_owned(),
            format!(
                "{} tok/min (threshold {}). Hottest: {}{}",
                to_locale_en(one_min_tpm),
                to_locale_en(th.tokens_per_min),
                session_label(sessions, top_id),
                cause_suffix(&top_cause)
            ),
            top_id,
            &top_cause,
            one_min_tpm,
            th.tokens_per_min,
            now,
        ));
    }

    // Rule 2 — global $/hr (from the rolling-5-min rate, steadier than 1-min).
    let cost_per_hour = f(&series["global"]["fiveMin"], "costPerMin") * 60.0;
    if cost_per_hour > th.cost_per_hour {
        alerts.push(alert(
            format!("cost_per_hour:{}", top_id.unwrap_or("global")),
            "cost_per_hour",
            "warning",
            "Spend rate high".to_owned(),
            format!(
                // toFixed(2) — pre-round with the JS tie rule, then pad to exactly 2 decimals.
                "${:.2}/hr (threshold ${}). Hottest: {}{}",
                js_to_fixed_num(cost_per_hour, 2),
                crate::summarize::helpers::fmt_js_num(th.cost_per_hour),
                session_label(sessions, top_id),
                cause_suffix(&top_cause)
            ),
            top_id,
            &top_cause,
            js_to_fixed_num(cost_per_hour, 2),
            th.cost_per_hour,
            now,
        ));
    }

    // Rule 3 — rate-limit window % (capacityExceeded ⇒ no percentage; prefer the COST pct).
    for (rule, wc) in [("window_5h_pct", &budget["fiveHour"]), ("window_7d_pct", &budget["sevenDay"])] {
        let fill = if wc["capacityExceeded"] == Value::Bool(true) {
            None
        } else {
            wc.get("pctConsumedCost").and_then(Value::as_f64).or_else(|| wc.get("pctConsumed").and_then(Value::as_f64))
        };
        let Some(fill) = fill else { continue };
        if fill > th.window_pct {
            let proj = wc
                .get("minutesToExhaustion")
                .and_then(Value::as_f64)
                .map(|mte| format!(" · ~{}min to exhaustion at current rate", crate::summarize::helpers::fmt_js_num(mte)))
                .unwrap_or_default();
            let window = s(wc, "window").unwrap_or("");
            alerts.push(alert(
                format!("{rule}:global"),
                rule,
                "error",
                format!("{window} rate-limit window {:.0}% consumed", js_to_fixed_num(fill, 0)),
                format!(
                    "{window} window {:.1}% consumed (threshold {}%){proj}. Top consumer: {}{}",
                    js_to_fixed_num(fill, 1),
                    crate::summarize::helpers::fmt_js_num(th.window_pct),
                    session_label(sessions, top_id),
                    cause_suffix(&top_cause)
                ),
                top_id,
                &top_cause,
                fill,
                th.window_pct,
                now,
            ));
        }
    }

    // Rule 4 — a single api_request re-wrote a huge prefix (cache-creation ≥ N in the last 5 min).
    let from = now - FIVE_MIN_MS;
    let mut worst: Option<&Value> = None;
    for e in events {
        let ts = f(e, "ts");
        if ts < from || ts > now {
            continue;
        }
        let cc = f(e, "cacheCreateTokens");
        if cc >= th.cache_create_single_call && worst.is_none_or(|w| cc > f(w, "cacheCreateTokens")) {
            worst = Some(e);
        }
    }
    if let Some(e) = worst {
        let cc = f(e, "cacheCreateTokens");
        let sid = s(e, "sessionId").unwrap_or("");
        let attr = e.get("attribution").cloned().filter(|v| !v.is_null());
        alerts.push(alert(
            format!("cache_create_spike:{sid}"),
            "cache_create_spike",
            "warning",
            "Large cache-creation on a single call".to_owned(),
            format!(
                "One call wrote {} cache-creation tokens (threshold {}). Session: {}{}",
                to_locale_en(cc),
                to_locale_en(th.cache_create_single_call),
                session_label(sessions, Some(sid)),
                // `worstSpike.attribution ? …` — truthy: an empty string adds no suffix (while
                // the `cause` FIELD below keeps '' — the TS mixes truthy and nullish here).
                attr.as_ref().and_then(Value::as_str).filter(|a| !a.is_empty()).map(|a| format!(" · cause: {a}")).unwrap_or_default()
            ),
            Some(sid),
            &attr.unwrap_or(Value::Null),
            cc,
            th.cache_create_single_call,
            now,
        ));
    }

    alerts
}

// ── Aggregate burn status (spec 4) ────────────────────────────────────────────────

/// cardTtlRegime — kind from the card lineage × the machine TtlContext; degrades to 'assumed'.
fn card_ttl_regime(card: Option<&Value>, ttl_ctx: Option<&TtlContext>) -> TtlRegime {
    classify_ttl_regime(card.map(session_ttl_kind_of), ttl_ctx)
}

/// computeBurnStatus — the get_burn_status / /api/burn-status shape (pre-enrichment).
pub fn compute_burn_status(events: &[Value], sessions: &[Value], config: &BurnConfig, now: f64, ttl_ctx: Option<&TtlContext>) -> Value {
    let series = compute_burn_series(events, now);
    let projection = f(&series["global"]["fiveMin"], "tokensPerMin");
    let budget = compute_window_budget(events, config, projection, now, None);
    let alerts = evaluate_burn_alerts(&series, &budget, config, sessions, events, now);
    let mut m = Map::new();
    m.insert("now".into(), num(now));
    let mut g = Map::new();
    g.insert("oneMin".into(), series["global"]["oneMin"].clone());
    g.insert("fiveMin".into(), series["global"]["fiveMin"].clone());
    g.insert("costPerHour".into(), num(js_to_fixed_num(f(&series["global"]["fiveMin"], "costPerMin") * 60.0, 4)));
    m.insert("global".into(), Value::Object(g));
    m.insert("window".into(), budget);
    m.insert("accountWindows".into(), compute_account_window_budgets(events, config, now));
    // P6 keep-warm decoration on the top-5 hot sessions ({...sb, keepWarm} — appended LAST).
    let empty = Vec::new();
    let top: Vec<Value> = series["sessions"]
        .as_array()
        .unwrap_or(&empty)
        .iter()
        .take(5)
        .map(|sb| {
            let card = sessions.iter().find(|c| s(c, "sessionId") == s(sb, "sessionId"));
            let empty_tl = Vec::new();
            let tl = card.and_then(|c| c.get("timeline")).and_then(Value::as_array).unwrap_or(&empty_tl);
            let kw = compute_keep_warm(tl, &card_ttl_regime(card, ttl_ctx)).unwrap_or(Value::Null);
            let mut o = sb.as_object().cloned().unwrap_or_default();
            o.insert("keepWarm".into(), kw);
            Value::Object(o)
        })
        .collect();
    m.insert("topSessions".into(), Value::Array(top));
    m.insert("alerts".into(), Value::Array(alerts));
    m.insert("activeSessions".into(), num(series["sessions"].as_array().map_or(0, Vec::len) as f64));
    Value::Object(m)
}

// ── Session resolution + status (spec 5) ──────────────────────────────────────────

/// lastActivityMs — last parseable timeline ts, else statusline lastTs, else startTime, else 0.
pub fn last_activity_ms(card: &Value) -> f64 {
    if let Some(tl) = card.get("timeline").and_then(Value::as_array) {
        for e in tl.iter().rev() {
            if let Some(t) = parse_iso_ms(s(e, "timestamp").unwrap_or("")) {
                return t;
            }
        }
    }
    // `card.statusline?.lastTs` — truthy (0 falls through, as in TS).
    if let Some(last_ts) = card.get("statusline").and_then(|sl| sl.get("lastTs")).and_then(Value::as_f64).filter(|t| *t != 0.0) {
        return to_ms(last_ts);
    }
    parse_iso_ms(s(card, "startTime").unwrap_or("")).unwrap_or(0.0)
}

/// resolveSession — sessionId exact, else workspace prefix (recent-first), else newest overall.
pub fn resolve_session<'a>(sessions: &'a [Value], session_id: Option<&str>, workspace: Option<&str>, now: f64) -> (Option<&'a Value>, bool, &'static str) {
    if let Some(sid) = session_id.filter(|v| !v.is_empty()) {
        let c = sessions.iter().find(|c| s(c, "sessionId") == Some(sid));
        let live = c.is_some_and(|c| now - last_activity_ms(c) < LIVE_MS);
        return (c, live, if c.is_some() { "sessionId" } else { "none" });
    }
    if let Some(ws) = workspace.filter(|v| !v.is_empty()) {
        let cands: Vec<&Value> = sessions
            .iter()
            .filter(|c| s(c, "workspace").unwrap_or("").starts_with(ws) || s(c, "projectPath").unwrap_or("").starts_with(ws) || s(c, "sessionId").unwrap_or("").contains(ws))
            .collect();
        if cands.is_empty() {
            return (None, false, "none");
        }
        let mut recent: Vec<&&Value> = cands.iter().filter(|c| now - last_activity_ms(c) < LIVE_MS).collect();
        recent.sort_by(|a, b| last_activity_ms(b).partial_cmp(&last_activity_ms(a)).unwrap_or(std::cmp::Ordering::Equal));
        if let Some(first) = recent.first() {
            return (Some(**first), true, "workspace-recent");
        }
        let mut by_recency = cands.clone();
        by_recency.sort_by(|a, b| last_activity_ms(b).partial_cmp(&last_activity_ms(a)).unwrap_or(std::cmp::Ordering::Equal));
        return (Some(by_recency[0]), false, "workspace-latest");
    }
    let mut all: Vec<&Value> = sessions.iter().collect();
    all.sort_by(|a, b| last_activity_ms(b).partial_cmp(&last_activity_ms(a)).unwrap_or(std::cmp::Ordering::Equal));
    match all.first() {
        None => (None, false, "none"),
        Some(c) => (Some(*c), now - last_activity_ms(c) < LIVE_MS, "latest"),
    }
}

/// cardCostUsd — statusline cumulative (presence-gated on samples>0, so an authoritative $0
/// survives), else the mixed-speed blended cost, else the pricing estimate. `now_ms` stands in
/// for the TS omitted `atIso` (today's rate).
pub fn card_cost_usd(card: &Value, now_ms: f64) -> f64 {
    if let Some(sl) = card.get("statusline").filter(|v| !v.is_null()) {
        if f(sl, "samples") > 0.0 {
            return f(sl, "totalCostUsd");
        }
    }
    if let Some(blended) = card.get("speedBlendedCostUsd").and_then(Value::as_f64) {
        return blended;
    }
    calc_token_cost_usd(f(card, "inputTokens"), f(card, "cacheReadTokens"), f(card, "cacheCreateTokens"), f(card, "outputTokens"), s(card, "model").unwrap_or(""), 0.0, None, now_ms)
}

/// computeSessionStatus — the one-call self-diagnostic (get_session_status).
pub fn compute_session_status(
    sessions: &[Value],
    events: &[Value],
    config: &BurnConfig,
    session_id: Option<&str>,
    workspace: Option<&str>,
    now: f64,
    ttl_ctx: Option<&TtlContext>,
) -> Value {
    let (card, live, matched_by) = resolve_session(sessions, session_id, workspace, now);
    let Some(card) = card else {
        let message = match (session_id.filter(|v| !v.is_empty()), workspace.filter(|v| !v.is_empty())) {
            (Some(sid), _) => format!("No session {sid} found."),
            (None, Some(ws)) => format!("No session found under workspace \"{ws}\"."),
            (None, None) => "No sessions recorded yet.".to_owned(),
        };
        let mut m = Map::new();
        m.insert("message".into(), message.into());
        m.insert("matchedBy".into(), "none".into());
        return Value::Object(m);
    };
    let sl = card.get("statusline").filter(|v| !v.is_null() && v.is_object());
    let sid = s(card, "sessionId").unwrap_or("");

    let sess_events: Vec<Value> = events.iter().filter(|e| s(e, "sessionId") == Some(sid)).cloned().collect();
    let tokens_per_min = f(&rate_window(&sess_events, now, FIVE_MIN_MS), "tokensPerMin");

    // Last-call cost: newest api_request WITH a costUsd key (a null value still counts as
    // present, then falls to 0 through `?? 0` — mirrored by f()).
    let empty_tl = Vec::new();
    let tl = card.get("timeline").and_then(Value::as_array).unwrap_or(&empty_tl);
    let last_api = tl.iter().rev().find(|e| s(e, "type") == Some("api_request") && has(e, "costUsd"));
    let last_call_cost = last_api.map_or(0.0, |e| f(e, "costUsd"));

    // `Math.max(1, card.totalLlmCalls || card.turns || 1)` — JS falsy chain.
    let first_truthy = [f(card, "totalLlmCalls"), f(card, "turns"), 1.0].into_iter().find(|v| *v != 0.0).unwrap_or(1.0);
    let turns = first_truthy.max(1.0);
    let total_tok = f(card, "inputTokens") + f(card, "outputTokens") + f(card, "cacheReadTokens") + f(card, "cacheCreateTokens");

    let series = compute_burn_series(events, now);
    let budget = compute_window_budget(events, config, f(&series["global"]["fiveMin"], "tokensPerMin"), now, None);

    // Comparison vs previous sessions in the SAME (non-empty) workspace, older than this one.
    let ws = s(card, "workspace").unwrap_or("");
    let prev: Vec<&Value> = sessions
        .iter()
        .filter(|c| s(c, "sessionId") != Some(sid) && s(c, "workspace").unwrap_or("") == ws && !ws.is_empty() && last_activity_ms(c) < last_activity_ms(card))
        .collect();
    let comparison = if prev.is_empty() {
        Value::Null
    } else {
        let n = prev.len() as f64;
        let avg_cost = prev.iter().map(|c| card_cost_usd(c, now)).sum::<f64>() / n;
        let avg_turns = prev.iter().map(|c| f(c, "totalLlmCalls")).sum::<f64>() / n;
        let avg_hit = prev.iter().map(|c| f(c, "cacheHitRate")).sum::<f64>() / n;
        let this_cost = card_cost_usd(card, now);
        let mut m = Map::new();
        m.insert("previousSessions".into(), num(n));
        m.insert("avgCostUsd".into(), num(js_to_fixed_num(avg_cost, 4)));
        m.insert("avgTurns".into(), num(js_to_fixed_num(avg_turns, 1)));
        m.insert("avgCacheHitRatePct".into(), num(js_math_round(avg_hit * 100.0)));
        m.insert("deltaCostUsd".into(), num(js_to_fixed_num(this_cost - avg_cost, 4)));
        m.insert("deltaTurns".into(), num(js_to_fixed_num(f(card, "totalLlmCalls") - avg_turns, 1)));
        m.insert("deltaCacheHitPct".into(), num(js_math_round((f(card, "cacheHitRate") - avg_hit) * 100.0)));
        Value::Object(m)
    };

    // `a ?? b ?? c` chains: present-and-non-null wins, 0 included.
    let nn = |v: Option<&Value>| v.filter(|v| !v.is_null()).and_then(Value::as_f64);
    let sl_num = |k: &str| nn(sl.and_then(|sl| sl.get(k)));
    let api_num = |k: &str| nn(last_api.and_then(|e| e.get(k)));

    let mut m = Map::new();
    let mut resolved = Map::new();
    resolved.insert("sessionId".into(), sid.into());
    resolved.insert("workspace".into(), ws.into());
    resolved.insert("source".into(), s(card, "source").unwrap_or("").into());
    resolved.insert("model".into(), s(card, "model").unwrap_or("").into());
    resolved.insert("live".into(), Value::Bool(live));
    resolved.insert("matchedBy".into(), matched_by.into());
    resolved.insert("tokensSource".into(), card.get("tokensSource").cloned().unwrap_or(Value::Null));
    if let Some(note) = s(card, "coverageNote").filter(|v| !v.is_empty()) {
        resolved.insert("coverageNote".into(), note.into());
    }
    m.insert("resolved".into(), Value::Object(resolved));
    let mut context = Map::new();
    context.insert("currentTokens".into(), num(sl_num("lastTotalInputTokens").or_else(|| nn(card.get("peakContextPerTurn"))).unwrap_or(0.0)));
    context.insert("peakTokens".into(), num(nn(card.get("peakContextPerTurn")).or_else(|| sl_num("peakContextTokens")).unwrap_or(0.0)));
    context.insert("windowSize".into(), sl_num("contextWindowSize").map_or(Value::Null, num));
    context.insert("usedPct".into(), sl_num("usedPercentage").map_or(Value::Null, num));
    m.insert("context".into(), Value::Object(context));
    let mut buckets = Map::new();
    buckets.insert("input".into(), num(sl_num("lastInputTokens").or_else(|| api_num("inputTokens")).unwrap_or(0.0)));
    buckets.insert("output".into(), num(sl_num("lastOutputTokens").or_else(|| api_num("outputTokens")).unwrap_or(0.0)));
    buckets.insert("cacheRead".into(), num(sl_num("lastCacheReadTokens").or_else(|| api_num("cacheReadTokens")).unwrap_or(0.0)));
    buckets.insert("cacheCreate".into(), num(sl_num("lastCacheCreateTokens").or_else(|| api_num("cacheCreateTokens")).unwrap_or(0.0)));
    m.insert("usageBuckets".into(), Value::Object(buckets));
    let mut avg = Map::new();
    avg.insert("input".into(), num(js_math_round(f(card, "inputTokens") / turns)));
    avg.insert("output".into(), num(js_math_round(f(card, "outputTokens") / turns)));
    avg.insert("cacheRead".into(), num(js_math_round(f(card, "cacheReadTokens") / turns)));
    avg.insert("cacheCreate".into(), num(js_math_round(f(card, "cacheCreateTokens") / turns)));
    avg.insert("total".into(), num(js_math_round(total_tok / turns)));
    m.insert("avgPerCall".into(), Value::Object(avg));
    m.insert("cacheHitRatePct".into(), num(js_math_round(f(card, "cacheHitRate") * 100.0)));
    m.insert("lastCallCostUsd".into(), num(js_to_fixed_num(last_call_cost, 4)));
    m.insert("sessionTotalCostUsd".into(), num(js_to_fixed_num(card_cost_usd(card, now), 4)));
    m.insert("tokensPerMin".into(), num(tokens_per_min));
    m.insert("keepWarm".into(), compute_keep_warm(tl, &card_ttl_regime(Some(card), ttl_ctx)).unwrap_or(Value::Null));
    let mut rlw = Map::new();
    rlw.insert("fiveHourPct".into(), budget["fiveHour"]["pctConsumed"].clone());
    rlw.insert("sevenDayPct".into(), budget["sevenDay"]["pctConsumed"].clone());
    rlw.insert("fiveHourMinutesToExhaustion".into(), budget["fiveHour"]["minutesToExhaustion"].clone());
    rlw.insert("sevenDayMinutesToExhaustion".into(), budget["sevenDay"]["minutesToExhaustion"].clone());
    rlw.insert("capacityConfigured".into(), budget["capacityConfigured"].clone());
    m.insert("rateLimitWindow".into(), Value::Object(rlw));
    m.insert("comparison".into(), comparison);
    let mut drill = Map::new();
    drill.insert("context_history".into(), "get_context_history(sessionId) — per-step context blocks + diffs (what changed each turn)".into());
    drill.insert("context_composition".into(), "get_context_composition(sessionId) — what occupies the context window per turn".into());
    m.insert("drill".into(), Value::Object(drill));
    if matched_by == "workspace-latest" {
        m.insert("message".into(), "No live session under this workspace in the last 10 min — returning the most recent one (live:false).".into());
    }
    Value::Object(m)
}

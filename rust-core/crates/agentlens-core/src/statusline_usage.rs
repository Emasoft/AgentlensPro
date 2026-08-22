//! Port of src/statuslineUsage.ts (TRDD-DMWOBWFH) — the in-memory aggregator over captured
//! status-line payloads. This is the AUTHORITATIVE, rate-limit-free source of exact per-turn
//! token buckets, context-window occupancy and cumulative cost: the numbers come straight from
//! the API response (context_window.used_percentage, context_window_size, cost.total_cost_usd)
//! with no server query and no pricing-table estimate. Feeds windowSource, lastTurnContextRead
//! and peakContextPerTurn (see src/mcpServer.ts).
//!
//! Pure in-memory logic: no file I/O, no clock reads (`now_ms` is always an explicit parameter,
//! per this port's convention — the TS uses `Date.now()` defaults, which are NOT ported here on
//! purpose so every caller is forced to pass a deterministic clock).
//!
//! JS coercion traps ported faithfully:
//!   - `num()` (here `num_or0`) turns NaN AND +/-Infinity into 0 — NOT just NaN like the common
//!     `Number(v) || 0` idiom. It is `Number.isFinite(n) ? n : 0`. See its doc comment.
//!   - `numOrNull()` (here `num_or_null`) returns None (not 0) for an unresolvable value — the
//!     honest "absent" for a utilization figure, so a missing window is never silently 0%.
//!   - `a || b` (workspace/model resolution) is JS truthiness — an empty string is falsy, so it
//!     falls through to the next candidate; ported as `is_empty()` checks, not `is_none()`.
//!   - `a ?? b` (nullish coalescing) only skips null/undefined, NOT empty string/0/false; ported
//!     as `non_null()` filters.

use std::collections::{HashMap, HashSet};
use serde_json::{Map, Value};
use std::sync::OnceLock;

use crate::summarize::helpers::num;

// ---------------------------------------------------------------------------------------------
// JS-coercion helpers
// ---------------------------------------------------------------------------------------------

/// `Number(v)` for the JSON shapes a captured payload can carry. Missing (`None`) mirrors
/// `undefined` → `NaN`. Not a full ECMA-262 ToNumber (objects with valueOf/toString beyond the
/// simple cases below never occur in these payloads) but faithful for every shape JSON can hold.
fn js_number(v: Option<&Value>) -> f64 {
    match v {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => if *b { 1.0 } else { 0.0 },
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() { 0.0 } else { t.parse::<f64>().unwrap_or(f64::NAN) }
        }
        // Number([]) === 0, Number([x]) === Number(x), Number([x,y,...]) === NaN.
        Some(Value::Array(a)) => match a.len() {
            0 => 0.0,
            1 => js_number(a.first()),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// TS `num()` — NOT `Number(v) || 0` (that idiom only collapses NaN and literal 0). This is
/// `Number.isFinite(n) ? n : 0`, which ALSO collapses +/-Infinity to 0. Getting this wrong would
/// let a malformed payload's `Infinity` sneak through as a context-window size.
fn num_or0(v: Option<&Value>) -> f64 {
    let n = js_number(v);
    if n.is_finite() { n } else { 0.0 }
}

/// TS `numOrNull()` — `v == null` (None/Null) → None; else finite-or-None. Never 0 for an
/// unresolvable value, so an absent rate-limit window is never reported as "0% consumed".
fn num_or_null(v: Option<&Value>) -> Option<f64> {
    match v {
        None | Some(Value::Null) => None,
        other => { let n = js_number(other); if n.is_finite() { Some(n) } else { None } }
    }
}

/// `v == null` filter — nullish coalescing (`??`) skips ONLY null/undefined, not '' or 0.
fn non_null(v: Option<&Value>) -> Option<&Value> {
    v.filter(|vv| !vv.is_null())
}

/// TS `obj()` — a non-object (including arrays and null) is treated as `{}`.
fn obj_of(v: Option<&Value>) -> &Map<String, Value> {
    static EMPTY: OnceLock<Map<String, Value>> = OnceLock::new();
    match v {
        Some(Value::Object(o)) => o,
        _ => EMPTY.get_or_init(Map::new),
    }
}

/// `String(v)` for the shapes these two fields (`project_dir`/`model`) carry in practice
/// (string, number, bool). Arrays/objects fall back to `Value::to_string()` — not exact JS
/// `String([1,2])` semantics, but those shapes never occur for a project dir or model name.
fn js_to_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                i.to_string()
            } else if let Some(f) = n.as_f64() {
                if f.fract() == 0.0 && f.is_finite() && f.abs() < 9.007_199_254_740_992e15 {
                    (f as i64).to_string()
                } else {
                    f.to_string()
                }
            } else {
                n.to_string()
            }
        }
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

// ---------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------

/// Mirrors src/shared/summarizerTypes.ts `StatuslineUsageAgg`.
#[derive(Debug, Clone, PartialEq)]
pub struct StatuslineUsageAgg {
    pub session_id: String,
    pub project_dir: String,
    pub model: String,
    pub last_input_tokens: f64,
    pub last_output_tokens: f64,
    pub last_cache_create_tokens: f64,
    pub last_cache_read_tokens: f64,
    pub last_total_input_tokens: f64,
    pub last_total_output_tokens: f64,
    pub context_window_size: f64,
    pub used_percentage: f64,
    pub total_cost_usd: f64,
    pub peak_context_tokens: f64,
    pub samples: f64,
    pub last_ts: f64,
}

impl StatuslineUsageAgg {
    fn new(session_id: &str) -> Self {
        StatuslineUsageAgg {
            session_id: session_id.to_string(),
            project_dir: String::new(),
            model: String::new(),
            last_input_tokens: 0.0,
            last_output_tokens: 0.0,
            last_cache_create_tokens: 0.0,
            last_cache_read_tokens: 0.0,
            last_total_input_tokens: 0.0,
            last_total_output_tokens: 0.0,
            context_window_size: 0.0,
            used_percentage: 0.0,
            total_cost_usd: 0.0,
            peak_context_tokens: 0.0,
            samples: 0.0,
            last_ts: 0.0,
        }
    }

    /// JSON projection matching the TS wire shape (camelCase, JS-number formatting via
    /// `summarize::helpers::num` so integral values serialize bare like `JSON.stringify`).
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("sessionId".into(), Value::from(self.session_id.clone()));
        m.insert("projectDir".into(), Value::from(self.project_dir.clone()));
        m.insert("model".into(), Value::from(self.model.clone()));
        m.insert("lastInputTokens".into(), num(self.last_input_tokens));
        m.insert("lastOutputTokens".into(), num(self.last_output_tokens));
        m.insert("lastCacheCreateTokens".into(), num(self.last_cache_create_tokens));
        m.insert("lastCacheReadTokens".into(), num(self.last_cache_read_tokens));
        m.insert("lastTotalInputTokens".into(), num(self.last_total_input_tokens));
        m.insert("lastTotalOutputTokens".into(), num(self.last_total_output_tokens));
        m.insert("contextWindowSize".into(), num(self.context_window_size));
        m.insert("usedPercentage".into(), num(self.used_percentage));
        m.insert("totalCostUsd".into(), num(self.total_cost_usd));
        m.insert("peakContextTokens".into(), num(self.peak_context_tokens));
        m.insert("samples".into(), num(self.samples));
        m.insert("lastTs".into(), num(self.last_ts));
        Value::Object(m)
    }
}

/// One per-turn billing delta for the burn monitor — mirrors src/burnMonitor.ts
/// `StatuslineBillingEvent`. `seq` is an internal open-turn identity token (TS uses object
/// reference identity to find "the same event" after a prune; Rust has no such identity for
/// Vec elements, so a monotonic sequence number stands in for it) — private, not part of the
/// TS-mirrored public shape.
#[derive(Debug, Clone, PartialEq)]
pub struct StatuslineBillingEvent {
    pub ts: f64,
    pub session_id: String,
    pub workspace: Option<String>,
    pub delta_cost_usd: f64,
    pub delta_tokens: f64,
    pub delta_input: Option<f64>,
    pub delta_output: Option<f64>,
    pub delta_cache_read: Option<f64>,
    pub delta_cache_create: Option<f64>,
    pub interval_ms: Option<f64>,
    seq: u64,
}

/// TRDD-VY1IUVUM Part-5 — mirrors TS `RateLimitsSnapshot`. Both fields are `None` when that
/// window was absent in the record — never a stand-in 0.
#[derive(Debug, Clone, PartialEq)]
pub struct RateLimitsSnapshot {
    pub ts: f64,
    pub five_hour_utilization: Option<f64>,
    pub seven_day_utilization: Option<f64>,
}

struct RateLimitsRecord {
    five_hour_utilization: Option<f64>,
    seven_day_utilization: Option<f64>,
}

/// One raw parsed line — internal, mirrors the TS `StatuslineUsageRecord` interface.
struct StatuslineUsageRecord {
    ts: f64,
    session_id: String,
    project_dir: String,
    model: String,
    input_tokens: f64,
    output_tokens: f64,
    cache_creation_input_tokens: f64,
    cache_read_input_tokens: f64,
    total_input_tokens: f64,
    total_output_tokens: f64,
    context_window_size: f64,
    used_percentage: f64,
    total_cost_usd: f64,
    rate_limits: Option<RateLimitsRecord>,
}

/// Project ONE captured status-line payload onto the flat record the aggregates are built from.
/// `None` when `session_id` is missing/empty/non-string — a malformed sample must never crash
/// ingestion (mirrors the TS: returns `null`, the caller skips it).
///
/// `ts_ms` is the caller's clock reading in epoch milliseconds; the record's own `ts` is
/// deliberately epoch SECONDS (billing-event pruning and downstream consumers work in seconds).
fn record_from_statusline_payload(payload: &Map<String, Value>, ts_ms: f64) -> Option<StatuslineUsageRecord> {
    let sid = match payload.get("session_id") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => return None,
    };
    let cw = obj_of(payload.get("context_window"));
    let cu = obj_of(cw.get("current_usage"));
    let cost = obj_of(payload.get("cost"));
    let ws = obj_of(payload.get("workspace"));
    let rl = obj_of(payload.get("rate_limits"));
    let five = obj_of(rl.get("five_hour"));
    let seven = obj_of(rl.get("seven_day"));

    let pd_val = non_null(ws.get("project_dir"))
        .or_else(|| non_null(ws.get("current_dir")))
        .or_else(|| non_null(payload.get("cwd")));
    let project_dir = pd_val.map(js_to_string).unwrap_or_default();

    let model_obj = obj_of(payload.get("model"));
    let model = non_null(model_obj.get("display_name")).map(js_to_string).unwrap_or_default();

    let five_raw = non_null(five.get("used_percentage")).or_else(|| non_null(five.get("utilization")));
    let seven_raw = non_null(seven.get("used_percentage")).or_else(|| non_null(seven.get("utilization")));
    let f = num_or_null(five_raw);
    let s = num_or_null(seven_raw);
    let rate_limits = if f.is_some() || s.is_some() {
        Some(RateLimitsRecord { five_hour_utilization: f, seven_day_utilization: s })
    } else {
        None
    };

    Some(StatuslineUsageRecord {
        ts: (ts_ms / 1000.0).floor(),
        session_id: sid,
        project_dir,
        model,
        input_tokens: num_or0(cu.get("input_tokens")),
        output_tokens: num_or0(cu.get("output_tokens")),
        cache_creation_input_tokens: num_or0(cu.get("cache_creation_input_tokens")),
        cache_read_input_tokens: num_or0(cu.get("cache_read_input_tokens")),
        total_input_tokens: num_or0(cw.get("total_input_tokens")),
        total_output_tokens: num_or0(cw.get("total_output_tokens")),
        context_window_size: num_or0(cw.get("context_window_size")),
        used_percentage: num_or0(cw.get("used_percentage")),
        total_cost_usd: num_or0(cost.get("total_cost_usd")),
        rate_limits,
    })
}

/// JS `String(n)` for the turn-key components — must match exactly, or two distinct numeric
/// values could format identically and collide as "the same turn".
fn js_num_str(v: f64) -> String {
    if v.fract() == 0.0 && v.is_finite() && v.abs() < 9.007_199_254_740_992e15 {
        (v as i64).to_string()
    } else {
        v.to_string()
    }
}

struct OpenTurn {
    key: String,
    seq: u64,
}

/// Port of TS `StatuslineUsageReader` — aggregates captured status-line payloads per session and
/// derives per-turn billing deltas for the burn monitor. Never throws on bad input.
pub struct StatuslineUsageReader {
    agg: HashMap<String, StatuslineUsageAgg>,
    billing_events: Vec<StatuslineBillingEvent>,
    open_turn: HashMap<String, OpenTurn>,
    latest_rate_limits: Option<RateLimitsSnapshot>,
    rate_limits_by_session: HashMap<String, RateLimitsSnapshot>,
    next_seq: u64,
}

impl Default for StatuslineUsageReader {
    fn default() -> Self { Self::new() }
}

impl StatuslineUsageReader {
    const BILLING_MAX: usize = 100_000;
    const BILLING_MAX_AGE_MS: f64 = 8.0 * 24.0 * 60.0 * 60.0 * 1000.0;

    pub fn new() -> Self {
        StatuslineUsageReader {
            agg: HashMap::new(),
            billing_events: Vec::new(),
            open_turn: HashMap::new(),
            latest_rate_limits: None,
            rate_limits_by_session: HashMap::new(),
            next_seq: 0,
        }
    }

    /// Ingest ONE captured status-line payload. `ts_ms` is the caller's clock reading — never
    /// read internally, per this port's determinism convention. A malformed sample (missing/
    /// empty session_id) is silently skipped, matching the TS's `try {} catch {}` shield.
    pub fn ingest_sample(&mut self, payload: &Map<String, Value>, ts_ms: f64) {
        if let Some(rec) = record_from_statusline_payload(payload, ts_ms) {
            self.ingest_record(rec);
        }
    }

    fn ingest_record(&mut self, rec: StatuslineUsageRecord) {
        let sid = rec.session_id.clone();
        if sid.is_empty() { return; }
        let total_input = rec.total_input_tokens;
        let first_sample_of_session = !self.agg.contains_key(&sid);

        // prevCost/prevTs MUST be read before this session's aggregate is touched — reading them
        // after would make every session look already-known and suppress the first-sample cost
        // guard below (a real incident: a server restart re-meeting a live session at sample one
        // billed that session's entire lifetime cost to the current window as a single turn).
        let (prev_cost, prev_ts) = {
            let entry = self.agg.entry(sid.clone()).or_insert_with(|| StatuslineUsageAgg::new(&sid));
            (entry.total_cost_usd, entry.last_ts)
        };

        let d_input = rec.input_tokens;
        let d_output = rec.output_tokens;
        let d_cache_create = rec.cache_creation_input_tokens;
        let d_cache_read = rec.cache_read_input_tokens;
        let delta_tokens = d_input + d_output + d_cache_create + d_cache_read;
        let new_cost = rec.total_cost_usd;
        let delta_cost = if first_sample_of_session { 0.0 } else { (new_cost - prev_cost).max(0.0) };
        let interval_ms = if first_sample_of_session || prev_ts <= 0.0 {
            None
        } else {
            Some(((rec.ts - prev_ts) * 1000.0).max(0.0))
        };

        // ONE EVENT PER TURN — the turn's identity is its INPUT-side buckets (input, cache
        // create, cache read). `output_tokens` is deliberately excluded: it grows while the
        // response streams, so keying on it would split one turn back into its own snapshots.
        let turn_key = format!("{}:{}:{}", js_num_str(d_input), js_num_str(d_cache_create), js_num_str(d_cache_read));
        let matches_open = self.open_turn.get(&sid).map(|o| o.key == turn_key).unwrap_or(false);
        if matches_open {
            let seq = self.open_turn.get(&sid).unwrap().seq;
            if let Some(ev) = self.billing_events.iter_mut().find(|e| e.seq == seq) {
                ev.delta_cost_usd += delta_cost;
                ev.delta_output = Some(d_output);
                ev.delta_tokens = d_input + d_cache_create + d_cache_read + d_output;
            }
        } else if delta_tokens > 0.0 || delta_cost > 0.0 {
            let seq = self.next_seq;
            self.next_seq += 1;
            let event = StatuslineBillingEvent {
                ts: rec.ts,
                session_id: sid.clone(),
                workspace: if rec.project_dir.is_empty() { None } else { Some(rec.project_dir.clone()) },
                delta_cost_usd: delta_cost,
                delta_tokens,
                delta_input: Some(d_input),
                delta_output: Some(d_output),
                delta_cache_read: Some(d_cache_read),
                delta_cache_create: Some(d_cache_create),
                interval_ms,
                seq,
            };
            self.billing_events.push(event);
            self.open_turn.insert(sid.clone(), OpenTurn { key: turn_key, seq });
        }
        // else: open turn exists under a DIFFERENT key but this sample is a no-op (no tokens, no
        // cost) — left untouched, matching the TS (the stale open-turn entry is not cleared).

        // Latest-wins snapshot for the display fields; a late/out-of-order line (ts < last seen)
        // never clobbers a newer one.
        {
            let entry = self.agg.get_mut(&sid).expect("just inserted above");
            if rec.ts >= entry.last_ts {
                entry.last_ts = rec.ts;
                if !rec.project_dir.is_empty() { entry.project_dir = rec.project_dir.clone(); }
                if !rec.model.is_empty() { entry.model = rec.model.clone(); }
                entry.last_input_tokens = rec.input_tokens;
                entry.last_output_tokens = rec.output_tokens;
                entry.last_cache_create_tokens = rec.cache_creation_input_tokens;
                entry.last_cache_read_tokens = rec.cache_read_input_tokens;
                entry.last_total_input_tokens = total_input;
                entry.last_total_output_tokens = rec.total_output_tokens;
                entry.context_window_size = rec.context_window_size;
                entry.used_percentage = rec.used_percentage;
                entry.total_cost_usd = rec.total_cost_usd;
            }
            entry.peak_context_tokens = entry.peak_context_tokens.max(total_input);
            entry.samples += 1.0;
        }

        // TRDD-VY1IUVUM Part-5 — machine-wide + per-session latest-wins rate-limit snapshot.
        if let Some(rl) = rec.rate_limits {
            let rec_ts = rec.ts;
            if rl.five_hour_utilization.is_some() || rl.seven_day_utilization.is_some() {
                let snap = RateLimitsSnapshot {
                    ts: rec_ts,
                    five_hour_utilization: rl.five_hour_utilization,
                    seven_day_utilization: rl.seven_day_utilization,
                };
                if self.latest_rate_limits.as_ref().map(|s| rec_ts >= s.ts).unwrap_or(true) {
                    self.latest_rate_limits = Some(snap.clone());
                }
                let update_session = self.rate_limits_by_session.get(&sid).map(|s| rec_ts >= s.ts).unwrap_or(true);
                if update_session {
                    self.rate_limits_by_session.insert(sid, snap);
                }
            }
        }
    }

    /// TRDD-VY1IUVUM Part-5 — the latest Claude-Code-authoritative window utilization, or `None`
    /// when nothing ingested has carried a rate_limits block yet.
    pub fn get_latest_rate_limits(&self) -> Option<&RateLimitsSnapshot> {
        self.latest_rate_limits.as_ref()
    }

    /// The newest window reading among a GIVEN set of sessions — the account-safe accessor
    /// (several accounts can be live at once; the machine-wide snapshot above cannot be
    /// attributed to any one of them). `None` when none of those sessions has reported a window.
    pub fn get_rate_limits_for_sessions<'a>(&self, session_ids: impl IntoIterator<Item = &'a str>) -> Option<RateLimitsSnapshot> {
        let mut best: Option<&RateLimitsSnapshot> = None;
        for sid in session_ids {
            if let Some(snap) = self.rate_limits_by_session.get(sid) {
                if best.map(|b| snap.ts >= b.ts).unwrap_or(true) {
                    best = Some(snap);
                }
            }
        }
        best.cloned()
    }

    /// The aggregate for a session, or `None` if it never wrote a statusline line.
    pub fn get(&self, session_id: &str) -> Option<&StatuslineUsageAgg> {
        self.agg.get(session_id)
    }

    /// Per-turn billing deltas for the burn monitor, pruned to the last ~8 days + a hard cap.
    /// `now_ms` is the caller's clock reading — never read internally.
    pub fn get_billing_events(&mut self, now_ms: f64) -> &[StatuslineBillingEvent] {
        let cutoff_sec = (now_ms - Self::BILLING_MAX_AGE_MS) / 1000.0;
        let needs_prune = self.billing_events.len() > Self::BILLING_MAX
            || self.billing_events.iter().any(|e| e.ts < cutoff_sec);
        if needs_prune {
            let mut kept: Vec<StatuslineBillingEvent> = self.billing_events
                .iter()
                .filter(|e| e.ts >= cutoff_sec)
                .cloned()
                .collect();
            if kept.len() > Self::BILLING_MAX {
                let start = kept.len() - Self::BILLING_MAX;
                kept.drain(0..start);
            }
            let kept_seqs: HashSet<u64> = kept.iter().map(|e| e.seq).collect();
            // Drop any open turn whose event was just pruned — otherwise a later sample of that
            // turn would silently mutate an orphaned event nobody reads (mirrors the TS's
            // `if (!kept.has(o.event)) this.openTurn.delete(sid)`).
            self.open_turn.retain(|_, o| kept_seqs.contains(&o.seq));
            self.billing_events = kept;
        }
        &self.billing_events
    }

    /// Attaches the authoritative statusline aggregate onto `card["statusline"]` and raises
    /// `card["peakContextPerTurn"]` to the exact context occupancy the statusline observed.
    /// No-op when this session has no statusline data, or the card carries no `sessionId`.
    pub fn overlay(&self, card: &mut Map<String, Value>) {
        let sid = match card.get("sessionId").and_then(|v| v.as_str()) {
            Some(s) => s.to_string(),
            None => return,
        };
        let a = match self.agg.get(&sid) {
            Some(a) => a,
            None => return,
        };
        card.insert("statusline".into(), a.to_value());
        // `card.peakContextPerTurn ?? 0` — nullish coalescing, so an existing 0 is kept as 0, not
        // replaced; only a missing/null field falls back to 0.
        let existing = card.get("peakContextPerTurn")
            .and_then(|v| if v.is_null() { None } else { v.as_f64() })
            .unwrap_or(0.0);
        let updated = existing.max(a.peak_context_tokens);
        card.insert("peakContextPerTurn".into(), num(updated));
    }
}

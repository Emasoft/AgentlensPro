//! Port of src/windowEta.ts (TRDD-8ZMZ4I6B, ported under TRDD-DMWOBWFH P4x.2d) —
//! `get_window_eta`: how long until the CURRENT account exhausts its rate-limit windows, at the
//! current COST rate.
//!
//! Anthropic meters the 5h/7d windows by COST (cache-read is weighted far below fresh input), so a
//! token-based projection over-counts the ~96%-cache-read stream and under-estimates the time left.
//! This projects on dollars: remaining cost capacity ÷ the account's current $/min.
//!
//! Reuses `account_burners`' machine-wide attribution and its capacity resolver (own observed
//! calibration → same-plan proxy → none) so the ETA and the burners autopsy can never disagree
//! about which events belong to the account or what its cap is.

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::account_burners::{
    events_for_account_in_window, fmt_tok, resolve_window_capacity, weighted, AccountSegment, ResolvedAccount, WindowCapacity,
};
use crate::burn::monitor::ObservedAccountCapacity;
use crate::summarize::helpers::{iso_from_ms, js_math_round, js_to_fixed_num, js_to_fixed_str, num};

/// The readable ETA, chosen by the REASON so a rolling-window plateau is never dressed up as a
/// finite countdown — the whole point of separating the two.
pub fn human_eta(eta_minutes: Option<f64>, reason: &str) -> String {
    match reason {
        "no-capacity" => "unknown (no cost capacity calibrated for this account or a same-plan one)".to_owned(),
        "idle" => "not draining (no consumption in the rate window)".to_owned(),
        "plateau" => "won't exhaust at the current rate (rolling window plateaus below the cap)".to_owned(),
        "over-limit" => "already at/over the limit".to_owned(),
        _ => {
            let m = eta_minutes.unwrap_or(0.0);
            let hh = (m / 60.0).floor();
            // `Math.round`, which is half toward +∞ — NOT Rust's half-away-from-zero.
            let mm = js_math_round(m % 60.0);
            if hh > 0.0 {
                format!("{}h {}m", crate::summarize::helpers::fmt_js_num(hh), crate::summarize::helpers::fmt_js_num(mm))
            } else {
                format!("{}m", crate::summarize::helpers::fmt_js_num(mm))
            }
        }
    }
}

pub struct EtaSection {
    label: &'static str,
    window_hours: f64,
    from_ms: f64,
    now_ms: f64,
    consumed_cost_usd: f64,
    consumed_tokens: f64,
    consumed_billable_weighted: f64,
    capacity: WindowCapacity,
    fill_pct: Option<f64>,
    remaining_cost_usd: Option<f64>,
    cost_per_min: f64,
    steady_state_fill_usd: f64,
    will_exhaust: bool,
    /// The ROUNDED field (`+etaMinutes.toFixed(1)`) — what the report reports and what the binding
    /// pick compares.
    eta_minutes: Option<f64>,
    eta_reason: &'static str,
    eta_human: String,
    exhaustion_eta_iso: Option<String>,
}

impl EtaSection {
    fn to_value(&self) -> Value {
        let mut w = Map::new();
        w.insert("fromIso".into(), Value::String(iso_from_ms(self.from_ms)));
        w.insert("untilIso".into(), Value::String(iso_from_ms(self.now_ms)));
        let mut m = Map::new();
        m.insert("label".into(), Value::String(self.label.to_owned()));
        m.insert("windowHours".into(), num(self.window_hours));
        m.insert("window".into(), Value::Object(w));
        m.insert("consumedCostUsd".into(), num(self.consumed_cost_usd));
        m.insert("consumedTokens".into(), num(self.consumed_tokens));
        m.insert("consumedBillableWeighted".into(), num(self.consumed_billable_weighted));
        m.insert("capacity".into(), self.capacity.to_value());
        m.insert("fillPct".into(), self.fill_pct.map(num).unwrap_or(Value::Null));
        m.insert("remainingCostUsd".into(), self.remaining_cost_usd.map(num).unwrap_or(Value::Null));
        m.insert("costPerMin".into(), num(self.cost_per_min));
        m.insert("steadyStateFillUsd".into(), num(self.steady_state_fill_usd));
        m.insert("willExhaustAtCurrentRate".into(), Value::Bool(self.will_exhaust));
        m.insert("etaMinutes".into(), self.eta_minutes.map(num).unwrap_or(Value::Null));
        m.insert("etaReason".into(), Value::String(self.eta_reason.to_owned()));
        m.insert("etaHuman".into(), Value::String(self.eta_human.clone()));
        m.insert("exhaustionEtaIso".into(), self.exhaustion_eta_iso.clone().map(Value::from).unwrap_or(Value::Null));
        Value::Object(m)
    }
}

struct SectionOpts<'a> {
    events: &'a [Value],
    target: &'a ResolvedAccount,
    label: &'static str,
    window_hours: f64,
    now_ms: f64,
    cost_per_min: f64,
    capacity: WindowCapacity,
}

fn build_section(o: SectionOpts<'_>) -> EtaSection {
    let from_ms = o.now_ms - o.window_hours * 3_600_000.0;
    let in_window = events_for_account_in_window(o.events, o.target, from_ms, o.now_ms, o.now_ms);
    let (mut cost, mut tokens, mut bw) = (0.0_f64, 0.0_f64, 0.0_f64);
    for e in &in_window {
        cost += e.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0);
        tokens += e.get("tokens").and_then(Value::as_f64).unwrap_or(0.0);
        bw += weighted(e);
    }

    let cap = o.capacity.cost_usd;
    let fill_pct = cap.filter(|c| *c > 0.0).map(|c| (cost / c) * 100.0);
    let remaining = cap.map(|c| c - cost);
    // A rolling window at steady rate r plateaus at r × windowLength. If that plateau is below the
    // cap the window CANNOT exhaust at this rate however long it runs — reporting remaining/rate
    // there would be a fiction, because it assumes a monotonic accumulation a rolling window never
    // does. This is the distinction a naive projection gets wrong.
    let steady_state_fill_usd = o.cost_per_min * o.window_hours * 60.0;
    let will_exhaust = cap.is_some_and(|c| steady_state_fill_usd >= c);

    let (eta_reason, eta_minutes_raw): (&'static str, Option<f64>) = if cap.is_none() {
        ("no-capacity", None)
    } else if remaining.unwrap() <= 0.0 {
        ("over-limit", Some(0.0))
    } else if o.cost_per_min <= 0.0 {
        ("idle", None)
    } else if !will_exhaust {
        ("plateau", None)
    } else {
        ("projected", Some(remaining.unwrap() / o.cost_per_min))
    };

    EtaSection {
        label: o.label,
        window_hours: o.window_hours,
        from_ms,
        now_ms: o.now_ms,
        consumed_cost_usd: js_to_fixed_num(cost, 4),
        consumed_tokens: tokens,
        consumed_billable_weighted: js_math_round(bw),
        capacity: o.capacity,
        fill_pct,
        remaining_cost_usd: remaining.map(|r| js_to_fixed_num(r, 4)),
        cost_per_min: js_to_fixed_num(o.cost_per_min, 6),
        steady_state_fill_usd: js_to_fixed_num(steady_state_fill_usd, 2),
        will_exhaust,
        eta_minutes: eta_minutes_raw.map(|m| js_to_fixed_num(m, 1)),
        eta_reason,
        // `humanEta(etaMinutes, …)` is called with the UNROUNDED local, not the rounded field.
        eta_human: human_eta(eta_minutes_raw, eta_reason),
        // …and so is the exhaustion instant: `new Date(nowMs + etaMinutes * 60_000)` reads the
        // UNROUNDED value too, so the ISO can disagree with `etaMinutes × 60s` by up to 3 seconds.
        // Rounding first would silently "fix" a discrepancy the TS actually emits.
        exhaustion_eta_iso: eta_minutes_raw.filter(|m| *m > 0.0).map(|m| iso_from_ms(o.now_ms + m * 60_000.0)),
    }
}

fn cap_src(s: &EtaSection) -> String {
    match s.capacity.source {
        Some("same-plan-proxy") => {
            let id = s.capacity.proxy_account_id.as_deref().map_or("undefined".to_owned(), |p| p.chars().take(8).collect());
            format!("same-plan proxy {id}")
        }
        Some(other) => other.to_owned(),
        None => "none".to_owned(),
    }
}

/// `x?.toFixed(n)` inside a template literal — an absent value stringifies to "undefined", which is
/// what the TS actually renders. Silently substituting "0" or "" would print a different report.
fn opt_fixed(x: Option<f64>, digits: usize) -> String {
    x.map_or("undefined".to_owned(), |v| js_to_fixed_str(v, digits))
}

pub struct WindowEtaOpts<'a> {
    pub events: &'a [Value],
    pub target: &'a ResolvedAccount,
    pub all_segments: &'a [AccountSegment],
    pub now_ms: f64,
    pub rate_window_ms: f64,
    pub observed: &'a IndexMap<String, ObservedAccountCapacity>,
}

pub fn build_window_eta_report(o: &WindowEtaOpts<'_>) -> Value {
    // The account's CURRENT cost rate: its OWN events over the rate window — per-account, because
    // the rate limit is per account and a concurrent session on a different token does not fill it.
    let rate_from = o.now_ms - o.rate_window_ms;
    let rate_events = events_for_account_in_window(o.events, o.target, rate_from, o.now_ms, o.now_ms);
    let rate_cost: f64 = rate_events.iter().map(|e| e.get("costUsd").and_then(Value::as_f64).unwrap_or(0.0)).sum();
    let cost_per_min = rate_cost / (o.rate_window_ms / 60_000.0);

    let five_hour = build_section(SectionOpts {
        events: o.events,
        target: o.target,
        label: "5h",
        window_hours: 5.0,
        now_ms: o.now_ms,
        cost_per_min,
        capacity: resolve_window_capacity(o.observed, o.target, o.all_segments, "5h"),
    });
    let seven_day = build_section(SectionOpts {
        events: o.events,
        target: o.target,
        label: "7d",
        window_hours: 168.0,
        now_ms: o.now_ms,
        cost_per_min,
        capacity: resolve_window_capacity(o.observed, o.target, o.all_segments, "7d"),
    });

    let sections = [&five_hour, &seven_day];
    // Which runs out FIRST? The smaller positive ETA — but an already-over window wins outright,
    // because "you are past the limit" is not a countdown.
    let mut cand: Vec<&EtaSection> = sections.iter().copied().filter(|s| s.eta_minutes.is_some_and(|m| m > 0.0)).collect();
    cand.sort_by(|a, b| (a.eta_minutes.unwrap() - b.eta_minutes.unwrap()).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
    let binding = cand.first().copied();
    let any_over = sections.iter().copied().find(|s| s.eta_minutes == Some(0.0));
    let binding_window = any_over.map(|s| s.label).or_else(|| binding.map(|s| s.label)).unwrap_or("none");

    let rate_window_min = js_math_round(o.rate_window_ms / 60_000.0);
    let verdict = if let Some(over) = any_over {
        format!(
            "The {} window is ALREADY at/over its cost limit ({} of {} $ cap) — a rotation is imminent or overdue.",
            over.label,
            js_to_fixed_str(over.consumed_cost_usd, 0),
            opt_fixed(over.capacity.cost_usd, 0)
        )
    } else if let Some(b) = binding {
        format!(
            "At ${}/min the {} window exhausts first in ~{} ({} of {} $ cap, {}% used, capacity {}).",
            js_to_fixed_str(cost_per_min, 2),
            b.label,
            b.eta_human,
            js_to_fixed_str(b.consumed_cost_usd, 0),
            opt_fixed(b.capacity.cost_usd, 0),
            opt_fixed(b.fill_pct, 0),
            cap_src(b)
        )
    } else if five_hour.capacity.cost_usd.is_none() && seven_day.capacity.cost_usd.is_none() {
        "No cost capacity is calibrated for this account or a same-plan account, so no ETA can be projected. A future rate-limit hit auto-calibrates it; or set AGENTLENS_WINDOW_5H_COST_USD / _7D_COST_USD.".to_owned()
    } else if cost_per_min <= 0.0 {
        format!(
            "Capacity is known but nothing is burning in the last {}m (rate $0/min) — the windows are not draining right now.",
            crate::summarize::helpers::fmt_js_num(rate_window_min)
        )
    } else {
        // Rolling-window plateau: the current rate is not enough for EITHER window to reach its cap.
        let mut with_cap: Vec<&EtaSection> = sections.iter().copied().filter(|s| s.capacity.cost_usd.is_some()).collect();
        with_cap.sort_by(|a, b| {
            let r = |s: &EtaSection| s.steady_state_fill_usd / s.capacity.cost_usd.unwrap();
            (r(b) - r(a)).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
        });
        let worst_txt = with_cap.first().map_or(String::new(), |w| {
            let cap = w.capacity.cost_usd.unwrap();
            format!(
                "The {} plateaus at ~${} of its ${} cap ({}%). ",
                w.label,
                js_to_fixed_str(w.steady_state_fill_usd, 0),
                js_to_fixed_str(cap, 0),
                crate::summarize::helpers::fmt_js_num(js_math_round(w.steady_state_fill_usd / cap * 100.0))
            )
        });
        format!(
            "At ${}/min NEITHER window exhausts — a rolling window plateaus at rate×length. {}It would take a sustained higher burst (like the one that forced the last rotation) to exhaust a window.",
            js_to_fixed_str(cost_per_min, 2),
            worst_txt
        )
    };

    let note = "ETA is COST-based (Anthropic meters the windows by cost, not raw tokens — cache-read is weighted ~0.1×). The rate is THIS account's own $/min (rate limits are per OAuth account); capacity is the account's observed calibration, else a same-plan account's as a labeled proxy, else undetermined. Consumption uses time-based attribution against the account-state timeline, so cross-rotation sessions split correctly.";

    let acct = format!(
        "{}{}",
        o.target.email.clone().unwrap_or_else(|| o.target.account_id.clone()),
        if o.target.is_current { "" } else { " (NOT the current account)" }
    );
    let mut lines = vec![format!(
        "window ETA for {} at ${}/min (rate over last {}m) — as of {}",
        acct,
        js_to_fixed_str(cost_per_min, 2),
        crate::summarize::helpers::fmt_js_num(rate_window_min),
        iso_from_ms(o.now_ms)
    )];
    for s in sections {
        let mark = if binding_window == s.label { "  ◀ EXHAUSTS FIRST" } else { "" };
        let cap_str = match s.capacity.cost_usd {
            Some(c) => format!(
                "${} / ${} cap ({}%, {})",
                js_to_fixed_str(s.consumed_cost_usd, 0),
                js_to_fixed_str(c, 0),
                opt_fixed(s.fill_pct, 0),
                cap_src(s)
            ),
            None => format!("${} consumed · no capacity", js_to_fixed_str(s.consumed_cost_usd, 0)),
        };
        lines.push(format!(
            "  {}: {} · {} raw tok · ETA {}{}{}",
            s.label,
            cap_str,
            fmt_tok(s.consumed_tokens),
            s.eta_human,
            s.exhaustion_eta_iso.as_deref().map_or(String::new(), |iso| format!(" (≈ {iso})")),
            mark
        ));
    }
    lines.push(verdict.clone());

    let mut account = Map::new();
    account.insert("accountId".into(), Value::String(o.target.account_id.clone()));
    account.insert("email".into(), o.target.email.clone().map(Value::from).unwrap_or(Value::Null));
    account.insert("plan".into(), o.target.plan.clone().map(Value::from).unwrap_or(Value::Null));
    account.insert("isCurrent".into(), Value::Bool(o.target.is_current));

    let mut m = Map::new();
    m.insert("account".into(), Value::Object(account));
    m.insert("nowIso".into(), Value::String(iso_from_ms(o.now_ms)));
    m.insert("rateWindowMin".into(), num(rate_window_min));
    m.insert("fiveHour".into(), five_hour.to_value());
    m.insert("sevenDay".into(), seven_day.to_value());
    m.insert("bindingWindow".into(), Value::String(binding_window.to_owned()));
    m.insert("verdict".into(), Value::String(verdict));
    m.insert("note".into(), Value::String(note.to_owned()));
    m.insert("text".into(), Value::String(lines.join("\n")));
    Value::Object(m)
}

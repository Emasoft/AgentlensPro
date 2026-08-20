//! Port of src/accountBurners.ts (TRDD-1XM0YSWQ, ported under TRDD-DMWOBWFH P4x.2d) —
//! `get_account_burners`: who exhausted a given OAuth account's rate-limit window.
//!
//! Rate limits are PER ACCOUNT (one keychain OAuth token active machine-wide at a time) and the
//! user rotates accounts when a window exhausts, so "who burned the PREVIOUS account's window"
//! needs per-account scoping × per-session ranking — which neither `investigate_burn` (no account
//! filter) nor `get_window_budget` (no per-session ranking) provides.
//!
//! Attribution is TIME-based, not card-based: a running session picks up a rotated token, so a
//! session alive across a rotation burns TWO accounts' windows. `ConsumptionEvent.accountUuid` is
//! one value per session and cannot express that — instead an event belongs to the target account
//! iff its ts falls inside one of the target's ACTIVE SEGMENTS intersected with the window.

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::burn::monitor::{W_CACHE_CREATE, W_CACHE_READ, W_INPUT, W_OUTPUT, W_UNKNOWN};
use crate::summarize::helpers::{fmt_js_num, iso_from_ms, js_to_fixed_str, num, parse_iso_ms};

#[derive(Clone, Debug, PartialEq)]
pub struct AccountSegment {
    pub account_id: String,
    pub email: Option<String>,
    pub plan: Option<String>,
    pub start_ms: f64,
    /// None = still the active account.
    pub end_ms: Option<f64>,
}

/// Collapse the timeline's change-records into contiguous per-account segments. A record whose
/// accountId is NULL (unresolved state) CLOSES the previous segment — consumption during an
/// unresolved stretch must not be attributed to the last known account.
pub fn segments_from_records(records: &[Value]) -> Vec<AccountSegment> {
    let mut sorted: Vec<&Value> = records.iter().collect();
    // STABLE, like Array.prototype.sort — equal timestamps keep input order.
    sorted.sort_by(|a, b| {
        let (x, y) = (a.get("ts").and_then(Value::as_f64).unwrap_or(0.0), b.get("ts").and_then(Value::as_f64).unwrap_or(0.0));
        x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut out: Vec<AccountSegment> = Vec::new();
    for r in sorted {
        let ts = r.get("ts").and_then(Value::as_f64).unwrap_or(0.0);
        let account_id = r.get("accountId").and_then(Value::as_str);
        let open_is_same = out.last().is_some_and(|s| s.end_ms.is_none() && Some(s.account_id.as_str()) == account_id);
        if open_is_same {
            continue; // same account re-recorded (plan/mode change)
        }
        if let Some(last) = out.last_mut() {
            if last.end_ms.is_none() {
                last.end_ms = Some(ts);
            }
        }
        if let Some(id) = account_id {
            out.push(AccountSegment {
                account_id: id.to_owned(),
                email: r.get("email").and_then(Value::as_str).map(str::to_owned),
                plan: r.get("plan").and_then(Value::as_str).map(str::to_owned),
                start_ms: ts,
                end_ms: None,
            });
        }
    }
    out
}

/// Read + parse the account-state NDJSON into segments. A torn line is skipped and an absent file
/// yields an empty list — callers turn that into an explicit "no timeline" error, never a crash.
pub fn read_account_segments(path: &std::path::Path) -> Vec<AccountSegment> {
    let Ok(raw) = std::fs::read_to_string(path) else { return Vec::new() };
    let records: Vec<Value> = raw
        .split('\n')
        .filter(|l| !l.trim().is_empty())
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        // `typeof r?.ts === 'number'` — a record with a missing or non-numeric ts is DROPPED, not
        // defaulted to 0, which would open a segment at the epoch.
        .filter(|r| r.get("ts").is_some_and(Value::is_number))
        .collect();
    segments_from_records(&records)
}

#[derive(Clone, Debug)]
pub struct ResolvedAccount {
    pub account_id: String,
    pub email: Option<String>,
    pub plan: Option<String>,
    /// Every segment of THIS account (it can have several stints inside a 7d window).
    pub segments: Vec<AccountSegment>,
    /// The last instant the account was active — the natural `until` for its exhausted window.
    pub last_active_ms: f64,
    pub is_current: bool,
}

/// Resolve the window END (`until`) from the interval selector:
///   `last`     → the account's last-active instant (its rotation-out moment; now if current) — the
///                window it most recently filled. DEFAULT.
///   `current`  → now (the ongoing window).
///   <ISO date> → that instant.
/// The error NAMES an unparseable date instead of silently using `now`.
pub fn resolve_window_until(interval: &str, target: &ResolvedAccount, now_ms: f64) -> (f64, Option<String>) {
    let s = interval.trim().to_lowercase();
    if s == "last" {
        return (target.last_active_ms, None);
    }
    if s == "current" || s == "now" {
        return (now_ms, None);
    }
    // `Date.parse(interval)` on the RAW argument — NOT the trimmed/lowercased `s`. An ISO string
    // with surrounding whitespace parses in JS, and lowercasing would not matter, but the raw value
    // is what the TS hands the parser and the port must not silently normalize first.
    match parse_iso_ms(interval).filter(|t| t.is_finite()) {
        Some(t) => (t, None),
        None => (
            target.last_active_ms,
            Some(format!("Unparseable interval '{interval}' — expected 'last', 'current', or an ISO-8601 date.")),
        ),
    }
}

/// Resolve `previous` / `current` / a uuid-prefix / an email against the segment timeline.
pub fn resolve_target_account(segments: &[AccountSegment], spec: &str, now_ms: f64) -> Option<ResolvedAccount> {
    if segments.is_empty() {
        return None;
    }
    let current = segments.last().filter(|s| s.end_ms.is_none());
    let s = spec.trim().to_lowercase();
    let account_id: Option<String> = if s == "current" {
        current.map(|c| c.account_id.clone())
    } else if s == "previous" {
        // The account of the segment immediately before the CURRENT account's last contiguous run
        // — i.e. the one the user rotated away from, even if the timeline re-recorded the current
        // account several times since.
        segments
            .iter()
            .rev()
            .find(|seg| current.is_none_or(|c| seg.account_id != c.account_id))
            .map(|seg| seg.account_id.clone())
    } else {
        segments
            .iter()
            .rev()
            .find(|seg| seg.account_id.to_lowercase().starts_with(&s) || seg.email.as_deref().unwrap_or("").to_lowercase() == s)
            .map(|seg| seg.account_id.clone())
    };
    let account_id = account_id?;
    let own: Vec<AccountSegment> = segments.iter().filter(|seg| seg.account_id == account_id).cloned().collect();
    let last = own.last()?;
    Some(ResolvedAccount {
        account_id,
        // `.filter(Boolean).pop()` — the LAST TRUTHY value, so an empty string is skipped, not
        // taken as "the newest email is blank".
        email: own.iter().filter_map(|seg| seg.email.as_deref()).rfind(|e| !e.is_empty()).map(str::to_owned),
        plan: own.iter().filter_map(|seg| seg.plan.as_deref()).rfind(|p| !p.is_empty()).map(str::to_owned),
        last_active_ms: last.end_ms.unwrap_or(now_ms),
        is_current: last.end_ms.is_none(),
        segments: own,
    })
}

/// The "Known: …" list an unmatched account spec is answered with — a bare "not found" would send
/// the caller hunting for a bug in the tool instead of fixing the argument.
///
/// `${s.email ?? '?'}` is NULLISH: an EMPTY email renders as "" (an account shown with empty
/// parens), NOT as "?". Only an absent/null one becomes the question mark, and the Set dedupes on
/// the rendered STRING, so the same account with two different emails appears twice — deliberately,
/// because that is what the timeline actually recorded.
pub fn known_accounts(segments: &[AccountSegment]) -> String {
    let mut seen: Vec<String> = Vec::new();
    for s in segments {
        let label = format!("{} ({})", s.account_id.chars().take(8).collect::<String>(), s.email.as_deref().unwrap_or("?"));
        if !seen.contains(&label) {
            seen.push(label);
        }
    }
    seen.join(", ")
}

fn f(e: &Value, k: &str) -> f64 {
    e.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}

fn in_segments(ts: f64, segments: &[AccountSegment], now_ms: f64) -> bool {
    segments.iter().any(|seg| ts >= seg.start_ms && ts < seg.end_ms.unwrap_or(now_ms))
}

/// THE attribution rule, exported so every window consumer shares ONE definition: an event burned
/// this account iff its ts is inside the requested window AND inside one of the account's active
/// segments (so a session alive across a rotation splits correctly). Used by the burners tables and
/// by `window_eta` alike — the rule must never drift between them.
pub fn events_for_account_in_window<'a>(
    events: &'a [Value],
    target: &ResolvedAccount,
    from_ms: f64,
    until_ms: f64,
    now_ms: f64,
) -> Vec<&'a Value> {
    events.iter().filter(|e| {
        let ts = f(e, "ts");
        ts >= from_ms && ts < until_ms && in_segments(ts, &target.segments, now_ms)
    }).collect()
}

/// Billable-weighted tokens for one event — the window-fill metric. Exported so `window_eta` shares
/// ONE definition (they must never drift).
pub fn weighted(e: &Value) -> f64 {
    let known = f(e, "inputTokens") + f(e, "outputTokens") + f(e, "cacheReadTokens") + f(e, "cacheCreateTokens");
    f(e, "inputTokens") * W_INPUT
        + f(e, "outputTokens") * W_OUTPUT
        + f(e, "cacheReadTokens") * W_CACHE_READ
        + f(e, "cacheCreateTokens") * W_CACHE_CREATE
        + (f(e, "tokens") - known).max(0.0) * W_UNKNOWN
}

/// Compact token count (12.3M / 4k / 1.2B). Exported so `window_eta` shares ONE definition.
///
/// NOTE the last branch divides by 1e3 unconditionally, so anything under a million renders in "k"
/// — 500 becomes "1k", not "500". That is the TS's own behaviour and the tables are aligned to it.
pub fn fmt_tok(n: f64) -> String {
    if n >= 1e9 {
        return format!("{}B", js_to_fixed_str(n / 1e9, 2));
    }
    if n >= 1e6 {
        return format!("{}M", js_to_fixed_str(n / 1e6, 1));
    }
    format!("{}k", js_to_fixed_str(n / 1e3, 0))
}

#[derive(Clone, Debug, Default)]
pub struct WindowCapacity {
    pub tokens: Option<f64>,
    pub cost_usd: Option<f64>,
    pub source: Option<&'static str>,
    pub proxy_account_id: Option<String>,
    pub observed_at: Option<String>,
}

impl WindowCapacity {
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("tokens".into(), self.tokens.map(num).unwrap_or(Value::Null));
        m.insert("costUsd".into(), self.cost_usd.map(num).unwrap_or(Value::Null));
        m.insert("source".into(), self.source.map(Value::from).unwrap_or(Value::Null));
        m.insert("proxyAccountId".into(), self.proxy_account_id.clone().map(Value::from).unwrap_or(Value::Null));
        m.insert("observedAt".into(), self.observed_at.clone().map(Value::from).unwrap_or(Value::Null));
        Value::Object(m)
    }
}

type Observed = IndexMap<String, crate::burn::monitor::ObservedAccountCapacity>;

fn pick(cap: &crate::burn::monitor::ObservedAccountCapacity, label: &str) -> (Option<f64>, Option<f64>) {
    if label == "5h" {
        (cap.window5h_tokens, cap.window5h_cost_usd)
    } else {
        (cap.window7d_tokens, cap.window7d_cost_usd)
    }
}

/// Capacity for a window fill%: the target's OWN observed calibration first; else the calibration of
/// a SAME-PLAN account as a LABELED proxy (Max 20x limits are per plan tier); else null — the fill
/// is left undetermined rather than invented.
pub fn resolve_window_capacity(observed: &Observed, target: &ResolvedAccount, all_segments: &[AccountSegment], label: &str) -> WindowCapacity {
    if let Some(own) = observed.get(&target.account_id) {
        let (tokens, cost_usd) = pick(own, label);
        if tokens.is_some() || cost_usd.is_some() {
            return WindowCapacity { tokens, cost_usd, source: Some("observed"), proxy_account_id: None, observed_at: own.observed_at.clone() };
        }
    }
    if let Some(plan) = target.plan.as_deref() {
        // last write wins = the account's LATEST plan
        let mut plan_of: IndexMap<&str, Option<&str>> = IndexMap::new();
        for seg in all_segments {
            plan_of.insert(seg.account_id.as_str(), seg.plan.as_deref());
        }
        let mut candidates: Vec<(&String, &crate::burn::monitor::ObservedAccountCapacity)> = observed
            .iter()
            .filter(|(acct, cap)| {
                let (t, c) = pick(cap, label);
                acct.as_str() != target.account_id && plan_of.get(acct.as_str()).copied().flatten() == Some(plan) && (t.is_some() || c.is_some())
            })
            .collect();
        // DETERMINISTIC: most recently calibrated, then the larger cap — so the answer never depends
        // on key insertion order when several accounts qualify. `Date.parse(x ?? '') || 0` makes an
        // absent or unparseable observedAt sort as 0, not NaN.
        candidates.sort_by(|(_, a), (_, b)| {
            let ts = |c: &crate::burn::monitor::ObservedAccountCapacity| c.observed_at.as_deref().and_then(parse_iso_ms).filter(|t| *t != 0.0).unwrap_or(0.0);
            let d = ts(b) - ts(a);
            if d != 0.0 && !d.is_nan() {
                return d.partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal);
            }
            let size = |c: &crate::burn::monitor::ObservedAccountCapacity| {
                let (t, u) = pick(c, label);
                u.or(t).unwrap_or(0.0)
            };
            (size(b) - size(a)).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal)
        });
        if let Some((acct, cap)) = candidates.first() {
            let (tokens, cost_usd) = pick(cap, label);
            return WindowCapacity {
                tokens,
                cost_usd,
                source: Some("same-plan-proxy"),
                proxy_account_id: Some((*acct).clone()),
                observed_at: cap.observed_at.clone(),
            };
        }
    }
    WindowCapacity::default()
}

struct Totals {
    events: f64,
    tokens: f64,
    cost_usd: f64,
    billable_weighted: f64,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_create: f64,
}

struct SessionRow {
    session_id: String,
    workspace: Option<String>,
    source: Option<String>,
    model: Option<String>,
    events: f64,
    tokens: f64,
    cost_usd: f64,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_create: f64,
    billable_weighted: f64,
    share_pct: f64,
    top_attribution: Option<String>,
    first_ms: f64,
    last_ms: f64,
    attr: IndexMap<String, f64>,
}

struct ProjectRow {
    workspace: Option<String>,
    sessions: f64,
    events: f64,
    tokens: f64,
    cost_usd: f64,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_create: f64,
    billable_weighted: f64,
    share_pct: f64,
    top_model: Option<String>,
    model_w: IndexMap<String, f64>,
}

struct Section {
    label: &'static str,
    window_hours: f64,
    from_ms: f64,
    until_ms: f64,
    totals: Totals,
    projects: Vec<ProjectRow>,
    burners: Vec<SessionRow>,
    total_projects: usize,
    total_burners: usize,
    capacity: WindowCapacity,
    fill_pct: Option<f64>,
}

/// `[...map.entries()].sort((a,b)=>b[1]-a[1])[0]?.[0]` — the heaviest key, ties keeping insertion
/// order under the stable sort.
fn heaviest(m: &IndexMap<String, f64>) -> Option<String> {
    let mut v: Vec<(&String, &f64)> = m.iter().collect();
    v.sort_by(|a, b| (b.1 - a.1).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
    v.first().map(|(k, _)| (*k).clone())
}

struct SectionOpts<'a> {
    events: &'a [Value],
    target: &'a ResolvedAccount,
    card_by: &'a IndexMap<String, &'a Value>,
    label: &'static str,
    window_hours: f64,
    until_ms: f64,
    now_ms: f64,
    limit: f64,
    capacity: WindowCapacity,
}

/// One window's full aggregation: session rows AND the cross-session project (workspace) rollup.
fn build_window_section(o: SectionOpts<'_>) -> Section {
    let from_ms = o.until_ms - o.window_hours * 3_600_000.0;
    let in_window = events_for_account_in_window(o.events, o.target, from_ms, o.until_ms, o.now_ms);

    let mut by_session: IndexMap<String, SessionRow> = IndexMap::new();
    let mut totals = Totals {
        events: 0.0,
        tokens: 0.0,
        cost_usd: 0.0,
        billable_weighted: 0.0,
        input: 0.0,
        output: 0.0,
        cache_read: 0.0,
        cache_create: 0.0,
    };
    for e in &in_window {
        let sid = e.get("sessionId").and_then(Value::as_str).unwrap_or("").to_owned();
        let card = o.card_by.get(&sid).copied();
        let r = by_session.entry(sid.clone()).or_insert_with(|| SessionRow {
            session_id: sid,
            // `e.workspace ?? card?.workspace ?? null` — the EVENT's own workspace wins.
            workspace: e
                .get("workspace")
                .and_then(Value::as_str)
                .or_else(|| card.and_then(|c| c.get("workspace").and_then(Value::as_str)))
                .map(str::to_owned),
            source: card.and_then(|c| c.get("source").and_then(Value::as_str)).map(str::to_owned),
            model: card.and_then(|c| c.get("model").and_then(Value::as_str)).map(str::to_owned),
            events: 0.0,
            tokens: 0.0,
            cost_usd: 0.0,
            input: 0.0,
            output: 0.0,
            cache_read: 0.0,
            cache_create: 0.0,
            billable_weighted: 0.0,
            share_pct: 0.0,
            top_attribution: None,
            first_ms: f(e, "ts"),
            last_ms: f(e, "ts"),
            attr: IndexMap::new(),
        });
        let w = weighted(e);
        r.events += 1.0;
        r.tokens += f(e, "tokens");
        r.cost_usd += f(e, "costUsd");
        r.billable_weighted += w;
        r.input += f(e, "inputTokens");
        r.output += f(e, "outputTokens");
        r.cache_read += f(e, "cacheReadTokens");
        r.cache_create += f(e, "cacheCreateTokens");
        let ts = f(e, "ts");
        if ts < r.first_ms {
            r.first_ms = ts;
        }
        if ts > r.last_ms {
            r.last_ms = ts;
        }
        // `if (e.attribution)` is TRUTHY — an empty attribution string is no attribution.
        if let Some(a) = e.get("attribution").and_then(Value::as_str).filter(|a| !a.is_empty()) {
            *r.attr.entry(a.to_owned()).or_insert(0.0) += w;
        }
        totals.events += 1.0;
        totals.tokens += f(e, "tokens");
        totals.cost_usd += f(e, "costUsd");
        totals.billable_weighted += w;
        totals.input += f(e, "inputTokens");
        totals.output += f(e, "outputTokens");
        totals.cache_read += f(e, "cacheReadTokens");
        totals.cache_create += f(e, "cacheCreateTokens");
    }

    let mut ranked_sessions: Vec<SessionRow> = by_session.into_values().collect();
    for r in &mut ranked_sessions {
        r.share_pct = if totals.billable_weighted > 0.0 { (r.billable_weighted / totals.billable_weighted) * 100.0 } else { 0.0 };
        r.top_attribution = heaviest(&r.attr);
    }
    ranked_sessions.sort_by(|a, b| (b.billable_weighted - a.billable_weighted).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));

    // The PROJECT rollup — the same window totals re-grouped by workspace, because "who is
    // responsible" outlives any one session: an agent restarted five times is still ONE project.
    let mut by_project: IndexMap<Option<String>, ProjectRow> = IndexMap::new();
    for s in &ranked_sessions {
        let p = by_project.entry(s.workspace.clone()).or_insert_with(|| ProjectRow {
            workspace: s.workspace.clone(),
            sessions: 0.0,
            events: 0.0,
            tokens: 0.0,
            cost_usd: 0.0,
            input: 0.0,
            output: 0.0,
            cache_read: 0.0,
            cache_create: 0.0,
            billable_weighted: 0.0,
            share_pct: 0.0,
            top_model: None,
            model_w: IndexMap::new(),
        });
        p.sessions += 1.0;
        p.events += s.events;
        p.tokens += s.tokens;
        p.cost_usd += s.cost_usd;
        p.input += s.input;
        p.output += s.output;
        p.cache_read += s.cache_read;
        p.cache_create += s.cache_create;
        p.billable_weighted += s.billable_weighted;
        if let Some(m) = s.model.as_deref().filter(|m| !m.is_empty()) {
            *p.model_w.entry(m.to_owned()).or_insert(0.0) += s.billable_weighted;
        }
    }
    let mut ranked_projects: Vec<ProjectRow> = by_project.into_values().collect();
    for p in &mut ranked_projects {
        p.share_pct = if totals.billable_weighted > 0.0 { (p.billable_weighted / totals.billable_weighted) * 100.0 } else { 0.0 };
        p.top_model = heaviest(&p.model_w);
    }
    ranked_projects.sort_by(|a, b| (b.billable_weighted - a.billable_weighted).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));

    // Fill% against the calibrated capacity — COST-based FIRST (Anthropic meters the windows by
    // cost, and raw-token fill is inflated by the ~96%-cache-read volume). This matches
    // get_window_eta, so the two tools' "how full is the window" never disagree. Token fill is the
    // fallback only when no cost cap is calibrated; else null — undetermined, never invented.
    let fill_pct = match (o.capacity.cost_usd, o.capacity.tokens) {
        (Some(c), _) if c > 0.0 => Some((totals.cost_usd / c) * 100.0),
        (_, Some(t)) if t > 0.0 => Some((totals.tokens / t) * 100.0),
        _ => None,
    };

    let cap = o.limit.max(1.0) as usize;
    let (total_projects, total_burners) = (ranked_projects.len(), ranked_sessions.len());
    ranked_projects.truncate(cap);
    ranked_sessions.truncate(cap);

    Section {
        label: o.label,
        window_hours: o.window_hours,
        from_ms,
        until_ms: o.until_ms,
        totals,
        projects: ranked_projects,
        burners: ranked_sessions,
        total_projects,
        total_burners,
        capacity: o.capacity,
        fill_pct,
    }
}

fn totals_value(t: &Totals) -> Value {
    let mut m = Map::new();
    m.insert("events".into(), num(t.events));
    m.insert("tokens".into(), num(t.tokens));
    m.insert("costUsd".into(), num(t.cost_usd));
    m.insert("billableWeighted".into(), num(t.billable_weighted));
    m.insert("input".into(), num(t.input));
    m.insert("output".into(), num(t.output));
    m.insert("cacheRead".into(), num(t.cache_read));
    m.insert("cacheCreate".into(), num(t.cache_create));
    Value::Object(m)
}

/// The rest-spread `const { attr: _attr, ...row } = r` keeps every REMAINING key in its literal
/// position and drops only `attr` — so the wire order is the declaration order minus that one key.
fn session_row_value(r: &SessionRow) -> Value {
    let opt = |x: &Option<String>| x.clone().map(Value::from).unwrap_or(Value::Null);
    let mut m = Map::new();
    m.insert("sessionId".into(), Value::String(r.session_id.clone()));
    m.insert("workspace".into(), opt(&r.workspace));
    m.insert("source".into(), opt(&r.source));
    m.insert("model".into(), opt(&r.model));
    m.insert("events".into(), num(r.events));
    m.insert("tokens".into(), num(r.tokens));
    m.insert("costUsd".into(), num(r.cost_usd));
    m.insert("input".into(), num(r.input));
    m.insert("output".into(), num(r.output));
    m.insert("cacheRead".into(), num(r.cache_read));
    m.insert("cacheCreate".into(), num(r.cache_create));
    m.insert("billableWeighted".into(), num(r.billable_weighted));
    m.insert("shareOfWindowPct".into(), num(r.share_pct));
    m.insert("topAttribution".into(), opt(&r.top_attribution));
    m.insert("firstMs".into(), num(r.first_ms));
    m.insert("lastMs".into(), num(r.last_ms));
    Value::Object(m)
}

fn project_row_value(p: &ProjectRow) -> Value {
    let opt = |x: &Option<String>| x.clone().map(Value::from).unwrap_or(Value::Null);
    let mut m = Map::new();
    m.insert("workspace".into(), opt(&p.workspace));
    m.insert("sessions".into(), num(p.sessions));
    m.insert("events".into(), num(p.events));
    m.insert("tokens".into(), num(p.tokens));
    m.insert("costUsd".into(), num(p.cost_usd));
    m.insert("input".into(), num(p.input));
    m.insert("output".into(), num(p.output));
    m.insert("cacheRead".into(), num(p.cache_read));
    m.insert("cacheCreate".into(), num(p.cache_create));
    m.insert("billableWeighted".into(), num(p.billable_weighted));
    m.insert("shareOfWindowPct".into(), num(p.share_pct));
    m.insert("topModel".into(), opt(&p.top_model));
    Value::Object(m)
}

fn section_value(s: &Section) -> Value {
    let mut w = Map::new();
    w.insert("fromIso".into(), Value::String(iso_from_ms(s.from_ms)));
    w.insert("untilIso".into(), Value::String(iso_from_ms(s.until_ms)));
    let mut m = Map::new();
    m.insert("label".into(), Value::String(s.label.to_owned()));
    m.insert("windowHours".into(), num(s.window_hours));
    m.insert("window".into(), Value::Object(w));
    m.insert("totals".into(), totals_value(&s.totals));
    m.insert("projects".into(), Value::Array(s.projects.iter().map(project_row_value).collect()));
    m.insert("burners".into(), Value::Array(s.burners.iter().map(session_row_value).collect()));
    m.insert("totalProjects".into(), num(s.total_projects as f64));
    m.insert("totalBurners".into(), num(s.total_burners as f64));
    m.insert("capacity".into(), s.capacity.to_value());
    m.insert("fillPct".into(), s.fill_pct.map(num).unwrap_or(Value::Null));
    Value::Object(m)
}

/// `String.prototype.padStart` — pads to a length in UTF-16 units. Every value padded here is
/// ASCII (formatted numbers), so char count and code-unit count coincide.
fn pad_start(s: &str, width: usize) -> String {
    let len = s.chars().count();
    if len >= width {
        return s.to_owned();
    }
    format!("{}{}", " ".repeat(width - len), s)
}

fn cap_src(s: &Section) -> String {
    match s.capacity.source {
        Some("same-plan-proxy") => {
            // `?.slice(0, 8)` on a possibly-absent id — undefined stringifies to "undefined".
            let id = s.capacity.proxy_account_id.as_deref().map_or("undefined".to_owned(), |p| p.chars().take(8).collect());
            format!("same-plan proxy {id}")
        }
        Some(other) => other.to_owned(),
        None => "none".to_owned(),
    }
}

fn project_table(section: &Section, home: &str) -> Vec<String> {
    let mut lines = vec!["  share   equiv     cost   cache-created  cache-read   raw     sess  model / project".to_owned()];
    for p in &section.projects {
        let ws = match p.workspace.as_deref() {
            None => "(unattributed)".to_owned(),
            // `home && p.workspace.startsWith(home)` — an EMPTY home is falsy, so it never turns
            // every absolute path into "~<path>".
            Some(w) if !home.is_empty() && w.starts_with(home) => format!("~{}", &w[home.len()..]),
            Some(w) => w.to_owned(),
        };
        lines.push(format!(
            "  {}%  {}  ${}  {}  {}  {}  {}  {}  {}",
            pad_start(&js_to_fixed_str(p.share_pct, 1), 5),
            pad_start(&fmt_tok(p.billable_weighted), 7),
            pad_start(&js_to_fixed_str(p.cost_usd, 2), 8),
            pad_start(&fmt_tok(p.cache_create), 12),
            pad_start(&fmt_tok(p.cache_read), 10),
            pad_start(&fmt_tok(p.tokens), 7),
            pad_start(&fmt_js_num(p.sessions), 4),
            p.top_model.as_deref().unwrap_or("?"),
            ws
        ));
    }
    lines
}

pub struct AccountBurnersOpts<'a> {
    pub events: &'a [Value],
    pub target: &'a ResolvedAccount,
    pub all_segments: &'a [AccountSegment],
    pub cards: &'a [Value],
    pub until_ms: f64,
    pub now_ms: f64,
    pub limit: f64,
    /// `loadBurnConfig().observed` — per-account calibrated capacities (may be empty).
    pub observed: &'a Observed,
    /// `process.env.HOME ?? ''`, injected so the rendered table is reproducible.
    pub home: &'a str,
}

pub fn build_account_burners_report(o: &AccountBurnersOpts<'_>) -> Value {
    let mut card_by: IndexMap<String, &Value> = IndexMap::new();
    for c in o.cards {
        // `new Map(cards.map(...))` — LAST duplicate wins.
        card_by.insert(c.get("sessionId").and_then(Value::as_str).unwrap_or("").to_owned(), c);
    }

    let five_hour = build_window_section(SectionOpts {
        events: o.events,
        target: o.target,
        card_by: &card_by,
        label: "5h",
        window_hours: 5.0,
        until_ms: o.until_ms,
        now_ms: o.now_ms,
        limit: o.limit,
        capacity: resolve_window_capacity(o.observed, o.target, o.all_segments, "5h"),
    });
    let seven_day = build_window_section(SectionOpts {
        events: o.events,
        target: o.target,
        card_by: &card_by,
        label: "7d",
        window_hours: 168.0,
        until_ms: o.until_ms,
        now_ms: o.now_ms,
        limit: o.limit,
        capacity: resolve_window_capacity(o.observed, o.target, o.all_segments, "7d"),
    });

    // Which window forced the rotation? The one nearer/over its calibrated capacity at `until`.
    // With no capacity for EITHER window the answer is UNDETERMINED — never guessed.
    let (f5, f7) = (five_hour.fill_pct, seven_day.fill_pct);
    let mut most_likely = "undetermined";
    let exhaustion_reason: String;
    if f5.is_none() && f7.is_none() {
        exhaustion_reason = "No calibrated capacity for this account or a same-plan account — cannot tell which window hit its limit. A future rate-limit hit auto-calibrates it.".to_owned();
    } else if f5.unwrap_or(-1.0) >= f7.unwrap_or(-1.0) {
        most_likely = "5h";
        exhaustion_reason = format!(
            "5h at {}% vs 7d at {} of capacity ({}) at the rotation moment.",
            js_to_fixed_str(f5.unwrap(), 0),
            f7.map_or("unknown".to_owned(), |v| format!("{}%", js_to_fixed_str(v, 0))),
            cap_src(&five_hour)
        );
    } else {
        most_likely = "7d";
        exhaustion_reason = format!(
            "7d at {}% vs 5h at {} of capacity ({}) at the rotation moment.",
            js_to_fixed_str(f7.unwrap(), 0),
            f5.map_or("unknown".to_owned(), |v| format!("{}%", js_to_fixed_str(v, 0))),
            cap_src(&seven_day)
        );
    }

    // Coverage is measured over ALL events, not the window-filtered or account-filtered subset —
    // the question is what the SOURCES retain, not what this account burned.
    let oldest = o.events.iter().map(|e| f(e, "ts")).fold(f64::INFINITY, f64::min);
    let has_oldest = !o.events.is_empty() && oldest.is_finite();
    let seven_day_from = o.until_ms - 168.0 * 3_600_000.0;
    let mut coverage = Map::new();
    coverage.insert("oldestEventIso".into(), if has_oldest { Value::String(iso_from_ms(oldest)) } else { Value::Null });
    coverage.insert("coversWindow".into(), Value::Bool(has_oldest && oldest <= seven_day_from));
    let covers_window = has_oldest && oldest <= seven_day_from;

    let top_of = |s: &Section| -> Vec<String> {
        s.projects
            .iter()
            .take(3)
            .map(|p| {
                let ws = p
                    .workspace
                    .as_deref()
                    .map_or("(unattributed)".to_owned(), |w| w.split('/').next_back().unwrap_or("").to_owned());
                format!("{} ({}%, ${})", ws, js_to_fixed_str(p.share_pct, 0), js_to_fixed_str(p.cost_usd, 0))
            })
            .collect()
    };
    let acct_name = o.target.email.clone().unwrap_or_else(|| o.target.account_id.clone());
    let verdict = if five_hour.total_burners == 0 && seven_day.total_burners == 0 {
        format!("No consumption events attribute to {acct_name} in either window — they may predate the event sources' retention (see coverage).")
    } else {
        let top5 = top_of(&five_hour).join("; ");
        let top7 = top_of(&seven_day).join("; ");
        format!(
            "Most likely exhausted: {} — {} Top 5h projects: {}. Top 7d projects: {}.",
            if most_likely == "undetermined" { "undetermined".to_owned() } else { format!("the {most_likely} window") },
            exhaustion_reason,
            if top5.is_empty() { "none" } else { &top5 },
            if top7.is_empty() { "none" } else { &top7 }
        )
    };

    let note = format!(
        "Attribution is TIME-based (the machine-wide account-state timeline decides which account each event burned), so sessions alive across a rotation split correctly between accounts. Projects group sessions by workspace. share/equiv rank by billable weight (input×1 + output×5 + cacheRead×0.1 + cacheCreate×1.25); cache columns are raw token counts.{}",
        if covers_window { "" } else { " ⚠ COVERAGE GAP: the oldest available event is younger than the 7d window start — 7d totals are a LOWER BOUND." }
    );

    let mut lines: Vec<String> = Vec::new();
    let acct = format!("{}{}", acct_name, if o.target.is_current { " (CURRENT)" } else { " (rotated out)" });
    for s in [&five_hour, &seven_day] {
        let mark = if most_likely == s.label { "  ◀ MOST LIKELY EXHAUSTED (forced the rotation)" } else { "" };
        let fill = match s.fill_pct {
            Some(v) => format!(" · fill {}% of {} capacity", js_to_fixed_str(v, 0), cap_src(s)),
            None => " · fill unknown (no capacity)".to_owned(),
        };
        lines.push(format!(
            "━━ {} window of {} ending {} · {} calls · {} equiv · ${}{}{}",
            s.label,
            acct,
            iso_from_ms(s.until_ms),
            fmt_js_num(s.totals.events),
            fmt_tok(s.totals.billable_weighted),
            js_to_fixed_str(s.totals.cost_usd, 2),
            fill,
            mark
        ));
        lines.extend(project_table(s, o.home));
    }
    lines.push(verdict.clone());
    if !covers_window {
        let oldest_iso = if has_oldest { iso_from_ms(oldest) } else { "none".to_owned() };
        lines.push(format!("⚠ coverage: oldest event {oldest_iso} is inside the 7d window — 7d is a lower bound."));
    }

    let mut account = Map::new();
    account.insert("accountId".into(), Value::String(o.target.account_id.clone()));
    account.insert("email".into(), o.target.email.clone().map(Value::from).unwrap_or(Value::Null));
    account.insert("plan".into(), o.target.plan.clone().map(Value::from).unwrap_or(Value::Null));
    account.insert("isCurrent".into(), Value::Bool(o.target.is_current));

    let mut m = Map::new();
    m.insert("account".into(), Value::Object(account));
    m.insert("untilIso".into(), Value::String(iso_from_ms(o.until_ms)));
    m.insert("fiveHour".into(), section_value(&five_hour));
    m.insert("sevenDay".into(), section_value(&seven_day));
    m.insert("mostLikelyExhausted".into(), Value::String(most_likely.to_owned()));
    m.insert("exhaustionReason".into(), Value::String(exhaustion_reason));
    m.insert("coverage".into(), Value::Object(coverage));
    m.insert("verdict".into(), Value::String(verdict));
    m.insert("note".into(), Value::String(note));
    m.insert("text".into(), Value::String(lines.join("\n")));
    Value::Object(m)
}

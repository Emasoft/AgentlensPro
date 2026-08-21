//! Port of `src/subscriptionUsage.ts` SLICE A of 2 (TRDD-DMWOBWFH P4x.2m) — the PURE half: the
//! response normalizer, the cache-record boundary, the staleness predicates, the cooldown
//! arithmetic and the renderer. SLICE B is `getSubscriptionUsage` itself (the network + keychain
//! orchestration), which needs an injected fetch seam.
//!
//! A `SubscriptionUsage` is carried as a `Value`, NOT a struct, and that is load-bearing:
//! `normalizeCacheRecord` and `fromCache` both SPREAD the record (`{...raw, …}`), so a cache file
//! written by a newer version keeps keys this code has never heard of, and every key keeps its
//! original POSITION when overwritten. A struct would silently drop the unknown ones on the next
//! write.

use std::collections::HashMap;
use std::path::Path;

use serde_json::{Map, Value};

use crate::summarize::helpers::{fmt_js_num, js_math_round, num, pad_end, pad_start, parse_iso_ms};

pub const USAGE_URL: &str = "https://api.anthropic.com/api/oauth/usage";
/// Resolves a TOKEN to the identity it authenticates as — the only trustworthy answer to "whose
/// numbers are these?", because the usage endpoint itself carries NO identity field of any kind and
/// answers purely to the presented credential.
pub const PROFILE_URL: &str = "https://api.anthropic.com/api/oauth/profile";
pub const USAGE_BETA: &str = "oauth-2025-04-20";

/// Never refetch inside this window.
pub const TTL_MS: f64 = 600_000.0;
/// First 429 when the server names no Retry-After…
const BACKOFF_BASE_MS: f64 = 600_000.0;
/// …doubling per CONSECUTIVE 429, capped at 2h.
const BACKOFF_CAP_MS: f64 = 7_200_000.0;

/// The token's own identity, from `/api/oauth/profile`.
#[derive(Default, Clone)]
pub struct TokenIdentity {
    pub email: Option<String>,
    pub account_uuid: Option<String>,
    pub tier: Option<String>,
}

fn finite(v: Option<&Value>) -> Option<f64> {
    v.and_then(Value::as_f64).filter(|f| f.is_finite())
}

/// A window's fill, whichever way the endpoint spelled it this time. Both are percentages (0-100).
/// `ccbroker` measured the pair against the live API; accepting only `utilization` read a real
/// number as "no window".
pub fn window_pct(w: Option<&Value>) -> Option<f64> {
    let w = w?;
    finite(w.get("utilization")).or_else(|| finite(w.get("used_percentage")))
}

/// `resets_at` in every shape the endpoint has produced, normalized to an ISO string.
///
/// MEASURED BY `ccbroker` AGAINST THE LIVE API: it may be a unix timestamp in SECONDS or in
/// MILLISECONDS, as a JSON number or as a numeric string, or an RFC3339 string. Accepting only the
/// string form turned a numeric epoch into `null` — and a null `resetsAt` silently disables the
/// already-reset check in `derive_stale`, so a window that had rolled would be served as current.
/// The 1e12 threshold is ccbroker's: below it the value cannot plausibly be milliseconds.
pub fn normalize_resets_at(raw: Option<&Value>) -> Option<String> {
    let n: f64 = match raw {
        Some(Value::Number(_)) => finite(raw)?,
        Some(Value::String(s)) => {
            let s = s.trim();
            if s.is_empty() {
                return None;
            }
            if s.chars().all(|c| c.is_ascii_digit()) || is_decimal_digits(s) {
                s.parse::<f64>().ok()?
            } else {
                // Already a date string — keep it VERBATIM, not re-serialized.
                return parse_iso_ms(s).map(|_| s.to_owned());
            }
        }
        _ => return None,
    };
    let ms = if n < 1e12 { n * 1000.0 } else { n };
    if !ms.is_finite() {
        return None;
    }
    Some(iso_from_ms_expanded(ms))
}

/// `Date.prototype.toISOString()`, INCLUDING the expanded-year form. ECMA-262 renders a year
/// outside `[0, 9999]` as a SIGNED SIX-digit field (`+033658-09-27T…`, `-000001-…`); the shared
/// `iso_from_ms` emits the bare year, which is right for every real timestamp and wrong here.
///
/// It is reachable from real input, which is why it is implemented rather than waved off: the
/// seconds-vs-milliseconds heuristic multiplies anything under 1e12 by 1000, so an endpoint that
/// ever sent a *milliseconds* value just below the threshold (999999999999 → year 33658) lands in
/// the expanded range. The fixture carries exactly that boundary value.
fn iso_from_ms_expanded(ms: f64) -> String {
    let base = crate::summarize::helpers::iso_from_ms(ms);
    let (neg, rest) = match base.strip_prefix('-') {
        Some(r) => (true, r),
        None => (false, base.as_str()),
    };
    let Some((year, tail)) = rest.split_once('-') else { return base };
    if !neg && year.len() == 4 {
        return base;
    }
    format!("{}{:0>6}-{tail}", if neg { '-' } else { '+' }, year)
}

/// `/^\d+(\.\d+)?$/` — a bare integer or one decimal point with digits on both sides.
fn is_decimal_digits(s: &str) -> bool {
    let mut parts = s.splitn(2, '.');
    let head = parts.next().unwrap_or("");
    if head.is_empty() || !head.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    match parts.next() {
        None => true,
        Some(tail) => !tail.is_empty() && tail.chars().all(|c| c.is_ascii_digit()),
    }
}

fn secs_until(iso: Option<&str>, now: f64) -> Option<f64> {
    let t = parse_iso_ms(iso?)?;
    Some(js_math_round((t - now) / 1000.0))
}

fn opt_str(v: Option<&Value>) -> Option<String> {
    v.and_then(Value::as_str).map(str::to_owned)
}

fn json_opt_string(v: Option<String>) -> Value {
    v.map_or(Value::Null, Value::String)
}

fn json_opt_num(v: Option<f64>) -> Value {
    v.map_or(Value::Null, num)
}

/// Normalize a raw usage payload into the wire record. Key order mirrors the TS literal.
#[allow(clippy::too_many_arguments)]
pub fn normalize(
    body: &Value,
    fetched_at: f64,
    reason: &str,
    now: f64,
    account_fp: Option<&str>,
    identity: Option<&TokenIdentity>,
    local_claimed_label: Option<&str>,
) -> Value {
    let empty: Vec<Value> = Vec::new();
    let limits: Vec<Value> = body
        .get("limits")
        .and_then(Value::as_array)
        .unwrap_or(&empty)
        .iter()
        .map(|l| {
            let resets_at = normalize_resets_at(l.get("resets_at"));
            let mut m = Map::new();
            m.insert("kind".into(), Value::String(opt_str(l.get("kind")).unwrap_or_else(|| "unknown".to_owned())));
            m.insert("group".into(), Value::String(opt_str(l.get("group")).unwrap_or_else(|| "unknown".to_owned())));
            // NOT `?? 0`. A percentage that could not be parsed is UNKNOWN, and rendering it as an
            // empty window is the worst substitution this module can make — every consumer reads 0
            // as "all the headroom in the world".
            m.insert("percent".into(), json_opt_num(finite(l.get("percent"))));
            m.insert(
                "severity".into(),
                Value::String(opt_str(l.get("severity")).unwrap_or_else(|| "normal".to_owned())),
            );
            m.insert("resetsAt".into(), json_opt_string(resets_at.clone()));
            m.insert("isActive".into(), Value::Bool(l.get("is_active") == Some(&Value::Bool(true))));
            m.insert(
                "scopeLabel".into(),
                json_opt_string(opt_str(l.pointer("/scope/model/display_name"))),
            );
            m.insert("resetsInSeconds".into(), json_opt_num(secs_until(resets_at.as_deref(), now)));
            Value::Object(m)
        })
        .collect();

    let age_seconds = js_math_round((now - fetched_at) / 1000.0).max(0.0);
    let email = identity.and_then(|i| i.email.clone());
    let mut m = Map::new();
    m.insert("fetchedAt".into(), num(fetched_at));
    m.insert("ageSeconds".into(), num(age_seconds));
    m.insert("stale".into(), Value::Bool(age_seconds * 1000.0 > TTL_MS * 3.0));
    m.insert("accountFp".into(), json_opt_string(account_fp.map(str::to_owned)));
    m.insert("accountUuid".into(), json_opt_string(identity.and_then(|i| i.account_uuid.clone())));
    m.insert("accountLabel".into(), json_opt_string(email.clone()));
    m.insert("accountTier".into(), json_opt_string(identity.and_then(|i| i.tier.clone())));
    m.insert("localClaimedLabel".into(), json_opt_string(local_claimed_label.map(str::to_owned)));
    // Only a real, OBSERVED disagreement — never asserted when either side is unknown, because "we
    // could not check" is not a mismatch.
    m.insert(
        "accountLabelSuspect".into(),
        Value::Bool(matches!((&email, local_claimed_label), (Some(e), Some(c)) if e != c)),
    );
    // A LIVE fetch is by construction the current account's — the endpoint answered the very token
    // presented. Unknown only when that token could not be fingerprinted.
    m.insert(
        "accountVerified".into(),
        Value::String(if account_fp.is_none() { "unknown".to_owned() } else { "yes".to_owned() }),
    );
    m.insert("reason".into(), Value::String(reason.to_owned()));
    m.insert("limits".into(), Value::Array(limits));
    m.insert("fiveHourPercent".into(), json_opt_num(window_pct(body.get("five_hour"))));
    m.insert("sevenDayPercent".into(), json_opt_num(window_pct(body.get("seven_day"))));
    m.insert(
        "usageCreditsEnabled".into(),
        match body.pointer("/extra_usage/is_enabled") {
            Some(Value::Bool(b)) => Value::Bool(*b),
            _ => Value::Null,
        },
    );
    m.insert("spendPercent".into(), json_opt_num(finite(body.pointer("/spend/percent"))));
    m.insert(
        "note".into(),
        Value::String(
            "Utilization is Anthropic's own figure for this account (the numbers /usage shows), not a local projection. Endpoint is undocumented and community-reverse-engineered.".to_owned(),
        ),
    );
    Value::Object(m)
}

/// NORMALIZE ABSENCE AT THE BOUNDARY. A cache file written before the identity fields existed has
/// no such key, and JSON has no `undefined` — so downstream comparisons written against `null`
/// would take the "fingerprints differ" branch and report a valid reading as ANOTHER ACCOUNT'S.
/// Absent and null must become the same thing exactly ONCE, here.
pub fn normalize_cache_record(raw: Option<&Value>) -> Option<Value> {
    // `typeof raw.fetchedAt !== 'number'` — the ONLY validity test the TS applies.
    let raw = raw.filter(|r| finite(r.get("fetchedAt")).is_some())?;
    let mut m = raw.as_object()?.clone();
    // `{...raw, k: v}` — an EXISTING key keeps its original position; an absent one appends here,
    // in the literal's order.
    for k in ["accountFp", "accountUuid", "accountLabel", "accountTier", "localClaimedLabel"] {
        let v = m.get(k).cloned().unwrap_or(Value::Null);
        m.insert(k.to_owned(), if v.is_null() { Value::Null } else { v });
    }
    let suspect = m.get("accountLabelSuspect") == Some(&Value::Bool(true));
    m.insert("accountLabelSuspect".into(), Value::Bool(suspect));
    let limits = match m.get("limits") {
        Some(Value::Array(a)) => Value::Array(a.clone()),
        _ => Value::Array(Vec::new()),
    };
    m.insert("limits".into(), limits);
    Some(Value::Object(m))
}

pub fn read_cache(cache_path: &Path) -> Option<Value> {
    let text = std::fs::read_to_string(cache_path).ok()?;
    let parsed: Value = serde_json::from_str(&text).ok()?;
    normalize_cache_record(Some(&parsed))
}

pub fn derive_stale(u: &Value, now: f64) -> bool {
    stale_reason(u, now).is_some()
}

/// WHICH of the two made it obsolete — because a consumer that reports the wrong one is worse than
/// one that reports none. A snapshot rejected for the SECOND reason once printed "NOT USABLE — the
/// cached reading is 0h old (fresh)": a stated cause that refutes itself. `derive_stale` delegates
/// here rather than repeating the predicates, so the boolean and the explanation can never disagree.
pub fn stale_reason(u: &Value, now: f64) -> Option<&'static str> {
    let fetched_at = finite(u.get("fetchedAt")).unwrap_or(0.0);
    if now - fetched_at > TTL_MS * 3.0 {
        return Some("too-old");
    }
    let empty: Vec<Value> = Vec::new();
    let rolled = u.get("limits").and_then(Value::as_array).unwrap_or(&empty).iter().any(|l| {
        l.get("resetsAt").and_then(Value::as_str).and_then(parse_iso_ms).is_some_and(|t| t <= now)
    });
    rolled.then_some("window-reset")
}

/// The ONLY way this module may serve a cached reading.
///
/// `ageSeconds` and `stale` are computed at WRITE time, so the values PERSISTED in the cache file
/// are permanently `0` and `false`. Spreading the cache verbatim hands the caller a six-day-old
/// snapshot that self-reports as "0s old, not stale", and every staleness guard downstream is keyed
/// on exactly that frozen `false` — which is how a 7d window was reported at 96% while the account
/// was really at 36%. Both fields, plus every countdown, are re-derived against `now` here.
pub fn from_cache(cached: &Value, reason: &str, now: f64, current_fp: Option<&str>) -> Value {
    let cached_fp = cached.get("accountFp").and_then(Value::as_str);
    // Unprovable is treated as unusable, not as a pass. Verification is on the CREDENTIAL, never on
    // `~/.claude.json`: the usage response carries no identity, so the answer is determined by
    // exactly one thing — the token presented.
    let verified = match (current_fp, cached_fp) {
        (None, _) | (_, None) => "unknown",
        (Some(a), Some(b)) => {
            if a == b {
                "yes"
            } else {
                "no"
            }
        }
    };
    let mut m = cached.as_object().cloned().unwrap_or_default();
    let fetched_at = finite(cached.get("fetchedAt")).unwrap_or(0.0);
    m.insert("ageSeconds".into(), num(js_math_round((now - fetched_at) / 1000.0).max(0.0)));
    // FRESHNESS ONLY. Attribution is a separate axis (`accountVerified`); conflating them called a
    // 13-second-old reading "NOT LIVE" merely because this process could not read the credential.
    m.insert("stale".into(), Value::Bool(derive_stale(cached, now)));
    m.insert("accountVerified".into(), Value::String(verified.to_owned()));
    let empty: Vec<Value> = Vec::new();
    let limits: Vec<Value> = cached
        .get("limits")
        .and_then(Value::as_array)
        .unwrap_or(&empty)
        .iter()
        .map(|l| {
            let mut lm = l.as_object().cloned().unwrap_or_default();
            lm.insert(
                "resetsInSeconds".into(),
                json_opt_num(secs_until(l.get("resetsAt").and_then(Value::as_str), now)),
            );
            Value::Object(lm)
        })
        .collect();
    m.insert("limits".into(), Value::Array(limits));
    m.insert("reason".into(), Value::String(reason.to_owned()));
    Value::Object(m)
}

// ─── cooldown ───────────────────────────────────────────────────────────────────
pub fn read_cooldown(cooldown_path: &Path) -> (f64, f64) {
    let Ok(text) = std::fs::read_to_string(cooldown_path) else { return (0.0, 0.0) };
    let Ok(o) = serde_json::from_str::<Value>(&text) else { return (0.0, 0.0) };
    (finite(o.get("until")).unwrap_or(0.0), finite(o.get("consecutive")).unwrap_or(0.0))
}

/// Arm the back-off. Honors the server's Retry-After when given; otherwise DOUBLES per CONSECUTIVE
/// 429, so a run of header-less 429s stretches the wait instead of re-arming the same fixed
/// interval forever.
pub fn arm_cooldown(retry_after_seconds: Option<f64>, now: f64, cooldown_path: &Path) -> f64 {
    let prev = read_cooldown(cooldown_path).1;
    let consecutive = prev + 1.0;
    let delay = match retry_after_seconds.filter(|s| *s > 0.0) {
        Some(s) => (s * 1000.0).max(60_000.0),
        None => (BACKOFF_BASE_MS * 2f64.powf(consecutive - 1.0)).min(BACKOFF_CAP_MS),
    };
    let _ = std::fs::write(
        cooldown_path,
        serde_json::to_string(&json_pair(now + delay, consecutive)).unwrap_or_default(),
    );
    delay
}

fn json_pair(until: f64, consecutive: f64) -> Value {
    let mut m = Map::new();
    m.insert("until".into(), num(until));
    m.insert("consecutive".into(), num(consecutive));
    Value::Object(m)
}

/// `Date.parse` — ISO 8601 **or** an RFC 7231 HTTP-date. The second form is not an edge case here:
/// `Retry-After` is SPECIFIED as either delta-seconds or an HTTP-date, so a server that sends the
/// date form (`Wed, 21 Aug 2026 06:01:30 GMT`) is behaving correctly, and an ISO-only parse reads
/// it as "no Retry-After" — silently discarding the one instruction the server gave us about when
/// to come back. The reset headers take the same fallback, since the TS calls `Date.parse` there
/// too.
fn js_date_parse(s: &str) -> Option<f64> {
    if let Some(ms) = parse_iso_ms(s) {
        return Some(ms);
    }
    chrono::DateTime::parse_from_rfc2822(s)
        .ok()
        .map(|d| d.timestamp_millis() as f64)
}

/// `Headers.get` is case-insensitive.
fn header<'a>(headers: &'a HashMap<String, String>, key: &str) -> Option<&'a str> {
    headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(key)).map(|(_, v)| v.as_str())
}

/// Retry-After (delta-seconds or HTTP-date), then Anthropic's own reset headers (epoch or ISO).
pub fn retry_after_seconds(headers: Option<&HashMap<String, String>>, now: f64) -> Option<f64> {
    let headers = headers?;
    if let Some(ra) = header(headers, "retry-after").map(str::trim).filter(|s| !s.is_empty()) {
        if !ra.is_empty() && ra.chars().all(|c| c.is_ascii_digit()) {
            return ra.parse::<f64>().ok();
        }
        if let Some(t) = js_date_parse(ra) {
            return Some(js_math_round((t - now) / 1000.0).max(0.0));
        }
    }
    for key in [
        "anthropic-ratelimit-unified-reset",
        "anthropic-ratelimit-unified-5h-reset",
        "anthropic-ratelimit-requests-reset",
        "anthropic-ratelimit-tokens-reset",
    ] {
        let Some(v) = header(headers, key).map(str::trim).filter(|s| !s.is_empty()) else { continue };
        if v.chars().all(|c| c.is_ascii_digit()) {
            if let Ok(n) = v.parse::<f64>() {
                let s = n - (now / 1000.0).floor();
                if s > 0.0 {
                    return Some(s);
                }
            }
            continue;
        }
        if let Some(t) = js_date_parse(v) {
            let s = js_math_round((t - now) / 1000.0);
            if s > 0.0 {
                return Some(s);
            }
        }
    }
    None
}

// ─── rendering ──────────────────────────────────────────────────────────────────
const BAR_CELLS: usize = 10;

/// A `cells`-segment bar. The percentage is deliberately NOT drawn inside it (it would occlude
/// segments) — render the number alongside.
pub fn usage_bar(percent: f64, cells: usize) -> String {
    let p = if percent.is_finite() { percent } else { 0.0 }.clamp(0.0, 100.0);
    let filled = js_math_round((p / 100.0) * cells as f64).clamp(0.0, cells as f64) as usize;
    format!("[{}{}]", "█".repeat(filled), "░".repeat(cells - filled))
}

/// Age as a human reads it. `Math.round(ageSeconds / 60)}m` rendered a six-day-old cache as
/// "8525m ago", which buries the one fact the warning exists to convey.
fn human_age(secs: f64) -> String {
    if secs < 90.0 {
        return format!("{}s", fmt_js_num(js_math_round(secs).max(0.0)));
    }
    let m = js_math_round(secs / 60.0);
    if m < 90.0 {
        return format!("{}m", fmt_js_num(m));
    }
    let h = (m / 60.0).floor();
    if h < 48.0 {
        return format!("{}h {}m", fmt_js_num(h), fmt_js_num(m % 60.0));
    }
    format!("{}d {}h", fmt_js_num((h / 24.0).floor()), fmt_js_num(h % 24.0))
}

fn human_reset(secs: Option<f64>) -> String {
    let Some(secs) = secs else { return String::new() };
    if secs <= 0.0 {
        return "now".to_owned();
    }
    let h = (secs / 3600.0).floor();
    let m = ((secs % 3600.0) / 60.0).floor();
    if h != 0.0 {
        format!("in {}h {}m", fmt_js_num(h), fmt_js_num(m))
    } else {
        format!("in {}m", fmt_js_num(m))
    }
}

/// Name the stronger reason when it applies: an EXPIRED window is not merely an old reading, it is
/// a reading of something that no longer exists.
///
/// ⚠ Reads the WALL CLOCK, not an injected `now` — faithfully, because the TS does
/// (`Date.parse(l.resetsAt) <= Date.now()` inline). Any fixture for the renderer must therefore put
/// its `resetsAt` values far enough from the run time that the answer cannot flip mid-suite.
fn rolled_note(u: &Value, now: f64) -> String {
    let empty: Vec<Value> = Vec::new();
    let limits = u.get("limits").and_then(Value::as_array).unwrap_or(&empty);
    let rolled = limits
        .iter()
        .filter(|l| l.get("resetsAt").and_then(Value::as_str).and_then(parse_iso_ms).is_some_and(|t| t <= now))
        .count();
    if rolled == 0 {
        return String::new();
    }
    let which = if rolled == limits.len() {
        "every window shown has".to_owned()
    } else {
        format!("{rolled} of the {} windows shown have", limits.len())
    };
    format!("; {which} ALREADY RESET since this was read")
}

pub fn format_subscription_usage(u: Option<&Value>, now: f64) -> String {
    let Some(u) = u else {
        return "subscription usage: unavailable (no token, opt-in required, or endpoint unreachable)".to_owned();
    };
    let stale = u.get("stale") == Some(&Value::Bool(true));
    let verified = u.get("accountVerified").and_then(Value::as_str).unwrap_or("");
    let suspect = u.get("accountLabelSuspect") == Some(&Value::Bool(true));
    // The label is the TOKEN's own identity, so it cannot disagree with the numbers.
    let base = u
        .get("accountLabel")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .or_else(|| u.get("accountUuid").and_then(Value::as_str).map(|s| crate::summarize::helpers::js_slice(s, 8).to_owned()))
        .unwrap_or_else(|| "unresolved account".to_owned());
    let who = if suspect {
        format!(
            "{base} ⚠ (the token's OWN account — ~/.claude.json claims {}, which is a DIFFERENT account)",
            u.get("localClaimedLabel").and_then(Value::as_str).unwrap_or("null")
        )
    } else {
        base
    };
    let mut lines: Vec<String> = vec![if stale {
        format!("Subscription window utilization — ⚠ STALE SNAPSHOT, NOT CURRENT [{who}]")
    } else if verified == "yes" {
        format!("Subscription window utilization for {who} (Anthropic's own numbers)")
    } else {
        format!("Subscription window utilization (Anthropic's own numbers) — account NOT verified [label: {who}]")
    }];
    let empty: Vec<Value> = Vec::new();
    for l in u.get("limits").and_then(Value::as_array).unwrap_or(&empty) {
        let scope = l.get("scopeLabel").and_then(Value::as_str).map_or(String::new(), |s| format!(" {s}"));
        // A countdown computed from a CACHED resets_at renders as live for a window that may
        // already have rolled — suppressed entirely while stale, not merely annotated.
        let reset = if stale {
            String::new()
        } else {
            format!("  resets {}", human_reset(finite(l.get("resetsInSeconds"))))
        };
        let pct_val = finite(l.get("percent"));
        // An unparseable percentage renders as `?`, not as an empty bar — a drawn-empty bar reads
        // as "nothing used" at a glance, the opposite of "we do not know".
        let bar = pct_val.map_or_else(|| "[unreadable]".to_owned(), |p| usage_bar(p, BAR_CELLS));
        let pct = pct_val.map_or_else(|| "  ?".to_owned(), |p| pad_start(&fmt_js_num(p), 3));
        let kind = format!("{}{scope}", l.get("kind").and_then(Value::as_str).unwrap_or(""));
        lines.push(format!(
            "  {} {bar} {pct}%  {}{reset}",
            pad_end(&kind, 22),
            l.get("severity").and_then(Value::as_str).unwrap_or("")
        ));
    }
    // `!== null` in the TS, so a non-boolean value would also print — but `normalize` only ever
    // writes a boolean or null here, and the cache boundary carries that through verbatim.
    if let Some(Value::Bool(b)) = u.get("usageCreditsEnabled") {
        lines.push(format!(
            "  usage credits: {}",
            if *b {
                "ENABLED — prompt-cache TTL drops to 5 min"
            } else {
                "disabled — 1-hour prompt-cache TTL active"
            }
        ));
    }
    // Name the account problem separately from the age problem: they call for different actions.
    let acct = match verified {
        "no" => " ⚠ ANOTHER ACCOUNT — the logged-in credential is not the one these were fetched with; do not read them as yours.",
        "unknown" => " ⚠ UNATTRIBUTED — could not read the current credential, so these cannot be confirmed to be THIS account's (set AGENTLENS_READ_KEYCHAIN_USAGE=1 to let this process check).",
        _ => "",
    };
    let age = finite(u.get("ageSeconds")).unwrap_or(0.0);
    let reason = u.get("reason").and_then(Value::as_str).unwrap_or("");
    if stale {
        lines.push(format!(
            "  ⚠ NOT LIVE — last good read {} ago ({reason}){}. Do not trust these values; run /usage in-app.{acct}",
            human_age(age),
            rolled_note(u, now)
        ));
    } else {
        lines.push(format!(
            "  [{} · cache {}s old · {reason}]{acct}",
            if verified == "yes" { "live · account verified" } else { "live" },
            fmt_js_num(age)
        ));
    }
    lines.join("\n")
}

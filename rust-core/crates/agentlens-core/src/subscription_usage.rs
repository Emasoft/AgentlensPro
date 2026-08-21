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
use std::path::{Path, PathBuf};

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

// ── SLICE B: credential loading + the fetch orchestration (TS 205-288, 621-703) ───
/// One HTTP response, reduced to what this module reads. The caller owns the transport: the TS
/// calls global `fetch` inline, so a faithful port with a testable oracle has to name the seam.
pub struct HttpResponse {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: String,
}

impl HttpResponse {
    /// `res.ok` — 2xx.
    fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }
}

#[derive(Default)]
pub struct LoadedToken {
    pub token: Option<String>,
    pub expires_at: Option<f64>,
    pub fp: Option<String>,
    pub reason: Option<&'static str>,
}

/// Identify the ACCOUNT a credential belongs to, without ever storing or logging the credential.
///
/// Prefer the REFRESH token: the access token rotates roughly hourly, so fingerprinting it would
/// invalidate the cache on every rotation. The refresh token is longer-lived but NOT permanent —
/// Anthropic rotates it server-side — so this fingerprint can change without an account switch.
/// That is the SAFE direction and the whole reason to key on it: a change yields a cache MISS and
/// one extra request, never another account's numbers under this account's name.
///
/// COROLLARY, and it is a landmine: this module must NEVER call the token-refresh endpoint with
/// Claude Code's credential. Reading the access token is inert; refreshing it would invalidate the
/// session the user is working in.
fn fingerprint(creds: &Value) -> Option<String> {
    let basis = creds
        .get("refreshToken")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .or_else(|| creds.get("accessToken").and_then(Value::as_str).filter(|s| !s.is_empty()))?;
    Some(agentlens_store::sections::sha256_hex(basis).chars().take(16).collect())
}

/// `raw.claudeAiOauth` when it is an object, else the record itself.
fn oauth_inner(raw: &Value) -> &Value {
    match raw.get("claudeAiOauth") {
        Some(v) if v.is_object() || v.is_array() => v,
        _ => raw,
    }
}

fn creds_to_loaded(inner: &Value) -> Option<LoadedToken> {
    let token = inner.get("accessToken").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    Some(LoadedToken {
        token: Some(token.to_owned()),
        expires_at: finite(inner.get("expiresAt")),
        fp: fingerprint(inner),
        reason: None,
    })
}

/// Read the OAuth credential. The FILE path first (absent on macOS by design), then — on darwin
/// only, and ONLY behind consent — the keychain.
///
/// `keychain_allowed` is `keychainReadAllowed(dataDirFrom(env), env)`, computed by the CALLER: that
/// consent module is not ported, and re-deriving the precedence here is exactly how the two drift.
/// `allow_keychain` is the same judgement made per CALL SITE — a command the user typed and is
/// watching can afford one macOS password prompt, a status line or a hook cannot.
pub fn load_token(
    config_dir: Option<&Path>,
    home: &Path,
    allow_keychain: bool,
    keychain_allowed: bool,
    is_darwin: bool,
) -> LoadedToken {
    let base = config_dir.map_or_else(|| home.join(".claude"), Path::to_path_buf);
    if let Ok(text) = std::fs::read_to_string(base.join(".credentials.json")) {
        if let Ok(raw) = serde_json::from_str::<Value>(&text) {
            if let Some(loaded) = creds_to_loaded(oauth_inner(&raw)) {
                return loaded;
            }
        }
    }
    if !is_darwin {
        return LoadedToken { reason: Some("no_token"), ..LoadedToken::default() };
    }
    if !keychain_allowed && !allow_keychain {
        return LoadedToken { reason: Some("opt_in_required"), ..LoadedToken::default() };
    }
    let out = std::process::Command::new("security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .stderr(std::process::Stdio::null())
        .output();
    if let Ok(out) = out {
        if let Ok(raw) = serde_json::from_slice::<Value>(&out.stdout) {
            // The keychain branch takes ONLY the nested shape — a bare record is not accepted here,
            // matching the TS (`: {}` rather than `: raw`).
            let inner = match raw.get("claudeAiOauth") {
                Some(v) if v.is_object() || v.is_array() => v.clone(),
                _ => Value::Object(Map::new()),
            };
            if let Some(loaded) = creds_to_loaded(&inner) {
                return loaded;
            }
        }
    }
    LoadedToken { reason: Some("no_token"), ..LoadedToken::default() }
}

/// Parse `/api/oauth/profile`. Fail-soft: a null identity is reported as "unresolved" and is NEVER
/// quietly replaced by the config file's claim — that substitution is the entire bug this module
/// exists to prevent, the one that printed one account's utilization under another's name.
pub fn parse_token_identity(res: &HttpResponse) -> Option<TokenIdentity> {
    if !res.ok() {
        return None;
    }
    let j: Value = serde_json::from_str(&res.body).ok()?;
    let s = |v: Option<&Value>| v.and_then(Value::as_str).filter(|x| !x.is_empty()).map(str::to_owned);
    Some(TokenIdentity {
        email: s(j.pointer("/account/email")).or_else(|| s(j.pointer("/account/full_name"))),
        account_uuid: s(j.pointer("/account/uuid")),
        tier: s(j.pointer("/organization/rate_limit_tier")),
    })
}

/// A uuid comes from the NETWORK and becomes a path segment. Anything outside hex-and-dashes is
/// REFUSED rather than sanitized: a value that is not a uuid is not an identity we can file under,
/// and "clean it up and use it anyway" is how `../` becomes a filename.
fn is_uuid_shape(s: &str) -> bool {
    let groups = [8, 4, 4, 4, 12];
    let parts: Vec<&str> = s.split('-').collect();
    parts.len() == groups.len()
        && parts.iter().zip(groups).all(|(p, n)| p.len() == n && p.chars().all(|c| c.is_ascii_hexdigit()))
}

/// File a reading under its own account. No-op when the account could not be identified: an
/// unattributed row cannot answer "whose numbers are these", and inventing a key for it would put
/// one account's figures under a name that means nothing.
pub fn archive_account_usage(u: Option<&Value>, account_usage_dir: &Path) {
    let Some(u) = u else { return };
    let Some(uuid) = u.get("accountUuid").and_then(Value::as_str).filter(|s| !s.is_empty()) else { return };
    if !is_uuid_shape(uuid) {
        return;
    }
    if std::fs::create_dir_all(account_usage_dir).is_err() {
        return;
    }
    // Write-then-rename: a reader can hit this file at any moment, and a half-written JSON parses
    // as nothing at all — which would read as "this account was never observed", the one answer
    // that must never be fabricated.
    let dest = account_usage_dir.join(format!("{uuid}.json"));
    let tmp = account_usage_dir.join(format!("{uuid}.json.tmp-{}", std::process::id()));
    if std::fs::write(&tmp, serde_json::to_string(u).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, &dest);
    }
}

/// Where each on-disk artifact lives. Passed in rather than derived from a global so a test can
/// point the whole read/write path at a fixture.
pub struct UsagePaths {
    pub cache: PathBuf,
    pub cooldown: PathBuf,
    pub lock: PathBuf,
    pub account_dir: PathBuf,
}

impl UsagePaths {
    pub fn under(data_dir: &Path) -> Self {
        Self {
            cache: data_dir.join("subscription-usage.json"),
            cooldown: data_dir.join("subscription-usage-cooldown.json"),
            lock: data_dir.join("subscription-usage.lock"),
            account_dir: data_dir.join("subscription-usage"),
        }
    }
}

const HTTP_TIMEOUT_MS: f64 = 8_000.0;

/// Fetch (or serve cache) the subscription window utilization. Never fails.
///
/// THE ORDER IS THE CONTRACT. `load_token` runs BEFORE any cached reading is trusted: serving a
/// within-TTL cache without knowing whose token is loaded is precisely how an account switch goes
/// invisible — the numbers stay put and simply describe the wrong account.
pub fn get_subscription_usage(
    paths: &UsagePaths,
    loaded: &LoadedToken,
    now: f64,
    force: bool,
    claimed_label: Option<&str>,
    fetch_usage: &dyn Fn(&str) -> Result<HttpResponse, String>,
    fetch_identity: &dyn Fn(&str) -> Option<TokenIdentity>,
) -> Option<Value> {
    let cached = read_cache(&paths.cache);
    let current_fp = loaded.fp.as_deref();
    let serve = |c: Option<&Value>, r: &str| -> Option<Value> { c.map(|c| from_cache(c, r, now, current_fp)) };
    let is_fresh = |c: &Value| {
        !force
            && now - finite(c.get("fetchedAt")).unwrap_or(0.0) < TTL_MS
            && c.get("accountFp").and_then(Value::as_str) == current_fp
            && current_fp.is_some()
    };

    if let Some(c) = cached.as_ref().filter(|c| is_fresh(c)) {
        return serve(Some(c), "fresh");
    }
    if read_cooldown(&paths.cooldown).0 > now {
        return serve(cached.as_ref(), "cooldown");
    }
    let Some(token) = loaded.token.as_deref() else {
        return serve(cached.as_ref(), loaded.reason.unwrap_or("no_token"));
    };
    // Expired or about to expire: do not spend a request on a token Claude Code is about to rotate.
    if loaded.expires_at.is_some_and(|e| e < now + 30_000.0) {
        return serve(cached.as_ref(), "expiring_token");
    }

    // Cross-process guard. Two callers can both clear the cooldown check above before either fires;
    // without this they double-hit the endpoint and, reading the same consecutive-429 count, fail
    // to escalate the back-off. `create_new` is the atomic create-or-fail primitive; a stale lock
    // older than twice the HTTP timeout is reclaimed so a crashed holder cannot wedge this forever.
    let mut held = std::fs::OpenOptions::new().write(true).create_new(true).open(&paths.lock).is_ok();
    if held {
        let _ = std::fs::write(&paths.lock, std::process::id().to_string());
    } else {
        let age = std::fs::metadata(&paths.lock)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| now - d.as_millis() as f64);
        if age.is_some_and(|a| a > HTTP_TIMEOUT_MS * 2.0) && std::fs::write(&paths.lock, std::process::id().to_string()).is_ok() {
            held = true;
        }
        if !held {
            return serve(cached.as_ref(), "lock_contended");
        }
    }

    let out = (|| {
        // Re-check under the lock: whoever won it may have just refreshed or armed a cooldown.
        let again = read_cache(&paths.cache);
        if let Some(c) = again.as_ref().filter(|c| is_fresh(c)) {
            return serve(Some(c), "fresh");
        }
        if read_cooldown(&paths.cooldown).0 > now {
            return serve(again.as_ref(), "cooldown");
        }
        let Ok(res) = fetch_usage(token) else {
            return serve(cached.as_ref(), "http_error");
        };
        if res.status == 429 {
            arm_cooldown(retry_after_seconds(Some(&res.headers), now), now, &paths.cooldown);
            return serve(cached.as_ref(), "429");
        }
        if !res.ok() {
            return serve(cached.as_ref(), "http_error");
        }
        let Ok(body) = serde_json::from_str::<Value>(&res.body) else {
            return serve(cached.as_ref(), "http_error");
        };
        // Resolve WHOSE numbers these are from the SAME credential that just produced them. One
        // extra request, cached with the reading, and it is the difference between a labelled
        // figure and a misattributed one.
        let identity = fetch_identity(token);
        let usage = normalize(&body, now, "ok", now, current_fp, identity.as_ref(), claimed_label);
        let _ = std::fs::write(&paths.cache, serde_json::to_string(&usage).unwrap_or_default());
        // The SAME reading, also filed under its own account. This is the ONLY moment it can be
        // kept: the next fetch overwrites the line above, and a reading not archived here is gone.
        archive_account_usage(Some(&usage), &paths.account_dir);
        let _ = std::fs::remove_file(&paths.cooldown);
        Some(usage)
    })();
    if held {
        let _ = std::fs::remove_file(&paths.lock);
    }
    out
}

// ── The live transport (TS `userAgent` + the two inline `fetch` calls) ────────────
const DEFAULT_UA: &str = "claude-code/2.1.220";
static UA: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// `userAgent()` — the installed Claude Code version. Memoized because it costs a subprocess, and
/// a failure to find `claude` is not an error: the pinned fallback is still a valid claude-code UA,
/// which is all this endpoint looks at.
pub fn user_agent() -> &'static str {
    UA.get_or_init(|| {
        let out = std::process::Command::new("claude")
            .arg("--version")
            .stderr(std::process::Stdio::null())
            .output();
        let ver = out.ok().and_then(|o| {
            let text = String::from_utf8_lossy(&o.stdout).into_owned();
            regex::Regex::new(r"(\d+\.\d+\.\d+)").ok()?.captures(&text)?.get(1).map(|m| m.as_str().to_owned())
        });
        ver.map_or_else(|| DEFAULT_UA.to_owned(), |v| format!("claude-code/{v}"))
    })
}

/// One authenticated GET. `http_status_as_error(false)` is load-bearing: the 429 branch needs the
/// RESPONSE (its `Retry-After` header sets the back-off), and a client that turns 4xx into an error
/// type would collapse every rate-limit into the generic transport failure — the one shape that
/// does NOT arm a cooldown, so the next call would hit the endpoint again immediately.
fn http_get(url: &str, token: &str) -> Result<HttpResponse, String> {
    let agent: ureq::Agent = ureq::Agent::config_builder()
        .http_status_as_error(false)
        .timeout_global(Some(std::time::Duration::from_millis(HTTP_TIMEOUT_MS as u64)))
        .build()
        .into();
    let mut res = agent
        .get(url)
        .header("Authorization", format!("Bearer {token}"))
        .header("anthropic-beta", USAGE_BETA)
        .header("User-Agent", user_agent())
        .header("Accept", "application/json")
        .call()
        .map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    let headers = res
        .headers()
        .iter()
        .map(|(k, v)| (k.as_str().to_owned(), v.to_str().unwrap_or_default().to_owned()))
        .collect();
    let body = res.body_mut().read_to_string().unwrap_or_default();
    Ok(HttpResponse { status, headers, body })
}

/// `keychainReadAllowed` (src/keychainConsent.ts) — env > `<data-dir>/config.json` > OFF.
///
/// The persisted layer is the point: consent used to live ONLY in the environment, so any restart
/// that did not carry the variable (a deploy, a hook-triggered server start, a launchd revival)
/// silently dropped it and the refresh began answering `opt_in_required` — nothing errored, the
/// numbers just quietly went stale. A typo must never read as consent, so an unrecognized value is
/// "unset" and falls through rather than being coerced.
pub fn keychain_read_allowed(data_dir: &Path, vars: &HashMap<String, String>) -> bool {
    if let Some(v) = parse_consent(vars.get("AGENTLENS_READ_KEYCHAIN_USAGE").map(String::as_str)) {
        return v;
    }
    std::fs::read_to_string(data_dir.join("config.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|o| o.pointer("/usage/readKeychainUsage").and_then(Value::as_bool))
        .unwrap_or(false)
}

fn parse_consent(raw: Option<&str>) -> Option<bool> {
    match raw?.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "on" | "yes" => Some(true),
        "0" | "false" | "off" | "no" => Some(false),
        _ => None,
    }
}

pub fn live_fetch_usage(token: &str) -> Result<HttpResponse, String> {
    http_get(USAGE_URL, token)
}

/// Fail-soft by construction: a transport failure and a non-2xx both yield `None`, which is
/// reported as an unresolved identity rather than being back-filled from the local config.
pub fn live_fetch_identity(token: &str) -> Option<TokenIdentity> {
    parse_token_identity(&http_get(PROFILE_URL, token).ok()?)
}

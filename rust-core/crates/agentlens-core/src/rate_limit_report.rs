//! Port of src/rateLimitReport.ts (TRDD-DMWOBWFH P4x.2g) — rate-limit forensics: "what rate limits
//! did I hit, EXACTLY how many tokens filled the window, and what behavior caused it?"
//!
//! Sources: StopFailure lifecycle hook events are the ground truth for WHEN a rate limit killed a
//! turn (exact timestamps + session/cwd/error verbatim — the transcripts do not record these). The
//! exact token accounting + culprit heuristics come from investigate_burn scanned over the 5h
//! window ENDING at the stall, so "the combined requests that triggered the limit" is MEASURED
//! from response bodies, never estimated.
//!
//! ⚠ THE TRAP, and it must NOT be "fixed": `top_findings` reads `code`, `summary` and `detail` off
//! each finding — and a BurnFinding has NONE of those fields (its keys are cause/verdict/evidence/
//! confidence/…). So the label is ALWAYS empty and every entry falls through to a 160-char JSON
//! dump of the whole finding. That is the observable wire behaviour today; rewriting it to use
//! `cause`/`verdict` would read better and diverge from the TS. Pinned by a parity assertion.

use serde_json::{json, Map, Value};

use crate::hook_events::{read_hook_events, HookEventFilter};
use crate::summarize::helpers::{iso_from_ms, js_slice, num};

/// Group StopFailure events into stall EPISODES: events ≤`gap_ms` apart are ONE episode, because
/// one rate-limit incident kills many turns across sessions as they each retry into the wall.
pub fn group_stall_episodes(events: &[Value], gap_ms: f64) -> Vec<Value> {
    let mut asc: Vec<&Value> = events.iter().collect();
    asc.sort_by(|a, b| ts_of(a).total_cmp(&ts_of(b)));
    let mut episodes: Vec<Value> = Vec::new();
    let mut cur: Option<(f64, f64, Vec<&Value>)> = None;
    for e in asc {
        match cur.as_mut() {
            Some((_, end, recs)) if ts_of(e) - *end <= gap_ms => {
                *end = ts_of(e);
                recs.push(e);
            }
            _ => {
                if let Some(c) = cur.take() {
                    episodes.push(finish_episode(&c));
                }
                cur = Some((ts_of(e), ts_of(e), vec![e]));
            }
        }
    }
    if let Some(c) = cur {
        episodes.push(finish_episode(&c));
    }
    episodes
}

fn ts_of(e: &Value) -> f64 {
    e.get("ts").and_then(Value::as_f64).unwrap_or(0.0)
}

fn finish_episode(c: &(f64, f64, Vec<&Value>)) -> Value {
    let (start, end, recs) = c;
    // FIRST record per session wins — a session that died repeatedly in one episode is listed once,
    // with its earliest error, not its latest.
    let mut by_session: Vec<(String, Value)> = Vec::new();
    for r in recs {
        let sid = r.get("session").and_then(Value::as_str).unwrap_or("?").to_owned();
        if by_session.iter().any(|(k, _)| *k == sid) {
            continue;
        }
        let payload = r.get("payload");
        let cwd = payload.and_then(|p| p.get("cwd")).and_then(Value::as_str);
        // `.slice(0, 200)` is UTF-16, and an error message is exactly the kind of string that
        // carries non-ASCII (a path, a quoted prompt).
        let err = payload.and_then(|p| p.get("error")).and_then(Value::as_str).map(|s| js_slice(s, 200));
        by_session.push((
            sid,
            json!({
                "session": r.get("session").and_then(Value::as_str),
                "cwd": cwd,
                "error": err,
            }),
        ));
    }
    json!({
        "startIso": iso_from_ms(*start),
        "endIso": iso_from_ms(*end),
        "events": num(recs.len() as f64),
        "sessions": by_session.into_iter().map(|(_, v)| v).collect::<Vec<_>>(),
    })
}

/// `[r.code, r.summary ?? r.detail].filter(v => typeof v === 'string').join(': ')`, then fall back
/// to a 160-char JSON dump. See the module header: a BurnFinding has none of those three keys, so
/// in practice this ALWAYS returns the dump — that is the shipped behaviour, not a bug to fix here.
/// The `??` is nullish, so a non-null non-string `summary` suppresses `detail` AND fails the string
/// filter, contributing nothing.
fn top_finding_label(f: &Value) -> String {
    let mut parts: Vec<&str> = Vec::new();
    if let Some(s) = f.get("code").and_then(Value::as_str) {
        parts.push(s);
    }
    let second = match f.get("summary") {
        Some(v) if !v.is_null() => Some(v),
        _ => f.get("detail"),
    };
    if let Some(s) = second.and_then(Value::as_str) {
        parts.push(s);
    }
    let label = parts.join(": ");
    // `JSON.stringify(r).slice(0, 160)` — UTF-16, and a finding's verdict carries '→' and '≤'.
    if label.is_empty() { js_slice(&f.to_string(), 160).to_owned() } else { label }
}

#[derive(Default)]
pub struct RateLimitReportOptions {
    pub window_hours: Option<f64>,
    pub max_episodes: Option<f64>,
    /// Body-scan cap for the deep attribution (forwarded to investigate_burn).
    pub max_files: Option<f64>,
}

/// buildRateLimitReport. `investigate` is the TS's test seam, kept as a parameter so the oracle can
/// stub the scan: it receives (windowHours, untilMs, maxFiles) and returns the investigation, or an
/// Err whose message reaches the report's `attributed.error` — the TS catch branch.
pub fn build_rate_limit_report(
    hook_events_dir: &std::path::Path,
    opts: &RateLimitReportOptions,
    now_ms: f64,
    investigate: &dyn Fn(f64, f64, f64) -> Result<Value, String>,
) -> Value {
    // `clamp` over `.min().max()`: it propagates NaN like Math.max(1, Math.min(336, NaN)) does.
    let hours = opts.window_hours.unwrap_or(24.0).clamp(1.0, 24.0 * 14.0);
    let max_episodes = opts.max_episodes.unwrap_or(5.0).clamp(1.0, 20.0) as usize;
    let since_ms = now_ms - hours * 3_600e3;
    let window = json!({
        "sinceIso": iso_from_ms(since_ms), "untilIso": iso_from_ms(now_ms), "hours": num(hours),
    });

    let events = read_hook_events(
        hook_events_dir,
        &HookEventFilter {
            ev: Some("StopFailure"),
            since_ms: Some(since_ms as i64),
            until_ms: Some(now_ms as i64),
            limit: Some(1000),
            ..Default::default()
        },
    );
    if events.is_empty() {
        // An empty result is NOT proof no stall happened — it is equally "hook capture was never
        // installed", and the note has to say so or the report reads as an all-clear.
        return json!({
            "window": window,
            "stallEvents": num(0.0),
            "episodes": [],
            "note": "no StopFailure (rate-limit/API turn-death) hook events in the window — either no stall happened, or lifecycle hook capture is not installed (agentlenspro-cli --install-hooks; needs a session restart).",
        });
    }

    let all = group_stall_episodes(&events, 600_000.0);
    // `.slice(-maxEpisodes).reverse()` — the newest N, newest first.
    let episodes: Vec<Value> = all.iter().skip(all.len().saturating_sub(max_episodes)).rev().cloned().collect();
    let latest = episodes[0].clone();
    let latest_start = latest["startIso"].as_str().unwrap_or("").to_owned();

    // Deep-attribute the MOST RECENT episode only: the scan reads real bodies (bounded), and one
    // attribution answers the common question. Cost honesty > completeness here.
    let until = crate::summarize::helpers::parse_iso_ms(&latest_start).unwrap_or(f64::NAN);
    let attributed = match investigate(5.0, until, opts.max_files.unwrap_or(400.0)) {
        Err(e) => json!({ "episodeStartIso": latest_start, "error": format!("attribution scan failed: {e}") }),
        Ok(inv) => {
            // Hoist the essentials to FLAT fields: the lean shaper prunes deep nested objects from
            // the default view, and a rate-limit report without its verdict is useless.
            let totals = inv.get("totals").cloned().unwrap_or(Value::Null);
            let findings = inv.get("findings").and_then(Value::as_array).cloned().unwrap_or_default();
            json!({
                "episodeStartIso": latest_start,
                "meaning": "the 5h rate-limit window ENDING at this stall — exact billed usage (from response bodies) that filled the window, attributed by workspace/model, with ranked culprit findings and a verdict.",
                "verdict": inv.get("verdict").filter(|v| v.is_string()).cloned().unwrap_or(Value::Null),
                "windowEstCostUsd": totals.get("estCostUsd").filter(|v| v.is_number()).cloned().unwrap_or(Value::Null),
                // See the module header: `code`/`summary`/`detail` do not exist on a finding, so
                // the label is always empty and this is always a JSON dump. Do NOT "improve" it.
                "topFindings": findings.iter().take(4).map(|f| Value::String(top_finding_label(f))).collect::<Vec<_>>(),
                "investigation": inv,
            })
        }
    };

    let mut out = Map::new();
    out.insert("window".into(), window);
    out.insert("stallEvents".into(), num(events.len() as f64));
    out.insert("episodesTotal".into(), num(all.len() as f64));
    out.insert("episodes".into(), Value::Array(episodes));
    out.insert("attributed".into(), attributed);
    out.insert("note".into(), json!("episodes = StopFailure events grouped by ≤10min gaps (one incident kills many turns as sessions retry into the wall). Only the newest episode is deep-attributed (bounded body scan); for an older one run investigate_burn with untilIso set to that episode's startIso."));
    Value::Object(out)
}

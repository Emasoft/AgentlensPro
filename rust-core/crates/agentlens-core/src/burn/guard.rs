//! Port of src/burnGuard.ts (TRDD-W6UH8LPA) — check_burn_risk: realtime early warning against
//! token explosions, fusing the three feeds the server already receives:
//!   1. lifecycle hook events (SubagentStart bursts / StopFailure / PreCompact),
//!   2. the raw OTEL bodies dir (fat requests in flight, exact response usage → CACHE_THRASH),
//!   3. the live burn monitor's 4s tick (tokens/min across accounts).
//!
//! Each source can be absent — the report SAYS so instead of silently returning "no risk".

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

use super::bodies_activity::fmt_fat_senders;
use super::causing_tool_call::{causing_tool_calls, composition, CausingCallsOptions};
use crate::summarize::helpers::{fmt_js_num, iso_from_ms, js_math_round, js_slice, js_to_fixed_num, num};

/// fmtStartOrigins — WHO spawned, from SubagentStart payloads: top-`cap` spawning sessions with
/// their dir + agent types (culprit naming for FANOUT_BURST).
fn fmt_start_origins(starts: &[Value], cap: usize) -> String {
    /// (cwd, agent types in insertion order, count) per spawning session.
    type Origin = (Option<String>, indexmap::IndexMap<String, f64>, f64);
    let mut by: indexmap::IndexMap<String, Origin> = indexmap::IndexMap::new();
    for s in starts {
        let sid = s.get("session").and_then(Value::as_str).unwrap_or("?").to_owned();
        let e = by.entry(sid).or_insert((None, indexmap::IndexMap::new(), 0.0));
        e.2 += 1.0;
        if e.0.is_none() {
            // `if (!e.cwd && typeof cwd === 'string')` — '' is falsy in TS, so it never sticks.
            if let Some(cwd) = s.get("payload").and_then(|p| p.get("cwd")).and_then(Value::as_str).filter(|c| !c.is_empty()) {
                e.0 = Some(cwd.to_owned());
            }
        }
        if let Some(t) = s.get("payload").and_then(|p| p.get("agent_type")).and_then(Value::as_str) {
            *e.1.entry(t.to_owned()).or_insert(0.0) += 1.0;
        }
    }
    let mut ranked: Vec<(String, Origin)> = by.into_iter().collect();
    ranked.sort_by(|a, b| b.1 .2.partial_cmp(&a.1 .2).unwrap_or(std::cmp::Ordering::Equal));
    let parts: Vec<String> = ranked
        .iter()
        .take(cap)
        .map(|(sid, e)| {
            let where_ = e
                .0
                .as_deref()
                .map(|cwd| format!(" in …/{}", cwd.split('/').rfind(|s| !s.is_empty()).unwrap_or("")))
                .unwrap_or_default();
            let types = if e.1.is_empty() {
                String::new()
            } else {
                let mut t: Vec<(&String, &f64)> = e.1.iter().collect();
                t.sort_by(|a, b| b.1.partial_cmp(a.1).unwrap_or(std::cmp::Ordering::Equal));
                format!(": {}", t.iter().map(|(k, n)| if **n > 1.0 { format!("{k}×{}", fmt_js_num(**n)) } else { (*k).clone() }).collect::<Vec<String>>().join(", "))
            };
            format!("session {}…{where_} ({}{types})", js_slice(sid, 8), fmt_js_num(e.2))
        })
        .collect();
    let more = if ranked.len() > cap { format!("; +{} more", ranked.len() - cap) } else { String::new() };
    if parts.is_empty() { String::new() } else { parts.join("; ") + &more }
}

fn risk(code: &str, active: bool, detail: String, evidence: Option<Value>) -> Value {
    let mut m = Map::new();
    m.insert("code".into(), code.into());
    m.insert("active".into(), Value::Bool(active));
    m.insert("detail".into(), detail.into());
    // `evidence: undefined` drops from JSON — the CACHE_THRASH no-tracker branch relies on it.
    if let Some(e) = evidence {
        m.insert("evidence".into(), e);
    }
    Value::Object(m)
}

pub struct BurnGuardOptions<'a> {
    pub now: f64,
    pub bodies_dir: PathBuf,
    pub hook_events_dir: PathBuf,
    pub fanout_threshold: f64,
    pub spike_tokens_per_min: f64,
    /// The in-memory hook-event ring when the server injects it (zero disk); None → disk scan.
    /// NOT PORTED upstream: the ring itself (P4m note), so the standalone path passes None and
    /// reads the NDJSON buckets — correct, just not the zero-disk fast path.
    pub recent_events: Option<&'a [Value]>,
    pub bodies_activity: Option<&'a Value>,
    /// The live monitor's status (the 4s tick's lastBurnStatus); None when unavailable.
    pub burn_status: Option<&'a Value>,
}

/// checkBurnRisk — the six risk rows, always all present (an inactive row states the quiet
/// measurement, so "no risk" is never confused with "no feed").
pub fn check_burn_risk(opts: &BurnGuardOptions) -> Value {
    let now = opts.now;
    let fanout_threshold = opts.fanout_threshold.max(2.0);
    let spike_tpm = opts.spike_tokens_per_min.max(10_000.0);

    let hooks_available = opts.recent_events.is_some() || std::fs::metadata(&opts.hook_events_dir).is_ok();
    let bodies_available = match opts.bodies_activity {
        Some(b) => b.get("available") == Some(&Value::Bool(true)),
        None => std::fs::metadata(&opts.bodies_dir).is_ok(),
    };
    let mut risks: Vec<Value> = Vec::new();

    // In-memory ring when injected; NDJSON scan otherwise. The ring arrives APPEND-ordered while
    // readHookEvents returns newest-first, and the COLD_RESUME row reads [0] as "most recent" —
    // sort so both paths agree.
    let events = |ev: &str, since_ms: f64, limit: i64| -> Vec<Value> {
        match opts.recent_events {
            Some(ring) => {
                let mut v: Vec<Value> = ring
                    .iter()
                    .filter(|r| {
                        let ts = r.get("ts").and_then(Value::as_f64).unwrap_or(0.0);
                        r.get("ev").and_then(Value::as_str) == Some(ev) && ts >= since_ms && ts <= now
                    })
                    .cloned()
                    .collect();
                v.sort_by(|a, b| {
                    let k = |x: &Value| x.get("ts").and_then(Value::as_f64).unwrap_or(0.0);
                    k(b).partial_cmp(&k(a)).unwrap_or(std::cmp::Ordering::Equal)
                });
                v.truncate(limit as usize);
                v
            }
            None if hooks_available => crate::hook_events::read_hook_events(
                &opts.hook_events_dir,
                &crate::hook_events::HookEventFilter { ev: Some(ev), since_ms: Some(since_ms as i64), until_ms: Some(now as i64), limit: Some(limit), ..Default::default() },
            ),
            None => Vec::new(),
        }
    };

    // ── hook-event signals ──────────────────────────────────────────────────────
    let starts = events("SubagentStart", now - 120_000.0, 200);
    let n_starts = starts.len() as f64;
    let fanout_active = n_starts >= fanout_threshold;
    let start_origins = if fanout_active { fmt_start_origins(&starts, 2) } else { String::new() };
    let mut ev = Map::new();
    ev.insert("subagentStarts2min".into(), num(n_starts));
    ev.insert("threshold".into(), num(fanout_threshold));
    if let (true, Some(first)) = (fanout_active, starts.first()) {
        // The anchor for the causing-call lookup: WHERE the fan-out spawns and WHEN. The
        // spawning tool_use PRECEDES the SubagentStart, so causingToolCall windows back from it.
        ev.insert("spawnAtMs".into(), first.get("ts").cloned().unwrap_or(Value::Null));
        if let Some(cwd) = first.get("payload").and_then(|p| p.get("cwd")).and_then(Value::as_str) {
            ev.insert("spawnWorkspace".into(), cwd.into());
        }
    }
    risks.push(risk(
        "FANOUT_BURST",
        fanout_active,
        if fanout_active {
            format!(
                "{} subagents launched in the last 2min (threshold {}) — a fan-out is starting NOW{}. If the parent session is large, every fork re-pays its prefix; if the cache is cold (>5min idle or a stall just ended), each pays it at the WRITE rate.",
                fmt_js_num(n_starts),
                fmt_js_num(fanout_threshold),
                if start_origins.is_empty() { String::new() } else { format!(". Spawners: {start_origins}") }
            )
        } else {
            format!("{} subagent start(s) in the last 2min", fmt_js_num(n_starts))
        },
        Some(Value::Object(ev)),
    ));

    let stops = events("StopFailure", now - 600_000.0, 20);
    let last_stop_ts = stops.first().and_then(|s| s.get("ts").and_then(Value::as_f64));
    risks.push(risk(
        "COLD_RESUME_RISK",
        !stops.is_empty(),
        match last_stop_ts {
            Some(ts) => format!(
                "a StopFailure (rate-limit/API turn death) fired {}min ago — the stall likely outlived the 5-min cache TTL. Do NOT resume a fan-out yet: check get_account_status headroom, then warm the cache with ONE agent before launching the rest.",
                fmt_js_num(js_math_round((now - ts) / 60_000.0))
            ),
            None => "no rate-limit turn deaths in the last 10min".to_owned(),
        },
        Some(serde_json::json!({
            "stopFailures10min": num(stops.len() as f64),
            "lastAtIso": last_stop_ts.map_or(Value::Null, |ts| Value::from(iso_from_ms(ts))),
        })),
    ));

    let compacts = events("PreCompact", now - 300_000.0, 10);
    let last_compact = compacts.first();
    risks.push(risk(
        "COMPACTION_REWRITE",
        !compacts.is_empty(),
        match last_compact {
            Some(c) => format!(
                "PreCompact fired {}min ago (trigger: {}) — the next turn rewrites the full prefix at the write rate. Avoid launching fan-outs or model switches until the new prefix is warm.",
                fmt_js_num(js_math_round((now - c.get("ts").and_then(Value::as_f64).unwrap_or(0.0)) / 60_000.0)),
                // `String(payload?.trigger ?? '?')` — String() of a non-string keeps its JSON text.
                match c.get("payload").and_then(|p| p.get("trigger")) {
                    None | Some(Value::Null) => "?".to_owned(),
                    Some(Value::String(s)) => s.clone(),
                    Some(v) => v.to_string(),
                }
            ),
            None => "no compaction in the last 5min".to_owned(),
        },
        Some(serde_json::json!({ "preCompacts5min": num(compacts.len() as f64) })),
    ));

    // ── bodies-dir signal: fat-context fan-out already in flight ────────────────
    let (mut huge, mut huge_bytes) = (0.0f64, 0.0f64);
    let empty_senders: Vec<Value> = Vec::new();
    let huge_senders: &Vec<Value> = match opts.bodies_activity {
        Some(b) => {
            huge = b.get("hugeRequests90s").and_then(|h| h.get("count")).and_then(Value::as_f64).unwrap_or(0.0);
            huge_bytes = b.get("hugeRequests90s").and_then(|h| h.get("bytes")).and_then(Value::as_f64).unwrap_or(0.0);
            b.get("hugeRequests90s").and_then(|h| h.get("senders")).and_then(Value::as_array).unwrap_or(&empty_senders)
        }
        None => {
            // The full readdir+stat fallback — exactly what the tracker exists to avoid on the
            // gate-frequency path, kept for the no-tracker callers.
            if bodies_available {
                if let Ok(rd) = std::fs::read_dir(&opts.bodies_dir) {
                    for e in rd.flatten() {
                        let name = e.file_name().to_string_lossy().into_owned();
                        if !name.ends_with(".request.json") {
                            continue;
                        }
                        let Ok(md) = e.metadata() else { continue }; // raced with the writer
                        let mt = md
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                            .map_or(0.0, |d| d.as_secs() as f64 * 1000.0 + d.subsec_nanos() as f64 / 1e6);
                        if now - mt <= 90_000.0 && md.len() > 1_000_000 {
                            huge += 1.0;
                            huge_bytes += md.len() as f64;
                        }
                    }
                }
            }
            &empty_senders
        }
    };
    risks.push(risk(
        "HUGE_REQUEST_BURST",
        huge >= 3.0,
        if huge >= 3.0 {
            format!(
                "{} requests >1MB ({:.0}MB ≈ {}k tokens) sent in the last 90s — a fat-context fan-out is IN FLIGHT{}. Stop spawning further agents; let this wave settle before adding load.",
                fmt_js_num(huge),
                js_to_fixed_num(huge_bytes / 1e6, 0),
                fmt_js_num(js_math_round(huge_bytes / 4.0 / 1000.0)),
                if huge_senders.is_empty() { String::new() } else { format!(". Senders: {}", fmt_fat_senders(huge_senders, 2)) }
            )
        } else {
            format!("{} request(s) >1MB in the last 90s", fmt_js_num(huge))
        },
        Some(serde_json::json!({ "hugeRequests90s": num(huge), "bytes": num(huge_bytes), "senders": huge_senders })),
    ));

    // ── cache-thrash signal: the prefix is being re-WRITTEN every turn ──────────
    let thrash = opts.bodies_activity.and_then(|b| b.get("thrash"));
    let thrash_active = thrash.and_then(|t| t.get("active")).and_then(Value::as_bool).unwrap_or(false);
    risks.push(risk(
        "CACHE_THRASH",
        thrash_active,
        match (thrash, thrash_active) {
            (Some(t), true) => {
                let count = t.get("count").and_then(Value::as_f64).unwrap_or(0.0);
                let rebilled = t.get("rebilledTokens").and_then(Value::as_f64).unwrap_or(0.0);
                let model = t.get("model").and_then(Value::as_str);
                let suspects = t.get("suspects").and_then(Value::as_array).unwrap_or(&empty_senders);
                format!(
                    "{} calls in the last {}min re-WROTE ~{}k tokens of prefix instead of reading cache{} — the context cache is being invalidated every turn. {} STOP launching agents and fix the prefix mutator (get_cache_break_causes shows the mechanism).",
                    fmt_js_num(count),
                    fmt_js_num(js_math_round(t.get("windowMs").and_then(Value::as_f64).unwrap_or(0.0) / 60_000.0)),
                    fmt_js_num(js_math_round(rebilled / 1000.0)),
                    model.map(|m| format!(" (model {m})")).unwrap_or_default(),
                    if suspects.is_empty() {
                        "Source not attributable from the fat requests — investigate_burn --windowHours 1 names it.".to_owned()
                    } else {
                        format!("Likely source: {}.", fmt_fat_senders(suspects, 2))
                    }
                )
            }
            (Some(t), false) => format!("{} cache-missing call(s) in the window (needs ≥3)", fmt_js_num(t.get("count").and_then(Value::as_f64).unwrap_or(0.0))),
            (None, _) => "no realtime response-usage feed (tracker not injected)".to_owned(),
        },
        thrash.map(|t| {
            serde_json::json!({
                "misses": t.get("count").cloned().unwrap_or(Value::Null),
                "rebilledTokens": t.get("rebilledTokens").cloned().unwrap_or(Value::Null),
                "model": t.get("model").cloned().unwrap_or(Value::Null),
                "windowMs": t.get("windowMs").cloned().unwrap_or(Value::Null),
                "suspects": t.get("suspects").cloned().unwrap_or(Value::Null),
            })
        }),
    ));

    // ── live burn-rate signal ───────────────────────────────────────────────────
    let empty_windows: Vec<Value> = Vec::new();
    let windows = opts.burn_status.and_then(|b| b.get("accountWindows")).and_then(Value::as_array).unwrap_or(&empty_windows);
    let tpm = |w: &Value| w.get("fiveMinTokensPerMin").and_then(Value::as_f64).unwrap_or(0.0);
    let worst = windows.iter().fold(0.0f64, |a, w| a.max(tpm(w)));

    // The remaining-window clause — warnings are about NOW; the one future-looking fact they may
    // carry is how long until the CURRENT window fills at the current rate (needs capacity).
    let fmt_left = |min: f64| if min >= 90.0 { format!("~{:.1}h", js_to_fixed_num(min / 60.0, 1)) } else { format!("~{}min", fmt_js_num(js_math_round(min))) };
    let hot = windows.iter().fold(None::<&Value>, |a, w| if tpm(w) > a.map_or(-1.0, tpm) { Some(w) } else { a });
    let window_clause = {
        let m = |k: &str| hot.and_then(|h| h.get("budget")?.get(k)?.get("minutesToExhaustion")?.as_f64());
        let mut parts: Vec<String> = Vec::new();
        if let Some(m5) = m("fiveHour") {
            parts.push(format!("the 5h window fills in {}", fmt_left(m5)));
        }
        if let Some(m7) = m("sevenDay") {
            parts.push(format!("the 7d in {}", fmt_left(m7)));
        }
        if parts.is_empty() {
            String::new()
        } else {
            format!(
                " At the current rate {}{}.",
                parts.join(", "),
                hot.and_then(|h| h.get("accountLabel")).and_then(Value::as_str).filter(|l| !l.is_empty()).map(|l| format!(" (account {l})")).unwrap_or_default()
            )
        }
    };

    risks.push(risk(
        "BURN_SPIKE",
        worst > spike_tpm,
        if worst > spike_tpm {
            format!(
                "live burn is {}k tokens/min on the 5-min window (threshold {}k).{} Identify the source NOW: agentlenspro-cli --risk names the senders; investigate_burn --windowHours 1 for depth.",
                fmt_js_num(js_math_round(worst / 1000.0)),
                fmt_js_num(js_math_round(spike_tpm / 1000.0)),
                if window_clause.is_empty() { " Window time-left unavailable (capacity not configured).".to_owned() } else { window_clause.clone() }
            )
        } else {
            format!("live burn {}k tokens/min", fmt_js_num(js_math_round(worst / 1000.0)))
        },
        Some(serde_json::json!({ "fiveMinTokensPerMin": num(worst), "threshold": num(spike_tpm) })),
    ));

    let active = risks.iter().filter(|r| r.get("active") == Some(&Value::Bool(true))).count();
    let mut out = Map::new();
    out.insert("checkedAtIso".into(), iso_from_ms(now).into());
    out.insert("activeCount".into(), num(active as f64));
    out.insert("risks".into(), Value::Array(risks));
    out.insert(
        "sources".into(),
        serde_json::json!({ "hookEvents": hooks_available, "bodies": bodies_available, "burnStatus": opts.burn_status.is_some() }),
    );
    out.insert(
        "advice".into(),
        if active == 0 {
            Value::Null
        } else {
            Value::from(format!("PAUSE before spawning more agents: let in-flight waves settle, warm a cold cache with ONE agent first, and prefer cheap models for fan-out work.{window_clause}"))
        },
    );
    Value::Object(out)
}

/// attachRiskCausingCalls — enrich each ACTIVE risk that anchors a fan-out (a workspace + a
/// time) with the VERBATIM spawning tool-calls. SEPARATE from check_burn_risk so a transcript
/// is opened ONLY when a risk actually fired — the quiet path stays cheap. Mutates in place;
/// honest on failure, never fabricates a call.
pub fn attach_risk_causing_calls(report: &mut Value, projects_dirs: &[PathBuf]) {
    let Some(risks) = report.get_mut("risks").and_then(Value::as_array_mut) else { return };
    for r in risks.iter_mut() {
        if r.get("active") != Some(&Value::Bool(true)) {
            continue;
        }
        let at_ms = r.get("evidence").and_then(|e| e.get("spawnAtMs")).and_then(Value::as_f64);
        let workspace = r.get("evidence").and_then(|e| e.get("spawnWorkspace")).and_then(Value::as_str).map(str::to_owned);
        // Only risks that anchor a spawn call.
        let (Some(at_ms), Some(workspace)) = (at_ms, workspace.filter(|w| !w.is_empty())) else { continue };
        let res = causing_tool_calls(&CausingCallsOptions {
            at_ms,
            session_id: None,
            workspace: Some(&workspace),
            jsonl_path: None,
            window_ms: None,
            forward_slack_ms: None,
            tools: None,
            projects_dirs: projects_dirs.to_vec(),
        });
        let calls = res.get("calls").and_then(Value::as_array).cloned().unwrap_or_default();
        let obj = r.as_object_mut().expect("risk object");
        if calls.is_empty() {
            obj.insert("causingCallsUnavailable".into(), res.get("reason").cloned().unwrap_or(Value::Null));
            continue;
        }
        let comp = composition(&calls);
        let summary = calls
            .iter()
            .map(|c| {
                let s = |k: &str| c.get(k).and_then(Value::as_str).filter(|v| !v.is_empty());
                format!(
                    "{}. {}{}{} @{}",
                    fmt_js_num(c.get("n").and_then(Value::as_f64).unwrap_or(0.0)),
                    s("tool").unwrap_or(""),
                    s("subagentType").map(|v| format!("/{v}")).unwrap_or_default(),
                    s("model").map(|v| format!("/{v}")).unwrap_or_default(),
                    s("iso").unwrap_or("")
                )
            })
            .collect::<Vec<String>>()
            .join("; ");
        let detail = obj.get("detail").and_then(Value::as_str).unwrap_or("").to_owned();
        obj.insert("detail".into(), format!("{detail} Causing calls ({}: {comp}): {summary}", calls.len()).into());
        obj.insert("causingCalls".into(), Value::Array(calls));
        obj.insert("causingCallsComposition".into(), comp.into());
    }
}

/// defaultBodiesDir (src/cacheCreationForensics.ts → captureConfig.resolveBodiesReadScope):
/// the FIRST readable bodies dir — the configured RAM-disk spool when one exists, else the
/// legacy `<data>/otel-bodies`. Resolved, never hardcoded: the legacy dir is empty on any
/// install that redirects bodies to a spool, and a guard reading an empty dir silently reports
/// "no risk" (TRDD-8N3KQW2R).
pub fn default_bodies_dir(data_dir: &Path) -> PathBuf {
    let legacy = data_dir.join("otel-bodies");
    let (dirs, _) = bodies_dir_candidates(data_dir);
    dirs.into_iter().next().unwrap_or(legacy)
}

/// captureConfig.spoolDirConfigured — the RAM-disk spool path persisted when capture was turned on
/// with a spool. `None` on any missing/corrupt config: reading config must never crash a reader,
/// and the absence just means "no spool".
pub fn spool_dir_configured(data_dir: &Path) -> Option<PathBuf> {
    std::fs::read_to_string(data_dir.join("config.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("capture")?.get("spoolDir")?.as_str().map(PathBuf::from))
}

/// The candidate split behind BOTH `default_bodies_dir` (first readable) and
/// `resolve_bodies_read_scope` (all readable). ONE definition of the candidate list and of what
/// "readable" means, because the two answers must never disagree about the same disk.
///
/// Order matters: the spool comes FIRST, so a single-dir reader picks the live spool over a legacy
/// dir that is empty on any install redirecting bodies to a spool — a guard reading that empty dir
/// silently reports "no risk" (TRDD-8N3KQW2R).
fn bodies_dir_candidates(data_dir: &Path) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let legacy = data_dir.join("otel-bodies");
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Some(s) = spool_dir_configured(data_dir) {
        candidates.push(s);
    }
    if !candidates.contains(&legacy) {
        candidates.push(legacy);
    }
    // A dir that EXISTS but is unreadable is as blind as an absent one — both count as missing.
    candidates.into_iter().partition(|d| std::fs::metadata(d).is_ok_and(|m| m.is_dir()))
}

/// captureConfig.rawBodyCaptureEnabled — env > config.json > default, and the DEFAULT IS OFF: a
/// default that silently costs ~35 GB/day is not one a user consented to.
///
/// A typo (`AGENTLENS_CAPTURE_RAW_BODIES=treu`) is NOT consent — it falls through to the file and
/// then the default, rather than being read as either true or false.
pub fn raw_body_capture_enabled(data_dir: &Path, vars: &std::collections::HashMap<String, String>) -> bool {
    fn parse_bool(raw: &str) -> Option<bool> {
        match raw.trim().to_ascii_lowercase().as_str() {
            "1" | "true" | "on" | "yes" => Some(true),
            "0" | "false" | "off" | "no" => Some(false),
            _ => None,
        }
    }
    if let Some(v) = vars.get("AGENTLENS_CAPTURE_RAW_BODIES").and_then(|s| parse_bool(s)) {
        return v;
    }
    std::fs::read_to_string(data_dir.join("config.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("capture")?.get("rawBodies")?.as_bool())
        .unwrap_or(false)
}

/// captureConfig.resolveBodiesReadScope — EVERY readable bodies dir, not just the first.
///
/// The multi-dir case is real and transient: while a drain is in progress the live spool and the
/// legacy dir BOTH hold bodies, so a reader that sees only one under-counts. That is why this
/// returns a list and `missing` alongside it — a report can then say what it actually read
/// (`coverage.dirsScanned`) instead of implying it read everything.
pub struct BodiesReadScope {
    pub dirs: Vec<PathBuf>,
    pub missing: Vec<PathBuf>,
    pub capture_on: bool,
    pub spool_configured: bool,
}

pub fn resolve_bodies_read_scope(data_dir: &Path, vars: &std::collections::HashMap<String, String>) -> BodiesReadScope {
    let (dirs, missing) = bodies_dir_candidates(data_dir);
    BodiesReadScope {
        dirs,
        missing,
        capture_on: raw_body_capture_enabled(data_dir, vars),
        spool_configured: spool_dir_configured(data_dir).is_some(),
    }
}

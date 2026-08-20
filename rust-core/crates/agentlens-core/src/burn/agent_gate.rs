//! Agent-launch burn gate (TRDD-DMWOBWFH P4r.5, freeze row 13) — ports src/agentGate.ts (the
//! pure decision core), src/shared/imageReads.ts (the image-read predicate), and the server.ts
//! gate glue (1159–1315: env thresholds, the caller-TTL resolver, buildGateState, the advisory
//! dedupe map). The POST /api/agent-gate route itself lives in ui.rs.
//!
//! THE CONTRACT IS FAIL-OPEN: allow → 204 empty; PostToolUse advisory / deny / warn → the three
//! 200 hookSpecificOutput shapes; EVERY error path → 204 — a gate that can error a launch is
//! worse than no gate (the route enforces this; nothing in this module returns an error).
//!
//! Design law of the port: the gate STATE is a serde_json `Value` mirroring the TS object
//! literal exactly (buildGateState's return), and every evaluator reads it with JS access
//! semantics — which is what lets ONE committed case list drive both engines in the parity
//! oracle (tests/fixtures/gen-agentgate-expected.mjs). Deny/warn reason strings are compared
//! byte-for-byte there, so every template below must match the TS source verbatim.

use std::collections::HashMap;
use std::path::Path;

use serde_json::{json, Map, Value};

use super::cache_ttl::{classify_ttl_regime, ttl_phrase, SessionTtlKind, COLD_IDLE_SLACK_MS, DEFAULT_COLD_IDLE_MS};
use crate::summarize::helpers::{fmt_js_num, js_math_round, js_slice, num, parse_iso_ms, truthy};

/// server.ts:3556 — 1MB body cap: PreToolUse payloads carry the agent prompt (tens of KB), but a
/// megabyte-scale body is a bug, and the gate must stay cheap.
pub const GATE_BODY_MAX: usize = 1_048_576;

/// readTranscriptContext's default bounded tail read.
pub const TRANSCRIPT_TAIL_BYTES: u64 = 262_144;

/// PostToolUse advisory + IMG_RESIDENT dedupe window (server.ts:3584/3642).
pub const ADVISORY_DEDUPE_MS: f64 = 600_000.0;

// ── DEFAULT_GATE_THRESHOLDS ──────────────────────────────────────────────────────────────────

fn default_threshold(key: &str) -> f64 {
    match key {
        "forkFatTokens" => 200_000.0,
        // Derived, not hardcoded: the shared 5-min tier + slack (TRDD-VY1IUVUM) — the fallback
        // when no per-session TTL regime was resolvable.
        "coldIdleMs" => DEFAULT_COLD_IDLE_MS,
        "runaway60s" => 8.0,
        "fanoutWarn2min" => 5.0,
        "coldResumeWindowMs" => 600_000.0,
        "imgWarnTokens" => 50_000.0,
        "imgDenyTokens" => 300_000.0,
        _ => unreachable!("unknown gate threshold {key}"),
    }
}

/// `{...DEFAULT_GATE_THRESHOLDS, ...state.thresholds}[key]` — the state's partial wins when it
/// carries a NUMBER for the key. The TS partial is env-built and can only hold finite positive
/// numbers (server.ts:1161 `set()` guards), so narrowing "present" to "present as a number" is
/// exact for every real caller.
fn threshold(state: &Value, key: &str) -> f64 {
    state
        .get("thresholds")
        .and_then(|t| t.get(key))
        .and_then(Value::as_f64)
        .unwrap_or_else(|| default_threshold(key))
}

/// server.ts:1161 gateThresholds — the env-built partial. Only DEFINED keys land in it: spreading
/// `{key: undefined}` over the defaults would silently erase them.
pub fn gate_thresholds_from_env(vars: &HashMap<String, String>) -> Value {
    let mut out = Map::new();
    let mut set = |key: &str, env: &str| {
        if let Some(v) = vars.get(env).and_then(|s| s.parse::<f64>().ok()) {
            if v.is_finite() && v > 0.0 {
                out.insert(key.to_owned(), num(v));
            }
        }
    };
    set("forkFatTokens", "AGENTLENS_GATE_FORK_FAT_TOKENS");
    set("coldIdleMs", "AGENTLENS_GATE_COLD_IDLE_MS");
    set("runaway60s", "AGENTLENS_GATE_RUNAWAY_60S");
    set("fanoutWarn2min", "AGENTLENS_GATE_FANOUT_WARN_2MIN");
    set("coldResumeWindowMs", "AGENTLENS_GATE_COLD_RESUME_WINDOW_MS");
    set("imgWarnTokens", "AGENTLENS_GATE_IMG_WARN_TOKENS");
    set("imgDenyTokens", "AGENTLENS_GATE_IMG_DENY_TOKENS");
    Value::Object(out)
}

// ── src/shared/imageReads.ts ─────────────────────────────────────────────────────────────────

/// IMAGE_READ_EXT — `/\.(png|jpe?g|gif|webp|bmp|pdf)$/i`. `.pdf` included (Read renders PDF
/// pages visually); `.svg` deliberately NOT (arrives as text/XML — warning on it would be
/// noise, and noise is how a guard earns its way onto the ignore list).
const IMAGE_READ_EXTS: [&str; 7] = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".pdf"];

/// isImageReadPath — anything path-less or non-string answers false: no path, no claim.
pub fn is_image_read_path(file_path: Option<&Value>) -> bool {
    let Some(p) = file_path.and_then(Value::as_str) else { return false };
    let lower = p.to_ascii_lowercase();
    IMAGE_READ_EXTS.iter().any(|e| lower.ends_with(e))
}

// ── the message-fragment helpers (agentGate.ts:137–202) ──────────────────────────────────────

/// `${Math.round(n / 1000)}k`
fn k(n: f64) -> String {
    format!("{}k", fmt_js_num(js_math_round(n / 1000.0)))
}

/// `(s ? `${s.slice(0, 8)}…` : '?')` — empty string is falsy.
fn short_sid(s: Option<&str>) -> String {
    match s.filter(|s| !s.is_empty()) {
        Some(s) => format!("{}…", js_slice(s, 8)),
        None => "?".to_owned(),
    }
}

/// `(cwd ? `…/${cwd.split('/').filter(Boolean).pop() ?? cwd}` : '')`
fn dir_name(cwd: Option<&str>) -> String {
    match cwd.filter(|c| !c.is_empty()) {
        Some(cwd) => {
            let last = cwd.split('/').rfind(|p| !p.is_empty()).unwrap_or(cwd);
            format!("…/{last}")
        }
        None => String::new(),
    }
}

fn s<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key).and_then(Value::as_str)
}

fn f(v: &Value, key: &str) -> Option<f64> {
    v.get(key).and_then(Value::as_f64)
}

/// A JS-truthy non-empty string field (`caller?.session && …` — '' is falsy).
fn ts<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    s(v, key).filter(|s| !s.is_empty())
}

/// isOwnProject — SESSION first (a worktree-isolated fan-out runs each subagent in
/// .claude/worktrees/<name>, so its cwd differs from the caller's by design; matching on cwd
/// alone silenced the advisory for exactly the expensive fan-out shape). `'?'` is the server's
/// sentinel for a payload with no session id — it must never match anything. Exact cwd match is
/// deliberate: a subagent inherits its parent's cwd, a worktree really is a different project.
fn is_own_project(caller: Option<&Value>, who_session: Option<&str>, who_cwd: Option<&str>) -> bool {
    let caller_session = caller.and_then(|c| ts(c, "session"));
    if let (Some(cs), Some(ws)) = (caller_session, who_session.filter(|s| !s.is_empty())) {
        if ws != "?" && ws == cs {
            return true;
        }
    }
    let caller_cwd = caller.and_then(|c| ts(c, "cwd"));
    matches!((caller_cwd, who_cwd.filter(|c| !c.is_empty())), (Some(cc), Some(wc)) if cc == wc)
}

fn spawners(state: &Value) -> &[Value] {
    state.get("spawners").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[])
}

/// ownLaunches — launches belonging to the CALLER'S OWN project; 0 (never the machine-wide
/// count) when the caller cannot be identified, so an unattributable wave stays silent.
fn own_launches(state: &Value) -> f64 {
    let caller = state.get("caller");
    spawners(state)
        .iter()
        .filter(|sp| is_own_project(caller, s(sp, "session"), s(sp, "cwd")))
        .map(|sp| f(sp, "count").unwrap_or(0.0))
        .sum()
}

/// fmtOwnAgentTypes — distinct agent KINDS of the caller's own spawners, `×N` suffixes STRIPPED
/// (each spawner pre-aggregates per ITS session, so carrying them through would print a count
/// that contradicts the caller's own total). Set = first-occurrence order.
fn fmt_own_agent_types(state: &Value) -> String {
    let caller = state.get("caller");
    let mut seen: Vec<String> = Vec::new();
    for sp in spawners(state) {
        if !is_own_project(caller, s(sp, "session"), s(sp, "cwd")) {
            continue;
        }
        for t in sp.get("agentTypes").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
            let Some(t) = t.as_str() else { continue };
            let base = t.split('×').next().unwrap_or("").trim();
            if !base.is_empty() && !seen.iter().any(|x| x == base) {
                seen.push(base.to_owned());
            }
        }
    }
    seen.join(", ")
}

/// fmtStallOrigin — named ONLY when the stall was the caller's own project (a foreign stall
/// still justifies the deny, but whose session it was is not this agent's business).
fn fmt_stall_origin(state: &Value) -> String {
    let Some(stall) = state.get("stall").filter(|v| truthy(v)) else { return String::new() };
    if !is_own_project(state.get("caller"), s(stall, "session"), s(stall, "cwd")) {
        return String::new();
    }
    format!(" (turn died in session {} in {})", short_sid(s(stall, "session")), dir_name(s(stall, "cwd")))
}

/// thrashSource — names NOBODY (a suspect can never be shown to be the caller's own project);
/// how much is being re-written is what the reader can act on, WHO is a question for the CLI.
fn thrash_source(t: &Value) -> String {
    let n = t.get("suspects").and_then(Value::as_array).map_or(0, Vec::len);
    if n > 0 {
        format!("{n} sender(s) implicated — investigate_burn --windowHours 1 names them.")
    } else {
        "Source not attributable from the fat requests — investigate_burn --windowHours 1 to name it.".to_owned()
    }
}

/// ttlPhrase over the state's ttl Value (the same fields ttl_phrase reads off the struct).
fn ttl_phrase_v(ttl: &Value) -> String {
    let min = f(ttl, "ttlAssumedMin").map(fmt_js_num).unwrap_or_else(|| "undefined".to_owned());
    format!("{}-min TTL ({})", min, s(ttl, "ttlSource").unwrap_or("undefined"))
}

/// The conversations a COLD_RESUME rule protects are SUBAGENT ones — per the doc matrix those
/// ride the 5-min tier ALWAYS, independent of the machine's auth regime (agentGate.ts:26).
fn subagent_ttl_phrase() -> String {
    ttl_phrase(&classify_ttl_regime(Some(SessionTtlKind::Subagent), None))
}

// ── readTranscriptContext (agentGate.ts:210) ─────────────────────────────────────────────────

/// Read the parent session's REAL context size + cache warmth from its transcript: the last
/// assistant entry's message.usage (input + cache_read + cache_creation) IS the prefix a fork
/// will inherit — a bytes/4 guess over the append-only JSONL would count every pre-compaction
/// turn and overestimate wildly. One stat + one bounded tail read.
/// Returns the TS literal: `{contextTokens, idleMs, lastRequestAtMs}` (`{contextTokens: null,
/// idleMs: null}` — no lastRequestAtMs key — when the file cannot even be statted).
pub fn read_transcript_context(transcript_path: &Path, now: f64, tail_bytes: u64) -> Value {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(meta) = std::fs::metadata(transcript_path) else {
        return json!({ "contextTokens": null, "idleMs": null });
    };
    let mtime_ms = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0);
    let idle_ms = (now - mtime_ms).max(0.0);
    let mut context_tokens: Option<f64> = None;
    let mut last_request_at_ms: Option<f64> = None;
    // The TS wraps the whole tail read in try/finally — an unreadable tail leaves idleMs standing.
    let _ = (|| -> std::io::Result<()> {
        let mut fd = std::fs::File::open(transcript_path)?;
        let size = meta.len();
        let start = size.saturating_sub(tail_bytes);
        fd.seek(SeekFrom::Start(start))?;
        let mut buf = vec![0u8; size.min(tail_bytes) as usize];
        fd.read_exact(&mut buf)?;
        // Buffer.toString('utf-8') is lossy on invalid sequences; from_utf8_lossy matches.
        let text = String::from_utf8_lossy(&buf);
        let lines: Vec<&str> = text.split('\n').collect();
        // Started mid-file → the first chunk line is a partial JSONL record; drop it.
        let first = if start > 0 { 1 } else { 0 };
        for l in lines.iter().skip(first).rev() {
            if !l.contains("\"usage\"") {
                continue;
            }
            let Ok(e) = serde_json::from_str::<Value>(l) else { continue }; // corrupt/partial — keep walking back
            // `const u = e.message?.usage; if (!u) continue` — TS truthiness, then property
            // access with the finite-number coercion (a non-number field counts 0).
            let Some(u) = e.get("message").and_then(|m| m.get("usage")).filter(|u| truthy(u)) else { continue };
            let n = |key: &str| u.get(key).and_then(Value::as_f64).unwrap_or(0.0);
            context_tokens = Some(n("input_tokens") + n("cache_read_input_tokens") + n("cache_creation_input_tokens"));
            // TRDD-CXPLAT01: this entry IS the last billed request — its timestamp answers "when
            // was the last LLM request" from the same bounded read. Transcript timestamps are
            // ISO; Date.parse and parse_iso_ms agree on those (a non-ISO string answers null).
            last_request_at_ms = e.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms);
            break;
        }
        Ok(())
    })();
    json!({
        "contextTokens": context_tokens.map(num).unwrap_or(Value::Null),
        "idleMs": num(idle_ms),
        "lastRequestAtMs": last_request_at_ms.map(num).unwrap_or(Value::Null),
    })
}

// ── isKeepWarmPinger (agentGate.ts:260) ──────────────────────────────────────────────────────

/// USER ORDER (2026-07-11, highest priority): a keep-warm pinger launch is NEVER denied — the
/// pinger exists to PREVENT the cold cache every deny state guards against. Signature: a fork
/// (or type-less Task/Agent) whose prompt matches `/keep.?warm|pinger/i`.
pub fn is_keep_warm_pinger(input: &Value) -> bool {
    let st = input.get("subagent_type");
    let fork_or_unspecified = match st {
        None => true,
        Some(Value::Null) => true,
        Some(Value::String(s)) => s.is_empty() || s == "fork",
        _ => false,
    };
    let Some(prompt) = input.get("prompt").and_then(Value::as_str) else { return false };
    // /keep.?warm|pinger/i — `.` in a non-dotall JS regex excludes \n \r    , hence the
    // negated class (Rust's `.` excludes only \n). Divergence note: JS matches UTF-16 units, so
    // an ASTRAL char between keep/warm (two units) fails there and matches here — unreachable in
    // any real prompt, recorded rather than hidden.
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r"(?i)(?:keep[^\n\r\u{2028}\u{2029}]?warm|pinger)").expect("static regex"));
    fork_or_unspecified && re.is_match(prompt)
}

// ── evaluateAgentGate (agentGate.ts:266) ─────────────────────────────────────────────────────

fn allow() -> Value {
    json!({ "decision": "allow", "code": null, "reason": null })
}

/// The pure decision core behind POST /api/agent-gate: "will THIS launch, right now, multiply a
/// burn that is already forming?" Denies only the four high-confidence disaster signatures
/// measured in the 2026-07-10 incident; everything ambiguous is a warning or a silent allow — a
/// gate that cries wolf gets AGENTLENS_GATE=off'd and then prevents nothing.
pub fn evaluate_agent_gate(tool_input: Option<&Value>, state: &Value) -> Value {
    let empty = Value::Object(Map::new());
    let input = tool_input.filter(|v| !v.is_null()).unwrap_or(&empty);
    let fork = s(input, "subagent_type") == Some("fork");
    let keep_warm = is_keep_warm_pinger(input);
    // TTL-aware cold cutoff (TRDD-VY1IUVUM): the entry a fork re-reads is the CALLER's, so
    // "cold" means idle past the CALLER's regime TTL (+ slack). An EXPLICIT
    // AGENTLENS_GATE_COLD_IDLE_MS still wins — silently out-scaling a hand-pinned cutoff would
    // make the env knob a no-op.
    let assumed = super::cache_ttl::assumed_ttl_regime().to_value();
    let ttl = state.get("ttl").filter(|v| v.is_object()).unwrap_or(&assumed);
    // A malformed ttl object mirrors TS: undefined + slack = NaN, and `idleMs > NaN` is false.
    let ttl_ms = f(ttl, "ttlMs").unwrap_or(f64::NAN);
    let explicit_cold = state.get("thresholds").and_then(|t| t.get("coldIdleMs")).and_then(Value::as_f64).is_some();
    let cold_cutoff_ms = if explicit_cold { threshold(state, "coldIdleMs") } else { ttl_ms + COLD_IDLE_SLACK_MS };
    let parent = state.get("parent").unwrap_or(&Value::Null);
    let idle_ms = parent.get("idleMs").and_then(Value::as_f64);
    let cold = idle_ms.is_some_and(|i| i > cold_cutoff_ms);
    let idle_min = idle_ms.map(|i| js_math_round(i / 60_000.0));
    let ctx = parent.get("contextTokens").and_then(Value::as_f64);
    let fat = ctx.is_some_and(|c| c >= threshold(state, "forkFatTokens"));
    let parent_k = ctx.map(k).unwrap_or_else(|| "an unknown amount of".to_owned());
    let stall_age_ms = f(state, "lastStopFailureMs").map(|t| f(state, "now").unwrap_or(0.0) - t);
    // Evidence beats the timer: a warm post-stall response from the stalled session disarms the
    // cold-resume rule immediately; the window is the fallback.
    let cold_resume = stall_age_ms.is_some_and(|a| a >= 0.0 && a <= threshold(state, "coldResumeWindowMs"))
        && state.get("stallRecovered") != Some(&Value::Bool(true));
    let enforce = s(state, "mode") == Some("enforce");

    let deny = |code: &str, reason: String| -> Value {
        if keep_warm {
            // Keep-warm allowance: every deny downgrades to at most an advisory that still names
            // the signal, so the transcript shows the gate SAW the state and let the pinger pass.
            json!({ "decision": "warn", "code": code, "reason": format!(
                "[agentlens] keep-warm pinger allowed through {code}: the pinger is the cache \
warm-up this rule is protecting — denying it would cause the cold cache it prevents.") })
        } else if enforce {
            json!({ "decision": "deny", "code": code, "reason": reason })
        } else {
            json!({ "decision": "warn", "code": code, "reason": format!("[deny downgraded to warning: AGENTLENS_GATE_MODE=warn] {reason}") })
        }
    };

    // ── deny tier: the four measured disaster signatures, most specific first ────
    if let Some(t) = state.get("thrash").filter(|t| t.get("active") == Some(&Value::Bool(true))) {
        let model_clause = s(t, "model").filter(|m| !m.is_empty()).map(|m| format!(" (model {m})")).unwrap_or_default();
        let thrash_base = format!(
            "AgentLens burn-gate: cache-thrash in progress — {} calls in the last {}min re-WROTE ~{} tokens of prefix instead of reading cache{}, i.e. something mutates the context prefix on every call so the cache never hits. {}",
            fmt_js_num(f(t, "count").unwrap_or(0.0)),
            fmt_js_num(js_math_round(f(t, "windowMs").unwrap_or(0.0) / 60_000.0)),
            k(f(t, "rebilledTokens").unwrap_or(0.0)),
            model_clause,
            thrash_source(t)
        );
        // A FORK re-enters the thrashing caller's prefix and re-pays it per launch — deny. A
        // FRESH agent boots its OWN prefix and multiplies nothing (TRDD-THRGX41P) — warn. The
        // keep-warm pinger routes through deny() so its USER-ordered advisory wording holds.
        if fork || keep_warm {
            return deny(
                "THRASH_ACTIVE",
                format!("{thrash_base} A fork re-enters that prefix and multiplies the re-billing. Fix the source first. Override: AGENTLENS_GATE=off."),
            );
        }
        return json!({ "decision": "warn", "code": "THRASH_ACTIVE", "reason": format!(
            "[agentlens] {thrash_base} This fresh launch pays only its own boot prefix (forks stay denied) — diagnose the source before widening fan-outs.") });
    }
    let starts60 = f(state, "startsLast60s").unwrap_or(0.0);
    if starts60 >= threshold(state, "runaway60s") {
        // The COUNT stays machine-wide — this deny protects the machine's cache; only the
        // IDENTITIES are dropped.
        let kinds = fmt_own_agent_types(state);
        let kinds_clause = if kinds.is_empty() { String::new() } else { format!(". From this project: {kinds}") };
        return deny(
            "RUNAWAY_FANOUT",
            format!(
                "AgentLens burn-gate: {} subagent launches in the last 60s — runaway fan-out{kinds_clause}. Let the in-flight wave settle, then relaunch this agent (retry in ~60s is usually enough). Override: AGENTLENS_GATE=off.",
                fmt_js_num(starts60)
            ),
        );
    }
    let starts120 = f(state, "startsLast2min").unwrap_or(0.0);
    if cold_resume && starts120 >= 1.0 {
        let stall_who = fmt_stall_origin(state);
        // The TTL here is the SUBAGENT tier: the launches this rule holds back are fresh agent
        // conversations whose shared prefix entries ride the 5-min tier regardless of the
        // caller's regime.
        return deny(
            "COLD_RESUME_FANOUT",
            format!(
                "AgentLens burn-gate: a rate-limit stall ended {}min ago{stall_who}, so the fan-out's agent prefix caches are past their {}, and {} agent(s) already launched since — that first launch IS the cache warm-up. Every further agent launched before it lands re-pays the full prefix at the write rate. Retry this launch in ~60s. Override: AGENTLENS_GATE=off.",
                fmt_js_num(js_math_round(stall_age_ms.unwrap_or(0.0) / 60_000.0)),
                subagent_ttl_phrase(),
                fmt_js_num(starts120)
            ),
        );
    }
    // CC ≥2.1.229 performs the "warm the cache with ONE agent first" remedy itself for WORKFLOW
    // same-prefix siblings (stagger), so this deny keeps firing only on launches that still
    // storm: parallel Agent-tool forks in one message, a disabled stagger, or an older CC.
    if fork && fat && cold && starts120 >= 2.0 {
        let kinds = fmt_own_agent_types(state);
        // Same split as RUNAWAY_FANOUT: the COUNT is machine-wide, the KINDS are own-project
        // only — the labeled parenthetical keeps the two populations from reading as one.
        let kinds_clause = if kinds.is_empty() { String::new() } else { format!(" (from this project: {kinds})") };
        return deny(
            "FORK_STORM_FORMING",
            format!(
                "AgentLens burn-gate: fork of a ~{parent_k}-token parent into a COLD cache (idle {}min > its {}) with {} launches already in 2min{kinds_clause} — a fork storm is forming; each fork re-pays the full parent prefix at the cache-WRITE rate. Warm the cache with ONE agent first, or compact the parent before fanning out. Retry in ~60s. Override: AGENTLENS_GATE=off.",
                fmt_js_num(idle_min.unwrap_or(f64::NAN)),
                ttl_phrase_v(ttl),
                fmt_js_num(starts120)
            ),
        );
    }

    // ── warn tier: real cost, but a single launch is a legitimate choice ─────────
    // The keep-warm pinger skips the warn tier entirely: COLD_FORK advice is vacuous for the
    // warm-up itself, and a scheduled pinger would re-trigger it on every ping.
    if keep_warm {
        return allow();
    }
    if fork && fat && cold {
        return json!({ "decision": "warn", "code": "COLD_FORK", "reason": format!(
            "[agentlens] cache cold (idle {}min > the parent's {}): this fork re-pays ~{parent_k} tokens of parent prefix at the write rate once. Let it warm the cache before launching further forks.",
            fmt_js_num(idle_min.unwrap_or(f64::NAN)), ttl_phrase_v(ttl)) });
    }
    if fork && fat {
        return json!({ "decision": "warn", "code": "FORK_FAT_PARENT", "reason": format!(
            "[agentlens] fork inherits ~{parent_k} tokens of parent prefix (warm cache — read rate). Compact before large fan-outs to shrink what every fork re-reads.") });
    }
    // THRASH_UNATTRIBUTED was retired from the model-facing channels (2026-08-07): by
    // construction it reported writes provably tied to nobody. The DETECTION still runs in
    // bodies_activity; this module was its only consumer.
    let own_starts = own_launches(state);
    if own_starts >= threshold(state, "fanoutWarn2min") {
        let premium_hint = match f(state, "premiumShare") {
            Some(share) if share > 0.5 && input.get("model").and_then(Value::as_str).is_none() => format!(
                " Recent traffic is on {} and this launch does not pin a model — fan-out agents inherit it; pin a cheaper one (model: 'sonnet' or 'haiku') for mechanical work.",
                s(state, "premiumModel").unwrap_or("a premium model")
            ),
            _ => String::new(),
        };
        let kinds = fmt_own_agent_types(state);
        let kinds_clause = if kinds.is_empty() { String::new() } else { format!(" ({kinds})") };
        return json!({ "decision": "warn", "code": "FANOUT_HEADSUP", "reason": format!(
            "[agentlens] {} agent launches from this project in the last 2min — fan-out in progress{kinds_clause}.{premium_hint}",
            fmt_js_num(own_starts)) });
    }

    allow()
}

// ── resolveMessageTargetLiveness (agentGate.ts:418) ──────────────────────────────────────────

/// Resolve a SendMessage target's liveness from the SubagentStart/Stop hook-event ring. `to`
/// matches hook payloads only when it is an agent id — a NAME has no hook-event counterpart, so
/// name targets honestly resolve 'unknown' (→ warn, not deny). 'main' is the caller's own live
/// conversation by definition.
pub fn resolve_message_target_liveness(target: Option<&Value>, events: &[Value]) -> &'static str {
    let Some(target) = target.and_then(Value::as_str).filter(|t| !t.is_empty()) else { return "unknown" };
    if target == "main" {
        return "live";
    }
    let id = target.strip_prefix("agent-").unwrap_or(target);
    let mut verdict = "unknown";
    let mut last_ts = -1.0;
    for e in events {
        let ev = s(e, "ev");
        if ev != Some("SubagentStart") && ev != Some("SubagentStop") {
            continue;
        }
        if e.get("payload").and_then(|p| p.get("agent_id")).and_then(Value::as_str) != Some(id) {
            continue;
        }
        let ts = f(e, "ts").unwrap_or(f64::NAN);
        if ts >= last_ts {
            last_ts = ts;
            verdict = if ev == Some("SubagentStart") { "live" } else { "dead" };
        }
    }
    verdict
}

// ── evaluateSendMessageGate (agentGate.ts:453) ───────────────────────────────────────────────

/// The narrower sibling of evaluateAgentGate: ONLY THRASH_ACTIVE and COLD_RESUME may deny, and
/// ONLY against a target whose liveness resolves DEAD (a resume re-runs the request that killed
/// it; delivery to a LIVE agent rides its existing run). 'unknown' downgrades the deny to a
/// warning — a hard deny needs positive dead evidence. No warn tier for quiet states.
pub fn evaluate_send_message_gate(state: &Value) -> Value {
    let stall_age_ms = f(state, "lastStopFailureMs").map(|t| f(state, "now").unwrap_or(0.0) - t);
    let cold_resume = stall_age_ms.is_some_and(|a| a >= 0.0 && a <= threshold(state, "coldResumeWindowMs"))
        && state.get("stallRecovered") != Some(&Value::Bool(true));
    let liveness = s(state, "targetLiveness").unwrap_or("unknown");
    let who = ts(state, "messageTarget").map(|t| format!(" '{t}'")).unwrap_or_default();

    // A LIVE target rides its own already-running request stream — never gate live messaging.
    if liveness == "live" {
        return allow();
    }

    let enforce = s(state, "mode") == Some("enforce");
    let deny = |code: &str, reason: String| -> Value {
        if liveness == "unknown" {
            // No positive dead evidence → never hard-deny; surface the risk as a warning.
            json!({ "decision": "warn", "code": code, "reason": format!("[target{who} liveness unknown — deny downgraded to warning] {reason}") })
        } else if enforce {
            json!({ "decision": "deny", "code": code, "reason": reason })
        } else {
            json!({ "decision": "warn", "code": code, "reason": format!("[deny downgraded to warning: AGENTLENS_GATE_MODE=warn] {reason}") })
        }
    };

    if let Some(t) = state.get("thrash").filter(|t| t.get("active") == Some(&Value::Bool(true))) {
        let model_clause = s(t, "model").filter(|m| !m.is_empty()).map(|m| format!(" (model {m})")).unwrap_or_default();
        return deny(
            "THRASH_ACTIVE",
            format!(
                "AgentLens burn-gate: cache-thrash in progress — {} calls in the last {}min re-WROTE ~{} tokens of prefix instead of reading cache{}. {} Resuming a dead agent{who} now re-runs its whole transcript into the thrashing prefix. Fix the source first. Override: AGENTLENS_GATE=off.",
                fmt_js_num(f(t, "count").unwrap_or(0.0)),
                fmt_js_num(js_math_round(f(t, "windowMs").unwrap_or(0.0) / 60_000.0)),
                k(f(t, "rebilledTokens").unwrap_or(0.0)),
                model_clause,
                thrash_source(t)
            ),
        );
    }
    if cold_resume {
        let stall_who = fmt_stall_origin(state);
        // A dead SendMessage target is a SUBAGENT conversation by construction ('main' resolves
        // live above), so the resume-cost premise uses the subagent tier — 5 min ALWAYS.
        return deny(
            "COLD_RESUME_MESSAGE",
            format!(
                "AgentLens burn-gate: a rate-limit stall ended {}min ago{stall_who} — messaging a dead agent{who} resumes it by RE-RUNNING the request that killed it, and with the agent's prompt cache past its {} that resume re-pays its full prefix at the write rate. Wait ~60s for the wall to clear, then retry this message. Override: AGENTLENS_GATE=off.",
                fmt_js_num(js_math_round(stall_age_ms.unwrap_or(0.0) / 60_000.0)),
                subagent_ttl_phrase()
            ),
        );
    }
    allow()
}

// ── evaluateImageReadGate (agentGate.ts:524) ─────────────────────────────────────────────────

/// Cache-guard for image reads — WARN ONLY, on purpose: a per-turn resident tax is not the same
/// class of event as a forming fork storm, and Read is a hot path where a false deny is
/// maximally annoying. `imgDenyTokens` is honoured only as the "dominating" phrasing trigger.
pub fn evaluate_image_read_gate(tool_input: Option<&Value>, state: &Value) -> Value {
    let empty = Value::Object(Map::new());
    let input = tool_input.filter(|v| !v.is_null()).unwrap_or(&empty);
    let file_path = input.get("file_path");
    if !is_image_read_path(file_path) {
        return allow();
    }
    let file_path = file_path.and_then(Value::as_str).expect("is_image_read_path narrowed");
    // No readable transcript ⇒ no context size ⇒ no claim: a warning needs a real number behind
    // it — inventing one is how a gate earns its way onto the ignore list.
    let ctx = state.get("parent").and_then(|p| p.get("contextTokens")).and_then(Value::as_f64);
    let Some(ctx) = ctx.filter(|c| *c >= threshold(state, "imgWarnTokens")) else { return allow() };

    let name = file_path.split('/').rfind(|p| !p.is_empty()).unwrap_or(file_path);
    let dominating = if ctx >= threshold(state, "imgDenyTokens") {
        " This session is already large enough that resident blocks dominate its per-turn cost."
    } else {
        ""
    };
    json!({ "decision": "warn", "code": "IMG_RESIDENT", "reason": format!(
        "[agentlens cache-guard] reading {name} into a ~{}-token session. An image block is RESIDENT: it rides forward in the prefix and is re-billed on EVERY later turn until a compaction evicts it — the cost is not the one read, it is the read times every turn that follows.{dominating} Cheapest first: (1) delegate the look to a subagent — it reads the image in ITS small context and returns a text verdict, so nothing lands here; (2) if you look here, read every image you need in ONE message and draw the conclusions in that same turn — batching costs no more than one; (3) write the verdict down and never re-read the file. Silence: AGENTLENS_CACHE_GUARD=off.",
        k(ctx)) })
}

// ── buildAdvisory (agentGate.ts:561) ─────────────────────────────────────────────────────────

/// PostToolUse advisory — ONE short warning when a burn pattern is active as an agent wave
/// completes, or Null. The route dedupes per session+code so injections stay RARE (per-call
/// injections that later get stripped in place are themselves a cache-break cause).
pub fn build_advisory(state: &Value) -> Value {
    if let Some(t) = state.get("thrash").filter(|t| t.get("active") == Some(&Value::Bool(true))) {
        let model_clause = s(t, "model").filter(|m| !m.is_empty()).map(|m| format!(" (model {m})")).unwrap_or_default();
        return json!({ "code": "THRASH_ACTIVE", "text": format!(
            "⚠ AgentLens: cache-thrash detected while your agents ran — {} calls re-wrote ~{} tokens of prefix each turn instead of reading cache{}. {} Do NOT launch more agents until the source is fixed.",
            fmt_js_num(f(t, "count").unwrap_or(0.0)),
            k(f(t, "rebilledTokens").unwrap_or(0.0)),
            model_clause,
            thrash_source(t)) });
    }
    // Only ONE other advisory survives, and only when it is the caller's OWN fan-out — a message
    // put in front of a model must be about its own project, actionable right now, significant.
    let own_starts = own_launches(state);
    if own_starts >= threshold(state, "fanoutWarn2min") {
        let premium = match f(state, "premiumShare") {
            Some(share) if share > 0.5 => format!(
                " Most of that traffic is on {} — pin cheaper models on fan-out agents.",
                s(state, "premiumModel").unwrap_or("a premium model")
            ),
            _ => String::new(),
        };
        let kinds = fmt_own_agent_types(state);
        let kinds_clause = if kinds.is_empty() { String::new() } else { format!(" ({kinds})") };
        return json!({ "code": "FANOUT_HEADSUP", "text": format!(
            "⚠ AgentlensPro: {} agent launches from this project in the last 2min{kinds_clause}.{premium} Check headroom before widening the fan-out: agentlenspro-cli --risk.",
            fmt_js_num(own_starts)) });
    }
    Value::Null
}

// ── the server glue (standalone/server.ts:1188–1315) ─────────────────────────────────────────

/// resolveCallerTtlKind — best-effort TTL kind of the session CALLING the gate. Signals,
/// strongest first: (1) the hook-event ring (a SubagentStart whose agent_id matches proves a
/// spawned agent; agent_type distinguishes fork from the rest); (2) the transcript path
/// (subagent transcripts live at .../subagents/agent-<id>.jsonl, worktree fleets under a
/// "-claude-worktrees" mangled dir). No signal → None, so the classifier reports 'assumed'.
pub fn resolve_caller_ttl_kind(session_id: Option<&str>, transcript_path: Option<&str>, ring: &[Value]) -> Option<SessionTtlKind> {
    if let Some(sid) = session_id.filter(|s| !s.is_empty() && *s != "unknown") {
        let bare = sid.strip_prefix("agent-").unwrap_or(sid);
        // Newest match wins (a name/id can be reused across restarts — the latest launch is the
        // caller).
        for r in ring.iter().rev() {
            if s(r, "ev") != Some("SubagentStart") {
                continue;
            }
            let payload = r.get("payload");
            if payload.and_then(|p| p.get("agent_id")).and_then(Value::as_str) != Some(bare) {
                continue;
            }
            let kind = if payload.and_then(|p| p.get("agent_type")).and_then(Value::as_str) == Some("fork") {
                SessionTtlKind::Fork
            } else {
                SessionTtlKind::Subagent
            };
            return Some(kind);
        }
    }
    if let Some(tp) = transcript_path {
        let base = Path::new(tp).file_name().and_then(|n| n.to_str()).unwrap_or("");
        let sep = std::path::MAIN_SEPARATOR;
        if base.starts_with("agent-") || tp.contains(&format!("{sep}subagents{sep}")) || tp.contains("-claude-worktrees") {
            // A spawned transcript whose SubagentStart already left the ring: provably a child,
            // but fork-vs-fresh is no longer distinguishable — 'subagent' is the doc-certain
            // floor; calling it 'fork' would grant an unproven 1h tier.
            return Some(SessionTtlKind::Subagent);
        }
        return Some(SessionTtlKind::Main);
    }
    None
}

/// buildGateState (server.ts:1221) — the ring-derived counts + attribution, the bodies-activity
/// snapshot, the evidence-based stall disarm, the caller's TTL regime, and the env thresholds,
/// as the TS object literal. The bodies report is READ-ONLY here: polling happens on the burn
/// tick, never on the PreToolUse hot path (a poll landing on new multi-MB response files costs
/// 100-400ms of parsing — the TRDD-9CNHP8CN request-latency outlier).
pub fn build_gate_state(
    st: &mut crate::CoreState,
    now: f64,
    parent: Value,
    caller_session: &str,
    caller_transcript: Option<&str>,
    caller_cwd: Option<&str>,
) -> Value {
    let mut starts60 = 0.0;
    let mut starts120 = 0.0;
    let mut last_stop: Option<&Value> = None;
    // Per-session launch attribution: SubagentStart payloads carry cwd + agent_type, so the
    // deny/warn messages can name WHO is fanning out, from WHERE, with WHAT agent kinds.
    // IndexMaps: JS Map iteration order is insertion order, and the stable sorts below rely on it.
    // (first cwd seen, agent_type → count, launch count) — the TS bySession entry.
    type Spawner = (Option<String>, indexmap::IndexMap<String, f64>, f64);
    let mut by_session: indexmap::IndexMap<String, Spawner> = indexmap::IndexMap::new();
    for r in &st.recent_hook_events {
        let ts_v = f(r, "ts").unwrap_or(f64::NAN);
        if ts_v > now {
            continue;
        }
        let ev = s(r, "ev");
        if ev == Some("SubagentStart") {
            if now - ts_v <= 60_000.0 {
                starts60 += 1.0;
            }
            if now - ts_v <= 120_000.0 {
                starts120 += 1.0;
                // Sessionless events are keyed by their CWD, not lumped under one '?' bucket —
                // merging two projects' sessionless launches would either credit all of them to
                // whoever matched that cwd, or exclude all of them; both wrong, both silent.
                let payload = r.get("payload");
                let cwd = payload.and_then(|p| p.get("cwd")).and_then(Value::as_str);
                let sid = s(r, "session").map(str::to_owned).unwrap_or_else(|| format!("?:{}", cwd.unwrap_or("unknown")));
                let e = by_session.entry(sid).or_insert((None, indexmap::IndexMap::new(), 0.0));
                e.2 += 1.0;
                // `if (!e.cwd && typeof cwd === 'string')` — an empty-string cwd is assigned AND
                // stays falsy, so a later real cwd still overwrites it.
                if e.0.as_deref().is_none_or(str::is_empty) {
                    if let Some(c) = cwd {
                        e.0 = Some(c.to_owned());
                    }
                }
                if let Some(t) = payload.and_then(|p| p.get("agent_type")).and_then(Value::as_str) {
                    *e.1.entry(t.to_owned()).or_insert(0.0) += 1.0;
                }
            }
        } else if ev == Some("StopFailure") && last_stop.is_none_or(|l| ts_v > f(l, "ts").unwrap_or(f64::NAN)) {
            last_stop = Some(r);
        }
    }
    let mut ranked: Vec<(String, Spawner)> = by_session.into_iter().collect();
    ranked.sort_by(|a, b| b.1 .2.partial_cmp(&a.1 .2).unwrap_or(std::cmp::Ordering::Equal));
    let spawners: Vec<Value> = ranked
        .into_iter()
        .map(|(session, (cwd, types, count))| {
            let mut tv: Vec<(String, f64)> = types.into_iter().collect();
            tv.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
            let agent_types: Vec<Value> = tv
                .into_iter()
                .map(|(t, n)| Value::from(if n > 1.0 { format!("{t}×{}", fmt_js_num(n)) } else { t }))
                .collect();
            json!({
                // A synthesized `?:<cwd>` key is NOT a session id — hand the gate `'?'` so its
                // own-session match can never fire on it.
                "session": if session.starts_with("?:") { "?" } else { session.as_str() },
                "cwd": cwd,
                "count": num(count),
                "agentTypes": agent_types,
            })
        })
        .collect();
    let (last_stop_ms, stall, stall_session): (Value, Value, Option<String>) = match last_stop {
        Some(r) => {
            let session = s(r, "session").map(str::to_owned);
            let cwd = r.get("payload").and_then(|p| p.get("cwd")).and_then(Value::as_str).map(str::to_owned);
            (
                r.get("ts").cloned().unwrap_or(Value::Null),
                json!({ "session": session, "cwd": cwd }),
                // `if (lastStop?.session)` — truthiness: an empty-string session never probes.
                s(r, "session").filter(|s| !s.is_empty()).map(str::to_owned),
            )
        }
        None => (Value::Null, Value::Null, None),
    };
    // Evidence-based cold-resume disarm (2026-07-11): a warm post-stall response from the
    // STALLED session proves the stall is over. Fail-closed to `false` (the timer fallback)
    // when the session is unknown. 50_000 is sessionWarmSince's TS default warmReadFloor.
    let stall_recovered = match (&stall_session, last_stop.and_then(|r| f(r, "ts"))) {
        (Some(sess), Some(ts_v)) => st.burn.bodies.session_warm_since(sess, ts_v, 50_000.0),
        _ => false,
    };
    let act = st.burn.bodies.report(now);
    let available = act.get("available") == Some(&Value::Bool(true));
    let premium_sampled = act.get("premium").and_then(|p| p.get("sampled")).and_then(Value::as_f64).unwrap_or(0.0);
    // The CALLER's TTL regime (TRDD-VY1IUVUM): a fork reads the CALLER's cache entry, so the
    // fork cold checks run against ITS tier — 1h on a subscription main session.
    let ttl_ctx = st.burn.ttl_context(now);
    let ttl = classify_ttl_regime(
        resolve_caller_ttl_kind(Some(caller_session), caller_transcript, &st.recent_hook_events),
        Some(&ttl_ctx),
    );
    json!({
        "now": num(now),
        "mode": st.hook_runtime.gate_mode,
        "parent": parent,
        "startsLast60s": num(starts60),
        "startsLast2min": num(starts120),
        "spawners": spawners,
        "lastStopFailureMs": last_stop_ms,
        "stall": stall,
        "stallRecovered": stall_recovered,
        "thrash": if available { act.get("thrash").cloned().unwrap_or(Value::Null) } else { Value::Null },
        "premiumShare": if premium_sampled > 0.0 { act.get("premium").and_then(|p| p.get("share")).cloned().unwrap_or(Value::Null) } else { Value::Null },
        "premiumModel": act.get("premium").and_then(|p| p.get("lastModel")).cloned().unwrap_or(Value::Null),
        "ttl": ttl.to_value(),
        // WHO is asking — the identity every model-facing message is scoped against.
        "caller": { "session": caller_session, "cwd": caller_cwd },
        "thresholds": gate_thresholds_from_env(&st.burn.vars),
    })
}

/// pruneAdvisoryIssued (server.ts:1309) — prune the oldest half so a long-lived server never
/// grows the dedupe map unbounded; called from EVERY writer. The TS sorts Map entries (insertion
/// order under ties); a HashMap's tie order is arbitrary — which of two SAME-timestamp keys gets
/// pruned can differ, never whether pruning happens.
pub fn prune_advisory_issued(map: &mut HashMap<String, f64>, now: f64) {
    if map.len() <= 200 {
        return;
    }
    let mut entries: Vec<(String, f64)> = map.iter().map(|(k, v)| (k.clone(), *v)).collect();
    entries.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    for (key, v) in entries.into_iter().take(100) {
        if v <= now {
            map.remove(&key);
        }
    }
}

//! Port of src/sessionBurnProfile.ts — `get_session_burn_profile` (TRDD-DMWOBWFH P4x.2d).
//!
//! One-call burn diagnosis for a single session, bounded by an mtime window plus a file-size cap.
//! Only the NEWEST request body is fully parsed; every other file is scanned with regexes over its
//! raw text, because a session's request bodies are megabytes each and a full parse of all of them
//! is the cost this tool exists to diagnose.
//!
//! `defaultBodiesDir()` is deliberately NOT ported — the bodies dir is a REQUIRED parameter here,
//! and the route already resolves it via `burn::guard::default_bodies_dir`. Two resolvers could
//! disagree; one cannot.

use std::path::Path;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::pricing::calc_token_cost_usd;
use crate::summarize::helpers::{js_math_round, js_to_fixed_num, js_to_fixed_str, num, to_locale_en};

const MAX_BYTES: u64 = 8 * 1024 * 1024;
const CHARS_PER_TOKEN: f64 = 4.0;
/// A "cold" call: nothing read, yet a large prefix written.
const COLD_CREATE_FLOOR: f64 = 50_000.0;
/// Above pure append-growth: something in the prefix actually CHANGED.
const LARGE_CREATE_FLOOR: f64 = 20_000.0;
const ACTIVE_WITHIN_MIN: f64 = 3.0;
/// Anthropic's billing multipliers relative to the base input rate. A cache_read is nearly free per
/// token (0.1x) but a cache_create is a PREMIUM write (1.25x on the 5-min tier) — so 20k of create
/// can outweigh 200k of read. Comparing the WEIGHTED terms is the only honest way to name the
/// dominant cost.
const READ_WEIGHT: f64 = 0.1;
const CREATE_WEIGHT: f64 = 1.25;

fn median(xs: &[f64]) -> f64 {
    if xs.is_empty() {
        return 0.0;
    }
    let mut s = xs.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let mid = s.len() / 2;
    if !s.len().is_multiple_of(2) {
        s[mid]
    } else {
        // `Math.round` — half toward +∞, which differs from Rust's `round` on negative halves.
        js_math_round((s[mid - 1] + s[mid]) / 2.0)
    }
}

fn percentile(xs: &[f64], p: f64) -> f64 {
    if xs.is_empty() {
        return 0.0;
    }
    let mut s = xs.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let idx = ((p / 100.0) * s.len() as f64).floor();
    s[(idx as usize).min(s.len() - 1)]
}

fn re(cell: &'static std::sync::OnceLock<regex::Regex>, pattern: &str) -> &'static regex::Regex {
    cell.get_or_init(|| regex::Regex::new(pattern).expect("static regex"))
}

fn rx_msg_id() -> &'static regex::Regex {
    static C: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    re(&C, r#""id"\s*:\s*"(msg_[A-Za-z0-9]+)""#)
}
fn rx_prev() -> &'static regex::Regex {
    static C: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    re(&C, r#""previous_message_id"\s*:\s*"(msg_[A-Za-z0-9]+)""#)
}
fn rx_model() -> &'static regex::Regex {
    static C: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    re(&C, r#""model"\s*:\s*"([^"]+)""#)
}
fn rx_read() -> &'static regex::Regex {
    static C: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    re(&C, r#""cache_read_input_tokens"\s*:\s*(\d+)"#)
}
fn rx_create() -> &'static regex::Regex {
    static C: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    re(&C, r#""cache_creation_input_tokens"\s*:\s*(\d+)"#)
}
fn rx_tool_name() -> &'static regex::Regex {
    static C: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    re(&C, r#""name"\s*:\s*"([^"]+)""#)
}
fn rx_user_id() -> &'static regex::Regex {
    static C: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    re(&C, r#""user_id"\s*:\s*"((?:[^"\\]|\\.)*)""#)
}
fn rx_mcp_source() -> &'static regex::Regex {
    static C: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    // `.+?` is NON-GREEDY: `mcp__a__b__c` has server `a`, not `a__b`.
    re(&C, r"^mcp__(.+?)__")
}

fn cap1(rx: &regex::Regex, hay: &str) -> Option<String> {
    rx.captures(hay).map(|c| c[1].to_owned())
}

/// Extract the tool NAMES from a raw request body WITHOUT parsing the whole (MB-sized) document:
/// find `"tools":[` and bracket-match to its close, then pull the names inside that slice. This is
/// what makes fingerprinting `tools[]` on EVERY turn cheap — the diff of consecutive fingerprints
/// is the direct, MEASURED answer to "do the MCP tools change per turn?".
///
/// Scans BYTES where the TS scans UTF-16 code units. Every character the scanner tests — `"`, `[`,
/// `]`, `\` — is ASCII, and a multi-byte character's continuation bytes can never equal one, so the
/// structure found is identical and the slice lands on the same boundaries.
pub fn extract_tool_names(raw: &str) -> Vec<String> {
    let Some(key) = raw.find("\"tools\":") else { return Vec::new() };
    let Some(open) = raw[key..].find('[').map(|i| key + i) else { return Vec::new() };
    let b = raw.as_bytes();
    let mut depth = 0i32;
    let mut end: Option<usize> = None;
    let mut i = open;
    while i < b.len() {
        match b[i] {
            b'"' => {
                // Skip the string body — it may contain brackets.
                i += 1;
                while i < b.len() && !(b[i] == b'"' && b[i - 1] != b'\\') {
                    i += 1;
                }
            }
            b'[' => depth += 1,
            b']' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(i);
                    break;
                }
            }
            _ => {}
        }
        i += 1;
    }
    let Some(end) = end else { return Vec::new() };
    // `raw.slice(open, end)` — the closing bracket is EXCLUDED.
    rx_tool_name().captures_iter(&raw[open..end]).map(|c| c[1].to_owned()).collect()
}

/// Read the session id from `metadata.user_id` ONLY.
///
/// THE BUG THIS FIXES: a naive `/"session_id":"(…)"/` over the raw body matches the FIRST
/// occurrence anywhere — including inside CONVERSATION TEXT. A transcript that merely MENTIONS a
/// session id was therefore attributed to that session, and two different queries returned
/// byte-identical profiles. The id must come from the metadata field, so this anchors on
/// `"user_id"` searched from the END (metadata is emitted last) and parses its escaped JSON blob.
/// Absent or unparseable is `None` — fail-closed, never a guess.
pub fn session_id_of(raw: &str) -> Option<String> {
    let at = raw.rfind("\"user_id\"")?;
    let m = cap1(rx_user_id(), &raw[at..])?;
    // Unescape the JSON-in-a-JSON-string, then parse the blob.
    let blob: String = serde_json::from_str(&format!("\"{m}\"")).ok()?;
    let parsed: Value = serde_json::from_str(&blob).ok()?;
    parsed.get("session_id").and_then(Value::as_str).map(str::to_owned)
}

fn source_of(tool: &str) -> String {
    match cap1(rx_mcp_source(), tool) {
        Some(server) => format!("MCP: {server}"),
        None => "built-in".to_owned(),
    }
}

#[derive(Clone, Debug)]
struct ReqEntry {
    path: std::path::PathBuf,
    mtime: f64,
    model: String,
    prev: Option<String>,
    tool_names: Vec<String>,
}

/// Diff `tools[]` across consecutive turns. A change ANYWHERE in `tools[]` invalidates the whole
/// prefix (tools sit above system and messages), so this is the single highest-leverage stability
/// metric — and the one thing here that is measured rather than assumed.
fn analyze_tool_stability(reqs: &[ReqEntry]) -> Value {
    let mut turns_changed = 0.0;
    let mut by_source: IndexMap<String, f64> = IndexMap::new();
    let mut changes: Vec<Value> = Vec::new();
    for i in 1..reqs.len() {
        let prev = &reqs[i - 1].tool_names;
        let cur = &reqs[i].tool_names;
        if prev.is_empty() && cur.is_empty() {
            continue;
        }
        // `join('\x00')` — ORDER-SENSITIVE, deliberately: a reorder alone still invalidates the
        // prefix, so it must count as a change.
        if prev.join("\0") == cur.join("\0") {
            continue;
        }
        turns_changed += 1.0;
        let ps: std::collections::HashSet<&String> = prev.iter().collect();
        let cs: std::collections::HashSet<&String> = cur.iter().collect();
        let added: Vec<String> = cur.iter().filter(|n| !ps.contains(n)).cloned().collect();
        let removed: Vec<String> = prev.iter().filter(|n| !cs.contains(n)).cloned().collect();
        // `[...new Set(...)]` — unique in FIRST-SEEN order.
        let mut sources: Vec<String> = Vec::new();
        for n in added.iter().chain(removed.iter()) {
            let s = source_of(n);
            if !sources.contains(&s) {
                sources.push(s);
            }
        }
        if added.is_empty() && removed.is_empty() {
            sources.push("(reorder — same set, different order)".to_owned());
        }
        for s in &sources {
            *by_source.entry(s.clone()).or_insert(0.0) += 1.0;
        }
        if changes.len() < 5 {
            let mut m = Map::new();
            m.insert("turn".into(), num((i + 1) as f64));
            m.insert("added".into(), Value::Array(added.iter().take(5).map(|s| Value::String(s.clone())).collect()));
            m.insert("removed".into(), Value::Array(removed.iter().take(5).map(|s| Value::String(s.clone())).collect()));
            m.insert("sources".into(), Value::Array(sources.iter().map(|s| Value::String(s.clone())).collect()));
            changes.push(Value::Object(m));
        }
    }
    let turns_compared = (reqs.len() as f64 - 1.0).max(0.0);
    let change_pct = if turns_compared > 0.0 { js_to_fixed_num(100.0 * turns_changed / turns_compared, 1) } else { 0.0 };
    let mut culprits: Vec<(String, f64)> = by_source.into_iter().collect();
    culprits.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    let culprit_txt =
        culprits.iter().map(|(s, t)| format!("{s}×{}", crate::summarize::helpers::fmt_js_num(*t))).collect::<Vec<_>>().join(", ");
    let verdict = if turns_changed == 0.0 {
        "tools[] is BYTE-STABLE across every turn — the tool catalog is NOT breaking this session's cache.".to_owned()
    } else {
        format!(
            "tools[] changed on {}/{} turns ({}%) — each change invalidates the ENTIRE prefix. Sources: {culprit_txt}.",
            crate::summarize::helpers::fmt_js_num(turns_changed),
            crate::summarize::helpers::fmt_js_num(turns_compared),
            crate::summarize::helpers::fmt_js_num(change_pct),
        )
    };
    let mut m = Map::new();
    m.insert("turnsCompared".into(), num(turns_compared));
    m.insert("turnsChanged".into(), num(turns_changed));
    m.insert("changePct".into(), num(change_pct));
    m.insert(
        "culpritSources".into(),
        Value::Array(
            culprits
                .iter()
                .map(|(source, turns)| {
                    let mut r = Map::new();
                    r.insert("source".into(), Value::String(source.clone()));
                    r.insert("turns".into(), num(*turns));
                    Value::Object(r)
                })
                .collect(),
        ),
    );
    m.insert("changes".into(), Value::Array(changes));
    m.insert("verdict".into(), Value::String(verdict));
    Value::Object(m)
}

fn gap_histogram(under10s: f64, s10to30: f64, s30to60: f64, m1to5: f64, over5m: f64) -> Value {
    let mut m = Map::new();
    m.insert("under10s".into(), num(under10s));
    m.insert("s10to30".into(), num(s10to30));
    m.insert("s30to60".into(), num(s30to60));
    m.insert("m1to5".into(), num(m1to5));
    m.insert("over5m".into(), num(over5m));
    Value::Object(m)
}

fn tool_surface(total: f64, deferred: f64, tokens_per_turn: f64, pct_of_context: f64, by_source: Vec<Value>) -> Value {
    let mut m = Map::new();
    m.insert("total".into(), num(total));
    m.insert("deferred".into(), num(deferred));
    m.insert("tokensPerTurn".into(), num(tokens_per_turn));
    m.insert("pctOfContext".into(), num(pct_of_context));
    m.insert("bySource".into(), Value::Array(by_source));
    Value::Object(m)
}

fn coverage_of(bodies_dir: &str, dir_exists: bool, files_scanned: f64, window_hours: f64, note: &str) -> Value {
    let mut m = Map::new();
    m.insert("bodiesDir".into(), Value::String(bodies_dir.to_owned()));
    m.insert("dirExists".into(), Value::Bool(dir_exists));
    m.insert("filesScanned".into(), num(files_scanned));
    m.insert("windowHours".into(), num(window_hours));
    m.insert("complete".into(), Value::Bool(true));
    m.insert("note".into(), Value::String(note.to_owned()));
    Value::Object(m)
}

fn empty_profile(session_id: &str, window_hours: f64, bodies_dir: &str, dir_exists: bool, note: &str) -> Value {
    let mut w = Map::new();
    w.insert("readWeighted".into(), num(0.0));
    w.insert("createWeighted".into(), num(0.0));
    w.insert("dominantTerm".into(), Value::String("transcript-reread".to_owned()));
    let mut ts = Map::new();
    ts.insert("turnsCompared".into(), num(0.0));
    ts.insert("turnsChanged".into(), num(0.0));
    ts.insert("changePct".into(), num(0.0));
    ts.insert("culpritSources".into(), Value::Array(Vec::new()));
    ts.insert("changes".into(), Value::Array(Vec::new()));
    ts.insert("verdict".into(), Value::String("no data".to_owned()));

    let mut m = Map::new();
    m.insert("sessionId".into(), Value::String(session_id.to_owned()));
    m.insert("windowHours".into(), num(window_hours));
    m.insert("requests".into(), num(0.0));
    m.insert("spanMinutes".into(), num(0.0));
    m.insert("turnsPerHour".into(), num(0.0));
    m.insert("gapHistogram".into(), gap_histogram(0.0, 0.0, 0.0, 0.0, 0.0));
    m.insert("cacheReadTotal".into(), num(0.0));
    m.insert("cacheCreateTotal".into(), num(0.0));
    m.insert("avgContextTokens".into(), num(0.0));
    m.insert("coldCalls".into(), num(0.0));
    m.insert("coldPct".into(), num(0.0));
    m.insert("costUsd".into(), num(0.0));
    m.insert("cacheCreateMedian".into(), num(0.0));
    m.insert("cacheCreateP90".into(), num(0.0));
    m.insert("turnsWithLargeCreate".into(), num(0.0));
    m.insert("createConcentrationPct".into(), num(0.0));
    m.insert("weighted".into(), Value::Object(w));
    m.insert("transcriptMessages".into(), num(0.0));
    m.insert("toolSurface".into(), tool_surface(0.0, 0.0, 0.0, 0.0, Vec::new()));
    m.insert("toolStability".into(), Value::Object(ts));
    m.insert("topToolUse".into(), Value::Array(Vec::new()));
    // `lastCallMinutesAgo: null` — there was no last call, which is NOT the same as "0 minutes ago".
    m.insert("lastCallMinutesAgo".into(), Value::Null);
    m.insert("active".into(), Value::Bool(false));
    m.insert("verdict".into(), Value::String("No requests found for this session in the scanned window.".to_owned()));
    m.insert("remediation".into(), Value::Array(Vec::new()));
    m.insert("coverage".into(), coverage_of(bodies_dir, dir_exists, 0.0, window_hours, note));
    Value::Object(m)
}

/// Full-parse EXACTLY ONE request (the newest) to break the tool surface down by source, and to
/// count the transcript length plus the tool_use frequency that reveals what the session is doing.
fn inspect_newest(path: &Path) -> (Value, Vec<Value>, f64) {
    let empty = (tool_surface(0.0, 0.0, 0.0, 0.0, Vec::new()), Vec::new(), 0.0);
    let Ok(raw) = std::fs::read_to_string(path) else { return empty };
    let Ok(body) = serde_json::from_str::<Value>(&raw) else { return empty };

    let no_tools: Vec<Value> = Vec::new();
    let tools = body.get("tools").and_then(Value::as_array).unwrap_or(&no_tools);
    let mut groups: IndexMap<String, (f64, f64, Vec<String>)> = IndexMap::new();
    let mut total_bytes = 0.0;
    let mut deferred = 0.0;
    for t in tools {
        let name = t.get("name").and_then(Value::as_str).unwrap_or("?").to_owned();
        let desc = t.get("description").and_then(Value::as_str).unwrap_or("");
        // `JSON.stringify(t.input_schema ?? {})` — NULLISH, so an explicit null becomes `{}` too.
        let schema = match t.get("input_schema") {
            Some(v) if !v.is_null() => v.to_string(),
            _ => "{}".to_owned(),
        };
        // `Buffer.byteLength` — UTF-8 BYTES, not characters.
        let bytes = (name.len() + desc.len() + schema.len()) as f64;
        total_bytes += bytes;
        let is_deferred = t.get("defer_loading") == Some(&Value::Bool(true));
        if is_deferred {
            deferred += 1.0;
        }
        let source = match cap1(rx_mcp_source(), &name) {
            Some(server) => format!("MCP: {server}"),
            // NOTE this differs from `sourceOf`: a deferred BUILT-IN gets its own bucket here, but
            // never in the stability diff — the diff cares who CHANGED, not how it loads.
            None if is_deferred => "built-in (deferred)".to_owned(),
            None => "built-in".to_owned(),
        };
        let g = groups.entry(source).or_insert((0.0, 0.0, Vec::new()));
        g.0 += 1.0;
        g.1 += bytes;
        if g.2.len() < 3 {
            g.2.push(name);
        }
    }
    let mut by_source: Vec<(String, f64, f64, Vec<String>)> =
        groups.into_iter().map(|(s, g)| (s, g.0, js_math_round(g.1 / CHARS_PER_TOKEN), g.2)).collect();
    by_source.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
    let by_source: Vec<Value> = by_source
        .into_iter()
        .map(|(source, tools, tokens, examples)| {
            let mut m = Map::new();
            m.insert("source".into(), Value::String(source));
            m.insert("tools".into(), num(tools));
            m.insert("tokensPerTurn".into(), num(tokens));
            m.insert("examples".into(), Value::Array(examples.into_iter().map(Value::String).collect()));
            Value::Object(m)
        })
        .collect();

    let no_msgs: Vec<Value> = Vec::new();
    let messages = body.get("messages").and_then(Value::as_array).unwrap_or(&no_msgs);
    let mut freq: IndexMap<String, f64> = IndexMap::new();
    for msg in messages {
        let Some(content) = msg.get("content").and_then(Value::as_array) else { continue };
        for b in content {
            if b.get("type").and_then(Value::as_str) == Some("tool_use") {
                if let Some(n) = b.get("name").and_then(Value::as_str) {
                    *freq.entry(n.to_owned()).or_insert(0.0) += 1.0;
                }
            }
        }
    }
    let mut top: Vec<(String, f64)> = freq.into_iter().collect();
    top.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    top.truncate(8);
    let top_tool_use: Vec<Value> = top
        .into_iter()
        .map(|(name, count)| {
            let mut m = Map::new();
            m.insert("name".into(), Value::String(name));
            m.insert("count".into(), num(count));
            Value::Object(m)
        })
        .collect();

    (
        tool_surface(tools.len() as f64, deferred, js_math_round(total_bytes / CHARS_PER_TOKEN), 0.0, by_source),
        top_tool_use,
        messages.len() as f64,
    )
}

#[derive(Default)]
struct Gaps {
    under10s: f64,
    s10to30: f64,
    s30to60: f64,
    m1to5: f64,
    over5m: f64,
}

impl Gaps {
    fn bucket(&mut self, sec: f64) {
        if sec < 10.0 {
            self.under10s += 1.0;
        } else if sec < 30.0 {
            self.s10to30 += 1.0;
        } else if sec < 60.0 {
            self.s30to60 += 1.0;
        } else if sec < 300.0 {
            self.m1to5 += 1.0;
        } else {
            self.over5m += 1.0;
        }
    }
}

/// Build the one-line verdict plus the ordered remediation list. Ranked by what actually dominates
/// the cost model (turns × context), never by what is merely easy to change.
fn judge(p: &Value) -> (String, Vec<String>) {
    let n = |k: &str| p.get(k).and_then(Value::as_f64).unwrap_or(0.0);
    let requests = n("requests");
    if requests == 0.0 {
        return ("No activity in the window.".to_owned(), Vec::new());
    }
    let read_m = js_to_fixed_str(n("cacheReadTotal") / 1e6, 1);
    let create_m = js_to_fixed_str(n("cacheCreateTotal") / 1e6, 1);
    let median_create = n("cacheCreateMedian");
    // THE DECISIVE BRANCH: a mutating prefix re-writes on essentially every turn ⇒ a LARGE median.
    // Stable append-only growth writes only the new tail ⇒ a small median, with the total
    // concentrated in a few break events.
    let mutating = median_create > LARGE_CREATE_FLOOR;
    let stab = &p["toolStability"];
    let change_pct = stab.get("changePct").and_then(Value::as_f64).unwrap_or(0.0);
    let tools_unstable = change_pct >= 5.0;
    let f = crate::summarize::helpers::fmt_js_num;

    let empty: Vec<Value> = Vec::new();
    let culprits = stab.get("culpritSources").and_then(Value::as_array).unwrap_or(&empty);
    let culprit_txt = culprits
        .iter()
        .map(|c| {
            format!(
                "{}×{}",
                c.get("source").and_then(Value::as_str).unwrap_or(""),
                f(c.get("turns").and_then(Value::as_f64).unwrap_or(0.0))
            )
        })
        .collect::<Vec<_>>()
        .join(", ");

    let mut rem: Vec<String> = Vec::new();
    if tools_unstable {
        let mcp: Vec<&str> = culprits
            .iter()
            .filter_map(|c| c.get("source").and_then(Value::as_str))
            .filter(|s| s.starts_with("MCP:"))
            // `.slice(5)` — drops "MCP: " including the space.
            .map(|s| &s[5..])
            .collect();
        rem.push(format!(
            "MAKE tools[] FIXED — it changed on {}/{} turns ({}%), and a tool change invalidates the ENTIRE prefix. Sources: {culprit_txt}.",
            f(stab.get("turnsChanged").and_then(Value::as_f64).unwrap_or(0.0)),
            f(stab.get("turnsCompared").and_then(Value::as_f64).unwrap_or(0.0)),
            f(change_pct),
        ));
        if !mcp.is_empty() {
            rem.push(format!(
                "Pin those MCP servers so their tool set never moves: keep them connected for the WHOLE session (a disconnect/reconnect or lazy start adds/removes their tools), do not run /reload-plugins mid-session, and do not toggle them. Affected: {}.",
                mcp.join(", ")
            ));
        }
        rem.push("Pin `tools:` in every sub-agent frontmatter — an agent with no `tools:` inherits the LIVE tool set, so its catalog drifts whenever any server connects or disconnects.".to_owned());
        rem.push("Keep tool-search/deferral OFF: a defer/undefer re-load also mutates tools[]. Resident-but-stable beats deferred-but-churning.".to_owned());
    } else if p.pointer("/toolSurface/total").and_then(Value::as_f64).unwrap_or(0.0) > 0.0 {
        rem.push(format!(
            "tools[] is stable ({}% of turns changed) — the tool catalog is NOT the culprit here; its {} tok/turn are cached and re-READ, not re-written.",
            f(change_pct),
            to_locale_en(p.pointer("/toolSurface/tokensPerTurn").and_then(Value::as_f64).unwrap_or(0.0)),
        ));
    }

    let cold_pct = n("coldPct");
    let avg_ctx = n("avgContextTokens");
    if cold_pct >= 50.0 {
        rem.push("The cache never warms: calls arrive further apart than the TTL, so each pays a full cold prefix write. Fire within the 5-min TTL, or stop the periodic trigger.".to_owned());
    }
    if mutating {
        rem.push(format!(
            "The prefix is re-written on MOST turns (median cache_create {}). Something above the transcript changes every turn — check toolStability, hook injections into the cached prefix, and model switches.",
            to_locale_en(median_create)
        ));
    } else if avg_ctx > 200_000.0 {
        rem.push(format!(
            "Prefix is stable (median cache_create {} = append-only growth); the cost is the RE-READ: ~{}k tokens × {} turns ({} messages). Compact or start a fresh session.",
            to_locale_en(median_create),
            f(js_math_round(avg_ctx / 1000.0)),
            f(requests),
            f(n("transcriptMessages")),
        ));
    }
    let turns_per_hour = n("turnsPerHour");
    if turns_per_hour > 60.0 {
        rem.push(format!(
            "~{} turns/hour: an unattended loop. Turns are a linear multiplier on both terms — stop it or batch its work.",
            f(js_math_round(turns_per_hour))
        ));
    }

    let g = |k: &str| p.pointer(&format!("/gapHistogram/{k}")).and_then(Value::as_f64).unwrap_or(0.0);
    let loop_gaps = g("under10s") + g("s10to30");
    let dominant = if cold_pct >= 50.0 {
        format!("COLD-START LOOP — {}/{} calls read zero cache", f(n("coldCalls")), f(requests))
    } else if mutating {
        format!("PREFIX REWRITTEN EVERY TURN — median cache_create {}", to_locale_en(median_create))
    } else if avg_ctx > 200_000.0 && requests > 100.0 {
        format!(
            "MARATHON RE-READ — {} turns × ~{}k context = {read_m}M tokens re-read",
            f(requests),
            f(js_math_round(avg_ctx / 1000.0))
        )
    } else {
        format!("{} turns, ~{}k avg context", f(requests), f(js_math_round(avg_ctx / 1000.0)))
    };

    // The weighted comparison is the ONLY honest way to say which term dominates: a cache_read is
    // 0.1x but a cache_create is 1.25x, so 20k of create can outweigh 200k of read.
    let rw = p.pointer("/weighted/readWeighted").and_then(Value::as_f64).unwrap_or(0.0);
    let cw = p.pointer("/weighted/createWeighted").and_then(Value::as_f64).unwrap_or(0.0);
    let dom = if p.pointer("/weighted/dominantTerm").and_then(Value::as_str) == Some("prefix-rewrite") {
        format!(
            "DOMINANT COST = prefix-rewrite ({}M weighted vs {}M for re-reads)",
            js_to_fixed_str(cw / 1e6, 1),
            js_to_fixed_str(rw / 1e6, 1)
        )
    } else {
        format!(
            "DOMINANT COST = transcript re-read ({}M weighted vs {}M for rewrites)",
            js_to_fixed_str(rw / 1e6, 1),
            js_to_fixed_str(cw / 1e6, 1)
        )
    };

    let idle = if p.get("active") == Some(&Value::Bool(true)) {
        "STILL ACTIVE".to_owned()
    } else {
        // `p.lastCallMinutesAgo?.toFixed(0)` — optional chaining, so a null renders "undefined".
        match p.get("lastCallMinutesAgo").and_then(Value::as_f64) {
            Some(v) => format!("idle {} min", js_to_fixed_str(v, 0)),
            None => "idle undefined min".to_owned(),
        }
    };

    let verdict = format!(
        "{dominant}. {dom}. {read_m}M cache_read + {create_m}M cache_create ≈ ${} in {} min; median create {}, p90 {}, {} big-write turns holding {}% of all writes. {} {} of {} gaps under 30s. {idle}.",
        js_to_fixed_str(n("costUsd"), 2),
        js_to_fixed_str(n("spanMinutes"), 0),
        to_locale_en(median_create),
        to_locale_en(n("cacheCreateP90")),
        f(n("turnsWithLargeCreate")),
        f(n("createConcentrationPct")),
        stab.get("verdict").and_then(Value::as_str).unwrap_or(""),
        f(loop_gaps),
        f(requests - 1.0),
    );
    (verdict, rem)
}

#[derive(Clone, Debug, Default)]
pub struct SessionBurnProfileOptions {
    /// Full id, or a unique PREFIX.
    pub session_id: String,
    pub window_hours: Option<f64>,
}

/// One-call burn diagnosis for a single session. Bounded by an mtime window plus a file-size cap;
/// the newest request is the only body fully parsed. Coverage is always reported honestly.
pub fn build_session_burn_profile(bodies_dir: &Path, opts: &SessionBurnProfileOptions, now_ms: f64) -> Value {
    let dir_str = bodies_dir.to_string_lossy().into_owned();
    let window_hours = opts.window_hours.unwrap_or(6.0);
    let target = &opts.session_id;
    if !bodies_dir.exists() {
        return empty_profile(
            target,
            window_hours,
            &dir_str,
            false,
            &format!("No OTEL raw-body directory at {dir_str} — set OTEL_LOG_RAW_API_BODIES to capture bodies."),
        );
    }

    let cutoff = now_ms - window_hours * 3_600_000.0;
    let mut reqs: Vec<ReqEntry> = Vec::new();
    let mut resp_by_id: IndexMap<String, (f64, f64)> = IndexMap::new();
    let mut scanned = 0.0;

    // Sorted, unlike `readdirSync`: Node's order is filesystem-dependent, and `Map.set` overwrites,
    // so the TS's winner for two responses carrying the SAME msg id is whatever the filesystem
    // listed last. A sorted walk is the only reproducible version of that tie.
    let mut names: Vec<String> = match std::fs::read_dir(bodies_dir) {
        Ok(entries) => entries.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect(),
        Err(_) => Vec::new(),
    };
    names.sort();
    for name in names {
        let is_req = name.ends_with(".request.json");
        let is_resp = name.ends_with(".response.json");
        if !is_req && !is_resp {
            continue;
        }
        let p = bodies_dir.join(&name);
        let Ok(st) = std::fs::metadata(&p) else { continue };
        let mtime = st
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
        if mtime < cutoff || st.len() > MAX_BYTES {
            continue;
        }
        let Ok(s) = std::fs::read_to_string(&p) else { continue };
        scanned += 1.0;
        if is_resp {
            if let Some(id) = cap1(rx_msg_id(), &s) {
                let g = |rx: &regex::Regex| cap1(rx, &s).and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.0);
                resp_by_id.insert(id, (g(rx_read()), g(rx_create())));
            }
        } else if let Some(sess) = session_id_of(&s) {
            // A PREFIX match — the caller may pass a short unique id.
            if sess.starts_with(target.as_str()) {
                reqs.push(ReqEntry {
                    path: p,
                    mtime,
                    model: cap1(rx_model(), &s).unwrap_or_default(),
                    prev: cap1(rx_prev(), &s),
                    tool_names: extract_tool_names(&s),
                });
            }
        }
    }

    let note = format!(
        "Scanned {} body file(s) modified in the last {}h (files >{}MB skipped).",
        crate::summarize::helpers::fmt_js_num(scanned),
        crate::summarize::helpers::fmt_js_num(window_hours),
        crate::summarize::helpers::fmt_js_num(MAX_BYTES as f64 / 1e6),
    );
    if reqs.is_empty() {
        return empty_profile(target, window_hours, &dir_str, true, &note);
    }

    reqs.sort_by(|a, b| a.mtime.partial_cmp(&b.mtime).unwrap_or(std::cmp::Ordering::Equal));
    let mut gaps = Gaps::default();
    let (mut read_total, mut create_total, mut cold_calls, mut usable, mut cost_usd) = (0.0, 0.0, 0.0, 0.0, 0.0);
    let mut creates: Vec<f64> = Vec::new();
    for i in 0..reqs.len() {
        if i > 0 {
            gaps.bucket((reqs[i].mtime - reqs[i - 1].mtime) / 1000.0);
        }
        // Turn i's usage lives on the response whose id == turn i+1's previous_message_id — the
        // proven chain. The LAST turn therefore has no usage, by construction, not by omission.
        let Some(prev) = reqs.get(i + 1).and_then(|r| r.prev.as_deref()) else { continue };
        let Some(&(read, create)) = resp_by_id.get(prev) else { continue };
        usable += 1.0;
        read_total += read;
        create_total += create;
        creates.push(create);
        if read == 0.0 && create > COLD_CREATE_FLOOR {
            cold_calls += 1.0;
        }
        cost_usd += calc_token_cost_usd(0.0, read, create, 0.0, &reqs[i].model, 0.0, None, now_ms);
    }

    let large: Vec<f64> = creates.iter().copied().filter(|c| *c > LARGE_CREATE_FLOOR).collect();
    let large_sum: f64 = large.iter().sum();
    let read_weighted = js_math_round(read_total * READ_WEIGHT);
    let create_weighted = js_math_round(create_total * CREATE_WEIGHT);

    let first = reqs[0].mtime;
    let last = reqs[reqs.len() - 1].mtime;
    let span_minutes = (last - first) / 60000.0;
    let (surface, top_tool_use, transcript_messages) = inspect_newest(&reqs[reqs.len() - 1].path);
    let avg_context = if usable > 0.0 { js_math_round(read_total / usable) } else { 0.0 };
    let last_call_min_ago = (now_ms - last) / 60000.0;

    let mut w = Map::new();
    w.insert("readWeighted".into(), num(read_weighted));
    w.insert("createWeighted".into(), num(create_weighted));
    w.insert(
        "dominantTerm".into(),
        Value::String(if create_weighted > read_weighted { "prefix-rewrite".into() } else { "transcript-reread".to_string() }),
    );

    let tokens_per_turn = surface.get("tokensPerTurn").and_then(Value::as_f64).unwrap_or(0.0);
    let surface = tool_surface(
        surface.get("total").and_then(Value::as_f64).unwrap_or(0.0),
        surface.get("deferred").and_then(Value::as_f64).unwrap_or(0.0),
        tokens_per_turn,
        if avg_context > 0.0 { js_to_fixed_num(100.0 * tokens_per_turn / avg_context, 1) } else { 0.0 },
        surface.get("bySource").and_then(Value::as_array).cloned().unwrap_or_default(),
    );

    let mut m = Map::new();
    m.insert("sessionId".into(), Value::String(target.clone()));
    m.insert("windowHours".into(), num(window_hours));
    m.insert("requests".into(), num(reqs.len() as f64));
    m.insert("spanMinutes".into(), num(js_to_fixed_num(span_minutes, 1)));
    m.insert(
        "turnsPerHour".into(),
        num(if span_minutes > 0.0 { js_to_fixed_num(reqs.len() as f64 / (span_minutes / 60.0), 1) } else { 0.0 }),
    );
    m.insert("gapHistogram".into(), gap_histogram(gaps.under10s, gaps.s10to30, gaps.s30to60, gaps.m1to5, gaps.over5m));
    m.insert("cacheReadTotal".into(), num(read_total));
    m.insert("cacheCreateTotal".into(), num(create_total));
    m.insert("avgContextTokens".into(), num(avg_context));
    m.insert("coldCalls".into(), num(cold_calls));
    m.insert("coldPct".into(), num(if usable > 0.0 { js_to_fixed_num(100.0 * cold_calls / usable, 1) } else { 0.0 }));
    m.insert("costUsd".into(), num(js_to_fixed_num(cost_usd, 2)));
    m.insert("cacheCreateMedian".into(), num(median(&creates)));
    m.insert("cacheCreateP90".into(), num(percentile(&creates, 90.0)));
    m.insert("turnsWithLargeCreate".into(), num(large.len() as f64));
    m.insert(
        "createConcentrationPct".into(),
        num(if create_total > 0.0 { js_to_fixed_num(100.0 * large_sum / create_total, 1) } else { 0.0 }),
    );
    m.insert("weighted".into(), Value::Object(w));
    m.insert("transcriptMessages".into(), num(transcript_messages));
    m.insert("toolSurface".into(), surface);
    m.insert("toolStability".into(), analyze_tool_stability(&reqs));
    m.insert("topToolUse".into(), Value::Array(top_tool_use));
    m.insert("lastCallMinutesAgo".into(), num(js_to_fixed_num(last_call_min_ago, 1)));
    m.insert("active".into(), Value::Bool(last_call_min_ago < ACTIVE_WITHIN_MIN));
    m.insert("verdict".into(), Value::String(String::new()));
    m.insert("remediation".into(), Value::Array(Vec::new()));
    m.insert("coverage".into(), coverage_of(&dir_str, true, scanned, window_hours, &note));

    let mut profile = Value::Object(m);
    // `judge` reads the profile's ALREADY-ROUNDED fields, so it must run after they are set —
    // judging the raw values would print numbers the payload does not contain.
    let (verdict, remediation) = judge(&profile);
    profile["verdict"] = Value::String(verdict);
    profile["remediation"] = Value::Array(remediation.into_iter().map(Value::String).collect());
    profile
}

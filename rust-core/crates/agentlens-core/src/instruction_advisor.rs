//! Instruction Advisor (TRDD-DMWOBWFH row 19) — port of src/instructionAdvisor.ts: PURE
//! analysis over workspace-pre-filtered session cards, no I/O. Cards are serde_json Values
//! (the gate's Value-state design law), so the TS oracle's case list drives both engines and
//! every suggestion — evidence strings included — must Value-equal.

use indexmap::IndexMap;
use serde_json::{json, Value};

use crate::summarize::helpers::{fmt_js_num, js_math_round, js_to_fixed_num, utf16_len};

fn f(v: &Value, k: &str) -> f64 {
    // Absent card fields propagate as NaN in the TS arithmetic — mirrored, not defaulted.
    v.get(k).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

fn sid(v: &Value) -> String {
    s(v, "sessionId").unwrap_or("").to_owned()
}

/// sessionCost — inputTokens IS the raw uncached input (the 2026-07-10 one-convention fix);
/// `cacheCreateTokens ?? 0` is the one defaulted bucket, as in the TS.
fn session_cost(v: &Value) -> f64 {
    crate::pricing::calc_token_cost_usd(
        f(v, "inputTokens"),
        f(v, "cacheReadTokens"),
        v.get("cacheCreateTokens").and_then(Value::as_f64).unwrap_or(0.0),
        f(v, "outputTokens"),
        s(v, "model").unwrap_or(""),
        0.0,
        None,
        crate::now_ms() as f64,
    )
}

fn subsystem_from_path(p: &str) -> String {
    let norm = p.replace('\\', "/");
    let parts: Vec<&str> = norm.split('/').collect();
    if parts.len() >= 2 { parts[parts.len() - 2].to_owned() } else { "this area".to_owned() }
}

fn role_from_filename(name: &str) -> String {
    let base = name.split('.').next().unwrap_or("");
    match base {
        "types" => "shared type definitions".to_owned(),
        "schema" => "data schema definitions".to_owned(),
        "helpers" => "shared utility functions".to_owned(),
        "utils" => "utility functions".to_owned(),
        "config" => "configuration".to_owned(),
        "constants" => "constants and enums".to_owned(),
        "index" => "module entry point".to_owned(),
        "db" => "database access layer".to_owned(),
        "state" => "application state".to_owned(),
        other => format!("{other} definitions"),
    }
}

/// `${category}:${key.replace(/[^a-z0-9]/gi, '_').toLowerCase()}` — per-CHAR replacement (no
/// run collapsing), then lowercased.
fn make_id(category: &str, key: &str) -> String {
    let mangled: String = key.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect();
    format!("{category}:{}", mangled.to_lowercase())
}

/// `basename.pop()` of a '/'-split — JS pop() on a split result is never undefined (a split
/// always yields ≥1 element), so the `?? file` fallback is dead in both engines.
fn basename_of(file: &str) -> String {
    file.replace('\\', "/").split('/').next_back().unwrap_or(file).to_owned()
}

/// file → sessionIds, insertion-ordered like the JS Map, deduped per session.
fn file_freq(sessions: &[Value], fields: &[&str]) -> IndexMap<String, Vec<String>> {
    let mut freq: IndexMap<String, Vec<String>> = IndexMap::new();
    for sess in sessions {
        let mut seen: Vec<&str> = Vec::new();
        for field in fields {
            for fv in sess.get(*field).and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
                let Some(file) = fv.as_str() else { continue };
                if seen.contains(&file) {
                    continue;
                }
                seen.push(file);
                freq.entry(file.to_owned()).or_default().push(sid(sess));
            }
        }
    }
    freq
}

pub fn get_hot_file_suggestions(sessions: &[Value], existing: &str) -> Vec<Value> {
    if sessions.len() < 5 {
        return Vec::new();
    }
    let freq = file_freq(sessions, &["filesRead", "filesChanged"]);
    let threshold = 0.4;
    let existing_lower = existing.to_lowercase();
    let mut results: Vec<Value> = Vec::new();
    for (file, session_ids) in &freq {
        let pct = session_ids.len() as f64 / sessions.len() as f64;
        if pct < threshold {
            continue;
        }
        let basename = basename_of(file);
        // Skip if already mentioned in instruction files; skip very short/generic names.
        if existing_lower.contains(&basename.to_lowercase()) {
            continue;
        }
        if utf16_len(&basename) < 4 || basename == "index.ts" || basename == "index.js" {
            continue;
        }
        let pct_label = fmt_js_num(js_math_round(pct * 100.0));
        let subsystem = subsystem_from_path(file);
        let role = role_from_filename(basename.split('.').next().unwrap_or(""));
        results.push(json!({
            "id": make_id("hot_file", file),
            "category": "context",
            "title": format!("Add {basename} to instruction file"),
            "evidence": format!("Read in {} of {} sessions ({pct_label}%). Each agent discovery adds ~2–3 turns.", session_ids.len(), sessions.len()),
            "suggestedText": format!("Always read `{file}` before editing {subsystem} — it contains {role}."),
            "targetAgents": ["claude_code", "codex"],
            "priority": if pct >= 0.6 { "high" } else { "medium" },
            "evidenceSessions": session_ids,
        }));
    }
    // Stable sort by evidence count desc (JS sort stability), top 6.
    results.sort_by_key(|c| std::cmp::Reverse(c["evidenceSessions"].as_array().map_or(0, Vec::len)));
    results.truncate(6);
    results
}

pub fn get_loop_prevention_suggestions(sessions: &[Value]) -> Vec<Value> {
    if sessions.len() < 5 {
        return Vec::new();
    }
    let signal_text = |t: &str| -> Option<&'static str> {
        match t {
            "exact_tool_repeat" => Some(
                "After reading a file, do not re-read it unless you have modified it. If a tool call produces no new information, stop and ask the user rather than retrying.",
            ),
            "edit_revert_cycle" => Some(
                "Before editing any file, state the exact final state you intend to produce. Do not oscillate between two states — if a second edit would revert a prior one, stop and ask for clarification.",
            ),
            "error_recurrence" => Some(
                "If the same error appears twice, do not attempt a third fix without pausing to verify that the package, function, or file path actually exists.",
            ),
            "runaway_steps" => Some(
                "Each task must have an explicit stopping condition. If a task has no clear end state, ask before starting. Break multi-step work into one task at a time.",
            ),
            "token_runaway" => Some(
                "If input context exceeds 80K tokens without producing a final result, stop and summarize what you have tried so the user can redirect you.",
            ),
            _ => None,
        }
    };
    let mut signal_sessions: IndexMap<String, Vec<String>> = IndexMap::new();
    for sess in sessions {
        for sig in sess.get("loopSignals").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]) {
            let Some(t) = sig.get("type").and_then(Value::as_str) else { continue };
            signal_sessions.entry(t.to_owned()).or_default().push(sid(sess));
        }
    }
    let mut results = Vec::new();
    let threshold = 0.2;
    for (t, session_ids) in &signal_sessions {
        let pct = session_ids.len() as f64 / sessions.len() as f64;
        if pct < threshold {
            continue;
        }
        let Some(text) = signal_text(t) else { continue };
        let pct_label = fmt_js_num(js_math_round(pct * 100.0));
        results.push(json!({
            "id": make_id("loop", t),
            "category": "behavior",
            "title": format!("Prevent {} loops", t.replace('_', " ")),
            "evidence": format!("Signal \"{t}\" detected in {} of {} sessions ({pct_label}%).", session_ids.len(), sessions.len()),
            "suggestedText": text,
            "targetAgents": ["claude_code", "codex"],
            "priority": if pct >= 0.4 { "high" } else { "medium" },
            "evidenceSessions": session_ids,
        }));
    }
    results
}

pub fn get_front_loaded_discovery_suggestions(sessions: &[Value], existing: &str) -> Vec<Value> {
    if sessions.len() < 8 {
        return Vec::new();
    }
    let freq = file_freq(sessions, &["filesRead"]);
    let threshold = 0.5;
    let existing_lower = existing.to_lowercase();
    let mut candidates: Vec<(String, Vec<String>)> = Vec::new();
    for (file, session_ids) in freq {
        if session_ids.len() as f64 / sessions.len() as f64 >= threshold {
            let basename = basename_of(&file);
            if existing_lower.contains(&basename.to_lowercase()) {
                continue;
            }
            candidates.push((file, session_ids));
        }
    }
    if candidates.len() < 2 {
        return Vec::new();
    }
    candidates.sort_by_key(|c| std::cmp::Reverse(c.1.len()));
    let top = &candidates[..candidates.len().min(4)];
    // Set over flatMap — insertion order, first occurrence wins (evidenceSessions order parity).
    let mut all_ids: Vec<String> = Vec::new();
    for (_, ids) in top {
        for id in ids {
            if !all_ids.contains(id) {
                all_ids.push(id.clone());
            }
        }
    }
    let pct = fmt_js_num(js_math_round(all_ids.len() as f64 / sessions.len() as f64 * 100.0));
    let paths: Vec<&str> = top.iter().map(|(file, _)| file.as_str()).collect();
    let subsystem = subsystem_from_path(paths[0]);
    let lines: Vec<String> = top
        .iter()
        .map(|(file, _)| {
            let basename = basename_of(file);
            format!("- `{file}` — {}", role_from_filename(basename.split('.').next().unwrap_or("")))
        })
        .collect();
    vec![json!({
        "id": make_id("discovery", &paths.join(",")),
        "category": "context",
        "title": format!("Pre-load {subsystem} entry points"),
        "evidence": format!("These files appear early in {pct}% of sessions — the agent always discovers them before doing useful work."),
        "suggestedText": format!("Key entry points for {subsystem}:\n{}\nReview these before beginning any {subsystem} task.", lines.join("\n")),
        "targetAgents": ["claude_code", "codex"],
        "priority": "medium",
        "evidenceSessions": all_ids,
    })]
}

pub fn get_scope_suggestions(sessions: &[Value]) -> Vec<Value> {
    if sessions.len() < 8 {
        return Vec::new();
    }
    let avg_cost = sessions.iter().map(session_cost).sum::<f64>() / sessions.len() as f64;
    if avg_cost == 0.0 {
        return Vec::new();
    }
    // SCOPE_PATTERNS — `(?-u:\b)` = the ASCII word boundary a JS non-/u regex uses.
    static PATTERNS: std::sync::OnceLock<Vec<regex::Regex>> = std::sync::OnceLock::new();
    let patterns = PATTERNS.get_or_init(|| {
        [
            r"(?i)(?-u:\b)refactor(?-u:\b)|(?-u:\b)clean up(?-u:\b)|(?-u:\b)clean-up(?-u:\b)|(?-u:\b)improve(?-u:\b)|(?-u:\b)optimize(?-u:\b)",
            r"(?i)(?-u:\b)fix the bug(?-u:\b)|(?-u:\b)make it work(?-u:\b)|(?-u:\b)it'?s broken(?-u:\b)",
            r"(?i)(?-u:\b)find all(?-u:\b)|(?-u:\b)look through(?-u:\b)|(?-u:\b)check everywhere(?-u:\b)",
            r"(?i);\s*also(?-u:\b)|and then(?-u:\b)|(?-u:\b)finally(?-u:\b)",
        ]
        .iter()
        .map(|p| regex::Regex::new(p).expect("static regex"))
        .collect()
    });
    let mut matching: Vec<String> = Vec::new();
    let mut match_cost = 0.0;
    for sess in sessions {
        let req = s(sess, "userRequest").unwrap_or("");
        if patterns.iter().any(|p| p.is_match(req)) {
            matching.push(sid(sess));
            match_cost += session_cost(sess);
        }
    }
    if matching.len() < 3 {
        return Vec::new();
    }
    let match_avg = match_cost / matching.len() as f64;
    if match_avg < avg_cost * 1.8 {
        return Vec::new();
    }
    let pct = fmt_js_num(js_math_round(matching.len() as f64 / sessions.len() as f64 * 100.0));
    // `(matchAvg / avgCost).toFixed(1)` — the exact JS rounding, printed with one decimal.
    let ratio = format!("{:.1}", js_to_fixed_num(match_avg / avg_cost, 1));
    vec![json!({
        "id": "prompting:scope",
        "category": "prompting",
        "title": "Add scope prompting guidance",
        "evidence": format!("Sessions with open-ended language cost {ratio}× average ({} of {} sessions, {pct}%).", matching.len(), sessions.len()),
        "suggestedText": "Prompting guidance:\n- Always name the specific file and function. Don't say \"refactor\" — say \"refactor [function] in [file]\".\n- State the exact error message when reporting a bug, not just that something is broken.\n- One task at a time. Multi-part prompts (\"fix X, then also do Y\") should be split into separate sessions.",
        "targetAgents": ["claude_code", "copilot", "codex"],
        "priority": "medium",
        "evidenceSessions": matching,
    })]
}

pub fn get_tool_discipline_suggestions(sessions: &[Value]) -> Vec<Value> {
    if sessions.len() < 8 {
        return Vec::new();
    }
    let mut heavy: Vec<String> = Vec::new();
    for sess in sessions {
        let count = |t: &str| sess.get("toolCounts").and_then(|c| c.get(t)).and_then(Value::as_f64).unwrap_or(0.0);
        let (bash, read) = (count("Bash"), count("Read"));
        if bash > 0.0 && read > 0.0 && bash > read * 3.0 {
            heavy.push(sid(sess));
        }
    }
    if heavy.len() < 8 {
        return Vec::new();
    }
    let pct = fmt_js_num(js_math_round(heavy.len() as f64 / sessions.len() as f64 * 100.0));
    vec![json!({
        "id": "behavior:tool_discipline",
        "category": "behavior",
        "title": "Prefer Read tool over Bash for file inspection",
        "evidence": format!("Bash calls exceed Read calls by 3× in {} of {} sessions ({pct}%).", heavy.len(), sessions.len()),
        "suggestedText": "Prefer the Read tool over Bash for file inspection. Use Bash only for shell operations that cannot be done with a dedicated tool. Do not use cat, head, or tail to read file contents.",
        "targetAgents": ["claude_code", "codex"],
        "priority": "low",
        "evidenceSessions": heavy,
    })]
}

/// generateSuggestions — the master generator, in the TS concatenation order.
pub fn generate_suggestions(sessions: &[Value], existing: &str) -> Vec<Value> {
    if sessions.len() < 5 {
        return Vec::new();
    }
    let mut out = get_hot_file_suggestions(sessions, existing);
    out.extend(get_loop_prevention_suggestions(sessions));
    out.extend(get_front_loaded_discovery_suggestions(sessions, existing));
    out.extend(get_scope_suggestions(sessions));
    out.extend(get_tool_discipline_suggestions(sessions));
    out
}

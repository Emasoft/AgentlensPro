//! Cache-risk slash commands read straight out of the Claude Code transcripts (TRDD-DMWOBWFH
//! row 9) — ports src/cacheRiskCommands.ts + the src/shared/cacheRiskKinds.ts classifier.
//!
//! WHY a transcript scan and not a hook: there is no plugin-reload hook event, built-ins do
//! not fire UserPromptSubmit, and ConfigChange was measured and REFUTED as a reload signal —
//! but Claude Code persists every built-in command as a `type:"user"` entry whose content is a
//! `<command-name>…</command-name>` block, retroactively for the whole history. `mutation`
//! distinguishes commands that ALWAYS mutate the prefix from menu-openers that only might;
//! /fork, /subtask, /branch and /resume are DELIBERATELY absent (their cost lands in a
//! DIFFERENT context than the session the command was typed in — classifying them here would
//! bill a child context's cold start to the parent's next turn).

use std::path::PathBuf;

use indexmap::IndexMap;
use serde_json::{json, Map, Value};

use crate::summarize::helpers::{num, parse_iso_ms};

/// classifySlashCommand — (kind, mutation) or None for commands that do not touch the typed-in
/// session's cached prefix. Pure and table-driven: the vocabulary lives in exactly one place.
pub fn classify_slash_command(name: &str, args: Option<&str>) -> Option<(&'static str, &'static str)> {
    let cmd = name.trim().to_lowercase();
    let a = args.unwrap_or("").trim().to_owned();
    match cmd.as_str() {
        "/reload-plugins" => Some(("PLUGINS_RELOADED", "certain")),
        "/reload-skills" => Some(("SKILLS_RELOADED", "certain")),
        "/login" | "/logout" => Some(("ACCOUNT_SWITCHED", "certain")),
        // Before CC 2.1.273 these discarded earlier thinking exactly like /login did (the real
        // mechanism of that break, not the account), forcing a full prompt-cache rewrite.
        // `gate_by_cc_version` drops them on a transcript from a fixed version.
        "/upgrade" | "/extra-usage" => Some(("ACCOUNT_SWITCHED", "certain")),
        "/compact" => Some(("COMPACTION", "certain")),
        "/clear" => Some(("CLEAR", "certain")),
        // Menu-driven commands: an argument means the user named the mutation outright; bare
        // invocation only OPENS the picker and may change nothing at all.
        "/plugin" | "/plugins" => {
            if a.is_empty() {
                return Some(("PLUGIN_CHANGED", "ambiguous"));
            }
            // `/plugin plugin update x` appears in real transcripts — strip one redundant
            // leading `plugin` before testing the verb.
            static STRIP: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
            static MUTATING: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
            let strip = STRIP.get_or_init(|| regex::Regex::new(r"(?i)^plugins?\s+").expect("static regex"));
            let mutating =
                MUTATING.get_or_init(|| regex::Regex::new(r"(?i)^(install|uninstall|remove|enable|disable|update|marketplace)\b").expect("static regex"));
            if mutating.is_match(&strip.replace(&a, "")) {
                Some(("PLUGIN_CHANGED", "certain"))
            } else {
                None
            }
        }
        "/mcp" => Some(("MCP_SERVER_TOGGLE", "ambiguous")),
        "/model" => Some(("MODEL_SWITCHED", if a.is_empty() { "ambiguous" } else { "certain" })),
        "/effort" => Some(("EFFORT_CHANGED", if a.is_empty() { "ambiguous" } else { "certain" })),
        _ => None,
    }
}

/// gateByCcVersion — re-grade a classified command against the Claude Code version that wrote the
/// transcript, because several of these breaks were HARNESS behaviour that a later CC fixed
/// (TRDD-ZQQYRYBO I6). Blaming them on a fixed version tells the user to change a setup that is no
/// longer the cause. An absent version means an older transcript, so it keeps the old grading.
/// `model` is the most recent assistant model seen before the command in the same file.
/// Returns None when the command no longer touches the prefix at all.
pub fn gate_by_cc_version(
    command: &str,
    kind: &'static str,
    mutation: &'static str,
    version: Option<&str>,
    model: Option<&str>,
) -> Option<(&'static str, &'static str)> {
    use crate::loaded_plugin_versions::compare_versions;
    use std::cmp::Ordering::Less;
    let Some(v) = version.filter(|v| !v.is_empty()) else { return Some((kind, mutation)) };
    let at_least = |fixed: &str| compare_versions(v, fixed) != Less;
    let cmd = command.trim().to_lowercase();
    match kind {
        // 2.1.273: /login, /upgrade and /extra-usage no longer discard thinking. /upgrade and
        // /extra-usage keep the account, so nothing is left to break; a re-login may still land on a
        // different organization, whose cache the old one cannot read, so it stays possible.
        "ACCOUNT_SWITCHED" if at_least("2.1.273") => {
            if cmd == "/upgrade" || cmd == "/extra-usage" {
                None
            } else {
                Some((kind, "ambiguous"))
            }
        }
        // 2.1.260: /effort on Fable 5.1 is sent as a per-message change that keeps the cache.
        "EFFORT_CHANGED" if at_least("2.1.260") && model.is_some_and(is_fable_5_1) => Some((kind, "ambiguous")),
        // 2.1.267: tools that arrive mid-session load deferred, and a disconnected server no longer
        // rewrites the tool list (the last case, tool search off, fixed in 2.1.281).
        "PLUGINS_RELOADED" | "PLUGIN_CHANGED" | "MCP_SERVER_TOGGLE" if at_least("2.1.267") => Some((kind, "ambiguous")),
        _ => Some((kind, mutation)),
    }
}

/// `claude-fable-5-1`, dated or suffixed, but never a later `claude-fable-5-10`.
fn is_fable_5_1(model: &str) -> bool {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"(?i)fable-5-1(?:[^0-9]|$)").expect("static regex")).is_match(model)
}

/// The latest `"model":"…"` on a raw transcript line, read without parsing the JSON: the scan
/// already skips JSON-parsing every line that holds no command, and a substring search keeps it so.
fn model_on_line(line: &str) -> Option<String> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| regex::Regex::new(r#""model":"(claude-[^"]+)""#).expect("static regex"));
    re.captures_iter(line).last().map(|c| c[1].to_owned())
}

/// parseCommandBlock — the command name (+ non-empty args) out of a transcript entry's text.
pub fn parse_command_block(text: &str) -> Option<(String, Option<String>)> {
    static RE_NAME: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    static RE_ARGS: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let re_name = RE_NAME.get_or_init(|| {
        regex::Regex::new(r"(?s)^(?:\s*<local-command-caveat>.*?</local-command-caveat>)?\s*<command-name>([^<]*)</command-name>")
            .expect("static regex")
    });
    let re_args = RE_ARGS.get_or_init(|| regex::Regex::new(r"<command-args>([^<]*)</command-args>").expect("static regex"));
    let name = re_name.captures(text)?.get(1)?.as_str().trim().to_owned();
    if name.is_empty() {
        return None;
    }
    let args = re_args.captures(text).and_then(|c| c.get(1)).map(|m| m.as_str().trim().to_owned()).filter(|a| !a.is_empty());
    Some((name, args))
}

/// extractCacheRiskCommand — only `type:"user"` entries whose content is a STRING carry a
/// command block (a tool_result is an array; treating one as a command would let a transcript
/// that merely QUOTES `<command-name>` inflate the count). The wire row is
/// `{ts, session?, command, args?, kind, mutation}` — conditional keys mirrored.
pub fn extract_cache_risk_command(entry: &Value) -> Option<Value> {
    extract_cache_risk_command_with_model(entry, None)
}

/// As `extract_cache_risk_command`, graded against the entry's own CC `version` and the model the
/// session was on (`gate_by_cc_version`).
pub fn extract_cache_risk_command_with_model(entry: &Value, model: Option<&str>) -> Option<Value> {
    if entry.get("type").and_then(Value::as_str) != Some("user") {
        return None;
    }
    let content = entry.get("message").and_then(|m| m.get("content")).and_then(Value::as_str)?;
    let (name, args) = parse_command_block(content)?;
    let (kind, mutation) = classify_slash_command(&name, args.as_deref())?;
    let (kind, mutation) = gate_by_cc_version(&name, kind, mutation, entry.get("version").and_then(Value::as_str), model)?;
    // Transcript timestamps are ISO (Date.parse there, parse_iso_ms here — agree on ISO).
    let ts = entry.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms)?;
    let mut cmd = Map::new();
    cmd.insert("ts".into(), num(ts));
    if let Some(sid) = entry.get("sessionId").and_then(Value::as_str) {
        cmd.insert("session".into(), Value::from(sid));
    }
    cmd.insert("command".into(), Value::from(name.trim()));
    cmd.insert("kind".into(), Value::from(kind));
    cmd.insert("mutation".into(), Value::from(mutation));
    if let Some(a) = args {
        // `if (block.args) cmd.args = block.args` runs AFTER the literal — args serializes
        // LAST, whatever order the TS interface declares.
        cmd.insert("args".into(), Value::from(a));
    }
    Some(Value::Object(cmd))
}

/// transcriptFiles — every `*.jsonl` one level deep (<root>/<slug>/*.jsonl). Sorted for
/// determinism (the TS walks raw readdir order — observable only in same-ts tie order, which
/// no frozen shape pins).
pub fn transcript_files(dirs: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for root in dirs {
        let Ok(slugs) = std::fs::read_dir(root) else { continue };
        let mut slugs: Vec<PathBuf> = slugs.flatten().map(|e| e.path()).collect();
        slugs.sort();
        for slug in slugs {
            let Ok(names) = std::fs::read_dir(&slug) else { continue };
            let mut files: Vec<PathBuf> =
                names.flatten().map(|e| e.path()).filter(|p| p.to_string_lossy().ends_with(".jsonl")).collect();
            files.sort();
            out.extend(files);
        }
    }
    out
}

/// scanCacheRiskCommands — newest first. Two cheap filters keep a full-history scan (12k+
/// files) affordable: skip a file whose mtime predates sinceMs, and skip a file whose text has
/// no `<command-name>` at all — only then parse, and only the marker lines.
pub fn scan_cache_risk_commands(dirs: &[PathBuf], since_ms: Option<f64>, kinds: Option<&[String]>, limit: Option<usize>) -> Vec<Value> {
    let mut found: Vec<Value> = Vec::new();
    for file in transcript_files(dirs) {
        if let Some(since) = since_ms {
            let Ok(meta) = std::fs::metadata(&file) else { continue };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs_f64() * 1000.0)
                .unwrap_or(0.0);
            if mtime < since {
                continue;
            }
        }
        let Ok(bytes) = std::fs::read(&file) else { continue };
        let text = String::from_utf8_lossy(&bytes);
        if !text.contains("<command-name>") {
            continue;
        }
        // The model a command ran under is on the ASSISTANT records around it, never on the
        // command entry itself; track the latest one seen so far in this file.
        let mut last_model: Option<String> = None;
        for line in text.split('\n') {
            if line.contains("\"model\":\"claude-") {
                if let Some(m) = model_on_line(line) {
                    last_model = Some(m);
                }
            }
            if !line.contains("<command-name>") {
                continue;
            }
            let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
            let Some(cmd) = extract_cache_risk_command_with_model(&entry, last_model.as_deref()) else { continue };
            if let Some(since) = since_ms {
                if cmd.get("ts").and_then(Value::as_f64).unwrap_or(f64::NAN) < since {
                    continue;
                }
            }
            if let Some(kinds) = kinds {
                if !kinds.iter().any(|k| Some(k.as_str()) == cmd.get("kind").and_then(Value::as_str)) {
                    continue;
                }
            }
            found.push(cmd);
        }
    }
    // `b.ts - a.ts`, stable — ties keep scan order.
    found.sort_by(|a, b| {
        let t = |v: &Value| v.get("ts").and_then(Value::as_f64).unwrap_or(f64::NAN);
        t(b).partial_cmp(&t(a)).unwrap_or(std::cmp::Ordering::Equal)
    });
    if let Some(l) = limit {
        found.truncate(l);
    }
    found
}

/// The GET /api/cache-risk-commands body (server.ts:3465). Scan unlimited, then slice — the
/// response states the TRUE total (a capped list whose count silently equals the cap reads as
/// "that is all there was"); per-kind counts come from the FULL window, not the capped page.
pub fn cache_risk_commands_response(dirs: &[PathBuf], now_ms: f64, window_hours: f64, kinds: Option<&[String]>, limit: usize) -> Value {
    let all = scan_cache_risk_commands(dirs, Some(now_ms - window_hours * 3_600_000.0), kinds, None);
    let commands: Vec<Value> = all.iter().take(limit).cloned().collect();
    let mut by_kind: IndexMap<String, u64> = IndexMap::new();
    for c in &all {
        *by_kind.entry(c.get("kind").and_then(Value::as_str).unwrap_or("").to_owned()).or_insert(0) += 1;
    }
    let mut bk = Map::new();
    for (k, n) in by_kind {
        bk.insert(k, Value::from(n));
    }
    json!({
        "windowHours": num(window_hours),
        "total": all.len(),
        "count": commands.len(),
        "truncated": all.len() > commands.len(),
        "byKind": bk,
        "commands": commands,
    })
}

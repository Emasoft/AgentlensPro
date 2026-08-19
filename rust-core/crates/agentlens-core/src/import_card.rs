//! POST /api/import (TRDD-DMWOBWFH, freeze §1 row 3) — server.ts buildImportCardStandalone:
//! an exported session record becomes a log-feed card, every field coerced to its TS default
//! (`num` = number else 0, `str` = string else '', `arrStr` = the string elements of an array
//! else []). Key order is the TS literal's. `tokensSource`/`coverageNote` are carried ONLY when
//! the export recorded a valid value — a legacy export imports without them (JSON.stringify drops
//! `undefined`), never with a fabricated stamp.

use serde_json::{json, Map, Value};

use crate::summarize::helpers::iso_from_ms;

pub const VALID_SOURCES: [&str; 4] = ["copilot", "claude_code", "codex", "opencode"];

fn num(v: Option<&Value>) -> Value {
    match v {
        Some(n) if n.is_number() => n.clone(),
        _ => Value::from(0),
    }
}

fn str_or<'a>(v: Option<&'a Value>, def: &'a str) -> &'a str {
    v.and_then(Value::as_str).unwrap_or(def)
}

fn arr_str(v: Option<&Value>) -> Value {
    match v.and_then(Value::as_array) {
        Some(a) => Value::Array(a.iter().filter(|x| x.is_string()).cloned().collect()),
        None => Value::Array(Vec::new()),
    }
}

/// buildImportCardStandalone(raw). `now_ms` backs the `startTime` default (new Date()).
pub fn build_import_card(raw: &Map<String, Value>, now_ms: i64) -> Value {
    let g = |k: &str| raw.get(k);
    let mut card = json!({
        "sessionId": str_or(g("sessionId"), ""),
        "traceId": str_or(g("traceId"), ""),
        "source": match g("source") { Some(v) if !v.is_null() => v.clone(), _ => Value::from("claude_code") },
        "dataSource": "log",
        "workspace": str_or(g("workspace"), ""),
        "userRequest": str_or(g("userRequest"), ""),
        "model": str_or(g("model"), ""),
        "turns": num(g("turns")),
        "totalLlmCalls": num(g("turns")),
        "totalToolCalls": num(g("totalToolCalls")),
        "inputTokens": num(g("inputTokens")),
        "outputTokens": num(g("outputTokens")),
        "cacheReadTokens": num(g("cacheReadTokens")),
        "cacheCreateTokens": num(g("cacheCreateTokens")),
        "cacheHitRate": num(g("cacheHitRate")),
        "durationMs": num(g("durationMs")),
        "startTime": match g("startTime").and_then(Value::as_str) { Some(s) => s.to_owned(), None => iso_from_ms(now_ms as f64) },
        "filesRead": arr_str(g("filesRead")),
        "filesChanged": arr_str(g("filesChanged")),
        "filesSearched": [],
        "filesWritten": [],
        "toolCounts": match g("toolCounts") { Some(v) if v.is_object() => v.clone(), _ => json!({}) },
        "errors": num(g("errors")),
        "outcome": match g("outcome") { Some(v) if !v.is_null() => v.clone(), _ => Value::from("unknown") },
        "timeline": [],
        "backgroundSpans": [],
        "loopSignals": match g("loopSignals") { Some(v) if v.is_array() => v.clone(), _ => json!([]) },
    });
    let obj = card.as_object_mut().expect("object literal");
    if let Some(ts) = g("tokensSource").and_then(Value::as_str).filter(|s| matches!(*s, "log" | "otel" | "merged")) {
        obj.insert("tokensSource".into(), Value::from(ts));
    }
    if let Some(note) = g("coverageNote").and_then(Value::as_str) {
        obj.insert("coverageNote".into(), Value::from(note));
    }
    card
}

/// The handler's loop over `body.sessions`: non-objects and records without a string
/// `sessionId` + a valid `source` are silently dropped (neither imported nor skipped); an id
/// already in the card map is `skipped`; the rest are built and put. Returns (imported, skipped).
pub fn import_sessions(state: &mut crate::CoreState, sessions: &[Value], now_ms: i64) -> (u64, u64) {
    let (mut imported, mut skipped) = (0u64, 0u64);
    for raw in sessions {
        let Some(s) = raw.as_object() else { continue };
        let Some(id) = s.get("sessionId").and_then(Value::as_str).filter(|id| !id.is_empty()) else { continue };
        if !s.get("source").and_then(Value::as_str).is_some_and(|src| VALID_SOURCES.contains(&src)) {
            continue;
        }
        if state.log_sessions.contains_key(id) {
            skipped += 1;
            continue;
        }
        state.put_log_session(build_import_card(s, now_ms));
        imported += 1;
    }
    (imported, skipped)
}

//! Codex transcript parser (TRDD-DMWOBWFH P2c) — faithful port of
//! `src/logReader.ts::_codexOnEntry` + `_parseCodexFile`.
//!
//! Codex semantics the port must keep: `lastTimestamp` advances ONLY on `event_msg` rows;
//! the LATEST cumulative `total_token_usage` wins (per-turn sums drift from it); usage is
//! OPENAI-shaped — `cached_input_tokens ⊂ input_tokens`, so the cached share is shed from
//! input at construction (the tokenBuckets 'openai' rule) or every cached token double-bills;
//! reasoning tokens fold into output (billed at the output rate for o-series); a turn is
//! counted per `last_token_usage` presence.

use serde_json::Value;

use crate::{clamp_num, iso_from_ms, js_string, js_trim, parse_ts_ms, snip, Card, ParsedTranscript};

#[derive(Default, Clone)]
pub struct CodexAccum {
    workspace: String,
    model: String,
    first_timestamp: String,
    last_timestamp: String,
    user_request: String,
    turns: u64,
    last_total_usage: Option<serde_json::Map<String, Value>>,
}

/// JS truthiness for the `if (payload?.[k])` gates the TS parser uses.
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// TS `_extractCodexUserText`: the IDE preamble ends at "## My request for Codex:\n".
fn extract_codex_user_text(raw: &str) -> String {
    const MARKER: &str = "## My request for Codex:\n";
    match raw.find(MARKER) {
        Some(idx) => js_trim(&raw[idx + MARKER.len()..]).to_owned(),
        None => raw.to_owned(),
    }
}

pub fn on_entry(a: &mut CodexAccum, entry: &serde_json::Map<String, Value>) {
    let ts = entry.get("timestamp").and_then(Value::as_str);
    let entry_type = entry.get("type").and_then(Value::as_str);
    if let Some(ts) = ts {
        if a.first_timestamp.is_empty() {
            a.first_timestamp = ts.to_owned();
        }
        if entry_type == Some("event_msg") {
            a.last_timestamp = ts.to_owned();
        }
    }
    let payload = entry.get("payload").and_then(Value::as_object);
    if entry_type == Some("session_meta") && a.workspace.is_empty() {
        if let Some(p) = payload {
            if truthy(p.get("cwd")) {
                a.workspace = js_string(p.get("cwd").unwrap());
            }
        }
    }
    if entry_type == Some("turn_context") {
        if let Some(p) = payload {
            if truthy(p.get("model")) {
                a.model = js_string(p.get("model").unwrap());
            }
        }
    }
    if entry_type == Some("event_msg") {
        let Some(p) = payload else { return };
        let ptype = p.get("type").and_then(Value::as_str);
        if ptype == Some("user_message") && a.user_request.is_empty() {
            // TS: String(payload.message ?? '').trim()
            let raw = match p.get("message") {
                None | Some(Value::Null) => String::new(),
                Some(v) => js_string(v),
            };
            let msg = js_trim(&raw);
            if !msg.is_empty() {
                a.user_request = extract_codex_user_text(msg);
            }
        }
        if ptype == Some("token_count") {
            let info = p.get("info").and_then(Value::as_object);
            if let Some(info) = info {
                if truthy(info.get("model")) {
                    a.model = js_string(info.get("model").unwrap());
                }
                if let Some(total) = info.get("total_token_usage").and_then(Value::as_object) {
                    a.last_total_usage = Some(total.clone());
                }
                if info.get("last_token_usage").and_then(Value::as_object).is_some() {
                    a.turns += 1;
                }
            }
        }
    }
}

/// The `_parseCodexFile` assembly: OPENAI-shaped disjoint buckets from the final cumulative
/// usage, then the shared card shape (empty timeline/tool state — Codex logs carry none).
pub fn build_result(file_path: &str, a: CodexAccum) -> Option<ParsedTranscript> {
    if a.first_timestamp.is_empty() {
        return None;
    }
    let u = a.last_total_usage.as_ref();
    let input_raw = u.map(|m| clamp_num(m.get("input_tokens"))).unwrap_or(0.0);
    let cache_read = u.map(|m| clamp_num(m.get("cached_input_tokens"))).unwrap_or(0.0);
    let output = u
        .map(|m| clamp_num(m.get("output_tokens")) + clamp_num(m.get("reasoning_output_tokens")))
        .unwrap_or(0.0);
    // 'openai' shape: cached ⊂ input — shed it, guarded against an inconsistent payload.
    let input = (input_raw - cache_read).max(0.0);

    let session_id = std::path::Path::new(file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_owned();
    let start_ms = parse_ts_ms(&a.first_timestamp);
    let end_ms = parse_ts_ms(&a.last_timestamp);
    let duration_ms = if end_ms > 0 && start_ms > 0 { (end_ms - start_ms).max(0) } else { 0 };
    let total_context = input + cache_read;
    let last_ms = parse_ts_ms(if a.last_timestamp.is_empty() { &a.first_timestamp } else { &a.last_timestamp });

    let card = Card {
        session_id: session_id.clone(),
        trace_id: session_id,
        source: "codex",
        data_source: "log",
        tokens_source: "log",
        initiator: "user",
        parent_session_id: None,
        spawned_by_turn: None,
        spawn_kind: None,
        spawn_model_override: None,
        spawn_isolation: None,
        spawn_subagent_type: None,
        spawn_async: None,
        workspace: a.workspace.clone(),
        title: None,
        entrypoint: None,
        timeline_truncated_count: None,
        user_request: snip(&a.user_request, 500),
        model: if a.model.is_empty() { "codex".to_owned() } else { a.model.clone() },
        turns: a.turns,
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_create_tokens: 0.0,
        cache_hit_rate: if total_context > 0.0 { cache_read / total_context } else { 0.0 },
        duration_ms: duration_ms as f64,
        start_time: if start_ms > 0 { iso_from_ms(start_ms) } else { String::new() },
        files_read: Vec::new(),
        files_searched: Vec::new(),
        files_changed: Vec::new(),
        files_written: Vec::new(),
        file_ops: None,
        tool_counts: indexmap::IndexMap::new(),
        total_tool_calls: 0,
        total_llm_calls: a.turns,
        errors: 0,
        outcome: "text_response",
        timeline: Vec::new(),
        timeline_retained_bytes: None,
        background_spans: Vec::new(),
        loop_signals: Vec::new(),
        peak_context_per_turn: if a.turns > 1 { Some(0.0) } else { None },
    };
    Some(ParsedTranscript {
        file: file_path.to_owned(),
        workspace: a.workspace,
        card,
        child_cards: Vec::new(),
        gen_files: Vec::new(),
        blend_turns: None,
        last_timestamp_ms: last_ms,
        file_size_bytes: 0, // stamped by parse_codex_transcript
    })
}

/// Parse one Codex transcript cold. Same skip-corrupt-lines contract as the Claude path.
pub fn parse_codex_transcript(file_path: &str) -> std::io::Result<Option<ParsedTranscript>> {
    let bytes = std::fs::read(file_path)?;
    let mut a = CodexAccum::default();
    for line in bytes.split(|b| *b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else { continue };
        if let Value::Object(entry) = v {
            on_entry(&mut a, &entry);
        }
    }
    Ok(build_result(file_path, a).map(|mut r| {
        r.file_size_bytes = bytes.len() as u64;
        r
    }))
}

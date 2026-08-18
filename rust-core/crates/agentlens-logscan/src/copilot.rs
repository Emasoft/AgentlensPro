//! Copilot parsers (TRDD-DMWOBWFH P2d) — faithful ports of the three TS shapes in
//! `src/logReader.ts`:
//!   CLI      — `_parseCopilotFile`: ~/.copilot/session-state/<uuid>/events.jsonl; the SESSION
//!              ID IS THE DIRECTORY NAME, not the file stem. Tokens come from the
//!              session.shutdown modelMetrics usage (currentTokens is only the context size —
//!              never used); a turn is counted per truthy assistant outputTokens.
//!   VS Code  — `_parseCopilotVSCodeFile`: workspaceStorage/<hash>/chatSessions/<uuid>.jsonl,
//!              a DELTA LOG (kind=0 snapshot, kind=1 set, kind=2 push). completionTokens
//!              arrives in three formats; kind=1 always wins over a kind=2 push value.
//!   Legacy   — `_parseCopilotVSCodeJsonFile`: the pre-delta-log single-JSON snapshot; no
//!              token counts exist in that format at all.
//!
//! Cold-scan only, like the rest of the crate: the TS incremental path keeps live tails.

use serde_json::Value;

use crate::{iso_from_ms, js_string, js_trim, parse_ts_ms, snip, Card, ParsedTranscript};
use indexmap::IndexMap;

const MAX_ARRAY_READ_BYTES: u64 = 256 * 1024 * 1024; // TS MAX_ARRAY_READ_BYTES
const MAX_JSON_BYTES: u64 = 64 * 1024 * 1024; // TS MAX_JSON_BYTES

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0 && !f.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}

/// `decodeURIComponent` for the file:/// workspace URI (UTF-8 percent-decoding; a malformed
/// escape keeps the raw bytes, which is close enough to JS throwing-then-caught here because
/// the TS caller wraps the whole read in try/catch and real VS Code URIs are well-formed).
fn percent_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            let hex = |c: u8| -> Option<u8> {
                match c {
                    b'0'..=b'9' => Some(c - b'0'),
                    b'a'..=b'f' => Some(c - b'a' + 10),
                    b'A'..=b'F' => Some(c - b'A' + 10),
                    _ => None,
                }
            };
            if let (Some(h), Some(l)) = (hex(b[i + 1]), hex(b[i + 2])) {
                out.push(h * 16 + l);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Workspace from the sibling `workspaceStorage/<hash>/workspace.json` (two levels up from the
/// chatSessions file). win32 drive-letter handling deliberately absent: this binary ships for
/// macOS/Linux (the TS path keeps serving Windows).
fn workspace_from_sibling(file_path: &str) -> String {
    let p = std::path::Path::new(file_path);
    let Some(dir) = p.parent().and_then(|d| d.parent()) else { return String::new() };
    let wj_path = dir.join("workspace.json");
    let Ok(body) = std::fs::read_to_string(&wj_path) else { return String::new() };
    let Ok(Value::Object(wj)) = serde_json::from_str::<Value>(&body) else { return String::new() };
    let folder = match wj.get("folder") {
        None | Some(Value::Null) => String::new(),
        Some(v) => js_string(v),
    };
    if let Some(rest) = folder.strip_prefix("file:///") {
        // TS slices 7 chars (keeps the leading '/'), then decodes.
        percent_decode(&format!("/{rest}"))
    } else {
        String::new()
    }
}

// ── TS `_extractCopilotUserText` — the CLI XML-block skipper ─────────────────────

fn is_lower_name(bytes: &[u8]) -> usize {
    bytes.iter().take_while(|c| c.is_ascii_lowercase() || **c == b'_').count()
}

/// `/^<[a-z_]+[^>]*>/` — an opening injected-XML tag at line start.
fn is_open_tag(line: &str) -> bool {
    let b = line.as_bytes();
    if b.first() != Some(&b'<') {
        return false;
    }
    let n = is_lower_name(&b[1..]);
    n > 0 && b[1 + n..].contains(&b'>')
}

/// `/<\/[a-z_]+>$/` — the tag closes on the same line.
fn closes_same_line(line: &str) -> bool {
    let b = line.as_bytes();
    if b.last() != Some(&b'>') {
        return false;
    }
    let body = &b[..b.len() - 1];
    let name_len = body.iter().rev().take_while(|c| c.is_ascii_lowercase() || **c == b'_').count();
    if name_len == 0 {
        return false;
    }
    body[..body.len() - name_len].ends_with(b"</")
}

/// `/^<\/[a-z_]+>/` — a closing tag at line start.
fn is_close_tag(line: &str) -> bool {
    let b = line.as_bytes();
    if !b.starts_with(b"</") {
        return false;
    }
    let n = is_lower_name(&b[2..]);
    n > 0 && b.get(2 + n) == Some(&b'>')
}

fn extract_copilot_user_text(raw: &str) -> String {
    let mut in_tag = false;
    for line in raw.split('\n') {
        let trimmed = js_trim(line);
        if trimmed.is_empty() {
            continue;
        }
        if is_open_tag(trimmed) && !trimmed.starts_with("</") {
            if closes_same_line(trimmed) {
                continue;
            }
            in_tag = true;
            continue;
        }
        if is_close_tag(trimmed) {
            in_tag = false;
            continue;
        }
        if in_tag {
            continue;
        }
        return trimmed.to_owned();
    }
    String::new()
}

/// TS `_extractVSCodeCopilotUserText`: strip GREEDILY through the LAST closing tag, then take
/// the first line of what remains.
fn extract_vscode_copilot_user_text(raw: &str) -> String {
    // Find the end of the LAST `</...>` occurrence.
    let mut last_end: Option<usize> = None;
    let b = raw.as_bytes();
    let mut i = 0;
    while i + 1 < b.len() {
        if b[i] == b'<' && b[i + 1] == b'/' {
            if let Some(gt) = raw[i + 2..].find('>') {
                // `[^>]+` requires at least one char between `</` and `>`.
                if gt > 0 {
                    last_end = Some(i + 2 + gt + 1);
                }
                i = i + 2 + gt + 1;
                continue;
            }
        }
        i += 1;
    }
    let raw_trimmed = js_trim(raw);
    let stripped = match last_end {
        Some(e) => js_trim(&raw[e..]).to_owned(),
        None => raw_trimmed.to_owned(),
    };
    if !stripped.is_empty() && stripped != raw_trimmed {
        return js_trim(stripped.split('\n').next().unwrap_or("")).to_owned();
    }
    if stripped.is_empty() {
        return String::new();
    }
    js_trim(raw_trimmed.split('\n').next().unwrap_or("")).to_owned()
}

// ── Shared card assembly (the copilot cards are timeline-less) ───────────────────

#[allow(clippy::too_many_arguments)]
fn copilot_card(
    session_id: String,
    model: String,
    first_ts: &str,
    last_ts: &str,
    workspace: String,
    user_request: &str,
    turns: u64,
    total_tool_calls: u64,
    tool_counts: IndexMap<String, u64>,
    files_changed: Vec<String>,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_create: f64,
) -> Card {
    let start_ms = parse_ts_ms(first_ts);
    let end_ms = parse_ts_ms(last_ts);
    let duration_ms = if end_ms > 0 && start_ms > 0 { (end_ms - start_ms).max(0) } else { 0 };
    let total_context = input + cache_read + cache_create;
    Card {
        session_id: session_id.clone(),
        trace_id: session_id,
        source: "copilot",
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
        workspace,
        title: None,
        entrypoint: None,
        timeline_truncated_count: None,
        user_request: snip(user_request, 500),
        model,
        turns,
        input_tokens: input,
        output_tokens: output,
        cache_read_tokens: cache_read,
        cache_create_tokens: cache_create,
        cache_hit_rate: if total_context > 0.0 { cache_read / total_context } else { 0.0 },
        duration_ms: duration_ms as f64,
        start_time: if start_ms > 0 { iso_from_ms(start_ms) } else { String::new() },
        files_read: Vec::new(),
        files_searched: Vec::new(),
        files_changed,
        files_written: Vec::new(),
        file_ops: None,
        tool_counts,
        total_tool_calls,
        total_llm_calls: turns,
        errors: 0,
        outcome: if total_tool_calls > 0 { "tool_calls" } else { "text_response" },
        timeline: Vec::new(),
        timeline_retained_bytes: None,
        background_spans: Vec::new(),
        loop_signals: Vec::new(),
        peak_context_per_turn: if turns > 1 { Some(0.0) } else { None },
    }
}

fn wrap(file_path: &str, workspace: String, card: Card, last_ts: &str, first_ts: &str, size: u64) -> ParsedTranscript {
    let last_ms = parse_ts_ms(if last_ts.is_empty() { first_ts } else { last_ts });
    ParsedTranscript {
        file: file_path.to_owned(),
        workspace,
        card,
        child_cards: Vec::new(),
        gen_files: Vec::new(),
        blend_turns: None,
        last_timestamp_ms: last_ms,
        file_size_bytes: size,
    }
}

// ── CLI shape ────────────────────────────────────────────────────────────────────

pub fn parse_copilot_cli(file_path: &str) -> std::io::Result<Option<ParsedTranscript>> {
    let bytes = std::fs::read(file_path)?;
    if bytes.len() as u64 > MAX_ARRAY_READ_BYTES {
        return Ok(None);
    }
    // TS: sessionId = the DIRECTORY name holding events.jsonl.
    let session_id = std::path::Path::new(file_path)
        .parent()
        .and_then(|p| p.file_name())
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_owned();

    let mut workspace = String::new();
    let mut model = String::new();
    let mut first_ts = String::new();
    let mut last_ts = String::new();
    let mut user_request = String::new();
    let mut total_output = 0.0_f64;
    let mut total_input = 0.0_f64;
    let mut cache_read = 0.0_f64;
    let mut cache_create = 0.0_f64;
    let mut turns = 0_u64;
    let mut total_tool_calls = 0_u64;
    let mut tool_counts: IndexMap<String, u64> = IndexMap::new();
    let mut files_changed: Vec<String> = Vec::new();

    for line in bytes.split(|b| *b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(Value::Object(event)) = serde_json::from_slice::<Value>(line) else { continue };
        let ts = event.get("timestamp").and_then(Value::as_str);
        let etype = event.get("type").and_then(Value::as_str);
        if let Some(ts) = ts {
            if first_ts.is_empty() {
                first_ts = ts.to_owned();
            }
            if matches!(etype, Some("user.message") | Some("assistant.message") | Some("session.shutdown")) {
                last_ts = ts.to_owned();
            }
        }
        let Some(data) = event.get("data").and_then(Value::as_object) else { continue };
        let Some(etype) = etype else { continue };

        if etype == "session.start" {
            if truthy(data.get("selectedModel")) {
                model = js_string(data.get("selectedModel").unwrap());
            }
            if let Some(ctx) = data.get("context").and_then(Value::as_object) {
                if truthy(ctx.get("cwd")) {
                    workspace = js_string(ctx.get("cwd").unwrap());
                }
            }
            if truthy(data.get("startTime")) && first_ts.is_empty() {
                first_ts = js_string(data.get("startTime").unwrap());
            }
        }
        if etype == "user.message" && user_request.is_empty() {
            let raw = match data.get("transformedContent") {
                None | Some(Value::Null) => String::new(),
                Some(v) => js_string(v),
            };
            user_request = extract_copilot_user_text(&raw);
        }
        if etype == "assistant.message" {
            let out_tok = data.get("outputTokens").and_then(Value::as_f64).unwrap_or(0.0);
            if out_tok != 0.0 {
                total_output += out_tok;
                turns += 1;
            }
            if let Some(reqs) = data.get("toolRequests").and_then(Value::as_array) {
                for req in reqs.iter().filter_map(Value::as_object) {
                    let name = match req.get("name") {
                        None | Some(Value::Null) => String::new(),
                        Some(v) => js_string(v),
                    };
                    if name.is_empty() {
                        continue;
                    }
                    total_tool_calls += 1;
                    *tool_counts.entry(name.clone()).or_insert(0) += 1;
                    let args = req.get("arguments").and_then(Value::as_object);
                    let fp = args
                        .map(|a| {
                            for k in ["path", "file_path"] {
                                match a.get(k) {
                                    None | Some(Value::Null) => continue,
                                    Some(v) => return js_string(v),
                                }
                            }
                            String::new()
                        })
                        .unwrap_or_default();
                    if !fp.is_empty()
                        && (name == "edit" || name == "write" || name == "create")
                        && !files_changed.contains(&fp)
                    {
                        files_changed.push(fp);
                    }
                }
            }
            if truthy(data.get("model")) {
                model = js_string(data.get("model").unwrap());
            }
        }
        if etype == "session.shutdown" {
            if let Some(metrics) = data.get("modelMetrics").and_then(Value::as_object) {
                for entry in metrics.values().filter_map(Value::as_object) {
                    let Some(usage) = entry.get("usage").and_then(Value::as_object) else { continue };
                    total_input += usage.get("inputTokens").and_then(Value::as_f64).unwrap_or(0.0);
                    cache_read += usage.get("cacheReadTokens").and_then(Value::as_f64).unwrap_or(0.0);
                    cache_create += usage.get("cacheWriteTokens").and_then(Value::as_f64).unwrap_or(0.0);
                }
            }
        }
    }
    if first_ts.is_empty() {
        return Ok(None);
    }
    let card = copilot_card(
        session_id,
        if model.is_empty() { "copilot".to_owned() } else { model },
        &first_ts,
        &last_ts,
        workspace.clone(),
        &user_request,
        turns,
        total_tool_calls,
        tool_counts,
        files_changed,
        total_input,
        total_output,
        cache_read,
        cache_create,
    );
    Ok(Some(wrap(file_path, workspace, card, &last_ts, &first_ts, bytes.len() as u64)))
}

// ── VS Code delta-log shape ──────────────────────────────────────────────────────

pub fn parse_copilot_vscode(file_path: &str) -> std::io::Result<Option<ParsedTranscript>> {
    let bytes = std::fs::read(file_path)?;
    if bytes.len() as u64 > MAX_ARRAY_READ_BYTES {
        return Ok(None);
    }
    let session_id = std::path::Path::new(file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_owned();
    let workspace = workspace_from_sibling(file_path);

    let mut session_created_ms = 0.0_f64;
    let mut model = String::new();
    let mut user_request = String::new();
    let mut turn_completion: IndexMap<u64, f64> = IndexMap::new();
    let mut turn_prompt: IndexMap<u64, f64> = IndexMap::new();
    let mut turn_timestamps: Vec<Option<f64>> = Vec::new();
    let mut request_push_count = 0_u64;

    for line in bytes.split(|b| *b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(Value::Object(entry)) = serde_json::from_slice::<Value>(line) else { continue };
        let kind = entry.get("kind").and_then(Value::as_f64);
        let k = entry.get("k");
        let v = entry.get("v");

        if kind == Some(0.0) {
            if let Some(Value::Object(sv)) = v {
                if let Some(c) = sv.get("creationDate").and_then(Value::as_f64) {
                    session_created_ms = c;
                }
                let sel = sv
                    .get("inputState")
                    .and_then(Value::as_object)
                    .and_then(|is| is.get("selectedModel"))
                    .and_then(Value::as_object);
                if let Some(sel) = sel {
                    if let Some(fam) = sel.get("metadata").and_then(Value::as_object).and_then(|m| m.get("family")).and_then(Value::as_str) {
                        model = fam.to_owned();
                    } else if let Some(id) = sel.get("id").and_then(Value::as_str) {
                        model = id.to_owned();
                    }
                }
            }
        }

        if kind == Some(2.0) {
            if let (Some(Value::Array(karr)), Some(Value::Array(items))) = (k, v) {
                if karr.len() == 1 && karr[0].as_str() == Some("requests") {
                    for (j, req) in items.iter().enumerate() {
                        let Some(req) = req.as_object() else { continue };
                        let turn_idx = request_push_count + j as u64;
                        if let Some(t) = req.get("timestamp").and_then(Value::as_f64) {
                            if turn_timestamps.len() <= turn_idx as usize {
                                turn_timestamps.resize(turn_idx as usize + 1, None);
                            }
                            turn_timestamps[turn_idx as usize] = Some(t);
                        }
                        if let Some(ct) = req.get("completionTokens").and_then(Value::as_f64) {
                            turn_completion.entry(turn_idx).or_insert(ct);
                        }
                        if turn_idx == 0 && user_request.is_empty() {
                            if let Some(text) = req.get("message").and_then(Value::as_object).and_then(|m| m.get("text")).and_then(Value::as_str) {
                                if !js_trim(text).is_empty() {
                                    user_request = js_trim(text).to_owned();
                                }
                            }
                        }
                        if model.is_empty() {
                            if let Some(mid) = req.get("modelId").and_then(Value::as_str) {
                                model = mid.strip_prefix("copilot/").unwrap_or(mid).to_owned();
                            }
                        }
                    }
                    request_push_count += items.len() as u64;
                }
            }
        }

        if kind == Some(1.0) {
            if let Some(Value::Array(karr)) = k {
                if karr.first().and_then(Value::as_str) == Some("requests") {
                    if let Some(idx) = karr.get(1).and_then(Value::as_f64) {
                        let idx = idx as u64;
                        let key2 = karr.get(2).and_then(Value::as_str);
                        if key2 == Some("completionTokens") {
                            if let Some(n) = v.and_then(Value::as_f64) {
                                turn_completion.insert(idx, n);
                            }
                        }
                        if key2 == Some("result") {
                            if let Some(Value::Object(result)) = v {
                                if let Some(usage) = result.get("usage").and_then(Value::as_object) {
                                    if let Some(ct) = usage.get("completionTokens").and_then(Value::as_f64) {
                                        turn_completion.insert(idx, ct);
                                    }
                                    if let Some(pt) = usage.get("promptTokens").and_then(Value::as_f64) {
                                        turn_prompt.insert(idx, pt);
                                    }
                                }
                                if user_request.is_empty() {
                                    let rendered = result
                                        .get("metadata")
                                        .and_then(Value::as_object)
                                        .and_then(|m| m.get("renderedUserMessage"))
                                        .and_then(Value::as_array);
                                    if let Some(rendered) = rendered {
                                        for chunk in rendered.iter().filter_map(Value::as_object) {
                                            if chunk.get("type").and_then(Value::as_f64) == Some(1.0) {
                                                if let Some(text) = chunk.get("text").and_then(Value::as_str) {
                                                    user_request = extract_vscode_copilot_user_text(text);
                                                    if !user_request.is_empty() {
                                                        break;
                                                    }
                                                }
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    let total_output: f64 = turn_completion.values().sum();
    let total_input: f64 = turn_prompt.values().sum();
    let turns = turn_completion.len() as u64;
    if turns == 0 || session_created_ms == 0.0 {
        return Ok(None);
    }
    let start_ts = iso_from_ms(session_created_ms as i64);
    let last_turn_ms = turn_timestamps
        .iter()
        .flatten()
        .fold(f64::NEG_INFINITY, |a, b| a.max(*b));
    let end_ms = if last_turn_ms.is_finite() { last_turn_ms } else { session_created_ms };
    let end_ts = iso_from_ms(end_ms as i64);

    let card = copilot_card(
        session_id,
        if model.is_empty() { "copilot".to_owned() } else { model },
        &start_ts,
        &end_ts,
        workspace.clone(),
        &user_request,
        turns,
        0,
        IndexMap::new(),
        Vec::new(),
        total_input,
        total_output,
        0.0,
        0.0,
    );
    Ok(Some(wrap(file_path, workspace, card, &end_ts, &start_ts, bytes.len() as u64)))
}

// ── Legacy JSON snapshot shape ───────────────────────────────────────────────────

pub fn parse_copilot_vscode_json(file_path: &str) -> std::io::Result<Option<ParsedTranscript>> {
    let bytes = std::fs::read(file_path)?;
    if bytes.len() as u64 > MAX_JSON_BYTES {
        return Ok(None);
    }
    let Ok(Value::Object(data)) = serde_json::from_slice::<Value>(&bytes) else { return Ok(None) };
    let creation_ms = data.get("creationDate").and_then(Value::as_f64).unwrap_or(0.0);
    let last_ms = data.get("lastMessageDate").and_then(Value::as_f64).unwrap_or(0.0);
    if creation_ms == 0.0 {
        return Ok(None);
    }
    let Some(requests) = data.get("requests").and_then(Value::as_array) else { return Ok(None) };
    if requests.is_empty() {
        return Ok(None);
    }
    let workspace = workspace_from_sibling(file_path);

    let mut model = String::new();
    if let Some(sel) = data
        .get("inputState")
        .and_then(Value::as_object)
        .and_then(|is| is.get("selectedModel"))
        .and_then(Value::as_object)
    {
        if let Some(fam) = sel.get("metadata").and_then(Value::as_object).and_then(|m| m.get("family")).and_then(Value::as_str) {
            model = fam.to_owned();
        } else if let Some(id) = sel.get("id").and_then(Value::as_str) {
            model = id.to_owned();
        }
    }

    let mut user_request = String::new();
    let mut total_tool_calls = 0_u64;
    let mut tool_counts: IndexMap<String, u64> = IndexMap::new();
    for req in requests.iter().filter_map(Value::as_object) {
        if model.is_empty() {
            if let Some(mid) = req.get("modelId").and_then(Value::as_str) {
                model = mid.strip_prefix("copilot/").unwrap_or(mid).to_owned();
            }
        }
        if user_request.is_empty() {
            let msg = req.get("message").and_then(Value::as_object);
            if let Some(text) = msg.and_then(|m| m.get("text")).and_then(Value::as_str) {
                if !js_trim(text).is_empty() {
                    user_request = js_trim(text).to_owned();
                }
            }
            if user_request.is_empty() {
                if let Some(parts) = msg.and_then(|m| m.get("parts")).and_then(Value::as_array) {
                    for part in parts.iter().filter_map(Value::as_object) {
                        if let Some(text) = part.get("text").and_then(Value::as_str) {
                            let t = js_trim(text);
                            if !t.is_empty() && !t.starts_with('<') {
                                user_request = t.to_owned();
                                break;
                            }
                        }
                    }
                }
            }
        }
        if let Some(response) = req.get("response").and_then(Value::as_array) {
            for entry in response.iter().filter_map(Value::as_object) {
                if entry.get("kind").and_then(Value::as_str) == Some("toolInvocationSerialized") {
                    total_tool_calls += 1;
                    let tool_id = match entry.get("toolId") {
                        None | Some(Value::Null) => "unknown".to_owned(),
                        Some(v) => js_string(v),
                    };
                    *tool_counts.entry(tool_id).or_insert(0) += 1;
                }
            }
        }
    }

    let fallback_id = std::path::Path::new(file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_owned();
    let sid = match data.get("sessionId") {
        None | Some(Value::Null) => fallback_id,
        Some(v) => js_string(v),
    };
    let start_ts = iso_from_ms(creation_ms as i64);
    let end_ts = iso_from_ms(if last_ms != 0.0 { last_ms } else { creation_ms } as i64);

    let card = copilot_card(
        sid,
        if model.is_empty() { "copilot".to_owned() } else { model },
        &start_ts,
        &end_ts,
        workspace.clone(),
        &user_request,
        requests.len() as u64,
        total_tool_calls,
        tool_counts,
        Vec::new(),
        0.0,
        0.0,
        0.0,
        0.0,
    );
    Ok(Some(wrap(file_path, workspace, card, &end_ts, &start_ts, bytes.len() as u64)))
}

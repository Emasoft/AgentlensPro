//! Port of src/summarizers/copilot.ts (TRDD-DMWOBWFH P4d) — invoke_agent session cards.
//!
//! Cards and timeline entries are built as `serde_json::Value` object literals mirroring the TS
//! objects KEY BY KEY (the STATE-recorded design decision): a field the TS code sets to
//! `undefined` is OMITTED here, because JSON.stringify drops it from the wire; a field TS sets
//! to '' / 0 / false STAYS. Numbers serialize integral-bare via `num()` exactly as JS does.

use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet, VecDeque};

use super::buckets::{context_tokens, disjoint_buckets, UsageShape};
use super::helpers as h;
use super::helpers::{iso_from_ms, name_of, num, put_span_id, start_time, status_is_error, status_message, truthy};

fn usage_shape_for(model: &str) -> UsageShape {
    let m = model.as_bytes();
    let gpt = m.len() >= 4 && m[..4].eq_ignore_ascii_case(b"gpt-");
    let o_series = m.len() >= 2 && (m[0] == b'o' || m[0] == b'O') && m[1].is_ascii_digit();
    if gpt || o_series { UsageShape::OpenAi } else { UsageShape::Anthropic }
}

pub fn build_copilot_sessions(
    invoke_agent_spans: &[&Value],
    children_of: &HashMap<String, Vec<&Value>>,
) -> Vec<Value> {
    invoke_agent_spans
        .iter()
        .map(|agent| {
            let root_id = agent.get("spanId").and_then(Value::as_str).unwrap_or("");
            let mut children = collect_descendants(root_id, children_of);
            children.sort_by(|a, b| {
                h::nano_to_ms(start_time(a)).partial_cmp(&h::nano_to_ms(start_time(b))).unwrap_or(std::cmp::Ordering::Equal)
            });

            let extracted = h::extract_user_request(&h::get_attr_str(agent, "copilot_chat.user_request"));
            let user_req = if extracted.is_empty() { "[Copilot session]".to_owned() } else { extracted };
            let model = h::get_gen_ai_model(agent);
            let conversation_id = children
                .iter()
                .find(|s| name_of(s).starts_with("chat"))
                .map(|s| h::get_attr_str(s, "gen_ai.conversation.id"));
            let turns = h::get_attr_num(agent, "copilot_chat.turn_count");
            let b = disjoint_buckets(&h::extract_token_counts(agent), usage_shape_for(&model));
            let total_context = context_tokens(&b);
            let cache_hit_rate = if total_context > 0.0 { b.cache_read_tokens / total_context } else { 0.0 };

            let start_ms = h::nano_to_ms(start_time(agent));
            let end_ms = h::nano_to_ms(agent.get("endTime").and_then(Value::as_str).unwrap_or(""));
            let duration_ms = end_ms - start_ms;

            // Sets keep insertion order (Array.from(Set) preserves it in JS).
            let mut files_read: Vec<String> = Vec::new();
            let mut files_searched: Vec<String> = Vec::new();
            let mut files_changed: Vec<String> = Vec::new();
            let mut seen_read = HashSet::new();
            let mut seen_searched = HashSet::new();
            let mut seen_changed = HashSet::new();
            let mut tool_counts: Vec<(String, u64)> = Vec::new();
            let mut total_tool_calls = 0u64;
            let mut total_llm_calls = 0u64;
            let mut errors = 0u64;
            let mut last_outcome = "unknown";

            let timeline: Vec<Value> = children
                .iter()
                .map(|child| {
                    let child_start = h::nano_to_ms(start_time(child));
                    let child_end = h::nano_to_ms(child.get("endTime").and_then(Value::as_str).unwrap_or(""));
                    let child_dur = child_end - child_start;
                    let is_error = status_is_error(child);
                    if is_error {
                        errors += 1;
                    }
                    let ts = if child_start > 0.0 { iso_from_ms(child_start) } else { String::new() };
                    let name = name_of(child);

                    if name.starts_with("execute_tool") {
                        let tool_name = h::get_attr_str(child, "gen_ai.tool.name");
                        let args_str = h::get_attr_str(child, "gen_ai.tool.call.arguments");
                        let result_str = h::get_attr_str(child, "gen_ai.tool.call.result");
                        match tool_counts.iter_mut().find(|(k, _)| *k == tool_name) {
                            Some((_, n)) => *n += 1,
                            None => tool_counts.push((tool_name.clone(), 1)),
                        }
                        total_tool_calls += 1;

                        let args: Option<Value> = serde_json::from_str(&args_str).ok();
                        if tool_name == "read_file" {
                            if let Some(a) = &args {
                                let fp = a.get("filePath").and_then(Value::as_str).unwrap_or("");
                                let file = fp.rsplit('/').next().unwrap_or("");
                                if !file.is_empty() && seen_read.insert(file.to_owned()) {
                                    files_read.push(file.to_owned());
                                }
                            }
                        }
                        if tool_name == "file_search" || tool_name == "grep_search" {
                            if let Some(a) = &args {
                                let q = a
                                    .get("query")
                                    .and_then(Value::as_str)
                                    .filter(|s| !s.is_empty())
                                    .or_else(|| a.get("includePattern").and_then(Value::as_str).filter(|s| !s.is_empty()))
                                    .unwrap_or("");
                                if seen_searched.insert(q.to_owned()) {
                                    files_searched.push(q.to_owned());
                                }
                            }
                        }
                        if tool_name == "replace_string_in_file" || tool_name == "create_file" || tool_name == "edit_notebook_file" {
                            if let Some(fp) = args.as_ref().and_then(|a| a.get("filePath")).filter(|v| truthy(v)) {
                                let s = h::js_string(fp);
                                if seen_changed.insert(s.clone()) {
                                    files_changed.push(s);
                                }
                            }
                        }
                        if tool_name == "multi_replace_string_in_file" {
                            if let Some(reps) = args.as_ref().and_then(|a| a.get("replacements")).and_then(Value::as_array) {
                                for r in reps {
                                    if let Some(fp) = r.get("filePath").filter(|v| truthy(v)) {
                                        let s = h::js_string(fp);
                                        if seen_changed.insert(s.clone()) {
                                            files_changed.push(s);
                                        }
                                    }
                                }
                            }
                        }
                        if tool_name == "apply_patch" {
                            if let Some(a) = &args {
                                let content = ["command", "patch", "input"]
                                    .iter()
                                    .find_map(|k| a.get(*k).and_then(Value::as_str).filter(|s| !s.is_empty()))
                                    .unwrap_or("");
                                for line in content.split('\n') {
                                    if let Some(fp) = patch_file_line(line) {
                                        if fp.contains('/') && seen_changed.insert(fp.to_owned()) {
                                            files_changed.push(fp.to_owned());
                                        }
                                    }
                                }
                            }
                        }

                        let mut e = Map::new();
                        e.insert("type".into(), "tool".into());
                        put_span_id(&mut e, child);
                        e.insert("label".into(), format!("{tool_name} {}", h::summarize_tool_args(&tool_name, &args_str)).into());
                        e.insert("durationMs".into(), num(child_dur));
                        e.insert("resultSummary".into(), h::summarize_tool_result(&tool_name, &result_str).into());
                        if !result_str.is_empty() {
                            e.insert("fullResult".into(), result_str.into());
                        }
                        if !args_str.is_empty() {
                            e.insert("toolInput".into(), args_str.clone().into());
                        }
                        e.insert("isError".into(), is_error.into());
                        if is_error {
                            if let Some(m) = status_message(child) {
                                e.insert("errorMessage".into(), m.into());
                            }
                        }
                        e.insert("timestamp".into(), ts.into());
                        if let Some(details) = extract_copilot_edit_details(&tool_name, &args_str) {
                            e.insert("editDetails".into(), details);
                        }
                        Value::Object(e)
                    } else if name.starts_with("chat") {
                        total_llm_calls += 1;
                        let child_model = h::get_gen_ai_model(child);
                        let shape_model = if child_model.is_empty() { model.clone() } else { child_model.clone() };
                        let eb = disjoint_buckets(&h::extract_token_counts(child), usage_shape_for(&shape_model));
                        let ttft = h::get_attr_num(child, "copilot_chat.time_to_first_token");
                        let thinking = h::get_attr_str(child, "copilot_chat.reasoning_content");
                        let output_msgs = h::get_attr_str(child, "gen_ai.output.messages");
                        let action = h::detect_output_action(&output_msgs);
                        let response_text = h::extract_response_text(&output_msgs);

                        if action == "text response" {
                            last_outcome = "text_response";
                        } else if action.starts_with("called") {
                            last_outcome = "tool_calls";
                        }

                        let mut e = Map::new();
                        e.insert("type".into(), "llm".into());
                        put_span_id(&mut e, child);
                        e.insert("label".into(), child_model.clone().into());
                        e.insert("model".into(), child_model.into());
                        if !thinking.is_empty() {
                            e.insert("thinking".into(), h::js_slice(&thinking, 200).into());
                        }
                        e.insert("inputTokens".into(), num(eb.input_tokens));
                        e.insert("outputTokens".into(), num(eb.output_tokens));
                        if eb.cache_read_tokens != 0.0 {
                            e.insert("cacheReadTokens".into(), num(eb.cache_read_tokens));
                        }
                        if eb.cache_create_tokens != 0.0 {
                            e.insert("cacheCreateTokens".into(), num(eb.cache_create_tokens));
                        }
                        e.insert("ttft".into(), num(ttft));
                        e.insert("durationMs".into(), num(child_dur));
                        e.insert("action".into(), action.into());
                        if let Some(rt) = response_text.filter(|t| !t.is_empty()) {
                            e.insert("responseText".into(), rt.into());
                        }
                        e.insert("isError".into(), is_error.into());
                        if is_error {
                            if let Some(m) = status_message(child) {
                                e.insert("errorMessage".into(), m.into());
                            }
                        }
                        e.insert("timestamp".into(), ts.into());
                        Value::Object(e)
                    } else {
                        let mut e = Map::new();
                        e.insert("type".into(), "background".into());
                        put_span_id(&mut e, child);
                        e.insert("label".into(), name.into());
                        e.insert("durationMs".into(), num(child_dur));
                        e.insert("isError".into(), is_error.into());
                        e.insert("timestamp".into(), ts.into());
                        Value::Object(e)
                    }
                })
                .collect();

            let mut card = Map::new();
            // sessionId: agent.spanId — raw field; a missing one is OMITTED (stringify drops
            // undefined), never null.
            if let Some(id) = agent.get("spanId").filter(|v| !v.is_null()) {
                card.insert("sessionId".into(), id.clone());
            }
            card.insert("traceId".into(), agent.get("traceId").and_then(Value::as_str).unwrap_or("").into());
            card.insert("source".into(), "copilot".into());
            card.insert("dataSource".into(), "otel".into());
            card.insert("initiator".into(), "agent".into());
            if let Some(cid) = conversation_id.filter(|c| !c.is_empty()) {
                card.insert("conversationId".into(), cid.into());
            }
            card.insert("workspace".into(), "".into());
            card.insert("userRequest".into(), user_req.into());
            card.insert("model".into(), model.into());
            card.insert("turns".into(), num(turns));
            card.insert("inputTokens".into(), num(b.input_tokens));
            card.insert("outputTokens".into(), num(b.output_tokens));
            card.insert("cacheReadTokens".into(), num(b.cache_read_tokens));
            card.insert("cacheCreateTokens".into(), num(b.cache_create_tokens));
            card.insert("cacheHitRate".into(), num(cache_hit_rate));
            card.insert("durationMs".into(), num(duration_ms));
            card.insert("startTime".into(), if start_ms > 0.0 { iso_from_ms(start_ms).into() } else { "".into() });
            card.insert("filesRead".into(), files_read.into());
            card.insert("filesSearched".into(), files_searched.into());
            card.insert("filesChanged".into(), files_changed.into());
            card.insert("filesWritten".into(), Value::Array(Vec::new()));
            let mut tc = Map::new();
            for (k, v) in tool_counts {
                tc.insert(k, Value::from(v));
            }
            card.insert("toolCounts".into(), Value::Object(tc));
            card.insert("totalToolCalls".into(), Value::from(total_tool_calls));
            card.insert("totalLlmCalls".into(), Value::from(total_llm_calls));
            card.insert("errors".into(), Value::from(errors));
            card.insert("outcome".into(), last_outcome.into());
            card.insert("timeline".into(), Value::Array(timeline));
            card.insert("backgroundSpans".into(), Value::Array(Vec::new()));
            card.insert("loopSignals".into(), Value::Array(Vec::new()));
            Value::Object(card)
        })
        .collect()
}

/// BFS over the child map (the TS `stack.shift()` makes it a QUEUE), dedup by spanId.
fn collect_descendants<'a>(root_span_id: &str, children_of: &HashMap<String, Vec<&'a Value>>) -> Vec<&'a Value> {
    let mut result = Vec::new();
    let mut seen: HashSet<&str> = HashSet::new();
    let mut queue: VecDeque<&Value> = children_of.get(root_span_id).map(|v| v.iter().copied().collect()).unwrap_or_default();
    while let Some(span) = queue.pop_front() {
        let Some(id) = span.get("spanId").and_then(Value::as_str) else { continue };
        if !seen.insert(id) {
            continue;
        }
        result.push(span);
        if let Some(kids) = children_of.get(id) {
            for c in kids {
                queue.push_back(c);
            }
        }
    }
    result
}

/// The `^\*\*\*\s+(?:Update File:|Add File:|Delete File:)?\s*(.+)` line match, shared with the
/// helpers' apply_patch summary.
fn patch_file_line(line: &str) -> Option<&str> {
    static RE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let r = RE.get_or_init(|| regex::Regex::new(r"^\*\*\*\s+(?:Update File:|Add File:|Delete File:)?\s*(.+)").expect("static regex"));
    r.captures(line).and_then(|c| c.get(1)).map(|m| m.as_str().trim()).filter(|s| !s.is_empty())
}

/// extractCopilotEditDetails — EditDetail objects with the exact optional-field omissions.
fn extract_copilot_edit_details(tool_name: &str, args_str: &str) -> Option<Value> {
    let args: Value = serde_json::from_str(args_str).ok()?;
    let detail = |file_path: &Value, old: Option<&Value>, new: Option<&Value>, content: Option<&Value>| -> Value {
        let mut d = Map::new();
        d.insert("filePath".into(), file_path.clone());
        if let Some(o) = old.filter(|v| !v.is_null()) {
            d.insert("oldString".into(), o.clone());
        }
        if let Some(n) = new.filter(|v| !v.is_null()) {
            d.insert("newString".into(), n.clone());
        }
        if let Some(c) = content.filter(|v| !v.is_null()) {
            d.insert("content".into(), c.clone());
        }
        Value::Object(d)
    };
    match tool_name {
        "replace_string_in_file" => {
            let fp = args.get("filePath").filter(|v| truthy(v))?;
            Some(Value::Array(vec![detail(fp, args.get("oldString"), args.get("newString"), None)]))
        }
        "multi_replace_string_in_file" => {
            let reps = args.get("replacements").and_then(Value::as_array)?;
            let out: Vec<Value> = reps
                .iter()
                .filter(|r| r.get("filePath").is_some_and(truthy))
                .map(|r| detail(r.get("filePath").expect("filtered"), r.get("oldString"), r.get("newString"), None))
                .collect();
            Some(Value::Array(out))
        }
        "create_file" => {
            let fp = args.get("filePath").filter(|v| truthy(v))?;
            Some(Value::Array(vec![detail(fp, None, None, args.get("content"))]))
        }
        "apply_patch" => {
            let content = ["command", "patch", "input"]
                .iter()
                .find_map(|k| args.get(*k).and_then(Value::as_str).filter(|s| !s.is_empty()))
                .unwrap_or("");
            let mut details: Vec<Value> = Vec::new();
            let mut current_file = String::new();
            let mut old_lines: Vec<&str> = Vec::new();
            let mut new_lines: Vec<&str> = Vec::new();
            let push = |file: &str, old: &[&str], new: &[&str], details: &mut Vec<Value>| {
                let mut d = Map::new();
                d.insert("filePath".into(), file.into());
                if !old.is_empty() {
                    d.insert("oldString".into(), old.join("\n").into());
                }
                if !new.is_empty() {
                    d.insert("newString".into(), new.join("\n").into());
                }
                details.push(Value::Object(d));
            };
            for line in content.split('\n') {
                if let Some(candidate) = patch_file_line(line) {
                    if !candidate.contains('/') {
                        continue; // *** Begin Patch / End Patch
                    }
                    if !current_file.is_empty() {
                        push(&current_file, &old_lines, &new_lines, &mut details);
                    }
                    current_file = candidate.to_owned();
                    old_lines.clear();
                    new_lines.clear();
                    continue;
                }
                if line.starts_with("@@") {
                    continue;
                }
                if let Some(rest) = line.strip_prefix('-') {
                    old_lines.push(rest);
                } else if let Some(rest) = line.strip_prefix('+') {
                    new_lines.push(rest);
                }
            }
            if !current_file.is_empty() {
                push(&current_file, &old_lines, &new_lines, &mut details);
            }
            if details.is_empty() { None } else { Some(Value::Array(details)) }
        }
        _ => None,
    }
}

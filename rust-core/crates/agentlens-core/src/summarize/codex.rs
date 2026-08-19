//! Port of src/summarizers/codex.ts (TRDD-DMWOBWFH P4d) — codex.* session cards.
//!
//! Same Value-literal discipline as the other builders: object keys mirror the TS literals,
//! `undefined` fields are omitted, `num()` keeps integral numbers bare. The BATCH grouper here
//! (group_codex_spans_by_session) is deliberately a DISTINCT algorithm from the streaming
//! CodexSessionNormalizer in agentlens-ingest — the two share only the atoms that must never
//! drift (the prompt-event predicate, via helpers → the ingest crate, and the
//! `codex:<conv>:prompt-<n>` key format), exactly as the TS comment records (TRDD-4AFOFVFD).
//!
//! JS-quirk notes carried over: `activePromptTraceId` can legitimately hold JS `undefined`
//! (a prompt span without a traceId), and `undefined === undefined` MATCHES — modeled as
//! `Option<String>` compared with `==`.

use serde_json::{Map, Value};
use std::collections::HashMap;
use std::sync::OnceLock;

use super::buckets::{disjoint_buckets, UsageShape};
use super::helpers::{self as h, iso_from_ms, num, put_span_id, truthy, JsSet};

const CONV_KEYS: [&str; 7] = [
    "conversation.id", "conversation_id", "codex.conversation.id",
    "thread.id", "thread_id", "session.id", "session_id",
];
const TURN_KEYS: [&str; 3] = ["turn.id", "turn_id", "codex.turn.id"];

/// maxOrDefault — the largest value, or `fallback` for an EMPTY slice (a max smaller than the
/// fallback is still returned; the TS comment's TRDD-2YP3DB9Y no-spread lesson is moot in Rust,
/// but the semantics are kept verbatim).
pub fn max_or_default(xs: &[f64], fallback: f64) -> f64 {
    let mut it = xs.iter();
    let Some(first) = it.next() else { return fallback };
    let mut best = *first;
    for x in it {
        if *x > best {
            best = *x;
        }
    }
    best
}

/// nanoToMs(startTime) || receivedAt || 0 — the stored-span timing fallback.
fn to_ms(s: &Value) -> f64 {
    let n = h::nano_to_ms(h::start_time(s));
    if n != 0.0 {
        return n;
    }
    let r = s.get("receivedAt").and_then(Value::as_f64).unwrap_or(0.0);
    if r != 0.0 { r } else { 0.0 }
}

fn received_or(s: &Value, from_nano: f64) -> f64 {
    if from_nano != 0.0 {
        return from_nano;
    }
    let r = s.get("receivedAt").and_then(Value::as_f64).unwrap_or(0.0);
    if r != 0.0 { r } else { 0.0 }
}

pub fn build_codex_sessions(spans: &[Value]) -> Vec<Value> {
    group_codex_spans_by_session(spans)
        .into_iter()
        .map(|(key, group)| build_codex_card(&key, &group))
        .collect()
}

fn is_codex_span(span: &Value) -> bool {
    if h::name_of(span).starts_with("codex.") {
        return true;
    }
    if !h::get_first_attr(span, &["codex.session.id"]).is_empty() {
        return true;
    }
    !h::get_first_attr(span, &["thread.id", "thread_id"]).is_empty()
        && !h::get_first_attr(span, &TURN_KEYS).is_empty()
}

struct WorkingGroup<'a> {
    key: String,
    spans: Vec<&'a Value>,
    has_prompt: bool,
}

fn next_prompt_key(ordinals: &mut HashMap<String, u64>, conversation_id: &str) -> String {
    let next = ordinals.get(conversation_id).copied().unwrap_or(0) + 1;
    ordinals.insert(conversation_id.to_owned(), next);
    // codexPromptSessionId — the canonical per-prompt key, format shared with the ingest
    // normalizer's next_prompt_session_id.
    format!("codex:{conversation_id}:prompt-{next}")
}

fn create_group<'a>(groups: &mut Vec<WorkingGroup<'a>>, index: &mut HashMap<String, usize>, key: &str) -> usize {
    groups.push(WorkingGroup { key: key.to_owned(), spans: Vec::new(), has_prompt: false });
    let i = groups.len() - 1;
    index.insert(key.to_owned(), i);
    i
}

fn get_group<'a>(groups: &mut Vec<WorkingGroup<'a>>, index: &mut HashMap<String, usize>, key: &str) -> usize {
    match index.get(key) {
        Some(&i) => i,
        None => create_group(groups, index, key),
    }
}

/// groupCodexSpansBySession — insertion-ordered (group key, spans) pairs; the key becomes the
/// card's traceId.
pub fn group_codex_spans_by_session(spans: &[Value]) -> Vec<(String, Vec<&Value>)> {
    let mut groups: Vec<WorkingGroup> = Vec::new();
    let mut index_by_key: HashMap<String, usize> = HashMap::new();
    let mut current_by_conversation: HashMap<String, usize> = HashMap::new();
    let mut ordinal_by_conversation: HashMap<String, u64> = HashMap::new();
    let mut turn_session_by_raw_trace_id: HashMap<String, String> = HashMap::new();
    let mut active_prompt_group: Option<usize> = None;
    // '' initially, then whatever the last prompt span carried — including JS undefined (None).
    let mut active_prompt_trace_id: Option<String> = Some(String::new());

    for span in spans {
        let trace_id = span.get("traceId").and_then(Value::as_str).unwrap_or("");
        if trace_id.is_empty() {
            continue;
        }
        let explicit = h::get_first_attr(span, &["codex.session.id"]);
        let raw_otel = h::get_first_attr(span, &["otel.trace_id"]);
        if !explicit.is_empty() && !raw_otel.is_empty() {
            turn_session_by_raw_trace_id.insert(raw_otel, explicit.clone());
        }
        let conversation_id = h::get_first_attr(span, &CONV_KEYS);
        let turn_id = h::get_first_attr(span, &TURN_KEYS);
        if !conversation_id.is_empty() && !turn_id.is_empty() {
            let v = if explicit.is_empty() { format!("codex:{conversation_id}:{turn_id}") } else { explicit };
            turn_session_by_raw_trace_id.insert(trace_id.to_owned(), v);
        }
    }

    let mut codex_spans: Vec<&Value> = spans
        .iter()
        .filter(|s| {
            is_codex_span(s) || {
                let t = s.get("traceId").and_then(Value::as_str).unwrap_or("");
                !t.is_empty() && turn_session_by_raw_trace_id.contains_key(t)
            }
        })
        .collect();
    codex_spans.sort_by(|a, b| to_ms(a).partial_cmp(&to_ms(b)).unwrap_or(std::cmp::Ordering::Equal));

    for span in codex_spans {
        let conversation_id = h::get_first_attr(span, &CONV_KEYS);
        let explicit = h::get_first_attr(span, &["codex.session.id"]);
        let turn_id = h::get_first_attr(span, &TURN_KEYS);
        let is_prompt = h::is_codex_prompt_span_name(h::name_of(span));
        let trace_id: Option<String> = span.get("traceId").and_then(Value::as_str).map(str::to_owned);
        let turn_session_id: Option<String> = trace_id
            .as_deref()
            .filter(|t| !t.is_empty())
            .and_then(|t| turn_session_by_raw_trace_id.get(t).cloned())
            .or_else(|| {
                if !conversation_id.is_empty() && !turn_id.is_empty() {
                    Some(if explicit.is_empty() { format!("codex:{conversation_id}:{turn_id}") } else { explicit.clone() })
                } else {
                    None
                }
            });

        let mut gi: Option<usize> = None;
        if is_prompt {
            if let Some(ts_id) = turn_session_id.as_deref() {
                if let Some(&i) = index_by_key.get(ts_id) {
                    gi = Some(i);
                }
            }
            if gi.is_none() && !conversation_id.is_empty() {
                if let Some(&ci) = current_by_conversation.get(&conversation_id) {
                    if !groups[ci].has_prompt {
                        gi = Some(ci);
                    }
                }
            }
            if gi.is_none() {
                let fallback_conversation: &str = if !conversation_id.is_empty() {
                    &conversation_id
                } else if let Some(t) = trace_id.as_deref().filter(|t| !t.is_empty()) {
                    t
                } else {
                    "unknown"
                };
                let base_key = if !explicit.is_empty() {
                    explicit.clone()
                } else if let Some(t) = turn_session_id.clone() {
                    t
                } else {
                    next_prompt_key(&mut ordinal_by_conversation, fallback_conversation)
                };
                let idx = get_group(&mut groups, &mut index_by_key, &base_key);
                gi = Some(if groups[idx].has_prompt {
                    let k = next_prompt_key(&mut ordinal_by_conversation, fallback_conversation);
                    create_group(&mut groups, &mut index_by_key, &k)
                } else {
                    idx
                });
            }
            let i = gi.expect("resolved above");
            groups[i].has_prompt = true;
            if !conversation_id.is_empty() {
                current_by_conversation.insert(conversation_id.clone(), i);
            }
        } else if active_prompt_group.is_some() && trace_id == active_prompt_trace_id {
            // Only absorb spans from the same OTEL trace as the prompt.
            gi = active_prompt_group;
            if !conversation_id.is_empty() {
                current_by_conversation.insert(conversation_id.clone(), gi.expect("checked"));
            }
        } else if let Some(ts_id) = turn_session_id.as_deref() {
            gi = Some(get_group(&mut groups, &mut index_by_key, ts_id));
            if !conversation_id.is_empty() {
                current_by_conversation.insert(conversation_id.clone(), gi.expect("just set"));
            }
        } else if !conversation_id.is_empty() {
            gi = current_by_conversation.get(&conversation_id).copied();
        }

        let Some(i) = gi else { continue };
        groups[i].spans.push(span);
        if is_prompt {
            active_prompt_group = Some(i);
            active_prompt_trace_id = trace_id;
        }
    }

    groups.into_iter().map(|g| (g.key, g.spans)).collect()
}

fn extract_codex_token_counts(span: &Value) -> h::TokenCounts {
    let input = h::first_nonzero(span, &[
        "gen_ai.usage.input_tokens", "input_token_count", "input_tokens", "prompt_tokens",
        "codex.turn.token_usage.input_tokens",
    ]);
    let cache_read = h::first_nonzero(span, &[
        "gen_ai.usage.cache_read.input_tokens", "cached_token_count", "cache_read_tokens",
        "codex.turn.token_usage.cached_input_tokens",
    ]);
    let cache_create = h::first_nonzero(span, &["gen_ai.usage.cache_creation.input_tokens", "cache_creation_tokens"]);
    let reasoning = h::first_nonzero(span, &[
        "reasoning_token_count", "codex.usage.reasoning_output_tokens",
        "codex.turn.token_usage.reasoning_output_tokens",
    ]);
    let output_base = h::first_nonzero(span, &[
        "gen_ai.usage.output_tokens", "output_token_count", "output_tokens", "completion_tokens",
        "codex.turn.token_usage.output_tokens",
    ]);
    h::TokenCounts { input, output: output_base + reasoning, cache_read, cache_create }
}

fn is_duplicate_codex_token_record(span: &Value) -> bool {
    if matches!(h::name_of(span), "handle_responses" | "session_task.turn" | "codex.turn") {
        return true;
    }
    let otel = h::get_first_attr(span, &["otel.name"]);
    otel == "session_task.turn" || otel == "codex.turn"
}

fn is_codex_timeline_llm_span(span: &Value, input_tokens: f64, output_tokens: f64) -> bool {
    if input_tokens > 0.0 || output_tokens > 0.0 {
        return true;
    }
    let name = h::name_of(span);
    if !h::is_codex_llm_span_name(name) {
        return false;
    }
    if name == "codex.sse_event" {
        let kind = h::get_first_attr(span, &["event.kind", "codex.event.kind", "codex.event.type"]).to_lowercase();
        if kind.is_empty() {
            return true;
        }
        return matches!(kind.as_str(), "response.completed" | "response.failed" | "response.cancelled" | "response.incomplete");
    }
    // Only exact known LLM span names without tokens; broad name.includes() matches are not
    // real completions.
    matches!(name, "codex.completion" | "codex.response" | "codex.stream_event")
}

/// The shell-command file extractor — JS \w/\s are ASCII/whitespace classes here; the quote
/// strip and the `*` guard in TS are dead-by-construction (the class admits neither) but the
/// guards are kept verbatim.
fn file_re() -> &'static regex::Regex {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| {
        regex::Regex::new(
            r#"(?:^|[\s'"<>`|])([./~]?(?:[0-9A-Za-z_.-]+/)+[0-9A-Za-z_.-]+\.(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|swift|cpp|c|h|cs|php|html|css|scss|json|yaml|yml|toml|md|txt|sh|env))\b"#,
        )
        .expect("static regex compiles")
    })
}

fn build_codex_card(key: &str, trace_group: &[&Value]) -> Value {
    let mut trace_spans: Vec<&Value> = trace_group.to_vec();
    trace_spans.sort_by(|a, b| to_ms(a).partial_cmp(&to_ms(b)).unwrap_or(std::cmp::Ordering::Equal));
    let prompt_span: Option<&Value> = trace_spans.iter().copied().find(|s| h::is_codex_prompt_span_name(h::name_of(s)));
    let root_span: Option<&Value> = prompt_span.or_else(|| trace_spans.first().copied());

    let (mut input_tokens, mut output_tokens, mut cache_read_tokens, mut cache_create_tokens) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let (mut total_llm_calls, mut total_tool_calls, mut errors) = (0.0f64, 0.0f64, 0.0f64);
    let mut model = String::new();
    let mut tool_counts: Vec<(String, f64)> = Vec::new();
    let mut files_read = JsSet::default();
    let mut files_searched = JsSet::default();
    let mut files_changed = JsSet::default();

    // Pre-pass: index tool_decision (tool_name) and tool.call (arguments) by call_id so
    // tool_result entries can merge all three into one coherent timeline entry.
    let mut tool_name_by_call_id: HashMap<String, String> = HashMap::new();
    let mut tool_args_by_call_id: HashMap<String, String> = HashMap::new();
    let has_completion_events = trace_spans.iter().any(|s| {
        h::name_of(s) == "codex.sse_event" && {
            let u = extract_codex_token_counts(s);
            u.input > 0.0 || u.output > 0.0
        }
    });
    for s in &trace_spans {
        let call_id = h::get_first_attr(s, &["call_id"]);
        if call_id.is_empty() {
            continue;
        }
        let name = h::name_of(s);
        if h::is_codex_tool_decision_span(name) {
            let n = h::get_first_attr(s, &["tool_name"]);
            if !n.is_empty() {
                tool_name_by_call_id.insert(call_id, n);
            }
        } else if h::is_codex_tool_call_span(name) {
            let a = h::get_first_attr(s, &["arguments"]);
            if !a.is_empty() {
                tool_args_by_call_id.insert(call_id, a);
            }
        }
    }

    let mut last_ttft_ms = 0.0f64;
    let mut timeline: Vec<Value> = Vec::new();
    let mut background_spans: Vec<Value> = Vec::new();
    for child in &trace_spans {
        if prompt_span.is_some_and(|p| child.get("spanId") == p.get("spanId")) {
            continue;
        }
        let name = h::name_of(child);
        if name == "codex.websocket_event" {
            continue;
        }

        let child_start = h::nano_to_ms(h::start_time(child));
        let child_end = h::nano_to_ms(child.get("endTime").and_then(Value::as_str).unwrap_or(""));
        let child_dur = {
            let d = child_end - child_start;
            if d != 0.0 {
                d
            } else {
                let a = h::get_attr_num(child, "codex.api.duration_ms");
                if a != 0.0 {
                    a
                } else {
                    let b2 = h::get_attr_num(child, "codex.duration_ms");
                    if b2 != 0.0 { b2 } else { h::get_attr_num(child, "duration_ms") }
                }
            }
        };
        let is_error = h::status_is_error(child)
            || h::get_first_attr(child, &["codex.api.success"]) == "false"
            || h::get_first_attr(child, &["codex.tool.success"]) == "false"
            || h::get_first_attr(child, &["success"]) == "false";
        if is_error {
            errors += 1.0;
        }
        let ts = if child_start > 0.0 { iso_from_ms(child_start) } else { String::new() };

        let child_model = h::get_first_attr(child, &["gen_ai.request.model", "gen_ai.response.model", "model"]);
        if !child_model.is_empty() {
            model = child_model.clone();
        }

        let raw_usage = extract_codex_token_counts(child);
        let (in_tok, out_tok) = (raw_usage.input, raw_usage.output);
        // OpenAI-shaped usage (cached ⊂ input): the constructor sheds the cacheRead share so the
        // four buckets stay DISJOINT.
        let b = disjoint_buckets(&raw_usage, UsageShape::OpenAi);

        // Prefer the terminal sse_event stream; skip raw handle_responses / session_task.turn
        // rollups of the same usage (errors/model above still counted — TS order preserved).
        if has_completion_events && is_duplicate_codex_token_record(child) {
            continue;
        }

        if h::is_codex_tool_exec_span(child) {
            let call_id = h::get_first_attr(child, &["call_id"]);

            // tool_decision IS an LLM turn; when sse_events carry tokens the completed event
            // already accounts for it — skip to avoid doubling.
            if h::is_codex_tool_decision_span(name) {
                if !has_completion_events && (in_tok > 0.0 || out_tok > 0.0) {
                    total_llm_calls += 1.0;
                    input_tokens += b.input_tokens;
                    output_tokens += b.output_tokens;
                    cache_read_tokens += b.cache_read_tokens;
                    cache_create_tokens += b.cache_create_tokens;
                }
                continue;
            }

            // tool.call paired with a tool_decision via call_id: the tool_result owns the entry.
            if h::is_codex_tool_call_span(name) && !call_id.is_empty() && tool_name_by_call_id.contains_key(&call_id) {
                continue;
            }

            total_tool_calls += 1.0;

            let tool_name: String = (!call_id.is_empty())
                .then(|| tool_name_by_call_id.get(&call_id).cloned())
                .flatten()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| {
                    let n = h::get_first_attr(child, &["tool_name", "codex.tool.name", "gen_ai.tool.name"]);
                    if n.is_empty() { "tool".to_owned() } else { n }
                });
            match tool_counts.iter_mut().find(|(k, _)| *k == tool_name) {
                Some((_, n)) => *n += 1.0,
                None => tool_counts.push((tool_name.clone(), 1.0)),
            }

            let args_str: String = (!call_id.is_empty())
                .then(|| tool_args_by_call_id.get(&call_id).cloned())
                .flatten()
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| h::get_first_attr(child, &["gen_ai.tool.call.arguments", "tool_input", "input", "arguments"]));

            // tool_result carries end-to-end duration; other spans use span timing.
            let is_result = h::is_codex_tool_result_span(name);
            let dur = {
                let a = if is_result { h::get_attr_num(child, "duration_ms") } else { 0.0 };
                if a != 0.0 {
                    a
                } else {
                    let b2 = h::get_attr_num(child, "codex.tool.duration_ms");
                    if b2 != 0.0 { b2 } else { child_dur }
                }
            };
            let result_text = if is_result {
                h::get_first_attr(child, &["output", "result", "tool_result", "content", "stdout", "stderr"])
            } else {
                String::new()
            };

            let mut found_file_path = false;
            let mut cmd_from_args: Option<String> = None;
            if !args_str.is_empty() {
                if let Ok(args) = serde_json::from_str::<Value>(&args_str) {
                    if !args.is_null() {
                        let fp = [args.get("filePath"), args.get("file_path"), args.get("path")]
                            .into_iter()
                            .flatten()
                            .find(|v| truthy(v));
                        if let Some(fp) = fp {
                            found_file_path = true;
                            let fp_str = h::js_string(fp);
                            if tool_name == "read_file" || tool_name == "Read" {
                                let base = fp_str.rsplit('/').next().unwrap_or("");
                                files_read.add_str(if base.is_empty() { fp_str.clone() } else { base.to_owned() });
                            } else if tool_name == "grep_search" || tool_name == "file_search" || tool_name == "Glob" || tool_name == "Grep" {
                                let sv = [args.get("query"), args.get("pattern")]
                                    .into_iter()
                                    .flatten()
                                    .find(|v| truthy(v))
                                    .map(h::js_string)
                                    .unwrap_or_else(|| fp_str.clone());
                                files_searched.add_str(sv);
                            } else {
                                files_changed.add_str(fp_str);
                            }
                        }
                        // Codex shell tool: the command nests inside the args JSON.
                        if !found_file_path {
                            if let Some(c) = [args.get("command"), args.get("cmd")].into_iter().flatten().find(|v| truthy(v)) {
                                cmd_from_args = Some(h::js_string(c));
                            }
                        }
                    }
                }
            }
            // Extract file paths from the shell command string (Codex primarily uses bash).
            if !found_file_path {
                let cmd = cmd_from_args
                    .filter(|c| !c.is_empty())
                    .unwrap_or_else(|| h::get_first_attr(child, &["cmd", "command", "codex.tool.cmd", "codex.tool.command", "shell_command"]));
                if !cmd.is_empty() {
                    for cap in file_re().captures_iter(&cmd) {
                        let p = cap.get(1).expect("group 1 always participates").as_str();
                        if p.len() > 2 && !p.contains('*') {
                            files_changed.add_str(p.to_owned());
                        }
                    }
                }
            }

            let mut e = Map::new();
            e.insert("type".into(), "tool".into());
            put_span_id(&mut e, child);
            e.insert("label".into(), tool_name.clone().into());
            e.insert("durationMs".into(), num(dur));
            if !args_str.is_empty() {
                e.insert("toolInput".into(), args_str.clone().into());
            }
            e.insert("isError".into(), is_error.into());
            if is_error {
                let msg = h::status_message(child).map(str::to_owned).or_else(|| {
                    let m = h::get_first_attr(child, &["error.message"]);
                    if m.is_empty() { None } else { Some(m) }
                });
                if let Some(m) = msg {
                    e.insert("errorMessage".into(), m.into());
                }
            }
            if !result_text.is_empty() {
                e.insert("resultSummary".into(), h::summarize_tool_result(&tool_name, &result_text).into());
                e.insert("fullResult".into(), result_text.clone().into());
            }
            e.insert("timestamp".into(), ts.into());
            timeline.push(Value::Object(e));
        } else if is_codex_timeline_llm_span(child, in_tok, out_tok) {
            total_llm_calls += 1.0;
            input_tokens += b.input_tokens;
            output_tokens += b.output_tokens;
            cache_read_tokens += b.cache_read_tokens;
            cache_create_tokens += b.cache_create_tokens;
            let ttft_ms = {
                let a = h::get_attr_num(child, "ttft_ms");
                if a != 0.0 {
                    a
                } else {
                    let b2 = h::get_attr_num(child, "codex.ttft_ms");
                    if b2 != 0.0 {
                        b2
                    } else if last_ttft_ms != 0.0 {
                        last_ttft_ms
                    } else {
                        0.0
                    }
                }
            };
            last_ttft_ms = 0.0;
            let mut e = Map::new();
            e.insert("type".into(), "llm".into());
            put_span_id(&mut e, child);
            e.insert(
                "label".into(),
                if !child_model.is_empty() {
                    child_model.clone()
                } else if !model.is_empty() {
                    model.clone()
                } else {
                    "Codex".to_owned()
                }
                .into(),
            );
            e.insert("model".into(), (if !child_model.is_empty() { child_model.clone() } else { model.clone() }).into());
            e.insert("inputTokens".into(), num(b.input_tokens));
            e.insert("outputTokens".into(), num(b.output_tokens));
            if b.cache_read_tokens != 0.0 {
                e.insert("cacheReadTokens".into(), num(b.cache_read_tokens));
            }
            if b.cache_create_tokens != 0.0 {
                e.insert("cacheCreateTokens".into(), num(b.cache_create_tokens));
            }
            if ttft_ms != 0.0 {
                e.insert("ttft".into(), num(ttft_ms));
            }
            {
                let a = h::get_first_attr(child, &["codex.event.type", "event.kind", "stop_reason"]);
                if !a.is_empty() {
                    e.insert("action".into(), a.into());
                }
            }
            {
                let r = h::get_first_attr(child, &["output_text", "assistant_response"]);
                if !r.is_empty() {
                    e.insert("responseText".into(), r.into());
                }
            }
            e.insert("durationMs".into(), num(child_dur));
            e.insert("isError".into(), is_error.into());
            if is_error {
                if let Some(m) = h::status_message(child) {
                    e.insert("errorMessage".into(), m.into());
                }
            }
            e.insert("timestamp".into(), ts.into());
            timeline.push(Value::Object(e));
        } else {
            // Capture TTFT from codex.turn_ttft so the next LLM entry can report it.
            if name == "codex.turn_ttft" {
                let t = {
                    let a = h::get_attr_num(child, "duration_ms");
                    if a != 0.0 { a } else { child_dur }
                };
                if t > 0.0 {
                    last_ttft_ms = t;
                }
            }
            let mut bg = Map::new();
            bg.insert("name".into(), name.into());
            bg.insert("model".into(), (if !child_model.is_empty() { child_model.clone() } else { model.clone() }).into());
            bg.insert("purpose".into(), name.into());
            bg.insert("inputTokens".into(), num(in_tok));
            bg.insert("outputTokens".into(), num(out_tok));
            background_spans.push(Value::Object(bg));
        }
    }

    let conversation_id: Option<String> = trace_spans
        .iter()
        .map(|s| h::get_first_attr(s, &["conversation.id", "conversation_id", "codex.conversation.id"]))
        .find(|v| !v.is_empty() && v.chars().map(char::len_utf16).sum::<usize>() > 10);

    let workspace = trace_spans
        .iter()
        .map(|s| h::get_first_attr(s, &["cwd"]))
        .find(|v| !v.is_empty() && v.starts_with('/'))
        .unwrap_or_default();

    let start_ms = match root_span {
        Some(r) => received_or(r, h::nano_to_ms(h::start_time(r))),
        None => trace_spans.first().and_then(|s| s.get("receivedAt")).and_then(Value::as_f64).unwrap_or(0.0),
    };
    let user_prompt_text = prompt_span
        .map(|p| {
            h::get_first_attr(p, &[
                "user_prompt", "prompt", "codex.user_prompt", "codex.prompt",
                "message", "content", "text", "user_message", "input",
                "codex.user_message", "codex.input",
            ])
        })
        .unwrap_or_default();
    let prompt_length = prompt_span
        .map(|p| {
            let a = h::get_attr_num(p, "user_prompt.length");
            if a != 0.0 {
                a
            } else {
                let b2 = h::get_attr_num(p, "user_prompt_length");
                if b2 != 0.0 { b2 } else { h::get_attr_num(p, "prompt_length") }
            }
        })
        .unwrap_or(0.0);
    let user_request = h::normalize_user_request(
        &user_prompt_text,
        prompt_length,
        if prompt_span.is_some() { "[prompt unavailable]" } else { "[session in progress]" },
        None,
    );

    let last_llm_action: Option<Option<String>> = timeline
        .iter()
        .rev()
        .find(|e| e.get("type").and_then(Value::as_str) == Some("llm"))
        .map(|e| e.get("action").and_then(Value::as_str).map(str::to_owned));
    let outcome = match &last_llm_action {
        Some(Some(a)) if a.contains("fail") || a.contains("cancel") => "unknown",
        Some(_) => "text_response",
        None => "unknown",
    };

    // The accumulators are already DISJOINT (the OpenAI cached-⊂-input share was shed per call).
    let total_context = input_tokens + cache_read_tokens + cache_create_tokens;
    let cache_hit_rate = if total_context > 0.0 { cache_read_tokens / total_context } else { 0.0 };

    let all_end_times: Vec<f64> = trace_spans
        .iter()
        .map(|s| received_or(s, h::nano_to_ms(s.get("endTime").and_then(Value::as_str).unwrap_or(""))))
        .filter(|t| *t > 0.0)
        .collect();
    let end_ms = max_or_default(&all_end_times, start_ms);
    let duration_ms = end_ms - start_ms;

    let mut card = Map::new();
    match prompt_span.and_then(|p| p.get("spanId")).filter(|v| truthy(v)) {
        Some(id) => {
            card.insert("sessionId".into(), id.clone());
        }
        None => {
            card.insert("sessionId".into(), format!("codex-{key}").into());
        }
    }
    card.insert("traceId".into(), key.into());
    card.insert("source".into(), "codex".into());
    card.insert("dataSource".into(), "otel".into());
    if let Some(c) = conversation_id {
        card.insert("conversationId".into(), c.into());
    }
    card.insert("workspace".into(), workspace.into());
    card.insert("userRequest".into(), user_request.into());
    card.insert("model".into(), model.into());
    card.insert("turns".into(), num(total_llm_calls));
    card.insert("inputTokens".into(), num(input_tokens));
    card.insert("outputTokens".into(), num(output_tokens));
    card.insert("cacheReadTokens".into(), num(cache_read_tokens));
    card.insert("cacheCreateTokens".into(), num(cache_create_tokens));
    card.insert("cacheHitRate".into(), num(cache_hit_rate));
    card.insert("durationMs".into(), num(duration_ms));
    card.insert("startTime".into(), if start_ms > 0.0 { iso_from_ms(start_ms).into() } else { Value::from("") });
    card.insert("filesRead".into(), files_read.into_value());
    card.insert("filesSearched".into(), files_searched.into_value());
    card.insert("filesChanged".into(), files_changed.into_value());
    card.insert("filesWritten".into(), Value::Array(Vec::new()));
    {
        let mut tc = Map::new();
        for (k, v) in tool_counts {
            tc.insert(k, num(v));
        }
        card.insert("toolCounts".into(), Value::Object(tc));
    }
    card.insert("totalToolCalls".into(), num(total_tool_calls));
    card.insert("totalLlmCalls".into(), num(total_llm_calls));
    card.insert("errors".into(), num(errors));
    card.insert("outcome".into(), outcome.into());
    card.insert("timeline".into(), Value::Array(timeline));
    card.insert("backgroundSpans".into(), Value::Array(background_spans));
    card.insert("loopSignals".into(), Value::Array(Vec::new()));
    Value::Object(card)
}

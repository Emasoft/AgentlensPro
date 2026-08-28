//! Port of src/spanSummarizer.ts::summarizeSpans (TRDD-DMWOBWFH P4d) — the top-level pass:
//! grouping, the two synth-root passes (in-progress Claude traces, orphan Copilot chat trees),
//! the three builders, loop signals, background-span association, and the efficiency report.
//!
//! Ports the TS control flow verbatim over `serde_json::Value` cards. One deliberate deviation:
//! the synth passes' `(a.startTime ?? '0') < (b.startTime ?? '0') ? -1 : 1` comparator never
//! returns 0, which Rust's sort_by may PANIC on (non-total order) — the port uses the
//! consistent `str::cmp`, identical for distinct startTimes; ties may order differently than
//! V8's TimSort (only the synthesized root's start/end anchor could notice).

use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use super::claude::build_claude_sessions;
use super::codex::build_codex_sessions;
use super::copilot::build_copilot_sessions;
use super::helpers::{self as h, js_slice, num, utf16_len};
use super::loop_detector::detect_loop_signals;

fn f(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}

fn sstr<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn empty_efficiency() -> Value {
    let mut e = Map::new();
    e.insert("totalInputTokens".into(), num(0.0));
    e.insert("totalOutputTokens".into(), num(0.0));
    e.insert("totalLlmCalls".into(), num(0.0));
    e.insert("avgInputPerCall".into(), num(0.0));
    e.insert("avgTtft".into(), num(0.0));
    e.insert("cacheHitRate".into(), num(0.0));
    e.insert("toolDefWaste".into(), num(0.0));
    e.insert("sysInstructionWaste".into(), num(0.0));
    e.insert("topTokenConsumers".into(), Value::Array(Vec::new()));
    Value::Object(e)
}

/// The synth passes' string-compare sort on raw startTime (`?? '0'`).
fn sort_by_start_string(spans: &mut [&Value]) {
    spans.sort_by(|a, b| {
        let sa = a.get("startTime").and_then(Value::as_str).unwrap_or("0");
        let sb = b.get("startTime").and_then(Value::as_str).unwrap_or("0");
        sa.cmp(sb)
    });
}

fn str_attr(key: &str, value: &str) -> Value {
    let mut a = Map::new();
    a.insert("key".into(), key.into());
    let mut v = Map::new();
    v.insert("stringValue".into(), value.into());
    a.insert("value".into(), Value::Object(v));
    Value::Object(a)
}

fn int_attr(key: &str, value: f64) -> Value {
    let mut a = Map::new();
    a.insert("key".into(), key.into());
    let mut v = Map::new();
    v.insert("intValue".into(), num(value));
    a.insert("value".into(), Value::Object(v));
    Value::Object(a)
}

/// `&[Arc<Value>]`, not `&[Value]`: the caller is the live span window, which hands out a shared
/// snapshot so this (the expensive pass) runs off the state lock — TRDD-HFV4AIT7. Read-only, so
/// the sharing is invisible here.
pub fn summarize_spans(spans: &[Arc<Value>], account_for: &dyn Fn(&str) -> Option<String>) -> Value {
    if spans.is_empty() {
        let mut r = Map::new();
        r.insert("sessions".into(), Value::Array(Vec::new()));
        r.insert("backgroundSpans".into(), Value::Array(Vec::new()));
        r.insert("efficiency".into(), empty_efficiency());
        return Value::Object(r);
    }

    // ── Grouping ─────────────────────────────────────────────────────────────
    let mut children_of: HashMap<String, Vec<&Value>> = HashMap::new();
    let mut invoke_agent_spans: Vec<&Value> = Vec::new();
    let mut claude_interaction_spans: Vec<&Value> = Vec::new();
    let mut orphan_spans: Vec<&Value> = Vec::new();
    let mut spans_by_trace_id: HashMap<String, Vec<&Value>> = HashMap::new();
    // Object key insertion order — Object.entries iterates first-seen (no integer-like trace
    // ids in practice; hex/uuid ids never parse as array indices).
    let mut trace_id_order: Vec<String> = Vec::new();

    for s in spans {
        let name = h::name_of(s);
        if name.starts_with("invoke_agent") {
            invoke_agent_spans.push(s);
        } else if name == "claude_code.interaction" {
            claude_interaction_spans.push(s);
        }
        let parent = s.get("parentSpanId").and_then(Value::as_str).unwrap_or("");
        if !parent.is_empty() {
            children_of.entry(parent.to_owned()).or_default().push(s);
        } else if !name.starts_with("invoke_agent") && name != "claude_code.interaction" {
            orphan_spans.push(s);
        }
        let trace_id = s.get("traceId").and_then(Value::as_str).unwrap_or("");
        if !trace_id.is_empty() {
            match spans_by_trace_id.entry(trace_id.to_owned()) {
                std::collections::hash_map::Entry::Occupied(mut e) => e.get_mut().push(s),
                std::collections::hash_map::Entry::Vacant(e) => {
                    trace_id_order.push(trace_id.to_owned());
                    e.insert(vec![s]);
                }
            }
        }
    }

    // ── Synthesize Claude interaction roots for in-progress traces ───────────
    let existing_interaction_trace_ids: HashSet<&str> = claude_interaction_spans
        .iter()
        .filter_map(|s| s.get("traceId").and_then(Value::as_str))
        .filter(|t| !t.is_empty())
        .collect();
    let mut synth_claude: Vec<Value> = Vec::new();
    for trace_id in &trace_id_order {
        if existing_interaction_trace_ids.contains(trace_id.as_str()) {
            continue;
        }
        let trace_spans = &spans_by_trace_id[trace_id];
        let has_claude_spans = trace_spans.iter().any(|s| {
            matches!(
                h::name_of(s),
                "claude_code.llm_request" | "claude_code.tool" | "claude_code.api_request"
                    | "claude_code.compaction" | "claude_code.api_error" | "claude_code.api_retries_exhausted"
            )
        });
        if !has_claude_spans {
            continue;
        }
        let mut sorted: Vec<&Value> = trace_spans.clone();
        sort_by_start_string(&mut sorted);
        // Phase B: propagate the transcript UUID so the builder can group this trace with the
        // rest of its session; a trace whose spans carry none stays keyed synth-<traceId>.
        let mut claude_session_id = String::new();
        for s in trace_spans {
            claude_session_id = h::get_attr_str(s, "session.id");
            if !claude_session_id.is_empty() {
                break;
            }
        }
        let mut synth = Map::new();
        synth.insert("traceId".into(), trace_id.as_str().into());
        synth.insert("spanId".into(), format!("synth-{}", js_slice(trace_id, 12)).into());
        synth.insert("name".into(), "claude_code.interaction".into());
        if let Some(st) = sorted[0].get("startTime") {
            synth.insert("startTime".into(), st.clone());
        }
        if let Some(et) = sorted[sorted.len() - 1].get("endTime") {
            synth.insert("endTime".into(), et.clone());
        }
        synth.insert(
            "attributes".into(),
            if claude_session_id.is_empty() {
                Value::Array(Vec::new())
            } else {
                Value::Array(vec![str_attr("session.id", &claude_session_id)])
            },
        );
        synth_claude.push(Value::Object(synth));
    }
    for s in &synth_claude {
        claude_interaction_spans.push(s);
    }

    // ── Synthesize invoke_agent roots for in-progress Copilot sessions ───────
    let all_span_ids: HashSet<&str> = spans
        .iter()
        .filter_map(|s| s.get("spanId").and_then(Value::as_str))
        .filter(|i| !i.is_empty())
        .collect();
    let existing_invoke_trace_ids: HashSet<&str> = invoke_agent_spans
        .iter()
        .filter_map(|s| s.get("traceId").and_then(Value::as_str))
        .filter(|t| !t.is_empty())
        .collect();
    let existing_invoke_span_ids: HashSet<&str> = invoke_agent_spans
        .iter()
        .filter_map(|s| s.get("spanId").and_then(Value::as_str))
        .filter(|i| !i.is_empty())
        .collect();
    let mut orphan_parent_children: Vec<(String, Vec<&Value>)> = Vec::new();
    for s in spans {
        let parent = s.get("parentSpanId").and_then(Value::as_str).unwrap_or("");
        if parent.is_empty() || all_span_ids.contains(parent) {
            continue;
        }
        let name = h::name_of(s);
        if !name.starts_with("chat") && !name.starts_with("execute_tool") {
            continue;
        }
        let trace_id = s.get("traceId").and_then(Value::as_str).unwrap_or("");
        if !trace_id.is_empty() && existing_invoke_trace_ids.contains(trace_id) {
            continue;
        }
        match orphan_parent_children.iter_mut().find(|(k, _)| k == parent) {
            Some((_, v)) => v.push(s),
            None => orphan_parent_children.push((parent.to_owned(), vec![s])),
        }
    }
    let mut synth_invoke: Vec<Value> = Vec::new();
    for (parent_id, children) in &orphan_parent_children {
        if existing_invoke_span_ids.contains(parent_id.as_str()) {
            continue;
        }
        let mut sorted: Vec<&Value> = children.clone();
        sort_by_start_string(&mut sorted);
        let trace_id = sorted[0].get("traceId").and_then(Value::as_str).unwrap_or("");
        let (mut total_input, mut total_output, mut total_cache_read, mut total_cache_create) = (0.0f64, 0.0, 0.0, 0.0);
        let mut model = String::new();
        for c in children {
            if !h::name_of(c).starts_with("chat") {
                continue;
            }
            total_input += h::get_attr_num(c, "gen_ai.usage.input_tokens");
            total_output += h::get_attr_num(c, "gen_ai.usage.output_tokens");
            total_cache_read += h::get_attr_num(c, "gen_ai.usage.cache_read.input_tokens");
            total_cache_create += h::get_attr_num(c, "gen_ai.usage.cache_creation.input_tokens");
            let m = h::get_attr_str(c, "gen_ai.request.model");
            if !m.is_empty() {
                model = m;
            }
        }
        let mut synth = Map::new();
        synth.insert("traceId".into(), trace_id.into());
        synth.insert("spanId".into(), parent_id.as_str().into());
        synth.insert("name".into(), "invoke_agent".into());
        if let Some(st) = sorted[0].get("startTime") {
            synth.insert("startTime".into(), st.clone());
        }
        if let Some(et) = sorted[sorted.len() - 1].get("endTime") {
            synth.insert("endTime".into(), et.clone());
        }
        synth.insert(
            "attributes".into(),
            Value::Array(vec![
                str_attr("copilot_chat.user_request", "[session in progress]"),
                int_attr("gen_ai.usage.input_tokens", total_input),
                int_attr("gen_ai.usage.output_tokens", total_output),
                int_attr("gen_ai.usage.cache_read.input_tokens", total_cache_read),
                int_attr("gen_ai.usage.cache_creation.input_tokens", total_cache_create),
                str_attr("gen_ai.request.model", &model),
            ]),
        );
        synth_invoke.push(Value::Object(synth));
    }
    for s in &synth_invoke {
        invoke_agent_spans.push(s);
    }

    // ── Build + sort sessions ────────────────────────────────────────────────
    let mut sessions: Vec<Value> = Vec::new();
    sessions.extend(build_copilot_sessions(&invoke_agent_spans, &children_of));
    sessions.extend(build_claude_sessions(&claude_interaction_spans, &spans_by_trace_id, account_for));
    sessions.extend(build_codex_sessions(spans));
    sessions.sort_by(|a, b| {
        let ta = h::timestamp_to_ms(a.get("startTime"));
        let tb = h::timestamp_to_ms(b.get("startTime"));
        ta.partial_cmp(&tb).unwrap_or(std::cmp::Ordering::Equal)
    });

    for s in &mut sessions {
        let signals = detect_loop_signals(s);
        s.as_object_mut().expect("card is an object").insert("loopSignals".into(), Value::Array(signals));
    }

    // ── Background/orphan spans — associate with sessions by traceId ─────────
    let mut bg_by_trace_id: HashMap<String, Vec<Value>> = HashMap::new();
    let mut background_spans: Vec<Value> = Vec::new();
    for s in orphan_spans.iter().filter(|s| !h::name_of(s).starts_with("codex.")) {
        let agent_name = h::get_attr_str(s, "gen_ai.agent.name");
        let model = h::get_attr_str(s, "gen_ai.request.model");
        let in_tok = h::get_attr_num(s, "gen_ai.usage.input_tokens");
        let out_tok = h::get_attr_num(s, "gen_ai.usage.output_tokens");
        let workflow_run_id = h::get_attr_str(s, "workflow.run_id");
        let workflow_name = h::get_attr_str(s, "workflow.name");
        let name = h::name_of(s);
        let mut purpose: String = if agent_name.is_empty() { name.to_owned() } else { agent_name.clone() };
        if agent_name == "title" {
            purpose = "Generate chat title".into();
        }
        if agent_name == "progressMessages" {
            purpose = "Generate progress messages".into();
        }
        if purpose == "copilotLanguageModelWrapper" || name == "copilotLanguageModelWrapper" {
            purpose = "Extension language model call".into();
        }
        // A workflow agent with no agent name shows the workflow name, not a bare span name.
        if agent_name.is_empty() && !workflow_name.is_empty() {
            purpose = format!("workflow: {workflow_name}");
        }
        let mut bg = Map::new();
        bg.insert("name".into(), name.into());
        bg.insert("model".into(), model.into());
        bg.insert("purpose".into(), purpose.into());
        bg.insert("inputTokens".into(), num(in_tok));
        bg.insert("outputTokens".into(), num(out_tok));
        if !workflow_run_id.is_empty() {
            bg.insert("workflowRunId".into(), workflow_run_id.into());
        }
        if !workflow_name.is_empty() {
            bg.insert("workflowName".into(), workflow_name.into());
        }
        let bg = Value::Object(bg);
        let tid = s.get("traceId").and_then(Value::as_str).unwrap_or("");
        if !tid.is_empty() {
            bg_by_trace_id.entry(tid.to_owned()).or_default().push(bg.clone());
        }
        background_spans.push(bg);
    }

    // Captured BEFORE the association below appends the trace-matched orphans.
    let session_owned_background_spans: Vec<Value> = sessions
        .iter()
        .flat_map(|s| s.get("backgroundSpans").and_then(Value::as_array).cloned().unwrap_or_default())
        .collect();

    for sess in &mut sessions {
        let tid = sstr(sess, "traceId").to_owned();
        if tid.is_empty() {
            continue;
        }
        if let Some(bgs) = bg_by_trace_id.get(&tid) {
            let mut merged = sess.get("backgroundSpans").and_then(Value::as_array).cloned().unwrap_or_default();
            merged.extend(bgs.iter().cloned());
            sess.as_object_mut().expect("card").insert("backgroundSpans".into(), Value::Array(merged));
        }
    }

    // ── Efficiency report ────────────────────────────────────────────────────
    let (mut ttft_sum, mut ttft_count) = (0.0f64, 0u64);
    let (mut tool_def_size, mut sys_instruction_size) = (0usize, 0usize);
    for s in spans {
        let name = h::name_of(s);
        let is_copilot_llm = name.starts_with("chat");
        let is_claude_llm = name == "claude_code.llm_request";
        let is_codex_llm = name.starts_with("codex.") && {
            let codex_input = h::get_attr_num(s, "gen_ai.usage.input_tokens")
                + h::get_attr_num(s, "gen_ai.usage.cache_read.input_tokens")
                + h::get_attr_num(s, "gen_ai.usage.cache_creation.input_tokens")
                + h::get_attr_num(s, "input_tokens")
                + h::get_attr_num(s, "prompt_tokens")
                + h::get_attr_num(s, "cache_read_tokens")
                + h::get_attr_num(s, "cache_creation_tokens");
            let codex_output = h::get_attr_num(s, "gen_ai.usage.output_tokens")
                + h::get_attr_num(s, "output_tokens")
                + h::get_attr_num(s, "completion_tokens");
            h::is_codex_llm_span_name(name) || codex_input > 0.0 || codex_output > 0.0
        };
        if is_copilot_llm || is_claude_llm || is_codex_llm || name.starts_with("invoke_agent") {
            if is_codex_llm {
                // Codex TTFT is attached during normalization, not here.
            } else if is_copilot_llm {
                let in_tok = h::get_attr_num(s, "gen_ai.usage.input_tokens");
                let out_tok = h::get_attr_num(s, "gen_ai.usage.output_tokens");
                if in_tok > 0.0 || out_tok > 0.0 {
                    let ttft = h::get_attr_num(s, "copilot_chat.time_to_first_token");
                    if ttft > 0.0 {
                        ttft_sum += ttft;
                        ttft_count += 1;
                    }
                }
            } else if is_claude_llm {
                let in_tok = h::get_attr_num(s, "input_tokens")
                    + h::get_attr_num(s, "cache_read_tokens")
                    + h::get_attr_num(s, "cache_creation_tokens");
                let out_tok = h::get_attr_num(s, "output_tokens");
                if in_tok > 0.0 || out_tok > 0.0 {
                    let ttft = h::get_attr_num(s, "ttft_ms");
                    if ttft > 0.0 {
                        ttft_sum += ttft;
                        ttft_count += 1;
                    }
                }
            }
            tool_def_size += utf16_len(&h::get_attr_str(s, "gen_ai.tool.definitions"));
            sys_instruction_size += utf16_len(&h::get_attr_str(s, "gen_ai.system_instructions"));
        }
    }

    let total_chars: usize = spans
        .iter()
        .map(|s| {
            s.get("attributes")
                .and_then(Value::as_array)
                .map(|attrs| {
                    attrs
                        .iter()
                        .map(|a| a.get("value").and_then(|v| v.get("stringValue")).and_then(Value::as_str).map_or(0, utf16_len))
                        .sum::<usize>()
                })
                .unwrap_or(0)
        })
        .sum();

    let total_cache_read: f64 = sessions.iter().map(|s| f(s, "cacheReadTokens")).sum();
    // Context-size denominator via the disjoint-buckets identity (input + cacheRead + cacheCreate).
    let total_context: f64 = sessions.iter().map(|s| f(s, "inputTokens") + f(s, "cacheReadTokens") + f(s, "cacheCreateTokens")).sum();
    let session_total_input: f64 = sessions.iter().map(|s| f(s, "inputTokens")).sum();
    let session_total_output: f64 = sessions.iter().map(|s| f(s, "outputTokens")).sum();
    let session_total_llm: f64 = sessions.iter().map(|s| f(s, "totalLlmCalls")).sum();

    let mut top: Vec<(String, f64)> = sessions
        .iter()
        .map(|s| (js_slice(sstr(s, "userRequest"), 50).to_owned(), f(s, "inputTokens") + f(s, "outputTokens")))
        .collect();
    top.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    top.truncate(5);

    let mut eff = Map::new();
    eff.insert("totalInputTokens".into(), num(session_total_input));
    eff.insert("totalOutputTokens".into(), num(session_total_output));
    eff.insert("totalLlmCalls".into(), num(session_total_llm));
    eff.insert(
        "avgInputPerCall".into(),
        num(if session_total_llm > 0.0 { (session_total_input / session_total_llm).round() } else { 0.0 }),
    );
    eff.insert("avgTtft".into(), num(if ttft_count > 0 { (ttft_sum / ttft_count as f64).round() } else { 0.0 }));
    eff.insert("cacheHitRate".into(), num(if total_context > 0.0 { total_cache_read / total_context } else { 0.0 }));
    eff.insert("toolDefWaste".into(), num(if total_chars > 0 { tool_def_size as f64 / total_chars as f64 } else { 0.0 }));
    eff.insert(
        "sysInstructionWaste".into(),
        num(if total_chars > 0 { sys_instruction_size as f64 / total_chars as f64 } else { 0.0 }),
    );
    eff.insert(
        "topTokenConsumers".into(),
        Value::Array(
            top.into_iter()
                .map(|(label, tokens)| {
                    let mut t = Map::new();
                    t.insert("label".into(), label.into());
                    t.insert("tokens".into(), num(tokens));
                    Value::Object(t)
                })
                .collect(),
        ),
    );

    let mut all_background = background_spans;
    all_background.extend(session_owned_background_spans);

    let mut r = Map::new();
    r.insert("sessions".into(), Value::Array(sessions));
    r.insert("backgroundSpans".into(), Value::Array(all_background));
    r.insert("efficiency".into(), Value::Object(eff));
    Value::Object(r)
}

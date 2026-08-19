//! Port of src/summarizers/claude.ts (TRDD-DMWOBWFH P4d) — claude_code.interaction session cards.
//!
//! Cards and timeline entries are `serde_json::Value` object literals mirroring the TS objects
//! KEY BY KEY (the STATE-recorded design decision): a field TS sets to `undefined` is OMITTED
//! (JSON.stringify drops it from the wire); '' / 0 / false STAY. `num()` keeps integral numbers
//! bare exactly as JS prints them.
//!
//! The ONE stateful TS dependency — `callBodyRegistry.accountFor(sessionId)` — arrives as the
//! `account_for` callback (the P3b precedent: side-effectful lookups stay with the caller so the
//! builder is pure). The parity oracle runs in a fresh Node process whose registry is empty, so
//! the harness passes `|_| None`.
//!
//! Documented micro-divergence (shared with every builder): a `null` element inside a parsed
//! args/messages array throws in TS (aborting the rest of that try block, keeping partial
//! results) while this port skips the element; real gen_ai payloads never carry null elements.

use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

use super::buckets::{context_tokens, disjoint_buckets, UsageShape};
use super::helpers::{self as h, iso_from_ms, name_of, num, put_span_id, start_time, status_is_error, status_message, truthy, JsSet};
use super::retention::{cap_timeline, timeline_max_entries, timeline_max_bytes};

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `a || b`: the first operand when truthy, else the second (whatever it is).
fn or2<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    match a {
        Some(v) if truthy(v) => a,
        _ => b,
    }
}

/// strOrUndef: null/undefined/'' → omitted; everything else String()-ified (0 → "0").
fn str_or_undef(v: Option<&Value>) -> Option<String> {
    match v {
        None | Some(Value::Null) => None,
        Some(Value::String(s)) if s.is_empty() => None,
        Some(x) => Some(h::js_string(x)),
    }
}

fn put_opt(obj: &mut Map<String, Value>, key: &str, v: Option<String>) {
    if let Some(s) = v {
        obj.insert(key.into(), s.into());
    }
}

/// `Number(s)` for a NON-EMPTY string flowing onto the wire: an unparseable value is JS NaN,
/// which JSON.stringify writes as null.
fn js_number_value(s: &str) -> Value {
    let t = s.trim();
    if t.is_empty() {
        return num(0.0); // Number('   ') === 0
    }
    match t.parse::<f64>() {
        Ok(n) if n.is_finite() => num(n),
        _ => Value::Null,
    }
}

/// Chronology key shared by the per-card timeline sort and the cross-slice merge: entries with no
/// parseable timestamp sort LAST (Date.parse('') is NaN → MAX_SAFE_INTEGER in TS).
fn timeline_ts_key(e: &Value) -> f64 {
    let ts = e.get("timestamp").and_then(Value::as_str).unwrap_or("");
    h::parse_iso_ms(ts).unwrap_or(MAX_SAFE_INTEGER)
}

fn start_ms_of(card: &Value) -> f64 {
    let s = card.get("startTime").and_then(Value::as_str).unwrap_or("");
    h::parse_iso_ms(s).unwrap_or(MAX_SAFE_INTEGER)
}

/// buildClaudeSessions — group per-interaction slice cards by the `session.id` transcript UUID
/// and emit ONE session-scoped card per UUID; interactions with no session.id keep their
/// per-interaction card (fail-soft, no invented identity).
pub fn build_claude_sessions(
    claude_interaction_spans: &[&Value],
    spans_by_trace_id: &HashMap<String, Vec<&Value>>,
    account_for: &dyn Fn(&str) -> Option<String>,
) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut group_index: HashMap<String, usize> = HashMap::new();
    let mut groups: Vec<(String, Vec<Value>)> = Vec::new();
    for interaction in claude_interaction_spans {
        let card = build_interaction_card(interaction, spans_by_trace_id, account_for);
        let claude_session_id = h::get_attr_str(interaction, "session.id");
        if claude_session_id.is_empty() {
            out.push(card);
            continue;
        }
        match group_index.get(&claude_session_id) {
            Some(&i) => groups[i].1.push(card),
            None => {
                group_index.insert(claude_session_id.clone(), groups.len());
                groups.push((claude_session_id, vec![card]));
            }
        }
    }
    for (sid, slices) in groups {
        out.push(merge_interaction_slices(&sid, slices));
    }
    out
}

/// One claude_code.interaction span plus its trace tree → one slice card.
fn build_interaction_card(
    interaction: &Value,
    spans_by_trace_id: &HashMap<String, Vec<&Value>>,
    account_for: &dyn Fn(&str) -> Option<String>,
) -> Value {
    let trace_id = interaction.get("traceId").and_then(Value::as_str).unwrap_or("");
    let mut trace_spans: Vec<&Value> = spans_by_trace_id
        .get(trace_id)
        .map(|v| v.iter().copied().filter(|s| s.get("spanId") != interaction.get("spanId")).collect())
        .unwrap_or_default();
    trace_spans.sort_by(|a, b| {
        h::nano_to_ms(start_time(a)).partial_cmp(&h::nano_to_ms(start_time(b))).unwrap_or(std::cmp::Ordering::Equal)
    });

    let top_spans: Vec<&Value> = trace_spans
        .iter()
        .copied()
        .filter(|s| {
            let n = name_of(s);
            n == "claude_code.llm_request" || n == "claude_code.tool"
        })
        .collect();

    let mut children_by_span_id: HashMap<&str, Vec<&Value>> = HashMap::new();
    for s in &trace_spans {
        if let Some(p) = s.get("parentSpanId").and_then(Value::as_str).filter(|p| !p.is_empty()) {
            children_by_span_id.entry(p).or_default().push(s);
        }
    }

    let (mut input_tokens, mut output_tokens, mut cache_read_tokens, mut cache_create_tokens) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let (mut total_llm_calls, mut total_tool_calls, mut errors) = (0.0f64, 0.0f64, 0.0f64);
    let mut model = String::new();
    let mut tool_counts: Vec<(String, f64)> = Vec::new();
    let mut files_read = JsSet::default();
    let mut files_searched = JsSet::default();
    let mut files_changed = JsSet::default();
    let mut files_written = JsSet::default();
    let mut all_abs_file_paths: Vec<String> = Vec::new();
    let mut seen_abs: HashSet<String> = HashSet::new();
    let mut missing_changed: i64 = 0;

    // 1-based turn index: each llm_request opens a turn; tools before the first llm_request fall
    // into turn 1.
    let mut turn_counter: i64 = 0;
    let mut timeline: Vec<Value> = Vec::new();

    macro_rules! add_abs {
        ($p:expr) => {
            if $p.starts_with('/') && seen_abs.insert($p.clone()) {
                all_abs_file_paths.push($p.clone());
            }
        };
    }

    for child in &top_spans {
        let child_start = h::nano_to_ms(start_time(child));
        let child_end = h::nano_to_ms(child.get("endTime").and_then(Value::as_str).unwrap_or(""));
        let diff = child_end - child_start;
        let child_dur = if diff != 0.0 { diff } else { h::get_attr_num(child, "duration_ms") };
        let is_error = status_is_error(child);
        if is_error {
            errors += 1.0;
        }
        let ts = if child_start > 0.0 { iso_from_ms(child_start) } else { String::new() };

        if name_of(child) == "claude_code.llm_request" {
            total_llm_calls += 1.0;
            turn_counter += 1;
            // Anthropic-shaped usage (input already cache-excluded) — pass-through, but the ONE
            // place the disjoint invariant is enforced.
            let b = disjoint_buckets(&h::extract_token_counts(child), UsageShape::Anthropic);
            let ttft = h::get_attr_num(child, "ttft_ms");
            let child_model = h::get_gen_ai_model(child);
            if !child_model.is_empty() {
                model = child_model.clone();
            }
            input_tokens += b.input_tokens;
            output_tokens += b.output_tokens;
            cache_read_tokens += b.cache_read_tokens;
            cache_create_tokens += b.cache_create_tokens;

            let stop_reason = h::get_attr_str(child, "stop_reason");
            let action: String = if stop_reason == "tool_use" {
                "called tools".into()
            } else if stop_reason == "end_turn" {
                "text response".into()
            } else if !stop_reason.is_empty() {
                stop_reason.clone()
            } else {
                "unknown".into()
            };
            let claude_output_msgs = h::get_attr_str(child, "gen_ai.output.messages");
            let response_text = h::extract_response_text(&claude_output_msgs);

            // File paths and edit details from tool_use blocks in the LLM response — the primary
            // source, because tool_input on claude_code.tool spans needs the enhanced-telemetry
            // beta flag.
            let mut llm_edit_details: Vec<Value> = Vec::new();
            if !claude_output_msgs.is_empty() {
                if let Ok(msgs) = serde_json::from_str::<Value>(&claude_output_msgs) {
                    if let Some(arr) = msgs.as_array() {
                        for msg in arr {
                            if msg.get("role").and_then(Value::as_str) != Some("assistant") {
                                continue;
                            }
                            let content = msg.get("content").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
                            for block in content {
                                if block.get("type").and_then(Value::as_str) != Some("tool_use")
                                    || !block.get("input").is_some_and(truthy)
                                {
                                    continue;
                                }
                                let input = block.get("input").expect("checked above");
                                let tool_n = block.get("name").filter(|v| truthy(v)).map(h::js_string).unwrap_or_default();
                                let mut found_changed_path = false;
                                let fp = or2(input.get("file_path"), input.get("filePath"))
                                    .filter(|v| truthy(v))
                                    .map(h::js_string)
                                    .unwrap_or_default();
                                if !fp.is_empty() {
                                    if h::CLAUDE_WRITE_TOOLS.contains(&tool_n.as_str()) {
                                        files_changed.add_str(fp.clone());
                                        if h::FULL_WRITE_TOOLS.contains(&tool_n.as_str()) {
                                            files_written.add_str(fp.clone());
                                        }
                                        found_changed_path = true;
                                        let mut d = Map::new();
                                        d.insert("filePath".into(), fp.clone().into());
                                        d.insert("toolName".into(), tool_n.clone().into());
                                        put_opt(&mut d, "oldString", str_or_undef(or2(input.get("old_string"), input.get("oldString"))));
                                        put_opt(&mut d, "newString", str_or_undef(or2(input.get("new_string"), input.get("newString"))));
                                        put_opt(&mut d, "content", str_or_undef(input.get("content")));
                                        llm_edit_details.push(Value::Object(d));
                                    } else if tool_n == "Read" {
                                        let base = fp.rsplit('/').next().unwrap_or("");
                                        files_read.add_str(if base.is_empty() { fp.clone() } else { base.to_owned() });
                                    } else if tool_n == "Glob" || tool_n == "Grep" {
                                        let sv = match or2(input.get("pattern"), input.get("query")) {
                                            Some(v) if truthy(v) => h::js_string(v),
                                            _ => fp.clone(),
                                        };
                                        files_searched.add_str(sv);
                                    }
                                }
                                if tool_n == "MultiEdit" {
                                    if let Some(edits) = input.get("edits").and_then(Value::as_array) {
                                        for e in edits {
                                            if let Some(efp) = or2(e.get("file_path"), e.get("filePath")).filter(|v| truthy(v)) {
                                                let efp_str = h::js_string(efp);
                                                files_changed.add_str(efp_str.clone());
                                                found_changed_path = true;
                                                let mut d = Map::new();
                                                d.insert("filePath".into(), efp_str.into());
                                                d.insert("toolName".into(), "Edit".into());
                                                put_opt(&mut d, "oldString", str_or_undef(or2(e.get("old_string"), e.get("oldString"))));
                                                put_opt(&mut d, "newString", str_or_undef(or2(e.get("new_string"), e.get("newString"))));
                                                llm_edit_details.push(Value::Object(d));
                                            }
                                        }
                                    }
                                }
                                if h::CLAUDE_WRITE_TOOLS.contains(&tool_n.as_str()) && !found_changed_path {
                                    missing_changed += 1;
                                }
                            }
                        }
                    }
                }
            }

            let mut e = Map::new();
            e.insert("type".into(), "llm".into());
            put_span_id(&mut e, child);
            e.insert("label".into(), if child_model.is_empty() { "LLM".into() } else { Value::from(child_model.clone()) });
            e.insert("turn".into(), Value::from(turn_counter));
            e.insert("model".into(), child_model.into());
            // RAW uncached input — timeline entries carry the SAME four disjoint buckets as the card.
            e.insert("inputTokens".into(), num(b.input_tokens));
            e.insert("outputTokens".into(), num(b.output_tokens));
            if b.cache_read_tokens != 0.0 {
                e.insert("cacheReadTokens".into(), num(b.cache_read_tokens));
            }
            if b.cache_create_tokens != 0.0 {
                e.insert("cacheCreateTokens".into(), num(b.cache_create_tokens));
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
            if !llm_edit_details.is_empty() {
                e.insert("editDetails".into(), Value::Array(llm_edit_details));
            }
            timeline.push(Value::Object(e));
        } else {
            // claude_code.tool
            total_tool_calls += 1.0;
            let tool_name = {
                let t = h::get_attr_str(child, "tool_name");
                if t.is_empty() { name_of(child).to_owned() } else { t }
            };
            match tool_counts.iter_mut().find(|(k, _)| *k == tool_name) {
                Some((_, n)) => *n += 1.0,
                None => tool_counts.push((tool_name.clone(), 1.0)),
            }
            let is_write_tool = h::CLAUDE_WRITE_TOOLS.contains(&tool_name.as_str());

            let args_str = h::get_first_attr(child, &["tool_input", "input", "gen_ai.tool.call.arguments", "full_command", "file_path"]);
            let mut found_changed_path = false;
            let mut tool_edit_details: Vec<Value> = Vec::new();
            if !args_str.is_empty() {
                // JSON.parse('null') then `.file_path` throws in TS (→ its catch): a Null parse
                // skips the whole block here too.
                if let Ok(args) = serde_json::from_str::<Value>(&args_str) {
                    if !args.is_null() {
                        if let Some(fp_v) = or2(args.get("file_path"), args.get("filePath")).filter(|v| truthy(v)) {
                            let fp_str = h::js_string(fp_v);
                            add_abs!(fp_str);
                            if h::CLAUDE_WRITE_TOOLS.contains(&tool_name.as_str()) {
                                files_changed.add_str(fp_str.clone());
                                if h::FULL_WRITE_TOOLS.contains(&tool_name.as_str()) {
                                    files_written.add_str(fp_str.clone());
                                }
                                found_changed_path = true;
                                let mut d = Map::new();
                                d.insert("filePath".into(), fp_str.clone().into());
                                put_opt(&mut d, "oldString", str_or_undef(or2(args.get("old_string"), args.get("oldString"))));
                                put_opt(&mut d, "newString", str_or_undef(or2(args.get("new_string"), args.get("newString"))));
                                put_opt(&mut d, "content", str_or_undef(args.get("content")));
                                tool_edit_details.push(Value::Object(d));
                            } else if tool_name == "Read" {
                                let base = fp_str.rsplit('/').next().unwrap_or("");
                                files_read.add_str(if base.is_empty() { fp_str.clone() } else { base.to_owned() });
                            } else if tool_name == "Glob" || tool_name == "Grep" {
                                // RAW value (TS adds args.pattern un-stringified here) — a
                                // non-string pattern lands on the wire as itself.
                                match or2(args.get("pattern"), args.get("query")) {
                                    Some(v) if truthy(v) => files_searched.add(v.clone()),
                                    _ => files_searched.add_str(fp_str.clone()),
                                }
                            }
                        }
                        if tool_name == "MultiEdit" {
                            if let Some(edits) = args.get("edits").and_then(Value::as_array) {
                                for e in edits {
                                    if let Some(efp) = or2(e.get("file_path"), e.get("filePath")).filter(|v| truthy(v)) {
                                        let efp_str = h::js_string(efp);
                                        add_abs!(efp_str);
                                        files_changed.add_str(efp_str.clone());
                                        found_changed_path = true;
                                        let mut d = Map::new();
                                        d.insert("filePath".into(), efp_str.into());
                                        put_opt(&mut d, "oldString", str_or_undef(or2(e.get("old_string"), e.get("oldString"))));
                                        put_opt(&mut d, "newString", str_or_undef(or2(e.get("new_string"), e.get("newString"))));
                                        tool_edit_details.push(Value::Object(d));
                                    }
                                }
                            }
                        }
                    }
                }
            }
            // Fallback: claude_code.tool spans expose file_path as a direct attribute even when
            // tool_input is absent (default telemetry without OTEL_LOG_TOOL_DETAILS).
            if !found_changed_path {
                let direct_fp = h::get_attr_str(child, "file_path");
                if !direct_fp.is_empty() {
                    add_abs!(direct_fp);
                    if h::CLAUDE_WRITE_TOOLS.contains(&tool_name.as_str()) {
                        files_changed.add_str(direct_fp.clone());
                        if h::FULL_WRITE_TOOLS.contains(&tool_name.as_str()) {
                            files_written.add_str(direct_fp.clone());
                        }
                        found_changed_path = true;
                    } else if tool_name == "Read" {
                        let base = direct_fp.rsplit('/').next().unwrap_or("");
                        files_read.add_str(if base.is_empty() { direct_fp.clone() } else { base.to_owned() });
                    } else if tool_name == "Glob" || tool_name == "Grep" {
                        files_searched.add_str(direct_fp.clone());
                    }
                }
            }
            if is_write_tool && !found_changed_path {
                missing_changed += 1;
            }

            let turn = turn_counter.max(1);
            let mut e = Map::new();
            e.insert("type".into(), "tool".into());
            put_span_id(&mut e, child);
            e.insert("label".into(), tool_name.clone().into());
            e.insert("turn".into(), Value::from(turn));
            e.insert("durationMs".into(), num(if child_dur != 0.0 { child_dur } else { h::get_attr_num(child, "duration_ms") }));
            if !args_str.is_empty() {
                e.insert("toolInput".into(), args_str.clone().into());
            }
            e.insert("isError".into(), is_error.into());
            if is_error {
                if let Some(m) = status_message(child) {
                    e.insert("errorMessage".into(), m.into());
                }
            }
            e.insert("timestamp".into(), ts.clone().into());
            if !tool_edit_details.is_empty() {
                e.insert("editDetails".into(), Value::Array(tool_edit_details));
            }
            timeline.push(Value::Object(e));

            let blocked = child
                .get("spanId")
                .and_then(Value::as_str)
                .and_then(|id| children_by_span_id.get(id))
                .and_then(|kids| kids.iter().copied().find(|c| name_of(c) == "claude_code.tool.blocked_on_user"));
            if let Some(bs) = blocked {
                let blocked_start = h::nano_to_ms(start_time(bs));
                let dur = {
                    let a = h::get_attr_num(bs, "duration_ms");
                    if a != 0.0 {
                        a
                    } else {
                        h::nano_to_ms(bs.get("endTime").and_then(Value::as_str).unwrap_or("")) - blocked_start
                    }
                };
                let mut u = Map::new();
                u.insert("type".into(), "user_input".into());
                put_span_id(&mut u, bs);
                u.insert("label".into(), "Permission prompt".into());
                u.insert("turn".into(), Value::from(turn));
                u.insert("durationMs".into(), num(dur));
                {
                    let d = h::get_attr_str(bs, "decision");
                    if !d.is_empty() {
                        u.insert("decision".into(), d.into());
                    }
                }
                u.insert("isError".into(), false.into());
                u.insert("timestamp".into(), if blocked_start > 0.0 { iso_from_ms(blocked_start).into() } else { Value::from(ts) });
                timeline.push(Value::Object(u));
            }
        }
    }

    // Supplement file paths from claude_code.tool_result log-derived spans (OTEL_LOG_TOOL_DETAILS=1
    // payloads) — BEFORE computing filesChangedNote so the note reflects final state.
    for trs in trace_spans.iter().copied().filter(|s| name_of(s) == "claude_code.tool_result") {
        let tr_tool_name = h::get_first_attr(trs, &["tool.name", "tool_name"]);
        let tr_args_str = h::get_first_attr(trs, &["tool_input", "input"]);
        if tr_tool_name.is_empty() || tr_args_str.is_empty() {
            continue;
        }
        let mut multi_edits: Vec<Value> = Vec::new();
        let fp: String = match serde_json::from_str::<Value>(&tr_args_str) {
            Ok(args) if !args.is_null() => {
                if tr_tool_name == "MultiEdit" {
                    if let Some(edits) = args.get("edits").and_then(Value::as_array) {
                        multi_edits = edits.to_vec();
                    }
                }
                or2(args.get("file_path"), args.get("filePath")).filter(|v| truthy(v)).map(h::js_string).unwrap_or_default()
            }
            // Not JSON (or JSON null, which throws on property access in TS): the raw string is
            // the file path.
            _ => tr_args_str.trim().to_owned(),
        };
        if !fp.is_empty() {
            add_abs!(fp);
            if h::CLAUDE_WRITE_TOOLS.contains(&tr_tool_name.as_str()) {
                files_changed.add_str(fp.clone());
                if h::FULL_WRITE_TOOLS.contains(&tr_tool_name.as_str()) {
                    files_written.add_str(fp.clone());
                }
            } else if tr_tool_name == "Read" {
                let base = fp.rsplit('/').next().unwrap_or("");
                files_read.add_str(if base.is_empty() { fp.clone() } else { base.to_owned() });
            } else if tr_tool_name == "Glob" || tr_tool_name == "Grep" {
                files_searched.add_str(fp.clone());
            }
        }
        for e in &multi_edits {
            if let Some(efp) = or2(e.get("file_path"), e.get("filePath")).filter(|v| truthy(v)) {
                let efp_str = h::js_string(efp);
                add_abs!(efp_str);
                files_changed.add_str(efp_str);
            }
        }
    }

    // Log-derived rich Claude Code events (api_request / compaction / api_error) — each its own
    // timeline entry. api_request tokens are deliberately NOT added to the session aggregates:
    // the llm_request spans already count them.
    for rs in trace_spans.iter().copied().filter(|s| {
        matches!(
            name_of(s),
            "claude_code.api_request" | "claude_code.compaction" | "claude_code.api_error" | "claude_code.api_retries_exhausted"
        )
    }) {
        let rs_start = h::nano_to_ms(start_time(rs));
        let rs_ts = if rs_start > 0.0 { iso_from_ms(rs_start) } else { String::new() };
        let rs_dur = {
            let a = h::get_attr_num(rs, "duration_ms");
            if a != 0.0 {
                a
            } else {
                h::nano_to_ms(rs.get("endTime").and_then(Value::as_str).unwrap_or("")) - rs_start
            }
        };
        let rs_model = h::get_gen_ai_model(rs);
        let name = name_of(rs);
        if name == "claude_code.api_request" {
            let rb = disjoint_buckets(&h::extract_token_counts(rs), UsageShape::Anthropic);
            let cost_str = h::get_attr_str(rs, "cost_usd");
            let mut e = Map::new();
            e.insert("type".into(), "api_request".into());
            put_span_id(&mut e, rs);
            e.insert("label".into(), "api_request".into());
            if !rs_model.is_empty() {
                e.insert("model".into(), rs_model.clone().into());
            }
            if rb.input_tokens != 0.0 {
                e.insert("inputTokens".into(), num(rb.input_tokens));
            }
            if rb.output_tokens != 0.0 {
                e.insert("outputTokens".into(), num(rb.output_tokens));
            }
            if rb.cache_read_tokens != 0.0 {
                e.insert("cacheReadTokens".into(), num(rb.cache_read_tokens));
            }
            if rb.cache_create_tokens != 0.0 {
                e.insert("cacheCreateTokens".into(), num(rb.cache_create_tokens));
            }
            if !cost_str.is_empty() {
                e.insert("costUsd".into(), js_number_value(&cost_str));
            }
            for (key, attr) in [
                ("querySource", "query_source"),
                ("agentName", "agent.name"),
                ("skillName", "skill.name"),
                ("pluginName", "plugin.name"),
                ("mcpServerName", "mcp_server.name"),
                ("mcpToolName", "mcp_tool.name"),
                ("requestId", "request_id"),
            ] {
                let v = h::get_attr_str(rs, attr);
                if !v.is_empty() {
                    e.insert(key.into(), v.into());
                }
            }
            e.insert("durationMs".into(), num(rs_dur));
            e.insert("isError".into(), false.into());
            e.insert("timestamp".into(), rs_ts.into());
            timeline.push(Value::Object(e));
        } else if name == "claude_code.compaction" {
            let mut e = Map::new();
            e.insert("type".into(), "compaction".into());
            put_span_id(&mut e, rs);
            e.insert("label".into(), "compaction".into());
            {
                let t = h::get_attr_str(rs, "trigger");
                if !t.is_empty() {
                    e.insert("compactionTrigger".into(), t.into());
                }
            }
            {
                let n = h::get_attr_num(rs, "pre_tokens");
                if n != 0.0 {
                    e.insert("preTokens".into(), num(n));
                }
            }
            {
                let n = h::get_attr_num(rs, "post_tokens");
                if n != 0.0 {
                    e.insert("postTokens".into(), num(n));
                }
            }
            e.insert("durationMs".into(), num(rs_dur));
            e.insert("isError".into(), (h::get_attr_str(rs, "success") == "false").into());
            e.insert("timestamp".into(), rs_ts.into());
            timeline.push(Value::Object(e));
        } else {
            // claude_code.api_error / claude_code.api_retries_exhausted
            errors += 1.0;
            let status_str = h::get_attr_str(rs, "status_code");
            let attempts_str = h::get_first_attr(rs, &["attempt", "total_attempts"]);
            let mut e = Map::new();
            e.insert("type".into(), "api_error".into());
            put_span_id(&mut e, rs);
            e.insert(
                "label".into(),
                if name == "claude_code.api_retries_exhausted" { "api_retries_exhausted" } else { "api_error" }.into(),
            );
            if !rs_model.is_empty() {
                e.insert("model".into(), rs_model.clone().into());
            }
            if !status_str.is_empty() {
                e.insert("statusCode".into(), js_number_value(&status_str));
            }
            if !attempts_str.is_empty() {
                e.insert("attempts".into(), js_number_value(&attempts_str));
            }
            e.insert("durationMs".into(), num(rs_dur));
            e.insert("isError".into(), true.into());
            {
                let m = h::get_attr_str(rs, "error");
                if !m.is_empty() {
                    e.insert("errorMessage".into(), m.into());
                }
            }
            e.insert("timestamp".into(), rs_ts.into());
            timeline.push(Value::Object(e));
        }
    }

    // Re-order chronologically after appending the log-derived entries (stable sort; entries with
    // no timestamp go last).
    timeline.sort_by(|a, b| timeline_ts_key(a).partial_cmp(&timeline_ts_key(b)).unwrap_or(std::cmp::Ordering::Equal));

    let workspace = h::find_project_root(&h::common_path_prefix(&all_abs_file_paths));

    let start_ms = h::nano_to_ms(start_time(interaction));
    // The card's four disjoint buckets — sums of per-call disjoint buckets, routed through the
    // one constructor so the invariant stays compile-shaped.
    let buckets = disjoint_buckets(
        &h::TokenCounts { input: input_tokens, output: output_tokens, cache_read: cache_read_tokens, cache_create: cache_create_tokens },
        UsageShape::Anthropic,
    );
    let total_context = context_tokens(&buckets);
    let cache_hit_rate = if total_context > 0.0 { buckets.cache_read_tokens / total_context } else { 0.0 };
    let duration_ms = {
        let a = h::get_attr_num(interaction, "interaction.duration_ms");
        if a != 0.0 {
            a
        } else {
            h::nano_to_ms(interaction.get("endTime").and_then(Value::as_str).unwrap_or("")) - start_ms
        }
    };

    let raw_prompt = h::get_attr_str(interaction, "user_prompt");
    let prompt_length = h::get_attr_num(interaction, "user_prompt_length");
    let has_data = total_llm_calls > 0.0 || input_tokens > 0.0 || !timeline.is_empty();
    let user_request = h::normalize_user_request(
        &raw_prompt,
        prompt_length,
        if has_data { "[prompt redacted]" } else { "[session in progress]" },
        Some(if has_data { "prompt redacted" } else { "session in progress" }),
    );

    // Note computed AFTER enrichment — suppressed entirely when any changed path was found.
    let files_changed_note: Option<String> = if files_changed.is_empty() && missing_changed > 0 {
        Some(format!(
            "Changed-file paths are unavailable for {missing_changed} write operation{}. Claude Code redacts tool arguments by default. Add OTEL_LOG_TOOL_DETAILS=1 to your Claude environment variables (alongside CLAUDE_CODE_ENABLE_TELEMETRY=1) and restart to enable path tracking.",
            if missing_changed != 1 { "s" } else { "" }
        ))
    } else {
        None
    };

    let mut card = Map::new();
    // sessionId: interaction.spanId — raw field; a missing one is OMITTED, never null.
    if let Some(id) = interaction.get("spanId").filter(|v| !v.is_null()) {
        card.insert("sessionId".into(), id.clone());
    }
    card.insert("traceId".into(), interaction.get("traceId").filter(|v| truthy(v)).cloned().unwrap_or_else(|| "".into()));
    card.insert("source".into(), "claude_code".into());
    card.insert("dataSource".into(), "otel".into());
    {
        let parented = interaction.get("parentSpanId").is_some_and(truthy);
        let sidechain = h::get_attr_str(interaction, "is_sidechain") == "true";
        card.insert("initiator".into(), if parented || sidechain { "agent" } else { "user" }.into());
    }
    {
        // TRDD-BURNWDGT — span attr first, else the caller-provided registry; omitted when unknown.
        let acct = {
            let a = h::get_attr_str(interaction, "user.account_uuid");
            if !a.is_empty() {
                Some(a)
            } else {
                account_for(&h::get_attr_str(interaction, "session.id")).filter(|s| !s.is_empty())
            }
        };
        if let Some(a) = acct {
            card.insert("accountId".into(), a.into());
        }
    }
    card.insert("workspace".into(), workspace.into());
    card.insert("userRequest".into(), user_request.into());
    card.insert("model".into(), model.into());
    card.insert("turns".into(), num(total_llm_calls));
    // RAW uncached input — the schema invariant is FOUR DISJOINT BUCKETS.
    card.insert("inputTokens".into(), num(buckets.input_tokens));
    card.insert("outputTokens".into(), num(buckets.output_tokens));
    card.insert("cacheReadTokens".into(), num(buckets.cache_read_tokens));
    card.insert("cacheCreateTokens".into(), num(buckets.cache_create_tokens));
    card.insert("cacheHitRate".into(), num(cache_hit_rate));
    card.insert("durationMs".into(), num(duration_ms));
    card.insert("startTime".into(), if start_ms > 0.0 { iso_from_ms(start_ms).into() } else { Value::from("") });
    card.insert("filesRead".into(), files_read.into_value());
    card.insert("filesSearched".into(), files_searched.into_value());
    card.insert("filesChanged".into(), files_changed.into_value());
    card.insert("filesWritten".into(), files_written.into_value());
    if let Some(n) = files_changed_note {
        card.insert("filesChangedNote".into(), n.into());
    }
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
    card.insert("outcome".into(), "unknown".into());
    card.insert("timeline".into(), Value::Array(timeline));
    card.insert("backgroundSpans".into(), Value::Array(Vec::new()));
    card.insert("loopSignals".into(), Value::Array(Vec::new()));
    Value::Object(card)
}

/// Roll the per-interaction slice cards of ONE session (same `session.id` UUID) into a single
/// session-scoped card: buckets/turns/tool counts SUM, file sets UNION, timelines concatenate in
/// time order, startTime is the earliest slice, durationMs spans the whole group.
fn merge_interaction_slices(claude_session_id: &str, slices: Vec<Value>) -> Value {
    let mut ordered = slices;
    ordered.sort_by(|a, b| start_ms_of(a).partial_cmp(&start_ms_of(b)).unwrap_or(std::cmp::Ordering::Equal));
    if ordered.len() == 1 {
        let mut card = ordered.pop().expect("one slice");
        card.as_object_mut().expect("card is an object").insert("sessionId".into(), claude_session_id.into());
        return card;
    }

    fn f(c: &Value, k: &str) -> f64 {
        c.get(k).and_then(Value::as_f64).unwrap_or(0.0)
    }
    fn sstr<'a>(c: &'a Value, k: &str) -> &'a str {
        c.get(k).and_then(Value::as_str).unwrap_or("")
    }

    let (mut input_tokens, mut output_tokens, mut cache_read_tokens, mut cache_create_tokens) = (0.0f64, 0.0f64, 0.0f64, 0.0f64);
    let (mut total_llm_calls, mut total_tool_calls, mut errors) = (0.0f64, 0.0f64, 0.0f64);
    let mut tool_counts: Vec<(String, f64)> = Vec::new();
    let mut files_read = JsSet::default();
    let mut files_searched = JsSet::default();
    let mut files_changed = JsSet::default();
    let mut files_written = JsSet::default();
    let mut timeline: Vec<Value> = Vec::new();
    let mut background_spans: Vec<Value> = Vec::new();
    let mut min_start_ms = MAX_SAFE_INTEGER;
    let mut max_end_ms = 0.0f64;

    for s in &ordered {
        input_tokens += f(s, "inputTokens");
        output_tokens += f(s, "outputTokens");
        cache_read_tokens += f(s, "cacheReadTokens");
        cache_create_tokens += f(s, "cacheCreateTokens");
        total_llm_calls += f(s, "totalLlmCalls");
        total_tool_calls += f(s, "totalToolCalls");
        errors += f(s, "errors");
        if let Some(tc) = s.get("toolCounts").and_then(Value::as_object) {
            for (tool, n) in tc {
                let add = n.as_f64().unwrap_or(0.0);
                match tool_counts.iter_mut().find(|(k, _)| k == tool) {
                    Some((_, v)) => *v += add,
                    None => tool_counts.push((tool.clone(), add)),
                }
            }
        }
        if let Some(arr) = s.get("filesRead").and_then(Value::as_array) {
            for v in arr {
                files_read.add(v.clone());
            }
        }
        if let Some(arr) = s.get("filesSearched").and_then(Value::as_array) {
            for v in arr {
                files_searched.add(v.clone());
            }
        }
        if let Some(arr) = s.get("filesChanged").and_then(Value::as_array) {
            for v in arr {
                files_changed.add(v.clone());
            }
        }
        if let Some(arr) = s.get("filesWritten").and_then(Value::as_array) {
            for v in arr {
                files_written.add(v.clone());
            }
        }
        if let Some(arr) = s.get("timeline").and_then(Value::as_array) {
            timeline.extend(arr.iter().cloned());
        }
        if let Some(arr) = s.get("backgroundSpans").and_then(Value::as_array) {
            background_spans.extend(arr.iter().cloned());
        }
        let st = start_ms_of(s);
        if st != MAX_SAFE_INTEGER {
            if st < min_start_ms {
                min_start_ms = st;
            }
            let d = f(s, "durationMs");
            let end = st + if d > 0.0 { d } else { 0.0 };
            if end > max_end_ms {
                max_end_ms = end;
            }
        }
    }

    // Interactions can overlap (background/sidechain turns) — re-sort globally with the same
    // stable comparator a single card uses.
    timeline.sort_by(|a, b| timeline_ts_key(a).partial_cmp(&timeline_ts_key(b)).unwrap_or(std::cmp::Ordering::Equal));
    // Retention bound (TRDD-66IXMIGN): the merged concatenation obeys the same cap the per-card
    // ingest paths enforce; trim AFTER the sort so the evicted entries are the oldest.
    let merged_truncated = ordered.iter().map(|s| f(s, "timelineTruncatedCount")).sum::<f64>()
        + cap_timeline(&mut timeline, timeline_max_entries(), timeline_max_bytes()) as f64;

    // Most-informative slice = richest timeline; per-field fallback scans the group in time order.
    let tl_len = |c: &Value| c.get("timeline").and_then(Value::as_array).map_or(0, Vec::len);
    let mut informative = &ordered[0];
    for s in &ordered[1..] {
        if tl_len(s) > tl_len(informative) {
            informative = s;
        }
    }
    let is_placeholder = |r: &str| r.is_empty() || r == "[prompt redacted]" || r == "[session in progress]";
    let user_request: String = if !is_placeholder(sstr(informative, "userRequest")) {
        sstr(informative, "userRequest").to_owned()
    } else {
        ordered
            .iter()
            .find(|s| !is_placeholder(sstr(s, "userRequest")))
            .map(|s| sstr(s, "userRequest").to_owned())
            .unwrap_or_else(|| sstr(informative, "userRequest").to_owned())
    };
    let first_nonempty = |key: &str| -> String {
        let m = sstr(informative, key);
        if !m.is_empty() {
            m.to_owned()
        } else {
            ordered.iter().map(|s| sstr(s, key)).find(|m| !m.is_empty()).unwrap_or("").to_owned()
        }
    };
    let model = first_nonempty("model");
    let workspace = first_nonempty("workspace");

    let total_context = input_tokens + cache_read_tokens + cache_create_tokens;
    let cache_hit_rate = if total_context > 0.0 { cache_read_tokens / total_context } else { 0.0 };
    // Suppressed-note logic: only when the union found NO changed path, surface the first slice
    // note (they all carry the same telemetry-config advice).
    let files_changed_note: Option<Value> = if !files_changed.is_empty() {
        None
    } else {
        ordered.iter().filter_map(|s| s.get("filesChangedNote")).find(|v| truthy(v)).cloned()
    };

    // {...base, overrides} — the earliest interaction's card anchors key order and the fields not
    // overridden (traceId, source, dataSource, sessionId position, …).
    let mut card = ordered[0].as_object().expect("card is an object").clone();
    card.insert("sessionId".into(), claude_session_id.into());
    if ordered.iter().any(|s| sstr(s, "initiator") == "user") {
        card.insert("initiator".into(), "user".into());
    }
    match ordered.iter().find_map(|s| s.get("accountId").filter(|v| truthy(v))) {
        Some(a) => {
            card.insert("accountId".into(), a.clone());
        }
        None => {
            // The TS literal writes `accountId: undefined` — stringify drops the key even when
            // the base slice carried one.
            card.shift_remove("accountId");
        }
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
    if min_start_ms != MAX_SAFE_INTEGER && max_end_ms > min_start_ms {
        card.insert("durationMs".into(), num(max_end_ms - min_start_ms));
    }
    if min_start_ms != MAX_SAFE_INTEGER {
        card.insert("startTime".into(), iso_from_ms(min_start_ms).into());
    }
    card.insert("filesRead".into(), files_read.into_value());
    card.insert("filesSearched".into(), files_searched.into_value());
    card.insert("filesChanged".into(), files_changed.into_value());
    card.insert("filesWritten".into(), files_written.into_value());
    match files_changed_note {
        Some(n) => {
            card.insert("filesChangedNote".into(), n);
        }
        None => {
            card.shift_remove("filesChangedNote");
        }
    }
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
    card.insert("outcome".into(), "unknown".into());
    card.insert("timeline".into(), Value::Array(timeline));
    if merged_truncated > 0.0 {
        card.insert("timelineTruncatedCount".into(), num(merged_truncated));
    }
    card.insert("backgroundSpans".into(), Value::Array(background_spans));
    card.insert("loopSignals".into(), Value::Array(Vec::new()));
    Value::Object(card)
}

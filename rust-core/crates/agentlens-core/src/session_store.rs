//! Port of src/sessionStore.ts (TRDD-DMWOBWFH P4d) — the 5-minute rolling in-memory span
//! window: the engine behind /api/summary's live half, the SSE update source, and the gen_ai
//! injection target (injectSpanAttribute).
//!
//! Deviations on record:
//! - The TS class reads the ambient clock (`Date.now()`); this port takes `now_ms` as a
//!   parameter on every clock-touching call — the same testability precedent as the span-store
//!   writer, and what lets the parity oracle pin the clock.
//! - The onUpdate callback registry is host wiring (the TS server's SSE push), not data
//!   behavior — the alcore server slice will own eventing; nothing here loses wire parity.
//! - The summary's `lastUpdated` is kept as epoch ms and exported as the ISO string
//!   JSON.stringify makes of a Date.

use serde_json::{Map, Value};

use crate::summarize::copilot::patch_file_line;
use crate::summarize::helpers::{self as h, iso_from_ms, num, truthy};

pub const SPAN_WINDOW_MS: f64 = 5.0 * 60.0 * 1000.0;

const COPILOT_WRITE_TOOLS: [&str; 5] =
    ["replace_string_in_file", "multi_replace_string_in_file", "create_file", "edit_notebook_file", "apply_patch"];
const CLAUDE_WRITE_TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];

/// parseInt(String(x)) || 0 — base-10 digit-prefix parse (NOT Number(): "2.7" parses to 2).
fn js_parse_int_or_zero(s: &str) -> f64 {
    let t = s.trim_start();
    let (sign, rest) = match t.as_bytes().first() {
        Some(b'-') => (-1.0, &t[1..]),
        Some(b'+') => (1.0, &t[1..]),
        _ => (1.0, t),
    };
    let end = rest.bytes().position(|b| !b.is_ascii_digit()).unwrap_or(rest.len());
    if end == 0 {
        return 0.0; // parseInt → NaN → || 0
    }
    rest[..end].parse::<f64>().map(|n| sign * n).unwrap_or(0.0)
}

/// `parseInt(String(a?.value?.intValue ?? a?.value?.stringValue ?? 0)) || 0` — note the NULLISH
/// chain (a present-but-0 intValue wins) and that doubleValue is deliberately not consulted.
fn int_attr(span: &Value, key: &str) -> f64 {
    let val = span
        .get("attributes")
        .and_then(Value::as_array)
        .and_then(|attrs| attrs.iter().find(|a| a.get("key").and_then(Value::as_str) == Some(key)))
        .and_then(|a| a.get("value"));
    let picked: Value = match val {
        Some(v) => {
            if let Some(iv) = v.get("intValue").filter(|x| !x.is_null()) {
                iv.clone()
            } else if let Some(sv) = v.get("stringValue").filter(|x| !x.is_null()) {
                sv.clone()
            } else {
                Value::from(0)
            }
        }
        None => Value::from(0),
    };
    js_parse_int_or_zero(&h::js_string(&picked))
}

fn first_of(span: &Value, keys: &[&str]) -> f64 {
    for k in keys {
        let v = int_attr(span, k);
        if v > 0.0 {
            return v;
        }
    }
    0.0
}

/// stringValue || '' — only stringValue, unlike the summarizers' coercing accessor.
fn attr_str_val(span: &Value, key: &str) -> String {
    span.get("attributes")
        .and_then(Value::as_array)
        .and_then(|attrs| attrs.iter().find(|a| a.get("key").and_then(Value::as_str) == Some(key)))
        .and_then(|a| a.get("value"))
        .and_then(|v| v.get("stringValue"))
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .unwrap_or("")
        .to_owned()
}

pub struct SessionStore {
    spans: Vec<Value>,
    total_spans: f64,
    agent_sessions: f64,
    tool_calls: Vec<(String, f64)>,
    tokens_used: f64,
    files_changed: Vec<String>,
    errors: f64,
    last_updated_ms: f64,
}

impl SessionStore {
    /// emptySummary()'s construction-time `new Date()` — the caller supplies the clock.
    pub fn new(now_ms: f64) -> SessionStore {
        SessionStore {
            spans: Vec::new(),
            total_spans: 0.0,
            agent_sessions: 0.0,
            tool_calls: Vec::new(),
            tokens_used: 0.0,
            files_changed: Vec::new(),
            errors: 0.0,
            last_updated_ms: now_ms,
        }
    }

    pub fn add_span(&mut self, mut span: Value, now_ms: f64) {
        if let Some(obj) = span.as_object_mut() {
            // `=== undefined` — an explicit null is NOT restamped.
            if !obj.contains_key("receivedAt") {
                obj.insert("receivedAt".into(), num(now_ms));
            }
        }
        self.update_summary(&span, now_ms);
        self.spans.push(span);
        self.trim_spans(now_ms);
    }

    fn trim_spans(&mut self, now_ms: f64) {
        let cutoff = now_ms - SPAN_WINDOW_MS;
        self.spans.retain(|s| {
            // receivedAt ?? nanoToMs(startTime) — nullish, so a present 0 stays a 0.
            let ms = match s.get("receivedAt") {
                Some(v) if !v.is_null() => v.as_f64().unwrap_or(0.0),
                _ => h::nano_to_ms(h::start_time(s)),
            };
            ms == 0.0 || ms > cutoff
        });
    }

    fn update_summary(&mut self, span: &Value, now_ms: f64) {
        self.total_spans += 1.0;
        self.last_updated_ms = now_ms;
        let name = h::name_of(span);

        if name.contains("agent") || name.contains("session") {
            self.agent_sessions += 1.0;
        }

        if name.contains("tool") {
            let tool_name = name.replacen("tool/", "", 1);
            match self.tool_calls.iter_mut().find(|(k, _)| *k == tool_name) {
                Some((_, n)) => *n += 1.0,
                None => self.tool_calls.push((tool_name, 1.0)),
            }
        }

        // Coarse "total context" scalar — first present value PER BUCKET, never both naming
        // conventions summed (the double-count trap the TS comment records).
        let input = first_of(span, &["input_tokens", "prompt_tokens", "gen_ai.usage.input_tokens"]);
        let cache_read = first_of(span, &["cache_read_tokens", "gen_ai.usage.cache_read.input_tokens"]);
        let cache_create = first_of(span, &["cache_creation_tokens", "gen_ai.usage.cache_creation.input_tokens"]);
        let output = first_of(span, &["output_tokens", "completion_tokens", "gen_ai.usage.output_tokens"]);
        self.tokens_used += input + cache_read + cache_create + output;

        let tool_name = {
            let a = attr_str_val(span, "gen_ai.tool.name");
            if a.is_empty() { attr_str_val(span, "tool_name") } else { a }
        };
        let args_str = {
            let a = attr_str_val(span, "gen_ai.tool.call.arguments");
            if !a.is_empty() {
                a
            } else {
                let b = attr_str_val(span, "tool_input");
                if b.is_empty() { attr_str_val(span, "input") } else { b }
            }
        };
        let is_write_tool =
            COPILOT_WRITE_TOOLS.contains(&tool_name.as_str()) || CLAUDE_WRITE_TOOLS.contains(&tool_name.as_str());

        if is_write_tool && !args_str.is_empty() {
            // JSON null (property access throws) aborts the whole try in TS.
            if let Ok(args) = serde_json::from_str::<Value>(&args_str) {
                if !args.is_null() {
                    let mut aborted = false;
                    if tool_name == "apply_patch" {
                        let patch = [args.get("command"), args.get("patch"), args.get("input")]
                            .into_iter()
                            .flatten()
                            .find(|v| truthy(v));
                        match patch {
                            Some(Value::String(content)) => {
                                for line in content.split('\n') {
                                    if let Some(fp) = patch_file_line(line) {
                                        if fp.contains('/') && !self.files_changed.iter().any(|f| f == fp) {
                                            self.files_changed.push(fp.to_owned());
                                        }
                                    }
                                }
                            }
                            // A truthy non-string patch content throws on .split in TS,
                            // aborting the rest of the try block.
                            Some(_) => aborted = true,
                            None => {}
                        }
                    } else if let Some(fp) = [args.get("filePath"), args.get("file_path")].into_iter().flatten().find(|v| truthy(v)) {
                        let fp = h::js_string(fp);
                        if !self.files_changed.contains(&fp) {
                            self.files_changed.push(fp);
                        }
                    }
                    if !aborted {
                        if let Some(reps) = args.get("replacements").and_then(Value::as_array) {
                            for r in reps {
                                if let Some(fp) = [r.get("filePath"), r.get("file_path")].into_iter().flatten().find(|v| truthy(v)) {
                                    let fp = h::js_string(fp);
                                    if !self.files_changed.contains(&fp) {
                                        self.files_changed.push(fp);
                                    }
                                }
                            }
                        }
                        if let Some(edits) = args.get("edits").and_then(Value::as_array) {
                            for e in edits {
                                if let Some(fp) = [e.get("file_path"), e.get("filePath")].into_iter().flatten().find(|v| truthy(v)) {
                                    let fp = h::js_string(fp);
                                    if !self.files_changed.contains(&fp) {
                                        self.files_changed.push(fp);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if h::status_is_error(span) {
            self.errors += 1.0;
        }
    }

    /// Injects or overwrites a single attribute on an existing span (the gen_ai log-event
    /// attach). Returns whether the span was found.
    pub fn inject_span_attribute(&mut self, trace_id: &str, span_id: &str, key: &str, value: &str) -> bool {
        let Some(span) = self.spans.iter_mut().find(|s| {
            s.get("traceId").and_then(Value::as_str) == Some(trace_id) && s.get("spanId").and_then(Value::as_str) == Some(span_id)
        }) else {
            return false;
        };
        let attrs = span
            .as_object_mut()
            .expect("span is an object")
            .entry("attributes")
            .or_insert_with(|| Value::Array(Vec::new()));
        let Some(attrs) = attrs.as_array_mut() else { return true };
        let mut new_value = Map::new();
        new_value.insert("stringValue".into(), value.into());
        match attrs.iter_mut().find(|a| a.get("key").and_then(Value::as_str) == Some(key)) {
            Some(existing) => {
                existing.as_object_mut().expect("attr is an object").insert("value".into(), Value::Object(new_value));
            }
            None => {
                let mut a = Map::new();
                a.insert("key".into(), key.into());
                a.insert("value".into(), Value::Object(new_value));
                attrs.push(Value::Object(a));
            }
        }
        true
    }

    pub fn clear(&mut self, now_ms: f64) {
        self.spans.clear();
        self.total_spans = 0.0;
        self.agent_sessions = 0.0;
        self.tool_calls.clear();
        self.tokens_used = 0.0;
        self.files_changed.clear();
        self.errors = 0.0;
        self.last_updated_ms = now_ms;
    }

    pub fn spans(&self) -> &[Value] {
        &self.spans
    }

    pub fn summary_value(&self) -> Value {
        let mut s = Map::new();
        s.insert("totalSpans".into(), num(self.total_spans));
        s.insert("agentSessions".into(), num(self.agent_sessions));
        {
            let mut tc = Map::new();
            for (k, v) in &self.tool_calls {
                tc.insert(k.clone(), num(*v));
            }
            s.insert("toolCalls".into(), Value::Object(tc));
        }
        s.insert("totalDurationMs".into(), num(0.0));
        s.insert("tokensUsed".into(), num(self.tokens_used));
        s.insert("filesChanged".into(), Value::Array(self.files_changed.iter().map(|f| Value::from(f.as_str())).collect()));
        s.insert("errors".into(), num(self.errors));
        // JSON.stringify(Date) — the ISO string.
        s.insert("lastUpdated".into(), iso_from_ms(self.last_updated_ms).into());
        Value::Object(s)
    }

    /// export() — { summary, spans }.
    pub fn export(&self) -> Value {
        let mut r = Map::new();
        r.insert("summary".into(), self.summary_value());
        r.insert("spans".into(), Value::Array(self.spans.clone()));
        Value::Object(r)
    }
}

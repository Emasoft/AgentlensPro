//! agentlens-ingest — the OTLP → Span transform (TRDD-DMWOBWFH P3b), a pure port of
//! `src/otlpCollector.ts`'s processTraces/processLogs/processMetrics plus its two helper
//! state machines (`src/codexSessionNormalizer.ts`, `src/genAiContent.ts`) and the shared
//! gate sets (`src/otlpLogEvents.ts`).
//!
//! PURE means: no HTTP, no store writes — the functions consume a parsed OTLP payload and
//! return the spans `store.addSpan` would have received, byte-shaped identically (traceId,
//! spanId, parentSpanId?, name, startTime, endTime, attributes, status). Side effects the TS
//! collector performs inline come back as DATA: account pairs (callBodyRegistry.recordAccount),
//! body pointers (callBodyRegistry.record), dropped log events (the sink), and gen_ai
//! injections happen through a caller-supplied `try_inject` so the buffer's
//! consume-on-successful-inject semantics stay exact. `receivedAt` stamping remains the
//! STORE's job, exactly as in TS.
//!
//! Contracts ported deliberately (each was a real drift/bug in TS history — see the module
//! docs in the TS sources):
//! - Rich Claude LOG events key on session.id FIRST; the propagated OTLP traceId only as
//!   fallback (traceId-first orphaned every rich event into a pseudo-session, measured).
//! - Stored names are ALWAYS re-prefixed `claude_code.<bare>` regardless of what the emitter
//!   sent (2.1.206 emits bare names; the summarizer keys on the prefixed form).
//! - Codex per-prompt grouping (`codex:<conv>:prompt-N`) is a stateful normalizer whose maps
//!   persist across payloads; background Codex calls with neither an OTLP traceId nor a
//!   conversation id are DROPPED, never folded into the sticky fallback trace.
//! - gen_ai response content buffers by traceId:spanId (cap 500, oldest-evict) and injects on
//!   whichever side arrives second.

use indexmap::IndexMap;
use serde_json::{json, Map, Value};

pub const CLAUDE_RICH_LOG_EVENTS: [&str; 4] = ["api_request", "compaction", "api_error", "api_retries_exhausted"];
pub const BODY_POINTER_LOG_EVENTS: [&str; 2] = ["api_request_body", "api_response_body"];
const GEN_AI_BUFFER_MAX: usize = 500;
const DROPPED_EVENTS_MAX_NAMES: usize = 50;

// ── Attribute helpers (SpanAttribute = {key, value:{stringValue|intValue|doubleValue|…}}) ─────

type Attr = Map<String, Value>;

/// PROFILED, not guessed (TRDD-DMWOBWFH D2, `/usr/bin/sample` on a 1M-span payload): this
/// function was **63% of `process_traces`**, and inside it the hot frames were
/// `IndexMap::insert` → `RawVecInner::finish_grow` → `malloc`. The map is known to hold exactly
/// two entries, so every one of those growth reallocations was avoidable — `Map::new()` starts at
/// capacity 0 and regrows on the way to 2, once per attribute, millions of times per ingest.
///
/// `with_capacity` on the outer Vec matters for the same reason: a span's attribute count is
/// bounded by the input array's length, so the output vector never needs to double.
///
/// Now takes the attribute array BY VALUE, which removes the rebuild entirely: an OTLP `KeyValue`
/// is already exactly `{key, value}` — the shape this function used to construct — so once the
/// input is owned there is nothing to build. Validate, drop any field that is not `key`/`value`
/// (`retain` is in place, so it allocates nothing), and MOVE the map into the output. Per
/// attribute that is 0 allocations where there were 5, including a deep clone of the value.
///
/// `retain` rather than trusting the input: OTLP KeyValue carries only those two fields, but a
/// pass-through would make the output depend on what the sender happened to include, and the
/// cross-engine parity tests pin the exact key set against the TS collector.
/// The borrowing form, for the log and metric paths, which still walk a borrowed payload. It
/// delegates rather than duplicating the logic — one `cloned()` here is what the owned path used
/// to pay per attribute, and these callers are not the measured hot path (the traces transform
/// was; see `process_traces`). If they ever show up in a profile, convert them the same way
/// instead of forking a second implementation.
fn to_span_attributes_ref(raw: Option<&Value>) -> Vec<Attr> {
    to_span_attributes(raw.cloned())
}

fn to_span_attributes(raw: Option<Value>) -> Vec<Attr> {
    let Some(Value::Array(items)) = raw else { return Vec::new() };
    let mut out: Vec<Attr> = Vec::with_capacity(items.len());
    for item in items {
        let Value::Object(mut obj) = item else { continue };
        let key_ok = obj.get("key").and_then(Value::as_str).is_some_and(|k| !k.is_empty());
        let value_ok = obj.get("value").is_some_and(Value::is_object);
        if !key_ok || !value_ok {
            continue;
        }
        obj.retain(|k, _| k == "key" || k == "value");
        out.push(obj);
    }
    out
}

fn merge_attributes(lists: &[&[Attr]]) -> Vec<Attr> {
    let mut out: Vec<Attr> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for list in lists {
        for attr in *list {
            let key = attr.get("key").and_then(Value::as_str).unwrap_or("");
            if seen.contains(key) {
                continue;
            }
            seen.insert(key.to_owned());
            out.push(attr.clone());
        }
    }
    out
}

/// TS `unwrapAttrValue`: first present of these wrapper keys wins, inner value verbatim
/// (intValue stays a STRING — Number() would corrupt 64-bit ids). Unknown wrapper shape → the
/// whole object cloned, nothing lost.
fn unwrap_attr_value(v: &Value) -> Value {
    for k in ["stringValue", "intValue", "doubleValue", "boolValue", "arrayValue", "kvlistValue", "bytesValue"] {
        if let Some(inner) = v.get(k) {
            return inner.clone();
        }
    }
    v.clone()
}

/// Port of `buildDroppedLogEventRecord` (src/logEventSink.ts) — pure, shared by the log-event
/// sink. Key insertion order is load-bearing (it is what JSON.stringify wrote in TS):
/// ts, ev, name, session?, traceId?, spanId?, tsEvent?, severity?, attrs, body?.
pub fn build_dropped_log_event_record(name: &str, bare: &str, attrs: &[Attr], rec: &Map<String, Value>, ts: i64) -> Map<String, Value> {
    let mut merged: Map<String, Value> = Map::new();
    for a in attrs {
        let Some(key) = a.get("key").and_then(Value::as_str) else { continue };
        let Some(value) = a.get("value").filter(|v| v.is_object()) else { continue };
        merged.insert(key.to_owned(), unwrap_attr_value(value)); // duplicate key: last wins
    }

    // Empty string is falsy in TS (`x ? x : undefined`) — an empty session/trace/span/severity
    // means ABSENT, not present-but-empty.
    let non_empty_str = |v: Option<&Value>| -> Option<String> {
        v.and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned)
    };
    let session = non_empty_str(merged.get("session.id")).or_else(|| non_empty_str(merged.get("session_id")));

    let mut ts_event: Option<i64> = None;
    if let Some(tun) = rec.get("timeUnixNano") {
        match tun {
            Value::String(s) if !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()) => {
                if let Ok(n) = s.parse::<f64>() {
                    ts_event = Some((n / 1e6).round() as i64);
                }
            }
            Value::Number(n) => {
                if let Some(n) = n.as_f64() {
                    if n.is_finite() && n > 0.0 {
                        ts_event = Some((n / 1e6).round() as i64);
                    }
                }
            }
            _ => {}
        }
    }

    let body_str = rec
        .get("body")
        .and_then(Value::as_object)
        .and_then(|b| b.get("stringValue"))
        .and_then(Value::as_str)
        // NOT `non_empty_str`: the TS guard here is `typeof bodyStr === 'string'`, not
        // truthiness, so an EMPTY body is present as `""` while an empty traceId/session/
        // severity is absent. Reusing one "non-empty" helper for all of them is the mutation
        // that passes every other case in the matrix (case `body-empty-string` catches it).
        .map(str::to_owned);

    let mut out: Map<String, Value> = Map::new();
    out.insert("ts".into(), json!(ts));
    out.insert("ev".into(), json!(bare));
    out.insert("name".into(), json!(name));
    if let Some(session) = session {
        out.insert("session".into(), json!(session));
    }
    if let Some(trace_id) = non_empty_str(rec.get("traceId")) {
        out.insert("traceId".into(), json!(trace_id));
    }
    if let Some(span_id) = non_empty_str(rec.get("spanId")) {
        out.insert("spanId".into(), json!(span_id));
    }
    if let Some(ts_event) = ts_event {
        out.insert("tsEvent".into(), json!(ts_event));
    }
    if let Some(severity) = non_empty_str(rec.get("severityText")) {
        out.insert("severity".into(), json!(severity));
    }
    out.insert("attrs".into(), Value::Object(merged));
    if let Some(body) = body_str {
        out.insert("body".into(), json!(body));
    }
    out
}

/// TS `getAttrFrom`: first non-empty stringValue/intValue/doubleValue across the key list,
/// String()-coerced.
fn get_attr_from(attrs: &[Attr], keys: &[&str]) -> String {
    for key in keys {
        let Some(attr) = attrs.iter().find(|a| a.get("key").and_then(Value::as_str) == Some(*key)) else { continue };
        let Some(value) = attr.get("value").and_then(Value::as_object) else { continue };
        for field in ["stringValue", "intValue", "doubleValue"] {
            match value.get(field) {
                None | Some(Value::Null) => continue,
                Some(Value::String(s)) if s.is_empty() => return get_attr_next(attrs, keys, key), // matched key, empty → but TS `??` picks FIRST non-null then checks length…
                Some(Value::String(s)) => return s.clone(),
                Some(Value::Number(n)) => return n.to_string(),
                Some(v) => return crate::js_string_min(v),
            }
        }
    }
    String::new()
}

// TS getAttrFrom nuance: `a.value?.stringValue ?? a.value?.intValue ?? a.value?.doubleValue` —
// the ?? chain picks the FIRST present-and-non-null FIELD; only then is String(val).length
// checked, and an empty result moves on to the NEXT KEY (not the next field). The helper above
// approximates the chain per-field; this continues the key scan after an empty first field —
// matching the observable behavior (empty string → try next key).
fn get_attr_next(attrs: &[Attr], keys: &[&str], after: &str) -> String {
    let pos = keys.iter().position(|k| k == &after).map(|p| p + 1).unwrap_or(keys.len());
    if pos >= keys.len() {
        return String::new();
    }
    get_attr_from(attrs, &keys[pos..])
}

fn js_string_min(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_owned(),
        _ => "[object Object]".to_owned(),
    }
}

fn string_attr(key: &str, value: &str) -> Attr {
    let mut a = Map::new();
    a.insert("key".into(), Value::String(key.to_owned()));
    a.insert("value".into(), json!({ "stringValue": value }));
    a
}

/// TS `withStringAttr`: append only when absent (and value non-empty).
fn with_string_attr(mut attrs: Vec<Attr>, key: &str, value: &str) -> Vec<Attr> {
    if value.is_empty() || attrs.iter().any(|a| a.get("key").and_then(Value::as_str) == Some(key)) {
        return attrs;
    }
    attrs.push(string_attr(key, value));
    attrs
}

/// TS `setStringAttr`: replace in place, else append (value non-empty).
fn set_string_attr(mut attrs: Vec<Attr>, key: &str, value: &str) -> Vec<Attr> {
    if value.is_empty() {
        return attrs;
    }
    let mut replaced = false;
    for a in attrs.iter_mut() {
        if a.get("key").and_then(Value::as_str) == Some(key) {
            *a = string_attr(key, value);
            replaced = true;
        }
    }
    if !replaced {
        attrs.push(string_attr(key, value));
    }
    attrs
}

fn attrs_from_body_kv(body: Option<&Value>) -> Vec<Attr> {
    let values = body
        .and_then(Value::as_object)
        .and_then(|o| o.get("kvlistValue"))
        .and_then(Value::as_object)
        .and_then(|kv| kv.get("values"))
        .and_then(Value::as_array);
    let Some(values) = values else { return Vec::new() };
    values
        .iter()
        .filter_map(|v| {
            let entry = v.as_object()?;
            let key = entry.get("key").and_then(Value::as_str)?;
            let value = entry.get("value")?;
            if key.is_empty() || !value.is_object() {
                return None;
            }
            let mut a = Map::new();
            a.insert("key".into(), Value::String(key.to_owned()));
            a.insert("value".into(), value.clone());
            Some(a)
        })
        .collect()
}

// ── otlpLogEvents.ts ──────────────────────────────────────────────────────────────

pub fn resolve_log_event_name(from_attrs: &str, rec: &Map<String, Value>) -> String {
    if !from_attrs.is_empty() {
        return from_attrs.to_owned();
    }
    if let Some(en) = rec.get("eventName").and_then(Value::as_str) {
        if !en.is_empty() {
            return en.to_owned();
        }
    }
    rec.get("body")
        .and_then(Value::as_object)
        .and_then(|b| b.get("stringValue"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned()
}

pub fn bare_log_event_name(name: &str) -> &str {
    name.strip_prefix("claude_code.").unwrap_or(name)
}

// ── genAiContent.ts ───────────────────────────────────────────────────────────────

pub fn format_gen_ai_event_content(raw: &str, event_name: &str) -> String {
    let Ok(parsed) = serde_json::from_str::<Value>(raw) else { return String::new() };
    let Some(parsed) = parsed.as_object() else { return String::new() };
    let msg: &Map<String, Value> = if event_name == "gen_ai.choice" && parsed.get("message").is_some_and(|m| !m.is_null() && truthy(m)) {
        parsed.get("message").and_then(Value::as_object).unwrap_or(parsed)
    } else {
        parsed
    };
    let role = msg.get("role").cloned().filter(|r| !r.is_null()).unwrap_or(Value::String("assistant".into()));
    let content = match msg.get("content") {
        Some(Value::String(s)) => json!([{ "type": "text", "text": s }]),
        Some(v) => v.clone(),
        None => Value::Null,
    };
    serde_json::to_string(&json!([{ "role": role, "content": content }])).unwrap_or_default()
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|f| f != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

// ── codexSessionNormalizer.ts ─────────────────────────────────────────────────────

pub fn is_codex_prompt_event_name(name: &str) -> bool {
    matches!(name, "codex.user_prompt" | "codex.prompt" | "codex.user_message" | "codex.session_start")
}

#[derive(Default)]
pub struct CodexSessionNormalizer {
    by_otel_trace: IndexMap<String, String>,
    current_by_conversation: IndexMap<String, String>,
    state_by_id: IndexMap<String, bool>, // sessionId → hasPrompt
    prompt_ordinal_by_conversation: IndexMap<String, u64>,
    active_prompt_session_id: String,
}

impl CodexSessionNormalizer {
    pub fn session_by_otel_trace_id(&self, otlp_trace_id: &str) -> Option<&str> {
        self.by_otel_trace.get(otlp_trace_id).map(String::as_str)
    }

    fn next_prompt_session_id(&mut self, conversation_id: &str) -> String {
        let next = self.prompt_ordinal_by_conversation.get(conversation_id).copied().unwrap_or(0) + 1;
        self.prompt_ordinal_by_conversation.insert(conversation_id.to_owned(), next);
        format!("codex:{conversation_id}:prompt-{next}")
    }

    pub fn resolve_session_id(&mut self, conversation_id: &str, otlp_trace_id: &str, turn_id: &str, span_name: &str) -> Option<String> {
        let is_prompt = is_codex_prompt_event_name(span_name);
        let mut session_id: Option<String> = if otlp_trace_id.is_empty() {
            None
        } else {
            self.by_otel_trace.get(otlp_trace_id).cloned()
        };

        if is_prompt {
            let current = self.current_by_conversation.get(conversation_id).cloned();
            let current_has_prompt = current.as_deref().map(|c| *self.state_by_id.get(c).unwrap_or(&false));
            if session_id.is_none() {
                if let (Some(c), Some(false)) = (&current, current_has_prompt) {
                    session_id = Some(c.clone());
                }
            }
            match &session_id {
                None => {
                    session_id = Some(if turn_id.is_empty() {
                        self.next_prompt_session_id(conversation_id)
                    } else {
                        format!("codex:{conversation_id}:{turn_id}")
                    });
                }
                Some(s) if *self.state_by_id.get(s.as_str()).unwrap_or(&false) => {
                    session_id = Some(if turn_id.is_empty() {
                        self.next_prompt_session_id(conversation_id)
                    } else {
                        format!("codex:{conversation_id}:{turn_id}")
                    });
                }
                _ => {}
            }
        } else if session_id.is_some() {
            // Existing raw OTEL trace already mapped to the active prompt cycle.
        } else if let Some(c) = self.current_by_conversation.get(conversation_id) {
            session_id = Some(c.clone());
        } else if !self.active_prompt_session_id.is_empty() {
            session_id = Some(self.active_prompt_session_id.clone());
        } else if !turn_id.is_empty() {
            session_id = Some(format!("codex:{conversation_id}:{turn_id}"));
        } else {
            return None;
        }

        let session_id = session_id?;
        self.current_by_conversation.insert(conversation_id.to_owned(), session_id.clone());
        if !otlp_trace_id.is_empty() {
            self.by_otel_trace.insert(otlp_trace_id.to_owned(), session_id.clone());
        }
        if is_prompt {
            self.state_by_id.insert(session_id.clone(), true);
            self.active_prompt_session_id = session_id.clone();
        } else {
            self.state_by_id.entry(session_id.clone()).or_insert(false);
        }
        Some(session_id)
    }
}

// ── The ingest state machine (OtlpCollector's private fields) ─────────────────────

pub struct IngestState {
    pub codex_fallback_trace_id: String,
    pub codex_last_activity_ms: i64,
    codex_session_root_by_trace: IndexMap<String, String>,
    pub codex_norm: CodexSessionNormalizer,
    gen_ai_buffer: IndexMap<String, String>,
    pub dropped_log_events: IndexMap<String, u64>,
    /// Deterministic fallback span-id counter (TS uses Math.random base36; the fallback fires
    /// only for records with NO span id anywhere, and uniqueness is all that matters).
    fallback_span_counter: u64,
}

impl Default for IngestState {
    fn default() -> Self {
        IngestState {
            codex_fallback_trace_id: String::new(),
            codex_last_activity_ms: 0,
            codex_session_root_by_trace: IndexMap::new(),
            codex_norm: CodexSessionNormalizer::default(),
            gen_ai_buffer: IndexMap::new(),
            dropped_log_events: IndexMap::new(),
            fallback_span_counter: 0,
        }
    }
}

/// A body-pointer record (callBodyRegistry.record's payload, minus the registry).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BodyPointer {
    pub session_id: String,
    pub kind: &'static str, // request | response
    #[serde(skip_serializing_if = "Option::is_none")]
    pub body_ref: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inline_body: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub request_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query_source: Option<String>,
    pub ts: i64,
}

#[derive(Debug, Default)]
pub struct LogsResult {
    pub spans: Vec<Value>,
    pub account_pairs: Vec<(String, String)>,
    pub body_pointers: Vec<BodyPointer>,
    /// Gate-rejected log events, already built into their persisted sink records
    /// (`build_dropped_log_event_record`). The record is built HERE, at the drop site, because
    /// this is the only place that still holds the merged wire attrs and the raw log record —
    /// the caller sees neither. The caller's job is only to append them.
    pub dropped: Vec<Map<String, Value>>,
    pub count: u64,
}

fn parse_iso_ms(s: &str) -> Option<i64> {
    // Reuse the spanstore parser shape without a crate dependency: the harness writes strict
    // ISO; `new Date(ts).getTime()` in TS accepts the same forms for these inputs.
    agentlens_iso::parse_iso_ms(s)
}

/// Minimal ISO parser, duplicated intentionally as a nested module to keep this crate
/// dependency-free; pinned by the same tests that pin the spanstore copy.
mod agentlens_iso {
    pub fn parse_iso_ms(s: &str) -> Option<i64> {
        let b = s.as_bytes();
        if b.len() < 20 || b[4] != b'-' || b[7] != b'-' || b[10] != b'T' {
            return None;
        }
        let num = |from: usize, to: usize| -> Option<i64> { s.get(from..to)?.parse::<i64>().ok() };
        let (y, mo, d) = (num(0, 4)?, num(5, 7)?, num(8, 10)?);
        let (h, mi, sec) = (num(11, 13)?, num(14, 16)?, num(17, 19)?);
        let mut idx = 19;
        let mut millis: i64 = 0;
        if b.get(idx) == Some(&b'.') {
            let start = idx + 1;
            let mut end = start;
            while end < b.len() && b[end].is_ascii_digit() {
                end += 1;
            }
            let frac = s.get(start..end)?;
            let scaled = format!("{:0<3}", &frac[..frac.len().min(3)]);
            millis = scaled.parse().ok()?;
            idx = end;
        }
        let offset_min: i64 = match b.get(idx) {
            Some(b'Z') => 0,
            Some(sign @ (b'+' | b'-')) => {
                let oh = num(idx + 1, idx + 3)?;
                let om = if b.get(idx + 3) == Some(&b':') { num(idx + 4, idx + 6)? } else { num(idx + 3, idx + 5)? };
                let m = oh * 60 + om;
                if *sign == b'+' { m } else { -m }
            }
            _ => return None,
        };
        let days = days_from_civil(y, mo, d)?;
        Some((((days * 24 + h) * 60 + mi - offset_min) * 60 + sec) * 1000 + millis)
    }
    fn days_from_civil(y: i64, m: i64, d: i64) -> Option<i64> {
        if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
            return None;
        }
        let y = if m <= 2 { y - 1 } else { y };
        let era = if y >= 0 { y } else { y - 399 } / 400;
        let yoe = y - era * 400;
        let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + d - 1;
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
        Some(era * 146097 + doe - 719468)
    }
}

impl IngestState {
    fn note_dropped(&mut self, name: &str) {
        let key = if name.is_empty() { "(unnamed)" } else { name };
        if !self.dropped_log_events.contains_key(key) && self.dropped_log_events.len() >= DROPPED_EVENTS_MAX_NAMES {
            *self.dropped_log_events.entry("(other)".to_owned()).or_insert(0) += 1;
            return;
        }
        *self.dropped_log_events.entry(key.to_owned()).or_insert(0) += 1;
    }

    fn is_codex_websocket_span(&self, span_name: &str, attrs: &[Attr]) -> bool {
        let name = span_name.to_lowercase();
        if !name.contains("websocket") {
            return false;
        }
        let event_name = get_attr_from(attrs, &["event.name", "event_name", "name", "event"]).to_lowercase();
        let has_codex_attr = !get_attr_from(attrs, &["codex.session.id", "codex.conversation.id", "codex.turn.id"]).is_empty();
        name.starts_with("codex.") || event_name.starts_with("codex.") || has_codex_attr
    }

    fn is_codex_trace_span(&self, span_name: &str, attrs: &[Attr]) -> bool {
        let thread_id = get_attr_from(attrs, &["thread.id", "thread_id"]);
        let turn_id = get_attr_from(attrs, &["turn.id", "turn_id"]);
        if !thread_id.is_empty() && !turn_id.is_empty() {
            return true;
        }
        let otel_name = get_attr_from(attrs, &["otel.name"]);
        otel_name.starts_with("session_task.") || otel_name == "completed" || span_name == "handle_responses"
    }

    /// processLogs. `try_inject(traceId, spanId, formatted) -> bool` mirrors
    /// store.injectSpanAttribute — the buffer entry is consumed on a successful inject.
    pub fn process_logs(
        &mut self,
        payload: &Value,
        now_ms: i64,
        mut try_inject: impl FnMut(&str, &str, &str) -> bool,
    ) -> LogsResult {
        let mut out = LogsResult::default();
        if self.codex_fallback_trace_id.is_empty() || now_ms - self.codex_last_activity_ms > 30_000 {
            self.codex_fallback_trace_id = format!("codex-{now_ms}");
        }
        let claude_log_fallback_trace_id = format!("claude-log-{now_ms}");

        let resource_logs = payload.get("resourceLogs").and_then(Value::as_array);
        let Some(resource_logs) = resource_logs else { return out };
        for rl in resource_logs.iter().filter_map(Value::as_object) {
            let resource_attrs = to_span_attributes_ref(rl.get("resource").and_then(Value::as_object).and_then(|r| r.get("attributes")));
            for sl in rl.get("scopeLogs").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]).iter().filter_map(Value::as_object) {
                let scope_attrs = to_span_attributes_ref(sl.get("scope").and_then(Value::as_object).and_then(|s| s.get("attributes")));
                for rec in sl.get("logRecords").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]).iter().filter_map(Value::as_object) {
                    let record_attrs = to_span_attributes_ref(rec.get("attributes"));
                    let body_attrs = attrs_from_body_kv(rec.get("body"));
                    let mut attrs = merge_attributes(&[&record_attrs, &body_attrs, &scope_attrs, &resource_attrs]);

                    let event_name = resolve_log_event_name(&get_attr_from(&attrs, &["event.name", "event_name", "name", "event"]), rec);
                    let bare_event = bare_log_event_name(&event_name).to_owned();
                    let log_tool_name = get_attr_from(&attrs, &["tool.name", "tool_name"]);
                    let is_codex_event = event_name.starts_with("codex.");
                    let is_claude_tool_result = bare_event == "tool_result" && !log_tool_name.is_empty();
                    let is_claude_rich_event = CLAUDE_RICH_LOG_EVENTS.contains(&bare_event.as_str());

                    let is_gen_ai_content = event_name == "gen_ai.choice" || event_name == "gen_ai.assistant.message";
                    if is_gen_ai_content {
                        let log_trace_id = rec.get("traceId").and_then(Value::as_str).unwrap_or("");
                        let log_span_id = rec.get("spanId").and_then(Value::as_str).unwrap_or("");
                        if !log_trace_id.is_empty() && !log_span_id.is_empty() {
                            let raw = get_attr_from(&attrs, &["gen_ai.event.content"]);
                            let formatted = if raw.is_empty() { String::new() } else { format_gen_ai_event_content(&raw, &event_name) };
                            if !formatted.is_empty() {
                                let buf_key = format!("{log_trace_id}:{log_span_id}");
                                self.gen_ai_buffer.insert(buf_key.clone(), formatted.clone());
                                if self.gen_ai_buffer.len() > GEN_AI_BUFFER_MAX {
                                    self.gen_ai_buffer.shift_remove_index(0);
                                }
                                if try_inject(log_trace_id, log_span_id, &formatted) {
                                    self.gen_ai_buffer.shift_remove(&buf_key);
                                }
                            }
                        }
                        continue;
                    }

                    if BODY_POINTER_LOG_EVENTS.contains(&bare_event.as_str()) {
                        let body_session_id = get_attr_from(&attrs, &["session.id", "session_id"]);
                        let body_ref = get_attr_from(&attrs, &["body_ref", "body.ref", "bodyRef"]);
                        let inline_body = get_attr_from(&attrs, &["body"]);
                        let body_account = get_attr_from(&attrs, &["user.account_uuid", "user_account_uuid"]);
                        if !body_session_id.is_empty() && !body_account.is_empty() {
                            out.account_pairs.push((body_session_id.clone(), body_account));
                        }
                        if !body_session_id.is_empty() && (!body_ref.is_empty() || !inline_body.is_empty()) {
                            let body_span_id = rec
                                .get("spanId")
                                .and_then(Value::as_str)
                                .filter(|s| !s.is_empty())
                                .map(str::to_owned)
                                .unwrap_or_else(|| get_attr_from(&attrs, &["span_id", "spanId"]));
                            let none_if_empty = |s: String| if s.is_empty() { None } else { Some(s) };
                            out.body_pointers.push(BodyPointer {
                                session_id: body_session_id,
                                kind: if bare_event == "api_request_body" { "request" } else { "response" },
                                body_ref: none_if_empty(body_ref.clone()),
                                inline_body: if body_ref.is_empty() { none_if_empty(inline_body) } else { None },
                                request_id: none_if_empty(get_attr_from(&attrs, &["request_id", "request.id", "requestId"])),
                                span_id: none_if_empty(body_span_id),
                                model: none_if_empty(get_attr_from(&attrs, &["model"])),
                                query_source: none_if_empty(get_attr_from(&attrs, &["query_source", "query.source"])),
                                ts: now_ms,
                            });
                        }
                        continue;
                    }

                    if !is_codex_event && !is_claude_tool_result && !is_claude_rich_event {
                        self.note_dropped(&event_name);
                        out.dropped.push(build_dropped_log_event_record(&event_name, &bare_event, &attrs, rec, now_ms));
                        continue;
                    }
                    if is_codex_event && self.is_codex_websocket_span(&event_name, &attrs) {
                        continue;
                    }

                    let span_id = rec
                        .get("spanId")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .map(str::to_owned)
                        .unwrap_or_else(|| {
                            let a = get_attr_from(&attrs, &["span_id", "spanId"]);
                            if a.is_empty() {
                                self.fallback_span_counter += 1;
                                format!("cl-{:08x}", now_ms as u64 ^ self.fallback_span_counter.rotate_left(17))
                            } else {
                                a
                            }
                        });

                    let trace_id: String;
                    let span_name: String;
                    if is_claude_tool_result || is_claude_rich_event {
                        let sid = get_attr_from(&attrs, &["session.id", "session_id"]);
                        trace_id = if !sid.is_empty() {
                            sid
                        } else {
                            rec.get("traceId")
                                .and_then(Value::as_str)
                                .filter(|s| !s.is_empty())
                                .map(str::to_owned)
                                .unwrap_or_else(|| claude_log_fallback_trace_id.clone())
                        };
                        span_name = format!("claude_code.{bare_event}");
                    } else {
                        let otlp_trace_id = rec.get("traceId").and_then(Value::as_str).unwrap_or("").to_owned();
                        let conv_id = get_attr_from(&attrs, &[
                            "conversation.id", "conversation_id", "codex.conversation.id",
                            "thread.id", "thread_id", "session.id", "session_id", "trace_id", "traceId",
                        ]);
                        if otlp_trace_id.is_empty() && conv_id.is_empty() {
                            continue; // background Codex call with no conversation context
                        }
                        span_name = event_name.clone();
                        let turn_id = get_attr_from(&attrs, &["turn.id", "turn_id", "codex.turn.id"]);
                        let conversation_key = if !conv_id.is_empty() {
                            conv_id.clone()
                        } else if !otlp_trace_id.is_empty() {
                            otlp_trace_id.clone()
                        } else {
                            self.codex_fallback_trace_id.clone()
                        };
                        let session_id = self.codex_norm.resolve_session_id(&conversation_key, &otlp_trace_id, &turn_id, &span_name);
                        trace_id = session_id
                            .clone()
                            .or_else(|| if otlp_trace_id.is_empty() { None } else { Some(otlp_trace_id.clone()) })
                            .unwrap_or_else(|| conversation_key.clone());
                        if let Some(sid) = &session_id {
                            attrs = set_string_attr(attrs, "codex.session.id", sid);
                            attrs = set_string_attr(attrs, "codex.conversation.id", &conversation_key);
                            if !turn_id.is_empty() {
                                attrs = set_string_attr(attrs, "codex.turn.id", &turn_id);
                            }
                        }
                        if !otlp_trace_id.is_empty() && session_id.is_some() && otlp_trace_id != trace_id {
                            attrs = with_string_attr(attrs, "otel.trace_id", &otlp_trace_id);
                        }
                        self.codex_last_activity_ms = now_ms;
                    }

                    let mut parent_span_id = {
                        let p = get_attr_from(&attrs, &["parent_span_id", "parentSpanId"]);
                        if p.is_empty() { None } else { Some(p) }
                    };
                    if is_codex_event {
                        if is_codex_prompt_event_name(&span_name) {
                            self.codex_session_root_by_trace.insert(trace_id.clone(), span_id.clone());
                        } else if !trace_id.is_empty() && parent_span_id.is_none() {
                            parent_span_id = self.codex_session_root_by_trace.get(&trace_id).cloned();
                        }
                    }

                    // Codex puts an ISO timestamp in event.timestamp instead of timeUnixNano.
                    let mut start_nano = js_string_min(rec.get("timeUnixNano").or_else(|| rec.get("observedTimeUnixNano")).unwrap_or(&Value::String("0".into())));
                    let mut end_nano = start_nano.clone();
                    if start_nano == "0" {
                        let ts = get_attr_from(&attrs, &["event.timestamp"]);
                        if !ts.is_empty() {
                            if let Some(ms) = parse_iso_ms(&ts) {
                                if ms > 0 {
                                    let end_ns = (ms as i128) * 1_000_000;
                                    let dur_ms = get_attr_from(&attrs, &["duration_ms"]).parse::<i64>().unwrap_or(0);
                                    end_nano = end_ns.to_string();
                                    start_nano = if dur_ms > 0 {
                                        (end_ns - (dur_ms as i128) * 1_000_000).to_string()
                                    } else {
                                        end_nano.clone()
                                    };
                                }
                            }
                        }
                    }

                    let mut span = Map::new();
                    span.insert("traceId".into(), Value::String(trace_id));
                    span.insert("spanId".into(), Value::String(span_id));
                    if let Some(p) = parent_span_id {
                        span.insert("parentSpanId".into(), Value::String(p));
                    }
                    span.insert("name".into(), Value::String(span_name));
                    span.insert("startTime".into(), Value::String(start_nano));
                    span.insert("endTime".into(), Value::String(end_nano));
                    span.insert("attributes".into(), Value::Array(attrs.into_iter().map(Value::Object).collect()));
                    out.spans.push(Value::Object(span));
                    out.count += 1;
                }
            }
        }
        out
    }

    /// processTraces. Returns the store-ready spans; gen_ai buffered content injects here when
    /// the span arrives after its log event.
    /// Takes the payload BY VALUE, and that is the performance fix, not a style choice.
    ///
    /// Measured (TRDD-DMWOBWFH D2): while the payload was borrowed, nothing could be moved out of
    /// it, so every span rebuilt its attribute list — a fresh `Map` per attribute plus a DEEP
    /// clone of each value — and then copied `traceId`/`spanId`/`name`/`startTime`/`endTime`/
    /// `status` out one field at a time. That is roughly 12 million allocations per million spans
    /// that the TypeScript collector never performs at all: `JSON.parse` hands it objects and it
    /// passes them by reference. The Rust port was 3.9x SLOWER than the TS one for exactly that
    /// reason — same algorithm, one side copying and the other not. Owning the payload turns
    /// every one of those copies into a move.
    ///
    /// Ownership also makes the whole walk a `remove()` chain: taking a field OUT of the map both
    /// yields it owned and stops it being cloned into the output.
    pub fn process_traces(&mut self, payload: Value, collector_path: &str) -> Vec<Value> {
        let mut out = Vec::new();
        let Value::Object(mut root) = payload else { return out };
        let Some(Value::Array(resource_spans)) = root.remove("resourceSpans") else { return out };

        for rs in resource_spans {
            let Value::Object(mut rs) = rs else { continue };
            let Some(Value::Array(scope_spans)) = rs.remove("scopeSpans") else { continue };
            for ss in scope_spans {
                let Value::Object(mut ss) = ss else { continue };
                let Some(Value::Array(spans)) = ss.remove("spans") else { continue };
                for raw in spans {
                    let Value::Object(mut span) = raw else { continue };
                    // `remove()` rather than `get()`: it yields the value OWNED, so nothing here
                    // is cloned into the output span.
                    //
                    // A one-pass `for (k, v) in span { match k.as_str() { … } }` was tried here to
                    // avoid serde_json's per-lookup SipHash — the second profile's top frames were
                    // `core::hash::sip` / `RandomState::hash_one` / `IndexMap` lookup, so it looked
                    // like the obvious next win. It MEASURED NEUTRAL (2546/2593/2690 ms across
                    // three runs of each, i.e. inside the ±6% run-to-run variance) and was
                    // reverted. Do not re-derive it from the profile alone: a frame being hot does
                    // not mean the alternative is cheaper, and the variance has to be measured
                    // before a single-run comparison means anything.
                    let (Some(Value::String(otlp_trace_id)), Some(Value::String(span_id)), Some(Value::String(name))) =
                        (span.remove("traceId"), span.remove("spanId"), span.remove("name"))
                    else {
                        continue;
                    };
                    let mut attrs = to_span_attributes(span.remove("attributes"));
                    if self.is_codex_websocket_span(&name, &attrs) {
                        continue;
                    }
                    let mut trace_id = otlp_trace_id.clone();
                    let parent_span_id = match span.remove("parentSpanId") {
                        Some(Value::String(p)) if !p.is_empty() => Some(p),
                        _ => None,
                    };
                    if let Some(mapped) = self.codex_norm.session_by_otel_trace_id(&otlp_trace_id).map(str::to_owned) {
                        trace_id = mapped.clone();
                        attrs = set_string_attr(attrs, "codex.session.id", &mapped);
                        attrs = with_string_attr(attrs, "otel.trace_id", &otlp_trace_id);
                    } else if self.is_codex_trace_span(&name, &attrs) {
                        let conversation_id = get_attr_from(&attrs, &["thread.id", "thread_id", "conversation.id", "conversation_id", "codex.conversation.id"]);
                        let turn_id = get_attr_from(&attrs, &["turn.id", "turn_id", "codex.turn.id"]);
                        if !conversation_id.is_empty() && !turn_id.is_empty() {
                            let session_id = self.codex_norm.resolve_session_id(&conversation_id, &otlp_trace_id, &turn_id, &name);
                            if let Some(sid) = &session_id {
                                trace_id = sid.clone();
                                attrs = set_string_attr(attrs, "codex.session.id", sid);
                                attrs = set_string_attr(attrs, "codex.conversation.id", &conversation_id);
                                attrs = set_string_attr(attrs, "codex.turn.id", &turn_id);
                                if otlp_trace_id != trace_id {
                                    attrs = with_string_attr(attrs, "otel.trace_id", &otlp_trace_id);
                                }
                                if parent_span_id.is_none() && !self.codex_session_root_by_trace.contains_key(&trace_id) {
                                    self.codex_session_root_by_trace.insert(trace_id.clone(), span_id.clone());
                                }
                            }
                        }
                    }
                    let buf_key = format!("{trace_id}:{span_id}");
                    if let Some(buffered) = self.gen_ai_buffer.shift_remove(&buf_key) {
                        attrs = set_string_attr(attrs, "gen_ai.output.messages", &buffered);
                    }
                    attrs = set_string_attr(attrs, "_agentlens.collector_path", collector_path);

                    // 7 known keys, so the output map is sized once instead of regrowing — the
                    // same avoidable-growth defect the profile found inside to_span_attributes.
                    let mut s = Map::with_capacity(8);
                    s.insert("traceId".into(), Value::String(trace_id));
                    s.insert("spanId".into(), Value::String(span_id));
                    if let Some(p) = parent_span_id {
                        s.insert("parentSpanId".into(), Value::String(p));
                    }
                    s.insert("name".into(), Value::String(name));
                    s.insert("startTime".into(), span.remove("startTimeUnixNano").unwrap_or(Value::Null));
                    s.insert("endTime".into(), span.remove("endTimeUnixNano").unwrap_or(Value::Null));
                    s.insert("attributes".into(), Value::Array(attrs.into_iter().map(Value::Object).collect()));
                    if let Some(status) = span.remove("status") {
                        s.insert("status".into(), status);
                    }
                    out.push(Value::Object(s));
                }
            }
        }
        out
    }
}

/// processMetrics: harvest (session, account) pairs; return (metricCount, pointCount, pairs).
pub fn process_metrics(payload: &Value) -> (u64, u64, Vec<(String, String)>) {
    let mut metric_count = 0u64;
    let mut point_count = 0u64;
    let mut pairs: Vec<(String, String)> = Vec::new();
    let rms = payload.get("resourceMetrics").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
    for rm in rms.iter().filter_map(Value::as_object) {
        let res_attrs = to_span_attributes_ref(rm.get("resource").and_then(Value::as_object).and_then(|r| r.get("attributes")));
        let res_account = get_attr_from(&res_attrs, &["user.account_uuid", "user_account_uuid"]);
        let res_session = get_attr_from(&res_attrs, &["session.id", "session_id"]);
        if !res_account.is_empty() && !res_session.is_empty() {
            pairs.push((res_session.clone(), res_account.clone()));
        }
        for sm in rm.get("scopeMetrics").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]).iter().filter_map(Value::as_object) {
            let metrics = sm.get("metrics").and_then(Value::as_array).map(Vec::as_slice).unwrap_or(&[]);
            metric_count += metrics.len() as u64;
            for m in metrics.iter().filter_map(Value::as_object) {
                for group in ["sum", "gauge", "histogram", "exponentialHistogram"] {
                    let dps = m.get(group).and_then(Value::as_object).and_then(|g| g.get("dataPoints")).and_then(Value::as_array);
                    let Some(dps) = dps else { continue };
                    for dp in dps.iter().filter_map(Value::as_object) {
                        let point_attrs = to_span_attributes_ref(dp.get("attributes"));
                        let account = {
                            let a = get_attr_from(&point_attrs, &["user.account_uuid", "user_account_uuid"]);
                            if a.is_empty() { res_account.clone() } else { a }
                        };
                        let session = {
                            let s = get_attr_from(&point_attrs, &["session.id", "session_id"]);
                            if s.is_empty() { res_session.clone() } else { s }
                        };
                        if !account.is_empty() && !session.is_empty() {
                            pairs.push((session, account));
                        }
                    }
                    point_count += dps.len() as u64;
                }
            }
        }
    }
    (metric_count, point_count, pairs)
}

// The test module stays LAST in this file: clippy's items_after_test_module denies
// any item declared after it (a `#[cfg(test)]` block visually ends the file, so a
// definition below it reads as dead code and gets skipped in review).
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gen_ai_content_buffers_from_the_log_and_injects_into_the_later_span() {
        let mut state = IngestState::default();
        let content = serde_json::to_string(&json!({ "message": { "role": "assistant", "content": "hello é" } })).unwrap();
        let logs = json!({ "resourceLogs": [{ "scopeLogs": [{ "logRecords": [{
            "eventName": "gen_ai.choice", "traceId": "g1", "spanId": "gs1",
            "attributes": [{ "key": "gen_ai.event.content", "value": { "stringValue": content } }],
        }] }] }] });
        let r = state.process_logs(&logs, 0, |_, _, _| false); // span not in store yet
        assert_eq!(r.spans.len(), 0, "gen_ai content is never itself a span");
        let traces = json!({ "resourceSpans": [{ "scopeSpans": [{ "spans": [{
            "traceId": "g1", "spanId": "gs1", "name": "chat gpt-5",
            "startTimeUnixNano": "1", "endTimeUnixNano": "2", "attributes": [],
        }] }] }] });
        // Cloned explicitly because process_traces now CONSUMES the payload (that is the
        // optimization — see its doc comment). This test deliberately feeds the same payload
        // twice to prove the gen_ai buffer is consume-once, so it needs two copies; the clone is
        // the test paying for what it is testing, not a cost the production path carries.
        let spans = state.process_traces(traces.clone(), "/v1/traces");
        assert_eq!(spans.len(), 1);
        let attrs = spans[0]["attributes"].as_array().unwrap();
        let injected = attrs.iter().find(|a| a["key"] == "gen_ai.output.messages").expect("injected");
        assert_eq!(
            injected["value"]["stringValue"].as_str().unwrap(),
            r#"[{"role":"assistant","content":[{"type":"text","text":"hello é"}]}]"#
        );
        // Consumed: a second span with the same key gets nothing.
        let spans2 = state.process_traces(traces, "/v1/traces");
        assert!(spans2[0]["attributes"].as_array().unwrap().iter().all(|a| a["key"] != "gen_ai.output.messages"));
    }

    #[test]
    fn codex_prompt_cycles_get_distinct_per_prompt_sessions() {
        let mut n = CodexSessionNormalizer::default();
        let s1 = n.resolve_session_id("conv-1", "t1", "", "codex.user_prompt").unwrap();
        assert_eq!(s1, "codex:conv-1:prompt-1");
        let child = n.resolve_session_id("conv-1", "t1", "", "codex.turn_complete").unwrap();
        assert_eq!(child, s1, "same trace folds into the prompt cycle");
        let s2 = n.resolve_session_id("conv-1", "t2", "", "codex.user_prompt").unwrap();
        assert_eq!(s2, "codex:conv-1:prompt-2", "a second prompt opens a new cycle");
        assert_eq!(n.session_by_otel_trace_id("t1"), Some(s1.as_str()));
    }
}

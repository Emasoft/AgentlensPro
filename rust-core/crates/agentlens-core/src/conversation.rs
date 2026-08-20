//! Port of `src/conversation.ts` (TRDD-DMWOBWFH P4w.2c, freeze row 34) — the NARRATIVE per-turn
//! reconstruction of a Claude Code session.
//!
//! Unlike `context_history` (which MERGES same-kind blocks per turn behind a `kind:label` map for
//! analytics), this preserves the VERBATIM ordered sequence: user prompt → thinking → text → tool
//! calls with their paired outputs. That ordering IS the product — it is what makes a session
//! readable as a conversation — so nothing here may be reordered or coalesced for tidiness.
//!
//! It also harvests signals nothing else parses: system/turn_duration, system/compact_boundary
//! (pre/post/dropped tokens), ai-title, agent-name, entrypoint, and the usage.cache_creation
//! ephemeral 5m/1h TTL-tier split.

use indexmap::IndexMap;
use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};
use std::io::BufRead;

use agentlens_logscan::discovery::Env;

use crate::context_composition::{classify_attachment, find_session_file};
use crate::summarize::helpers::{js_slice, js_string, num, truthy};
use crate::token_estimator::count_tokens;

const MAX_LINES: u64 = 3_000_000;
const MAX_TURNS: usize = 5000;
const BLOCK_TEXT_CAP: usize = 20_000;

/// Same env var as contextHistory — deliberately ONE budget knob for both on-demand reconstructions.
fn text_budget_bytes(env: &Env) -> u64 {
    let mb = env
        .vars
        .get("AGENTLENS_HISTORY_TEXT_BUDGET_MB")
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n != 0.0)
        .unwrap_or(24.0);
    (mb.max(1.0) * 1024.0 * 1024.0) as u64
}

fn zero_usage() -> Value {
    let mut m = Map::new();
    for k in ["input", "output", "cacheRead", "cacheCreate", "tier5m", "tier1h"] {
        m.insert(k.into(), num(0.0));
    }
    Value::Object(m)
}

/// Resume-duplicate detection only. See `context_history::hash_text` for why unsigned wrapping
/// arithmetic reproduces the JS 32-bit modular result exactly.
fn hash_text(s: &str) -> String {
    let mut h: u32 = 0x811c_9dc5;
    for u in s.encode_utf16() {
        h ^= u as u32;
        let sum = h
            .wrapping_shl(1)
            .wrapping_add(h.wrapping_shl(4))
            .wrapping_add(h.wrapping_shl(7))
            .wrapping_add(h.wrapping_shl(8))
            .wrapping_add(h.wrapping_shl(24));
        h = h.wrapping_add(sum);
    }
    format!("{h:x}")
}

fn full_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => {
            let mut parts: Vec<&str> = Vec::new();
            for b in items {
                if b.get("type").and_then(Value::as_str) == Some("text") {
                    if let Some(t) = b.get("text").and_then(Value::as_str) {
                        parts.push(t);
                        continue;
                    }
                }
                if let Some(c) = b.get("content").and_then(Value::as_str) {
                    parts.push(c);
                }
            }
            parts.join("\n")
        }
        _ => String::new(),
    }
}

/// `Number(v)` where the caller then asks `Number.isFinite(...)` — so an input that coerces to NaN
/// must be DISTINGUISHABLE, not silently 0. That distinction is the whole point at the
/// compact_boundary call sites: an ABSENT preTokens is omitted from the wire, while an explicit
/// `null` coerces to 0 and IS emitted.
fn js_number_finite(v: Option<&Value>) -> Option<f64> {
    match v {
        None => None,
        Some(Value::Null) => Some(0.0),
        Some(Value::Bool(b)) => Some(if *b { 1.0 } else { 0.0 }),
        Some(Value::Number(n)) => n.as_f64().filter(|f| f.is_finite()),
        Some(Value::String(s)) => {
            let t = s.trim();
            if t.is_empty() {
                Some(0.0)
            } else {
                t.parse::<f64>().ok().filter(|f| f.is_finite())
            }
        }
        _ => None,
    }
}

/// `Number(v) || 0` — the NaN-tolerant variant used for usage sums.
fn js_number_or_0(v: Option<&Value>) -> f64 {
    js_number_finite(v).filter(|f| *f != 0.0).unwrap_or(0.0)
}

struct Turn {
    number: f64,
    role: &'static str,
    /// Extra fields spread AFTER `blocks` in the TS literal, in this order.
    init: Vec<(String, Value)>,
    blocks: Vec<Value>,
    keys: HashSet<String>,
    duration_ms: Option<f64>,
    /// A turn built past MAX_TURNS is RETURNED but never pushed — its blocks are unreachable, yet
    /// its toolUse blocks still increment totals.toolCalls (appendBlock does not know the
    /// difference). Mirrored rather than "fixed": the count is what the TS reports.
    kept: bool,
}

impl Turn {
    fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("turn".into(), num(self.number));
        m.insert("role".into(), Value::String(self.role.to_owned()));
        m.insert("blocks".into(), Value::Array(self.blocks.clone()));
        for (k, v) in &self.init {
            m.insert(k.clone(), v.clone());
        }
        // Assigned after construction, so it lands LAST in key order.
        if let Some(d) = self.duration_ms {
            m.insert("durationMs".into(), num(d));
        }
        Value::Object(m)
    }
}

/// Build the Conversation from an explicit transcript file. Pure w.r.t. session resolution, so the
/// oracle drives THIS directly. Returns None only when the file cannot be read.
pub fn build_conversation_from_file(env: &Env, file_path: &str, session_id: &str) -> Option<Value> {
    let f = std::fs::File::open(file_path).ok()?;
    let budget = text_budget_bytes(env);

    let mut all_turns: Vec<Turn> = Vec::new();
    let mut kept_count: usize = 0;
    let mut turn_by_message_id: HashMap<String, usize> = HashMap::new();
    let mut tool_use_id_to_turn: HashMap<String, (usize, String)> = HashMap::new();
    let mut seen_user_uuids: HashSet<String> = HashSet::new();
    let mut compactions: Vec<Value> = Vec::new();
    let mut other_records: IndexMap<String, f64> = IndexMap::new();
    let mut pending_attachments: Vec<Value> = Vec::new();

    let mut title: Option<String> = None;
    let mut agent_name: Option<String> = None;
    let mut entrypoint: Option<String> = None;
    let mut cwd: Option<String> = None;
    let mut model: Option<String> = None;
    let mut truncated = false;
    let mut lines: u64 = 0;
    let mut text_bytes_stored: u64 = 0;
    let (mut total_tool_calls, mut total_duration_ms) = (0.0f64, 0.0f64);
    let mut total_usage = [0.0f64; 6]; // input, output, cacheRead, cacheCreate, tier5m, tier1h

    // NOTE this charge CAPS the candidate itself (contextHistory's does not) — the cap is applied
    // before the budget is charged, so a huge block spends only its capped size.
    macro_rules! charge_text {
        ($candidate:expr) => {{
            let c: &str = $candidate;
            if c.is_empty() {
                String::new()
            } else if text_bytes_stored >= budget {
                truncated = true;
                String::new()
            } else {
                let capped = js_slice(c, BLOCK_TEXT_CAP).to_owned();
                text_bytes_stored += capped.len() as u64;
                capped
            }
        }};
    }

    // `{ kind, ...(rawText ? {text} : {}), ...(tokens ? {tokens} : {}), ...extra }` — note `tokens`
    // is TRUTHY-gated, so a non-empty text that tokenizes to 0 (e.g. a short run of spaces) stores
    // its text and OMITS the tokens key.
    macro_rules! make_block {
        ($kind:expr, $raw:expr, $extra:expr) => {{
            let raw: &str = $raw;
            let extra: Vec<(String, Value)> = $extra;
            let mut m = Map::new();
            m.insert("kind".into(), Value::String(($kind as &str).to_owned()));
            let tokens = if raw.is_empty() { 0.0 } else { count_tokens(raw) };
            if !raw.is_empty() {
                m.insert("text".into(), Value::String(charge_text!(raw)));
            }
            if tokens != 0.0 {
                m.insert("tokens".into(), num(tokens));
            }
            for (k, v) in extra {
                m.insert(k, v);
            }
            Value::Object(m)
        }};
    }

    macro_rules! new_turn {
        ($role:expr, $init:expr) => {{
            let idx = all_turns.len();
            let number = (kept_count + 1) as f64;
            let over = kept_count >= MAX_TURNS;
            if over {
                truncated = true;
            }
            let mut t = Turn {
                number,
                role: $role,
                init: $init,
                blocks: Vec::new(),
                keys: HashSet::new(),
                duration_ms: None,
                kept: !over,
            };
            if !over {
                // Injected attachments PRECEDE the turn's own content — that is their real
                // transcript position, and it is why they are queued rather than emitted inline.
                if !pending_attachments.is_empty() {
                    t.blocks.append(&mut pending_attachments);
                }
                kept_count += 1;
            }
            all_turns.push(t);
            idx
        }};
    }

    macro_rules! append_block {
        ($turn_idx:expr, $block:expr) => {{
            let idx: usize = $turn_idx;
            let block: Value = $block;
            let key = format!(
                "{}|{}|{}",
                block.get("kind").and_then(Value::as_str).unwrap_or(""),
                block.get("toolUseId").and_then(Value::as_str).unwrap_or(""),
                hash_text(block.get("text").and_then(Value::as_str).unwrap_or(""))
            );
            let t = &mut all_turns[idx];
            // A session RESUME re-appends byte-identical records; appending their blocks again
            // would duplicate the narrative. A genuinely new streaming chunk (same message.id,
            // different content) hashes differently and IS appended.
            if t.keys.insert(key) {
                if block.get("kind").and_then(Value::as_str) == Some("toolUse") {
                    total_tool_calls += 1.0;
                }
                t.blocks.push(block);
            }
        }};
    }

    let mut reader = std::io::BufReader::new(f);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {}
        }
        lines += 1;
        if lines > MAX_LINES {
            truncated = true;
            break;
        }
        let line = String::from_utf8_lossy(&buf);
        let line = line.trim_end_matches('\n').trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let Ok(e) = serde_json::from_str::<Value>(line) else { continue };
        let ty = e.get("type").and_then(Value::as_str);
        let ts = e.get("timestamp").and_then(Value::as_str).map(str::to_owned);

        // entrypoint/cwd ride as top-level fields on MANY record types — harvest them
        // record-agnostically, FIRST wins. Harvesting only from assistant rows missed sessions
        // whose first carrier is a user row.
        if entrypoint.is_none() {
            if let Some(v) = e.get("entrypoint").and_then(Value::as_str) {
                entrypoint = Some(v.to_owned());
            }
        }
        if cwd.is_none() {
            if let Some(v) = e.get("cwd").and_then(Value::as_str) {
                cwd = Some(v.to_owned());
            }
        }

        match ty {
            Some("assistant") => {
                let Some(msg) = e.get("message").filter(|m| m.is_object() || m.is_array()) else { continue };
                let row_model = msg.get("model").and_then(Value::as_str).map(str::to_owned);
                let usage = msg.get("usage").filter(|u| truthy(u));
                // A `<synthetic>` row with ZERO usage is title-gen noise; one WITH usage is real
                // and must still be counted.
                if row_model.as_deref() == Some("<synthetic>") {
                    let sum: f64 = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]
                        .iter()
                        .map(|k| js_number_or_0(usage.and_then(|u| u.get(*k))))
                        .sum();
                    if sum == 0.0 {
                        continue;
                    }
                }
                if model.is_none() {
                    if let Some(rm) = row_model.as_deref().filter(|m| !m.is_empty() && *m != "<synthetic>") {
                        model = Some(rm.to_owned());
                    }
                }
                let id = msg
                    .get("id")
                    .and_then(Value::as_str)
                    .or_else(|| e.get("requestId").and_then(Value::as_str))
                    .map(str::to_owned);
                let mut turn_idx = id.as_ref().and_then(|i| turn_by_message_id.get(i).copied());
                if turn_idx.is_none() {
                    // Usage is credited ONCE per message.id — every streaming chunk repeats the
                    // same numbers, so crediting per chunk would multiply the session's cost.
                    let u = usage.map(|u| {
                        let cc = u.get("cache_creation");
                        let vals = [
                            js_number_or_0(u.get("input_tokens")),
                            js_number_or_0(u.get("output_tokens")),
                            js_number_or_0(u.get("cache_read_input_tokens")),
                            js_number_or_0(u.get("cache_creation_input_tokens")),
                            js_number_or_0(cc.and_then(|c| c.get("ephemeral_5m_input_tokens"))),
                            js_number_or_0(cc.and_then(|c| c.get("ephemeral_1h_input_tokens"))),
                        ];
                        for (i, v) in vals.iter().enumerate() {
                            total_usage[i] += v;
                        }
                        let mut m = Map::new();
                        for (k, v) in ["input", "output", "cacheRead", "cacheCreate", "tier5m", "tier1h"].iter().zip(vals) {
                            m.insert((*k).into(), num(v));
                        }
                        Value::Object(m)
                    });
                    let mut init: Vec<(String, Value)> = Vec::new();
                    if let Some(i) = &id {
                        init.push(("messageId".into(), Value::String(i.clone())));
                    }
                    if let Some(rm) = row_model.as_deref().filter(|m| !m.is_empty() && *m != "<synthetic>") {
                        init.push(("model".into(), Value::String(rm.to_owned())));
                    }
                    if let Some(t) = &ts {
                        init.push(("ts".into(), Value::String(t.clone())));
                    }
                    if e.get("isSidechain") == Some(&Value::Bool(true)) {
                        init.push(("sidechain".into(), Value::Bool(true)));
                    }
                    if let Some(u) = u {
                        init.push(("usage".into(), u));
                    }
                    let idx = new_turn!("assistant", init);
                    if let Some(i) = &id {
                        turn_by_message_id.insert(i.clone(), idx);
                    }
                    turn_idx = Some(idx);
                }
                let turn_idx = turn_idx.expect("just assigned");
                let Some(content) = msg.get("content").and_then(Value::as_array).cloned() else { continue };
                for block in &content {
                    match block.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if let Some(t) = block.get("text").and_then(Value::as_str) {
                                append_block!(turn_idx, make_block!("assistantText", t, Vec::new()));
                            }
                        }
                        Some("thinking") => {
                            if let Some(t) = block.get("thinking").and_then(Value::as_str) {
                                append_block!(turn_idx, make_block!("thinking", t, Vec::new()));
                            }
                        }
                        Some("tool_use") => {
                            let Some(name) = block.get("name").filter(|v| truthy(v)).map(js_string) else { continue };
                            let bid = block.get("id").and_then(Value::as_str).map(str::to_owned);
                            let input = match block.get("input") {
                                None | Some(Value::Null) => Value::Object(Map::new()),
                                Some(v) => v.clone(),
                            };
                            // Bash reads best as the bare command; every other tool as its input.
                            let text = if name == "Bash" {
                                input
                                    .get("command")
                                    .and_then(Value::as_str)
                                    .map(str::to_owned)
                                    .unwrap_or_else(|| serde_json::to_string(&input).unwrap_or_default())
                            } else {
                                serde_json::to_string(&input).unwrap_or_default()
                            };
                            let mut extra: Vec<(String, Value)> = vec![("toolName".into(), Value::String(name.clone()))];
                            if let Some(b) = &bid {
                                extra.push(("toolUseId".into(), Value::String(b.clone())));
                            }
                            append_block!(turn_idx, make_block!("toolUse", &text, extra));
                            if let Some(b) = bid {
                                tool_use_id_to_turn.insert(b, (turn_idx, name));
                            }
                        }
                        _ => {}
                    }
                }
            }

            Some("user") => {
                if let Some(uuid) = e.get("uuid").and_then(Value::as_str) {
                    // A resume rewrite re-emits the same uuid — already rendered.
                    if !seen_user_uuids.insert(uuid.to_owned()) {
                        continue;
                    }
                }
                let msg = e.get("message");
                let is_compact = e.get("isCompactSummary") == Some(&Value::Bool(true));
                if e.get("isMeta") == Some(&Value::Bool(true)) || is_compact {
                    // Harness-injected metas and compact summaries are NOT things the human typed —
                    // they render as dimmed system notes, never as user prompts.
                    let mut text = full_text(msg.and_then(|m| m.get("content")));
                    if text.is_empty() {
                        text = e.get("summary").and_then(Value::as_str).unwrap_or("").to_owned();
                    }
                    if !text.is_empty() {
                        let init = ts.clone().map_or(Vec::new(), |t| vec![("ts".to_owned(), Value::String(t))]);
                        let idx = new_turn!("system", init);
                        let mut meta = Map::new();
                        meta.insert("subtype".into(), Value::String(if is_compact { "compact-summary".into() } else { "meta".to_string() }));
                        append_block!(idx, make_block!("systemNote", &text, vec![("meta".to_owned(), Value::Object(meta))]));
                    }
                    continue;
                }
                let content = msg.and_then(|m| m.get("content"));
                if let Some(s) = content.and_then(Value::as_str) {
                    let init = ts.clone().map_or(Vec::new(), |t| vec![("ts".to_owned(), Value::String(t))]);
                    let idx = new_turn!("user", init);
                    append_block!(idx, make_block!("userText", s, Vec::new()));
                    continue;
                }
                let Some(arr) = content.and_then(Value::as_array).cloned() else { continue };
                // A user record can MIX tool_results (which belong to the ISSUING assistant turn)
                // with real user text (a genuinely new user turn). Pair results first and open the
                // user turn LAZILY, so a pure tool-result record never fabricates an empty turn.
                let mut user_turn: Option<usize> = None;
                for block in &arr {
                    match block.get("type").and_then(Value::as_str) {
                        Some("tool_result") => {
                            let tid = block.get("tool_use_id").and_then(Value::as_str).map(str::to_owned);
                            let issued = tid.as_ref().and_then(|t| tool_use_id_to_turn.get(t).cloned());
                            let text = full_text(block.get("content"));
                            let mut extra: Vec<(String, Value)> = Vec::new();
                            if let Some((_, name)) = &issued {
                                extra.push(("toolName".into(), Value::String(name.clone())));
                            }
                            if let Some(t) = &tid {
                                extra.push(("toolUseId".into(), Value::String(t.clone())));
                            }
                            let b = make_block!("toolResult", &text, extra);
                            match issued {
                                Some((idx, _)) => append_block!(idx, b),
                                // No issuing turn on record (parse began mid-file, or a foreign
                                // result): keep it VISIBLE on a user turn rather than dropping it.
                                None => {
                                    let idx = *user_turn.get_or_insert_with(|| {
                                        let init = ts.clone().map_or(Vec::new(), |t| vec![("ts".to_owned(), Value::String(t))]);
                                        new_turn!("user", init)
                                    });
                                    append_block!(idx, b);
                                }
                            }
                        }
                        Some("text") => {
                            if let Some(t) = block.get("text").and_then(Value::as_str) {
                                let idx = *user_turn.get_or_insert_with(|| {
                                    let init = ts.clone().map_or(Vec::new(), |t| vec![("ts".to_owned(), Value::String(t))]);
                                    new_turn!("user", init)
                                });
                                append_block!(idx, make_block!("userText", t, Vec::new()));
                            }
                        }
                        Some("image") => {
                            let idx = *user_turn.get_or_insert_with(|| {
                                let init = ts.clone().map_or(Vec::new(), |t| vec![("ts".to_owned(), Value::String(t))]);
                                new_turn!("user", init)
                            });
                            let mut meta = Map::new();
                            meta.insert("note".into(), Value::String("image content (not stored)".into()));
                            append_block!(idx, make_block!("image", "", vec![("meta".to_owned(), Value::Object(meta))]));
                        }
                        _ => {}
                    }
                }
            }

            Some("system") => {
                let subtype = match e.get("subtype") {
                    None | Some(Value::Null) => "unknown".to_owned(),
                    Some(v) => js_string(v),
                };
                if subtype == "turn_duration" {
                    if let Some(ms) = js_number_finite(e.get("durationMs")).filter(|m| *m > 0.0) {
                        // Closes the most recent KEPT assistant turn.
                        if let Some(t) = all_turns.iter_mut().rev().find(|t| t.kept && t.role == "assistant") {
                            t.duration_ms = Some(ms);
                            total_duration_ms += ms;
                        }
                    }
                    continue;
                }
                if subtype == "compact_boundary" {
                    let m = e.get("compactMetadata");
                    let mut c = Map::new();
                    c.insert("afterTurn".into(), num(kept_count as f64));
                    if let Some(t) = m.and_then(|m| m.get("trigger")).and_then(Value::as_str) {
                        c.insert("trigger".into(), Value::String(t.to_owned()));
                    }
                    for (src, dst) in [("preTokens", "preTokens"), ("postTokens", "postTokens"), ("cumulativeDroppedTokens", "droppedTokens")] {
                        if let Some(v) = js_number_finite(m.and_then(|m| m.get(src))) {
                            c.insert(dst.into(), num(v));
                        }
                    }
                    compactions.push(Value::Object(c));
                    continue;
                }
                // Every other system subtype is COUNTED, never silently dropped (sink philosophy).
                *other_records.entry(format!("system/{subtype}")).or_insert(0.0) += 1.0;
            }

            Some("attachment") => {
                let c = e.get("attachment").and_then(classify_attachment);
                match c.filter(|c| c.bytes > 0) {
                    Some(c) => {
                        let mut meta = Map::new();
                        meta.insert("label".into(), Value::String(c.label.clone()));
                        meta.insert("attachmentKind".into(), Value::String(c.kind.to_owned()));
                        meta.insert("bytes".into(), num(c.bytes as f64));
                        let text = c.text.clone();
                        pending_attachments.push(make_block!("attachment", &text, vec![("meta".to_owned(), Value::Object(meta))]));
                    }
                    None => *other_records.entry("attachment".to_owned()).or_insert(0.0) += 1.0,
                }
            }

            Some("ai-title") => {
                // LATEST wins — a session's title is re-generated as it evolves.
                if let Some(t) = e.get("aiTitle").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    title = Some(t.to_owned());
                }
            }
            Some("agent-name") => {
                if let Some(a) = e.get("agentName").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    agent_name = Some(a.to_owned());
                }
            }

            // Unknown / unrendered record types: COUNTED so nothing ever disappears silently.
            other => {
                let key = other.filter(|s| !s.is_empty()).unwrap_or("(untyped)").to_owned();
                *other_records.entry(key).or_insert(0.0) += 1.0;
            }
        }
    }

    let turns: Vec<Value> = all_turns.iter().filter(|t| t.kept).map(Turn::to_value).collect();
    let mut totals = Map::new();
    totals.insert("turns".into(), num(turns.len() as f64));
    totals.insert("toolCalls".into(), num(total_tool_calls));
    totals.insert("durationMs".into(), num(total_duration_ms));
    let mut um = Map::new();
    for (k, v) in ["input", "output", "cacheRead", "cacheCreate", "tier5m", "tier1h"].iter().zip(total_usage) {
        um.insert((*k).into(), num(v));
    }
    totals.insert("usage".into(), Value::Object(um));

    let mut m = Map::new();
    m.insert("sessionId".into(), Value::String(session_id.to_owned()));
    for (k, v) in [("title", &title), ("agentName", &agent_name), ("entrypoint", &entrypoint), ("cwd", &cwd), ("model", &model)] {
        if let Some(s) = v.as_deref().filter(|s| !s.is_empty()) {
            m.insert(k.into(), Value::String(s.to_owned()));
        }
    }
    m.insert("turns".into(), Value::Array(turns));
    m.insert("compactions".into(), Value::Array(compactions));
    let mut orec = Map::new();
    for (k, v) in other_records {
        orec.insert(k, num(v));
    }
    m.insert("otherRecords".into(), Value::Object(orec));
    m.insert("totals".into(), Value::Object(totals));
    m.insert("truncated".into(), Value::Bool(truncated));
    Some(Value::Object(m))
}

/// Resolve a sessionId to its transcript and build the Conversation. Mirrors the no-own-log
/// fallback of composition/history exactly — see `build_context_composition` for why the
/// "neither log but a known parent" case returns an HONEST EMPTY rather than null.
pub fn build_conversation(env: &Env, session_id: &str, parent_session_id: Option<&str>) -> Option<Value> {
    let mut file = find_session_file(env, session_id);
    let mut reconstructed_from: Option<String> = None;
    if file.is_none() {
        if let Some(parent) = parent_session_id {
            if let Some(pf) = find_session_file(env, parent) {
                file = Some(pf);
                reconstructed_from = Some(parent.to_owned());
            }
        }
    }
    let Some(file) = file else {
        if let Some(parent) = parent_session_id {
            let mut m = Map::new();
            m.insert("sessionId".into(), Value::String(session_id.to_owned()));
            m.insert("turns".into(), Value::Array(Vec::new()));
            m.insert("compactions".into(), Value::Array(Vec::new()));
            m.insert("otherRecords".into(), Value::Object(Map::new()));
            let mut totals = Map::new();
            totals.insert("turns".into(), num(0.0));
            totals.insert("toolCalls".into(), num(0.0));
            totals.insert("durationMs".into(), num(0.0));
            totals.insert("usage".into(), zero_usage());
            m.insert("totals".into(), Value::Object(totals));
            m.insert("truncated".into(), Value::Bool(false));
            m.insert("reconstructedFrom".into(), Value::String(parent.to_owned()));
            return Some(Value::Object(m));
        }
        return None;
    };
    let mut conv = build_conversation_from_file(env, &file.to_string_lossy(), session_id)?;
    if let Some(r) = reconstructed_from {
        // Assigned after construction, so it lands LAST — same position as the empty-fallback
        // literal above, which is why both paths agree on key order.
        if let Some(o) = conv.as_object_mut() {
            o.insert("reconstructedFrom".into(), Value::String(r));
        }
    }
    Some(conv)
}

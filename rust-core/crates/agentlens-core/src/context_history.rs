//! Port of `src/contextHistory.ts` (TRDD-DMWOBWFH P4w.2b, freeze row 33) — reconstructs a Claude
//! session's per-STEP context history from its raw `.jsonl`, streamed, with each step's blocks
//! calibrated against that turn's exact usage and diffed against the previous step.
//!
//! Session-file resolution AND attachment classification come from `context_composition` — the ONE
//! resolver/classifier (TRDD-B22NYTOY). This module previously carried byte-identical private
//! copies in the TS, which is exactly how drift starts. Never re-implement them here.

use indexmap::{IndexMap, IndexSet};
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::BufRead;

use agentlens_logscan::discovery::Env;

use crate::context_composition::{classify_attachment, find_session_file};
use crate::summarize::helpers::{js_slice, js_slice_from, num, utf16_len};
use crate::token_estimator::{calibrate_tokens, count_tokens};

const MAX_LINES: u64 = 3_000_000;
const MAX_STEPS: usize = 2000;
const MAX_BLOCKS_PER_STEP: usize = 200;
const BLOCK_TEXT_CAP: usize = 20_000;

/// TRDD-PJC8N1HO (OOM P0): a WHOLE-RECONSTRUCTION text budget. The per-block cap alone is not
/// enough — MAX_STEPS × MAX_BLOCKS_PER_STEP × BLOCK_TEXT_CAP is an ~8 GB upper bound, and a
/// pathological session materialized enough drill-text to exhaust the heap and abort the whole
/// collector. Once spent, blocks keep their ACCURATE token/byte metadata but ship empty text.
///
/// `Math.max(1, Number(env) || 24) * 1MB` — zero is falsy, so it too falls back to 24.
fn text_budget_bytes(env: &Env) -> u64 {
    let mb = env
        .vars
        .get("AGENTLENS_HISTORY_TEXT_BUDGET_MB")
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n != 0.0)
        .unwrap_or(24.0);
    (mb.max(1.0) * 1024.0 * 1024.0) as u64
}


/// Map classifyAttachment's kind onto a ContextBlockKind.
fn attachment_kind(kind: &str) -> &'static str {
    match kind {
        "hook" => "hook",
        "skill" => "skillPrompt",
        "toolCatalog" => "toolCatalog",
        "agentCatalog" => "agentCatalog",
        "mcp" => "mcp",
        "file" => "file",
        "reminder" => "reminder",
        _ => "other",
    }
}

/// The FULL text of a message/tool_result content value. An array element contributes its `text`
/// when it is a text block, ELSE its string `content` — the `else if` is deliberate, so a text
/// block never contributes twice.
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

/// A tiny FNV-1a-flavoured hash used ONLY to detect that a block's text CHANGED between two steps.
/// Collisions are irrelevant — the diff is an advisory overlay, not a correctness gate.
///
/// The JS is 32-bit-modular: each `h << n` is a SIGNED int32, the five terms sum in float64 (below
/// 2^34, so exact), and `>>> 0` takes the result mod 2^32. Unsigned wrapping arithmetic agrees mod
/// 2^32, so `wrapping_*` on u32 reproduces it EXACTLY — and `charCodeAt` means UTF-16 code units,
/// not chars, so an astral character contributes TWO iterations.
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

/// A scheduled-task fire: the harness prepends the task name in brackets (`"[name]\n…"`). Kept in
/// its own function rather than a `OnceLock` inside the stream loop — it compiles once either way,
/// but clippy rightly flags a `Regex::new` written lexically inside a loop body.
fn scheduled_fire_re() -> &'static regex::Regex {
    static FIRE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    FIRE.get_or_init(|| regex::Regex::new(r"^\[([^\]\n]{1,80})\]\n").expect("valid regex"))
}

struct BlockAcc {
    kind: &'static str,
    label: String,
    text: String,
    bytes: u64,
    tokens_raw: f64,
    role: &'static str,
    tool_name: Option<String>,
}

#[derive(Default)]
struct StepAcc {
    timestamp: Option<String>,
    model: Option<String>,
    usage: Option<[f64; 4]>, // input, output, cacheRead, cacheCreate
    blocks: IndexMap<String, BlockAcc>,
}

/// Reconstruct the per-STEP context history of a Claude session from its raw `.jsonl`.
///
/// NO-OWN-LOG FALLBACK mirrors `build_context_composition` exactly: a fork with no own log is
/// reconstructed from its PARENT's (tagged `reconstructedFrom`); with neither but a known parent an
/// HONEST EMPTY history is returned, still tagged, so the UI shows a terminal parent-link message
/// instead of spinning. Only the pure OTEL/no-parent case is None.
pub fn build_context_history(env: &Env, session_id: &str, parent_session_id: Option<&str>) -> Option<Value> {
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
            m.insert("steps".into(), Value::Array(Vec::new()));
            m.insert("estimated".into(), Value::Bool(true));
            m.insert("truncated".into(), Value::Bool(false));
            m.insert("reconstructedFrom".into(), Value::String(parent.to_owned()));
            return Some(Value::Object(m));
        }
        return None;
    };

    let budget = text_budget_bytes(env);
    let mut steps: BTreeMap<i64, StepAcc> = BTreeMap::new();
    let mut seen_message_ids: HashSet<String> = HashSet::new();
    let mut tool_use_id_to_name: HashMap<String, String> = HashMap::new();
    let mut task_tool_use_ids: HashSet<String> = HashSet::new();
    let mut assistant_turns: i64 = 0;
    let mut lines: u64 = 0;
    let mut truncated = false;
    let mut text_bytes_stored: u64 = 0;

    // Charge a candidate drill-text against the whole-reconstruction budget; returns what to store
    // ('' once spent). Token/byte metadata is charged separately and stays ACCURATE, so a
    // budget-truncated block still reports its true weight — it just cannot be drilled.
    macro_rules! charge_text {
        ($candidate:expr) => {{
            let c: String = $candidate;
            if c.is_empty() {
                String::new()
            } else if text_bytes_stored >= budget {
                truncated = true;
                String::new()
            } else {
                text_bytes_stored += c.len() as u64;
                c
            }
        }};
    }

    macro_rules! add_block {
        ($turn:expr, $kind:expr, $label:expr, $raw:expr, $role:expr, $tool:expr) => {{
            let turn: i64 = $turn;
            let kind: &'static str = $kind;
            let label: String = $label;
            let raw: &str = $raw;
            let id = format!("{kind}:{label}");
            let bytes = raw.len() as u64;
            // Tokenize the FULL rawText (not the display-capped text) so a >CAP block's estimate
            // reflects all its content.
            let tokens_raw = count_tokens(raw);
            let step = steps.entry(turn).or_default();
            match step.blocks.get_mut(&id) {
                Some(existing) => {
                    existing.bytes += bytes;
                    existing.tokens_raw += tokens_raw;
                    if utf16_len(&existing.text) < BLOCK_TEXT_CAP && !raw.is_empty() {
                        let joined = if existing.text.is_empty() {
                            raw.to_owned()
                        } else {
                            format!("{}\n{}", existing.text, raw)
                        };
                        let merged = js_slice(&joined, BLOCK_TEXT_CAP).to_owned();
                        // Only the APPENDED delta is charged — existing.text was charged when first
                        // stored, and charging it again would spend the budget quadratically.
                        let delta = js_slice_from(&merged, utf16_len(&existing.text)).to_owned();
                        existing.text.push_str(&charge_text!(delta));
                    }
                }
                None => {
                    let text = charge_text!(js_slice(raw, BLOCK_TEXT_CAP).to_owned());
                    step.blocks.insert(
                        id,
                        BlockAcc { kind, label, text, bytes, tokens_raw, role: $role, tool_name: $tool },
                    );
                }
            }
        }};
    }

    let f = std::fs::File::open(&file).ok()?;
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
        let ty = e.get("type").and_then(Value::as_str).unwrap_or("");
        let ts = e.get("timestamp").and_then(Value::as_str).map(str::to_owned);

        if ty == "assistant" {
            let msg = e.get("message");
            let id = msg.and_then(|m| m.get("id")).and_then(Value::as_str).map(str::to_owned);
            let is_new = id.as_ref().is_none_or(|i| !seen_message_ids.contains(i));
            if is_new {
                assistant_turns += 1;
                if let Some(i) = &id {
                    seen_message_ids.insert(i.clone());
                }
            }
            let turn = assistant_turns;
            {
                let step = steps.entry(turn).or_default();
                if is_new {
                    if let Some(t) = ts {
                        if step.timestamp.is_none() {
                            step.timestamp = Some(t);
                        }
                    }
                    // `<synthetic>` is the harness's placeholder for a row that never hit a model;
                    // recording it would attribute real cost to a model that does not exist.
                    let row_model = msg.and_then(|m| m.get("model")).and_then(Value::as_str);
                    if let Some(rm) = row_model.filter(|m| !m.is_empty() && *m != "<synthetic>") {
                        if step.model.is_none() {
                            step.model = Some(rm.to_owned());
                        }
                    }
                    if let Some(u) = msg.and_then(|m| m.get("usage")).filter(|u| u.is_object() || u.is_array()) {
                        if step.usage.is_none() {
                            let g = |k: &str| u.get(k).and_then(Value::as_f64).unwrap_or(0.0);
                            step.usage = Some([
                                g("input_tokens"),
                                g("output_tokens"),
                                g("cache_read_input_tokens"),
                                g("cache_creation_input_tokens"),
                            ]);
                        }
                    }
                }
            }
            let empty: Vec<Value> = Vec::new();
            let content = msg.and_then(|m| m.get("content")).and_then(Value::as_array).unwrap_or(&empty).clone();
            for block in &content {
                match block.get("type").and_then(Value::as_str) {
                    Some("text") => {
                        if let Some(t) = block.get("text").and_then(Value::as_str) {
                            add_block!(turn, "assistantMsg", "assistant".to_owned(), t, "output", None);
                        }
                    }
                    Some("thinking") => {
                        if let Some(t) = block.get("thinking").and_then(Value::as_str) {
                            add_block!(turn, "reasoning", "thinking".to_owned(), t, "output", None);
                        }
                    }
                    Some("tool_use") => {
                        // `block['name']` is TRUTHY-gated, so an empty or absent name skips entirely.
                        let Some(name) = block.get("name").filter(|v| crate::summarize::helpers::truthy(v)).map(crate::summarize::helpers::js_string) else {
                            continue;
                        };
                        if let Some(bid) = block.get("id").and_then(Value::as_str) {
                            tool_use_id_to_name.insert(bid.to_owned(), name.clone());
                            if name == "Task" || name == "Agent" || name == "Workflow" {
                                task_tool_use_ids.insert(bid.to_owned());
                            }
                        }
                        let input = match block.get("input") {
                            None | Some(Value::Null) => Value::Object(Map::new()),
                            Some(v) => v.clone(),
                        };
                        if name == "Bash" {
                            let cmd = input
                                .get("command")
                                .and_then(Value::as_str)
                                .map(str::to_owned)
                                .unwrap_or_else(|| serde_json::to_string(&input).unwrap_or_default());
                            add_block!(turn, "bashInput", "Bash".to_owned(), &cmd, "output", Some("Bash".to_owned()));
                        } else {
                            let text = serde_json::to_string(&input).unwrap_or_default();
                            add_block!(turn, "toolInput", name.clone(), &text, "output", Some(name.clone()));
                        }
                    }
                    _ => {}
                }
            }
            continue;
        }

        if ty == "user" {
            // Input-side content feeds the UPCOMING assistant turn, matching the composition
            // attribution and the timeline's user_input turn.
            let turn = assistant_turns + 1;
            let msg = e.get("message");

            if e.get("isCompactSummary") == Some(&Value::Bool(true)) {
                let summary = e
                    .get("summary")
                    .and_then(Value::as_str)
                    .map(str::to_owned)
                    .unwrap_or_else(|| full_text(msg.and_then(|m| m.get("content"))));
                // NOTE: only a NON-EMPTY summary continues. An empty one deliberately FALLS THROUGH
                // to the isMeta check below, exactly as the TS does.
                if !summary.is_empty() {
                    add_block!(turn, "postCompact", "compact summary".to_owned(), &summary, "input", None);
                    continue;
                }
            }

            if e.get("isMeta") == Some(&Value::Bool(true)) {
                let text = full_text(msg.and_then(|m| m.get("content")));
                if !text.is_empty() {
                    // isMeta records are NOT compaction summaries — they are harness-injected metas
                    // (the <local-command-caveat> accompanying every scheduled-task fire, command
                    // output, …). The old `isCompactSummary || isMeta` branch mislabeled 300+
                    // per-turn cron caveats as "compact summary", fabricating a ~268k-token
                    // postCompact aggregate that was really 314 separate ~855-token cron pings, and
                    // made every turn look like a compaction boundary to the residency model
                    // (TRDD-W0RRL2FZ). postCompact marks the eviction boundary; metas do not.
                    if let Some(c) = scheduled_fire_re().captures(&text) {
                        let label = format!("scheduled task: {}", &c[1]);
                        add_block!(turn, "cron", label, &text, "input", None);
                    } else if text.contains("<local-command-caveat>") {
                        add_block!(turn, "cron", "local-command caveat".to_owned(), &text, "input", None);
                    } else {
                        add_block!(turn, "harness", "meta".to_owned(), &text, "input", None);
                    }
                }
                continue;
            }

            let content = msg.and_then(|m| m.get("content"));
            if let Some(s) = content.and_then(Value::as_str) {
                let is_harness = s.contains("<system-reminder>");
                let (kind, label) = if is_harness { ("harness", "system-reminder") } else { ("userMsg", "user") };
                add_block!(turn, kind, label.to_owned(), s, "input", None);
            } else if let Some(arr) = content.and_then(Value::as_array) {
                for block in arr {
                    match block.get("type").and_then(Value::as_str) {
                        Some("text") => {
                            if let Some(txt) = block.get("text").and_then(Value::as_str) {
                                let is_harness = txt.contains("<system-reminder>");
                                let (kind, label) =
                                    if is_harness { ("harness", "system-reminder") } else { ("userMsg", "user") };
                                add_block!(turn, kind, label.to_owned(), txt, "input", None);
                            }
                        }
                        Some("tool_result") => {
                            let id = block.get("tool_use_id").and_then(Value::as_str);
                            let tool_name = id.and_then(|i| tool_use_id_to_name.get(i)).cloned();
                            let text = full_text(block.get("content"));
                            if id.is_some_and(|i| task_tool_use_ids.contains(i)) {
                                let label = tool_name.clone().unwrap_or_else(|| "subagent".to_owned());
                                add_block!(turn, "subagentOutput", label, &text, "input", tool_name.clone());
                            } else if tool_name.as_deref() == Some("Bash") {
                                add_block!(turn, "bashOutput", "Bash".to_owned(), &text, "input", Some("Bash".to_owned()));
                            } else {
                                let label = tool_name.clone().unwrap_or_else(|| "tool".to_owned());
                                add_block!(turn, "toolOutput", label, &text, "input", tool_name.clone());
                            }
                        }
                        Some("image") => {
                            add_block!(turn, "other", "image".to_owned(), "", "input", None);
                        }
                        _ => {}
                    }
                }
            }
            continue;
        }

        if ty == "attachment" {
            let Some(att) = e.get("attachment") else { continue };
            let Some(c) = classify_attachment(att) else { continue };
            if c.bytes == 0 {
                continue;
            }
            let turn = assistant_turns + 1;
            let text = c.text.clone();
            add_block!(turn, attachment_kind(c.kind), c.label.clone(), &text, "input", None);
            continue;
        }

        if ty == "summary" {
            if let Some(summary) = e.get("summary").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                let turn = assistant_turns + 1;
                let s = summary.to_owned();
                add_block!(turn, "postCompact", "compact summary".to_owned(), &s, "input", None);
            }
            continue;
        }
    }

    // Finalize: ordered by turn, capped, then each kept step diffed against the previous one.
    let mut out_steps: Vec<Value> = Vec::new();
    let mut prev: Option<IndexMap<String, String>> = None;
    for (turn, s) in steps.into_iter().take(MAX_STEPS) {
        let mut blocks = finalize_blocks(s.blocks);
        calibrate_step_blocks(&mut blocks, s.usage.as_ref());
        let mut cur_hashes: IndexMap<String, String> = IndexMap::new();
        for b in &blocks {
            cur_hashes.insert(
                b.get("id").and_then(Value::as_str).unwrap_or("").to_owned(),
                hash_text(b.get("text").and_then(Value::as_str).unwrap_or("")),
            );
        }
        let diff = diff_steps(&blocks, prev.as_ref(), &cur_hashes);
        let mut m = Map::new();
        m.insert("turn".into(), num(turn as f64));
        if let Some(t) = &s.timestamp {
            m.insert("timestamp".into(), Value::String(t.clone()));
        }
        if let Some(md) = &s.model {
            m.insert("model".into(), Value::String(md.clone()));
        }
        if let Some(u) = &s.usage {
            let mut um = Map::new();
            um.insert("input".into(), num(u[0]));
            um.insert("output".into(), num(u[1]));
            um.insert("cacheRead".into(), num(u[2]));
            um.insert("cacheCreate".into(), num(u[3]));
            m.insert("usage".into(), Value::Object(um));
        }
        m.insert("blocks".into(), Value::Array(blocks));
        m.insert("diff".into(), diff);
        out_steps.push(Value::Object(m));
        prev = Some(cur_hashes);
    }

    let mut m = Map::new();
    m.insert("sessionId".into(), Value::String(session_id.to_owned()));
    m.insert("steps".into(), Value::Array(out_steps));
    m.insert("estimated".into(), Value::Bool(true));
    m.insert("truncated".into(), Value::Bool(truncated));
    if let Some(r) = reconstructed_from {
        m.insert("reconstructedFrom".into(), Value::String(r));
    }
    Some(Value::Object(m))
}

/// A step's ordered block map → ContextBlock[]; everything past MAX_BLOCKS_PER_STEP folds into one
/// summary "other" block so the payload stays bounded. The fold keeps 199 and makes the 200th the
/// summary, so the array never exceeds the cap.
fn finalize_blocks(map: IndexMap<String, BlockAcc>) -> Vec<Value> {
    let to_block = |id: String, a: BlockAcc| -> Value {
        let mut m = Map::new();
        m.insert("id".into(), Value::String(id));
        m.insert("kind".into(), Value::String(a.kind.to_owned()));
        m.insert("label".into(), Value::String(a.label));
        m.insert("tokens".into(), num(a.tokens_raw));
        m.insert("tokenSource".into(), Value::String("estimated".into()));
        m.insert("bytes".into(), num(a.bytes as f64));
        m.insert("text".into(), Value::String(a.text));
        m.insert("role".into(), Value::String(a.role.to_owned()));
        if let Some(tn) = a.tool_name {
            m.insert("toolName".into(), Value::String(tn));
        }
        Value::Object(m)
    };
    let mut entries: Vec<(String, BlockAcc)> = map.into_iter().collect();
    if entries.len() <= MAX_BLOCKS_PER_STEP {
        return entries.into_iter().map(|(id, a)| to_block(id, a)).collect();
    }
    let rest = entries.split_off(MAX_BLOCKS_PER_STEP - 1);
    let mut kept: Vec<Value> = entries.into_iter().map(|(id, a)| to_block(id, a)).collect();
    let bytes: u64 = rest.iter().map(|(_, a)| a.bytes).sum();
    let tokens: f64 = rest.iter().map(|(_, a)| a.tokens_raw).sum();
    let label = format!("+{} more blocks", rest.len());
    let mut m = Map::new();
    m.insert("id".into(), Value::String(format!("other:{label}")));
    m.insert("kind".into(), Value::String("other".into()));
    m.insert("label".into(), Value::String(label));
    m.insert("tokens".into(), num(tokens));
    m.insert("tokenSource".into(), Value::String("estimated".into()));
    m.insert("bytes".into(), num(bytes as f64));
    m.insert("text".into(), Value::String(String::new()));
    m.insert("role".into(), Value::String("input".into()));
    // NOTE: no `toolName` — the fold represents many blocks, so any one tool name would be a lie.
    kept.push(Value::Object(m));
    kept
}

/// Calibrate a step's per-block estimates against the exact usage totals (TRDD-IQENK7JM §2).
///
/// The ASYMMETRY between the two groups is the whole design and must not be "simplified":
///  - OUTPUT blocks (assistant text/thinking/tool_use) FULLY account for the turn's output, so they
///    calibrate unconditionally at any scale.
///  - INPUT blocks are only the NEW input this turn; they legitimately EXCLUDE the cached prefix and
///    the implicit system prompt, so their target is `input + cacheCreate` — NOT cacheRead, which is
///    the reused prefix — and calibration is allowed only inside a [0.5, 2] band. Inside it the gap
///    is estimator drift (honest to scale); outside it the blocks are structurally incomplete versus
///    the total (turn 1's system prompt, say), and scaling would misattribute INVISIBLE tokens onto
///    visible blocks. Those keep the raw estimate.
fn calibrate_step_blocks(blocks: &mut [Value], usage: Option<&[f64; 4]>) {
    let Some(u) = usage else { return };
    apply_calibration(blocks, "input", u[0] + u[3], Some(0.5), Some(2.0));
    apply_calibration(blocks, "output", u[1], None, None);
}

fn apply_calibration(blocks: &mut [Value], role: &str, target: f64, min_scale: Option<f64>, max_scale: Option<f64>) {
    let idxs: Vec<usize> = blocks
        .iter()
        .enumerate()
        .filter(|(_, b)| b.get("role").and_then(Value::as_str) == Some(role))
        .map(|(i, _)| i)
        .collect();
    if idxs.is_empty() {
        return;
    }
    let raw: Vec<f64> = idxs.iter().map(|i| blocks[*i].get("tokens").and_then(Value::as_f64).unwrap_or(0.0)).collect();
    let cal = calibrate_tokens(&raw, Some(target), min_scale, max_scale);
    for (k, i) in idxs.into_iter().enumerate() {
        if let Some(o) = blocks[i].as_object_mut() {
            o.insert("tokens".into(), num(cal.tokens[k]));
            o.insert("tokenSource".into(), Value::String(cal.source.to_string()));
        }
    }
}

/// Diff a step's blocks against the previous step's id→hash map. The FIRST step (no prev) reports
/// every block as "added" — not as "unchanged" — because there is no baseline to be unchanged from.
fn diff_steps(blocks: &[Value], prev: Option<&IndexMap<String, String>>, cur: &IndexMap<String, String>) -> Value {
    let id_of = |b: &Value| b.get("id").and_then(Value::as_str).unwrap_or("").to_owned();
    let mut m = Map::new();
    let Some(prev) = prev else {
        let added: Vec<Value> = blocks.iter().map(|b| Value::String(id_of(b))).collect();
        let first = added.first().cloned();
        m.insert("added".into(), Value::Array(added));
        m.insert("removed".into(), Value::Array(Vec::new()));
        m.insert("changed".into(), Value::Array(Vec::new()));
        if let Some(f) = first {
            m.insert("firstChangeBlockId".into(), f);
        }
        return Value::Object(m);
    };
    let mut added: Vec<Value> = Vec::new();
    let mut changed: Vec<Value> = Vec::new();
    let mut changed_or_added: IndexSet<String> = IndexSet::new();
    for b in blocks {
        let id = id_of(b);
        match prev.get(&id) {
            None => {
                added.push(Value::String(id.clone()));
                changed_or_added.insert(id);
            }
            Some(before) if Some(before) != cur.get(&id) => {
                changed.push(Value::String(id.clone()));
                changed_or_added.insert(id);
            }
            _ => {}
        }
    }
    // `removed` follows the PREVIOUS step's block order (its map insertion order), not this one's.
    let removed: Vec<Value> =
        prev.keys().filter(|id| !cur.contains_key(*id)).map(|id| Value::String(id.clone())).collect();
    let first = blocks.iter().map(id_of).find(|id| changed_or_added.contains(id));
    m.insert("added".into(), Value::Array(added));
    m.insert("removed".into(), Value::Array(removed));
    m.insert("changed".into(), Value::Array(changed));
    if let Some(f) = first {
        m.insert("firstChangeBlockId".into(), Value::String(f));
    }
    Value::Object(m)
}

//! Port of `src/rawBodyContext.ts::buildCallContextFromJson` + `parseUserId` (TRDD-DMWOBWFH) —
//! turns ONE raw Anthropic Messages API request body into an ordered ContextBlock[] (CallContext),
//! mirroring the TS module's exact block-taxonomy / ordering / truncation contract.
//!
//! NOT ported here (out of scope for this slice — port when a caller needs them):
//!  - `CallBodyRegistry` — already ported separately at `call_body_registry.rs`.
//!  - `buildCallContext` (the file-reading wrapper) and `resolveCallContext` (the registry-backed
//!    accessor) — thin I/O wrappers around this function.
//!
//! Wire objects (ContextBlock / CallContext) are built as `serde_json::Value` mirroring the TS
//! object literals EXACTLY, key-insertion-order included (`preserve_order` cargo feature) — never a
//! typed struct, per this port's design law. A TS object-literal key whose value is `undefined` is
//! OMITTED here (that is what `JSON.stringify` does to it), never serialized as `null`.

use serde_json::{Map, Value};
use std::sync::OnceLock;

use crate::summarize::helpers::{js_slice, js_string, num};
use crate::token_estimator::{count_tokens, estimate_tokens_from_bytes};

/// Image content blocks stay in the shared `other` ContextBlockKind bucket; this label prefix is
/// how a downstream consumer (contextCompositionIndex) re-classifies them as images without
/// re-parsing the body. Load-bearing — mirror exactly.
pub const IMAGE_BLOCK_LABEL_PREFIX: &str = "image";

/// Full text per block, capped so a single drill never ships an unbounded payload. The token count
/// is still computed on the FULL text (TRDD-IQENK7JM) — see `push_block`, which counts BEFORE the
/// cap is applied. That ordering is load-bearing.
const BLOCK_TEXT_CAP: usize = 20_000;

/// UTF-16 code-unit length of `s`, matching JS `.length` — used only to decide whether `js_slice`
/// must actually cap (avoids slicing/copying text that is already under the cap).
fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

fn re(cell: &'static OnceLock<regex::Regex>, pattern: &str) -> &'static regex::Regex {
    cell.get_or_init(|| regex::Regex::new(pattern).expect("valid regex"))
}

/// Parse Claude Code's `metadata.user_id` — a JSON STRING blob `{device_id, account_uuid,
/// session_id}` (NOT a bare id). Fail-soft: any malformed/absent input returns all-`None` fields
/// rather than propagating a parse error (mirrors the TS `try {...} catch { return {} }`).
#[derive(Default)]
pub struct ParsedUserId {
    pub session_id: Option<String>,
    pub account_uuid: Option<String>,
    pub device_id: Option<String>,
}

pub fn parse_user_id(raw: &Value) -> ParsedUserId {
    let Some(s) = raw.as_str() else { return ParsedUserId::default() };
    if s.is_empty() {
        return ParsedUserId::default();
    }
    let Ok(o) = serde_json::from_str::<Value>(s) else { return ParsedUserId::default() };
    ParsedUserId {
        session_id: o.get("session_id").and_then(Value::as_str).map(str::to_owned),
        account_uuid: o.get("account_uuid").and_then(Value::as_str).map(str::to_owned),
        device_id: o.get("device_id").and_then(Value::as_str).map(str::to_owned),
    }
}

/// classifySystem — cheaply tag CLAUDE.md / rules injections so the tree labels them, else plain
/// system. The first pattern's TS `/m` flag only matters for the `^` alternative, so `(?m)` is
/// applied to the whole pattern (harmless for the first alternative, which has no `^`).
fn classify_system(text: &str) -> &'static str {
    static CLAUDEMD: OnceLock<regex::Regex> = OnceLock::new();
    static RULE: OnceLock<regex::Regex> = OnceLock::new();
    if re(&CLAUDEMD, r"(?m)Contents of .*CLAUDE\.md|^#\s*CLAUDE\.md").is_match(text) {
        return "claudemd";
    }
    if re(&RULE, r"Contents of .*[/\\]\.claude[/\\]rules[/\\]").is_match(text) {
        return "rule";
    }
    "system"
}

/// flattenResultContent — a tool_result content (string, or array of {type:'text',text}/image
/// blocks) reduced to plain text.
fn flatten_result_content(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|c| {
                if let Some(s) = c.as_str() {
                    return s.to_owned();
                }
                let t = c.get("type").and_then(Value::as_str);
                if t == Some("text") {
                    if let Some(text) = c.get("text").and_then(Value::as_str) {
                        return text.to_owned();
                    }
                }
                if t == Some("image") {
                    return "[image]".to_owned();
                }
                serde_json::to_string(c).unwrap_or_default()
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Null => String::new(),
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

/// The `push` closure from the TS source, as a free function to sidestep a closure double-borrow
/// of `blocks`/`truncated` (this is called from many places across the loop below). Counts tokens
/// on the FULL text, THEN caps the stored text — the ordering TRDD-IQENK7JM depends on.
#[allow(clippy::too_many_arguments)]
fn push_block(
    blocks: &mut Vec<Value>,
    truncated: &mut bool,
    cap: usize,
    kind: &str,
    label: &str,
    raw_text: &str,
    role: &str,
    tool_name: Option<&str>,
) {
    let tokens = count_tokens(raw_text);
    let text: &str = if utf16_len(raw_text) > cap {
        *truncated = true;
        js_slice(raw_text, cap)
    } else {
        raw_text
    };
    // Buffer.byteLength(text) == UTF-8 byte length; Rust `str::len()` IS the UTF-8 byte count.
    let bytes = text.len();
    let mut m = Map::new();
    m.insert("id".into(), Value::String(format!("{kind}:{}", blocks.len())));
    m.insert("kind".into(), Value::String(kind.to_owned()));
    m.insert("label".into(), Value::String(label.to_owned()));
    m.insert("tokens".into(), num(tokens));
    m.insert("tokenSource".into(), Value::String("estimated".into()));
    m.insert("bytes".into(), num(bytes as f64));
    m.insert("text".into(), Value::String(text.to_owned()));
    m.insert("role".into(), Value::String(role.to_owned()));
    if let Some(tn) = tool_name {
        m.insert("toolName".into(), Value::String(tn.to_owned()));
    }
    blocks.push(Value::Object(m));
}

/// Turn a parsed request body into an ordered ContextBlock[] (CallContext): system → tool catalog →
/// messages, mirroring the actual prompt-cache prefix order (stable prefix first, conversation
/// after). `body` is the raw parsed JSON request body (`RawRequestBody` in the TS source — kept as
/// `Value` here per this port's design law: never invent a typed wire struct). `uncap` mirrors
/// `opts?.uncap` — lifts the per-block text cap for an explicit single-block drill.
pub fn build_call_context_from_json(body: &Value, uncap: bool) -> Option<Value> {
    if !body.is_object() {
        return None;
    }
    let mut blocks: Vec<Value> = Vec::new();
    let mut truncated = false;
    let cap = if uncap { usize::MAX } else { BLOCK_TEXT_CAP };

    // 1. system
    let system = body.get("system");
    if let Some(s) = system.and_then(Value::as_str) {
        if !s.is_empty() {
            push_block(&mut blocks, &mut truncated, cap, classify_system(s), "system prompt", s, "input", None);
        }
    } else if let Some(arr) = system.and_then(Value::as_array) {
        for (i, sb) in arr.iter().enumerate() {
            let text = sb.get("text").and_then(Value::as_str).unwrap_or("");
            if !text.is_empty() {
                let label = format!("system[{i}]");
                push_block(&mut blocks, &mut truncated, cap, classify_system(text), &label, text, "input", None);
            }
        }
    }

    // 2. tool catalog (one block)
    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        if !tools.is_empty() {
            let catalog = tools
                .iter()
                .map(|t| {
                    // `t.name ?? '?'` — nullish coalescing, only a missing/non-string name falls
                    // back (an empty-string name is kept, matching TS `??` vs `||`).
                    let name = t.get("name").and_then(Value::as_str).unwrap_or("?");
                    let desc = t.get("description").and_then(Value::as_str).unwrap_or("");
                    format!("- {name}: {}", js_slice(desc, 200))
                })
                .collect::<Vec<_>>()
                .join("\n");
            let label = format!("tool catalog ({} tools)", tools.len());
            push_block(&mut blocks, &mut truncated, cap, "toolCatalog", &label, &catalog, "input", None);
        }
    }

    // 3. messages — map each content element to a block. tool_use → its name; tool_result inherits
    //    the name from the matching tool_use (earlier in the list) so Bash/MCP results tag correctly.
    let mut tool_name_by_id: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let empty: Vec<Value> = Vec::new();
    let messages = body.get("messages").and_then(Value::as_array).unwrap_or(&empty);
    for m in messages {
        let role = m.get("role").and_then(Value::as_str).unwrap_or("");
        let content = m.get("content");
        if let Some(text) = content.and_then(Value::as_str) {
            let (kind, label) = if role == "assistant" {
                ("assistantMsg", "assistant")
            } else if role == "system" {
                ("reminder", "system message")
            } else {
                ("userMsg", "user")
            };
            let out_role = if role == "assistant" { "output" } else { "input" };
            push_block(&mut blocks, &mut truncated, cap, kind, label, text, out_role, None);
            continue;
        }
        let Some(content_arr) = content.and_then(Value::as_array) else { continue };
        for b in content_arr {
            let btype = b.get("type").and_then(Value::as_str);
            match btype {
                Some("text") => {
                    let text = b.get("text").and_then(Value::as_str).unwrap_or("");
                    let (kind, label, out_role) = if role == "assistant" {
                        ("assistantMsg", "assistant", "output")
                    } else {
                        ("userMsg", "user", "input")
                    };
                    push_block(&mut blocks, &mut truncated, cap, kind, label, text, out_role, None);
                }
                Some("thinking") => {
                    let thinking = b.get("thinking").and_then(Value::as_str).unwrap_or("");
                    push_block(&mut blocks, &mut truncated, cap, "reasoning", "thinking", thinking, "output", None);
                }
                Some("tool_use") => {
                    let name = b.get("name").and_then(Value::as_str).unwrap_or("");
                    if let Some(id) = b.get("id").and_then(Value::as_str) {
                        if !id.is_empty() {
                            tool_name_by_id.insert(id.to_owned(), name.to_owned());
                        }
                    }
                    let is_mcp = name.starts_with("mcp__");
                    let kind = if is_mcp { "mcp" } else if name == "Bash" { "bashInput" } else { "toolInput" };
                    // `JSON.stringify(tu.input ?? {})` — NULLISH, so an explicit `"input": null`
                    // stringifies as `{}`, NOT as the literal string "null". Treating an absent
                    // key and a null key differently here would mislabel every null-input
                    // tool_use block AND shift its token/byte counts.
                    let input = match b.get("input") {
                        None | Some(Value::Null) => Value::Object(Map::new()),
                        Some(v) => v.clone(),
                    };
                    let text = serde_json::to_string(&input).unwrap_or_default();
                    let label = if name.is_empty() { "tool_use" } else { name };
                    let tool_name = if name.is_empty() { None } else { Some(name) };
                    push_block(&mut blocks, &mut truncated, cap, kind, label, &text, "input", tool_name);
                }
                Some("tool_result") => {
                    let tool_use_id = b.get("tool_use_id").and_then(Value::as_str).unwrap_or("");
                    let name = if !tool_use_id.is_empty() {
                        tool_name_by_id.get(tool_use_id).cloned().unwrap_or_default()
                    } else {
                        String::new()
                    };
                    let is_mcp = name.starts_with("mcp__");
                    let kind = if is_mcp { "mcp" } else if name == "Bash" { "bashOutput" } else { "toolOutput" };
                    let empty_content = Value::Null;
                    let content = b.get("content").unwrap_or(&empty_content);
                    let text = flatten_result_content(content);
                    let label = if name.is_empty() { "tool_result" } else { name.as_str() };
                    let tool_name = if name.is_empty() { None } else { Some(name.as_str()) };
                    push_block(&mut blocks, &mut truncated, cap, kind, label, &text, "output", tool_name);
                }
                Some("image") => {
                    // Account the image's real token weight from its base64 LENGTH (bytes/4) rather
                    // than the display cap — mirrors the TS direct-push (no `push_block`, no cap,
                    // no toolName key at all). NEVER store the base64 bytes: the stored text is a
                    // metadata stub, so this stays pointer-only.
                    // `src?.media_type ?? 'unknown'` is NULLISH and then TEMPLATE-INTERPOLATED into
                    // the label, so a non-string media_type STRINGIFIES rather than falling back —
                    // `as_str().unwrap_or("unknown")` would silently relabel it. js_string mirrors
                    // the interpolation; only absent/null take the fallback.
                    let media = match b.get("source").and_then(|s| s.get("media_type")) {
                        None | Some(Value::Null) => "unknown".to_owned(),
                        Some(v) => js_string(v),
                    };
                    let b64len = b
                        .get("source")
                        .and_then(|s| s.get("data"))
                        .and_then(Value::as_str)
                        .map(utf16_len)
                        .unwrap_or(0);
                    let mut m = Map::new();
                    m.insert("id".into(), Value::String(format!("other:{}", blocks.len())));
                    m.insert("kind".into(), Value::String("other".into()));
                    m.insert("label".into(), Value::String(format!("{IMAGE_BLOCK_LABEL_PREFIX} {media}")));
                    m.insert("tokens".into(), num(estimate_tokens_from_bytes(b64len as u64) as f64));
                    m.insert("tokenSource".into(), Value::String("estimated".into()));
                    m.insert("bytes".into(), num(b64len as f64));
                    let text = if b64len > 0 { format!("[image {media} — {b64len} base64 bytes, not stored]") } else { "[image]".to_owned() };
                    m.insert("text".into(), Value::String(text));
                    m.insert("role".into(), Value::String("input".into()));
                    blocks.push(Value::Object(m));
                }
                _ => {
                    let label = btype.unwrap_or("block");
                    let text = serde_json::to_string(b).unwrap_or_default();
                    push_block(&mut blocks, &mut truncated, cap, "other", label, &text, "input", None);
                }
            }
        }
    }

    // metadata.user_id is a JSON blob {device_id, account_uuid, session_id} — parse out the real ids
    // (the pre-fix TS code assigned the whole blob string to sessionId).
    let empty_user_id = Value::Null;
    let user_id = body.get("metadata").and_then(|md| md.get("user_id")).unwrap_or(&empty_user_id);
    let uid = parse_user_id(user_id);

    let model = body.get("model").and_then(Value::as_str);
    // `betas` is kept verbatim (strings only) rather than pre-interpreted — an open-ended API list.
    // Absent/malformed stays omitted (None); an empty array would falsely assert "no betas sent".
    let betas: Option<Vec<Value>> = body.get("betas").and_then(Value::as_array).map(|arr| {
        arr.iter().filter(|b| b.is_string()).cloned().collect()
    });

    let mut out = Map::new();
    out.insert("sessionId".into(), Value::String(uid.session_id.unwrap_or_default()));
    if let Some(a) = uid.account_uuid {
        out.insert("accountUuid".into(), Value::String(a));
    }
    if let Some(m) = model {
        out.insert("model".into(), Value::String(m.to_owned()));
    }
    if let Some(b) = betas {
        out.insert("betas".into(), Value::Array(b));
    }
    out.insert("blocks".into(), Value::Array(blocks));
    out.insert("truncated".into(), Value::Bool(truncated));
    Some(Value::Object(out))
}

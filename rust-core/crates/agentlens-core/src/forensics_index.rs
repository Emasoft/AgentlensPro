//! Port of `src/forensicsIndex.ts` SLICE A of 2 (TRDD-DMWOBWFH P4x.2p) — the PURE half: the effort
//! classifier, the frontmatter fingerprint, injection attribution, and the content taxonomy.
//!
//! SLICE B is the bounded scan + the fact-table writer, which needs a storage decision this half
//! does not: every function here is a pure transform over one request body, so it is identical
//! whichever engine the facts eventually land in.

use std::sync::OnceLock;

use regex::Regex;
use serde_json::{Map, Value};

use crate::summarize::helpers::js_math_round;

/// `strOrUndef` — a non-empty string, or nothing.
fn nes(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str).filter(|s| !s.is_empty())
}

/// The budget→level thresholds are a documented heuristic (Claude Code maps "think" ≈ 4k, "think
/// hard" ≈ 10k, "ultrathink" ≈ 32k onto `budget_tokens`). Only the RELATIVE grouping matters to
/// `compare_configs`, so the exact cutoffs are not load-bearing — but the `<=` is: a port using `<`
/// disagrees only at exactly 8192 and 24576, which is the kind of difference no one notices.
///
/// `None` covers JS's falsy net: `undefined`, `null`, `0` and `NaN` all classify as `none`, and NaN
/// needs saying out loud because `NaN <= 0` is false while `!NaN` is true.
pub fn classify_effort(budget_tokens: Option<f64>) -> &'static str {
    match budget_tokens {
        Some(b) if b.is_finite() && b > 0.0 => {
            if b <= 8192.0 {
                "low"
            } else if b <= 24576.0 {
                "medium"
            } else {
                "high"
            }
        }
        // An INFINITE budget is not falsy in JS, so it takes the last branch rather than `none`.
        Some(b) if b.is_infinite() && b > 0.0 => "high",
        _ => "none",
    }
}

fn re(cell: &'static OnceLock<Regex>, pattern: &str) -> &'static Regex {
    cell.get_or_init(|| Regex::new(pattern).expect("static pattern"))
}

/// `/Contents of .*[/\\]\.claude[/\\]rules[/\\]([^\n\r]+?\.md)/` — GREEDY `.*` (unlike the global
/// variant below), so on a line naming two rule paths it takes the LAST one. `.` is spelled
/// `[^\n\r]` because JS's dot excludes both line terminators and Rust's excludes only `\n`.
fn rule_file_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"Contents of [^\n\r]*[/\\]\.claude[/\\]rules[/\\]([^\n\r]+?\.md)")
}

fn claudemd_test_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"(?m)Contents of [^\n\r]*CLAUDE\.md|^#\s*CLAUDE\.md")
}

/// One system block's IDENTITY — what it IS, not what it says. Two sessions that loaded the same
/// rule file produce the same identity even though the file's text differs between them.
fn system_block_identity(text: &str) -> String {
    if let Some(c) = rule_file_re().captures(text) {
        return format!("rule:{}", &c[1]);
    }
    if claudemd_test_re().is_match(text) {
        return "claudemd".to_owned();
    }
    "system".to_owned()
}

/// A sha1 of the tool-name list + each system block's identity — the "stable prefix" fingerprint.
///
/// ORDER IS PRESERVED, deliberately: the canonical string joins in ARRAY order, so two prefixes
/// that differ only in tool ORDER get different fingerprints. That is correct for what this
/// measures — the prompt cache keys on bytes, and a reordered tool list is a different prefix.
pub fn compute_frontmatter_fp(body: &Value) -> Option<String> {
    let tool_names: Vec<&str> = body
        .get("tools")
        .and_then(Value::as_array)
        .map(|ts| ts.iter().filter_map(|t| nes(t.get("name"))).collect())
        .unwrap_or_default();

    let mut sys_ids: Vec<String> = Vec::new();
    match body.get("system") {
        Some(Value::String(s)) => sys_ids.push(system_block_identity(s)),
        Some(Value::Array(blocks)) => {
            for b in blocks {
                // A block with no text is SKIPPED, not folded in as an empty identity — including
                // it would change the fingerprint of every request that carries one.
                if let Some(t) = nes(b.get("text")) {
                    sys_ids.push(system_block_identity(t));
                }
            }
        }
        _ => {}
    }
    if tool_names.is_empty() && sys_ids.is_empty() {
        return None;
    }
    let canonical = format!("tools:{}||system:{}", tool_names.join(","), sys_ids.join(","));
    Some(sha1_hex(&canonical))
}

fn sha1_hex(text: &str) -> String {
    use sha1::{Digest, Sha1};
    let mut h = Sha1::new();
    h.update(text.as_bytes());
    h.finalize().iter().map(|b| format!("{b:02x}")).collect()
}

/// One attributed injection. `tokens` is deliberately 0: the co-occurrence stats rank on the CALL's
/// cache/output tokens joined by call_id, not on injection tokens, and a per-injection split cannot
/// be cleanly attributed out of one shared system block. A fabricated split would rank on itself.
#[derive(Clone)]
pub struct InjectionRow {
    pub kind: &'static str,
    pub name: String,
}

impl InjectionRow {
    pub fn to_value(&self) -> Value {
        let mut m = Map::new();
        m.insert("kind".into(), Value::String(self.kind.to_owned()));
        m.insert("name".into(), Value::String(self.name.clone()));
        m.insert("tokens".into(), Value::from(0));
        Value::Object(m)
    }
}

/// GLOBAL and LAZY, where `rule_file_re` is single and greedy: the giant Claude Code system block
/// concatenates many `Contents of …/rules/X.md` markers, and a port that stopped at the first match
/// would record one rule per request instead of twenty.
fn rule_global_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"Contents of [^\n\r]*?[/\\]\.claude[/\\]rules[/\\]([^\n\r]+?\.md)")
}

fn claudemd_global_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"Contents of ([^\n\r]*?CLAUDE\.md)")
}

/// `mcp__<server>__<tool>` → `mcp__<server>`, where the SERVER name may itself contain single
/// underscores (`mcp__plugin_llm-externalizer_llm-externalizer__chat`).
///
/// The TS spells the repetition LAZY (`*?`) and it is copied verbatim, but measured: the `?` is a
/// NO-OP here. Each repetition is `_` followed by `[^_]+`, which can never consume a second
/// underscore, so the first `__` terminates the group whether it is greedy or lazy — flipping it
/// changes no output on any input. Said out loud because the lazy marker reads as load-bearing and
/// a future reader would otherwise preserve it as if it were.
fn mcp_tool_re() -> &'static Regex {
    static R: OnceLock<Regex> = OnceLock::new();
    re(&R, r"^(mcp__[^_]+(?:_[^_]+)*?)__")
}

fn collect_system_text(body: &Value) -> String {
    match body.get("system") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|b| b.get("text").and_then(Value::as_str).unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

/// Parse `system[]` + `tools[]` + `Skill` tool_use into attributed injections.
///
/// rule/mcp/claudemd are EXACT; skill is a documented heuristic — actively-INVOKED `Skill` calls,
/// NOT the whole "available skills" catalogue, because recording every AVAILABLE skill on every call
/// fills the junction table with a list that discriminates nothing.
pub fn extract_injections(body: &Value) -> Vec<InjectionRow> {
    let mut rows: Vec<InjectionRow> = Vec::new();
    let mut seen: std::collections::HashSet<(&'static str, String)> = std::collections::HashSet::new();
    let mut add = |kind: &'static str, name: &str| {
        let name = name.trim().to_owned();
        if !name.is_empty() && seen.insert((kind, name.clone())) {
            rows.push(InjectionRow { kind, name });
        }
    };

    let sys_text = collect_system_text(body);
    for c in rule_global_re().captures_iter(&sys_text) {
        add("rule", &c[1]);
    }
    for c in claudemd_global_re().captures_iter(&sys_text) {
        add("claudemd", &c[1]);
    }

    if let Some(tools) = body.get("tools").and_then(Value::as_array) {
        for t in tools {
            if let Some(name) = nes(t.get("name")) {
                if let Some(c) = mcp_tool_re().captures(name) {
                    add("mcp", &c[1]);
                }
            }
        }
    }

    if let Some(msgs) = body.get("messages").and_then(Value::as_array) {
        for msg in msgs {
            let Some(content) = msg.get("content").and_then(Value::as_array) else { continue };
            for blk in content {
                if blk.get("type") != Some(&Value::String("tool_use".into()))
                    || nes(blk.get("name")) != Some("Skill")
                {
                    continue;
                }
                let Some(input) = blk.get("input").filter(|v| v.is_object() || v.is_array()) else { continue };
                // Precedence: skill, then command, then name.
                if let Some(sk) = nes(input.get("skill"))
                    .or_else(|| nes(input.get("command")))
                    .or_else(|| nes(input.get("name")))
                {
                    add("skill", sk);
                }
            }
        }
    }
    rows
}

pub const BIG_READ_TOKENS: f64 = 25_000.0;
pub const BIG_CATALOG_TOKENS: f64 = 10_000.0;
pub const BIG_THINKING_TOKENS: f64 = 20_000.0;

fn is_tool_result_kind(kind: &str) -> bool {
    kind == "toolOutput" || kind == "bashOutput"
}

fn tag(name: &str, tokens: f64, count: usize) -> Value {
    let mut m = Map::new();
    m.insert("tag".into(), Value::String(name.to_owned()));
    m.insert("tokens".into(), crate::summarize::helpers::num(tokens));
    m.insert("count".into(), Value::from(count));
    Value::Object(m)
}

/// The content taxonomy, derived from a composition rather than reinvented. The composition arrives
/// as a `Value` because that is what `build_call_composition` returns.
pub fn derive_content_tags(comp: &Value) -> Vec<Value> {
    let mut tags = Vec::new();
    let f = |v: Option<&Value>| v.and_then(Value::as_f64).unwrap_or(0.0);
    let img_count = f(comp.pointer("/images/count"));
    if img_count > 0.0 {
        tags.push(tag("image", f(comp.pointer("/images/tokens")), img_count as usize));
    }

    let empty: Vec<Value> = Vec::new();
    let blocks = comp.get("blocks").and_then(Value::as_array).unwrap_or(&empty);

    // binary = NON-image binary media (a base64 block whose media type is not image/*, e.g. a PDF or
    // audio). Image media already has its own tag, so this stays a distinct, non-redundant signal.
    let bins: Vec<&Value> = blocks
        .iter()
        .filter(|b| nes(b.get("mediaType")).is_some_and(|m| !m.starts_with("image/")))
        .collect();
    if !bins.is_empty() {
        let tokens = bins.iter().map(|b| js_math_round(f(b.get("bytes")) / 4.0)).sum();
        tags.push(tag("binary", tokens, bins.len()));
    }

    let big: Vec<&Value> = blocks
        .iter()
        .filter(|b| {
            b.get("kind").and_then(Value::as_str).is_some_and(is_tool_result_kind)
                && f(b.get("tokens")) >= BIG_READ_TOKENS
        })
        .collect();
    if !big.is_empty() {
        let tokens = big.iter().map(|b| f(b.get("tokens"))).sum();
        tags.push(tag("big_file_read", tokens, big.len()));
    }

    // `tool_result:<Kind>` — one row per distinct tool result source present. Insertion order is the
    // wire order (a JS Map), so an IndexMap, not a HashMap.
    let mut by_kind: indexmap::IndexMap<String, (f64, usize)> = indexmap::IndexMap::new();
    for b in blocks {
        let Some(kind) = b.get("kind").and_then(Value::as_str) else { continue };
        if !is_tool_result_kind(kind) {
            continue;
        }
        // No toolName: the key falls back to the KIND rather than being dropped.
        let key = nes(b.get("toolName")).unwrap_or(kind).to_owned();
        let e = by_kind.entry(key).or_insert((0.0, 0));
        e.0 += f(b.get("tokens"));
        e.1 += 1;
    }
    for (k, (tokens, count)) in by_kind {
        tags.push(tag(&format!("tool_result:{k}"), tokens, count));
    }

    let catalog = f(comp.get("toolCatalogTokens"));
    if catalog >= BIG_CATALOG_TOKENS {
        tags.push(tag("tool_catalog_large", catalog, 1));
    }
    let thinking = f(comp.get("thinkingTokens"));
    if thinking >= BIG_THINKING_TOKENS {
        tags.push(tag("thinking_heavy", thinking, 1));
    }
    tags
}

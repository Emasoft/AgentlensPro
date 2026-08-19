//! agentlens-logscan — the Claude transcript boot-scan in Rust (TRDD-DMWOBWFH Phase 2).
//!
//! Faithful port of the TS Claude .jsonl parser (`src/logReader.ts::_claudeOnEntry` +
//! `_buildCard` + `_buildSubAgentCards` + the retention layer in `src/timelineRetention.ts`).
//! Every card field the TS parser emits is emitted here with the SAME value; the division of
//! labor with the TS wrapper (`src/rustLogScan.ts`) is deliberate:
//!
//!   RUST OWNS: the per-line CPU work — JSON parse, usage dedup by message.id, disjoint token
//!   buckets, tool/file accounting, bounded timeline retention, sub-agent child cards, the
//!   worktree/subagents parent linkage (pure path logic).
//!
//!   TS WRAPPER OWNS (one-source-of-truth boundaries, not laziness): accountId (live
//!   CallBodyRegistry), speedBlendedCostUsd (the pricing table lives ONLY in
//!   src/shared/pricing.ts — this crate emits `blendTurns` for mixed-speed sessions instead of
//!   growing a second rates table that would drift), attachGeneratedFiles (fs heuristics stay
//!   in src/generatedFiles.ts; this crate emits the harvested `genFiles` paths), and the
//!   hot-age timeline strip (Date::now-dependent).
//!
//! PARITY TRAPS ported deliberately — do not "simplify" these:
//! - JS string lengths are UTF-16 code units. capText/snip/entryCost all measure UTF-16, so the
//!   retention byte accounting and truncation boundaries here use utf16_len/utf16_snip, never
//!   str::len (which is UTF-8 bytes — that role belongs only to _utf8Bytes/_editInputBytes).
//! - One assistant MESSAGE spans many JSONL rows, each repeating the full `usage`; usage counts
//!   ONCE per message.id (2.4-4.5x over-count measured before the TS fix).
//! - model "<synthetic>" never overwrites the real model.
//! - The sibling `toolUseResult` attributes ONLY when the entry has exactly one tool_result.
//! - Bounded collections evict in INSERTION order at 4096 (IndexMap/shift_remove) — same
//!   dead-correlation-only guarantee as the TS _boundedSet/_boundedAdd.

use std::cell::RefCell;
use std::rc::Rc;

pub mod codex;
pub mod copilot;
pub mod discovery;
pub mod opencode;

use indexmap::{IndexMap, IndexSet};
use serde::Serialize;
use serde_json::Value;

pub const DEFAULT_TIMELINE_MAX_ENTRIES: usize = 2000;
pub const DEFAULT_TIMELINE_MAX_BYTES: usize = 2 * 1024 * 1024;
pub const FIELD_MAX_CHARS: usize = 32 * 1024;
const MAX_TOOL_RESULT_CHARS: usize = 500_000;
const ACCUM_COLLECTION_MAX: usize = 4096;

// ── UTF-16 string helpers (JS .length / .slice parity) ───────────────────────────

fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// First `n` UTF-16 code units of `s` (JS `s.slice(0, n)`), flat copy. A surrogate pair split by
/// the boundary is dropped whole — JS would keep a lone surrogate, which JSON-encodes as U+FFFD
/// anyway; whole-pair truncation is the honest equivalent.
fn utf16_slice(s: &str, n: usize) -> String {
    let mut units = 0usize;
    let mut out = String::new();
    for c in s.chars() {
        let w = c.len_utf16();
        if units + w > n {
            break;
        }
        units += w;
        out.push(c);
    }
    out
}

/// JS-whitespace trim: char::is_whitespace plus U+FEFF (ES WhiteSpace includes the BOM).
pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}')
}

/// TS `snip`: truncate to maxChars UTF-16 units with no marker.
pub(crate) fn snip(s: &str, max_chars: usize) -> String {
    if utf16_len(s) <= max_chars {
        s.to_owned()
    } else {
        utf16_slice(s, max_chars)
    }
}

/// TS `capText`: truncate with the retention marker naming what was cut.
pub(crate) fn cap_text(s: &str, max_chars: usize) -> String {
    let len = utf16_len(s);
    if len <= max_chars {
        return s.to_owned();
    }
    format!("{}\n…[retention: {} chars truncated]", utf16_slice(s, max_chars), len - max_chars)
}

// ── JSON value helpers (JS coercion parity where the TS code coerces) ─────────────

fn as_str(v: Option<&Value>) -> Option<&str> {
    v.and_then(Value::as_str)
}

/// JS `String(v)` for the value shapes a transcript actually carries in path fields.
pub(crate) fn js_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Number(n) => n.to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Null => "null".to_owned(),
        Value::Array(a) => a.iter().map(js_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".to_owned(),
    }
}

/// `String(inp[k1] ?? inp[k2] ?? … ?? '')` — the ?? chain skips only null/absent.
fn coalesce_string(obj: &serde_json::Map<String, Value>, keys: &[&str]) -> String {
    for k in keys {
        match obj.get(*k) {
            None | Some(Value::Null) => continue,
            Some(v) => return js_string(v),
        }
    }
    String::new()
}

/// A usage figure: finite positive JSON number, else 0 (TS tokenBuckets clamp — a string "5" is
/// NOT a number in JS `Number.isFinite` terms and collapses to 0).
pub(crate) fn clamp_num(v: Option<&Value>) -> f64 {
    match v.and_then(Value::as_f64) {
        Some(n) if n.is_finite() && n > 0.0 => n,
        _ => 0.0,
    }
}

// ── Disjoint token buckets (src/shared/tokenBuckets.ts, 'anthropic' shape) ────────

#[derive(Debug, Clone, Copy, Default)]
pub struct Buckets {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_create: f64,
}

fn disjoint_anthropic(usage: &serde_json::Map<String, Value>) -> Buckets {
    Buckets {
        input: clamp_num(usage.get("input_tokens")),
        output: clamp_num(usage.get("output_tokens")),
        cache_read: clamp_num(usage.get("cache_read_input_tokens")),
        cache_create: clamp_num(usage.get("cache_creation_input_tokens")),
    }
}

// ── Timeline entries (the subset of TimelineEntry the log path produces) ──────────

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineEntry {
    #[serde(rename = "type")]
    pub entry_type: &'static str, // user_input | tool | llm
    pub span_id: String,
    pub label: String,
    // Option because the opencode entries carry NO turn field (TS never sets it there); every
    // Claude-path constructor passes Some, so the existing wire shape is unchanged.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_input: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_read_tokens: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_create_tokens: Option<f64>,
    pub duration_ms: f64,
    pub is_error: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error_message: Option<String>,
    pub timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub response_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_summary: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub full_result: Option<String>,
}

/// TS `entryCost` — the retained heavy fields, in UTF-16 units. `thinking` is the one TS field
/// no Rust log path sets; it contributes 0, matching its TS `?? 0`.
fn entry_cost(e: &TimelineEntry) -> i64 {
    (e.full_result.as_deref().map(utf16_len).unwrap_or(0)
        + e.response_text.as_deref().map(utf16_len).unwrap_or(0)
        + e.tool_input.as_deref().map(utf16_len).unwrap_or(0)
        + e.result_summary.as_deref().map(utf16_len).unwrap_or(0)
        + e.error_message.as_deref().map(utf16_len).unwrap_or(0)
        + utf16_len(&e.label)) as i64
}

/// TS `capTimeline` — a single tail-trim over an already-assembled timeline (the opencode path
/// builds its Vec in one pass, so this is equivalent to per-push eviction, TRDD-66IXMIGN).
/// Returns the number of evicted (oldest) entries.
pub(crate) fn cap_timeline(timeline: &mut Vec<TimelineEntry>, max_entries: usize, max_bytes: i64) -> u64 {
    let keep_start = timeline.len().saturating_sub(max_entries);
    let mut bytes: i64 = 0;
    let mut i = timeline.len() as i64 - 1;
    let mut over_budget = false;
    while i >= keep_start as i64 {
        bytes += entry_cost(&timeline[i as usize]);
        if bytes > max_bytes {
            over_budget = true; // timeline[i] overflows the budget → keep only (i+1 .. end)
            break;
        }
        i -= 1;
    }
    let mut start = if over_budget { (i + 1) as usize } else { keep_start };
    // Keep at least the newest entry even if it alone busts the budget.
    if !timeline.is_empty() && start >= timeline.len() {
        start = timeline.len() - 1;
    }
    if start > 0 {
        timeline.drain(0..start);
    }
    start as u64
}

type EntryRef = Rc<RefCell<TimelineEntry>>;

/// TimelineHolder: the bounded timeline + its byte/eviction accounting (timelineRetention.ts).
/// Clone is SHALLOW on the entries (Rc) — the incremental tailer (agentlens-core P5d) clones
/// the accumulator only to hand the clone to `build_result`, which reads the entries and copies
/// them into the Card; the live accumulator keeps mutating its own Rc cells afterwards.
#[derive(Default, Clone)]
pub struct Timeline {
    pub entries: Vec<EntryRef>,
    pub truncated_count: u64,
    pub retained_bytes: i64,
    max_entries: usize,
    max_bytes: i64,
}

impl Timeline {
    fn new(max_entries: usize, max_bytes: usize) -> Self {
        Timeline { max_entries, max_bytes: max_bytes as i64, ..Default::default() }
    }

    /// TS `enforceBounds`: evict oldest-first until both bounds hold; keep at least the newest.
    fn enforce_bounds(&mut self) {
        let tl = &mut self.entries;
        let mut bytes = self.retained_bytes;
        let mut evict = tl.len().saturating_sub(self.max_entries);
        for e in tl.iter().take(evict) {
            bytes -= entry_cost(&e.borrow());
        }
        while bytes > self.max_bytes && evict < tl.len().saturating_sub(1) {
            bytes -= entry_cost(&tl[evict].borrow());
            evict += 1;
        }
        if evict > 0 {
            tl.drain(0..evict);
            self.truncated_count += evict as u64;
        }
        self.retained_bytes = bytes;
    }

    /// TS `pushBounded`: amortized count bound (max + max/4 slack), exact byte bound.
    fn push_bounded(&mut self, entry: TimelineEntry) -> EntryRef {
        let cost = entry_cost(&entry);
        let e = Rc::new(RefCell::new(entry));
        self.entries.push(Rc::clone(&e));
        self.retained_bytes += cost;
        let slack = self.max_entries.div_ceil(4);
        if self.entries.len() > self.max_entries + slack || self.retained_bytes > self.max_bytes {
            self.enforce_bounds();
        }
        e
    }

    /// TS `attachFullResult`: cap the field, keep the byte accounting true, re-enforce.
    fn attach_full_result(&mut self, entry: &EntryRef, text: &str) {
        let capped = cap_text(text, FIELD_MAX_CHARS);
        {
            let mut e = entry.borrow_mut();
            let before = e.full_result.as_deref().map(utf16_len).unwrap_or(0) as i64;
            self.retained_bytes += utf16_len(&capped) as i64 - before;
            e.full_result = Some(capped);
        }
        if self.retained_bytes > self.max_bytes {
            self.enforce_bounds();
        }
    }
}

// ── Bounded collections (insertion-order eviction at ACCUM_COLLECTION_MAX) ────────

fn bounded_insert<V>(map: &mut IndexMap<String, V>, key: String, value: V) {
    if !map.contains_key(&key) && map.len() >= ACCUM_COLLECTION_MAX {
        map.shift_remove_index(0);
    }
    map.insert(key, value);
}

fn bounded_add(set: &mut IndexSet<String>, key: String) {
    if !set.contains(&key) && set.len() >= ACCUM_COLLECTION_MAX {
        set.shift_remove_index(0);
    }
    set.insert(key);
}

// ── Sub-agents (SubAgentRec) ──────────────────────────────────────────────────────

#[derive(Debug, Default, Clone)]
struct SubAgentRec {
    tool_use_id: String,
    spawn_turn: u64,
    spawn_ts: String,
    requested_type: Option<String>,
    prompt: Option<String>,
    agent_id: Option<String>,
    model: Option<String>,
    agent_type: Option<String>,
    spawn_kind: Option<&'static str>,
    spawn_model_override: Option<String>,
    spawn_isolation: Option<String>,
    input: f64,
    output: f64,
    cache_read: f64,
    cache_create: f64,
    total_tokens: f64,
    tool_use_count: f64,
    duration_ms: f64,
    tool_stats: Option<serde_json::Map<String, Value>>,
    final_text: Option<String>,
    is_async: bool,
    done: bool,
}

// ── File ops ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOpAccum {
    pub read_bytes: u64,
    pub write_bytes: u64,
    pub edit_bytes: u64,
    pub read_count: u64,
    pub write_count: u64,
    pub edit_count: u64,
}

// ── The accumulator (ClaudeAccum + CardAccum) ─────────────────────────────────────

/// One priced turn's (model-at-that-time, fast?, buckets) — the wrapper computes
/// speedBlendedCostUsd from these against the ONE pricing table (see module doc).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BlendTurn {
    pub model: String,
    pub fast: bool,
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_create: f64,
}

/// The per-file running state (TS ClaudeAccum) — held ACROSS scans by the incremental tailer,
/// so a growing transcript is fed only its appended lines. `!Send` by construction (Rc entries):
/// the tailer parses on one thread.
#[derive(Clone)]
pub struct ClaudeAccum {
    pub workspace: String,
    pub model: String,
    pub first_timestamp: String,
    pub last_timestamp: String,
    pub has_fast_mode: bool,
    pub saw_standard_speed: bool,
    pub blend_turns: Vec<BlendTurn>,
    idx: u64,
    pending_reads: IndexMap<String, String>,
    seen_message_ids: IndexSet<String>,
    sub_agents: IndexMap<String, SubAgentRec>,
    pending_tool_results: IndexMap<String, EntryRef>,
    /// Harvested scratch paths → correlated spanId (genFiles). Order preserved for parity.
    pub gen_files: IndexMap<String, Option<String>>,
    // CardAccum
    total_input: f64,
    total_output: f64,
    total_cache_read: f64,
    total_cache_create: f64,
    peak_context_per_turn: f64,
    turns: u64,
    total_tool_calls: u64,
    tool_counts: IndexMap<String, u64>,
    files_read: IndexSet<String>,
    files_changed: IndexSet<String>,
    files_written: IndexSet<String>,
    files_searched: IndexSet<String>,
    file_ops: IndexMap<String, FileOpAccum>,
    user_request: String,
    timeline: Timeline,
    initiator: &'static str,
    title: Option<String>,
    entrypoint: Option<String>,
}

impl ClaudeAccum {
    pub fn new(max_entries: usize, max_bytes: usize) -> Self {
        ClaudeAccum {
            workspace: String::new(),
            model: String::new(),
            first_timestamp: String::new(),
            last_timestamp: String::new(),
            has_fast_mode: false,
            saw_standard_speed: false,
            blend_turns: Vec::new(),
            idx: 0,
            pending_reads: IndexMap::new(),
            seen_message_ids: IndexSet::new(),
            sub_agents: IndexMap::new(),
            pending_tool_results: IndexMap::new(),
            gen_files: IndexMap::new(),
            total_input: 0.0,
            total_output: 0.0,
            total_cache_read: 0.0,
            total_cache_create: 0.0,
            peak_context_per_turn: 0.0,
            turns: 0,
            total_tool_calls: 0,
            tool_counts: IndexMap::new(),
            files_read: IndexSet::new(),
            files_changed: IndexSet::new(),
            files_written: IndexSet::new(),
            files_searched: IndexSet::new(),
            file_ops: IndexMap::new(),
            user_request: String::new(),
            timeline: Timeline::new(max_entries, max_bytes),
            initiator: "user",
        title: None,
            entrypoint: None,
        }
    }
}

// ── Text-content helpers (logReader.ts) ───────────────────────────────────────────

/// TS `_extractTextContent`: a string content trimmed, else the FIRST non-empty text block.
fn extract_text_content(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => js_trim(s).to_owned(),
        Some(Value::Array(blocks)) => {
            for b in blocks {
                if as_str(b.get("type")) == Some("text") {
                    if let Some(t) = as_str(b.get("text")) {
                        if !js_trim(t).is_empty() {
                            return js_trim(t).to_owned();
                        }
                    }
                }
            }
            String::new()
        }
        _ => String::new(),
    }
}

/// TS `_toolResultBytes`: UTF-8 bytes of a result's string content or its {text} blocks.
fn tool_result_bytes(content: Option<&Value>) -> u64 {
    match content {
        Some(Value::String(s)) => s.len() as u64,
        Some(Value::Array(blocks)) => blocks
            .iter()
            .map(|b| as_str(b.get("text")).map(|t| t.len() as u64).unwrap_or(0))
            .sum(),
        _ => 0,
    }
}

/// TS `_toolResultText`: the FULL text (string or joined {text} blocks), snipped at 500k.
fn tool_result_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => snip(s, MAX_TOOL_RESULT_CHARS),
        Some(Value::Array(blocks)) => {
            let joined: String = blocks
                .iter()
                .filter_map(|b| as_str(b.get("text")))
                .collect();
            snip(&joined, MAX_TOOL_RESULT_CHARS)
        }
        _ => String::new(),
    }
}

/// TS `_editInputBytes`: MultiEdit sums edits[].new_string; else new_string/newString/content.
fn edit_input_bytes(inp: &serde_json::Map<String, Value>) -> u64 {
    if let Some(Value::Array(edits)) = inp.get("edits") {
        return edits
            .iter()
            .map(|e| {
                let m = e.as_object();
                m.and_then(|m| {
                    as_str(m.get("new_string")).or_else(|| as_str(m.get("newString")))
                })
                .map(|s| s.len() as u64)
                .unwrap_or(0)
            })
            .sum();
    }
    ["new_string", "newString", "content"]
        .iter()
        .find_map(|k| match inp.get(*k) {
            None | Some(Value::Null) => None,
            Some(v) => Some(v),
        })
        .and_then(Value::as_str)
        .map(|s| s.len() as u64)
        .unwrap_or(0)
}

// ── Scratch-path harvest (src/generatedFiles.ts) ──────────────────────────────────

/// TS SCRATCH_RE: `(?:^|\/)(?:private\/tmp|tmp|var\/folders\/[^/]+\/[^/]+\/[A-Za-z])\/claude-[^/]+\/`
fn is_claude_scratch_path(p: &str) -> bool {
    // Hand-rolled to avoid a regex dependency; segment-exact per the TS pattern.
    let bytes = p.as_bytes();
    let mut starts: Vec<usize> = vec![0];
    for (i, b) in bytes.iter().enumerate() {
        if *b == b'/' {
            starts.push(i + 1);
        }
    }
    for &s in &starts {
        let rest = &p[s..];
        for root_len in root_match_lens(rest) {
            let after = &rest[root_len..];
            if let Some(tail) = after.strip_prefix("/claude-") {
                if let Some(slash) = tail.find('/') {
                    if slash > 0 {
                        return true;
                    }
                }
            }
        }
    }
    false
}

/// Lengths of the temp-root alternatives matching at the head of `rest`.
fn root_match_lens(rest: &str) -> Vec<usize> {
    let mut out = Vec::new();
    if rest.starts_with("private/tmp") {
        out.push("private/tmp".len());
    }
    if rest.starts_with("tmp") {
        out.push(3);
    }
    if let Some(r) = rest.strip_prefix("var/folders/") {
        // var/folders/[^/]+/[^/]+/[A-Za-z]
        let mut idx = "var/folders/".len();
        let parts: Vec<&str> = r.splitn(3, '/').collect();
        if parts.len() == 3 && !parts[0].is_empty() && !parts[1].is_empty() {
            idx += parts[0].len() + 1 + parts[1].len() + 1;
            if parts[2].chars().next().is_some_and(|c| c.is_ascii_alphabetic()) {
                out.push(idx + 1);
            }
        }
    }
    out
}

/// TS `scratchPathsInToolInput`: known keys + any whitespace-free top-level string value.
fn scratch_paths_in_tool_input(inp: &serde_json::Map<String, Value>) -> Vec<String> {
    let mut out: IndexSet<String> = IndexSet::new();
    for key in ["file_path", "filePath", "path", "notebook_path", "output_file", "output-file", "outputFile"] {
        if let Some(Value::String(s)) = inp.get(key) {
            if is_claude_scratch_path(s) {
                out.insert(s.clone());
            }
        }
    }
    for v in inp.values() {
        if let Value::String(s) = v {
            if !s.chars().any(char::is_whitespace) && is_claude_scratch_path(s) {
                out.insert(s.clone());
            }
        }
    }
    out.into_iter().collect()
}

/// TS `scratchPathsInToolUseResult`: documented output-file keys only.
fn scratch_paths_in_tool_use_result(tur: Option<&serde_json::Map<String, Value>>) -> Vec<String> {
    let Some(tur) = tur else { return Vec::new() };
    let mut out: IndexSet<String> = IndexSet::new();
    for key in ["output-file", "output_file", "outputFile", "filePath", "file_path", "path"] {
        if let Some(Value::String(s)) = tur.get(key) {
            if is_claude_scratch_path(s) {
                out.insert(s.clone());
            }
        }
    }
    out.into_iter().collect()
}

// ── Per-entry handler (_claudeOnEntry) ────────────────────────────────────────────

fn add_file_op(a: &mut ClaudeAccum, fp: &str, op: u8, bytes: u64) {
    let fo = a.file_ops.entry(fp.to_owned()).or_default();
    match op {
        0 => { fo.read_bytes += bytes; fo.read_count += 1 }
        1 => { fo.write_bytes += bytes; fo.write_count += 1 }
        _ => { fo.edit_bytes += bytes; fo.edit_count += 1 }
    }
}

fn record_sub_agent_spawn(a: &mut ClaudeAccum, block: &serde_json::Map<String, Value>, inp: &serde_json::Map<String, Value>, ts: Option<&str>) {
    let Some(tid) = as_str(block.get("id")) else { return };
    if a.sub_agents.contains_key(tid) {
        return;
    }
    let tool_name = as_str(block.get("name"));
    let subagent_type = as_str(inp.get("subagent_type"));
    let isolation = as_str(inp.get("isolation"));
    let model_override = as_str(inp.get("model"));
    let spawn_kind = if tool_name == Some("Workflow") {
        "fleet"
    } else if subagent_type == Some("fork") {
        "fork"
    } else if isolation == Some("worktree") {
        "worktree"
    } else {
        "fresh"
    };
    // TS: requestedType = (subagent_type ?? inp.description) as string — a non-string description
    // survives the ?? and the cast, but downstream uses are string-typed; mirror by taking strings.
    let requested_type = subagent_type
        .map(str::to_owned)
        .or_else(|| as_str(inp.get("description")).map(str::to_owned));
    let rec = SubAgentRec {
        tool_use_id: tid.to_owned(),
        spawn_turn: a.turns,
        spawn_ts: ts.unwrap_or("").to_owned(),
        requested_type,
        prompt: as_str(inp.get("prompt")).map(|p| cap_text(p, FIELD_MAX_CHARS)),
        spawn_kind: Some(spawn_kind),
        spawn_model_override: model_override.map(str::to_owned),
        spawn_isolation: isolation.map(str::to_owned),
        ..Default::default()
    };
    bounded_insert(&mut a.sub_agents, tid.to_owned(), rec);
}

fn complete_sub_agent(sub: &mut SubAgentRec, tur: &serde_json::Map<String, Value>, result_content: Option<&Value>) {
    let usage = tur.get("usage").and_then(Value::as_object);
    let total_tokens = tur.get("totalTokens").and_then(Value::as_f64);
    if usage.is_none() || total_tokens.is_none() {
        if as_str(tur.get("status")) == Some("async_launched") {
            if let Some(aid) = as_str(tur.get("agentId")) {
                sub.agent_id = Some(aid.to_owned());
            }
            if let Some(m) = as_str(tur.get("resolvedModel")) {
                sub.model = Some(m.to_owned());
            }
            if sub.agent_type.is_none() {
                sub.agent_type = sub.requested_type.clone();
            }
            sub.is_async = true;
            sub.done = true;
        }
        return;
    }
    let usage = usage.unwrap();
    sub.is_async = false;
    let b = disjoint_anthropic(usage);
    sub.input = b.input;
    sub.output = b.output;
    sub.cache_read = b.cache_read;
    sub.cache_create = b.cache_create;
    sub.total_tokens = total_tokens.unwrap();
    sub.tool_use_count = tur.get("totalToolUseCount").and_then(Value::as_f64).unwrap_or(0.0);
    sub.duration_ms = tur.get("totalDurationMs").and_then(Value::as_f64).unwrap_or(0.0);
    sub.agent_id = as_str(tur.get("agentId")).map(str::to_owned);
    sub.agent_type = as_str(tur.get("agentType"))
        .map(str::to_owned)
        .or_else(|| sub.requested_type.clone());
    sub.model = as_str(tur.get("resolvedModel")).map(str::to_owned);
    sub.tool_stats = tur.get("toolStats").and_then(Value::as_object).cloned();
    let final_full = extract_text_content(result_content);
    sub.final_text = if final_full.is_empty() { None } else { Some(snip(&final_full, 4000)) };
    sub.done = true;
}

fn harvest_generated_file(a: &mut ClaudeAccum, p: String, span_id: Option<String>) {
    if let Some(prev) = a.gen_files.get(&p) {
        if prev.is_some() {
            return; // never downgrade a known correlation
        }
    }
    a.gen_files.insert(p, span_id);
}

fn resolve_tool_result(a: &mut ClaudeAccum, id: &str, block: &serde_json::Map<String, Value>, tool_use_result: Option<&serde_json::Map<String, Value>>) {
    if let Some(fp) = a.pending_reads.shift_remove(id) {
        let bytes = tool_result_bytes(block.get("content"));
        add_file_op(a, &fp, 0, bytes);
    }
    if let Some(tur) = tool_use_result {
        if let Some(sub) = a.sub_agents.get_mut(id) {
            complete_sub_agent(sub, tur, block.get("content"));
        }
    }
    if let Some(entry) = a.pending_tool_results.shift_remove(id) {
        let full = tool_result_text(block.get("content"));
        if !full.is_empty() {
            a.timeline.attach_full_result(&entry, &full);
            let mut e = entry.borrow_mut();
            if e.result_summary.is_none() {
                e.result_summary = Some(snip(&full, 200));
            }
        }
        let span_id = entry.borrow().span_id.clone();
        for p in scratch_paths_in_tool_use_result(tool_use_result) {
            harvest_generated_file(a, p, Some(span_id.clone()));
        }
    } else {
        for p in scratch_paths_in_tool_use_result(tool_use_result) {
            harvest_generated_file(a, p, None);
        }
    }
}

pub fn on_entry(a: &mut ClaudeAccum, entry: &serde_json::Map<String, Value>) {
    let ts = as_str(entry.get("timestamp"));
    if let Some(ts) = ts {
        if a.first_timestamp.is_empty() {
            a.first_timestamp = ts.to_owned();
        }
        a.last_timestamp = ts.to_owned();
    }
    if a.workspace.is_empty() {
        if let Some(cwd) = entry.get("cwd") {
            if !matches!(cwd, Value::Null) {
                // TS: `if (entry['cwd'] && !a.workspace)` — any truthy value; transcripts write strings.
                if let Some(s) = cwd.as_str() {
                    if !s.is_empty() {
                        a.workspace = s.to_owned();
                    }
                }
            }
        }
    }
    let entry_type = as_str(entry.get("type"));
    if entry_type == Some("ai-title") {
        if let Some(t) = as_str(entry.get("aiTitle")) {
            if !t.is_empty() {
                a.title = Some(t.to_owned());
            }
        }
    }
    if a.entrypoint.is_none() {
        if let Some(e) = as_str(entry.get("entrypoint")) {
            if !e.is_empty() {
                a.entrypoint = Some(e.to_owned());
            }
        }
    }

    if entry_type == Some("user") {
        if a.user_request.is_empty() && entry.get("isSidechain") == Some(&Value::Bool(true)) {
            a.initiator = "agent";
        }
        let content = entry.get("message").and_then(Value::as_object).and_then(|m| m.get("content"));
        let text = extract_text_content(content);
        if a.user_request.is_empty() && !text.is_empty() {
            if a.initiator == "user" && text.starts_with("<local-command-caveat>") {
                a.initiator = "api";
                let after = strip_local_command_caveat(&text);
                a.user_request = if after.is_empty() { "[api session]".to_owned() } else { after };
            } else {
                a.user_request = text.clone();
            }
        }
        if let Some(Value::Array(blocks)) = content {
            let tool_use_result = entry.get("toolUseResult").and_then(Value::as_object);
            let result_blocks: Vec<&serde_json::Map<String, Value>> = blocks
                .iter()
                .filter_map(Value::as_object)
                .filter(|b| as_str(b.get("type")) == Some("tool_result") && as_str(b.get("tool_use_id")).is_some())
                .collect();
            let attributable = if result_blocks.len() == 1 { tool_use_result } else { None };
            for block in result_blocks {
                let id = as_str(block.get("tool_use_id")).unwrap().to_owned();
                resolve_tool_result(a, &id, block, attributable);
            }
        }
        let e = TimelineEntry {
            entry_type: "user_input",
            span_id: format!("log-u-{}", a.idx),
            label: "User".to_owned(),
            turn: Some(a.turns + 1),
            action: None,
            tool_input: None,
            error_message: None,
            model: None,
            input_tokens: None,
            output_tokens: None,
            cache_read_tokens: None,
            cache_create_tokens: None,
            duration_ms: 0.0,
            is_error: false,
            timestamp: ts.unwrap_or("").to_owned(),
            response_text: Some(cap_text(&text, FIELD_MAX_CHARS)),
            result_summary: None,
            full_result: None,
        };
        a.timeline.push_bounded(e);
        a.idx += 1;
    }

    if entry_type == Some("assistant") {
        let msg = entry.get("message").and_then(Value::as_object);
        let row_model = msg.and_then(|m| as_str(m.get("model")));
        if let Some(m) = row_model {
            if !m.is_empty() && m != "<synthetic>" {
                a.model = m.to_owned();
            }
        }
        let message_id = msg.and_then(|m| as_str(m.get("id"))).map(str::to_owned);
        let is_first_row = match &message_id {
            None => true,
            Some(id) => !a.seen_message_ids.contains(id.as_str()),
        };
        if let Some(id) = &message_id {
            bounded_add(&mut a.seen_message_ids, id.clone());
        }
        let raw_usage = msg.and_then(|m| m.get("usage")).and_then(Value::as_object);
        let row_fast = raw_usage.and_then(|u| as_str(u.get("speed"))) == Some("fast");
        if row_fast {
            a.has_fast_mode = true;
        }
        let mut row_buckets: Option<Buckets> = None;
        if let Some(usage) = raw_usage {
            if is_first_row {
                let b = disjoint_anthropic(usage);
                a.total_input += b.input;
                a.total_output += b.output;
                a.total_cache_read += b.cache_read;
                a.total_cache_create += b.cache_create;
                let turn_context = b.input + b.cache_read + b.cache_create;
                if turn_context > a.peak_context_per_turn {
                    a.peak_context_per_turn = turn_context;
                }
                a.turns += 1;
                if !row_fast {
                    a.saw_standard_speed = true;
                }
                let turn_model = if row_fast && !a.model.is_empty() {
                    format!("{}-fast", a.model)
                } else {
                    a.model.clone()
                };
                a.blend_turns.push(BlendTurn {
                    model: turn_model,
                    fast: row_fast,
                    input: b.input,
                    output: b.output,
                    cache_read: b.cache_read,
                    cache_create: b.cache_create,
                });
                row_buckets = Some(b);
            }
        }
        let content: &[Value] = msg
            .and_then(|m| m.get("content"))
            .and_then(Value::as_array)
            .map(Vec::as_slice)
            .unwrap_or(&[]);
        let mut has_tool_call = false;
        let mut row_tool_use_ids: Vec<String> = Vec::new();
        let mut row_gen_paths: Vec<String> = Vec::new();
        let empty_map = serde_json::Map::new();
        for block in content.iter().filter_map(Value::as_object) {
            if as_str(block.get("type")) == Some("tool_use") {
                let Some(name) = as_str(block.get("name")) else { continue };
                if name.is_empty() {
                    continue;
                }
                has_tool_call = true;
                a.total_tool_calls += 1;
                *a.tool_counts.entry(name.to_owned()).or_insert(0) += 1;
                if let Some(bid) = as_str(block.get("id")) {
                    row_tool_use_ids.push(bid.to_owned());
                }
                let inp = block.get("input").and_then(Value::as_object).unwrap_or(&empty_map);
                for p in scratch_paths_in_tool_input(inp) {
                    row_gen_paths.push(p);
                }
                if name == "Task" || name == "Agent" || name == "Workflow" {
                    record_sub_agent_spawn(a, block, inp, ts);
                }
                let fp = coalesce_string(inp, &["file_path", "filePath", "path"]);
                if !fp.is_empty() {
                    if name == "Read" || name == "read_file" {
                        a.files_read.insert(fp.clone());
                        if let Some(id) = as_str(block.get("id")) {
                            bounded_insert(&mut a.pending_reads, id.to_owned(), fp.clone());
                        }
                    } else if ["Edit", "MultiEdit", "replace_string_in_file", "NotebookEdit"].contains(&name) {
                        a.files_changed.insert(fp.clone());
                        let bytes = edit_input_bytes(inp);
                        add_file_op(a, &fp, 2, bytes);
                    } else if name == "Write" || name == "create_file" {
                        a.files_changed.insert(fp.clone());
                        a.files_written.insert(fp.clone());
                        let bytes = as_str(inp.get("content")).map(|s| s.len() as u64).unwrap_or(0);
                        add_file_op(a, &fp, 1, bytes);
                    }
                }
            }
        }
        let response_text = content
            .iter()
            .filter_map(Value::as_object)
            .find(|b| as_str(b.get("type")) == Some("text"))
            .and_then(|b| as_str(b.get("text")));
        let e = TimelineEntry {
            entry_type: if has_tool_call { "tool" } else { "llm" },
            span_id: format!("log-a-{}", a.idx),
            label: if has_tool_call { "Tool calls" } else { "Response" }.to_owned(),
            turn: Some(a.turns),
            action: None,
            tool_input: None,
            error_message: None,
            model: if a.model.is_empty() { None } else { Some(a.model.clone()) },
            input_tokens: row_buckets.map(|b| b.input),
            output_tokens: row_buckets.map(|b| b.output),
            cache_read_tokens: row_buckets.map(|b| b.cache_read),
            cache_create_tokens: row_buckets.map(|b| b.cache_create),
            duration_ms: 0.0,
            is_error: false,
            timestamp: ts.unwrap_or("").to_owned(),
            response_text: response_text.map(|t| cap_text(t, FIELD_MAX_CHARS)),
            result_summary: None,
            full_result: None,
        };
        let entry_ref = a.timeline.push_bounded(e);
        for tid in row_tool_use_ids {
            bounded_insert(&mut a.pending_tool_results, tid, Rc::clone(&entry_ref));
        }
        if !row_gen_paths.is_empty() {
            let span_id = entry_ref.borrow().span_id.clone();
            for p in row_gen_paths {
                harvest_generated_file(a, p, Some(span_id.clone()));
            }
        }
        a.idx += 1;
    }
}

/// TS regex `/^<local-command-caveat>[\s\S]*?<\/local-command-caveat>\s*/i` — case-insensitive,
/// non-greedy: strip through the FIRST closing tag plus trailing whitespace, then trim.
fn strip_local_command_caveat(text: &str) -> String {
    let lower = text.to_lowercase();
    let close = "</local-command-caveat>";
    if let Some(pos) = lower.find(close) {
        let mut rest = &text[pos + close.len()..];
        rest = rest.trim_start_matches(|c: char| c.is_whitespace() || c == '\u{FEFF}');
        js_trim(rest).to_owned()
    } else {
        js_trim(text).to_owned()
    }
}

// ── Card assembly (_buildCard + _buildSubAgentCards + _parseClaudeFile tail) ──────

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileOpSummary {
    pub path: String,
    #[serde(flatten)]
    pub ops: FileOpAccum,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Card {
    pub session_id: String,
    pub trace_id: String,
    pub source: &'static str,
    pub data_source: &'static str,
    pub tokens_source: &'static str,
    pub initiator: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parent_session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawned_by_turn: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawn_kind: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawn_model_override: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawn_isolation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawn_subagent_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spawn_async: Option<bool>,
    pub workspace: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entrypoint: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeline_truncated_count: Option<u64>,
    pub user_request: String,
    pub model: String,
    pub turns: u64,
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cache_read_tokens: f64,
    pub cache_create_tokens: f64,
    pub cache_hit_rate: f64,
    pub duration_ms: f64,
    pub start_time: String,
    pub files_read: Vec<String>,
    pub files_searched: Vec<String>,
    pub files_changed: Vec<String>,
    pub files_written: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub file_ops: Option<Vec<FileOpSummary>>,
    pub tool_counts: IndexMap<String, u64>,
    pub total_tool_calls: u64,
    pub total_llm_calls: u64,
    pub errors: u64,
    pub outcome: &'static str,
    pub timeline: Vec<TimelineEntry>,
    /// Present (as 0) ONLY on a hot-age-stripped card — exactly the field shape TS
    /// `stripTimeline` leaves behind (it assigns timelineRetainedBytes = 0 on the card).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeline_retained_bytes: Option<u64>,
    pub background_spans: Vec<Value>,
    pub loop_signals: Vec<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub peak_context_per_turn: Option<f64>,
}

impl Card {
    /// TS `stripTimeline`: cold sessions must leave the parser WITHOUT a timeline — on a
    /// 12k-file boot scan the results array itself holds every card (TRDD-66IXMIGN fifth
    /// repro), and here the NDJSON stream additionally balloons past pipe buffers (measured:
    /// 1.2GB unstripped vs tens of MB stripped). Early-return on empty keeps it idempotent
    /// with the TS wrapper's own strip.
    pub fn strip_timeline(&mut self) {
        if self.timeline.is_empty() {
            return;
        }
        self.timeline_truncated_count =
            Some(self.timeline_truncated_count.unwrap_or(0) + self.timeline.len() as u64);
        self.timeline.clear();
        self.timeline_retained_bytes = Some(0);
    }
}

/// One parsed transcript, as the TS wrapper consumes it. `blend_turns` is present only for a
/// MIXED-speed session (the only case speedBlendedCostUsd is used); `gen_files` carries the
/// harvested scratch paths for attachGeneratedFiles on the TS side.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedTranscript {
    pub file: String,
    pub workspace: String,
    pub card: Card,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub child_cards: Vec<Card>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub gen_files: Vec<GenFileRef>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blend_turns: Option<Vec<BlendTurn>>,
    pub last_timestamp_ms: i64,
    /// Bytes actually parsed — the TS caller records this as the fileState tail offset so its
    /// next scan resumes/skips correctly (growth after our read mismatches and reparses, which
    /// is the conservative-safe direction).
    pub file_size_bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GenFileRef {
    pub path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub span_id: Option<String>,
}

pub(crate) fn parse_ts_ms(ts: &str) -> i64 {
    if ts.is_empty() {
        return 0;
    }
    if let Some(ms) = agentlens_spanstore::parse_iso_ms(ts) {
        return ms;
    }
    // TS fallback: unix NANOSECONDS as a bare number string.
    if let Ok(n) = ts.parse::<i64>() {
        if n > 1_000_000_000_000_000 {
            return n / 1_000_000;
        }
    }
    0
}

/// `new Date(ms).toISOString()` — always `YYYY-MM-DDTHH:MM:SS.mmmZ`.
pub(crate) fn iso_from_ms(ms: i64) -> String {
    let days = ms.div_euclid(86_400_000);
    let rem = ms.rem_euclid(86_400_000);
    let (y, mo, d) = agentlens_spanstore::civil_from_days(days);
    let (h, mi, s, mil) = (rem / 3_600_000, rem / 60_000 % 60, rem / 1000 % 60, rem % 1000);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}.{mil:03}Z")
}

fn build_sub_agent_cards(parent_session_id: &str, a: &ClaudeAccum) -> Vec<Card> {
    let mut cards = Vec::new();
    for sub in a.sub_agents.values() {
        if !sub.done {
            continue;
        }
        let sid = sub
            .agent_id
            .clone()
            .unwrap_or_else(|| format!("{}-sub-{}", parent_session_id, sub.tool_use_id));
        let mut tool_counts: IndexMap<String, u64> = IndexMap::new();
        if let Some(stats) = &sub.tool_stats {
            for (k, label) in [
                ("readCount", "Read"),
                ("searchCount", "Search"),
                ("bashCount", "Bash"),
                ("editFileCount", "Edit"),
                ("otherToolCount", "Other"),
            ] {
                let n = stats.get(k).and_then(Value::as_f64).unwrap_or(0.0);
                if n > 0.0 {
                    tool_counts.insert(label.to_owned(), n as u64);
                }
            }
        }
        let start_ms = parse_ts_ms(&sub.spawn_ts);
        let timeline = match &sub.final_text {
            Some(text) => vec![TimelineEntry {
                entry_type: "llm",
                span_id: format!("{sid}-out"),
                label: "Sub-agent output".to_owned(),
                turn: Some(1),
                action: None,
                tool_input: None,
                error_message: None,
                model: None,
                input_tokens: None,
                output_tokens: None,
                cache_read_tokens: None,
                cache_create_tokens: None,
                duration_ms: sub.duration_ms,
                is_error: false,
                timestamp: sub.spawn_ts.clone(),
                response_text: Some(text.clone()),
                result_summary: None,
                full_result: None,
            }],
            None => Vec::new(),
        };
        let user_request = sub
            .prompt
            .clone()
            .or_else(|| sub.agent_type.clone())
            .unwrap_or_else(|| "sub-agent".to_owned());
        cards.push(Card {
            session_id: sid.clone(),
            trace_id: sid,
            source: "claude_code",
            data_source: "log",
            tokens_source: "log",
            initiator: "agent",
            parent_session_id: Some(parent_session_id.to_owned()),
            spawned_by_turn: Some(sub.spawn_turn),
            spawn_kind: sub.spawn_kind,
            spawn_model_override: sub.spawn_model_override.clone(),
            spawn_isolation: sub.spawn_isolation.clone(),
            spawn_subagent_type: sub.requested_type.clone(),
            spawn_async: if sub.is_async { Some(true) } else { None },
            workspace: a.workspace.clone(),
            title: None,
            entrypoint: None,
            timeline_truncated_count: None,
            user_request: snip(&user_request, 500),
            model: sub
                .model
                .clone()
                .filter(|m| !m.is_empty())
                .unwrap_or_else(|| if a.model.is_empty() { "claude".to_owned() } else { a.model.clone() }),
            turns: 1,
            input_tokens: sub.input,
            output_tokens: sub.output,
            cache_read_tokens: sub.cache_read,
            cache_create_tokens: sub.cache_create,
            cache_hit_rate: if sub.total_tokens > 0.0 { sub.cache_read / sub.total_tokens } else { 0.0 },
            duration_ms: sub.duration_ms,
            start_time: if start_ms > 0 { iso_from_ms(start_ms) } else { String::new() },
            files_read: Vec::new(),
            files_searched: Vec::new(),
            files_changed: Vec::new(),
            files_written: Vec::new(),
            file_ops: None,
            tool_counts,
            total_tool_calls: sub.tool_use_count as u64,
            total_llm_calls: 1,
            errors: 0,
            outcome: if sub.is_async {
                "unknown"
            } else if sub.tool_use_count > 0.0 {
                "tool_calls"
            } else {
                "text_response"
            },
            timeline,
            timeline_retained_bytes: None,
            background_spans: Vec::new(),
            loop_signals: Vec::new(),
            peak_context_per_turn: None,
        });
    }
    cards
}

/// The `_parseClaudeFile` assembly: build the card, stamp fast-mode, link worktree/subagent
/// parents from the PATH, synthesize child cards. Returns None when the transcript never
/// produced a timestamp (same `!a.firstTimestamp` bail as TS).
pub fn build_result(file_path: &str, a: ClaudeAccum) -> Option<ParsedTranscript> {
    if a.first_timestamp.is_empty() {
        return None;
    }
    let mixed_speed = a.has_fast_mode && a.saw_standard_speed;
    let effective_model = if !a.model.is_empty() && a.has_fast_mode && !a.saw_standard_speed {
        format!("{}-fast", a.model)
    } else {
        a.model.clone()
    };
    let session_id = std::path::Path::new(file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_owned();

    let start_ms = parse_ts_ms(&a.first_timestamp);
    let end_ms = parse_ts_ms(&a.last_timestamp);
    let duration_ms = if end_ms > 0 && start_ms > 0 { (end_ms - start_ms).max(0) } else { 0 };
    let total_context = a.total_input + a.total_cache_read + a.total_cache_create;
    let cache_hit_rate = if total_context > 0.0 { a.total_cache_read / total_context } else { 0.0 };

    let mut card = Card {
        session_id: session_id.clone(),
        trace_id: session_id.clone(),
        source: "claude_code",
        data_source: "log",
        tokens_source: "log",
        initiator: a.initiator,
        parent_session_id: None,
        spawned_by_turn: None,
        spawn_kind: None,
        spawn_model_override: None,
        spawn_isolation: None,
        spawn_subagent_type: None,
        spawn_async: None,
        workspace: a.workspace.clone(),
        title: a.title.as_ref().map(|t| snip(t, 200)),
        entrypoint: a.entrypoint.clone(),
        timeline_truncated_count: if a.timeline.truncated_count > 0 { Some(a.timeline.truncated_count) } else { None },
        user_request: snip(&a.user_request, 500),
        model: if effective_model.is_empty() { "claude".to_owned() } else { effective_model },
        turns: a.turns,
        input_tokens: a.total_input,
        output_tokens: a.total_output,
        cache_read_tokens: a.total_cache_read,
        cache_create_tokens: a.total_cache_create,
        cache_hit_rate,
        duration_ms: duration_ms as f64,
        start_time: if start_ms > 0 { iso_from_ms(start_ms) } else { String::new() },
        files_read: a.files_read.iter().cloned().collect(),
        files_searched: a.files_searched.iter().cloned().collect(),
        files_changed: a.files_changed.iter().cloned().collect(),
        files_written: a.files_written.iter().cloned().collect(),
        file_ops: if a.file_ops.is_empty() {
            None
        } else {
            Some(a.file_ops.iter().map(|(p, f)| FileOpSummary { path: p.clone(), ops: f.clone() }).collect())
        },
        tool_counts: a.tool_counts.clone(),
        total_tool_calls: a.total_tool_calls,
        total_llm_calls: a.turns,
        errors: 0,
        outcome: if a.total_tool_calls > 0 { "tool_calls" } else { "text_response" },
        timeline: a.timeline.entries.iter().map(|e| e.borrow().clone()).collect(),
        timeline_retained_bytes: None,
        background_spans: Vec::new(),
        loop_signals: Vec::new(),
        peak_context_per_turn: if a.turns > 1 { Some(a.peak_context_per_turn) } else { None },
    };

    // Fleet/subagent parent linkage from the PATH (no guessing — the dir layout IS the link).
    let parent = std::path::Path::new(file_path).parent();
    let proj = parent.and_then(|p| p.file_name()).and_then(|s| s.to_str()).unwrap_or("");
    if let Some(idx) = proj.find("-claude-worktrees") {
        if idx > 0 {
            card.parent_session_id = Some(proj[..idx].trim_end_matches('-').to_owned());
            card.initiator = "agent";
        }
    } else if proj == "subagents" {
        card.parent_session_id = parent
            .and_then(|p| p.parent())
            .and_then(|p| p.file_name())
            .and_then(|s| s.to_str())
            .map(str::to_owned);
        card.initiator = "agent";
    }

    let child_cards = build_sub_agent_cards(&card.session_id, &a);
    let last_ms = parse_ts_ms(if a.last_timestamp.is_empty() { &a.first_timestamp } else { &a.last_timestamp });
    Some(ParsedTranscript {
        file: file_path.to_owned(),
        workspace: a.workspace.clone(),
        card,
        child_cards,
        gen_files: a
            .gen_files
            .iter()
            .map(|(p, s)| GenFileRef { path: p.clone(), span_id: s.clone() })
            .collect(),
        blend_turns: if mixed_speed { Some(a.blend_turns) } else { None },
        last_timestamp_ms: last_ms,
        file_size_bytes: 0, // stamped by parse_transcript, which knows the read length
    })
}

/// Parse one transcript file cold (whole file). Corrupt/partial lines skip, never fail the file.
pub fn parse_transcript(file_path: &str, max_entries: usize, max_bytes: usize) -> std::io::Result<Option<ParsedTranscript>> {
    let bytes = std::fs::read(file_path)?;
    let mut a = ClaudeAccum::new(max_entries, max_bytes);
    for line in bytes.split(|b| *b == b'\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(v) = serde_json::from_slice::<Value>(line) else { continue };
        if let Value::Object(entry) = v {
            on_entry(&mut a, &entry);
        }
    }
    Ok(build_result(file_path, a).map(|mut r| {
        r.file_size_bytes = bytes.len() as u64;
        r
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_helpers_measure_code_units_not_bytes() {
        assert_eq!(utf16_len("abc"), 3);
        assert_eq!(utf16_len("é"), 1);
        assert_eq!(utf16_len("𝄞"), 2); // astral → surrogate pair
        assert_eq!(utf16_slice("a𝄞b", 3), "a𝄞");
        assert_eq!(utf16_slice("a𝄞b", 2), "a"); // split pair dropped whole
    }

    #[test]
    fn cap_text_marks_the_cut_in_utf16_units() {
        let s = "x".repeat(10);
        assert_eq!(cap_text(&s, 10), s);
        let capped = cap_text(&s, 4);
        assert_eq!(capped, "xxxx\n…[retention: 6 chars truncated]");
    }

    #[test]
    fn scratch_path_predicate_matches_the_ts_regex() {
        assert!(is_claude_scratch_path("/tmp/claude-501/x/y.md"));
        assert!(is_claude_scratch_path("/private/tmp/claude-abc/f.txt"));
        assert!(is_claude_scratch_path("/var/folders/ab/cd/T/claude-9/z"));
        assert!(!is_claude_scratch_path("/home/me/claude-project/f.txt"));
        assert!(!is_claude_scratch_path("/tmp/claude-501")); // no trailing segment
    }

    #[test]
    fn local_command_caveat_strips_through_first_close() {
        let t = "<local-command-caveat>stuff</local-command-caveat>  real request";
        assert_eq!(strip_local_command_caveat(t), "real request");
    }
}

//! Port of `src/contextComposition.ts` (TRDD-DMWOBWFH P4w.2, freeze row 32) — reconstructs the
//! per-turn context composition of a Claude session from its raw `.jsonl`, on demand.
//!
//! The file is STREAMED, never read whole: sessions reach multi-GB, and the whole point of this
//! module is that a diagnostic must not be able to OOM the server it is diagnosing.
//!
//! Wire objects are `serde_json::Value` mirroring the TS object literals in insertion order, per
//! this port's design law; an `undefined` field is OMITTED, never null.

use indexmap::IndexMap;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashSet};
use std::io::BufRead;
use std::path::PathBuf;

use agentlens_logscan::discovery::{claude_projects_dirs, Env};

use crate::summarize::helpers::{js_math_round, js_string, num};
use crate::token_estimator::{count_tokens, estimate_tokens_from_bytes};

// Hard caps so an on-demand parse of a huge session never blocks the host unbounded. A session past
// MAX_LINES is reported truncated=true (the breakdown covers what was read).
const MAX_LINES: u64 = 3_000_000;
const TOP_SOURCES: usize = 24;
const MAX_TURNS: usize = 2000;
/// Per-source excerpt cap — P5 renders the ACTUAL injected bytes at a drill leaf, but a huge
/// session (thousands of turns × sources) must never ship an unbounded payload.
const EXCERPT_CAP: usize = 1200;

/// TRDD-PJC8N1HO (OOM P0): bounds the SUM of drill-excerpt bytes across every source/turn, so a
/// huge session can never materialize an unbounded excerpt buffer. Once spent, later sources ship
/// no excerpt (byte/token metadata stays accurate) and the composition is marked truncated.
///
/// `Math.max(1, Number(env) || 16) * 1MB`, JS coercion included: an unset, empty, non-numeric OR
/// ZERO value all fall back to 16 (`0` is falsy), and a negative clamps to 1.
fn excerpt_budget_bytes(env: &Env) -> u64 {
    let mb = env
        .vars
        .get("AGENTLENS_COMPOSITION_TEXT_BUDGET_MB")
        .and_then(|v| v.trim().parse::<f64>().ok())
        .filter(|n| n.is_finite() && *n != 0.0)
        .unwrap_or(16.0);
    (mb.max(1.0) * 1024.0 * 1024.0) as u64
}

/// `Buffer.byteLength(v, 'utf8')` for a string value, 0 for anything else.
fn utf8_len(v: Option<&Value>) -> u64 {
    v.and_then(Value::as_str).map_or(0, |s| s.len() as u64)
}

fn sum_fields(att: &Value, keys: &[&str]) -> u64 {
    keys.iter().map(|k| utf8_len(att.get(*k))).sum()
}

/// The first of `keys` whose value is a NON-EMPTY string.
fn first_text(att: &Value, keys: &[&str]) -> String {
    for k in keys {
        if let Some(s) = att.get(*k).and_then(Value::as_str) {
            if !s.is_empty() {
                return s.to_owned();
            }
        }
    }
    String::new()
}

fn joined_text(v: Option<&Value>) -> String {
    match v {
        Some(Value::Array(items)) => {
            items.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("\n")
        }
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

fn joined_len(v: Option<&Value>) -> u64 {
    match v {
        Some(Value::Array(items)) => items.iter().map(|s| utf8_len(Some(s))).sum(),
        other => utf8_len(other),
    }
}

/// `path.basename` — Node's, which is PLATFORM-DEPENDENT: on POSIX it splits on `/` ONLY, so a
/// Windows-style path in a transcript comes back WHOLE (`basename('C:\\win\\f.txt')` is the entire
/// string, not `f.txt`). Splitting on both separators everywhere looks more "correct" and is a
/// parity break — the oracle caught exactly that. Only Windows cuts backslashes.
fn basename(p: &str) -> &str {
    let cut = |s: &'static [char]| p.rsplit(s).next().unwrap_or(p);
    if cfg!(windows) { cut(&['/', '\\']) } else { cut(&['/']) }
}

/// One classified attachment.
pub struct Classified {
    pub label: String,
    pub kind: &'static str,
    pub bytes: u64,
    pub text: String,
}

/// Classify one `attachment` entry into (label, kind, bytes, text). Returns None for shapes that
/// carry no meaningful injected content (pure deltas with counts only, etc.).
///
/// THE ONE attachment classifier (TRDD-B22NYTOY): contextHistory and conversation consume this
/// same function in the TS — an identical private copy previously lived in contextHistory, and the
/// injected-content taxonomy must never fork. Keep it that way here.
pub fn classify_attachment(att: &Value) -> Option<Classified> {
    // `String(att['type'] ?? '')` — NULLISH then stringified, so a null/absent type is "" while a
    // numeric type stringifies rather than being rejected.
    let t = match att.get("type") {
        None | Some(Value::Null) => String::new(),
        Some(v) => js_string(v),
    };
    // `att['hookName'] ? String(...) : undefined` — TRUTHY, so an empty-string hookName falls back
    // to "unknown" rather than producing "hook: ".
    let hook_name = att
        .get("hookName")
        .filter(|v| crate::summarize::helpers::truthy(v))
        .map(js_string);

    match t.as_str() {
        "hook_additional_context" | "hook_success" | "hook_non_blocking_error" | "async_hook_response" => {
            const F: [&str; 4] = ["content", "stdout", "stderr", "response"];
            let bytes = sum_fields(att, &F);
            if bytes == 0 {
                return None;
            }
            Some(Classified {
                label: format!("hook: {}", hook_name.as_deref().unwrap_or("unknown")),
                kind: "hook",
                bytes,
                text: first_text(att, &F),
            })
        }
        "skill_listing" => Some(Classified {
            label: "skill catalog".into(),
            kind: "skill",
            bytes: utf8_len(att.get("content")),
            text: first_text(att, &["content"]),
        }),
        "deferred_tools_delta" => Some(Classified {
            label: "tool catalog".into(),
            kind: "toolCatalog",
            bytes: joined_len(att.get("addedLines")),
            text: joined_text(att.get("addedLines")),
        }),
        "agent_listing_delta" => Some(Classified {
            label: "agent catalog".into(),
            kind: "agentCatalog",
            bytes: joined_len(att.get("addedLines")),
            text: joined_text(att.get("addedLines")),
        }),
        "mcp_instructions_delta" => {
            // `joinedText(addedBlocks) || joinedText(addedNames)` — `||`, so an EMPTY blocks join
            // falls through to names.
            let blocks = joined_text(att.get("addedBlocks"));
            Some(Classified {
                label: "mcp instructions".into(),
                kind: "mcp",
                bytes: joined_len(att.get("addedBlocks")) + joined_len(att.get("addedNames")),
                text: if blocks.is_empty() { joined_text(att.get("addedNames")) } else { blocks },
            })
        }
        "file" | "edited_text_file" | "compact_file_reference" => {
            // `(displayPath ?? filename ?? path ?? 'file')` — NULLISH chain.
            let name = ["displayPath", "filename", "path"]
                .iter()
                .find_map(|k| match att.get(*k) {
                    None | Some(Value::Null) => None,
                    Some(v) => Some(js_string(v)),
                })
                .unwrap_or_else(|| "file".to_owned());
            let bytes = sum_fields(att, &["content", "text"]);
            if bytes == 0 {
                return None;
            }
            Some(Classified {
                label: format!("file: {}", basename(&name)),
                kind: "file",
                bytes,
                text: first_text(att, &["content", "text"]),
            })
        }
        "task_reminder" => Some(Classified {
            label: "task reminder".into(),
            kind: "reminder",
            bytes: utf8_len(att.get("content")),
            text: first_text(att, &["content"]),
        }),
        "invoked_skills" | "skill" => Some(Classified {
            label: "invoked skills".into(),
            kind: "skill",
            bytes: utf8_len(att.get("content")),
            text: first_text(att, &["content"]),
        }),
        _ => None,
    }
}

/// Locate the `.jsonl` for a sessionId across all Claude project dirs (filename == sessionId).
/// THE ONE canonical resolver (TRDD-B22NYTOY) — it was previously duplicated un-exported in
/// contextHistory, and duplicated resolution logic is exactly how subtle drift starts.
pub fn find_session_file(env: &Env, session_id: &str) -> Option<PathBuf> {
    for dir in claude_projects_dirs(env) {
        let Ok(projects) = std::fs::read_dir(&dir) else { continue };
        for proj in projects.flatten() {
            let candidate = proj.path().join(format!("{session_id}.jsonl"));
            if candidate.exists() {
                return Some(candidate);
            }
        }
    }
    None
}

/// Walk the parent chain upward and return the FIRST ancestor that actually has a `.jsonl` on
/// disk. A fork's immediate parent is often itself a logless sub-agent (agent-… → agent-… → real
/// session), so a single-level lookup can still dead-end. Cycle-safe via the seen-set.
pub fn resolve_logged_ancestor(
    env: &Env,
    session_id: &str,
    parent_of: &dyn Fn(&str) -> Option<String>,
) -> Option<String> {
    let mut seen: HashSet<String> = HashSet::from([session_id.to_owned()]);
    let mut cur = parent_of(session_id);
    while let Some(id) = cur {
        if seen.contains(&id) {
            break;
        }
        seen.insert(id.clone());
        if find_session_file(env, &id).is_some() {
            return Some(id);
        }
        cur = parent_of(&id);
    }
    None
}

/// One-pass index of every Claude session that actually has a `.jsonl` on disk.
///
/// Load-bearing for the cross-session aggregators: the session list is a recency-ordered mix
/// dominated, during active work, by cards with NO reconstructable log — OTEL-only merged sessions
/// (`synth-*`), sub-agent children whose id is an agentId not a file (`agent-*`), and sessions
/// whose log was deleted. Composition returns null for all of those, so a plain `slice(0, 25)`
/// spent its whole budget on dead cards and reported sessionsScanned:0 while real logs sat lower in
/// the list. Filtering by disk presence FIRST guarantees the pool holds only reconstructable ones.
pub fn list_session_file_ids(env: &Env) -> HashSet<String> {
    let mut ids = HashSet::new();
    for dir in claude_projects_dirs(env) {
        let Ok(projects) = std::fs::read_dir(&dir) else { continue };
        for proj in projects.flatten() {
            let Ok(files) = std::fs::read_dir(proj.path()) else { continue };
            for f in files.flatten() {
                let name = f.file_name();
                let name = name.to_string_lossy();
                if let Some(stem) = name.strip_suffix(".jsonl") {
                    ids.insert(stem.to_owned());
                }
            }
        }
    }
    ids
}

#[derive(Default)]
struct Acc {
    kind: &'static str,
    bytes: u64,
    tokens: f64,
    count: f64,
    excerpt: String,
}

/// Reconstruct the per-turn context composition of a Claude session from its raw `.jsonl`.
///
/// NO-OWN-LOG FALLBACK: a fork / sub-agent session has NO `<sessionId>.jsonl` of its own — its
/// transcript lives in its PARENT's log (a fork inherits the parent's context verbatim). So when
/// the own-file lookup fails we reconstruct from the PARENT's log and tag the result with
/// `reconstructedFrom`. When NEITHER exists we still return an HONEST EMPTY composition carrying
/// `reconstructedFrom` whenever a parent id is known, so the UI shows a terminal
/// "transcript lives in parent" message instead of spinning forever. Only the pure OTEL/synth case
/// (no file, no parent) returns None.
pub fn build_context_composition(env: &Env, session_id: &str, parent_session_id: Option<&str>) -> Option<Value> {
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
        // No transcript anywhere. Knowing the parent is still a TERMINAL TRUTH worth returning;
        // only a card with neither is unreconstructable.
        if let Some(parent) = parent_session_id {
            let mut m = Map::new();
            m.insert("sessionId".into(), Value::String(session_id.to_owned()));
            m.insert("turns".into(), Value::Array(Vec::new()));
            m.insert("estimated".into(), Value::Bool(true));
            m.insert("truncated".into(), Value::Bool(false));
            m.insert("reconstructedFrom".into(), Value::String(parent.to_owned()));
            return Some(Value::Object(m));
        }
        return None;
    };

    let budget = excerpt_budget_bytes(env);
    let mut by_turn: BTreeMap<i64, IndexMap<String, Acc>> = BTreeMap::new();
    let mut seen_message_ids: HashSet<String> = HashSet::new();
    let mut assistant_turns: i64 = 0;
    let mut lines: u64 = 0;
    let mut truncated = false;
    let mut excerpt_bytes_stored: u64 = 0;

    let f = std::fs::File::open(&file).ok()?;
    let mut reader = std::io::BufReader::new(f);
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        // read_until + from_utf8_lossy rather than `.lines()`: Node reads this file as utf8 and
        // decodes lossily, so a stray invalid byte must not abort the whole reconstruction.
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
        // `crlfDelay: Infinity` collapses \r\n, so the \r never reaches the JSON parser.
        let line = line.trim_end_matches('\n').trim_end_matches('\r');
        if line.is_empty() {
            continue;
        }
        let Ok(e) = serde_json::from_str::<Value>(line) else { continue };

        let ty = e.get("type").and_then(Value::as_str).unwrap_or("");
        if ty == "assistant" {
            let id = e.get("message").and_then(|m| m.get("id")).and_then(Value::as_str);
            // An assistant entry with NO id always counts; one with an id counts only the first
            // time (the same message can be re-emitted across streaming updates).
            match id {
                None => assistant_turns += 1,
                Some(id) => {
                    if !seen_message_ids.contains(id) {
                        assistant_turns += 1;
                        seen_message_ids.insert(id.to_owned());
                    }
                }
            }
            continue;
        }
        if ty != "attachment" {
            continue;
        }
        let Some(att) = e.get("attachment") else { continue };
        let Some(c) = classify_attachment(att) else { continue };
        if c.bytes == 0 {
            continue;
        }

        // Attribute to the turn this injected content FEEDS: the next assistant turn (1-based),
        // matching the timeline's `user_input` turn = assistantTurns + 1.
        let turn = assistant_turns + 1;
        let sources = by_turn.entry(turn).or_default();
        let cur = sources.entry(c.label.clone()).or_insert_with(|| Acc { kind: c.kind, ..Acc::default() });
        cur.bytes += c.bytes;
        // The real tokenizer on the injected text. When the attachment spans MULTIPLE byte-bearing
        // fields (c.bytes exceeds the text's own bytes) the count is extrapolated by the byte ratio,
        // so the estimate reflects the full injected weight rather than only the first field.
        cur.tokens += if c.text.is_empty() {
            estimate_tokens_from_bytes(c.bytes) as f64
        } else {
            js_math_round(count_tokens(&c.text) * (c.bytes as f64 / (c.text.len() as f64).max(1.0)))
        };
        cur.count += 1.0;
        // Keep the FIRST occurrence's leading text as the drill-leaf excerpt. Later occurrences add
        // only to the byte/token total — one representative excerpt is enough to show real content.
        if cur.excerpt.is_empty() && !c.text.is_empty() {
            if excerpt_bytes_stored < budget {
                cur.excerpt = crate::summarize::helpers::js_slice(&c.text, EXCERPT_CAP).to_owned();
                excerpt_bytes_stored += cur.excerpt.len() as u64;
            } else {
                truncated = true;
            }
        }
    }

    let turns: Vec<Value> = by_turn
        .into_iter()
        .take(MAX_TURNS)
        .map(|(turn, sources)| {
            let mut m = Map::new();
            m.insert("turn".into(), num(turn as f64));
            m.insert("sources".into(), Value::Array(cap_sources(sources)));
            Value::Object(m)
        })
        .collect();

    let mut m = Map::new();
    m.insert("sessionId".into(), Value::String(session_id.to_owned()));
    m.insert("turns".into(), Value::Array(turns));
    m.insert("estimated".into(), Value::Bool(true));
    m.insert("truncated".into(), Value::Bool(truncated));
    if let Some(r) = reconstructed_from {
        m.insert("reconstructedFrom".into(), Value::String(r));
    }
    Some(Value::Object(m))
}

/// Heaviest-first, keep the top TOP_SOURCES, fold the remainder into ONE "other" source so the
/// total stays honest without shipping an unbounded list.
///
/// The sort is STABLE over the map's INSERTION order, so sources tying on tokens keep first-seen
/// order — which is why `sources` is an IndexMap and not a HashMap.
fn cap_sources(sources: IndexMap<String, Acc>) -> Vec<Value> {
    let mut all: Vec<Value> = sources
        .into_iter()
        .map(|(label, s)| {
            let mut m = Map::new();
            m.insert("label".into(), Value::String(label));
            m.insert("kind".into(), Value::String(s.kind.to_owned()));
            m.insert("bytes".into(), num(s.bytes as f64));
            // Fall back to the byte estimator ONLY when the tokenizer produced nothing.
            m.insert("tokens".into(), num(if s.tokens > 0.0 { s.tokens } else { estimate_tokens_from_bytes(s.bytes) as f64 }));
            m.insert("tokenSource".into(), Value::String("estimated".into()));
            m.insert("count".into(), num(s.count));
            // `excerpt: s.excerpt || undefined` — an empty excerpt is OMITTED, never "".
            if !s.excerpt.is_empty() {
                m.insert("excerpt".into(), Value::String(s.excerpt));
            }
            Value::Object(m)
        })
        .collect();
    let tok = |v: &Value| v.get("tokens").and_then(Value::as_f64).unwrap_or(0.0);
    all.sort_by(|a, b| (tok(b) - tok(a)).partial_cmp(&0.0).unwrap_or(std::cmp::Ordering::Equal));
    if all.len() <= TOP_SOURCES {
        return all;
    }
    let rest: Vec<Value> = all.split_off(TOP_SOURCES);
    let sum = |k: &str| -> f64 { rest.iter().map(|s| s.get(k).and_then(Value::as_f64).unwrap_or(0.0)).sum() };
    let mut other = Map::new();
    other.insert("label".into(), Value::String(format!("+{} more sources", rest.len())));
    other.insert("kind".into(), Value::String("other".into()));
    other.insert("bytes".into(), num(sum("bytes")));
    other.insert("tokens".into(), num(sum("tokens")));
    other.insert("tokenSource".into(), Value::String("estimated".into()));
    other.insert("count".into(), num(sum("count")));
    // NOTE: the fold-up carries NO `excerpt` key — it represents many sources, so any single
    // excerpt would misattribute one source's content to the whole bucket.
    all.push(Value::Object(other));
    all
}

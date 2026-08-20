//! Port of src/causingToolCall.ts — given a burn PEAK (a time window plus a session or
//! workspace), EVERY spawn tool-call that could have caused it, VERBATIM, numbered and
//! time-ordered. Not a single "nearest" call: a fork-storm is a SUSTAINED burst driven by
//! potentially many spawns, so reporting one is misleading.
//!
//! DELIBERATE ENGINE DIVERGENCE: the TS streams the NDJSON through DuckDB's read_json because
//! parsing ~2GB transcripts in JS is not viable. Rust parses NDJSON natively line-by-line
//! (for_each_json_line — the same streaming reader the log scanners use, one line buffer), so
//! the DuckDB dependency, its `maximum_object_size` tuning and the `duckdb-unavailable` reason
//! all disappear. The torn-line disclosure is kept and computed the same way: a line that fails
//! to parse is counted and reported, never silently dropped.

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

use crate::summarize::helpers::iso_from_ms;

/// Tools whose call fans out / spawns work — the FORK_STORM candidates.
pub const SPAWN_TOOLS: [&str; 4] = ["Task", "Agent", "Workflow", "SendMessage"];

const DEFAULT_WINDOW_MS: f64 = 15.0 * 60_000.0;
const DEFAULT_FORWARD_SLACK_MS: f64 = 90_000.0;
/// mtime is a coarse "this session was active near the peak" proxy — a session file spans time.
const MTIME_SLACK_MS: f64 = 3_600_000.0;
const MAX_FILES: usize = 8;
/// Claude Code truncates a project slug longer than this before appending its hash.
const SLUG_MAX_LEN: usize = 200;

/// projectSlugOf — every non-alphanumeric character becomes '-'; a bare slug (no separator)
/// passes through unchanged.
pub fn project_slug_of(path_or_slug: &str) -> String {
    let value = path_or_slug.trim();
    if value.is_empty() {
        return String::new();
    }
    if !value.contains('/') && !value.contains('\\') {
        return value.to_owned();
    }
    value.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// resolveProjectSlugs — the naive derivation is exact BELOW the truncation boundary; at or past
/// it the real directory name carries a hash this code deliberately does NOT reproduce (it was
/// measured to be none of md5/sha1/sha256/sha512 over the path or slug), so the name is read off
/// disk instead. Falls back to the naive slug when nothing matches.
pub fn resolve_project_slugs(path_or_slug: &str, roots: &[PathBuf]) -> Vec<String> {
    let naive = project_slug_of(path_or_slug);
    if naive.chars().count() < SLUG_MAX_LEN {
        return vec![naive];
    }
    let head: String = naive.chars().take(SLUG_MAX_LEN).collect();
    let mut found: Vec<String> = Vec::new();
    for root in roots {
        let Ok(rd) = std::fs::read_dir(root) else { continue };
        for name in rd.flatten().filter_map(|e| e.file_name().to_str().map(str::to_owned)) {
            let chars: Vec<char> = name.chars().collect();
            let hashed = chars.len() > SLUG_MAX_LEN && chars[SLUG_MAX_LEN] == '-' && name.starts_with(&head);
            if (name == naive || hashed) && !found.contains(&name) {
                found.push(name);
            }
        }
    }
    if found.is_empty() { vec![naive] } else { found }
}

pub struct CausingCallsOptions<'a> {
    pub at_ms: f64,
    pub session_id: Option<&'a str>,
    pub workspace: Option<&'a str>,
    pub jsonl_path: Option<&'a Path>,
    pub window_ms: Option<f64>,
    pub forward_slack_ms: Option<f64>,
    pub tools: Option<&'a [&'a str]>,
    pub projects_dirs: Vec<PathBuf>,
}

/// Stream a transcript line by line (ONE line buffer — transcripts reach GBs; the P5g lesson
/// that a whole-file read is the memory peak applies here too). `f` sees each raw line; the
/// caller decides what a parse failure means, which is what makes the torn-line count possible
/// (agentlens_logscan::for_each_json_line is crate-private AND hands over parsed maps, so a
/// line that failed to parse would be invisible to it).
fn for_each_line(path: &Path, mut f: impl FnMut(&str)) {
    use std::io::BufRead;
    let Ok(file) = std::fs::File::open(path) else { return };
    let mut reader = std::io::BufReader::new(file);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => return,
            Ok(_) => {}
        }
        while buf.last().is_some_and(|b| *b == b'\n' || *b == b'\r') {
            buf.pop();
        }
        if buf.is_empty() {
            continue;
        }
        f(&String::from_utf8_lossy(&buf));
    }
}

fn mtime_ms(p: &Path) -> Option<f64> {
    let md = std::fs::metadata(p).ok()?;
    md.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() as f64 * 1000.0 + d.subsec_nanos() as f64 / 1e6)
}

/// Candidate transcript file(s) for this peak, most-recently-modified first (capped).
fn resolve_transcripts(opts: &CausingCallsOptions) -> Vec<PathBuf> {
    if let Some(p) = opts.jsonl_path {
        return if std::fs::metadata(p).is_ok() { vec![p.to_path_buf()] } else { Vec::new() };
    }
    if let Some(sid) = opts.session_id.filter(|s| !s.is_empty()) {
        let mut out = Vec::new();
        for base in &opts.projects_dirs {
            let Ok(rd) = std::fs::read_dir(base) else { continue };
            for sub in rd.flatten().filter_map(|e| e.file_name().to_str().map(str::to_owned)) {
                let p = base.join(sub).join(format!("{sid}.jsonl"));
                if std::fs::metadata(&p).is_ok() {
                    out.push(p);
                }
            }
        }
        return out;
    }
    if let Some(ws) = opts.workspace.filter(|s| !s.is_empty()) {
        let slugs = resolve_project_slugs(ws, &opts.projects_dirs);
        let lo = opts.at_ms - opts.window_ms.unwrap_or(DEFAULT_WINDOW_MS) - MTIME_SLACK_MS;
        let hi = opts.at_ms + opts.forward_slack_ms.unwrap_or(DEFAULT_FORWARD_SLACK_MS) + MTIME_SLACK_MS;
        let mut cand: Vec<(PathBuf, f64)> = Vec::new();
        for base in &opts.projects_dirs {
            for slug in &slugs {
                let dir = base.join(slug);
                let Ok(rd) = std::fs::read_dir(&dir) else { continue };
                for name in rd.flatten().filter_map(|e| e.file_name().to_str().map(str::to_owned)) {
                    if !name.ends_with(".jsonl") {
                        continue;
                    }
                    let p = dir.join(&name);
                    let Some(mt) = mtime_ms(&p) else { continue }; // raced/unreadable — skip
                    if mt < lo || mt > hi {
                        continue;
                    }
                    cand.push((p, mt));
                }
            }
        }
        cand.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        return cand.into_iter().take(MAX_FILES).map(|c| c.0).collect();
    }
    Vec::new()
}

/// causingToolCalls — every spawn tool-call in the peak window, numbered + time-ordered +
/// verbatim, or an empty list with an honest `reason` (never a fabricated call).
/// Wire shape: `{calls:[{n,iso,tool,subagentType,model,input,sessionId}], windowFromIso,
/// windowToIso, reason?, note?}`.
pub fn causing_tool_calls(opts: &CausingCallsOptions) -> Value {
    let window_ms = opts.window_ms.unwrap_or(DEFAULT_WINDOW_MS);
    let fwd = opts.forward_slack_ms.unwrap_or(DEFAULT_FORWARD_SLACK_MS);
    let window_from_iso = iso_from_ms(opts.at_ms - window_ms);
    let window_to_iso = iso_from_ms(opts.at_ms + fwd);
    let mut out = Map::new();

    let files = resolve_transcripts(opts);
    if files.is_empty() {
        let located = opts.jsonl_path.is_some() || opts.session_id.is_some_and(|s| !s.is_empty()) || opts.workspace.is_some_and(|s| !s.is_empty());
        out.insert("calls".into(), Value::Array(Vec::new()));
        out.insert("windowFromIso".into(), window_from_iso.into());
        out.insert("windowToIso".into(), window_to_iso.into());
        out.insert("reason".into(), if located { "no-transcript" } else { "no-locator" }.into());
        return Value::Object(out);
    }

    let tools: Vec<&str> = opts.tools.map(<[&str]>::to_vec).unwrap_or_else(|| SPAWN_TOOLS.to_vec());
    // (timestamp, tool, subagent_type, model, input, sessionId) per matching content block.
    let mut rows: Vec<(String, Value)> = Vec::new();
    let mut total_lines = 0u64;
    let mut with_type = 0u64;
    for file in &files {
        let session_from_file = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        for_each_line(file, |line| {
            total_lines += 1;
            // The torn-line probe keys on `type`, NOT `timestamp`: measured over 482,993 real
            // records, `type` is missing from 0 while `timestamp` is missing from 16.9% (the
            // attachment / queue-operation / last-prompt records legitimately carry none), so a
            // timestamp-keyed probe would report a sixth of a healthy machine as unparseable.
            let Ok(v) = serde_json::from_str::<Value>(line) else { return };
            if v.get("type").is_some() {
                with_type += 1;
            }
            if v.get("type").and_then(Value::as_str) != Some("assistant") {
                return;
            }
            let Some(ts) = v.get("timestamp").and_then(Value::as_str) else { return };
            // String comparison, as the SQL does on ISO text.
            if ts < window_from_iso.as_str() || ts > window_to_iso.as_str() {
                return;
            }
            let Some(content) = v.get("message").and_then(|m| m.get("content")).and_then(Value::as_array) else { return };
            for block in content {
                if block.get("type").and_then(Value::as_str) != Some("tool_use") {
                    continue;
                }
                let Some(tool) = block.get("name").and_then(Value::as_str) else { continue };
                if !tools.contains(&tool) {
                    continue;
                }
                let input = block.get("input").cloned().unwrap_or(Value::Null);
                let mut r = Map::new();
                r.insert("iso".into(), ts.into());
                r.insert("tool".into(), tool.into());
                // json_extract_string returns NULL for a missing/non-string field.
                r.insert("subagentType".into(), input.get("subagent_type").and_then(Value::as_str).map_or(Value::Null, Value::from));
                r.insert("model".into(), input.get("model").and_then(Value::as_str).map_or(Value::Null, Value::from));
                // CAST(json_extract(...) AS VARCHAR) — the input serialized back, verbatim.
                r.insert("input".into(), input.to_string().into());
                r.insert("sessionId".into(), opts.session_id.map_or_else(|| session_from_file.clone(), str::to_owned).into());
                rows.push((ts.to_owned(), Value::Object(r)));
            }
        });
    }
    // ORDER BY timestamp ASC — stable, so equal timestamps keep file/line order.
    rows.sort_by(|a, b| a.0.cmp(&b.0));

    let torn = total_lines.saturating_sub(with_type);
    let note = (torn > 0).then(|| format!("{torn} line(s) unparseable and excluded."));
    out.insert(
        "calls".into(),
        Value::Array(
            rows.into_iter()
                .enumerate()
                .map(|(i, (_, mut r))| {
                    let obj = r.as_object_mut().expect("row object");
                    // `n` leads the wire object (the TS literal's key order).
                    let mut with_n = Map::new();
                    with_n.insert("n".into(), Value::from(i as i64 + 1));
                    for (k, v) in obj.iter() {
                        with_n.insert(k.clone(), v.clone());
                    }
                    Value::Object(with_n)
                })
                .collect(),
        ),
    );
    let empty = out.get("calls").and_then(Value::as_array).is_some_and(Vec::is_empty);
    out.insert("windowFromIso".into(), window_from_iso.into());
    out.insert("windowToIso".into(), window_to_iso.into());
    if empty {
        out.insert("reason".into(), "none-in-window".into());
    }
    if let Some(n) = note {
        out.insert("note".into(), n.into());
    }
    Value::Object(out)
}

/// composition — "Agent/general-purpose/opus×2, Workflow×2", most-frequent first.
pub fn composition(calls: &[Value]) -> String {
    let mut by: indexmap::IndexMap<String, f64> = indexmap::IndexMap::new();
    for c in calls {
        // `[tool, subagentType, model].filter(Boolean).join('/')` — null/'' both drop.
        let key = ["tool", "subagentType", "model"]
            .iter()
            .filter_map(|k| c.get(*k).and_then(Value::as_str).filter(|s| !s.is_empty()))
            .collect::<Vec<&str>>()
            .join("/");
        *by.entry(key).or_insert(0.0) += 1.0;
    }
    let mut ranked: Vec<(String, f64)> = by.into_iter().collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    ranked.into_iter().map(|(k, n)| format!("{k}×{}", crate::summarize::helpers::fmt_js_num(n))).collect::<Vec<String>>().join(", ")
}

//! Port of src/effortTransitions.ts (TRDD-A4BA8IU5 gap B, ported under TRDD-DMWOBWFH P4x.2d) —
//! per-turn reasoning EFFORT read straight off the assistant records.
//!
//! WHY this exists when `/effort` is already a cache-risk command: an effort change does not need a
//! command. Claude Code 2.1.212 stamps every assistant record with a top-level `effort`, and
//! MEASURED over 51,203 assistant records across 6 sessions there were exactly TWO within-session
//! transitions — in a session containing ZERO `/effort` commands. So the command-based detector's
//! hit rate on this class is 0%: the change came from something that types no command (a `/model`
//! switch, or the automatic safety-classifier fallback, which invalidates with no user action).
//!
//! Rare AND invisible is exactly the combination worth a detector: an effort change invalidates the
//! prefix, so it is a real cold-write cause nothing else here can name.

use std::path::PathBuf;

use indexmap::IndexMap;
use serde_json::{Map, Value};

use crate::cache_risk_commands::transcript_files;
use crate::summarize::helpers::{num, parse_iso_ms};

/// One observation: the timestamp of the record, its EXPLICIT effort, and the model when present.
#[derive(Clone, Debug)]
pub struct Observation {
    pub ts: f64,
    pub effort: String,
    pub model: Option<String>,
}

/// Narrow one transcript line to an effort observation, or None.
///
/// THE ABSENT-VALUE RULE, and it is the whole correctness of this module: an observation is only
/// produced for an EXPLICIT non-empty string `effort`. Records written before CC 2.1.212 carry
/// none, so an absent→present step is the FIELD APPEARING, not the user changing anything —
/// reporting it as a cache break would manufacture one invalidation per session at the exact
/// upgrade boundary, across all history. Same rule `cacheBreakTimeline` applies to
/// `EFFORT_PARAM_CHANGED`: name it only between two DIFFERENT EXPLICIT values, and leave the
/// ambiguous case unnamed rather than guessing.
pub fn effort_observation(entry: &Value) -> Option<Observation> {
    if entry.get("type").and_then(Value::as_str) != Some("assistant") {
        return None;
    }
    let effort = entry.get("effort").and_then(Value::as_str).filter(|s| !s.is_empty())?;
    // `typeof timestamp === 'string' ? Date.parse(...) : NaN`, then `Number.isFinite` — so a
    // non-string timestamp and an unparseable one are both rejected, never coerced to 0.
    let ts = entry.get("timestamp").and_then(Value::as_str).and_then(parse_iso_ms).filter(|t| t.is_finite())?;
    let model = entry.get("message").and_then(|m| m.get("model")).and_then(Value::as_str).filter(|s| !s.is_empty()).map(str::to_owned);
    Some(Observation { ts, effort: effort.to_owned(), model })
}

/// Partition key. A subagent runs at its OWN effort and its records are interleaved into the same
/// transcript as the parent's — so differencing across the boundary invents transitions that never
/// happened (and would invent two per subagent: in and out). Session and sidechain, never file.
fn partition_key(session: &str, sidechain: bool) -> String {
    format!("{} {}", session, if sidechain { "side" } else { "main" })
}

/// Turn a stream of assistant records into the effort transitions they contain. Pure — the
/// file-walk and the differencing are genuinely separate concerns.
///
/// Emits `{ts, session, from, to, sidechain}` with `model` APPENDED LAST when present, because the
/// TS assigns it after the object literal.
pub fn effort_transitions_of(records: &[(Value, Observation)]) -> Vec<Value> {
    let mut by_partition: IndexMap<String, Vec<(&Observation, String, bool)>> = IndexMap::new();
    for (entry, obs) in records {
        let session = entry.get("sessionId").and_then(Value::as_str).unwrap_or("");
        if session.is_empty() {
            continue;
        }
        // `=== true` is STRICT: a truthy non-boolean is not a sidechain, and neither is an absent
        // field. Partitioning on a coerced value would merge a subagent's turns into the parent's.
        let sidechain = entry.get("isSidechain") == Some(&Value::Bool(true));
        by_partition.entry(partition_key(session, sidechain)).or_default().push((obs, session.to_owned(), sidechain));
    }

    let mut out: Vec<Value> = Vec::new();
    for bucket in by_partition.values_mut() {
        // Sort by TIME, not file order: one session can span several transcript files (a resume
        // writes a new one) and subagent records interleave, so read order is not time order.
        bucket.sort_by(|a, b| a.0.ts.partial_cmp(&b.0.ts).unwrap_or(std::cmp::Ordering::Equal));
        let mut prev: Option<&str> = None;
        for (obs, session, sidechain) in bucket.iter() {
            // THE FIRST OBSERVATION IN A PARTITION ESTABLISHES THE BASELINE AND EMITS NOTHING — a
            // first sighting is not a change, and treating it as one manufactures exactly one false
            // event per session.
            if let Some(p) = prev {
                if obs.effort != p {
                    let mut t = Map::new();
                    t.insert("ts".into(), num(obs.ts));
                    t.insert("session".into(), Value::String(session.clone()));
                    t.insert("from".into(), Value::String(p.to_owned()));
                    t.insert("to".into(), Value::String(obs.effort.clone()));
                    t.insert("sidechain".into(), Value::Bool(*sidechain));
                    if let Some(m) = &obs.model {
                        t.insert("model".into(), Value::String(m.clone()));
                    }
                    out.push(Value::Object(t));
                }
            }
            prev = Some(&obs.effort);
        }
    }
    // Newest first, STABLE — ties keep partition-then-time order.
    out.sort_by(|a, b| {
        let (x, y) = (a["ts"].as_f64().unwrap_or(0.0), b["ts"].as_f64().unwrap_or(0.0));
        y.partial_cmp(&x).unwrap_or(std::cmp::Ordering::Equal)
    });
    out
}

/// Present a transition as a cache-risk EVENT, so the pricing side can charge it against the turn
/// it broke without knowing this module exists.
///
/// `mutation: 'certain'`, and that is not a formality: a `/effort` COMMAND is 'ambiguous' precisely
/// because the user may re-select the value it already had, which changes and breaks nothing. A
/// transition is the OBSERVED CHANGE itself — the one thing the command cannot promise. It is the
/// more reliable of the two signals, not a supplement to it.
///
/// `command` is a synthetic LABEL in a shape no slash command can collide with
/// (`(effort xhigh→low)`), because a row that reads like a typed command invites someone to grep
/// the transcript for it and find nothing.
pub fn effort_transition_as_risk_command(t: &Value) -> Value {
    let s = |k: &str| t.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
    let mut cmd = Map::new();
    cmd.insert("ts".into(), t.get("ts").cloned().unwrap_or(Value::Null));
    cmd.insert("session".into(), Value::String(s("session")));
    cmd.insert("command".into(), Value::String(format!("(effort {}→{})", s("from"), s("to"))));
    cmd.insert("kind".into(), Value::String("EFFORT_CHANGED".into()));
    cmd.insert("mutation".into(), Value::String("certain".into()));
    // Appended AFTER the literal in the TS, so it lands LAST — and only when a model was recorded.
    if let Some(m) = t.get("model").and_then(Value::as_str).filter(|m| !m.is_empty()) {
        cmd.insert("args".into(), Value::String(m.to_owned()));
    }
    Value::Object(cmd)
}

/// Scan transcripts for effort transitions, newest first.
///
/// Same two cheap filters as `scan_cache_risk_commands`, for the same reason (a full-history scan
/// is 12k+ files): skip a file whose mtime predates `since_ms`, and skip a file with no `"effort"`
/// substring at all before parsing any line of it.
pub fn scan_effort_transitions(
    dirs: &[PathBuf],
    since_ms: Option<f64>,
    limit: Option<usize>,
    include_sidechain: bool,
) -> Vec<Value> {
    let mut records: Vec<(Value, Observation)> = Vec::new();
    for file in transcript_files(dirs) {
        if let Some(since) = since_ms {
            let Ok(meta) = std::fs::metadata(&file) else { continue };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
            if mtime < since {
                continue;
            }
        }
        let Ok(text) = std::fs::read_to_string(&file) else { continue };
        if !text.contains("\"effort\"") {
            continue;
        }
        for line in text.split('\n') {
            if !line.contains("\"effort\"") {
                continue;
            }
            let Ok(entry) = serde_json::from_str::<Value>(line) else { continue };
            if let Some(obs) = effort_observation(&entry) {
                records.push((entry, obs));
            }
        }
    }

    // NOTE both filters run AFTER the differencing, never before: dropping records first would
    // difference across the hole and report a transition between two turns that were never
    // adjacent.
    let mut found = effort_transitions_of(&records);
    if !include_sidechain {
        found.retain(|t| t.get("sidechain") != Some(&Value::Bool(true)));
    }
    if let Some(since) = since_ms {
        found.retain(|t| t.get("ts").and_then(Value::as_f64).unwrap_or(0.0) >= since);
    }
    if let Some(n) = limit {
        found.truncate(n);
    }
    found
}

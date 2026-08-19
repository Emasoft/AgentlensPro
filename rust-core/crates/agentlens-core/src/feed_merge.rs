//! Port of src/feedMergePolicy.ts (TRDD-DMWOBWFH P4g) — the feed-collision doctrine: which card
//! serves when a LOG transcript card and an OTEL card share a sessionId (Claude → log wins, every
//! other source → OTEL wins), the P7 provenance stamps, the TRDD-5GFSFX0Q api_request
//! attribution graft, and the P8 spawn-placeholder ↔ subagent-transcript link. Cards are Value
//! objects; every function is pure over its inputs exactly like the TS (stamps mutate the card
//! they are handed, as the TS does).
//!
//! This module is the SINGLE source of the doctrine on the Rust side, as feedMergePolicy.ts is on
//! the TS side — never re-encode the preference inline.

use serde_json::{Map, Value};
use std::collections::{HashMap, HashSet};

pub const OTEL_DISPLACED_NOTE: &str =
    "Token totals come from the log transcript; the colliding OTEL card for this session was displaced (OTEL is a lossy lower bound).";

fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(Value::as_str).unwrap_or("")
}

fn f(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}

fn obj(v: &mut Value) -> &mut Map<String, Value> {
    v.as_object_mut().expect("card is an object")
}

pub fn preferred_data_source(source: &str) -> &'static str {
    if source == "claude_code" { "log" } else { "otel" }
}

/// graftOtelAttribution — append the OTEL api_request entries missing from a log timeline,
/// then sort by timestamp (string compare, `''` for absent — the TS `<` comparator).
pub fn graft_otel_attribution(log_timeline: &[Value], otel_timeline: Option<&[Value]>) -> Vec<Value> {
    let grafts: Vec<&Value> = otel_timeline
        .unwrap_or(&[])
        .iter()
        .filter(|e| s(e, "type") == "api_request")
        .collect();
    if grafts.is_empty() {
        return log_timeline.to_vec();
    }
    let seen: HashSet<Option<&Value>> = log_timeline
        .iter()
        .filter(|e| s(e, "type") == "api_request")
        .map(|e| e.get("spanId"))
        .collect();
    let fresh: Vec<&Value> = grafts.into_iter().filter(|e| !seen.contains(&e.get("spanId"))).collect();
    if fresh.is_empty() {
        return log_timeline.to_vec();
    }
    let mut out: Vec<Value> = log_timeline.to_vec();
    out.extend(fresh.into_iter().cloned());
    // `(a.timestamp||'') < (b.timestamp||'') ? -1 : 1` — never Equal in TS; a total order on
    // the string is the consistent reading (ties keep insertion order here, V8's TimSort is
    // also stable for equal keys under a consistent comparator).
    out.sort_by(|a, b| s(a, "timestamp").cmp(s(b, "timestamp")));
    out
}

pub fn stamp_log_wins(card: &mut Value) {
    let o = obj(card);
    o.insert("tokensSource".into(), "log".into());
    o.insert("coverageNote".into(), OTEL_DISPLACED_NOTE.into());
}

pub fn stamp_identity_merge(winner: &mut Value, loser_data_source: &str) {
    let wds = s(winner, "dataSource").to_owned();
    if wds == loser_data_source {
        return;
    }
    let o = obj(winner);
    o.insert("tokensSource".into(), "merged".into());
    o.insert(
        "coverageNote".into(),
        format!("Identity-merged across feeds: this {wds} card absorbed its {loser_data_source} twin (identical token buckets in both feeds).").into(),
    );
}

fn stamp_plain(card: &mut Value, source: &str) {
    let o = obj(card);
    o.insert("tokensSource".into(), source.into());
    // `coverageNote = undefined` — the key vanishes from the wire.
    o.shift_remove("coverageNote");
}

/// mergeOtelAndLogSessions — on a sessionId collision the source's preferred feed wins; every
/// non-colliding card is kept; order is `[...keptLog, ...keptOtel]` (callers sort).
pub fn merge_otel_and_log_sessions(mut otel_sessions: Vec<Value>, mut log_sessions: Vec<Value>) -> Vec<Value> {
    if log_sessions.is_empty() {
        for c in &mut otel_sessions {
            stamp_plain(c, "otel");
        }
        return otel_sessions;
    }
    let log_wins_ids: HashSet<String> = log_sessions
        .iter()
        .filter(|c| preferred_data_source(s(c, "source")) == "log")
        .map(|c| s(c, "sessionId").to_owned())
        .collect();
    let otel_ids: HashSet<String> = otel_sessions.iter().map(|c| s(c, "sessionId").to_owned()).collect();
    let mut kept_otel: Vec<Value> = otel_sessions
        .drain(..)
        .filter(|c| !(s(c, "dataSource") == "otel" && log_wins_ids.contains(s(c, "sessionId"))))
        .collect();
    let kept_otel_ids: HashSet<String> = kept_otel.iter().map(|c| s(c, "sessionId").to_owned()).collect();
    let mut kept_log: Vec<Value> = log_sessions.drain(..).filter(|c| !kept_otel_ids.contains(s(c, "sessionId"))).collect();
    for c in &mut kept_otel {
        stamp_plain(c, "otel");
    }
    for c in &mut kept_log {
        if otel_ids.contains(s(c, "sessionId")) {
            stamp_log_wins(c);
        } else {
            stamp_plain(c, "log");
        }
    }
    kept_log.extend(kept_otel);
    kept_log
}

/// linkSubagentTranscripts — collapse each async/sync spawn placeholder with its
/// `agent-<id>` transcript twin into ONE child card (the transcript wins, the placeholder
/// contributes the spawn taxonomy and is recorded in `mergedFrom`).
pub fn link_subagent_transcripts(sessions: Vec<Value>) -> Vec<Value> {
    let by_id: HashMap<String, usize> = sessions.iter().enumerate().map(|(i, c)| (s(c, "sessionId").to_owned(), i)).collect();
    let mut winners: HashMap<String, Value> = HashMap::new();
    let mut consumed: HashSet<String> = HashSet::new();
    for (pi, p) in sessions.iter().enumerate() {
        if s(p, "source") != "claude_code" || s(p, "dataSource") != "log" || s(p, "parentSessionId").is_empty() {
            continue;
        }
        let Some(&ti) = by_id.get(&format!("agent-{}", s(p, "sessionId"))) else { continue };
        if ti == pi {
            continue;
        }
        let t = &sessions[ti];
        if s(t, "source") != "claude_code" || s(t, "dataSource") != "log" {
            continue;
        }
        // `t.parentSessionId !== undefined && t.parentSessionId !== p.parentSessionId`
        if let Some(tp) = t.get("parentSessionId").filter(|v| !v.is_null()) {
            if tp != p.get("parentSessionId").unwrap_or(&Value::Null) {
                continue;
            }
        }
        let t_traffic = f(t, "inputTokens") + f(t, "outputTokens") + f(t, "cacheReadTokens") + f(t, "cacheCreateTokens");
        let p_traffic = f(p, "inputTokens") + f(p, "outputTokens") + f(p, "cacheReadTokens") + f(p, "cacheCreateTokens");
        if !(t_traffic > 0.0) && p_traffic > 0.0 {
            continue;
        }
        let t_id = s(t, "sessionId").to_owned();
        if winners.contains_key(&t_id) {
            continue;
        }
        let mut w = t.clone();
        {
            let o = obj(&mut w);
            o.insert("parentSessionId".into(), p.get("parentSessionId").cloned().unwrap_or(Value::Null));
            o.insert("initiator".into(), "agent".into());
            // Spawn taxonomy — written as the placeholder carries it; an absent field on the
            // placeholder writes `undefined`, which drops the key (so a transcript-side value
            // is REPLACED by absence, exactly as the TS literal does).
            for k in ["spawnedByTurn", "spawnKind", "spawnModelOverride", "spawnIsolation", "spawnSubagentType"] {
                match p.get(k).filter(|v| !v.is_null()) {
                    Some(v) => {
                        o.insert(k.into(), v.clone());
                    }
                    None => {
                        o.shift_remove(k);
                    }
                }
            }
            // spawnAsync: tTraffic > 0 ? undefined : (p.spawnAsync || undefined)
            if t_traffic > 0.0 || !p.get("spawnAsync").is_some_and(|v| v.as_bool() == Some(true)) {
                o.shift_remove("spawnAsync");
            } else {
                o.insert("spawnAsync".into(), true.into());
            }
            for k in ["userRequest", "model", "workspace"] {
                let tv = s(t, k);
                // `t.x || p.x` — '' on t falls back to p's raw value (may be '' or absent).
                let chosen: Value = if !tv.is_empty() {
                    Value::from(tv)
                } else {
                    p.get(k).cloned().unwrap_or(Value::Null)
                };
                if chosen.is_null() {
                    o.shift_remove(k);
                } else {
                    o.insert(k.into(), chosen);
                }
            }
            let mut merged_from: Vec<Value> = t.get("mergedFrom").and_then(Value::as_array).cloned().unwrap_or_default();
            merged_from.push(Value::from(s(p, "sessionId")));
            merged_from.retain(|id| id.as_str() != Some(t_id.as_str()));
            o.insert("mergedFrom".into(), Value::Array(merged_from));
        }
        winners.insert(t_id, w);
        consumed.insert(s(p, "sessionId").to_owned());
    }
    if winners.is_empty() {
        return sessions;
    }
    sessions
        .into_iter()
        .filter(|c| !consumed.contains(s(c, "sessionId")))
        .map(|c| match winners.remove(s(&c, "sessionId")) {
            Some(w) => w,
            None => c,
        })
        .collect()
}

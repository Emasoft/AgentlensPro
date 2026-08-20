//! The hook-event store + lifecycle mapping (TRDD-DMWOBWFH, freeze rows 6–8) — ports of
//! src/ndjsonBuckets.ts (the shared append-only daily-bucket machinery; its disk-usage half
//! already lives in server_stats.rs), src/hookEventStore.ts (Claude Code lifecycle hook payloads
//! from `agentlenspro hook`, persisted VERBATIM — refinement happens at read time), and
//! src/lifecycleEvents.ts (the PURE record → typed-lifecycle-event mapping, TRDD-EYA3X5MQ).
//!
//! Append-only daily buckets ON PURPOSE: a per-event rewrite of a growing store is the exact
//! pattern that destroyed 420GB of SSD in 4 hours — never reintroduce it here either.
//!
//! NOT PORTED (each has its own TS subsystem, deferred): the statusline sample stores that
//! `routed:"statusline"` events divert into (the route answers the frozen body, the sample is
//! DROPPED — recorded, not silent); the boot-time hook-spool drain + its byte-for-byte
//! durability verification (TRDD-K3WDPR7M); the StopFailure capacity auto-calibration.
//! The in-memory recent-events ring IS ported (P4r.5 — it feeds the burn gate): boot-seeded in
//! CoreState::open, pushed on every ingest below.

use std::path::{Path, PathBuf};

use agentlens_spanstore::segment_day_ms;
use serde_json::{json, Map, Value};

/// ndjsonBuckets.bucketDayMs — `YYYY-MM-DD.ndjsonl`, calendar-real (the same round-trip check
/// the span segments use — '2026-02-31' is NOT a bucket), → UTC day-start ms.
pub fn bucket_day_ms(filename: &str) -> Option<i64> {
    let stem = filename.strip_suffix(".ndjsonl")?;
    segment_day_ms(&format!("{stem}.ndjson"))
}

fn bucket_path(dir: &Path, ts_ms: i64) -> PathBuf {
    let day = crate::summarize::helpers::iso_from_ms(ts_ms as f64);
    dir.join(format!("{}.ndjsonl", &day[..10]))
}

/// ndjsonBuckets.appendBucketLine — append `json` + newline to the day's bucket; returns the
/// bytes written (the caller's persistence accounting). The TS also returns the exact append
/// position for the spool drain's durability proof — unported with the drain.
pub fn append_bucket_line(dir: &Path, ts_ms: i64, line_json: &str) -> std::io::Result<u64> {
    use std::io::Write;
    std::fs::create_dir_all(dir)?;
    let line = format!("{line_json}\n");
    let mut f = std::fs::OpenOptions::new().append(true).create(true).open(bucket_path(dir, ts_ms))?;
    f.write_all(line.as_bytes())?;
    Ok(line.len() as u64)
}

/// hookEventStore.buildHookEventRecord — the ONE construction point for the record shape:
/// `{ts, ev, session?, payload}` (session only when the payload carries a string session_id;
/// the payload verbatim).
pub fn build_hook_event_record(payload: &Map<String, Value>, ts_ms: i64) -> Value {
    let mut rec = Map::new();
    rec.insert("ts".into(), Value::from(ts_ms));
    rec.insert("ev".into(), Value::from(payload.get("hook_event_name").and_then(Value::as_str).unwrap_or("")));
    if let Some(sid) = payload.get("session_id").and_then(Value::as_str) {
        rec.insert("session".into(), Value::from(sid));
    }
    rec.insert("payload".into(), Value::Object(payload.clone()));
    Value::Object(rec)
}

/// hookEventStore.appendHookEvent — build + append; returns (record, bytes written).
pub fn append_hook_event(dir: &Path, payload: &Map<String, Value>, ts_ms: i64) -> std::io::Result<(Value, u64)> {
    let rec = build_hook_event_record(payload, ts_ms);
    let bytes = append_bucket_line(dir, ts_ms, &rec.to_string())?;
    Ok((rec, bytes))
}

#[derive(Default)]
pub struct HookEventFilter<'a> {
    pub session: Option<&'a str>,
    pub ev: Option<&'a str>,
    pub since_ms: Option<i64>,
    pub until_ms: Option<i64>,
    pub limit: Option<i64>,
}

/// hookEventStore.readHookEvents — newest-first, limit clamped to [1, 1000] (default 100),
/// whole buckets outside the window skipped by their filename date, corrupt lines skipped.
pub fn read_hook_events(dir: &Path, filter: &HookEventFilter) -> Vec<Value> {
    let limit = filter.limit.unwrap_or(100).clamp(1, 1000) as usize;
    let since = filter.since_ms.unwrap_or(0);
    let until = filter.until_ms.unwrap_or(i64::MAX);
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(dir) else { return out };
    let mut buckets: Vec<String> = rd
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_owned))
        .filter(|n| bucket_day_ms(n).is_some())
        .collect();
    buckets.sort();
    buckets.reverse();
    for b in buckets {
        let day_start = bucket_day_ms(&b).expect("filtered above");
        if day_start > until || day_start + 86_400_000 < since {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(dir.join(&b)) else { continue };
        for l in raw.split('\n').rev() {
            let l = l.trim();
            if l.is_empty() {
                continue;
            }
            let Ok(rec) = serde_json::from_str::<Value>(l) else { continue }; // corrupt tail — skip
            let ts = rec.get("ts").and_then(Value::as_i64).unwrap_or(0);
            if ts < since || ts > until {
                continue;
            }
            if let Some(want) = filter.session {
                if rec.get("session").and_then(Value::as_str) != Some(want) {
                    continue;
                }
            }
            if let Some(want) = filter.ev {
                if rec.get("ev").and_then(Value::as_str) != Some(want) {
                    continue;
                }
            }
            out.push(rec);
            if out.len() >= limit {
                return out;
            }
        }
    }
    out
}

/// server.ts HOOK_EVENT_MAX_BYTES — lifecycle payloads are small; a bigger body is a bug.
pub const HOOK_EVENT_MAX_BYTES: usize = 512 * 1024;

/// server.ts STATUSLINE_EV_STREAMS — the version-skew bridge: an older CLI posts status-line
/// samples to /api/hook-events; they must NOT pollute the lifecycle buckets.
pub fn statusline_stream(ev: &str) -> Option<&'static str> {
    match ev {
        "StatusLineSample" => Some("main"),
        "SubagentStatusLineSample" => Some("subagent"),
        _ => None,
    }
}

/// server.ts ingestHookEvent — validate → route/drop → append → ring → stats. Returns the
/// HTTP-shaped (status, body). NOT PORTED inside: the statusline store (the diverted sample is
/// dropped after the frozen `routed` answer), the StopFailure calibration.
pub fn ingest_hook_event(st: &mut crate::CoreState, payload: &Value, now_ms: i64) -> (u16, Value) {
    let Some(p) = payload.as_object() else {
        return (400, json!({ "error": "payload must be a JSON object with hook_event_name" }));
    };
    let ev = p.get("hook_event_name").and_then(Value::as_str).unwrap_or("");
    if ev.is_empty() {
        return (400, json!({ "error": "payload must be a JSON object with hook_event_name" }));
    }
    if let Some(stream) = statusline_stream(ev) {
        let _ = stream; // the statusline store is not ported — the sample is dropped, the answer frozen
        return (200, json!({ "ok": true, "routed": "statusline" }));
    }
    if !st.hook_runtime.capture_enabled {
        // Switch off = accept and DROP: the hook script is a fire-and-forget dumb pipe, and a
        // non-2xx would make disabled capture look like a server outage.
        return (200, json!({ "ok": true, "dropped": "captureEnabled=false" }));
    }
    match append_hook_event(&st.data_dir.join("hook-events"), p, now_ms) {
        Ok((rec, bytes)) => {
            push_recent_hook_event(&mut st.recent_hook_events, rec);
            st.persist.hook_event_writes += 1;
            st.persist.hook_event_bytes += bytes;
            (200, json!({ "ok": true }))
        }
        Err(e) => (500, json!({ "error": e.to_string() })),
    }
}

/// server.ts RECENT_EVENTS_CAP — the in-memory ring the gate + buildGateState read.
pub const RECENT_EVENTS_CAP: usize = 600;

/// server.ts pushRecentHookEvent — append; past the cap, keep the newest 500 (the TS splice).
pub fn push_recent_hook_event(ring: &mut Vec<Value>, rec: Value) {
    ring.push(rec);
    if ring.len() > RECENT_EVENTS_CAP {
        let drop = ring.len() - 500;
        ring.drain(..drop);
    }
}

// ── src/lifecycleEvents.ts — the pure mapping ────────────────────────────────────────────────

/// SessionStart `source` → kind; unknown/absent degrades to STARTUP, never dropped.
fn session_start_kind(detail: Option<&str>) -> &'static str {
    match detail {
        Some("clear") => "CLEAR",
        Some("compact") => "COMPACT",
        Some("resume") => "RESUME",
        Some("fork") => "FORK",
        _ => "STARTUP",
    }
}

/// hook_event_name → the payload field carrying the human-meaningful discriminator.
fn detail_field(ev: &str) -> Option<&'static str> {
    match ev {
        "SessionStart" => Some("source"),
        "SessionEnd" => Some("reason"),
        "PreCompact" | "PostCompact" => Some("trigger"),
        "StopFailure" => Some("error_type"),
        "ConfigChange" => Some("source"),
        _ => None,
    }
}

/// toLifecycleEvent — None for records that are not session-lifecycle (PermissionRequest,
/// Notification, SubagentStart, …). Key order: ts, session?, kind, detail?, ev (the wire shape
/// row 8 freezes: `events:[{ts,session?,kind,detail?,ev}]`).
pub fn to_lifecycle_event(rec: &Value) -> Option<Value> {
    let ev = rec.get("ev").and_then(Value::as_str)?;
    let kind = match ev {
        "SessionStart" => None, // resolved below from the detail
        "SessionEnd" => Some("SESSION_END"),
        "Stop" => Some("STOP"),
        "StopFailure" => Some("STOP_FAILURE"),
        "PreCompact" => Some("PRE_COMPACT"),
        "PostCompact" => Some("POST_COMPACT"),
        "ConfigChange" => Some("CONFIG_CHANGE"),
        _ => return None,
    };
    let detail = detail_field(ev)
        .and_then(|f| rec.get("payload")?.get(f))
        .and_then(Value::as_str)
        .map(str::to_owned);
    let kind = kind.unwrap_or_else(|| session_start_kind(detail.as_deref()));
    let mut out = Map::new();
    out.insert("ts".into(), rec.get("ts").cloned().unwrap_or(Value::from(0)));
    if let Some(s) = rec.get("session").filter(|s| s.is_string()) {
        out.insert("session".into(), s.clone());
    }
    out.insert("kind".into(), Value::from(kind));
    if let Some(d) = detail {
        out.insert("detail".into(), Value::from(d));
    }
    out.insert("ev".into(), Value::from(ev));
    Some(Value::Object(out))
}

/// Kinds excluded by default (high-volume, low-signal): STOP fires every turn, SESSION_END for
/// every session. Opt back in with an explicit `kinds`.
const DEFAULT_EXCLUDED: [&str; 2] = ["STOP", "SESSION_END"];

/// extractLifecycleEvents — filter, map, most-recent-first, cap.
pub fn extract_lifecycle_events(records: &[Value], kinds: Option<&[String]>, session: Option<&str>, limit: usize) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for rec in records {
        if let Some(want) = session {
            if rec.get("session").and_then(Value::as_str) != Some(want) {
                continue;
            }
        }
        let Some(ev) = to_lifecycle_event(rec) else { continue };
        let kind = ev.get("kind").and_then(Value::as_str).unwrap_or("");
        let keep = match kinds {
            Some(want) => want.iter().any(|k| k == kind),
            None => !DEFAULT_EXCLUDED.contains(&kind),
        };
        if !keep {
            continue;
        }
        out.push(ev);
    }
    out.sort_by_key(|e| std::cmp::Reverse(e.get("ts").and_then(Value::as_i64).unwrap_or(0)));
    out.truncate(limit);
    out
}

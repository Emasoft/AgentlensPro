//! The hook-event store + lifecycle mapping (TRDD-DMWOBWFH, freeze rows 6–8) — ports of
//! src/ndjsonBuckets.ts (the shared append-only daily-bucket machinery; its disk-usage half
//! already lives in server_stats.rs), src/hookEventStore.ts (Claude Code lifecycle hook payloads
//! from `agentlenspro hook`, persisted VERBATIM — refinement happens at read time), and
//! src/lifecycleEvents.ts (the PURE record → typed-lifecycle-event mapping, TRDD-EYA3X5MQ).
//!
//! Append-only daily buckets ON PURPOSE: a per-event rewrite of a growing store is the exact
//! pattern that destroyed 420GB of SSD in 4 hours — never reintroduce it here either.
//!
//! NOT PORTED (each has its own TS subsystem, deferred): the boot-time hook-spool drain + its
//! byte-for-byte durability verification (TRDD-K3WDPR7M). The in-memory recent-events ring IS
//! ported (P4r.5 — it feeds the burn gate), the statusline divert lands in the ported store
//! (row 5) instead of dropping, and (P5) the StopFailure capacity auto-calibration now runs
//! through `crate::burn_calibration` too — see the bottom of `ingest_hook_event`.

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

/// ndjsonBuckets.purgeBuckets — delete daily buckets strictly older than `retention_days`.
/// `now_ms` is a parameter (never wall-clock read here) so the caller controls the clock and the
/// function is deterministic under test. Returns the removed filenames + freed bytes; per-file
/// errors (a raced unlink) are swallowed and the loop continues, matching the TS `catch {}`.
///
/// The cutoff is NOT a raw subtraction: it round-trips through a UTC day-string (`iso_from_ms`
/// truncated to 10 chars, then re-parsed via `segment_day_ms`) exactly as the TS does, which
/// snaps the cutoff to a UTC day boundary — collapsing a raw-ms subtraction back in changes which
/// files get deleted.
///
/// No floor is applied on `retention_days` here — `retention_config::resolve_knob` applies the
/// knob's `min` floor at the CALL SITE, the same split as the TS (`purgeBuckets` takes whatever
/// number it's given). A caller that skips `resolve_knob` and passes 0 or a negative number will
/// wipe buckets it shouldn't; that is a caller bug, not something this function guards against.
pub fn purge_buckets(dir: &Path, retention_days: f64, now_ms: f64) -> (Vec<String>, u64) {
    let mut removed = Vec::new();
    let mut freed_bytes = 0u64;
    let cutoff_day = &crate::summarize::helpers::iso_from_ms(now_ms - retention_days * 86_400_000.0)[..10];
    // An uncomputable cutoff must REFUSE THE PASS OUT LOUD, never degrade into a silent verdict.
    // `iso_from_ms` casts with `as i64`, which SATURATES instead of failing, so a non-finite or
    // absurd `retention_days` yields a well-formed but nonsense day ("2922770265") that
    // `segment_day_ms` rejects. Both silent readings are wrong and in opposite directions:
    // `unwrap_or(0)` makes `day_ms >= 0` always true, so the reaper deletes NOTHING for the life
    // of the process while reporting a normal empty manifest — indistinguishable from "nothing
    // was old enough", which is the common case, so nothing ever notices. The TS fails the other
    // way and worse: `Date.parse` gives NaN, `dayMs >= NaN` is false, and it deletes EVERY bucket.
    // Not reachable via `resolve_knob` (it filters both sources to finite, then floors at min 1),
    // so this guards a direct caller, which is exactly who has no floor.
    let Some(cutoff_ms) = agentlens_spanstore::segment_day_ms(&format!("{cutoff_day}.ndjson")) else {
        eprintln!(
            "alcore: refusing to purge {} — retention_days={retention_days} yields an unparseable \
             cutoff day '{cutoff_day}'; nothing deleted",
            dir.display()
        );
        return (removed, freed_bytes);
    };
    let Ok(rd) = std::fs::read_dir(dir) else { return (removed, freed_bytes) };
    for entry in rd.flatten() {
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else { continue };
        let Some(day_ms) = bucket_day_ms(&name) else { continue }; // not one of our buckets — never delete a foreign file
        if day_ms >= cutoff_ms {
            continue;
        }
        let p = dir.join(&name);
        let Ok(meta) = std::fs::metadata(&p) else { continue };
        if std::fs::remove_file(&p).is_ok() {
            freed_bytes += meta.len();
            removed.push(name);
        }
    }
    (removed, freed_bytes)
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

/// server.ts ingestHookEvent — validate → route/divert → append → ring → stats → (P5) StopFailure
/// capacity auto-calibration. Returns the HTTP-shaped (status, body).
pub fn ingest_hook_event(st: &mut crate::CoreState, payload: &Value, now_ms: i64) -> (u16, Value) {
    let Some(p) = payload.as_object() else {
        return (400, json!({ "error": "payload must be a JSON object with hook_event_name" }));
    };
    let ev = p.get("hook_event_name").and_then(Value::as_str).unwrap_or("");
    if ev.is_empty() {
        return (400, json!({ "error": "payload must be a JSON object with hook_event_name" }));
    }
    if let Some(stream) = statusline_stream(ev) {
        // The version-skew bridge lands in the SAME store as the dedicated endpoint (row 5) —
        // both must, or a skew would split the history in two.
        st.statusline.append(p, stream, now_ms as f64);
        st.persist.statusline_samples += 1;
        return (200, json!({ "ok": true, "routed": "statusline" }));
    }
    if !st.hook_runtime.capture_enabled {
        // Switch off = accept and DROP: the hook script is a fire-and-forget dumb pipe, and a
        // non-2xx would make disabled capture look like a server outage.
        return (200, json!({ "ok": true, "dropped": "captureEnabled=false" }));
    }
    match append_hook_event(&st.data_dir.join("hook-events"), p, now_ms) {
        Ok((rec, bytes)) => {
            // Cloned before the ring takes ownership — the calibration branch below needs the
            // record's own ts/session/payload after this push.
            let rec_for_calibration = rec.clone();
            push_recent_hook_event(&mut st.recent_hook_events, rec);
            st.persist.hook_event_writes += 1;
            st.persist.hook_event_bytes += bytes;
            // P5 auto-calibration: a rate-limit StopFailure is the ONE moment the undisclosed
            // window cap is observable — snapshot the hot account's consumed figures into
            // burn-config.json as observed capacity. Run AFTER the record is persisted/ringed
            // (ingestion is the priority); `calibrate_from_stop_failure` never panics, so a bad
            // calibration can never break hook ingestion.
            if ev == "StopFailure" {
                let sessions = st.build_session_summary(now_ms as f64);
                let sessions = sessions.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                let events = crate::burn::monitor::gather_consumption_events(&sessions, &[], now_ms as f64);
                let current_account_uuid = st.burn.current_account(now_ms as f64).account_uuid;
                let outcome = crate::burn_calibration::calibrate_from_stop_failure(
                    &rec_for_calibration,
                    &events,
                    &sessions,
                    current_account_uuid.as_deref(),
                    &st.burn.vars,
                    &st.burn.home_dir,
                );
                if outcome.calibrated {
                    // Reload so the next burn tick + every budget read projects against the new cap.
                    st.burn.config = crate::burn::monitor::load_burn_config(&st.burn.vars, &st.burn.home_dir);
                    println!("[AgentlensPro] window capacity auto-calibrated: {}", outcome.reason);
                } else {
                    println!("[AgentlensPro] capacity calibration skipped: {}", outcome.reason);
                }
            }
            (200, json!({ "ok": true }))
        }
        Err(e) => (500, json!({ "error": e.to_string() })),
    }
}

/// What one drain pass did. Reported so a boot line can say it, and so the test can assert on it.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SpoolDrain {
    pub drained: usize,
    pub rejected: usize,
    pub unverified: usize,
    pub kept: usize,
}

/// Drain the durable hook-spool on boot (D3K7QM2P/1a) — the port of `drainHookSpool`
/// (standalone/server.ts:1205), which existed ONLY in the TypeScript server (TRDD-465EXTJ6).
///
/// When the server was DOWN or shedding, `agentlenspro hook` writes each raw payload to
/// `<data>/hook-spool/<ts>-<rand>.json` instead of losing it. Until this port, alcore never read
/// that directory: the events were written and then sat there forever, which is data loss with
/// extra steps — the spool exists precisely so they are NOT lost.
///
/// **VERIFY BEFORE DELETE (TRDD-K3WDPR7M, USER directive 2026-07-15: a source file may be deleted
/// ONLY after the durable destination is confirmed to hold ALL its data).** A 200 is NOT trusted —
/// the appended line is read back out of its bucket and compared byte-for-byte before the spool
/// file is unlinked. The four outcomes are deliberately different:
///
/// - **drained** — appended AND read back identical ⇒ the spool copy is redundant, unlink it.
/// - **rejected** — unparseable, or a non-200 (a bad payload can never ingest). QUARANTINED into
///   `hook-spool/rejected/`, never deleted: it is still DATA, and keeping it there unwedges the
///   spool without destroying anything.
/// - **kept** — a 200 that appended NOTHING (capture disabled by policy, or routed to the
///   statusline store). Not an error and not bad data; a later boot with capture on will ingest
///   it. Deleting it would silently drop the event.
/// - **unverified** — 200 but the read-back did not match. The durable copy is NOT proven, so the
///   only guaranteed copy is kept for the next boot.
///
/// Idempotent: a crash mid-drain leaves the remaining files for the next boot.
///
/// `max_files` bounds how many spool files one call processes. The state lock (`st`) is held by
/// the caller across the whole loop, and each event costs a file read plus a bucket read-back —
/// on the boot path (`usize::MAX`) that is fine, nothing else needs the lock yet. On the periodic
/// drain tick added for TRDD-L6V1UUW0 (the server is up and serving requests), an unbounded loop
/// over a large backlog would hold the lock for multiple seconds and stall every request in
/// flight — exactly TRDD-2R36W8Q1's failure shape. Bounding the batch keeps each tick short; a
/// backlog bigger than the cap just drains over several ticks.
pub fn drain_hook_spool(st: &mut crate::CoreState, now_ms: i64, max_files: usize) -> SpoolDrain {
    let spool_dir = st.data_dir.join("hook-spool");
    let mut names: Vec<String> = match std::fs::read_dir(&spool_dir) {
        Ok(rd) => rd
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect(),
        // No spool dir — nothing to drain. Not an error; the common case on a clean install.
        Err(_) => return SpoolDrain::default(),
    };
    // Sorted so the oldest spooled event is reingested first — the filenames lead with a timestamp,
    // so lexical order IS chronological order, and replaying out of order would scramble a session's
    // lifecycle sequence.
    names.sort();
    names.truncate(max_files);
    let mut out = SpoolDrain::default();
    let rejected_dir = spool_dir.join("rejected");
    let events_dir = st.data_dir.join("hook-events");
    for name in names {
        let file = spool_dir.join(&name);
        let Ok(raw) = std::fs::read_to_string(&file) else { continue }; // vanished / unreadable — skip
        let Ok(payload) = serde_json::from_str::<Value>(&raw) else {
            quarantine(&file, &rejected_dir, &mut out);
            continue;
        };
        // The record the append WOULD write, computed before ingesting so the read-back has an
        // exact byte string to look for. `build_hook_event_record` is pure and takes the same
        // `now_ms` the ingest below uses, so the two cannot disagree.
        let expected_line = payload.as_object().map(|p| build_hook_event_record(p, now_ms).to_string());
        let (status, body) = ingest_hook_event(st, &payload, now_ms);
        if status != 200 {
            quarantine(&file, &rejected_dir, &mut out);
            continue;
        }
        // A 200 that appended nothing: routed to the statusline store, or dropped because capture
        // is off. Distinguished by the response body, which is the only signal `ingest_hook_event`
        // gives — it returns `{"ok":true}` alone ONLY on the append path.
        let appended = body.get("routed").is_none() && body.get("dropped").is_none();
        let Some(expected) = expected_line.filter(|_| appended) else {
            out.kept += 1;
            continue;
        };
        if bucket_contains_line(&events_dir, now_ms, &expected) {
            // Durable copy PROVEN — now, and only now, is the spool copy redundant.
            let _ = std::fs::remove_file(&file);
            out.drained += 1;
        } else {
            out.unverified += 1;
            eprintln!("[AgentlensPro] hook-spool: append NOT verified for {name} — keeping spool file (durable copy unproven)");
        }
    }
    out
}

/// Move a spool file into `rejected/` rather than deleting it. A payload that can never ingest is
/// still DATA; quarantining keeps the spool unwedged WITHOUT destroying it (TRDD-K3WDPR7M). If the
/// move itself fails the file stays where it is and is counted as kept — never dropped.
fn quarantine(file: &Path, rejected_dir: &Path, out: &mut SpoolDrain) {
    if std::fs::create_dir_all(rejected_dir).is_err() {
        out.kept += 1;
        return;
    }
    let dest = rejected_dir.join(file.file_name().unwrap_or_default());
    if std::fs::rename(file, &dest).is_ok() {
        out.rejected += 1;
    } else {
        out.kept += 1;
    }
}

/// Read the day-bucket back and look for `line` verbatim. This is the "prove it is durable" half
/// of verify-before-delete: a 200 from the ingest path is a claim, and the whole point of the rule
/// is that the claim is not accepted as proof before the only other copy is destroyed.
fn bucket_contains_line(events_dir: &Path, ts_ms: i64, line: &str) -> bool {
    let Ok(contents) = std::fs::read_to_string(bucket_path(events_dir, ts_ms)) else { return false };
    // Scanned rather than "is the last line", because a concurrent append would make the last-line
    // check spuriously fail and keep a spool file whose data IS durable.
    contents.lines().any(|l| l == line)
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

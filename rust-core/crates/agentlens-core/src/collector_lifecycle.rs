//! Port of src/collectorState.ts — the collector-lifecycle half (TRDD-PJC8N1HO spec 2).
//!
//! A start marker is appended on boot; a 30s heartbeat keeps the current run's last-known-alive
//! time fresh so a crash leaves a truthful gap boundary; a graceful stop records `stoppedAt`.
//! `compute_gaps` turns the run log into the dashboard's "telemetry lost" bands — served on
//! `GET /api/collector-gaps` and carried in every SSE update frame.
//!
//! Runs are kept as raw `Value` objects (not typed structs) deliberately: the TS loader keeps
//! whatever keys a run object carries and re-serializes them verbatim, filtering only entries
//! whose `startedAt` is not a string — a typed deserialize would silently drop unknown keys and
//! reject the whole array on one malformed entry, both divergences from the TS tolerance.
//!
//! NOT PORTED: the `countFallback('collectorState.lifecycleCorrupt')` counter on a non-ENOENT
//! read failure (the P6 fallback-counter sink is unported; the fresh-store fallback itself is).

use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

use crate::summarize::helpers;

/// TS MAX_RUNS — bound the run log on a long-lived, frequently-restarted collector.
const MAX_RUNS: usize = 200;

/// computeCollectorGaps' default `minGapMs` — a clean supervised restart is sub-second and
/// carries no lost telemetry worth flagging.
pub const MIN_GAP_MS: f64 = 15_000.0;

/// server.ts LIFECYCLE_FILE.
pub fn lifecycle_file(data_dir: &Path) -> PathBuf {
    data_dir.join("collector-lifecycle.json")
}

pub struct LifecycleStore {
    pub runs: Vec<Value>,
}

/// TS loadLifecycle — tolerant: a missing/corrupt file or a non-`{runs:[…]}` shape starts
/// fresh; individual runs survive only with a string `startedAt`.
fn load(file: &Path) -> LifecycleStore {
    let runs = std::fs::read(file)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .and_then(|v| v.get("runs").and_then(Value::as_array).cloned())
        .map(|rs| rs.into_iter().filter(|r| r.get("startedAt").is_some_and(Value::is_string)).collect())
        .unwrap_or_default();
    LifecycleStore { runs }
}

/// atomicWriteFileSync (tmp + rename), best-effort — the TS wraps every persist in a bare
/// catch: the lifecycle is advisory and must never take the collector down.
fn persist(file: &Path, store: &LifecycleStore) {
    let body = serde_json::json!({ "runs": store.runs }).to_string();
    let tmp = file.with_extension("json.tmp");
    if std::fs::write(&tmp, body).is_ok() {
        let _ = std::fs::rename(&tmp, file);
    }
}

/// recordCollectorStart — append this boot's run marker and persist; the returned store is the
/// live reference heartbeats/stop mutate.
pub fn record_start(file: &Path, now_ms: i64) -> LifecycleStore {
    let mut store = load(file);
    let iso = helpers::iso_from_ms(now_ms as f64);
    let mut m = Map::new();
    m.insert("startedAt".into(), iso.clone().into());
    m.insert("lastHeartbeat".into(), iso.into());
    store.runs.push(Value::Object(m));
    if store.runs.len() > MAX_RUNS {
        store.runs = store.runs.split_off(store.runs.len() - MAX_RUNS);
    }
    persist(file, &store);
    store
}

/// recordCollectorHeartbeat — update the current (last) run's last-known-alive time in place.
pub fn record_heartbeat(file: &Path, store: &mut LifecycleStore, now_ms: i64) {
    {
        let Some(run) = store.runs.last_mut().and_then(Value::as_object_mut) else { return };
        run.insert("lastHeartbeat".into(), helpers::iso_from_ms(now_ms as f64).into());
    }
    persist(file, store);
}

/// recordCollectorStop — a GRACEFUL shutdown marker on the current run.
pub fn record_stop(file: &Path, store: &mut LifecycleStore, now_ms: i64) {
    {
        let Some(run) = store.runs.last_mut().and_then(Value::as_object_mut) else { return };
        let iso = helpers::iso_from_ms(now_ms as f64);
        run.insert("stoppedAt".into(), iso.clone().into());
        run.insert("lastHeartbeat".into(), iso.into());
    }
    persist(file, store);
}

/// computeCollectorGaps — a gap spans one run's last-known-alive time (`stoppedAt` when it shut
/// down cleanly, else `lastHeartbeat`) to the NEXT run's `startedAt`; only gaps ≥ `min_gap_ms`
/// report. Wire shape per run: `{startedAt, endedAt, durationMs, reason}` in that key order.
/// An unparseable date skips the gap exactly as the TS `Date.parse → NaN` comparison does.
pub fn compute_gaps(store: &LifecycleStore, min_gap_ms: f64) -> Vec<Value> {
    let mut gaps: Vec<Value> = Vec::new();
    for i in 1..store.runs.len() {
        let prev = &store.runs[i - 1];
        let cur = &store.runs[i];
        // `prev.stoppedAt ?? prev.lastHeartbeat` — nullish, so an empty-string stoppedAt passes
        // through here and then fails the date parse below, skipping the gap (TS-identical).
        let down_since = prev
            .get("stoppedAt")
            .and_then(Value::as_str)
            .or_else(|| prev.get("lastHeartbeat").and_then(Value::as_str))
            .unwrap_or("");
        let started = cur.get("startedAt").and_then(Value::as_str).unwrap_or("");
        let (Some(down_start), Some(down_end)) = (helpers::parse_iso_ms(down_since), helpers::parse_iso_ms(started)) else {
            continue;
        };
        // TS `!(downEndMs > downStartMs)` — its NaN arm is the parse failure the `else continue`
        // above already took (parse_iso_ms builds from integers, never Some(NaN)), so ≤ is exact.
        if down_end <= down_start {
            continue;
        }
        let duration = down_end - down_start;
        if duration < min_gap_ms {
            continue;
        }
        // TS truthiness: an absent OR empty `stoppedAt` reads as a crash.
        let reason = if prev.get("stoppedAt").and_then(Value::as_str).is_some_and(|s| !s.is_empty()) { "shutdown" } else { "crash" };
        let mut g = Map::new();
        g.insert("startedAt".into(), helpers::iso_from_ms(down_start).into());
        g.insert("endedAt".into(), helpers::iso_from_ms(down_end).into());
        g.insert("durationMs".into(), helpers::num(duration));
        g.insert("reason".into(), reason.into());
        gaps.push(Value::Object(g));
    }
    gaps
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tmp_file(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!("al-lifecycle-{}-{tag}.json", std::process::id()))
    }

    #[test]
    fn start_heartbeat_stop_round_trip_and_the_runs_bound() {
        let file = tmp_file("rt");
        let _ = std::fs::remove_file(&file);
        let mut store = record_start(&file, 1_755_600_000_000);
        assert_eq!(store.runs.len(), 1);
        record_heartbeat(&file, &mut store, 1_755_600_030_000);
        record_stop(&file, &mut store, 1_755_600_060_000);
        // Reload through record_start (a second boot): both runs persisted, keys verbatim.
        let store2 = record_start(&file, 1_755_600_120_000);
        assert_eq!(store2.runs.len(), 2);
        assert_eq!(store2.runs[0]["stoppedAt"], json!("2025-08-19T10:41:00.000Z"));
        assert_eq!(store2.runs[0]["lastHeartbeat"], json!("2025-08-19T10:41:00.000Z"));
        // The bound: pushing past MAX_RUNS keeps the newest 200.
        let mut store3 = LifecycleStore { runs: (0..205).map(|i| json!({"startedAt": format!("s{i}"), "lastHeartbeat": "x"})).collect() };
        store3.runs.push(json!({"startedAt": "last", "lastHeartbeat": "x"}));
        persist(&file, &store3);
        let bounded = record_start(&file, 0);
        assert_eq!(bounded.runs.len(), 200);
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn corrupt_or_missing_file_starts_fresh_and_bad_runs_are_filtered() {
        let file = tmp_file("corrupt");
        std::fs::write(&file, "{not json").unwrap();
        assert_eq!(load(&file).runs.len(), 0);
        std::fs::write(&file, r#"{"runs":[{"startedAt":"ok","lastHeartbeat":"x"},{"lastHeartbeat":"no-start"},{"startedAt":42},"junk",null]}"#).unwrap();
        assert_eq!(load(&file).runs.len(), 1);
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn gaps_classify_shutdown_vs_crash_and_apply_the_min_gap_floor() {
        let store = LifecycleStore {
            runs: vec![
                json!({"startedAt": "2026-08-20T10:00:00.000Z", "lastHeartbeat": "2026-08-20T10:00:30.000Z", "stoppedAt": "2026-08-20T10:00:30.000Z"}),
                json!({"startedAt": "2026-08-20T10:01:00.000Z", "lastHeartbeat": "2026-08-20T10:02:00.000Z"}),
                json!({"startedAt": "2026-08-20T10:02:20.000Z", "lastHeartbeat": "2026-08-20T10:02:25.000Z"}),
                json!({"startedAt": "2026-08-20T10:02:30.000Z", "lastHeartbeat": "2026-08-20T10:02:35.000Z"}), // 5s gap — under the floor
                json!({"startedAt": "not-a-date", "lastHeartbeat": "also-not"}),                                // unparseable — skipped both sides
                json!({"startedAt": "2026-08-20T10:03:00.000Z", "lastHeartbeat": "2026-08-20T10:03:05.000Z"}),
            ],
        };
        let gaps = compute_gaps(&store, MIN_GAP_MS);
        assert_eq!(
            serde_json::to_value(&gaps).unwrap(),
            json!([
                { "startedAt": "2026-08-20T10:00:30.000Z", "endedAt": "2026-08-20T10:01:00.000Z", "durationMs": 30000, "reason": "shutdown" },
                { "startedAt": "2026-08-20T10:02:00.000Z", "endedAt": "2026-08-20T10:02:20.000Z", "durationMs": 20000, "reason": "crash" },
            ])
        );
    }
}

//! TRDD-RBBEX59R step c1 — the in-process half of no-collection mode: the hook RING-ONLY path (in the
//! mode and with capture off), the disk-error path, the write-path-only spool drain, and the raw-body
//! pass skipped in the mode. The spawned-binary half is tests/no_collection_boot.rs.
//!
//! MUTATION CHECKS (recorded in reports_dev/rbbex59r/): drop the `no_collection` arm of
//! `hook_events::hook_ring_only_reason` and `ring_only_in_no_collection_mode` MUST fail (a disk file
//! appears); drop the condition in `chores::spool_drain_tick` and `spool_drain_runs_only_on_the_write_path`
//! MUST fail (the kept spool file is re-ringed); drop the early return in `chores::bodies_pass` and
//! `bodies_pass_does_nothing_in_no_collection_mode` MUST fail (the aged body is drained).

use std::sync::{Arc, Mutex};

use agentlens_core::chores::{bodies_pass, spool_drain_tick};
use agentlens_core::hook_events::ingest_hook_event;
use agentlens_core::{now_ms, CoreState};
use serde_json::{json, Value};

fn tmp(name: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("al-nocoll-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn ingest(st: &mut CoreState, ev: &str) -> (u16, Value, bool) {
    let payload = json!({ "hook_event_name": ev, "session_id": "aaaaaaaa-nocoll" });
    let raw = payload.to_string();
    let (status, body, proof) = ingest_hook_event(st, &payload, raw.as_bytes(), now_ms());
    (status, body, proof.is_some())
}

/// Asserts the ring-only contract: 200 with `dropped` naming the reason, no append proof, the
/// event ringed and counted as accepted, no disk record, no write counters, and P5 still runs.
fn assert_ring_only(st: &mut CoreState, data: &std::path::Path, reason: &str) {
    let (status, body, proof) = ingest(st, "SubagentStart");
    assert_eq!((status, body), (200, json!({ "ok": true, "dropped": reason })));
    assert!(!proof, "the ring-only path appends nothing");
    assert_eq!(st.recent_hook_events.len(), 1, "the event is in the ring the gate reads");
    assert_eq!(st.recent_hook_events[0]["ev"], "SubagentStart");
    assert_eq!(st.counters.hook_events_accepted, 1, "it counts as accepted (receivedSinceBoot)");
    assert!(!data.join("hook-events").exists(), "no hook-events file may appear");
    assert_eq!((st.persist.hook_event_writes, st.persist.hook_event_bytes), (0, 0), "no write counters");
    let (status, _, _) = ingest(st, "StopFailure");
    assert_eq!(status, 200);
    assert_eq!(st.counters.stop_failure_calibrations, 1, "P5 runs on the ring-only path too");
    assert_eq!(st.recent_hook_events.len(), 2);
    assert!(!data.join("hook-events").exists());
}

#[test]
fn ring_only_in_no_collection_mode() {
    let data = tmp("mode");
    let mut st = CoreState::open(&data);
    st.no_collection = true;
    assert!(st.hook_runtime.capture_enabled, "the mode alone must select the ring-only path");
    assert_ring_only(&mut st, &data, "collection=off");
}

#[test]
fn ring_only_with_capture_off() {
    let data = tmp("capoff");
    let mut st = CoreState::open(&data);
    st.hook_runtime.capture_enabled = false;
    assert_ring_only(&mut st, &data, "captureEnabled=false");
}

/// The positive control: the same reads see a present record on the write path.
#[test]
fn write_path_appends_rings_and_counts() {
    let data = tmp("write");
    let mut st = CoreState::open(&data);
    let (status, body, proof) = ingest(&mut st, "SubagentStart");
    assert_eq!((status, body), (200, json!({ "ok": true })));
    assert!(proof);
    assert_eq!(st.recent_hook_events.len(), 1);
    assert_eq!(st.counters.hook_events_accepted, 1);
    assert_eq!(st.persist.hook_event_writes, 1);
    assert!(data.join("hook-events").is_dir());
    ingest(&mut st, "StopFailure");
    assert_eq!(st.counters.stop_failure_calibrations, 1);
}

/// A failed append is a 500 that touches nothing: a spool replay later must not double-count.
#[test]
fn disk_error_puts_nothing_in_the_ring() {
    let data = tmp("diskerr");
    let mut st = CoreState::open(&data);
    // A regular file where the bucket dir must be: every append fails.
    std::fs::write(data.join("hook-events"), "not a dir").unwrap();
    let (status, _, proof) = ingest(&mut st, "SubagentStart");
    assert_eq!(status, 500);
    assert!(!proof);
    assert!(st.recent_hook_events.is_empty(), "the disk-Err path rings nothing");
    assert_eq!(st.counters.hook_events_accepted, 0);
    assert_eq!(st.persist.hook_event_writes, 0);
}

fn spool_one(data: &std::path::Path) -> std::path::PathBuf {
    let dir = data.join("hook-spool");
    std::fs::create_dir_all(&dir).unwrap();
    let f = dir.join("1700000000000-aaaa.json");
    std::fs::write(&f, json!({ "hook_event_name": "SubagentStart", "session_id": "aaaaaaaa-spool" }).to_string()).unwrap();
    f
}

#[test]
fn spool_drain_runs_only_on_the_write_path() {
    for (label, mode, capture) in [("mode", true, true), ("capoff", false, false)] {
        let data = tmp(&format!("drain-{label}"));
        let file = spool_one(&data);
        let mut st = CoreState::open(&data);
        st.no_collection = mode;
        st.hook_runtime.capture_enabled = capture;
        for _ in 0..3 {
            assert_eq!(spool_drain_tick(&mut st, now_ms(), 200), None, "{label}: the drain is skipped");
        }
        assert!(file.exists(), "{label}: the spool file is kept");
        assert!(st.recent_hook_events.is_empty(), "{label}: a kept spool file is never re-ringed");
        assert_eq!(st.counters.hook_events_accepted, 0, "{label}");
    }
    let data = tmp("drain-write");
    let file = spool_one(&data);
    let mut st = CoreState::open(&data);
    let d = spool_drain_tick(&mut st, now_ms(), 200).expect("the write path drains");
    assert_eq!(d.drained, 1);
    assert!(!file.exists(), "drained otherwise");
    assert_eq!(st.recent_hook_events.len(), 1);
}

fn write_aged_body(dir: &std::path::Path, name: &str) {
    std::fs::create_dir_all(dir).unwrap();
    let p = dir.join(name);
    let big = "b".repeat(300);
    std::fs::write(&p, format!("{{\"model\":\"claude-opus-5\",\"messages\":[{{\"role\":\"user\",\"content\":\"{big}\"}}],\"n\":1}}")).unwrap();
    let t = std::time::SystemTime::now() - std::time::Duration::from_secs(11);
    std::fs::OpenOptions::new().write(true).open(&p).unwrap().set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
}

#[test]
fn bodies_pass_does_nothing_in_no_collection_mode() {
    let name = "11111111-2222-3333-4444-666666666666.request.json";
    let data = tmp("bodies-mode");
    let bodies = data.join("otel-bodies");
    write_aged_body(&bodies, name);
    let mut st = CoreState::open(&data);
    st.no_collection = true;
    let state = Arc::new(Mutex::new(st));
    bodies_pass(&state, now_ms() as f64);
    assert!(bodies.join(name).exists(), "no raw-body pass runs in the mode: the aged body stays");
    assert!(!data.join("store").exists(), "no body store is opened in the mode");

    // Control: the same aged body IS drained by the same call with the mode off.
    let data = tmp("bodies-normal");
    let bodies = data.join("otel-bodies");
    write_aged_body(&bodies, name);
    let state = Arc::new(Mutex::new(CoreState::open(&data)));
    bodies_pass(&state, now_ms() as f64);
    assert!(!bodies.join(name).exists(), "outside the mode the aged body is drained");
}

//! TRDD-HDUETCU7: `bodies_pass` must publish its counters to `/api/server-stats`. They used to reach
//! only a log line while the emitter sent literal zeros, so `server status` always read "archived 0".
//!
//! Proves, through the real chore and the real `server_stats` emitter: a pass that deletes one body
//! reports exactly one removed file, its exact byte size, `at` == the tick time and a non-zero-pass
//! time; `persistence.bodiesLastPurge` equals `bodies.lastPass`; and a following idle tick still
//! overwrites `at` (an empty pass is a pass) while the cumulative count and `lastNonZeroPassAt` hold.
//!
//! This file holds exactly ONE `#[test]`: the stats live in a process-level static in `chores.rs`,
//! shared by every test in a binary, so a second test here would see the first one's counts.
//!
//! MUTATION CHECK: put the literal-zero object back for `lastPass` (and literal 0 for the two new
//! keys) in `server_stats.rs` and `bodies_pass_publishes_its_counters` MUST fail on `removedFiles`.

use std::sync::{Arc, Mutex};

use agentlens_core::{chores::bodies_pass, server_stats::server_stats, CoreState};

fn body(tag: &str) -> String {
    let big = "b".repeat(300);
    format!("{{\"model\":\"claude-opus-5\",\"messages\":[{{\"role\":\"user\",\"content\":\"{big}-{tag}\"}}],\"n\":1}}")
}

fn write_aged(p: &std::path::Path, raw: &str, age_secs: u64) {
    std::fs::write(p, raw).unwrap();
    let t = std::time::SystemTime::now() - std::time::Duration::from_secs(age_secs);
    std::fs::OpenOptions::new().write(true).open(p).unwrap().set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
}

#[test]
fn bodies_pass_publishes_its_counters() {
    let tmp = std::env::temp_dir().join(format!("al-bodies-pass-stats-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let data_dir = tmp.join("data");
    let bodies_dir = data_dir.join("otel-bodies");
    std::fs::create_dir_all(&bodies_dir).unwrap();

    let state = Arc::new(Mutex::new(CoreState::open(&data_dir)));
    let stats = |now: i64| server_stats(&state.lock().unwrap(), now);

    // Tick 1: one body past the 10s cutoff.
    let raw = body("one");
    let n = raw.len() as u64;
    let f = bodies_dir.join("aaaaaaaa-1111-1111-1111-111111111111.request.json");
    write_aged(&f, &raw, 15);
    let t1 = agentlens_core::now_ms();
    bodies_pass(&state, t1 as f64);
    assert!(!f.exists(), "the raw body must be gone after the pass");

    let s = stats(t1 + 1);
    let last = &s["bodies"]["lastPass"];
    assert_eq!(last["removedFiles"].as_u64().expect("removedFiles"), 1);
    assert_eq!(last["freedBytes"].as_u64().expect("freedBytes"), n);
    assert_eq!(last["at"].as_i64().expect("at"), t1);
    assert_eq!(last["keptBytes"].as_u64().expect("keptBytes"), 0);
    assert_eq!(s["bodies"]["reclaimedSinceBoot"].as_u64().expect("reclaimedSinceBoot"), 1);
    assert_eq!(s["bodies"]["lastNonZeroPassAt"].as_i64().expect("lastNonZeroPassAt"), t1);
    assert_eq!(s["persistence"]["bodiesLastPurge"], *last);

    // Tick 2: nothing staged. An idle tick is a completed, empty pass.
    let t2 = t1 + 60_000;
    bodies_pass(&state, t2 as f64);
    let s = stats(t2 + 1);
    let last = &s["bodies"]["lastPass"];
    assert_eq!(last["at"].as_i64().expect("at"), t2);
    assert_eq!(last["removedFiles"].as_u64().expect("removedFiles"), 0);
    assert_eq!(s["bodies"]["reclaimedSinceBoot"].as_u64().expect("reclaimedSinceBoot"), 1);
    assert_eq!(s["bodies"]["lastNonZeroPassAt"].as_i64().expect("lastNonZeroPassAt"), t1);

    let _ = std::fs::remove_dir_all(&tmp);
}

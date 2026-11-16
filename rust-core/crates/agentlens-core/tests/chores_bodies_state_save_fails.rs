//! TRDD-5K0YLLEF: a failed `.pass-state.json` save inside `bodies_pass` is counted, and `/api/server-stats` reports the
//! consecutive count and the epoch ms of the last failure, so a full disk shows without relying on the one-time log line.
//!
//! The save is forced to fail with no mock: `save_pass_state` first writes `<state>.json.tmp`, and a non-empty DIRECTORY at
//! that path makes `File::create` fail. The pass deletes the aged body before it saves, so the failure happens after real
//! work. The recovery half needs a second aged body: a pass with nothing staged returns before the save, so it cannot clear
//! the count.
//!
//! This file holds exactly ONE `#[test]`: the save-failure statics are process-level in `chores.rs`, shared by every test in
//! a binary.
//!
//! MUTATION CHECK: in `server_stats.rs` `bodies`, replace `"stateSaveFails": state_save_fails,` with `"stateSaveFails": 0,`.
//! `pass_state_save_failures_reach_server_stats` MUST fail on the count assertion.

use std::sync::{Arc, Mutex};

use agentlens_core::{chores::{bodies_pass, reset_state_save_failures_for_test}, server_stats::server_stats, CoreState};

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
fn pass_state_save_failures_reach_server_stats() {
    let tmp = std::env::temp_dir().join(format!("al-state-save-fails-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let data_dir = tmp.join("data");
    let bodies_dir = data_dir.join("otel-bodies");
    let store_dir = data_dir.join("store");
    std::fs::create_dir_all(&bodies_dir).unwrap();
    std::fs::create_dir_all(&store_dir).unwrap();

    // The obstacle sits at the exact temp name save_pass_state writes first, so File::create fails with EISDIR.
    let state_file = store_dir.join(agentlens_store::pass::PASS_STATE_FILE);
    let obstacle = state_file.with_extension("json.tmp");
    std::fs::create_dir_all(&obstacle).unwrap();
    std::fs::write(obstacle.join("blocker"), b"x").unwrap();

    reset_state_save_failures_for_test();
    let state = Arc::new(Mutex::new(CoreState::open(&data_dir)));
    let stats = |now: i64| server_stats(&state.lock().unwrap(), now);

    // Tick 1: the save fails. The aged body is still deleted, because the deletions run before the save.
    write_aged(&bodies_dir.join("aaaaaaaa-3333-3333-3333-333333333333.request.json"), &body("first"), 15);
    let t1 = agentlens_core::now_ms();
    bodies_pass(&state, t1 as f64);
    let s = stats(t1 + 1);
    assert!(s["bodies"]["stateSaveFails"].as_u64().expect("stateSaveFails") >= 1, "{}", s["bodies"]);
    assert_eq!(s["bodies"]["lastStateSaveFailAt"].as_u64().expect("lastStateSaveFailAt"), t1 as u64, "{}", s["bodies"]);

    // Tick 2: the obstacle is removed and a second body is staged. A pass with nothing staged returns before the save,
    // so the body is what makes this tick reach the save and clear the count.
    std::fs::remove_dir_all(&obstacle).unwrap();
    write_aged(&bodies_dir.join("bbbbbbbb-3333-3333-3333-333333333333.request.json"), &body("second"), 15);
    let t2 = t1 + 60_000;
    bodies_pass(&state, t2 as f64);
    let s = stats(t2 + 1);
    assert_eq!(s["bodies"]["stateSaveFails"].as_u64().expect("stateSaveFails"), 0, "{}", s["bodies"]);
    assert_eq!(s["bodies"]["lastStateSaveFailAt"].as_u64().expect("lastStateSaveFailAt"), t1 as u64, "the last failure time survives recovery");
    assert!(state_file.exists(), "the recovered pass must have saved the state file");

    let _ = std::fs::remove_dir_all(&tmp);
}
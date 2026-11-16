//! TRDD-FINMFYDE round 2: an unreadable `.pass-state.json` seen by alcore's bodies pass is moved aside to
//! `.pass-state.json.corrupt-<unix_ms>` with its bytes intact, and the same pass rebuilds a valid state file in place.
//!
//! The state is read only on a tick that has staged bodies (an idle tick returns before the load), so the setup stages
//! one aged body in the bodies dir, as the stats test does.
//!
//! This file holds exactly ONE `#[test]`: the failed-move counter is a process-level static in `chores.rs`, shared by
//! every test in a binary.
//!
//! MUTATION CHECK: in `chores.rs` `bodies_pass`, replace the move-aside with an early `return;` (the old skip-the-tick
//! behaviour). `bodies_pass_moves_an_unreadable_state_aside_and_rebuilds_it` MUST fail on the moved-aside assertion.

use std::sync::{Arc, Mutex};

use agentlens_core::{chores::bodies_pass, CoreState};

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
fn bodies_pass_moves_an_unreadable_state_aside_and_rebuilds_it() {
    let tmp = std::env::temp_dir().join(format!("al-bodies-corrupt-state-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let data_dir = tmp.join("data");
    let bodies_dir = data_dir.join("otel-bodies");
    let store_dir = data_dir.join("store");
    std::fs::create_dir_all(&bodies_dir).unwrap();
    std::fs::create_dir_all(&store_dir).unwrap();

    let state_file = store_dir.join(agentlens_store::pass::PASS_STATE_FILE);
    let corrupt: &[u8] = b"{not json";
    std::fs::write(&state_file, corrupt).unwrap();
    write_aged(&bodies_dir.join("aaaaaaaa-2222-2222-2222-222222222222.request.json"), &body("corrupt-state"), 15);

    let state = Arc::new(Mutex::new(CoreState::open(&data_dir)));
    bodies_pass(&state, agentlens_core::now_ms() as f64);

    let moved: Vec<std::path::PathBuf> = std::fs::read_dir(&store_dir)
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|p| p.file_name().unwrap().to_string_lossy().starts_with(".pass-state.json.corrupt-"))
        .collect();
    assert_eq!(moved.len(), 1, "exactly one moved-aside state file, found {moved:?}");
    assert_eq!(std::fs::read(&moved[0]).unwrap(), corrupt, "the moved-aside file must keep the original bytes");

    let rebuilt: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(&state_file).unwrap())
        .expect("the pass must save a valid state file in place");
    assert!(rebuilt["skipNames"].is_array() && rebuilt["strandedNames"].is_array(), "{rebuilt}");
    let _ = std::fs::remove_dir_all(&tmp);
}
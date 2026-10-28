//! TRDD-ZR3OGSAV: the alstore CLI contract when the pass state file cannot be saved — exit 3 with
//! the cause on stderr, and `unpark` prints no counts. Runs the real built binary.
//!
//! The state path is made a non-empty directory: `unpark` loads it as "empty" (unreadable file),
//! then the save's temp write succeeds and the rename onto the directory fails.

use std::process::Command;

#[test]
fn unpark_exits_3_and_prints_no_counts_when_the_state_cannot_be_saved() {
    let dir = std::env::temp_dir().join(format!("al-cli-unpark-fail-{}", std::process::id()));
    std::fs::remove_dir_all(&dir).ok(); // robust to a leftover from a crashed earlier run
    let state = dir.join(agentlens_store::pass::PASS_STATE_FILE);
    std::fs::create_dir_all(&state).unwrap();
    std::fs::write(state.join("occupant"), b"x").unwrap();
    let names = dir.join("names.txt");
    std::fs::write(&names, "a.request.json\n").unwrap();

    let out = Command::new(env!("CARGO_BIN_EXE_alstore"))
        .args(["unpark", dir.to_str().unwrap(), "--names-file", names.to_str().unwrap()])
        .output()
        .expect("run alstore");

    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(3), "stderr: {stderr}");
    assert!(stderr.contains("alstore: cannot save"), "stderr: {stderr}");
    assert!(out.stdout.is_empty(), "no counts may be printed for an unpark that did not persist: {:?}", out.stdout);
    std::fs::remove_dir_all(&dir).ok();
}

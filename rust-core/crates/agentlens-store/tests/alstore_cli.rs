//! TRDD-ZR3OGSAV: the alstore CLI contract when the pass state file cannot be saved — exit 3 with
//! the cause on stderr, and `unpark` prints no counts. Runs the real built binary.
//!
//! The state file is a REAL, valid one (so the load reads it faithfully) and only the SAVE is made to
//! fail: its temp path (`.pass-state.json.tmp`) is a non-empty directory, so the temp write fails with
//! EISDIR. The original state file must be byte-identical afterwards.

use std::process::Command;

#[test]
fn unpark_exits_3_and_prints_no_counts_when_the_state_cannot_be_saved() {
    let dir = std::env::temp_dir().join(format!("al-cli-unpark-fail-{}", std::process::id()));
    std::fs::remove_dir_all(&dir).ok(); // robust to a leftover from a crashed earlier run
    std::fs::create_dir_all(&dir).unwrap();
    let state = dir.join(agentlens_store::pass::PASS_STATE_FILE);
    let original = br#"{"skipNames":[],"strandedNames":["a.request.json","b.request.json"]}"#;
    std::fs::write(&state, original).unwrap();
    // save_pass_state writes `p.with_extension("json.tmp")`; a non-empty directory there fails the write.
    let tmp = state.with_extension("json.tmp");
    std::fs::create_dir_all(&tmp).unwrap();
    std::fs::write(tmp.join("occupant"), b"x").unwrap();
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
    assert_eq!(std::fs::read(&state).unwrap(), original, "the original state file must be untouched");
    std::fs::remove_dir_all(&dir).ok();
}

/// TRDD-FINMFYDE: `unpark` refuses a state file it cannot read: exit 4, nothing on stdout, file byte-identical.
#[test]
fn unpark_exits_4_and_leaves_a_corrupt_state_file_untouched() {
    let dir = std::env::temp_dir().join(format!("al-cli-unpark-corrupt-{}", std::process::id()));
    std::fs::remove_dir_all(&dir).ok(); // robust to a leftover from a crashed earlier run
    std::fs::create_dir_all(&dir).unwrap();
    let state = dir.join(agentlens_store::pass::PASS_STATE_FILE);
    let original = b"{not json";
    std::fs::write(&state, original).unwrap();
    let names = dir.join("names.txt");
    std::fs::write(&names, "a.request.json\n").unwrap();

    let out = Command::new(env!("CARGO_BIN_EXE_alstore"))
        .args(["unpark", dir.to_str().unwrap(), "--names-file", names.to_str().unwrap()])
        .output()
        .expect("run alstore");

    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(4), "stderr: {stderr}");
    assert!(stderr.contains("alstore: cannot read pass state"), "stderr: {stderr}");
    assert!(out.stdout.is_empty(), "no counts may be printed for an unpark that refused: {:?}", out.stdout);
    assert_eq!(std::fs::read(&state).unwrap(), original, "the corrupt state file must be untouched");
    std::fs::remove_dir_all(&dir).ok();
}

/// TRDD-FINMFYDE: `pass` refuses a state file it cannot read: exit 4, nothing on stdout, file byte-identical.
#[test]
fn pass_exits_4_and_leaves_a_corrupt_state_file_untouched() {
    let dir = std::env::temp_dir().join(format!("al-cli-pass-corrupt-{}", std::process::id()));
    std::fs::remove_dir_all(&dir).ok(); // robust to a leftover from a crashed earlier run
    let store = dir.join("store");
    let bodies = dir.join("bodies");
    std::fs::create_dir_all(&store).unwrap();
    std::fs::create_dir_all(&bodies).unwrap();
    let state = store.join(agentlens_store::pass::PASS_STATE_FILE);
    let original = b"{not json";
    std::fs::write(&state, original).unwrap();

    let out = Command::new(env!("CARGO_BIN_EXE_alstore"))
        .args(["pass", store.to_str().unwrap(), bodies.to_str().unwrap()])
        .output()
        .expect("run alstore");

    let stderr = String::from_utf8_lossy(&out.stderr);
    assert_eq!(out.status.code(), Some(4), "stderr: {stderr}");
    assert!(stderr.contains("alstore: cannot read pass state"), "stderr: {stderr}");
    assert!(out.stdout.is_empty(), "no pass report may be printed for a pass that refused: {:?}", out.stdout);
    assert_eq!(std::fs::read(&state).unwrap(), original, "the corrupt state file must be untouched");
    std::fs::remove_dir_all(&dir).ok();
}

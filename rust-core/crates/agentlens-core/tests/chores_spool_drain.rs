//! TRDD-ZW4APOPI box 1: a body written to the CONFIGURED spool dir is ingested and reclaimed by
//! `bodies_pass`. The incident: the chore drained only the legacy `otel-bodies` dir, so a 2 GB
//! RAM-disk spool filled to 100% while every pass reported an empty dir and capture silently
//! lost bodies.
//!
//! MUTATION CHECK: point the drain in `bodies_pass` back at `data_dir.join("otel-bodies")` alone
//! and `spool_body_is_ingested_and_reclaimed` MUST fail (the spool file survives the pass).

use std::sync::{Arc, Mutex};

use agentlens_core::{chores::bodies_pass, CoreState};

fn body(tag: &str) -> String {
    let big = "b".repeat(300);
    format!("{{\"model\":\"claude-opus-5\",\"messages\":[{{\"role\":\"user\",\"content\":\"{big}-{tag}\"}}],\"n\":1}}")
}

fn write_aged(p: &std::path::Path, raw: &str, age_hours: u64) {
    std::fs::write(p, raw).unwrap();
    let t = std::time::SystemTime::now() - std::time::Duration::from_secs(age_hours * 3600);
    std::fs::OpenOptions::new().write(true).open(p).unwrap().set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
}

#[test]
fn spool_body_is_ingested_and_reclaimed() {
    let tmp = std::env::temp_dir().join(format!("al-spool-drain-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let data_dir = tmp.join("data");
    let spool_dir = tmp.join("spool");
    let legacy_dir = data_dir.join("otel-bodies");
    std::fs::create_dir_all(&spool_dir).unwrap();
    std::fs::create_dir_all(&legacy_dir).unwrap();
    std::fs::write(
        data_dir.join("config.json"),
        serde_json::json!({ "capture": { "rawBodies": true, "spoolDir": spool_dir.to_str().unwrap() } }).to_string(),
    )
    .unwrap();

    // The spool is drained on sight (age 0): a body written seconds ago must go. The legacy dir
    // keeps its batching age gate (72 h by default), so its body is aged past it to prove the
    // second dir is still drained too — the fix must ADD the spool, not swap to it.
    let spool_body = spool_dir.join("fresh.request.json");
    std::fs::write(&spool_body, body("spool")).unwrap();
    let legacy_body = legacy_dir.join("old.request.json");
    write_aged(&legacy_body, &body("legacy"), 73);

    let state = Arc::new(Mutex::new(CoreState::open(&data_dir)));
    bodies_pass(&state, agentlens_core::now_ms() as f64);

    assert!(!spool_body.exists(), "a body in the configured spool must be ingested and reclaimed by the pass");
    assert!(!legacy_body.exists(), "the legacy dir must still be drained alongside the spool");

    // A pass never deletes what the store cannot reproduce, so the two deletions are two proofs;
    // and the drained state persists — a second pass finds nothing and changes nothing.
    bodies_pass(&state, agentlens_core::now_ms() as f64);
    assert_eq!(std::fs::read_dir(&spool_dir).unwrap().count(), 0);
    assert_eq!(std::fs::read_dir(&legacy_dir).unwrap().count(), 0);

    let _ = std::fs::remove_dir_all(&tmp);
}

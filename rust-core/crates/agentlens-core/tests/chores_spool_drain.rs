//! TRDD-Z53IJFE9 step B: with the RAM-disk spool gone, `bodies_pass`'s SSD-dir age gate is what
//! now stands between "a body still being written" and "ingested mid-write". This file used to
//! prove the (retired) spool got drained alongside the legacy dir (TRDD-ZW4APOPI box 1); it now
//! proves the SSD dir's 10s age gate itself: a body younger than 10s is left alone for the next
//! tick, and only ages into the drain once it clears the cutoff.
//!
//! MUTATION CHECK: change `max_age_ms` in `bodies_pass` to `0` (age-0, "drain on sight" like the
//! old spool arm) and `young_body_is_left_for_next_tick` MUST fail (a 0s-old body would be
//! ingested immediately instead of surviving the first pass).

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
fn young_body_is_left_for_next_tick() {
    let tmp = std::env::temp_dir().join(format!("al-bodies-young-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let data_dir = tmp.join("data");
    let bodies_dir = data_dir.join("otel-bodies");
    std::fs::create_dir_all(&bodies_dir).unwrap();

    // Written "now" (0s old) — well inside the new 10s cutoff, mirroring a body Claude Code is
    // still writing when the tick fires.
    let name = "11111111-2222-3333-4444-555555555555.request.json";
    let raw = body("young");
    write_aged(&bodies_dir.join(name), &raw, 0);

    let state = Arc::new(Mutex::new(CoreState::open(&data_dir)));
    bodies_pass(&state, agentlens_core::now_ms() as f64);

    assert!(bodies_dir.join(name).exists(), "a body under the 10s age gate must survive one pass untouched");

    // Age it past the cutoff (mirrors the next tick, 10s+ later) and prove the SAME pass code
    // path drains it once it clears the gate — the file was left alone, not silently lost.
    write_aged(&bodies_dir.join(name), &raw, 11);
    bodies_pass(&state, agentlens_core::now_ms() as f64);
    assert!(!bodies_dir.join(name).exists(), "the same body must be drained once it ages past the 10s cutoff");

    let _ = std::fs::remove_dir_all(&tmp);
}

//! TRDD-Z53IJFE9 step B: the RAM-disk spool is gone — `bodies_pass` now drains the SSD
//! `<data>/otel-bodies` dir directly, on a 10s age cutoff instead of the legacy 72h batching
//! wait. This file used to prove the spool got the same on-sight drain the legacy dir lacked
//! (TRDD-ZW4APOPI); that regression is retired along with the spool, so the test now proves the
//! SSD dir's own on-sight drain: a body already 10s+ old is ingested, deleted, and reconstructs
//! byte-for-byte from the store it was ingested into.
//!
//! MUTATION CHECK: revert `max_age_ms` in `bodies_pass` back to the legacy
//! `(max_age_hours * 3_600_000.0) as i64` (72h default) and `fresh_body_is_ingested_and_round_trips`
//! MUST fail (the body is still there — 15s old is nowhere near 72h).

use std::sync::{Arc, Mutex};

use agentlens_core::{chores::bodies_pass, CoreState};

fn body(tag: &str) -> String {
    let big = "b".repeat(300);
    format!("{{\"model\":\"claude-opus-5\",\"messages\":[{{\"role\":\"user\",\"content\":\"{big}-{tag}\"}}],\"n\":1}}")
}

/// Write `raw` to `p` and set its mtime `age_secs` in the past — mirrors real capture (Claude
/// Code writes the file, then it ages on disk) rather than relying on wall-clock sleeps.
fn write_aged(p: &std::path::Path, raw: &str, age_secs: u64) -> i64 {
    std::fs::write(p, raw).unwrap();
    let t = std::time::SystemTime::now() - std::time::Duration::from_secs(age_secs);
    std::fs::OpenOptions::new().write(true).open(p).unwrap().set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
    t.duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as i64
}

#[test]
fn fresh_body_is_ingested_and_round_trips() {
    let tmp = std::env::temp_dir().join(format!("al-bodies-ssd-drain-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let data_dir = tmp.join("data");
    let bodies_dir = data_dir.join("otel-bodies");
    std::fs::create_dir_all(&bodies_dir).unwrap();

    // 15s old clears the new 10s cutoff comfortably without depending on how long the ingest
    // itself takes to run.
    let name = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.request.json";
    let raw = body("fresh");
    let mtime_ms = write_aged(&bodies_dir.join(name), &raw, 15);

    let state = Arc::new(Mutex::new(CoreState::open(&data_dir)));
    bodies_pass(&state, agentlens_core::now_ms() as f64);

    assert!(!bodies_dir.join(name).exists(), "a body already 10s+ old must be ingested and reclaimed by one pass");

    // Round-trip: the pass only deletes after `verify_bodies_in_store_cached` proves the store
    // reconstructs the file byte-for-byte — re-run that same proof here, independently, against
    // the store the pass just wrote to.
    let store_dir = data_dir.join("store");
    let store = agentlens_store::open_store(&store_dir, "512MB", 1).expect("store must exist — the pass created it");
    let items = [agentlens_store::VerifyItem { src_name: name.to_string(), raw: raw.clone(), ts_ms: Some(mtime_ms) }];
    let results = agentlens_store::verify_bodies_in_store(&store, &items).expect("verify query must succeed");
    let result = results.get(name).expect("the ingested body must have a verify result");
    assert!(result.ok, "round-trip verify failed: {:?}", result.reason);

    let _ = std::fs::remove_dir_all(&tmp);
}

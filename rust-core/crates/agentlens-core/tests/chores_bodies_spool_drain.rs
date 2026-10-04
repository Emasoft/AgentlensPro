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

// `bodies_pass` takes the process-wide heavy DuckDB slot (agentlens_store::transcript_sql::HEAVY)
// and SKIPS its tick when it cannot get it within 1s. That skip is the production behaviour under
// contention, not what these tests are about, so they run one at a time: without this, two tests
// calling `bodies_pass` in parallel make the loser's pass a no-op and its assertion fails.
static SLOT: Mutex<()> = Mutex::new(());

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
    let _serial = SLOT.lock().unwrap_or_else(|e| e.into_inner());
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



/// The over-cap emergency valve (TRDD-V79W9T2R): under `bodiesMaxGb` a body captured moments ago
/// is left alone (the 10s cutoff); once the staged bytes exceed the cap, the same body is ingested
/// at age 0 and reclaimed. The knob floors at `BODIES_MAX_GB.min` (set via config.json), so the cap is crossed with a
/// SPARSE junk file (apparent length floor + 1 MiB, no disk used; unreadable, so the pass keeps it).
///
/// MUTATION CHECK: change `if over_cap { 0 } else { 10_000 }` in `bodies_pass` to `10_000` and
/// the second half MUST fail (the fresh body is still there).
#[test]
fn over_cap_valve_drains_a_body_younger_than_the_age_cutoff() {
    let _serial = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    let tmp = std::env::temp_dir().join(format!("al-bodies-over-cap-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let data_dir = tmp.join("data");
    let bodies_dir = data_dir.join("otel-bodies");
    std::fs::create_dir_all(&bodies_dir).unwrap();

    let name = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee.request.json";
    write_aged(&bodies_dir.join(name), &body("young"), 0);
    let state = Arc::new(Mutex::new(CoreState::open(&data_dir)));

    // Control: under the cap a 0s-old body is below the 10s cutoff, so one pass keeps it.
    bodies_pass(&state, agentlens_core::now_ms() as f64);
    assert!(bodies_dir.join(name).exists(), "under the cap a fresh body must wait out the 10s cutoff");

    // Drop the cap to its floor (the default is higher), then push the staged bytes over it
    // without writing them. Both the knob key and the junk size derive from the knob itself.
    let knob = &agentlens_core::retention_config::BODIES_MAX_GB;
    std::fs::write(data_dir.join("config.json"), format!(r#"{{"retention":{{"{}":{}}}}}"#, knob.key, knob.min)).unwrap();
    let over_cap_bytes = (knob.min * 1024.0 * 1024.0 * 1024.0) as u64 + 1024 * 1024;
    // mode 000: counted by `staged_body_bytes` (metadata only) but the pass cannot read it, so it
    // is skipped instead of being slurped and parsed (over half a GiB of it exhausts memory).
    let junk_path = bodies_dir.join("bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee.response.json");
    let junk = std::fs::File::create(&junk_path).unwrap();
    junk.set_len(over_cap_bytes).unwrap();
    drop(junk);
    std::fs::set_permissions(&junk_path, std::os::unix::fs::PermissionsExt::from_mode(0o000)).unwrap();

    bodies_pass(&state, agentlens_core::now_ms() as f64);
    assert!(!bodies_dir.join(name).exists(), "over the cap the valve must ingest at age 0 and reclaim the fresh body");

    let _ = std::fs::remove_dir_all(&tmp);
}

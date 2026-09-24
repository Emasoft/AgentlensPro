//! TRDD-Z53IJFE9 step B, advisor verdict B-1: parquet parts are immutable once written, so a
//! part fsynced on one tick of `bodies_pass` must stay proven-durable on the next tick instead of
//! the barrier recomputing (and re-fsyncing) every part in the store from scratch every 60s.
//!
//! There is no fsync-call counter to assert on directly, so this proves the OBSERVABLE contract
//! the fix provides: `chores::fsynced_parts_snapshot_for_test()` — the persisted set the barrier
//! consults — is non-empty after the first tick that ingests a durable body, and a SUPERSET of
//! itself (grown, not reset) after a second tick ingests another one.
//!
//! MUTATION CHECK: revert `bodies_pass` to build `fsynced` as a fresh `HashSet::new()` local to
//! the function (instead of the module-level `FSYNCED_PARTS` static) and
//! `fsynced_parts_persist_across_ticks` MUST fail — the snapshot function would report an empty
//! set forever, since nothing would ever populate the static it reads.

use std::sync::{Arc, Mutex};

use agentlens_core::{chores::bodies_pass, chores::fsynced_parts_snapshot_for_test, CoreState};

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
fn fsynced_parts_persist_across_ticks() {
    let tmp = std::env::temp_dir().join(format!("al-bodies-fsync-persist-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let data_dir = tmp.join("data");
    let bodies_dir = data_dir.join("otel-bodies");
    std::fs::create_dir_all(&bodies_dir).unwrap();
    let store_dir = data_dir.join("store");

    let state = Arc::new(Mutex::new(CoreState::open(&data_dir)));

    // Tick 1: one durable body, well past the 10s cutoff.
    write_aged(&bodies_dir.join("aaaaaaaa-1111-1111-1111-111111111111.request.json"), &body("one"), 15);
    bodies_pass(&state, agentlens_core::now_ms() as f64);
    let after_tick1: std::collections::HashSet<_> =
        fsynced_parts_snapshot_for_test().into_iter().filter(|p| p.starts_with(&store_dir)).collect();
    assert!(!after_tick1.is_empty(), "the fsync barrier must have proven at least one part durable on tick 1");

    // Tick 2: a second durable body. If the set were rebuilt fresh every tick (the pre-fix bug),
    // the FIRST tick's parts would simply never appear in the persisted static at all (it isn't
    // touched), so this assertion is really checking "the static exists and accumulates" — the
    // superset check on top proves it isn't being cleared between ticks either.
    write_aged(&bodies_dir.join("bbbbbbbb-2222-2222-2222-222222222222.request.json"), &body("two"), 15);
    bodies_pass(&state, agentlens_core::now_ms() as f64);
    let after_tick2: std::collections::HashSet<_> =
        fsynced_parts_snapshot_for_test().into_iter().filter(|p| p.starts_with(&store_dir)).collect();

    assert!(after_tick2.is_superset(&after_tick1), "parts proven durable on tick 1 must still be in the set after tick 2");
    assert!(after_tick2.len() > after_tick1.len(), "tick 2's own new part(s) must be added, not just tick 1's kept");

    let _ = std::fs::remove_dir_all(&tmp);
}

//! TRDD-5PUD8RKE box 3: `bodies_pass` must set real spool back-pressure counters instead of the
//! hardcoded `spoolBackpressureSpills: 0, spoolBackpressureActive: false` `/api/server-stats`
//! used to report.
//!
//! MUTATION CHECK: comment out the `spool_backpressure::tick` call site in `bodies_pass` and
//! `spool_over_floor_counts_a_spill` MUST fail (the counters stay stuck at 0/false).

use std::sync::{Arc, Mutex};

use agentlens_core::{chores::bodies_pass, CoreState};

/// `AGENTLENS_SPOOL_FLOOR_MB` is process-global; cargo runs this file's tests on separate threads
/// by default, so serialize the two that touch it or they race each other's env var.
static ENV_LOCK: Mutex<()> = Mutex::new(());

fn setup(tmp_name: &str) -> (std::path::PathBuf, std::path::PathBuf) {
    let tmp = std::env::temp_dir().join(format!("al-spool-bp-{tmp_name}-{}", std::process::id()));
    let data_dir = tmp.join("data");
    let spool_dir = tmp.join("spool");
    std::fs::create_dir_all(&data_dir).unwrap();
    std::fs::create_dir_all(&spool_dir).unwrap();
    std::fs::create_dir_all(data_dir.join("otel-bodies")).unwrap();
    std::fs::write(
        data_dir.join("config.json"),
        serde_json::json!({ "capture": { "rawBodies": true, "spoolDir": spool_dir.to_str().unwrap() } }).to_string(),
    )
    .unwrap();
    (data_dir, spool_dir)
}

/// A floor set absurdly high (bigger than any real filesystem's free space) forces `over_capacity`
/// true every tick — the counter must go active and record exactly one spill.
#[test]
fn spool_over_floor_counts_a_spill() {
    let _guard = ENV_LOCK.lock().unwrap();
    let (data_dir, _spool_dir) = setup("over");
    std::env::set_var("AGENTLENS_SPOOL_FLOOR_MB", "999999999999");

    let state = Arc::new(Mutex::new(CoreState::open(&data_dir)));
    bodies_pass(&state, agentlens_core::now_ms() as f64);

    {
        let st = state.lock().unwrap();
        assert!(st.persist.spool_backpressure_active, "floor far above free space must read as over-capacity");
        assert_eq!(st.persist.spool_backpressure_spills, 1, "one transition into over-capacity must count as one spill");
    }

    // A second tick while still over capacity must NOT count a second spill (transitions only).
    bodies_pass(&state, agentlens_core::now_ms() as f64);
    {
        let st = state.lock().unwrap();
        assert_eq!(st.persist.spool_backpressure_spills, 1, "staying over-capacity must not re-increment the spill count");
    }

    std::env::remove_var("AGENTLENS_SPOOL_FLOOR_MB");
    let _ = std::fs::remove_dir_all(data_dir.parent().unwrap());
}

/// The default floor (64MB) is comfortably below a fresh temp dir's free space — the normal path
/// must leave the counters at their untouched defaults.
#[test]
fn spool_under_floor_leaves_counters_at_zero() {
    let _guard = ENV_LOCK.lock().unwrap();
    let (data_dir, _spool_dir) = setup("under");
    std::env::remove_var("AGENTLENS_SPOOL_FLOOR_MB");

    let state = Arc::new(Mutex::new(CoreState::open(&data_dir)));
    bodies_pass(&state, agentlens_core::now_ms() as f64);

    let st = state.lock().unwrap();
    assert!(!st.persist.spool_backpressure_active, "default floor must not report over-capacity on a normal machine");
    assert_eq!(st.persist.spool_backpressure_spills, 0);
    drop(st);

    let _ = std::fs::remove_dir_all(data_dir.parent().unwrap());
}

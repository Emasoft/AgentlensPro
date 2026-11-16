//! TRDD-H3D5ZBO1: the bodies-folder scan runs with NO state lock held, in a task the burn tick
//! starts and never awaits. Each test builds its own CoreState and data dir, so they share nothing.

use agentlens_core::burn::bodies_activity::{run_bodies_scan, run_bodies_scan_with};
use agentlens_core::burn::guard::default_bodies_dir;
use agentlens_core::{CoreState, LockTimed};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Barrier, Mutex};
use std::time::{Duration, Instant};

const SID: &str = "11111111-aaaa-bbbb-cccc-000000000001";

fn now_ms() -> f64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis() as f64
}

struct Fixture {
    root: PathBuf,
    bodies: PathBuf,
    state: Arc<Mutex<CoreState>>,
}

impl Fixture {
    fn new(tag: &str) -> Fixture {
        static N: AtomicU32 = AtomicU32::new(0);
        let root = std::env::temp_dir().join(format!("bodies-scan-off-lock-{tag}-{}-{}", std::process::id(), N.fetch_add(1, Ordering::SeqCst)));
        std::fs::create_dir_all(&root).unwrap();
        let bodies = default_bodies_dir(&root);
        std::fs::create_dir_all(&bodies).unwrap();
        let state = Arc::new(Mutex::new(CoreState::open(&root)));
        Fixture { root, bodies, state }
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

fn write_response(dir: &Path, name: &str, id: &str, cc: u64, cr: u64) {
    let body = serde_json::json!({
        "id": id, "model": "claude-opus-5",
        "usage": { "cache_creation_input_tokens": cc, "cache_read_input_tokens": cr,
                   "cache_creation": { "ephemeral_5m_input_tokens": 0, "ephemeral_1h_input_tokens": cc } },
    });
    std::fs::write(dir.join(name), body.to_string()).unwrap();
}

/// A HUGE request (over 1 MB): model up front, session id + previous message id in the tail.
fn write_huge_request(dir: &Path, name: &str) {
    let body = format!(
        "{{\"model\":\"claude-opus-5\",\"pad\":\"{}\",\"metadata\":{{\"user_id\":\"{{\\\"session_id\\\":\\\"{SID}\\\"}}\"}},\"diagnostics\":{{\"previous_message_id\":\"msg_p\"}}}}",
        "x".repeat(1_100_000)
    );
    std::fs::write(dir.join(name), body).unwrap();
}

fn in_progress(f: &Fixture, now: f64) -> bool {
    f.state.lock_timed().burn.bodies.scan_status(now)["inProgress"].as_bool().unwrap()
}

/// A parked scan holds neither the state lock nor leaves room for a second scan; once released
/// its findings land and the report says seeded and idle.
#[test]
fn a_parked_scan_holds_no_state_lock_and_blocks_a_second_scan() {
    let f = Fixture::new("t1");
    write_response(&f.bodies, "a.response.json", "msg_a", 150_000, 100);
    let t = now_ms();
    let b1 = Arc::new(Barrier::new(2));
    let b2 = Arc::new(Barrier::new(2));
    let (state, c1, c2) = (f.state.clone(), b1.clone(), b2.clone());
    let a = std::thread::spawn(move || {
        let mut first = true;
        run_bodies_scan_with(&state, t, || t, &mut || {
            if std::mem::take(&mut first) {
                c1.wait();
                c2.wait();
            }
        });
    });
    b1.wait(); // the scan is now parked inside its first entry
    drop(f.state.try_lock().expect("the state lock must be free while the scan runs"));
    assert!(in_progress(&f, t), "the scan is in flight");
    let scanned = std::cell::Cell::new(false);
    let started = Instant::now();
    run_bodies_scan_with(&f.state, t, || t, &mut || scanned.set(true));
    assert!(!scanned.get(), "a second scan must not scan while one is in flight");
    assert!(started.elapsed() < Duration::from_secs(1), "the second call must return at once");
    b2.wait();
    a.join().unwrap();

    let mut st = f.state.lock_timed();
    assert_eq!(st.burn.bodies.report(t)["premium"]["sampled"], serde_json::json!(1), "the response must be merged");
    let risk = st.burn_risk_report(t, None, None, None)["bodiesScan"].clone();
    assert_eq!(risk["seeded"], serde_json::json!(true));
    assert_eq!(risk["inProgress"], serde_json::json!(false));
}

/// A scan that panics clears `in_flight`, leaves the poller usable and loses nothing: the next
/// scan still reports the file.
#[test]
fn a_panicking_scan_clears_in_flight_and_loses_nothing() {
    let f = Fixture::new("t2");
    write_response(&f.bodies, "a.response.json", "msg_a", 150_000, 100);
    let t = now_ms();
    let state = f.state.clone();
    let r = std::thread::spawn(move || run_bodies_scan_with(&state, t, || t, &mut || panic!("injected scan panic"))).join();
    assert!(r.is_err(), "the injected panic must reach join");
    assert!(!in_progress(&f, t), "in_flight must be cleared by the panic path");
    run_bodies_scan(&f.state);
    assert_eq!(f.state.lock_timed().burn.bodies.report(now_ms())["premium"]["sampled"], serde_json::json!(1), "the file must not be lost");
}

/// The rings are pruned against MERGE time, not scan time: a fat request found at `t` is gone
/// when the merge happens 11 minutes later, and still there when the merge happens at `t`.
#[test]
fn rings_are_pruned_against_merge_time() {
    let late = Fixture::new("t3a");
    write_huge_request(&late.bodies, "r.request.json");
    let t = now_ms();
    run_bodies_scan_with(&late.state, t, || t + 11.0 * 60_000.0, &mut || {});
    assert_eq!(late.state.lock_timed().burn.bodies.report(t)["hugeRequests90s"]["count"], serde_json::json!(0), "pruned at merge time");

    let control = Fixture::new("t3b");
    write_huge_request(&control.bodies, "r.request.json");
    let t = now_ms();
    run_bodies_scan_with(&control.state, t, || t, &mut || {});
    assert_eq!(control.state.lock_timed().burn.bodies.report(t)["hugeRequests90s"]["count"], serde_json::json!(1), "control: kept when merged at scan time");
}
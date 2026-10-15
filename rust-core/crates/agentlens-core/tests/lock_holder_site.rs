//! TRDD-7EZE3AIZ: this file must hold exactly one test. Cargo runs each integration-test file as its own process, but tests inside one file run in parallel threads and would race on the process-wide holder slot (HOLDER_SITE). CoreState::open starts no thread and nothing else in this process takes the state lock, so the slot is ours. If a background holder ever appears, the exact-line asserts fail loudly, never pass silently.

use agentlens_core::shutdown::{flush_with_deadline, Outcome};
use agentlens_core::{current_lock_holder, CoreState, LockTimed};
use std::sync::{Arc, Mutex};
use std::time::Duration;

#[test]
fn lock_holder_site_is_recorded_cleared_and_named_on_timeout() {
    let dir = std::env::temp_dir().join(format!("agentlens-lock-holder-site-{}", std::process::id()));
    let m = Arc::new(Mutex::new(CoreState::open(&dir)));

    // (a) The guard records its own acquisition line as the holder; dropping it clears the slot.
    let g = m.lock_timed().unwrap();
    let line_a = line!() - 1;
    let (site, _) = current_lock_holder().expect("holder recorded");
    assert!(site.ends_with(&format!("lock_holder_site.rs:{line_a}")), "got {site}");
    drop(g);
    assert!(current_lock_holder().is_none(), "holder cleared on drop");

    // (b) A holder thread names its own lock line; a bounded flush must time out and report it.
    let (tx, rx) = std::sync::mpsc::channel();
    let holder = m.clone();
    let t = std::thread::spawn(move || {
        let _g = holder.lock_timed().unwrap();
        let line_of_lock = line!() - 1;
        tx.send(line_of_lock).unwrap();
        std::thread::sleep(Duration::from_millis(2000));
    });
    let line_b = rx.recv().unwrap();
    match flush_with_deadline(&m, Duration::from_millis(200)) {
        Outcome::TimedOut { holder: Some(h) } => {
            assert!(h.contains(&format!("lock_holder_site.rs:{line_b}")), "holder should name line {line_b}, got {h}");
            assert!(h.contains(" (holding for "), "holder should carry the held time, got {h}");
        }
        Outcome::TimedOut { holder: None } => panic!("expected a named holder, got None"),
        Outcome::Flushed(_) => panic!("expected TimedOut, got Flushed"),
        Outcome::Poisoned => panic!("expected TimedOut, got Poisoned"),
    }
    t.join().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}

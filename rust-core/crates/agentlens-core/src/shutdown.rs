//! TRDD-N60JUWU3: `server stop` must be able to make progress without a cooperative lock
//! holder. A bare `state.lock_timed()` (a plain blocking `Mutex::lock()`) has no deadline and
//! no priority over any other request path queuing for the same lock, so any long holder can
//! starve the shutdown flush indefinitely — the operator's only exit was a SIGKILL that skipped
//! `pid_lock::release` and lost whatever hadn't flushed yet.

use crate::CoreState;
use std::sync::{Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant};

/// What a bounded flush attempt concluded.
pub enum Outcome<'a> {
    /// The lock was acquired within the deadline; the guard is handed back for the caller to
    /// flush through.
    Flushed(MutexGuard<'a, CoreState>),
    /// The deadline elapsed while the lock was held elsewhere. Carries the holder site (with how
    /// long it had been held), when known, so the caller can name what it was stuck behind.
    TimedOut { holder: Option<String> },
}

/// Poll `state.try_lock()` for up to `timeout`, then hand back the guard (or the reason it
/// couldn't be acquired). Mirrors the `rebuild_gate().try_lock()` admission pattern already used
/// in `ui.rs`, applied to the state mutex for the first time.
pub fn flush_with_deadline(state: &Mutex<CoreState>, timeout: Duration) -> Outcome<'_> {
    let deadline = Instant::now() + timeout;
    loop {
        match state.try_lock() {
            Ok(guard) => return Outcome::Flushed(guard),
            // A poisoned CoreState lock is unreachable in alcore: its panic hook exits the process
            // before unwinding (TRDD-3RVTC1HY), so this arm fails loud instead of recovering.
            Err(TryLockError::Poisoned(_)) => panic!("CoreState lock poisoned"),
            Err(TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    return Outcome::TimedOut {
                        holder: crate::current_lock_holder()
                            .map(|(site, held_ms)| format!("{site} (holding for {held_ms} ms)")),
                    };
                }
                std::thread::sleep(Duration::from_millis(20));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::LockTimed;

    fn fresh_state() -> CoreState {
        let dir = std::env::temp_dir().join(format!("agentlens-shutdown-test-{}", crate::now_ms()));
        CoreState::open(&dir)
    }

    #[test]
    fn times_out_and_names_the_holder_when_the_lock_is_held_past_the_deadline() {
        let m = std::sync::Arc::new(Mutex::new(fresh_state()));
        let holder = m.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let t = std::thread::spawn(move || {
            let _g = holder.lock_timed();
            tx.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(2000));
        });
        // The holder signals once it owns the lock, so the poll below never races the acquisition.
        rx.recv().unwrap();
        let started = Instant::now();
        match flush_with_deadline(&m, Duration::from_millis(200)) {
            Outcome::TimedOut { holder } => {
                // The holder slot (HOLDER_SITE in lib.rs) is process-wide, so in this parallel unit-test binary another test can own it; None and another site are both possible here, and the exact-site check lives in tests/lock_holder_site.rs, which runs alone in its own process (TRDD-7EZE3AIZ).
                if let Some(site) = holder {
                    assert!(site.contains(".rs:") && site.contains(" (holding for "), "holder should be a well-formed site, got {site}");
                }
            }
            _ => panic!("expected TimedOut"),
        }
        assert!(started.elapsed() <= Duration::from_millis(1000), "should return close to the deadline, not wait for the holder");
        t.join().unwrap();
    }

    #[test]
    fn flushes_once_the_holder_releases_before_the_deadline() {
        let m = std::sync::Arc::new(Mutex::new(fresh_state()));
        let holder = m.clone();
        let t = std::thread::spawn(move || {
            let _g = holder.lock_timed();
            std::thread::sleep(Duration::from_millis(100));
        });
        std::thread::sleep(Duration::from_millis(20));
        match flush_with_deadline(&m, Duration::from_millis(2000)) {
            Outcome::Flushed(_guard) => {}
            Outcome::TimedOut { holder } => panic!("expected Flushed, timed out behind {holder:?}"),
        }
        t.join().unwrap();
    }
}

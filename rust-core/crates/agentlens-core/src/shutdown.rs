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
    /// Never constructed today — a poisoned mutex is recovered via `into_inner()` (the crate's
    /// own convention; see `chores.rs`'s `unwrap_or_else(|e| e.into_inner())`) and returned as
    /// `Flushed` instead, so a prior panic elsewhere never blocks a shutdown flush that could
    /// still succeed. Kept as a distinct variant so a future caller that needs to tell "recovered
    /// from poison" apart from "never poisoned" can do so without an API break.
    Poisoned,
}

/// Poll `state.try_lock()` for up to `timeout`, then hand back the guard (or the reason it
/// couldn't be acquired). Mirrors the `rebuild_gate().try_lock()` admission pattern already used
/// in `ui.rs`, applied to the state mutex for the first time.
pub fn flush_with_deadline(state: &Mutex<CoreState>, timeout: Duration) -> Outcome<'_> {
    let deadline = Instant::now() + timeout;
    loop {
        match state.try_lock() {
            Ok(guard) => return Outcome::Flushed(guard),
            Err(TryLockError::Poisoned(poisoned)) => return Outcome::Flushed(poisoned.into_inner()),
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
        let started = Instant::now();
        let t = std::thread::spawn(move || {
            let _g = holder.lock_timed().unwrap();
            std::thread::sleep(Duration::from_millis(2000));
        });
        // Give the thread a moment to actually acquire the lock before we start polling.
        std::thread::sleep(Duration::from_millis(50));
        match flush_with_deadline(&m, Duration::from_millis(200)) {
            Outcome::TimedOut { holder } => {
                // `HOLDER_SITE`/`HOLDER_SINCE_NS` (lib.rs) are process-wide statics shared by
                // EVERY `Mutex<CoreState>` in the binary, not scoped per-mutex — a pre-existing
                // property of `lock_timed`, unrelated to this change. Under the default parallel
                // `cargo test` run another test's unrelated mutex can clear the slot between our
                // failed `try_lock` and the read, so `None` is a real (if rare) outcome here, not
                // a bug in `flush_with_deadline`. Assert the shape when a holder IS named, run
                // single-threaded (`cargo test -- --test-threads=1`) for a deterministic check of
                // the name itself.
                if let Some(site) = holder {
                    assert!(site.contains("shutdown.rs"), "holder site should point at this file's lock_timed call, got {site}");
                }
            }
            _ => panic!("expected TimedOut"),
        }
        assert!(started.elapsed() <= Duration::from_millis(300), "should return close to the deadline, not wait for the holder");
        t.join().unwrap();
    }

    #[test]
    fn flushes_once_the_holder_releases_before_the_deadline() {
        let m = std::sync::Arc::new(Mutex::new(fresh_state()));
        let holder = m.clone();
        let t = std::thread::spawn(move || {
            let _g = holder.lock_timed().unwrap();
            std::thread::sleep(Duration::from_millis(100));
        });
        std::thread::sleep(Duration::from_millis(20));
        match flush_with_deadline(&m, Duration::from_millis(2000)) {
            Outcome::Flushed(_guard) => {}
            Outcome::TimedOut { holder } => panic!("expected Flushed, timed out behind {holder:?}"),
            Outcome::Poisoned => panic!("expected Flushed, got Poisoned"),
        }
        t.join().unwrap();
    }
}

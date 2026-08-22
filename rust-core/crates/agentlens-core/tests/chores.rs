//! The chore scheduler's two pieces of real logic (TRDD-DMWOBWFH tier A). `spawn_all` itself is
//! not tested — it is interval arithmetic over functions that ARE tested (`chores_purge.rs`,
//! agentlens-spanstore `writer.rs`), and a test that only proves `tokio::time::interval` works
//! would be documentation. These two are not: one ports JS truthiness, the other is the guard
//! standing between two engines and the same store.

use std::collections::HashMap;

use agentlens_core::chores::{hook_events_retention_days, with_chores_lock};

fn vars(v: Option<&str>) -> HashMap<String, String> {
    let mut m = HashMap::new();
    if let Some(v) = v {
        m.insert("AGENTLENS_HOOK_EVENTS_RETENTION_DAYS".to_owned(), v.to_owned());
    }
    m
}

/// `Math.max(1, Number(env) || 31)` — ported through JS TRUTHINESS, which is not the same as
/// "parse, else default", and the difference is observable at exactly the values an operator is
/// most likely to type.
#[test]
fn hook_events_retention_ports_js_truthiness_not_parse_or_default() {
    // Unset ⇒ the default. `Number(undefined)` is NaN, which is falsy.
    assert_eq!(hook_events_retention_days(&vars(None)), 31.0);

    // THE ONE THAT SURPRISES: an explicit 0 does NOT mean "keep nothing". `Number("0")` is 0,
    // which is FALSY, so the `||` takes the default. A naive parse-or-default would return 0 here
    // and the floor would raise it to 1 — a store purged to a single day instead of 31.
    assert_eq!(hook_events_retention_days(&vars(Some("0"))), 31.0);
    assert_eq!(hook_events_retention_days(&vars(Some("-0"))), 31.0);

    // Junk is NaN ⇒ falsy ⇒ default. "NaN" is the trap: `"NaN".parse::<f64>()` SUCCEEDS in Rust
    // and yields NaN, so without an explicit NaN filter this would return NaN and every
    // comparison against the cutoff would silently be false.
    assert_eq!(hook_events_retention_days(&vars(Some("abc"))), 31.0);
    assert_eq!(hook_events_retention_days(&vars(Some("NaN"))), 31.0);
    assert_eq!(hook_events_retention_days(&vars(Some(""))), 31.0);

    // A real value passes through, and whitespace is trimmed as `Number(" 5 ")` does.
    assert_eq!(hook_events_retention_days(&vars(Some("5"))), 5.0);
    assert_eq!(hook_events_retention_days(&vars(Some(" 7 "))), 7.0);

    // NEGATIVE is TRUTHY, so it survives the `||` and is caught by the floor instead — the two
    // guards do different jobs and both are needed.
    assert_eq!(hook_events_retention_days(&vars(Some("-3"))), 1.0);
    // Below the floor but positive: same floor, different path.
    assert_eq!(hook_events_retention_days(&vars(Some("0.5"))), 1.0);
}

/// The cross-engine guard. If the TS server and alcore share a data dir, their retention passes
/// race — both enumerate the same segments and both decide the same file is expired. Busy must
/// SKIP the tick, never block and never run anyway.
#[test]
fn chores_lock_is_exclusive_and_a_busy_tick_skips_rather_than_blocks() {
    let dir = std::env::temp_dir().join(format!("al-chores-lock-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    // Uncontended: the body runs and its value comes back.
    assert_eq!(with_chores_lock(&dir, || 7), Some(7));

    // Contended: hold the flock the way another PROCESS would, then prove the tick declines.
    // `ran` is the load-bearing assertion — a guard that returns None but ran the body anyway
    // would be worse than no guard, because it would look correct in the manifest.
    {
        use fs2::FileExt;
        let held = std::fs::OpenOptions::new()
            .create(true)
            .truncate(false)
            .write(true)
            .open(dir.join(".chores.lock"))
            .unwrap();
        held.try_lock_exclusive().expect("first claimant takes the lock");

        let mut ran = false;
        let out = with_chores_lock(&dir, || {
            ran = true;
            7
        });
        assert_eq!(out, None, "busy ⇒ the tick is skipped");
        assert!(!ran, "the body must NOT run while another engine holds the lock");

        fs2::FileExt::unlock(&held).unwrap();
    }

    // Released ⇒ the next tick proceeds. A lock that never came back would stop the reaper
    // forever, which is the silent-growth failure this whole tier exists to prevent.
    assert_eq!(with_chores_lock(&dir, || 9), Some(9));

    let _ = std::fs::remove_dir_all(&dir);
}

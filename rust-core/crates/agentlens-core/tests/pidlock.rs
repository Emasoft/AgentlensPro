//! Native tests for the single-owner data-dir lock (TRDD-DMWOBWFH D1 prerequisite,
//! docs_dev/d1-alcore-pidlock-brief.md). Each case is falsified by mutation, not just asserted
//! green — a lock test that cannot fail is worse than none.

use agentlens_core::pid_lock::{claim, format_pid_lock, parse_pid_lock, pidfile_path, release, ClaimOutcome};

fn tmp(tag: &str) -> std::path::PathBuf {
    // PID *and* tag: cargo runs the tests in this file as parallel THREADS of one process, so a
    // PID-only path lets siblings delete each other's fixtures mid-run.
    let d = std::env::temp_dir().join(format!("al-pidlock-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[test]
fn claim_on_empty_dir_succeeds_and_the_file_parses() {
    let dir = tmp("empty");
    assert!(matches!(claim(&dir), ClaimOutcome::Claimed));
    let content = std::fs::read_to_string(pidfile_path(&dir)).unwrap();
    let lock = parse_pid_lock(&content).expect("must parse");
    assert_eq!(lock.pid, std::process::id());

    // Falsify: mutating the file to garbage must NOT parse.
    std::fs::write(pidfile_path(&dir), "not a lock").unwrap();
    assert!(parse_pid_lock(&std::fs::read_to_string(pidfile_path(&dir)).unwrap()).is_none());
}

#[test]
fn second_claim_while_first_is_held_fails() {
    let dir = tmp("held");
    assert!(matches!(claim(&dir), ClaimOutcome::Claimed));
    // We ARE the pid in the lock (own process), so a second claim reclaims it as "our own stale
    // lock" rather than refusing — exercise the foreign-live-holder path with a fabricated lock
    // naming a pid we know is alive but isn't us: pid 1 (init/launchd) is always alive and never us.
    std::fs::write(pidfile_path(&dir), format_pid_lock(1, None)).unwrap();
    match claim(&dir) {
        ClaimOutcome::Refused { holder } => assert_eq!(holder, 1),
        ClaimOutcome::Claimed => panic!("expected Refused{{holder:1}}, got Claimed"),
        ClaimOutcome::VerifyFailed => panic!("expected Refused{{holder:1}}, got VerifyFailed"),
    }

    // Falsify: an unheld/missing lock must NOT refuse.
    let dir2 = tmp("held-negative");
    assert!(matches!(claim(&dir2), ClaimOutcome::Claimed));
}

#[test]
fn lock_naming_a_dead_pid_is_taken_over() {
    let dir = tmp("dead");
    // A pid essentially guaranteed dead on any dev/CI box.
    std::fs::write(pidfile_path(&dir), format_pid_lock(999_999, Some("Mon Jan  1 00:00:00 1990"))).unwrap();
    assert!(matches!(claim(&dir), ClaimOutcome::Claimed));
    let lock = parse_pid_lock(&std::fs::read_to_string(pidfile_path(&dir)).unwrap()).unwrap();
    assert_eq!(lock.pid, std::process::id(), "takeover must publish OUR pid, not leave the dead one");
}

#[test]
fn legacy_bare_numeric_shape_is_still_parsed() {
    let lock = parse_pid_lock("4242").expect("legacy bare-numeric must parse");
    assert_eq!(lock.pid, 4242);
    assert!(lock.start.is_none());

    // Falsify: a non-numeric, non-JSON string must not parse as a legacy lock.
    assert!(parse_pid_lock("42abc").is_none());
    // Falsify: pid 0 is never valid in either shape.
    assert!(parse_pid_lock("0").is_none());
}

#[test]
fn release_with_a_foreign_pid_in_the_file_does_not_unlink() {
    let dir = tmp("foreign-release");
    let path = pidfile_path(&dir);
    std::fs::write(&path, format_pid_lock(1, None)).unwrap();
    release(&dir);
    assert!(path.exists(), "release must not touch a lock naming another pid");

    // Falsify: releasing OUR OWN lock must unlink it.
    std::fs::write(&path, format_pid_lock(std::process::id(), None)).unwrap();
    release(&dir);
    assert!(!path.exists(), "release must unlink a lock naming our own pid");
}

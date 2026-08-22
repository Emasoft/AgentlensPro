//! Native tests for `AccountStateTimeline` (TRDD-DMWOBWFH C3,
//! tests/fixtures/c3-account-state-timeline-case-matrix.md part 3, cases 15-22). No TS oracle here — the writer has no clock/fs seam worth
//! oracling — so these drive the buffered/change-detected/fsync-on-flush contract directly.

use agentlens_core::account_state_timeline::AccountStateTimeline;
use serde_json::{json, Map, Value};

fn tmp(tag: &str) -> std::path::PathBuf {
    // PID *and* tag: cargo runs the tests in this file as parallel THREADS of one process, so a
    // PID-only path lets siblings delete each other's fixtures mid-run.
    let d = std::env::temp_dir().join(format!("al-acctstate-writer-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn state(account_id: &str, mode: &str, ttl_minutes: f64, email: &str) -> Map<String, Value> {
    json!({
        "ts": 1700000000000i64,
        "accountId": account_id,
        "email": email,
        "mode": mode,
        "plan": "Max 5x",
        "authRegime": "subscription",
        "ttlMinutes": ttl_minutes,
        "ttlSource": "doc-matrix",
    })
    .as_object()
    .unwrap()
    .clone()
}

/// Case 15 `writer-first-record-enqueues`: one record onto an empty timeline.
#[test]
fn first_record_enqueues_but_does_not_touch_disk_until_flush() {
    let path = tmp("first").join("account-state.ndjson");
    let mut t = AccountStateTimeline::open(path.clone());
    assert!(t.record(state("acct-1", "subscription (within plan)", 60.0, "a@example.com")));
    assert_eq!(t.buffered(), 1);
    assert!(!path.exists(), "not flushed yet — the file must not appear until flush()");
}

/// Case 16 `writer-same-key-is-noop`: the same discrete state recorded twice.
#[test]
fn recording_the_same_discrete_state_twice_is_a_noop() {
    let path = tmp("samekey").join("account-state.ndjson");
    let mut t = AccountStateTimeline::open(path);
    assert!(t.record(state("acct-1", "subscription (within plan)", 60.0, "a@example.com")));
    assert!(!t.record(state("acct-1", "subscription (within plan)", 60.0, "a@example.com")));
    assert_eq!(t.buffered(), 1);
}

/// Case 17 `writer-email-change-is-noop`: same discrete key, different email — email is excluded
/// from the discrete key on purpose (part 2 of the matrix), so this must NOT enqueue.
#[test]
fn an_email_only_change_does_not_enqueue() {
    let path = tmp("email-change").join("account-state.ndjson");
    let mut t = AccountStateTimeline::open(path);
    assert!(t.record(state("acct-1", "subscription (within plan)", 60.0, "a@example.com")));
    assert!(!t.record(state("acct-1", "subscription (within plan)", 60.0, "b@example.com")));
    assert_eq!(t.buffered(), 1);
}

/// Case 18 `writer-mode-change-enqueues`: same account, different mode — a real discrete change.
#[test]
fn a_mode_change_enqueues() {
    let path = tmp("mode-change").join("account-state.ndjson");
    let mut t = AccountStateTimeline::open(path);
    assert!(t.record(state("acct-1", "subscription (within plan)", 60.0, "a@example.com")));
    assert!(t.record(state("acct-1", "usage-credits", 5.0, "a@example.com")));
    assert_eq!(t.buffered(), 2);
}

/// Case 19 `writer-flush-writes-ndjson`: 2 records then flush() — the file has 2 lines, each the
/// record verbatim, trailing newline.
#[test]
fn flush_writes_ndjson_verbatim_with_trailing_newline() {
    let path = tmp("flush").join("account-state.ndjson");
    let mut t = AccountStateTimeline::open(path.clone());
    let s1 = state("acct-1", "subscription (within plan)", 60.0, "a@example.com");
    let s2 = state("acct-1", "usage-credits", 5.0, "a@example.com");
    assert!(t.record(s1.clone()));
    assert!(t.record(s2.clone()));
    t.flush();
    assert_eq!(t.buffered(), 0);

    let text = std::fs::read_to_string(&path).unwrap();
    assert!(text.ends_with('\n'), "trailing newline");
    let lines: Vec<&str> = text.trim_end_matches('\n').split('\n').collect();
    assert_eq!(lines.len(), 2);
    assert_eq!(lines[0], serde_json::to_string(&s1).unwrap());
    assert_eq!(lines[1], serde_json::to_string(&s2).unwrap());
}

/// Case 20 `writer-reopen-seeds-last-key`: flush, drop, reopen the same path, record the SAME
/// state — a restart into an unchanged state must not re-log it.
#[test]
fn reopening_the_same_file_seeds_the_last_key_from_the_tail() {
    let path = tmp("reopen").join("account-state.ndjson");
    let s = state("acct-1", "subscription (within plan)", 60.0, "a@example.com");
    {
        let mut t = AccountStateTimeline::open(path.clone());
        assert!(t.record(s.clone()));
        t.flush();
    }
    let mut t2 = AccountStateTimeline::open(path);
    assert!(!t2.record(s), "reopening into the same state must not re-log it");
    assert_eq!(t2.buffered(), 0);
}

/// Case 21 `writer-torn-tail-seeds-none`: a file whose last line is truncated JSON — open()
/// succeeds, last_key seeds to None, and the next record enqueues (nothing to compare against).
#[test]
fn a_torn_tail_seeds_no_last_key() {
    let path = tmp("torn").join("account-state.ndjson");
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    // A valid line followed by a truncated one — the LAST line is what open() reads.
    let good = serde_json::to_string(&state("acct-1", "subscription (within plan)", 60.0, "a@example.com")).unwrap();
    std::fs::write(&path, format!("{good}\n{{\"ts\":1700000000000,\"accountId\":\"acct-1\"")).unwrap();

    let mut t = AccountStateTimeline::open(path);
    assert!(t.record(state("acct-1", "subscription (within plan)", 60.0, "a@example.com")), "torn tail => no last_key => the next record must enqueue");
    assert_eq!(t.buffered(), 1);
}

/// Case 22 `writer-32-records-autoflushes`: 32 records with 32 DIFFERENT discrete keys — the file
/// must exist before any explicit flush() call, and the buffer must be empty afterward.
#[test]
fn thirty_two_distinct_records_autoflush_on_the_record_count_bound() {
    let path = tmp("autoflush").join("account-state.ndjson");
    let mut t = AccountStateTimeline::open(path.clone());
    for i in 0..32 {
        assert!(t.record(state("acct-1", &format!("mode-{i}"), 60.0, "a@example.com")));
    }
    assert!(path.exists(), "FLUSH_MAX_RECORDS=32 must have auto-flushed already");
    assert_eq!(t.buffered(), 0);
    let text = std::fs::read_to_string(&path).unwrap();
    assert_eq!(text.trim_end_matches('\n').split('\n').count(), 32);
}

/// The failure path, which every case above leaves untested and which is the one with real
/// consequences: a flush that CANNOT write must put the batch back rather than drop it. A writer
/// that swallowed the error and cleared the buffer would pass all eight cases above and lose every
/// state change during a disk problem, silently — the buffer count is the only observable that
/// tells the two apart.
#[test]
fn a_failed_flush_rebuffers_the_batch_instead_of_losing_it() {
    let dir = tmp("failed-flush");
    // A regular FILE where the timeline's parent directory must be ⇒ create_dir_all fails.
    std::fs::write(dir.join("blocked"), b"not a directory").unwrap();
    let path = dir.join("blocked").join("account-state.ndjson");

    let mut t = AccountStateTimeline::open(path.clone());
    assert!(t.record(state("acct-1", "subscription (within plan)", 60.0, "a@example.com")));
    assert!(t.record(state("acct-1", "usage-credits", 5.0, "a@example.com")));
    t.flush();
    assert_eq!(t.buffered(), 2, "the unwritable batch is back in the buffer, not dropped");
    assert!(!path.exists());

    // And a LATER record still enqueues behind the restored batch, in order.
    assert!(t.record(state("acct-2", "subscription (within plan)", 60.0, "a@example.com")));
    assert_eq!(t.buffered(), 3);
}

//! Hook-spool verify-before-delete (TRDD-K3WDPR7M, 202607-15 USER directive) — the Rust port of
//! `src/test/hookSpoolVerify.test.ts`.
//!
//! The contract under test: a spool file may be deleted ONLY after the durable day-bucket copy
//! is PROVEN byte-identical. Any failure of the verification MUST keep the spool file. A mocked
//! filesystem would test nothing: the whole contract is that the bytes really landed on disk.
//!
//! The verification is an OFFSET SEEK, not a whole-bucket scan: `verify_appended_line` reads
//! EXACTLY `pos.length` bytes at `pos.offset`. The scan it replaced read the whole day bucket
//! (69 MB) once per spooled event.

use std::path::{Path, PathBuf};

use agentlens_core::hook_events::{append_hook_event, drain_hook_spool, verify_appended_line, AppendPosition};
use agentlens_core::{now_ms, CoreState};
use serde_json::{json, Map, Value};

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("al-hookspool-verify-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn payload(ev: &str, sid: &str) -> Map<String, Value> {
    let mut p = Map::new();
    p.insert("hook_event_name".into(), json!(ev));
    p.insert("session_id".into(), json!(sid));
    p
}

/// Append one hook event and return (position, line). The line INCLUDES its trailing newline, so
/// its byte length is exactly `pos.length` — the same invariant the TS `appendBucketLine` has.
fn append(dir: &Path, ev: &str, sid: &str, ts_ms: i64) -> (AppendPosition, String) {
    let (_rec, _bytes, pos, line) = append_hook_event(dir, &payload(ev, sid), ts_ms).expect("append hook event");
    (pos, line)
}

/// The first appended line verifies byte-for-byte.
#[test]
fn the_first_appended_line_verifies() {
    let dir = tmp("first");
    let (pos, line) = append(&dir, "SessionStart", "s1", 1_787_000_000_000);
    assert_eq!(pos.offset, 0, "the first line in a fresh bucket starts at offset 0");
    assert!(verify_appended_line(&pos, &line), "the first line is durable");
}

/// A LATER appended line (non-zero offset) verifies byte-for-byte — the case the whole-bucket
/// scan was supposed to serve, now served by a seek.
#[test]
fn a_later_appended_line_at_a_non_zero_offset_verifies() {
    let dir = tmp("later");
    let ts = 1_787_000_000_000;
    let (first_pos, first_line) = append(&dir, "SessionStart", "s1", ts);
    let (second_pos, second_line) = append(&dir, "Stop", "s1", ts);
    assert_eq!(first_pos.bucket_path, second_pos.bucket_path, "both land in the same daily bucket");
    assert!(verify_appended_line(&first_pos, &first_line), "the first line is durable");
    assert!(verify_appended_line(&second_pos, &second_line), "the non-zero-offset line is durable");
}

/// The reported offset/length are the truth: the second line starts exactly where the first ends,
/// and the length is the byte length of the line INCLUDING its newline.
#[test]
fn the_reported_offset_and_length_are_the_bucket_size_before_the_append() {
    let dir = tmp("offsets");
    let ts = 1_787_000_000_000;
    let (first, first_line) = append(&dir, "SessionStart", "s1", ts);
    assert_eq!(first.offset, 0, "the first append starts at 0");
    assert_eq!(first.length, first_line.len() as u64, "the length is the byte length INCLUDING the newline");
    assert!(first_line.ends_with("\n"), "the appended line carries its trailing newline");

    let (second, second_line) = append(&dir, "Stop", "s1", ts);
    assert_eq!(second.offset, first.length, "the second line starts exactly where the first ends");
    assert_eq!(second.offset, first.offset + first.length, "the second offset is the first offset + the first length");
    assert_eq!(second.length, second_line.len() as u64, "the length is the byte length INCLUDING the newline");
    assert_eq!(
        std::fs::metadata(&second.bucket_path).unwrap().len(),
        second.offset + second.length,
        "the bucket is exactly the two appended lines"
    );
}

/// A line truncated away (the bucket truncated at the line offset) does NOT verify — the
/// durable copy is not proven.
#[test]
fn a_truncated_line_does_not_verify() {
    let dir = tmp("truncated");
    let ts = 1_787_000_000_000;
    let (a, a_line) = append(&dir, "SessionStart", "s1", ts);
    let (b, b_line) = append(&dir, "Stop", "s1", ts);
    // Truncate the bucket right at b offset — a crash / short write that ate the second line.
    let f = std::fs::OpenOptions::new().write(true).open(&b.bucket_path).unwrap();
    f.set_len(b.offset).unwrap();
    drop(f);
    assert!(!verify_appended_line(&b, &b_line), "a truncated-away line is NOT durable");
    assert!(verify_appended_line(&a, &a_line), "the surviving earlier line still verifies");
}

/// Bytes at the offset replaced with DIFFERENT but SAME-LENGTH bytes do NOT verify (silent
/// corruption at the same offset).
#[test]
fn same_length_but_different_bytes_do_not_verify() {
    let dir = tmp("corrupt");
    let ts = 1_787_000_000_000;
    let (a, a_line) = append(&dir, "SessionStart", "s1", ts);
    let (c, c_line) = append(&dir, "PreCompact", "s1", ts);
    // Overwrite c bytes with "X" — same length, different content.
    {
        use std::io::{Seek, SeekFrom, Write};
        let mut f = std::fs::OpenOptions::new().write(true).open(&c.bucket_path).unwrap();
        f.seek(SeekFrom::Start(c.offset)).unwrap();
        f.write_all(&vec![b'X'; c.length as usize]).unwrap();
    }
    assert!(!verify_appended_line(&c, &c_line), "same-length but different bytes are NOT durable");
    assert!(verify_appended_line(&a, &a_line), "the untouched earlier line still verifies");
}

/// A recorded length that disagrees with the expected line is rejected BEFORE any read.
#[test]
fn a_length_mismatch_fails_fast() {
    let dir = tmp("lenmismatch");
    let (a, a_line) = append(&dir, "SessionStart", "s1", 1_787_000_000_000);
    let longer = AppendPosition { bucket_path: a.bucket_path.clone(), offset: a.offset, length: a.length + 1 };
    assert!(!verify_appended_line(&longer, &a_line), "a length mismatch fails fast");
    let shorter = AppendPosition { bucket_path: a.bucket_path.clone(), offset: a.offset, length: a.length - 1 };
    assert!(!verify_appended_line(&shorter, &a_line), "a shorter recorded length fails fast");
    // The expected line itself disagreeing with the recorded length is also a mismatch.
    assert!(!verify_appended_line(&a, &format!("{a_line} ")), "an expected line of the wrong length fails fast");
}

/// A bucket that has VANISHED cannot prove durability — the verifier returns false, never panics.
#[test]
fn a_missing_bucket_does_not_verify() {
    let dir = tmp("missing");
    let (a, a_line) = append(&dir, "SessionStart", "s1", 1_787_000_000_000);
    std::fs::remove_file(&a.bucket_path).unwrap();
    assert!(!verify_appended_line(&a, &a_line), "a vanished bucket cannot prove durability");
}

/// The drain KEEPS the spool file when the durable copy cannot be proven.
///
/// The day bucket is made a symlink to /dev/null: the append SUCCEEDS (a 200, so the ingest path
/// claims it wrote the line) but the bytes are discarded, so the read-back finds nothing and the
/// durable copy is unproven. That is exactly the "inconclusive" case the directive names, and the
/// spool file MUST survive the drain.
#[test]
fn the_drain_keeps_the_spool_file_when_the_durable_copy_cannot_be_proven() {
    let data = tmp("kept");
    let spool = data.join("hook-spool");
    std::fs::create_dir_all(&spool).unwrap();
    std::fs::write(
        spool.join("0000-a.json"),
        json!({ "hook_event_name": "PreToolUse", "session_id": "s0" }).to_string(),
    )
    .unwrap();

    // One drain creates the day bucket (and removes the first spool file — the happy path).
    let mut st = CoreState::open(&data);
    let d = drain_hook_spool(&mut st, now_ms(), usize::MAX);
    assert_eq!(d.drained, 1, "the first spool file drains normally: {d:?}");

    // Swap the day bucket for a symlink to /dev/null: writes are accepted and discarded.
    let bucket = std::fs::read_dir(data.join("hook-events"))
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().map(|e| e == "ndjsonl").unwrap_or(false))
        .expect("the day bucket exists");
    std::fs::remove_file(&bucket).unwrap();
    std::os::unix::fs::symlink("/dev/null", &bucket).unwrap();

    let second = spool.join("0001-b.json");
    std::fs::write(
        &second,
        json!({ "hook_event_name": "PreToolUse", "session_id": "s1" }).to_string(),
    )
    .unwrap();
    let mut st = CoreState::open(&data);
    let d = drain_hook_spool(&mut st, now_ms(), usize::MAX);

    assert_eq!(d.drained, 0, "nothing may be drained when the durable copy is unproven: {d:?}");
    assert_eq!(d.unverified, 1, "the unverifiable append is counted as unverified: {d:?}");
    assert!(second.exists(), "the spool file MUST be kept when the durable copy is unproven");
}

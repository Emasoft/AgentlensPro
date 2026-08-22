//! ndjsonBuckets.purgeBuckets round-trip (TRDD-DMWOBWFH) — modeled on the purge half of
//! tests/statusline_parity.rs::rust_write_path_round_trips_and_the_seal_refuses_collapsed_inference.

use agentlens_core::hook_events::purge_buckets;

const NOW_MS: f64 = 1_760_000_000_000.0; // 2025-10-09T09:46:40Z — pinned so the test can't rot
const DAY_MS: f64 = 86_400_000.0;

/// PID **and tag** scoped. The tag is not decoration: cargo runs these tests in parallel threads
/// inside ONE process, so a PID-only path is the SAME path for all three, and the `remove_dir_all`
/// below would delete a sibling test's fixtures mid-run. Same convention as
/// tests/forensicsindexer_parity.rs:36.
fn tmp(tag: &str) -> std::path::PathBuf {
    let d = std::env::temp_dir().join(format!("al-purge-buckets-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn day_name(offset_days: f64) -> String {
    agentlens_core::summarize::helpers::iso_from_ms(NOW_MS - offset_days * DAY_MS)[..10].to_owned()
}

#[test]
fn old_bucket_is_removed_recent_bucket_and_foreign_files_are_kept() {
    let dir = tmp("keeps-foreign");
    let old = format!("{}.ndjsonl", day_name(120.0)); // well past a 90-day retention
    let recent = format!("{}.ndjsonl", day_name(1.0));
    std::fs::write(dir.join(&old), "line one\n").unwrap();
    std::fs::write(dir.join(&recent), "line two\n").unwrap();
    // A foreign file: right shape but calendar-invalid (2026-13-99 is not a real date) — the
    // exact trap bucket_day_ms.rs documents. Deleting an unrecognised file is how a store eats
    // something that is not its own.
    std::fs::write(dir.join("2026-13-99.ndjsonl"), "not ours\n").unwrap();
    std::fs::write(dir.join("notes.txt"), "definitely not ours\n").unwrap();

    let (removed, freed) = purge_buckets(&dir, 90.0, NOW_MS);

    assert_eq!(removed, vec![old.clone()]);
    assert!(freed > 0);
    assert!(!dir.join(&old).exists(), "old bucket removed from disk");
    assert!(dir.join(&recent).exists(), "recent bucket kept");
    assert!(dir.join("2026-13-99.ndjsonl").exists(), "calendar-invalid name kept — not one of our buckets");
    assert!(dir.join("notes.txt").exists(), "foreign file kept");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_missing_directory_returns_an_empty_manifest_not_an_error() {
    let dir = tmp("missing").join("does-not-exist");
    let (removed, freed) = purge_buckets(&dir, 30.0, NOW_MS);
    assert!(removed.is_empty());
    assert_eq!(freed, 0);
}

#[test]
fn an_uncomputable_cutoff_deletes_nothing_rather_than_everything() {
    // The refusal path. A non-finite retention_days saturates through `iso_from_ms`'s `as i64`
    // into a nonsense day string that `segment_day_ms` rejects, so there is no cutoff to compare
    // against. The only safe answer is to delete NOTHING and say so on stderr — note the TS
    // answers this case by deleting EVERY bucket (`dayMs >= NaN` is false), which is why this is
    // pinned rather than left to whatever the arithmetic happens to do.
    let dir = tmp("bad-cutoff");
    let old = format!("{}.ndjsonl", day_name(400.0));
    std::fs::write(dir.join(&old), "line\n").unwrap();

    let (removed, freed) = purge_buckets(&dir, f64::INFINITY, NOW_MS);

    assert!(removed.is_empty(), "no cutoff means no verdict — nothing may be deleted");
    assert_eq!(freed, 0);
    assert!(dir.join(&old).exists(), "the bucket is still on disk");

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn retention_zero_is_not_floored_here_and_the_day_cutoff_is_inclusive() {
    // TWO facts, both verified against the TS (src/ndjsonBuckets.ts:67-86) rather than assumed.
    //
    // 1. purge_buckets applies NO floor on retention_days — the floor is retention_config's
    //    Knob.min, applied by the CALLER. Passing 0 here really does purge.
    // 2. But 0 does NOT wipe today, because the cutoff is computed at DAY granularity and the
    //    comparison is `day_ms >= cutoff_ms` — INCLUSIVE. At retention 0 the cutoff IS today's
    //    midnight, so today's bucket compares equal and survives; yesterday's does not.
    //
    // Fact 2 is the one worth a test: it is the boundary an off-by-one would move, and getting
    // it wrong in the "helpful" direction means a purge deletes the bucket being actively
    // appended to. The TS behaves identically — same `>=`, same day-truncated cutoff.
    let dir = tmp("zero-retention");
    let today = format!("{}.ndjsonl", day_name(0.0));
    let yesterday = format!("{}.ndjsonl", day_name(1.0));
    std::fs::write(dir.join(&today), "line\n").unwrap();
    std::fs::write(dir.join(&yesterday), "line\n").unwrap();

    let (removed, _freed) = purge_buckets(&dir, 0.0, NOW_MS);

    assert_eq!(removed, vec![yesterday], "retention 0 has no floor of its own — yesterday goes");
    assert!(
        dir.join(&today).exists(),
        "today's bucket survives retention 0: the day cutoff is inclusive, and it is the file \
         being appended to right now"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

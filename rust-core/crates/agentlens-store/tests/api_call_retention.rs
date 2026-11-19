//! TRDD-OBJ4FK2T: api_calls parts are removed by the epoch in their NAME once older than the retention.
//! The writer's name format and the parser live side by side in agentlens-store, so the round trip below
//! is what keeps the purge and the writer from drifting apart.

use std::path::PathBuf;

use agentlens_store::{api_call_part_epoch_ms, part_file_name, purge_api_call_parts, API_CALLS_DIR};

const NOW_MS: u64 = 1_760_000_000_000;
const DAY_MS: u64 = 86_400_000;

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("al-api-call-retention-{tag}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn touch(dir: &std::path::Path, name: &str) {
    std::fs::write(dir.join(name), b"x").unwrap();
}

fn names(dir: &std::path::Path) -> Vec<String> {
    let mut v: Vec<String> = std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    v.sort();
    v
}

#[test]
fn the_writer_name_round_trips_and_foreign_names_do_not_parse() {
    let name = part_file_name(1_760_000_000_123u128, 4242, 7);
    assert_eq!(api_call_part_epoch_ms(&name), Some(1_760_000_000_123));
    for foreign in ["zz-null-ts.parquet", "part-x-1-2.parquet", "part-1-2-3.parquet.tmp", "part-1-2.parquet", "part-1-2-3-4.parquet", "part--1-2.parquet"] {
        assert_eq!(api_call_part_epoch_ms(foreign), None, "{foreign}");
    }
}

#[test]
fn only_parts_older_than_the_retention_are_removed_and_foreign_names_stay() {
    let store = tmp("age");
    let dir = store.join(API_CALLS_DIR);
    std::fs::create_dir_all(&dir).unwrap();
    let old40 = part_file_name((NOW_MS - 40 * DAY_MS) as u128, 1, 0);
    let old31_plus = part_file_name((NOW_MS - 31 * DAY_MS - 1) as u128, 1, 1);
    let exactly31 = part_file_name((NOW_MS - 31 * DAY_MS) as u128, 1, 2);
    let new1 = part_file_name((NOW_MS - DAY_MS) as u128, 1, 3);
    for n in [&old40, &old31_plus, &exactly31, &new1] {
        touch(&dir, n);
    }
    touch(&dir, "zz-null-ts.parquet");
    let mut removed = purge_api_call_parts(&store, 31.0, NOW_MS).unwrap().removed;
    removed.sort();
    let mut want = vec![old40.clone(), old31_plus.clone()];
    want.sort();
    assert_eq!(removed, want);
    let mut left = vec![exactly31, new1, "zz-null-ts.parquet".to_owned()];
    left.sort();
    assert_eq!(names(&dir), left);
}

#[test]
fn zero_nan_negative_retention_and_a_missing_directory_remove_nothing() {
    let store = tmp("guards");
    assert_eq!(purge_api_call_parts(&store, 31.0, NOW_MS).unwrap().removed, Vec::<String>::new(), "missing dir");
    let dir = store.join(API_CALLS_DIR);
    std::fs::create_dir_all(&dir).unwrap();
    let ancient = part_file_name(1_000, 1, 0);
    touch(&dir, &ancient);
    for days in [0.0, f64::NAN, -5.0, f64::INFINITY] {
        assert_eq!(purge_api_call_parts(&store, days, NOW_MS).unwrap().removed, Vec::<String>::new(), "retention {days}");
    }
    // A cutoff that underflows (retention longer than the clock has run) removes nothing either.
    assert_eq!(purge_api_call_parts(&store, 1.0e12, NOW_MS).unwrap().removed, Vec::<String>::new(), "underflow");
    assert_eq!(names(&dir), vec![ancient]);
}

#[test]
fn a_part_that_cannot_be_removed_is_reported_and_the_rest_are_still_removed() {
    let store = tmp("partial-failure");
    let dir = store.join(API_CALLS_DIR);
    std::fs::create_dir_all(&dir).unwrap();
    // A directory named like an old part: remove_file fails on it every time.
    let mut old_dirs: Vec<String> = (0..3).map(|k| part_file_name((NOW_MS - 40 * DAY_MS) as u128, 2, k)).collect();
    for name in &old_dirs {
        std::fs::create_dir(dir.join(name)).unwrap();
    }
    let mut old_files: Vec<String> = (0..3).map(|k| part_file_name((NOW_MS - 40 * DAY_MS) as u128, 3, k)).collect();
    for name in &old_files {
        touch(&dir, name);
    }
    let new1 = part_file_name((NOW_MS - DAY_MS) as u128, 3, 9);
    touch(&dir, &new1);
    let outcome = purge_api_call_parts(&store, 31.0, NOW_MS).unwrap();
    let mut removed = outcome.removed;
    removed.sort();
    old_files.sort();
    assert_eq!(removed, old_files);
    let mut failed: Vec<String> = outcome.failed.into_iter().map(|(name, _)| name).collect();
    failed.sort();
    old_dirs.sort();
    assert_eq!(failed, old_dirs);
    let mut left = old_dirs;
    left.push(new1);
    left.sort();
    assert_eq!(names(&dir), left);
}

//! TRDD-2HRA270Y step 3: the server keeps ONE store open per process and refreshes its dedup
//! tables each tick with `sync_new_parts`. These tests pin the contracts that make that safe:
//! flush registers its own files (so a sync after a flush imports nothing), a part another writer
//! adds becomes visible to dedup and verify, an unreadable part is never registered, and staging
//! left by a failed flush is flushed or cleared, never carried.

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

use agentlens_store::{
    flush_detailed, flush_or_clear_leftovers, ingest_body, open_store, staged_rows, sync_new_parts, verify_bodies_in_store, Leftovers, Store,
    VerifyItem, PART_DIRS,
};

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("al-sync-parts-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn open(dir: &Path) -> Store {
    open_store(dir, "512MB", 1).expect("open")
}

/// A JSON request body long enough to produce blob spans (and so a blob part on flush).
fn body(tag: &str) -> String {
    format!("{{\"model\":\"m\",\"messages\":[{{\"role\":\"user\",\"content\":\"{}-{tag}\"}}]}}", "s".repeat(600))
}

fn count(store: &Store, sql: &str) -> i64 {
    store.con.query_row(sql, [], |r| r.get(0)).expect(sql)
}

/// Every .parquet on disk across the four part dirs.
fn parquet_on_disk(dir: &Path) -> usize {
    PART_DIRS
        .iter()
        .map(|sub| {
            std::fs::read_dir(dir.join(sub))
                .map(|rd| rd.flatten().filter(|e| e.path().extension().is_some_and(|x| x == "parquet")).count())
                .unwrap_or(0)
        })
        .sum()
}

const TS: i64 = 1_787_000_000_000;

/// A tick right after a flush must import nothing: flush registered every file it wrote, in all
/// four dirs. MUTATION CHECK: register only the blob part in flush_detailed and this fails (the
/// body/part/api_call parts look foreign and are re-imported, duplicating body_durable rows).
#[test]
fn a_sync_after_a_flush_imports_nothing() {
    let dir = tmp("after-flush");
    let mut store = open(&dir);
    ingest_body(&mut store, "a.request.json", &body("a"), TS).expect("ingest");
    let flushed = flush_detailed(&mut store).expect("flush");
    assert_eq!(flushed.part_paths.len(), 4, "the fixture writes one part in each of the four dirs");
    let files_before = count(&store, "SELECT count(*) FROM part_file");
    let bodies_before = count(&store, "SELECT count(*) FROM body_durable");
    assert_eq!(files_before as usize, parquet_on_disk(&dir), "every flushed file is registered");

    let stats = sync_new_parts(&mut store).expect("sync");
    assert_eq!(stats.new_files, [0, 0, 0, 0], "no dir may report a new file after our own flush: {stats:?}");
    assert!(stats.skipped.is_empty(), "{stats:?}");
    assert_eq!(count(&store, "SELECT count(*) FROM part_file"), files_before);
    assert_eq!(count(&store, "SELECT count(*) FROM body_durable"), bodies_before);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A part written by a SECOND Store (another writer) between ticks becomes visible: sync registers
/// it, a re-ingest of that body writes neither a blob part nor a body part, and verify passes.
/// MUTATION CHECK: skip the bodies branch of sync_new_parts (register without loading rows) and
/// the re-ingest writes a body part again.
#[test]
fn a_part_from_a_second_store_becomes_visible_after_sync() {
    let dir = tmp("second-store");
    let mut ours = open(&dir);
    let raw = body("x");
    {
        let mut other = open(&dir);
        ingest_body(&mut other, "x.request.json", &raw, TS).expect("other ingest");
        flush_detailed(&mut other).expect("other flush");
    }
    let stats = sync_new_parts(&mut ours).expect("sync");
    assert_eq!(stats.new_files, [1, 1, 1, 1], "{stats:?}");
    assert!(stats.new_blob_shas > 0, "{stats:?}");
    assert_eq!(stats.new_body_rows, 1, "{stats:?}");

    let r = ingest_body(&mut ours, "x.request.json", &raw, TS).expect("re-ingest");
    assert!(r.existed, "the synced body row must make the re-ingest a dedup hit");
    assert_eq!(r.new_blobs, 0);
    let flushed = flush_detailed(&mut ours).expect("flush");
    let written: Vec<String> = flushed.part_paths.iter().map(|p| p.display().to_string()).collect();
    assert!(!written.iter().any(|p| p.contains("/blobs/") || p.contains("/bodies/")), "re-ingest wrote parts again: {written:?}");

    let v = verify_bodies_in_store(&ours, &[VerifyItem { src_name: "x.request.json".into(), raw, ts_ms: Some(TS) }]).expect("verify");
    assert!(v["x.request.json"].ok, "{:?}", v["x.request.json"].reason);
    let _ = std::fs::remove_dir_all(&dir);
}

/// Invariant only (not a test of the counter by itself): after many flushes plus a sync of a
/// second writer's parts, every part_file id is distinct and every file on disk is registered.
#[test]
fn part_file_ids_stay_unique_across_flushes_and_sync() {
    let dir = tmp("unique-ids");
    let mut store = open(&dir);
    for i in 0..5 {
        ingest_body(&mut store, &format!("n{i}.request.json"), &body(&format!("n{i}")), TS + i).expect("ingest");
        flush_detailed(&mut store).expect("flush");
    }
    {
        let mut other = open(&dir);
        ingest_body(&mut other, "o.request.json", &body("o"), TS).expect("other ingest");
        flush_detailed(&mut other).expect("other flush");
    }
    sync_new_parts(&mut store).expect("sync");
    ingest_body(&mut store, "last.request.json", &body("last"), TS).expect("ingest");
    flush_detailed(&mut store).expect("flush");
    let (n, distinct) = (count(&store, "SELECT count(*) FROM part_file"), count(&store, "SELECT count(DISTINCT id) FROM part_file"));
    assert_eq!(n, distinct, "part_file ids must be unique");
    assert_eq!(n as usize, parquet_on_disk(&dir), "every file on disk is registered once");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A flush that fails leaves staging behind; the next tick's leftover step flushes it or, when
/// that fails too, clears it. It is never carried into a second tick. MUTATION CHECK: drop the
/// clear_staging call in flush_or_clear_leftovers and staged_rows stays non-zero.
#[test]
fn leftover_staging_from_a_failed_flush_is_cleared_not_carried() {
    let dir = tmp("leftovers");
    let mut store = open(&dir);
    ingest_body(&mut store, "f.request.json", &body("f"), TS).expect("ingest");
    let blobs = dir.join("blobs");
    std::fs::set_permissions(&blobs, std::fs::Permissions::from_mode(0o555)).unwrap();
    assert!(flush_detailed(&mut store).is_err(), "a read-only blobs dir must fail the flush");
    assert!(staged_rows(&store).unwrap() > 0, "the failed flush keeps staging (the premise)");

    let out = flush_or_clear_leftovers(&mut store).expect("leftovers");
    std::fs::set_permissions(&blobs, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert!(matches!(out, Leftovers::Cleared(_)), "{out:?}");
    assert_eq!(staged_rows(&store).unwrap(), 0, "staging must be empty after the leftover step");
    assert_eq!(parquet_on_disk(&dir), 0, "a failed COPY leaves no part behind");
    assert!(matches!(flush_or_clear_leftovers(&mut store).expect("again"), Leftovers::None));

    // The source re-ingests cleanly on a later tick, and flushes.
    let r = ingest_body(&mut store, "f.request.json", &body("f"), TS).expect("re-ingest");
    assert!(!r.existed, "nothing durable was kept, so the re-ingest is a fresh ingest");
    assert!(matches!(flush_or_clear_leftovers(&mut store).expect("flush"), Leftovers::Flushed(_)));
    assert_eq!(staged_rows(&store).unwrap(), 0);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A part that cannot be read (half-written by a writer still running) is skipped and stays
/// unregistered; once it is readable the next sync registers it. MUTATION CHECK: stop reading
/// parts/ files before registering them in sync_new_parts and the garbage file gets registered.
#[test]
fn an_unreadable_part_is_skipped_until_it_becomes_readable() {
    let dir = tmp("unreadable");
    let mut store = open(&dir);
    let part = dir.join("parts").join("part-0-0-garbage.parquet");
    std::fs::write(&part, b"not a parquet file").unwrap();

    let stats = sync_new_parts(&mut store).expect("sync");
    assert_eq!(stats.new_files[1], 0, "{stats:?}");
    assert_eq!(stats.skipped.len(), 1, "{stats:?}");
    let registered = |s: &Store| count(s, &format!("SELECT count(*) FROM part_file WHERE path = '{}'", part.display()));
    assert_eq!(registered(&store), 0, "an unreadable file must never be registered");

    std::fs::remove_file(&part).unwrap();
    store.con.execute_batch(&format!("COPY (SELECT 1 AS x) TO '{}' (FORMAT PARQUET);", part.display())).unwrap();
    let stats = sync_new_parts(&mut store).expect("sync again");
    assert_eq!(stats.new_files[1], 1, "{stats:?}");
    assert!(stats.skipped.is_empty(), "{stats:?}");
    assert_eq!(registered(&store), 1);
    let _ = std::fs::remove_dir_all(&dir);
}

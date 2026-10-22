//! TRDD-2HRA270Y step 3, F4: a part file that vanishes from its dir (deleted out of band) takes its
//! dedup rows with it. The store is no longer rebuilt per tick, so without this the known_blob and
//! body_durable tables would keep reporting a blob or a body as stored after its file is gone, and
//! a body would be written with a dangling blob reference.

use std::path::{Path, PathBuf};

use agentlens_store::{all_of, body_id_of, flush_detailed, ingest_body, open_store, sync_new_parts, Store, BLOBS_DIR, BODIES_DIR};

const TS: i64 = 1_787_000_000_000;

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("al-sync-removed-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn open(dir: &Path) -> Store {
    open_store(dir, "512MB", 1).expect("open")
}

/// A JSON request body long enough to produce blob spans (the same shape sync_parts.rs uses).
fn body(tag: &str) -> String {
    format!("{{\"model\":\"m\",\"messages\":[{{\"role\":\"user\",\"content\":\"{}-{tag}\"}}]}}", "r".repeat(600))
}

fn count(store: &Store, sql: &str) -> i64 {
    store.con.query_row(sql, [], |r| r.get(0)).expect(sql)
}

fn body_rows(store: &Store, body_id: &str) -> i64 {
    store.con.query_row("SELECT count(*) FROM body_durable WHERE body_id = ?", [body_id], |r| r.get(0)).expect("body rows")
}

/// The one .parquet file in `sub`: one body flush writes exactly one file per dir.
fn only_part(dir: &Path, sub: &str) -> PathBuf {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir.join(sub))
        .expect("read dir")
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|x| x == "parquet"))
        .collect();
    assert_eq!(files.len(), 1, "premise: one part file in {sub}: {files:?}");
    files.pop().expect("one file")
}

/// A blob part and its body part deleted out of band: the next sync removes their shas from
/// known_blob and their row from body_durable, and the same body is then written again with its
/// blob (new_blobs > 0) instead of being reported as stored. The body part goes too, because a body
/// still in body_durable short-circuits ingest with new_blobs 0 and would hide the blob index. MUTATION
/// CHECK: drop the known_blob delete in remove_vanished_files and the first known_blob assertion fails.
#[test]
fn removed_blob_part_takes_its_shas_out_of_known_blob() {
    let dir = tmp("blob");
    let mut store = open(&dir);
    let raw = body("a");
    ingest_body(&mut store, "a.request.json", &raw, TS).expect("ingest");
    flush_detailed(&mut store).expect("flush");
    assert!(count(&store, "SELECT count(*) FROM known_blob") > 0, "premise: the body blob spans are indexed");

    std::fs::remove_file(only_part(&dir, BLOBS_DIR)).expect("delete blob part");
    std::fs::remove_file(only_part(&dir, BODIES_DIR)).expect("delete body part");
    let stats = sync_new_parts(&mut store).expect("sync");
    assert_eq!(stats.removed_files[0], 1, "{stats:?}");
    assert_eq!(stats.removed_files[2], 1, "{stats:?}");
    assert_eq!(count(&store, "SELECT count(*) FROM known_blob"), 0, "the vanished blob part must leave known_blob");
    assert_eq!(count(&store, "SELECT count(*) FROM body_durable"), 0, "the vanished body part must leave body_durable");

    let again = ingest_body(&mut store, "a.request.json", &raw, TS).expect("re-ingest");
    assert!(!again.existed, "the body is gone from body_durable, so it is not reported as stored");
    assert!(again.new_blobs > 0, "the blob must be written again, not probed as present: {}", again.new_blobs);
    let _ = std::fs::remove_dir_all(&dir);
}

/// After a reopen the body row takes its file id from the open-time load (the part_file join). Deleting
/// the bodies part and syncing removes the row, so the body is no longer reported as existing. MUTATION
/// CHECK: remove the body_durable delete in remove_vanished_files and the body still counts as stored.
#[test]
fn removed_bodies_part_is_no_longer_reported_as_existing() {
    let dir = tmp("bodies-reopen");
    let raw = body("b");
    let body_id = body_id_of(&raw);
    {
        let mut writer = open(&dir);
        ingest_body(&mut writer, "b.request.json", &raw, TS).expect("ingest");
        flush_detailed(&mut writer).expect("flush");
    }
    let mut store = open(&dir);
    assert_eq!(body_rows(&store, &body_id), 1, "premise: the reopened store loads the body row");

    std::fs::remove_file(only_part(&dir, BODIES_DIR)).expect("delete bodies part");
    let stats = sync_new_parts(&mut store).expect("sync");
    assert_eq!(stats.removed_files[2], 1, "{stats:?}");
    assert_eq!(body_rows(&store, &body_id), 0, "the vanished bodies part must take its row with it");
    let again = ingest_body(&mut store, "b.request.json", &raw, TS).expect("re-ingest");
    assert!(!again.existed, "a body whose part vanished is not reported as existing");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A bodies part written by ANOTHER writer and registered by sync_new_parts carries its file id too:
/// the sync-path load counts its rows, and deleting the file then removes them. MUTATION CHECK: load
/// the body rows with a NULL file id in sync_new_parts and the removal leaves the row behind.
#[test]
fn a_body_part_registered_by_sync_is_removed_with_its_file() {
    let dir = tmp("bodies-sync");
    let mut ours = open(&dir);
    let raw = body("c");
    let body_id = body_id_of(&raw);
    {
        let mut theirs = open(&dir);
        ingest_body(&mut theirs, "c.request.json", &raw, TS).expect("ingest");
        flush_detailed(&mut theirs).expect("flush");
    }
    let stats = sync_new_parts(&mut ours).expect("sync");
    assert_eq!(stats.new_files[2], 1, "{stats:?}");
    assert_eq!(stats.new_body_rows, 1, "the INSERT count is the one body row: {stats:?}");
    assert!(stats.new_blob_shas > 0, "the other writer blob part is registered too: {stats:?}");
    assert_eq!(body_rows(&ours, &body_id), 1);

    std::fs::remove_file(only_part(&dir, BODIES_DIR)).expect("delete bodies part");
    let stats = sync_new_parts(&mut ours).expect("sync again");
    assert_eq!(stats.removed_files[2], 1, "{stats:?}");
    assert_eq!(body_rows(&ours, &body_id), 0, "the removed file must take its row with it");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A blob part is flushed, then the whole blobs dir is removed (a missing dir, not a removed file). The
/// listing of a missing dir is empty, so the sync removes the vanished blob part and returns Ok: its shas
/// leave known_blob. MUTATION CHECK: make every read_dir error in load_sync_listing an error again and the
/// sync returns Err on the missing dir.
#[test]
fn removed_blobs_dir_takes_its_shas_out_of_known_blob() {
    let dir = tmp("blobs-dir-gone");
    let mut store = open(&dir);
    ingest_body(&mut store, "d.request.json", &body("d"), TS).expect("ingest");
    flush_detailed(&mut store).expect("flush");
    let indexed = count(&store, "SELECT count(*) FROM known_blob");
    assert!(indexed > 0, "premise: the body blob spans are indexed");

    std::fs::remove_dir_all(dir.join(BLOBS_DIR)).expect("remove blobs dir");
    let stats = sync_new_parts(&mut store).expect("a missing dir is an empty listing, not an error");
    assert_eq!(stats.removed_files[0], 1, "{stats:?}");
    assert_eq!(count(&store, "SELECT count(*) FROM known_blob"), 0, "the vanished blobs dir must leave known_blob");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A blob part is flushed, then the blobs dir is replaced by a regular file of the same name, so read_dir
/// fails with ENOTDIR. The sync returns an error and deletes nothing: known_blob keeps the sha. MUTATION
/// CHECK: map every read_dir error to an empty listing and the sync returns Ok and known_blob loses the sha.
#[test]
fn blobs_path_that_is_not_a_dir_is_an_error_and_keeps_its_shas() {
    let dir = tmp("blobs-not-a-dir");
    let mut store = open(&dir);
    ingest_body(&mut store, "e.request.json", &body("e"), TS).expect("ingest");
    flush_detailed(&mut store).expect("flush");
    let indexed = count(&store, "SELECT count(*) FROM known_blob");
    assert!(indexed > 0, "premise: the body blob spans are indexed");

    std::fs::remove_dir_all(dir.join(BLOBS_DIR)).expect("remove blobs dir");
    std::fs::write(dir.join(BLOBS_DIR), b"not a dir").expect("write blobs as a file");
    sync_new_parts(&mut store).expect_err("a blobs path that cannot be listed must fail the sync");
    assert_eq!(count(&store, "SELECT count(*) FROM known_blob"), indexed, "a failed listing must not delete known_blob rows");
    let _ = std::fs::remove_dir_all(&dir);
}

/// After a body is flushed, all_of(body) reads the body columns without the internal file_id that
/// body_durable carries. MUTATION CHECK: drop the EXCLUDE (file_id) in all_of and file_id appears in the columns.
#[test]
fn all_of_body_does_not_expose_the_internal_file_id() {
    let dir = tmp("all-of-body-columns");
    let mut store = open(&dir);
    ingest_body(&mut store, "f.request.json", &body("f"), TS).expect("ingest");
    flush_detailed(&mut store).expect("flush");
    let mut stmt = store.con.prepare(&format!("SELECT * FROM {} LIMIT 0", all_of(&store, "body"))).expect("prepare");
    let rows = stmt.query([]).expect("query");
    drop(rows);
    let columns = stmt.column_names();
    assert!(columns.iter().any(|c| c == "body_id"), "premise: the body columns are read: {columns:?}");
    assert!(!columns.iter().any(|c| c == "file_id"), "file_id is internal to body_durable: {columns:?}");
    let _ = std::fs::remove_dir_all(&dir);
}

//! TRDD-1FWN9XBS: the known_part index scopes a reconstruct's parts read to the files that own a body.
//! These tests pin the index's writers (flush, sync_new_parts, open_store, the removal path) and the read
//! it serves (part_fetch_sql). Each reconstruct reads back through the store that wrote the rows, so a
//! passing assertion means the original bytes came back, not only that an index row exists.

use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

use agentlens_store::{all_of, body_id_of, flush_detailed, ingest_body, open_store, part_fetch_sql, reconstruct_body, sync_new_parts, verify_bodies_in_store, Store, VerifyItem, BODIES_DIR, PARTS_DIR};

const TS: i64 = 1_787_000_000_000;

fn tmp(tag: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("al-known-part-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    d
}

fn open(dir: &Path) -> Store {
    open_store(dir, "512MB", 1).expect("open")
}

/// A JSON request body long enough to produce blob spans (the same shape sync_removed_parts.rs uses).
fn body(tag: &str) -> String {
    format!("{{\"model\":\"m\",\"messages\":[{{\"role\":\"user\",\"content\":\"{}-{tag}\"}}]}}", "r".repeat(600))
}

fn count(store: &Store, sql: &str) -> i64 {
    store.con.query_row(sql, [], |r| r.get(0)).expect(sql)
}

/// Every (body_id hex, parts file path) the index holds. The file is named by its path, read through
/// part_file, so the check does not depend on the numeric file id.
fn known_part_rows(store: &Store) -> Vec<(String, String)> {
    let mut stmt = store
        .con
        .prepare("SELECT lower(hex(k.body_id)), pf.path FROM known_part k JOIN part_file pf ON pf.id = k.file_id ORDER BY 1, 2")
        .expect("prepare");
    let rows: Vec<(String, String)> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows");
    rows
}

/// The parts file one flush wrote: the one entry of its returned paths that sits in `parts/`.
fn parts_path_of(dir: &Path, part_paths: &[PathBuf]) -> String {
    let parts_dir = dir.join(PARTS_DIR);
    let found: Vec<&PathBuf> = part_paths.iter().filter(|p| p.starts_with(&parts_dir)).collect();
    assert_eq!(found.len(), 1, "premise: one flush writes one parts file: {part_paths:?}");
    found[0].to_str().expect("utf8 path").to_owned()
}

/// The one .parquet file in `sub`: a single flush writes exactly one file per dir.
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

/// A flushed body is indexed to the parts file its own flush wrote, with no reopen: the flush writes the
/// known_part row in the same transaction as the part_file row. MUTATION CHECK: make the "part" arm of
/// flush_detailed an empty string and the index stays empty.
#[test]
fn a_flushed_body_is_indexed_to_the_parts_file_its_flush_wrote() {
    let dir = tmp("flush");
    let mut store = open(&dir);
    let raw = body("a");
    let body_id = body_id_of(&raw);
    ingest_body(&mut store, "a.request.json", &raw, TS).expect("ingest");
    let flushed = flush_detailed(&mut store).expect("flush");
    let parts_file = parts_path_of(&dir, &flushed.part_paths);

    assert_eq!(known_part_rows(&store), vec![(body_id, parts_file)], "one flushed body, one index row naming its parts file");
    let _ = std::fs::remove_dir_all(&dir);
}

/// part_fetch_sql names only the parts file that owns the requested body, so reconstruct_body reads one of
/// the two files and returns the original bytes with no fallback. MUTATION CHECK: drop the WHERE of the
/// owning-files query and the single-file assertion fails.
#[test]
fn part_fetch_sql_names_only_the_owning_file_and_reconstructs_the_body() {
    let dir = tmp("scoped");
    let mut store = open(&dir);
    let (raw_x, raw_y) = (body("x"), body("y"));
    let (x_id, y_id) = (body_id_of(&raw_x), body_id_of(&raw_y));
    ingest_body(&mut store, "x.request.json", &raw_x, TS).expect("ingest x");
    let x_file = parts_path_of(&dir, &flush_detailed(&mut store).expect("flush x").part_paths);
    ingest_body(&mut store, "y.request.json", &raw_y, TS).expect("ingest y");
    let y_file = parts_path_of(&dir, &flush_detailed(&mut store).expect("flush y").part_paths);
    assert_ne!(x_file, y_file, "premise: two flushes write two parts files");

    let sql = part_fetch_sql(&store, &[x_id.as_str()], "pos, kind, lit, sha").expect("sql");
    assert!(sql.contains(&x_file), "must read x's owning parts file: {sql}");
    assert!(!sql.contains(&y_file), "must not read y's parts file: {sql}");
    assert_eq!(sql.matches(".parquet").count(), 1, "exactly one parts file: {sql}");
    assert_eq!(store.part_fetch_fallbacks.load(Ordering::Relaxed), 0, "an indexed body must not fall back");
    assert_eq!(reconstruct_body(&store, &x_id).expect("reconstruct x"), raw_x);
    assert_eq!(reconstruct_body(&store, &y_id).expect("reconstruct y"), raw_y);
    let _ = std::fs::remove_dir_all(&dir);
}

/// A body still in RAM staging is not in the index: part_fetch_sql returns the full all_of("part") form,
/// counts the fallback, and reconstruct_body still returns the original bytes from the staged rows.
/// MUTATION CHECK: remove the fallback counter increment and the counter assertion fails.
#[test]
fn an_unflushed_body_falls_back_to_the_full_scan_and_is_counted() {
    let dir = tmp("staged");
    let mut store = open(&dir);
    let raw = body("c");
    let body_id = body_id_of(&raw);
    ingest_body(&mut store, "c.request.json", &raw, TS).expect("ingest");

    let sql = part_fetch_sql(&store, &[body_id.as_str()], "pos, kind, lit, sha").expect("sql");
    assert!(!sql.contains("read_parquet"), "no parts file exists yet, so the full scan reads none: {sql}");
    assert_eq!(store.part_fetch_fallbacks.load(Ordering::Relaxed), 1, "the fallback must be counted");
    assert_eq!(reconstruct_body(&store, &body_id).expect("reconstruct staged body"), raw);
    let _ = std::fs::remove_dir_all(&dir);
}

/// PRE-EXISTING DEFECT, pinned on purpose (TRDD-1FWN9XBS). A body present in TWO parts files (a copy
/// another writer registered through sync_new_parts) is named by both files, and reconstruct_body reads
/// every (body_id, pos) row twice. The sha256 gate then refuses the doubled bytes loudly. The old
/// all_of("part") read returned the same duplicate rows, so this change does not introduce the defect.
/// A fix (one row per (body_id, pos)) must flip the final assertion; this test must not hide it.
#[test]
fn a_body_in_two_parts_files_is_named_by_both_and_the_gate_refuses_the_doubled_rows() {
    let dir = tmp("two-files");
    let mut store = open(&dir);
    let raw = body("d");
    let body_id = body_id_of(&raw);
    ingest_body(&mut store, "d.request.json", &raw, TS).expect("ingest");
    let original = parts_path_of(&dir, &flush_detailed(&mut store).expect("flush").part_paths);
    // The same parts bytes under a new name: another writer's copy of this body's parts.
    let copy = dir.join(PARTS_DIR).join("part-copy.parquet");
    std::fs::copy(&original, &copy).expect("copy parts file");
    let stats = sync_new_parts(&mut store).expect("sync");
    assert_eq!(stats.new_files[1], 1, "{stats:?}");
    // The claim above, checked rather than assumed: all_of("part") is the pre-change read and is unchanged by
    // this work, so its row count on this body is the pre-change count. It must be two files' worth of rows.
    let one_file: i64 = store
        .con
        .query_row(&format!("SELECT count(*) FROM read_parquet(['{original}']) WHERE body_id = '{body_id}'"), [], |r| r.get(0))
        .expect("count one file");
    let all_parts: i64 = store
        .con
        .query_row(&format!("SELECT count(*) FROM {} WHERE body_id = '{body_id}'", all_of(&store, "part")), [], |r| r.get(0))
        .expect("count all_of(part)");
    assert_eq!(all_parts, 2 * one_file, "all_of(part) unions both files, so the pre-change read also saw every row twice");

    let sql = part_fetch_sql(&store, &[body_id.as_str()], "pos, kind, lit, sha").expect("sql");
    assert!(sql.contains(&original), "the original parts file must be named: {sql}");
    assert!(sql.contains(&copy.to_string_lossy().into_owned()), "the copy must be named too: {sql}");
    assert_eq!(store.part_fetch_fallbacks.load(Ordering::Relaxed), 0, "an indexed body must not fall back");
    let err = reconstruct_body(&store, &body_id).expect_err("the doubled rows must be refused, not returned");
    assert!(err.contains("RECONSTRUCTION MISMATCH"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A parts file deleted out of band takes its known_part rows with it, so the index never names a file that
/// is gone. MUTATION CHECK: remove the known_part DELETE from remove_vanished_files and the row stays.
#[test]
fn a_vanished_parts_file_takes_its_known_part_rows_with_it() {
    let dir = tmp("vanished");
    let mut store = open(&dir);
    ingest_body(&mut store, "e.request.json", &body("e"), TS).expect("ingest");
    flush_detailed(&mut store).expect("flush");
    assert_eq!(count(&store, "SELECT count(*) FROM known_part"), 1, "premise: the flushed body is indexed");

    std::fs::remove_file(only_part(&dir, PARTS_DIR)).expect("delete parts file");
    let stats = sync_new_parts(&mut store).expect("sync");
    assert_eq!(stats.removed_files[1], 1, "{stats:?}");
    assert_eq!(count(&store, "SELECT count(*) FROM known_part"), 0, "the vanished parts file must leave known_part");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A reopen rebuilds known_part from the parts files on disk: the seed in open_store yields the same rows
/// the writer held. MUTATION CHECK: remove the index_part_bodies call in open_store and the reopened index
/// is empty.
#[test]
fn reopening_the_store_rebuilds_known_part_from_the_parts_files() {
    let dir = tmp("reopen");
    let (raw_x, raw_y) = (body("x"), body("y"));
    let before = {
        let mut writer = open(&dir);
        ingest_body(&mut writer, "x.request.json", &raw_x, TS).expect("ingest x");
        flush_detailed(&mut writer).expect("flush x");
        ingest_body(&mut writer, "y.request.json", &raw_y, TS).expect("ingest y");
        flush_detailed(&mut writer).expect("flush y");
        known_part_rows(&writer)
    };
    assert_eq!(before.len(), 2, "premise: two bodies in two parts files: {before:?}");
    let reopened = open(&dir);
    assert_eq!(known_part_rows(&reopened), before, "the open-time seed must rebuild the writer's rows");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A parts file without body_id is not a parts file, so open_store refuses the store rather than seed the
/// index from it or skip it. This is the fail-at-open contract blobs and bodies already have (TRDD-1FWN9XBS).
/// MUTATION CHECK: make the open-time seed tolerate the index_part_bodies error (unwrap_or(0)) and open_store
/// returns Ok, so this test fails.
#[test]
fn a_parts_file_without_body_id_fails_open_store() {
    let dir = tmp("no-body-id");
    let store = open(&dir);
    let bad = dir.join(PARTS_DIR).join("part-0-0-no-body-id.parquet");
    store.con.execute_batch(&format!("COPY (SELECT 1 AS x) TO '{}' (FORMAT PARQUET);", bad.display())).expect("write fixture");
    drop(store);
    let err = open_store(&dir, "512MB", 1).err().expect("open_store must refuse a parts file without body_id");
    assert!(err.to_string().contains("body_id"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}


/// One flush writes every staged row of a body into one parts file, and that file holds all of them.
/// WHY (TRDD-1FWN9XBS): the scoped read takes only the files the index names, so a body whose rows sit outside the
/// file its index row names would be read short. MUTATION CHECK: keep only the even-pos rows in the flush "part"
/// select and the file holds fewer rows than were staged.
#[test]
fn a_flush_writes_every_staged_row_of_a_body_to_one_file() {
    let dir = tmp("one-file");
    let mut store = open(&dir);
    let raw = body("f");
    let body_id = body_id_of(&raw);
    ingest_body(&mut store, "f.request.json", &raw, TS).expect("ingest");
    let staged = count(&store, &format!("SELECT count(*) FROM part WHERE body_id = '{body_id}'"));
    assert!(staged > 1, "premise: the body has several part rows: {staged}");
    let flushed = flush_detailed(&mut store).expect("flush");
    let parts_file = parts_path_of(&dir, &flushed.part_paths);
    let in_file = count(&store, &format!("SELECT count(*) FROM read_parquet(['{parts_file}']) WHERE body_id = '{body_id}'"));
    assert_eq!(in_file, staged, "every staged row of the body must be in its one parts file");
    let _ = std::fs::remove_dir_all(&dir);
}

/// The bulk delete gate verifies two flushed bodies, each in its own parts file, with no part fallback.
/// WHY (TRDD-1FWN9XBS): the gate reads through reconstruct_chunk, so a fallback here would silently return to the
/// full parts scan the index exists to remove. MUTATION CHECK: remove the known_part insert from the flush "part"
/// arm and both bodies fall back, so the counter assertion fails.
#[test]
fn verify_of_two_flushed_bodies_passes_with_no_part_fallback() {
    let dir = tmp("verify");
    let mut store = open(&dir);
    let (raw_a, raw_b) = (body("va"), body("vb"));
    ingest_body(&mut store, "va.request.json", &raw_a, TS).expect("ingest a");
    flush_detailed(&mut store).expect("flush a");
    ingest_body(&mut store, "vb.request.json", &raw_b, TS).expect("ingest b");
    flush_detailed(&mut store).expect("flush b");
    let items = [
        VerifyItem { src_name: "va.request.json".into(), raw: raw_a, ts_ms: Some(TS) },
        VerifyItem { src_name: "vb.request.json".into(), raw: raw_b, ts_ms: Some(TS) },
    ];
    let v = verify_bodies_in_store(&store, &items).expect("verify");
    assert!(v["va.request.json"].ok, "{:?}", v["va.request.json"].reason);
    assert!(v["vb.request.json"].ok, "{:?}", v["vb.request.json"].reason);
    assert_eq!(store.part_fetch_fallbacks.load(Ordering::Relaxed), 0, "indexed bodies must verify without a fallback");
    let _ = std::fs::remove_dir_all(&dir);
}

/// A parts file a second Store wrote for a new body is indexed by one sync and reconstructs with no fallback.
/// WHY (TRDD-1FWN9XBS): the sync PARTS arm is the only writer of known_part for a file another writer registered,
/// so a body from another writer is read through the scoped path only if that arm indexes it. MUTATION CHECK:
/// remove the index_part_bodies call from the sync PARTS arm and the synced body falls back.
#[test]
fn a_second_writers_parts_file_is_indexed_by_sync_and_reconstructs_without_fallback() {
    let dir = tmp("second-writer");
    let mut ours = open(&dir);
    let raw = body("sw");
    let body_id = body_id_of(&raw);
    let other_file = {
        let mut other = open(&dir);
        ingest_body(&mut other, "sw.request.json", &raw, TS).expect("other ingest");
        parts_path_of(&dir, &flush_detailed(&mut other).expect("other flush").part_paths)
    };
    let stats = sync_new_parts(&mut ours).expect("sync");
    assert_eq!(stats.new_files[1], 1, "{stats:?}");
    assert!(stats.skipped.is_empty(), "{stats:?}");
    let sql = part_fetch_sql(&ours, &[body_id.as_str()], "pos, kind, lit, sha").expect("sql");
    assert!(sql.contains(&other_file), "the other writer's parts file must be named: {sql}");
    assert_eq!(sql.matches(".parquet").count(), 1, "exactly one parts file: {sql}");
    assert_eq!(ours.part_fetch_fallbacks.load(Ordering::Relaxed), 0, "a synced body must not fall back");
    assert_eq!(reconstruct_body(&ours, &body_id).expect("reconstruct"), raw);
    let _ = std::fs::remove_dir_all(&dir);
}


/// A bodies file deleted out of band makes a re-ingest of its body write the parts again, so two parts files name it.
/// WHY (TRDD-1FWN9XBS Change 1 review, TRDD-23TSWT9M): this records the mechanism behind the doubled-rows card; the test pins what the code does
/// and fixes nothing.
#[test]
fn a_vanished_bodies_file_makes_a_re_ingest_write_the_parts_again() {
    let dir = tmp("vanished-bodies");
    let mut store = open(&dir);
    let raw = body("vb");
    let body_id = body_id_of(&raw);
    ingest_body(&mut store, "vb.request.json", &raw, TS).expect("ingest");
    let first = parts_path_of(&dir, &flush_detailed(&mut store).expect("flush").part_paths);
    std::fs::remove_file(only_part(&dir, BODIES_DIR)).expect("delete bodies file");
    let stats = sync_new_parts(&mut store).expect("sync");
    assert_eq!(stats.removed_files[2], 1, "{stats:?}");
    assert_eq!(count(&store, "SELECT count(*) FROM body_durable"), 0, "the vanished bodies file must leave body_durable");
    let again = ingest_body(&mut store, "vb.request.json", &raw, TS).expect("re-ingest");
    assert!(!again.existed, "the body row is gone, so the re-ingest is not a dedup hit");
    let second = parts_path_of(&dir, &flush_detailed(&mut store).expect("flush again").part_paths);
    assert_ne!(first, second, "the re-ingest must write its parts to a new file");
    assert!(std::path::Path::new(&first).exists(), "the original parts file must survive");
    let named = count(&store, &format!("SELECT count(*) FROM known_part WHERE body_id = unhex('{body_id}')"));
    assert_eq!(named, 2, "the body must be named by two parts files");
    let err = reconstruct_body(&store, &body_id).expect_err("two copies of the rows must be refused");
    assert!(err.contains("RECONSTRUCTION MISMATCH"), "{err}");
    let _ = std::fs::remove_dir_all(&dir);
}


/// A parts file deleted out of band leaves its body unknown, and a re-ingest of that body writes nothing.
/// WHY (TRDD-1FWN9XBS Change 1 review, TRDD-23TSWT9M): the out-of-band-delete family the card describes; the test records what the code does.
#[test]
fn a_vanished_parts_file_leaves_its_body_unknown_and_a_re_ingest_writes_nothing() {
    let dir = tmp("vanished-parts");
    let mut store = open(&dir);
    let raw = body("vp");
    let body_id = body_id_of(&raw);
    ingest_body(&mut store, "vp.request.json", &raw, TS).expect("ingest");
    flush_detailed(&mut store).expect("flush");
    std::fs::remove_file(only_part(&dir, PARTS_DIR)).expect("delete parts file");
    let stats = sync_new_parts(&mut store).expect("sync");
    assert_eq!(stats.removed_files[1], 1, "{stats:?}");
    assert_eq!(count(&store, "SELECT count(*) FROM known_part"), 0, "the vanished parts file must leave known_part");
    let err = reconstruct_body(&store, &body_id).expect_err("the body parts are gone");
    assert_eq!(err, format!("unknown body {body_id}"));
    assert_eq!(store.part_fetch_fallbacks.load(Ordering::Relaxed), 1, "the read falls back to the full scan");
    let again = ingest_body(&mut store, "vp.request.json", &raw, TS).expect("re-ingest");
    assert!(again.existed, "the bodies row survives, so the re-ingest is a dedup hit");
    let flushed = flush_detailed(&mut store).expect("flush after re-ingest");
    assert!(flushed.part_paths.is_empty(), "a dedup hit stages no parts: {:?}", flushed.part_paths);
    assert!(reconstruct_body(&store, &body_id).is_err(), "the body stays unknown after the re-ingest");
    let _ = std::fs::remove_dir_all(&dir);
}


/// A malformed body id is refused with an error, never a panic. WHY (TRDD-1FWN9XBS): part_fetch_sql builds
/// unhex(...) from the id, so a bad id must come back to the caller as Err.
#[test]
fn reconstruct_body_refuses_a_malformed_id() {
    let dir = tmp("malformed");
    let store = open(&dir);
    let err = reconstruct_body(&store, "not-hex").expect_err("a malformed id must be refused");
    assert_eq!(err, "unknown body not-hex");
    // A malformed id is not rejected before SQL; unhex yields no match, so it takes the counted full-scan fallback. Pinned so a future pre-SQL rejection or a silent path change is visible.
    assert_eq!(store.part_fetch_fallbacks.load(Ordering::Relaxed), 1, "a malformed id must take the counted fallback");
    let _ = std::fs::remove_dir_all(&dir);
}

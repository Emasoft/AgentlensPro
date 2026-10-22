//! Store round-trip pins (TRDD-DMWOBWFH P3c): GATE 1 (byte-identical reconstruction), GATE 2
//! (re-ingest writes nothing), durability across reopen, and the verify delete-gate's three
//! checks (bytes / row / ts-tolerance).

use std::fs;
use std::path::PathBuf;

fn fixture_dir(tag: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("al-store-{}-{}", std::process::id(), tag));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).expect("mkdir");
    dir
}

fn body(tag: &str) -> String {
    let big = "m".repeat(400);
    format!(
        "{{\"model\":\"claude-opus-5\",\"metadata\":{{\"user_id\":\"{{\\\"session_id\\\":\\\"sess-{tag}\\\"}}\"}},\"messages\":[{{\"role\":\"user\",\"content\":\"{big}-{tag}\"}},{{\"role\":\"assistant\",\"content\":\"{big}-shared\"}}],\"max_tokens\":7}}"
    )
}

#[test]
fn ingest_flush_reopen_reconstructs_byte_identically_and_dedups() {
    let dir = fixture_dir("rt");
    let raw1 = body("one");
    let raw2 = body("two"); // shares the big assistant blob with raw1
    let ts = 1_787_000_000_000_i64;

    let mut store = agentlens_store::open_store(&dir, "1GB", 4).expect("open");
    let r1 = agentlens_store::ingest_body(&mut store, "a.request.json", &raw1, ts).expect("ingest 1");
    assert!(!r1.existed);
    assert!(r1.new_blobs >= 2);
    let r2 = agentlens_store::ingest_body(&mut store, "b.request.json", &raw2, ts + 1000).expect("ingest 2");
    assert!(r2.new_blobs < r1.new_blobs, "the shared blob must dedup (GATE 2)");
    // Same bytes again under a new name: zero new blobs, existed, but a NEW (src_name, ts) row.
    let r3 = agentlens_store::ingest_body(&mut store, "c.request.json", &raw1, ts + 2000).expect("ingest 3");
    assert!(r3.existed);
    assert_eq!(r3.new_blobs, 0);

    let flushed = agentlens_store::flush_detailed(&mut store).expect("flush");
    assert!(flushed.n > 0);
    // 4 since TRDD-9SYRK6SW: blob + body + part + api_call (these fixture bodies parse, so each
    // body row is accompanied by an api_call row).
    assert_eq!(flushed.part_paths.len(), 4, "one part per non-empty table");
    drop(store);

    // Reopen: the dedup set reloads from the durable parts; reconstruction is end-to-end proven.
    let mut store2 = agentlens_store::open_store(&dir, "1GB", 4).expect("reopen");
    assert!(count(&store2, "known_blob") > 0, "known_blob reloads from parts");
    let back = agentlens_store::reconstruct_body(&store2, &r1.body_id).expect("reconstruct");
    assert_eq!(back, raw1, "byte identity across flush + reopen");
    let r4 = agentlens_store::ingest_body(&mut store2, "a.request.json", &raw1, ts).expect("re-ingest");
    assert!(r4.existed);
    assert_eq!(r4.new_bytes, 0, "a restart must not re-store what is already durable");
    let _ = fs::remove_dir_all(&dir);
}

/// TRDD-768NEX6E box 4: `blob_files` must map every flushed sha to an existing part file on
/// disk, both right after flush and after a reopen (which rebuilds the index from scratch via
/// `filename := true`).
#[test]
fn blob_files_indexes_every_durable_sha_to_an_existing_part_file() {
    let dir = fixture_dir("blobidx");
    let raw = body("idx");
    let ts = 1_787_000_000_000_i64;

    let mut store = agentlens_store::open_store(&dir, "1GB", 4).expect("open");
    assert_eq!(count(&store, "known_blob"), 0, "nothing durable yet");
    agentlens_store::ingest_body(&mut store, "idx.request.json", &raw, ts).expect("ingest");
    agentlens_store::flush_detailed(&mut store).expect("flush");

    let index = sha_index(&store);
    assert!(!index.is_empty(), "flush must populate the index");
    assert_eq!(index.len() as i64, count(&store, "known_blob"), "every known_blob sha must map to a part_file row");
    for (sha, path) in &index {
        assert_eq!(sha.len(), 64, "the BLOB sha round-trips to a 64-char hex digest: {sha}");
        assert!(std::path::Path::new(path).is_file(), "indexed path must exist on disk: {path}");
        assert!(path.ends_with(".parquet"));
    }
    drop(store);

    // Reopen rebuilds the index purely from the parquet scan — must match.
    let store2 = agentlens_store::open_store(&dir, "1GB", 4).expect("reopen");
    assert_eq!(sha_index(&store2), index, "reopen must rebuild the same index");
    let _ = fs::remove_dir_all(&dir);
}

/// Dedup moved from Rust sets to SQL (ingest probes known_blob / body_durable, flush anti-joins):
/// the same bytes under a new name after a flush must add zero blob rows and exactly one body
/// row, and a reopen must rebuild the same known_blob.
#[test]
fn same_bytes_new_name_after_flush_adds_one_body_row_and_no_blobs() {
    let dir = fixture_dir("samebytes");
    let raw = body("same");
    let ts = 1_787_000_000_000_i64;

    let mut store = agentlens_store::open_store(&dir, "1GB", 4).expect("open");
    agentlens_store::ingest_body(&mut store, "a.request.json", &raw, ts).expect("ingest a");
    agentlens_store::flush_detailed(&mut store).expect("flush 1");
    let blobs_before = count(&store, "known_blob");
    let bodies_before = count(&store, "body_durable");
    assert!(blobs_before > 0);

    let r = agentlens_store::ingest_body(&mut store, "b.request.json", &raw, ts + 1000).expect("ingest b");
    assert!(r.existed);
    assert_eq!(r.new_blobs, 0);
    let flushed = agentlens_store::flush_detailed(&mut store).expect("flush 2");
    assert_eq!(flushed.n, 0, "no new blob rows written");
    assert!(
        !flushed.part_paths.iter().any(|p| p.parent().is_some_and(|d| d.ends_with(agentlens_store::BLOBS_DIR))),
        "no blob part file for a flush with nothing new: {:?}",
        flushed.part_paths
    );
    assert_eq!(count(&store, "known_blob"), blobs_before, "zero new blob rows");
    assert_eq!(count(&store, "body_durable"), bodies_before + 1, "exactly one new body row");
    drop(store);

    let store2 = agentlens_store::open_store(&dir, "1GB", 4).expect("reopen");
    assert_eq!(count(&store2, "known_blob"), blobs_before, "reopen rebuilds the same known_blob");
    assert_eq!(count(&store2, "body_durable"), bodies_before + 1);
    let _ = fs::remove_dir_all(&dir);
}

/// The flush correctness net on its own: a blob row staged by hand (bypassing the ingest probe)
/// whose sha is already durable must NOT be written again.
#[test]
fn flush_anti_join_drops_an_already_durable_blob() {
    let dir = fixture_dir("antijoin");
    let raw = body("aj");
    let ts = 1_787_000_000_000_i64;
    let mut store = agentlens_store::open_store(&dir, "1GB", 4).expect("open");
    agentlens_store::ingest_body(&mut store, "aj.request.json", &raw, ts).expect("ingest");
    agentlens_store::flush_detailed(&mut store).expect("flush 1");
    let before = count(&store, "known_blob");
    // Re-stage every durable sha twice, as a buggy ingest would.
    store
        .con
        .execute_batch(
            "INSERT INTO blob SELECT lower(hex(sha)), 1, NULL FROM known_blob;
             INSERT INTO blob SELECT lower(hex(sha)), 1, NULL FROM known_blob;",
        )
        .expect("stage dupes");
    let flushed = agentlens_store::flush_detailed(&mut store).expect("flush 2");
    assert_eq!(flushed.n, 0, "durable shas must be anti-joined away");
    assert_eq!(count(&store, "known_blob"), before);
    assert_eq!(count(&store, "blob"), 0, "staging is cleared");
    let _ = fs::remove_dir_all(&dir);
}


/// The body and part anti-joins on their own: an already-durable body row and its part rows
/// staged again by hand (bypassing the ingest probe) must not be written to a new part.
#[test]
fn flush_anti_join_drops_already_durable_body_and_part_rows() {
    let dir = fixture_dir("antijoin-body");
    let raw = body("ajb");
    let ts = 1_787_000_000_000_i64;
    let mut store = agentlens_store::open_store(&dir, "1GB", 4).expect("open");
    agentlens_store::ingest_body(&mut store, "ajb.request.json", &raw, ts).expect("ingest");
    agentlens_store::flush_detailed(&mut store).expect("flush 1");
    let bodies_before = count(&store, "body_durable");
    let parts = agentlens_store::parquet_scan(&dir, agentlens_store::PARTS_DIR).expect("a part file exists");
    store
        .con
        .execute_batch(&format!(
            "INSERT INTO body BY NAME SELECT * FROM body_durable;
             INSERT INTO part BY NAME SELECT * FROM {parts};"
        ))
        .expect("stage dupes");
    assert!(count(&store, "body") > 0 && count(&store, "part") > 0, "duplicates are staged");

    let flushed = agentlens_store::flush_detailed(&mut store).expect("flush 2");
    assert!(
        !flushed.part_paths.iter().any(|p| p.parent().is_some_and(|d| d.ends_with(agentlens_store::BODIES_DIR) || d.ends_with(agentlens_store::PARTS_DIR))),
        "no body or part file for durable duplicates: {:?}",
        flushed.part_paths
    );
    assert_eq!(count(&store, "body_durable"), bodies_before, "no body row added");
    assert_eq!(parquet_files(&dir, agentlens_store::PARTS_DIR), 1, "no second part file");
    assert_eq!(count(&store, "body") + count(&store, "part"), 0, "staging is cleared");
    let _ = fs::remove_dir_all(&dir);
}

/// The post-COPY index updates are one transaction: when one fails, the rollback leaves staging
/// and the index untouched, removes the unindexed part file the COPY wrote, and the retry writes
/// exactly one part.
#[test]
fn a_failed_post_copy_update_rolls_back_and_the_retry_writes_one_part() {
    let dir = fixture_dir("rollback");
    let raw = body("rb");
    let ts = 1_787_000_000_000_i64;
    let mut store = agentlens_store::open_store(&dir, "1GB", 4).expect("open");
    agentlens_store::ingest_body(&mut store, "rb.request.json", &raw, ts).expect("ingest");
    let staged = count(&store, "blob");
    assert!(staged >= 2, "the fixture stages several spans");
    // Fail the SECOND statement of the transaction deterministically: the part_file INSERT
    // succeeds, then the known_blob INSERT (several shas, one file id) violates this index.
    // Only a real transaction can undo the part_file row that already went in.
    store.con.execute_batch("CREATE UNIQUE INDEX one_sha_per_file ON known_blob (file_id);").expect("trap");
    let err = agentlens_store::flush_detailed(&mut store).expect_err("the index update must fail");
    assert!(err.contains("rolled back"), "{err}");
    assert_eq!(count(&store, "blob"), staged, "staging intact after rollback");
    assert_eq!(count(&store, "known_blob"), 0, "known_blob untouched after rollback");
    assert_eq!(count(&store, "part_file"), 0, "the part_file insert that succeeded is rolled back too");
    assert_eq!(parquet_files(&dir, agentlens_store::BLOBS_DIR), 0, "the unindexed part file is removed");

    store.con.execute_batch("DROP INDEX one_sha_per_file;").expect("untrap");
    agentlens_store::flush_detailed(&mut store).expect("retry");
    assert_eq!(parquet_files(&dir, agentlens_store::BLOBS_DIR), 1, "the retry writes exactly one blob part");
    assert_eq!(count(&store, "known_blob"), staged, "every staged sha indexed once");
    assert_eq!(count(&store, "blob"), 0);
    let _ = fs::remove_dir_all(&dir);
}

/// The flush anti-join net, end to end: a blob whose sha is already durable, a part row and a body
/// row for an already-durable body, and two identical NEW blob rows in one batch. Only the one new
/// sha may reach a part file, and only once.
#[test]
fn restaged_durable_rows_and_a_duplicated_new_sha_write_one_blob_once() {
    let dir = fixture_dir("antijoin-mixed");
    let raw = body("mix");
    let ts = 1_787_000_000_000_i64;
    let mut store = agentlens_store::open_store(&dir, "1GB", 4).expect("open");
    agentlens_store::ingest_body(&mut store, "mix.request.json", &raw, ts).expect("ingest");
    agentlens_store::flush_detailed(&mut store).expect("flush 1");
    let known_before = count(&store, "known_blob");
    let durable_sha: String = store
        .con
        .query_row("SELECT lower(hex(sha)) FROM known_blob LIMIT 1", [], |r| r.get(0))
        .expect("a durable sha");
    let body_id = agentlens_store::body_id_of(&raw);
    let new_sha = "f".repeat(64);
    store
        .con
        .execute_batch(&format!(
            "INSERT INTO blob VALUES ('{durable_sha}', 3, 'already-durable');
             INSERT INTO blob VALUES ('{new_sha}', 1, 'new'), ('{new_sha}', 1, 'new');
             INSERT INTO part VALUES ('{body_id}', 0, 'lit', 'dup', NULL, NULL, NULL, NULL);
             INSERT INTO body SELECT * FROM body_durable;"
        ))
        .expect("stage duplicates");

    let flushed = agentlens_store::flush_detailed(&mut store).expect("flush 2");
    assert_eq!(flushed.n, 1, "only the new sha is written");
    assert_eq!(flushed.part_paths.len(), 1, "the durable part and body duplicates write no file");
    let new_part = &flushed.part_paths[0];
    assert!(new_part.starts_with(dir.join(agentlens_store::BLOBS_DIR)), "the one file is a blob part: {}", new_part.display());
    let (rows, distinct): (i64, i64) = store
        .con
        .query_row(
            &format!("SELECT count(*), count(DISTINCT sha) FROM read_parquet('{}')", new_part.display()),
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .expect("read the new part");
    assert_eq!((rows, distinct), (1, 1), "the new part holds the one new sha exactly once");
    let (known_rows, known_distinct): (i64, i64) = store
        .con
        .query_row("SELECT count(*), count(DISTINCT sha) FROM known_blob", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .expect("known_blob");
    assert_eq!(known_rows, known_distinct, "known_blob has no duplicate sha");
    assert_eq!(known_rows, known_before + 1, "known_blob gains exactly the one new sha");
    assert_eq!(parquet_files(&dir, agentlens_store::PARTS_DIR), 1, "no new part-table file");
    assert_eq!(parquet_files(&dir, agentlens_store::BODIES_DIR), 1, "no new body file");
    for table in ["blob", "part", "body", "api_call"] {
        assert_eq!(count(&store, table), 0, "staging {table} is cleared");
    }
    let _ = fs::remove_dir_all(&dir);
}

/// A post-COPY transaction that fails must take the part file it just wrote with it: no index names
/// that file, so a reopen would not load it, but a retry would write the same rows again as a second
/// file. The staged blob must survive intact.
#[test]
fn a_failed_blob_index_update_removes_the_part_file_it_copied() {
    let dir = fixture_dir("cleanup");
    let raw = body("cl");
    let ts = 1_787_000_000_000_i64;
    let mut store = agentlens_store::open_store(&dir, "1GB", 4).expect("open");
    agentlens_store::ingest_body(&mut store, "cl.request.json", &raw, ts).expect("ingest");
    agentlens_store::flush_detailed(&mut store).expect("flush 1");
    let files_before = parquet_files(&dir, agentlens_store::BLOBS_DIR);
    assert_eq!(files_before, 1, "baseline: one blob part from flush 1");
    let new_sha = "a".repeat(64);
    store
        .con
        .execute_batch(&format!("INSERT INTO blob VALUES ('{new_sha}', 1, 'staged');"))
        .expect("stage one new blob");
    let staged = count(&store, "blob");
    // The COPY of the blob table writes its part file, then the index insert hits the missing table.
    store.con.execute_batch("DROP TABLE part_file;").expect("trap");
    let err = agentlens_store::flush_detailed(&mut store).expect_err("the index update must fail");
    assert!(err.contains("rolled back after COPY"), "{err}");
    assert!(!err.contains("ROLLBACK failed"), "{err}");
    assert_eq!(parquet_files(&dir, agentlens_store::BLOBS_DIR), files_before, "the part file the COPY wrote is removed");
    assert_eq!(count(&store, "blob"), staged, "staging is intact");
    let _ = fs::remove_dir_all(&dir);
}

fn parquet_files(dir: &std::path::Path, sub: &str) -> usize {
    fs::read_dir(dir.join(sub))
        .expect("read_dir")
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "parquet"))
        .count()
}

fn count(store: &agentlens_store::Store, table: &str) -> i64 {
    store.con.query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0)).expect("count")
}

/// sha (hex) to owning part file, from the SQL index that replaced the Rust `blob_files` map.
fn sha_index(store: &agentlens_store::Store) -> std::collections::BTreeMap<String, String> {
    let mut stmt = store
        .con
        .prepare("SELECT lower(hex(k.sha)), pf.path FROM known_blob k JOIN part_file pf ON pf.id = k.file_id")
        .expect("prepare");
    stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        .expect("query")
        .collect::<Result<_, _>>()
        .expect("rows")
}

#[test]
fn verify_gate_checks_bytes_row_and_ts() {
    let dir = fixture_dir("verify");
    let raw = body("v");
    let ts = 1_787_000_000_000_i64;
    let mut store = agentlens_store::open_store(&dir, "1GB", 4).expect("open");
    agentlens_store::ingest_body(&mut store, "v.request.json", &raw, ts).expect("ingest");
    agentlens_store::flush_detailed(&mut store).expect("flush");

    let ok = agentlens_store::verify_bodies_in_store(&store, &[agentlens_store::VerifyItem {
        src_name: "v.request.json".into(), raw: raw.clone(), ts_ms: Some(ts + 1500),
    }]).expect("verify");
    assert!(ok["v.request.json"].ok, "within ts tolerance passes");

    let wrong_ts = agentlens_store::verify_bodies_in_store(&store, &[agentlens_store::VerifyItem {
        src_name: "v.request.json".into(), raw: raw.clone(), ts_ms: Some(ts + 60_000),
    }]).expect("verify");
    assert!(!wrong_ts["v.request.json"].ok, "a wrong capture ts must fail the gate");
    assert!(wrong_ts["v.request.json"].reason.as_deref().unwrap().contains("stored ts"));

    let wrong_name = agentlens_store::verify_bodies_in_store(&store, &[agentlens_store::VerifyItem {
        src_name: "other.request.json".into(), raw: raw.clone(), ts_ms: None,
    }]).expect("verify");
    assert!(!wrong_name["other.request.json"].ok, "same content under another name is NOT a row for this name");
    let _ = fs::remove_dir_all(&dir);
}

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
    assert_eq!(flushed.part_paths.len(), 3, "one part per non-empty table");
    drop(store);

    // Reopen: the dedup set reloads from the durable parts; reconstruction is end-to-end proven.
    let mut store2 = agentlens_store::open_store(&dir, "1GB", 4).expect("reopen");
    assert!(!store2.known.is_empty(), "known set reloads from parts");
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
    assert!(store.blob_files.is_empty(), "nothing durable yet");
    agentlens_store::ingest_body(&mut store, "idx.request.json", &raw, ts).expect("ingest");
    agentlens_store::flush_detailed(&mut store).expect("flush");

    assert!(!store.blob_files.is_empty(), "flush must populate the index");
    for (sha, path) in &store.blob_files {
        assert!(store.known.contains(sha), "every indexed sha must also be in `known`");
        assert!(std::path::Path::new(path).is_file(), "indexed path must exist on disk: {path}");
        assert!(path.ends_with(".parquet"));
    }
    let after_flush = store.blob_files.clone();
    drop(store);

    // Reopen rebuilds the index purely from the parquet scan — must match.
    let store2 = agentlens_store::open_store(&dir, "1GB", 4).expect("reopen");
    assert_eq!(store2.blob_files.len(), after_flush.len(), "reopen must rebuild the same index");
    let _ = fs::remove_dir_all(&dir);
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

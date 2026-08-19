//! Ingest-pass pins (TRDD-DMWOBWFH P3c): the delete gate's ordering, the throttle, skip-name
//! reclaim, and the stranded park + relocate path.

use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use agentlens_store::pass::{ingest_pass, PassOptions};

fn fixture(tag: &str) -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!("al-pass-{}-{}", std::process::id(), tag));
    let _ = fs::remove_dir_all(&root);
    let bodies = root.join("bodies");
    let store = root.join("store");
    fs::create_dir_all(&bodies).expect("mkdir");
    (bodies, store)
}

fn body(tag: &str) -> String {
    let big = "b".repeat(300);
    format!("{{\"model\":\"claude-opus-5\",\"messages\":[{{\"role\":\"user\",\"content\":\"{big}-{tag}\"}}],\"n\":1}}")
}

fn write_body(dir: &std::path::Path, name: &str, raw: &str, age_ms: i64) {
    let p = dir.join(name);
    fs::write(&p, raw).expect("write");
    let t = std::time::SystemTime::now() - std::time::Duration::from_millis(age_ms as u64);
    let f = fs::OpenOptions::new().write(true).open(&p).expect("open");
    f.set_times(fs::FileTimes::new().set_modified(t)).expect("times");
}

#[test]
fn pass_ingests_verifies_then_deletes_and_a_second_pass_is_a_noop() {
    let (bodies, store_dir) = fixture("basic");
    write_body(&bodies, "a.request.json", &body("a"), 60_000);
    write_body(&bodies, "b.response.json", &body("b"), 50_000);

    let mut store = agentlens_store::open_store(&store_dir, "1GB", 4).expect("open");
    let opts = PassOptions { bodies_dir: bodies.clone(), ..Default::default() };
    let (mut skip, mut stranded, mut fsynced) = (HashSet::new(), HashSet::new(), HashSet::new());
    let r = ingest_pass(&mut store, &opts, &mut skip, &mut stranded, &mut fsynced);
    assert_eq!(r.ingested, 2);
    assert_eq!(r.deleted, 2, "verified bodies delete: {:?}", r.failed);
    assert!(r.failed.is_empty());
    assert!(!bodies.join("a.request.json").exists());

    let r2 = ingest_pass(&mut store, &opts, &mut skip, &mut stranded, &mut fsynced);
    assert_eq!(r2.ingested + r2.deleted, 0, "an empty dir is a no-op pass");
}

#[test]
fn throttle_stops_the_pass_and_reports_it() {
    let (bodies, store_dir) = fixture("throttle");
    write_body(&bodies, "a.request.json", &body("a"), 60_000);
    write_body(&bodies, "b.request.json", &body("b"), 50_000);
    let mut store = agentlens_store::open_store(&store_dir, "1GB", 4).expect("open");
    // Budget fits exactly one file (each ~360 bytes) — the second must throttle.
    let opts = PassOptions { bodies_dir: bodies.clone(), max_bytes_per_pass: 400, ..Default::default() };
    let (mut skip, mut stranded, mut fsynced) = (HashSet::new(), HashSet::new(), HashSet::new());
    let r = ingest_pass(&mut store, &opts, &mut skip, &mut stranded, &mut fsynced);
    assert!(r.throttled, "the byte budget must stop the pass");
    assert_eq!(r.ingested, 1);
    assert!(bodies.join("b.request.json").exists(), "the un-ingested file stays");
}

#[test]
fn unverifiable_bodies_are_kept_and_named_never_deleted() {
    let (bodies, store_dir) = fixture("keep");
    // A file whose bytes CHANGE between ingest and the settle's re-read: simulate by ingesting
    // through a normal pass with delete_after, but corrupting the file after ingest via a
    // pre-seeded skip name (durable path) whose store row does not exist.
    write_body(&bodies, "ghost.request.json", &body("ghost"), 60_000);
    let mut store = agentlens_store::open_store(&store_dir, "1GB", 4).expect("open");
    let opts = PassOptions { bodies_dir: bodies.clone(), ..Default::default() };
    // Pre-seed skip: the pass goes straight to the gate, the store holds nothing → verify fails.
    let mut skip: HashSet<String> = ["ghost.request.json".to_owned()].into();
    let (mut stranded, mut fsynced) = (HashSet::new(), HashSet::new());
    let r = ingest_pass(&mut store, &opts, &mut skip, &mut stranded, &mut fsynced);
    assert_eq!(r.deleted, 0, "an unproven body is NEVER deleted");
    assert!(bodies.join("ghost.request.json").exists());
    assert!(r.failed.iter().any(|m| m.contains("ghost.request.json")), "and it is NAMED: {:?}", r.failed);
    assert!(!skip.contains("ghost.request.json"), "a non-ts failure drops the skip name so re-ingest can repair");
}

#[test]
fn stranded_names_relocate_off_the_spool_with_mtime_preserved() {
    let (bodies, store_dir) = fixture("stranded");
    let raw = body("s");
    write_body(&bodies, "s.request.json", &raw, 120_000);
    let dest = store_dir.join("legacy");
    let mut store = agentlens_store::open_store(&store_dir, "1GB", 4).expect("open");
    let opts = PassOptions {
        bodies_dir: bodies.clone(),
        relocate_stranded_to: Some(dest.clone()),
        ..Default::default()
    };
    let mut stranded: HashSet<String> = ["s.request.json".to_owned()].into();
    let (mut skip, mut fsynced) = (HashSet::new(), HashSet::new());
    let before = fs::metadata(bodies.join("s.request.json")).unwrap().modified().unwrap();
    let r = ingest_pass(&mut store, &opts, &mut skip, &mut stranded, &mut fsynced);
    assert_eq!(r.stranded_relocated, 1, "parked file moves to the durable dir: {:?}", r.failed);
    assert!(!bodies.join("s.request.json").exists(), "the spool copy is gone");
    let moved = dest.join("s.request.json");
    assert_eq!(fs::read_to_string(&moved).unwrap(), raw, "bytes survive the move exactly");
    let after = fs::metadata(&moved).unwrap().modified().unwrap();
    let d = after.duration_since(before).unwrap_or_else(|e| e.duration());
    assert!(d.as_millis() < 1500, "the mtime IS the capture record and must survive");
}

#[test]
fn pass_lock_is_exclusive_and_dies_with_its_holder() {
    // One pass per store, machine-wide: a second acquire on the SAME store must refuse while the
    // first is held (BSD flock is per-open-file, so two opens conflict even in one process), and
    // releasing the first (what the kernel does on ANY process death, SIGKILL included) must let
    // the next acquire through — no stale-lock state exists to repair.
    let dir = std::env::temp_dir().join(format!("al-passlock-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    let held = agentlens_store::pass::acquire_pass_lock(&dir).expect("first acquire owns the store");
    let refused = agentlens_store::pass::acquire_pass_lock(&dir);
    assert!(refused.is_err(), "a concurrent pass must be refused while the lock is held");
    drop(held);
    agentlens_store::pass::acquire_pass_lock(&dir).expect("released lock is immediately reusable");
}

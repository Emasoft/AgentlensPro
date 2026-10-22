//! TRDD-2HRA270Y step 3: the bodies store is opened ONCE per process by the bodies pass and kept.
//! Its own test binary, because the store and its open counter are process-wide statics: another
//! binary's tests on other data dirs would legitimately reopen it. Every test here takes SLOT, so
//! they run one at a time (the pass also skips its tick when the HEAVY slot is busy).

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use agentlens_core::chores::{
    bodies_pass, bodies_store_opens_for_test, bodies_store_reader, bodies_store_writer, clean_spill_dirs, clean_spill_dirs_periodic,
    poison_bodies_store_writer_for_test,
};
use agentlens_core::CoreState;

static SLOT: Mutex<()> = Mutex::new(());

struct Fixture {
    tmp: PathBuf,
    data_dir: PathBuf,
    state: Arc<Mutex<CoreState>>,
}

impl Fixture {
    fn new(tag: &str) -> Fixture {
        let tmp = std::env::temp_dir().join(format!("al-shared-store-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&tmp);
        let data_dir = tmp.join("data");
        std::fs::create_dir_all(data_dir.join("otel-bodies")).unwrap();
        let state = Arc::new(Mutex::new(CoreState::open(&data_dir)));
        Fixture { tmp, data_dir, state }
    }
    fn store_dir(&self) -> PathBuf {
        self.data_dir.join("store")
    }
    fn bodies(&self) -> PathBuf {
        self.data_dir.join("otel-bodies")
    }
    fn pass(&self) {
        bodies_pass(&self.state, agentlens_core::now_ms() as f64);
    }
    /// A fresh file (under the 10s age cutoff): the pass sees staged bytes, so it opens and syncs
    /// the store, but ingests nothing.
    fn open_without_ingesting(&self) {
        std::fs::write(self.bodies().join("ffff0000.request.json"), "{\"fresh\":true}").unwrap();
        self.pass();
        assert!(bodies_store_reader(&self.store_dir()).is_some(), "the bodies pass must open the shared store");
    }
    fn staged(&self) -> u64 {
        let w = bodies_store_writer(&self.store_dir()).expect("store open");
        let g = w.lock().unwrap();
        agentlens_store::staged_rows(&g).unwrap()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.tmp);
    }
}

fn body(tag: &str) -> String {
    format!("{{\"model\":\"claude-opus-5\",\"messages\":[{{\"role\":\"user\",\"content\":\"{}-{tag}\"}}]}}", "b".repeat(300))
}

fn age(p: &Path, secs: u64) {
    let t = std::time::SystemTime::now() - std::time::Duration::from_secs(secs);
    std::fs::OpenOptions::new().write(true).open(p).unwrap().set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
}

/// A second bodies pass reuses the store the first one opened. MUTATION CHECK: drop the
/// same-dir early return in open_shared_bodies_writer and the second pass opens it again.
#[test]
fn a_second_pass_does_not_reopen_the_store() {
    let _s = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new("reuse");
    let before = bodies_store_opens_for_test();
    f.open_without_ingesting();
    assert_eq!(bodies_store_opens_for_test(), before + 1, "the first busy pass opens the store");
    f.pass();
    assert_eq!(bodies_store_opens_for_test(), before + 1, "the second pass must reuse it");
}

/// A pass for a different data dir drops the open store and opens its own. MUTATION CHECK: ignore
/// the store_dir comparison in open_shared_bodies_writer and B is served A's store.
#[test]
fn a_different_data_dir_forces_a_reopen() {
    let _s = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    let a = Fixture::new("dir-a");
    let b = Fixture::new("dir-b");
    let before = bodies_store_opens_for_test();
    a.open_without_ingesting();
    b.open_without_ingesting();
    assert_eq!(bodies_store_opens_for_test(), before + 2);
    assert!(bodies_store_reader(&a.store_dir()).is_none(), "A's store must be dropped");
    assert!(bodies_store_reader(&b.store_dir()).is_some());
}

/// A poisoned writer mutex drops the shared store; the next pass reopens it. MUTATION CHECK: make
/// the poison arm in bodies_pass return without drop_poisoned_bodies_store and the store stays.
#[test]
fn a_poisoned_writer_is_dropped_and_reopened() {
    let _s = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new("poison");
    f.open_without_ingesting();
    poison_bodies_store_writer_for_test(&f.store_dir());
    let before = bodies_store_opens_for_test();
    f.pass();
    assert!(bodies_store_writer(&f.store_dir()).is_none(), "a poisoned writer must drop the shared store");
    f.pass();
    assert_eq!(bodies_store_opens_for_test(), before + 1, "the next pass reopens it");
    assert!(bodies_store_writer(&f.store_dir()).unwrap().lock().is_ok(), "the reopened writer is healthy");
}

/// Periodic spill cleanup skips store/tmp while the store is open; boot cleanup still empties it.
/// MUTATION CHECK: pass an empty skip list in clean_spill_dirs_periodic and the store file goes.
#[test]
fn periodic_spill_cleanup_skips_store_tmp_while_open() {
    let _s = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new("spill");
    f.open_without_ingesting();
    let store_spill = f.store_dir().join("tmp").join("old-store.block");
    let other_dir = f.data_dir.join("statusline").join("tmp");
    std::fs::create_dir_all(&other_dir).unwrap();
    let other_spill = other_dir.join("old-statusline.block");
    for p in [&store_spill, &other_spill] {
        std::fs::write(p, b"x").unwrap();
        age(p, 2 * 3600);
    }
    clean_spill_dirs_periodic(&f.data_dir);
    assert!(store_spill.exists(), "store/tmp must be skipped while the long-lived store is open");
    assert!(!other_spill.exists(), "the other spill dirs keep the age sweep");
    clean_spill_dirs(&f.data_dir, None);
    assert!(!store_spill.exists(), "boot cleanup still empties store/tmp");
}

/// The purge delete gate never proves a volume from staged, unflushed rows: with the July lumps
/// staged (not flushed) in the shared store, purge refuses and the volume stays. MUTATION CHECK:
/// drop the staged_rows refusal in bodies_purge and the volume is deleted on RAM-only proof.
#[test]
fn purge_refuses_while_rows_are_staged() {
    let _s = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new("purge");
    f.open_without_ingesting();
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bodyarchive-tree/otel-bodies-archive");
    let arch = f.data_dir.join("otel-bodies-archive");
    std::fs::create_dir_all(&arch).unwrap();
    for name in ["bodies-2026-07.wad", "bodies-2026-07.wad.idx"] {
        std::fs::copy(src.join(name), arch.join(name)).unwrap();
    }
    {
        let w = bodies_store_writer(&f.store_dir()).unwrap();
        let mut store = w.lock().unwrap();
        for e in agentlens_core::body_archive::list_archive_entries(&arch) {
            let raw = String::from_utf8_lossy(&agentlens_core::body_archive::read_archive_entry(&e).unwrap()).into_owned();
            agentlens_store::ingest_body(&mut store, &e.name, &raw, e.mtime_ms as i64).unwrap();
        }
    }
    assert!(f.staged() > 0, "premise: the lumps are staged, not flushed");
    let (status, v) = agentlens_core::body_archive::bodies_purge(&f.data_dir);
    assert_eq!(status, 409, "{v}");
    assert!(arch.join("bodies-2026-07.wad").exists(), "a volume proven only by staged rows must stay");

    // A pass running (writer held) is a 409 too, never a wait.
    let w = bodies_store_writer(&f.store_dir()).unwrap();
    let _held = w.lock().unwrap();
    let (status, v) = agentlens_core::body_archive::bodies_purge(&f.data_dir);
    assert_eq!(status, 409, "{v}");
}

/// Staging a failed flush left is cleared at the next tick when the flush fails again, never
/// carried; once the store is writable the source re-ingests and is deleted within a few ticks.
/// MUTATION CHECK: remove the flush_or_clear_leftovers call in bodies_pass and staging is still
/// non-empty after the second tick.
#[test]
fn a_failed_flush_is_cleared_at_the_next_tick_and_the_source_converges() {
    let _s = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new("failed-flush");
    let name = "aaaaaaaa-bbbb-cccc-dddd-ffffffffffff.request.json";
    let src = f.bodies().join(name);
    std::fs::write(&src, body("ff")).unwrap();
    age(&src, 15);
    let blobs = f.store_dir().join("blobs");
    std::fs::create_dir_all(&blobs).unwrap();
    std::fs::set_permissions(&blobs, std::fs::Permissions::from_mode(0o555)).unwrap();

    f.pass();
    assert!(src.exists(), "a failed flush deletes nothing");
    assert!(f.staged() > 0, "premise: the failed flush left staging behind");
    f.pass();
    let staged_after_second = f.staged();
    std::fs::set_permissions(&blobs, std::fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(staged_after_second, 0, "staging must not be carried into a second tick");

    for _ in 0..4 {
        if !src.exists() {
            break;
        }
        f.pass();
    }
    assert!(!src.exists(), "the source must re-ingest, verify and be deleted within a few ticks");
    assert_eq!(f.staged(), 0);
}

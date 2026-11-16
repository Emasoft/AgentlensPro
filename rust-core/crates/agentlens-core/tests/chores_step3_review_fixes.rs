//! TRDD-2HRA270Y step 3 review fixes (F1, F2, F3, F5). Their own test binary, because the shared store and
//! its counters are process-wide statics. Every test takes SLOT, so they run one at a time.

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use agentlens_core::body_archive::bodies_export;
use agentlens_core::chores::{
    bodies_pass, bodies_store_opens_for_test, bodies_store_reader, bodies_store_writer, poison_bodies_store_writer_for_test,
};
use agentlens_core::CoreState;

const TS: i64 = 1_787_000_000_000;

static SLOT: Mutex<()> = Mutex::new(());

struct Fixture {
    tmp: PathBuf,
    data_dir: PathBuf,
    state: Arc<Mutex<CoreState>>,
}

impl Fixture {
    fn new(tag: &str) -> Fixture {
        let tmp = std::env::temp_dir().join(format!("al-step3-fixes-{}-{tag}", std::process::id()));
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
    /// Opens the shared store through a pass: a fresh file (under the 10s age cutoff) is staged, so the
    /// pass opens the store but ingests nothing. The file is removed again so the dir is idle afterwards.
    fn open_store_idle_afterwards(&self) {
        let fresh = self.bodies().join("ffff0000.request.json");
        std::fs::write(&fresh, "{\"fresh\":true}").unwrap();
        self.pass();
        std::fs::remove_file(&fresh).unwrap();
        assert!(bodies_store_reader(&self.store_dir()).is_some(), "the bodies pass must open the shared store");
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

/// F1: export opens the shared store itself. A data dir whose bodies pass never ran (an idle server) still
/// exports the store half, and nothing answers "not open". MUTATION CHECK: make bodies_store_open_or_get
/// return Ok(None) while the slot is empty and this test answers 503 instead of 200.
#[test]
fn export_opens_the_store_on_an_idle_server() {
    let _s = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new("export-idle");
    let raw = body("export");
    {
        let mut other = agentlens_store::open_store(&f.store_dir(), agentlens_store::STORE_MEMORY_LIMIT, 1).expect("open");
        agentlens_store::ingest_body(&mut other, "export.request.json", &raw, TS).expect("ingest");
        agentlens_store::flush_detailed(&mut other).expect("flush");
    }
    assert!(bodies_store_reader(&f.store_dir()).is_none(), "premise: no bodies pass has opened the store");

    let dest = f.tmp.join("out");
    let request = format!("{{\"destDir\":\"{}\"}}", dest.display());
    let (status, v) = bodies_export(&f.data_dir, request.as_bytes());
    assert_eq!(status, 200, "{v}");
    assert_eq!(v["fromStore"], 1, "the store half must find the body: {v}");
    assert!(dest.join("export.request.json").exists(), "the body is written to destDir");
}

/// F2: a pass never waits for the writer. A purge holding the writer makes the pass return at once, the
/// staged body stays on disk, and the first pass after the writer is released ingests it. MUTATION CHECK:
/// put writer.lock() back in bodies_pass and the pass blocks, so the recv_timeout below fails.
#[test]
fn a_pass_skips_its_tick_while_the_writer_is_held() {
    let _s = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new("busy");
    f.open_store_idle_afterwards();
    let staged = f.bodies().join("cccc0000.request.json");
    std::fs::write(&staged, body("busy")).unwrap();
    age(&staged, 15);

    let writer = bodies_store_writer(&f.store_dir()).expect("open");
    let held = writer.lock().unwrap();
    let (state, now) = (f.state.clone(), agentlens_core::now_ms() as f64);
    let (done_tx, done_rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        bodies_pass(&state, now);
        let _ = done_tx.send(());
    });
    done_rx.recv_timeout(Duration::from_secs(20)).expect("the pass must return while the writer is held, not block on it");
    assert!(staged.exists(), "a skipped tick deletes nothing");
    drop(held);

    for _ in 0..4 {
        if !staged.exists() {
            break;
        }
        f.pass();
    }
    assert!(!staged.exists(), "once the writer is free the next ticks ingest and delete the staged body");
}

/// F3: a store whose poisoned writer is still held is not replaced by a second instance. The reopen waits
/// until the held clone is gone. MUTATION CHECK: drop the RETIRED_STORE check in open_shared_bodies_writer
/// and the open counter moves while the clone is still held.
#[test]
fn a_released_store_that_is_still_held_blocks_the_reopen() {
    let _s = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new("retired");
    f.open_store_idle_afterwards();
    // Taken before the poison: after the poison the slot no longer hands out the writer.
    let held = bodies_store_writer(&f.store_dir()).expect("open");
    poison_bodies_store_writer_for_test(&f.store_dir());
    let fresh = f.bodies().join("dddd0000.request.json");
    std::fs::write(&fresh, "{\"fresh\":true}").unwrap();
    f.pass();
    assert!(bodies_store_writer(&f.store_dir()).is_none(), "the poisoned store is released");

    let before = bodies_store_opens_for_test();
    f.pass();
    assert_eq!(bodies_store_opens_for_test(), before, "no second store while the released one is still held");
    assert!(bodies_store_writer(&f.store_dir()).is_none());

    drop(held);
    f.pass();
    assert_eq!(bodies_store_opens_for_test(), before + 1, "once the clone is gone the store reopens");
}

/// F5: an idle tick refreshes a store that is already open. A part another writer adds is in known_blob
/// after the idle tick, read through the reader. MUTATION CHECK: remove the sync_open_store_idle call from
/// the idle branch of bodies_pass and known_blob does not grow.
#[test]
fn an_idle_tick_syncs_an_open_store() {
    let _s = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    let f = Fixture::new("idle-sync");
    f.open_store_idle_afterwards();
    let opens_before = bodies_store_opens_for_test();
    let known_blobs = |f: &Fixture| -> i64 {
        let reader = bodies_store_reader(&f.store_dir()).expect("open");
        let guard = reader.lock().unwrap();
        guard.as_store().con.query_row("SELECT count(*) FROM known_blob", [], |r| r.get(0)).expect("count")
    };
    assert_eq!(known_blobs(&f), 0, "premise: the store was opened over an empty parts dir");

    let raw = body("idle");
    let added = {
        let mut other = agentlens_store::open_store(&f.store_dir(), agentlens_store::STORE_MEMORY_LIMIT, 1).expect("open");
        let ingested = agentlens_store::ingest_body(&mut other, "idle.request.json", &raw, TS).expect("ingest");
        agentlens_store::flush_detailed(&mut other).expect("flush");
        ingested.new_blobs
    };
    assert!(added > 0, "premise: the other writer flushed blobs");

    f.pass();
    assert_eq!(known_blobs(&f), added as i64, "the idle tick must register the other writer blob part");
    assert_eq!(bodies_store_opens_for_test(), opens_before, "an idle tick refreshes the store and never opens it");
}

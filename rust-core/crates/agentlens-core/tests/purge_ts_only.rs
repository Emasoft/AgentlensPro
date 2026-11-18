//! TRDD-7NHUU6GK: the purge route deletes a volume whose lumps are proven bit-exact in the store but whose
//! stored capture ts moved (a re-emitted body), and keeps any volume holding a byte-unproven lump. Its own
//! test binary: the bodies store is a process-wide static, so every test takes SLOT and runs alone.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use agentlens_core::body_archive::{bodies_purge, list_archive_entries, read_archive_entry, verify_volume_in_store, VolumeVerifyResult};

static SLOT: Mutex<()> = Mutex::new(());

/// What the store is told about one lump of the fixture volume: a lump name plus how to ingest it.
enum Ingest {
    /// Same bytes, capture ts shifted by this many ms from the idx mtime (the ts-only failure when beyond tolerance).
    Shifted(i64),
    /// Other bytes under the same name: the lump bytes are NOT in the store.
    OtherBytes,
}

struct Fixture {
    tmp: PathBuf,
    data_dir: PathBuf,
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.tmp);
    }
}

impl Fixture {
    fn arch(&self) -> PathBuf {
        self.data_dir.join("otel-bodies-archive")
    }
}

/// Copy one fixture volume into a fresh data dir, open the bodies store the way the purge route does, ingest
/// the named lumps as told, and flush so the proof reads durable parquet (a purge refuses staged rows).
fn fixture(tag: &str, volume: &str, ingest: &[(&str, Ingest)]) -> Fixture {
    let tmp = std::env::temp_dir().join(format!("al-purge-ts-only-{}-{tag}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    let data_dir = tmp.join("data");
    let f = Fixture { tmp, data_dir };
    std::fs::create_dir_all(f.arch()).unwrap();
    let src = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bodyarchive-tree/otel-bodies-archive");
    for name in [volume.to_owned(), format!("{volume}.idx")] {
        std::fs::copy(src.join(&name), f.arch().join(&name)).unwrap();
    }
    let handles = agentlens_core::chores::bodies_store_open_or_get(&f.data_dir.join("store")).unwrap().expect("store opens");
    {
        let mut store = handles.writer.lock().unwrap();
        for e in list_archive_entries(&f.arch()) {
            let Some((_, how)) = ingest.iter().find(|(n, _)| *n == e.name) else { continue };
            let raw = String::from_utf8_lossy(&read_archive_entry(&e).unwrap()).into_owned();
            let (raw, ts) = match how {
                Ingest::Shifted(d) => (raw, e.mtime_ms as i64 + d),
                Ingest::OtherBytes => (format!("{{\"other\":\"{}\"}}", e.name), e.mtime_ms as i64),
            };
            agentlens_store::ingest_body(&mut store, &e.name, &raw, ts).unwrap();
        }
        agentlens_store::flush_detailed(&mut store).unwrap();
        assert_eq!(agentlens_store::staged_rows(&store).unwrap(), 0, "premise: nothing staged");
    }
    f
}

fn verify(f: &Fixture, volume: &str) -> agentlens_core::body_archive::VolumeVerifyResult {
    let handles = agentlens_core::chores::bodies_store_open_or_get(&f.data_dir.join("store")).unwrap().expect("store open");
    let store = handles.writer.lock().unwrap();
    verify_volume_in_store(&store, &f.arch(), volume)
}

/// A lump in the store bit-exact with a different stored ts is purgeable (ok false, ts_only 1) and the route deletes the volume, keeping the .idx.
#[test]
fn ts_only_volume_is_purgeable_and_the_route_removes_it() {
    let _s = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    let f = fixture("a", "bodies-2026-08.wad", &[("cccc3333.request.json", Ingest::Shifted(60_000))]);
    let proof = verify(&f, "bodies-2026-08.wad");
    assert!(!proof.ok, "premise: the strict gate still fails on the ts");
    assert_eq!(proof.ts_only, 1);
    assert!(proof.purgeable());
    let (status, v) = bodies_purge(&f.data_dir);
    assert_eq!(status, 200, "{v}");
    assert_eq!(v["removed"], serde_json::json!(["bodies-2026-08.wad"]), "{v}");
    assert!(!f.arch().join("bodies-2026-08.wad").exists(), "the volume file is gone");
    assert!(f.arch().join("bodies-2026-08.wad.idx").exists(), "the .idx sidecar stays");
}

/// A volume whose lump bytes are NOT in the store is not purgeable, whatever the ts.
#[test]
fn byte_unproven_volume_is_not_purgeable() {
    let _s = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    let f = fixture("b", "bodies-2026-08.wad", &[("cccc3333.request.json", Ingest::OtherBytes)]);
    let proof = verify(&f, "bodies-2026-08.wad");
    assert!(!proof.ok);
    assert_eq!(proof.ts_only, 0);
    assert!(!proof.purgeable());
}

/// A volume with one ts-only lump and one byte-unproven lump is not purgeable.
#[test]
fn ts_only_plus_byte_unproven_lump_is_not_purgeable() {
    let _s = SLOT.lock().unwrap_or_else(|e| e.into_inner());
    let f = fixture(
        "c",
        "bodies-2026-07.wad",
        &[("aaaa1111.request.json", Ingest::Shifted(60_000)), ("bbbb2222.response.json", Ingest::OtherBytes)],
    );
    let proof = verify(&f, "bodies-2026-07.wad");
    assert!(!proof.ok);
    assert_eq!(proof.ts_only, 1, "{:?}", proof.failed);
    assert_eq!(proof.failed.len(), 2, "{:?}", proof.failed);
    assert!(!proof.purgeable());
}

/// Each clause of the purge rule is needed. These verdicts are built by hand, so no clause can hide behind another
/// (the fixture tests above cannot show that: on real volumes the two equalities fail together).
#[test]
fn purgeable_needs_every_clause() {
    let v = |entries: u64, verified: u64, failed: usize, ts_only: u64| VolumeVerifyResult {
        ok: false,
        entries,
        verified,
        failed: vec!["x".to_string(); failed],
        ts_only,
    };
    // Every failure is ts-only and every lump is counted once: purgeable.
    assert!(v(2, 1, 1, 1).purgeable());
    // A second failure that is not ts-only: `failed.len() == ts_only` refuses it (the counts still add up).
    assert!(!v(2, 1, 2, 1).purgeable());
    // A lump in neither count: `verified + ts_only == entries` refuses it (every recorded failure is ts-only).
    assert!(!v(3, 1, 1, 1).purgeable());
    // No ts-only failure at all: `ts_only > 0` refuses it (both equalities hold at zero).
    assert!(!v(0, 0, 0, 0).purgeable());
    // A fully proven volume needs none of the above.
    assert!(VolumeVerifyResult { ok: true, entries: 2, verified: 2, failed: Vec::new(), ts_only: 0 }.purgeable());
}

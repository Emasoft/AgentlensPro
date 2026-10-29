//! The ingest pass — port of `src/store/ingestPass.ts` (TRDD-DMWOBWFH P3c).
//!
//! THIS DELETES THE USER'S FILES, so the ordering IS the contract and must not be "simplified":
//!   1. ingest  — GATE 1 already refuses anything that does not reconstruct byte-identically.
//!   2. FLUSH   — the spans reach an immutable Parquet part. durableSource additionally fsyncs
//!      every part file + the part dirs BEFORE any delete (the page-cache hole).
//!   3. verify  — reconstruct FROM THE FLUSHED STORE and compare against the file's own bytes,
//!      plus the (src_name, ts) row — metadata is data too.
//!   4. delete  — and only now.
//!
//! A crash loses at most the un-flushed batch; sources are still there. It is also THROTTLED
//! (512MB/pass default): the archiver this replaced burned 694 MB/min of device writes on boot.
//!
//! Stranded parking is LEGACY (TRDD-6SPXOV0P option A). It was the livelock fix: a durable-named
//! file failing ONLY on capture-ts could never be repaired by re-ingest (dedup never updates
//! ts), so it was parked (zero I/O next pass). That failure is now recognised at the gate as a
//! benign re-emit and RECLAIMED, so nothing parks any more; a stranded name still persisted in
//! `.pass-state.json` from before is routed back through the gate and forgotten (see the loop),
//! unless the operator asked to RELOCATE parked files off a volatile spool
//! (`relocate_stranded_to`: verify-before-unlink, mtime preserved — the mtime IS the capture
//! record — with a 3-strike per-pass breaker on relocation failures), which still wins. Only the
//! `alstore` CLI ever sets that option; the server's chore never does, so on a server every
//! legacy stranded name drains.

use std::collections::HashSet;
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use crate::{flush_detailed, ingest_body_with, Store, VerifyItemRef, API_CALLS_DIR, BLOBS_DIR, BODIES_DIR, PARTS_DIR};

pub const DEFAULT_MAX_BYTES_PER_PASS: u64 = 512 * 1024 * 1024;
pub const DEFAULT_BATCH: usize = 200;
/// Settle-group ceiling in SOURCE bytes: bounds peak memory (raw + rebuilt strings ≈ 2× this)
/// while keeping the corpus-priced verify queries to a handful per batch.
pub const SETTLE_GROUP_BYTES: u64 = 128 * 1024 * 1024;

/// Why a pass could not take the store's lock: Busy is the benign skip-this-tick case; Io is a
/// real failure that must stay LOUD (conflating them made a fresh store dir look "busy").
#[derive(Debug)]
pub enum PassLockErr {
    Busy,
    Io(String),
}

/// EXACTLY ONE pass per store dir, machine-wide. The in-process `bodiesPassRunning` guard the
/// TS server uses cannot span processes, and the exec-sidecar model creates real multi-process
/// exposure: a SIGKILLed server (the loop watchdog kills with SIGKILL) leaves its pass child
/// running as an orphan while the respawned server starts its own — observed live 2026-08-18,
/// two concurrent passes on one store. flock is the correct primitive: the kernel releases it
/// on ANY process death, so there is no stale-lock state to repair. Hold the returned File for
/// the whole pass; Busy means another pass owns the store RIGHT NOW (a benign skip-this-tick,
/// not a broken deployment).
pub fn acquire_pass_lock(store_dir: &Path) -> Result<fs::File, PassLockErr> {
    use fs2::FileExt;
    // The lock is taken BEFORE open_store (so a locked-out tick never pays the open), which
    // means on a brand-new store THIS is the first touch — create the dir or a fresh store
    // would report its own absence as "busy".
    fs::create_dir_all(store_dir).map_err(|e| PassLockErr::Io(format!("cannot create store dir: {e}")))?;
    let f = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .open(store_dir.join(".pass.lock"))
        .map_err(|e| PassLockErr::Io(format!("cannot open pass lock: {e}")))?;
    f.try_lock_exclusive().map_err(|_| PassLockErr::Busy)?;
    Ok(f)
}

/// The pass's cross-invocation memory: names already proven stored (`skipNames`) and names whose
/// body could not be reconstructed (`strandedNames`). It lives in a FILE because a pass is not
/// always a long-lived process — the `alstore pass` CLI is one pass per process, so without this
/// every invocation would re-examine the entire corpus.
///
/// MUST be read and written INSIDE the pass lock. `acquire_pass_lock` serializes whole passes, so
/// load → ingest → save is atomic with respect to another engine; hold the lock only around the
/// ingest and two engines can interleave a load and a save, silently dropping skip/stranded names.
/// A dropped skip name means a body is re-examined forever; a dropped stranded name means a body
/// that could NOT be reconstructed is forgotten, which is the one that loses data.
///
/// A missing file is EMPTY, not an error: it is the true first-run state. A file that is present but cannot
/// be read, or whose bytes are not valid JSON, is an Err (TRDD-FINMFYDE). Loading that file as empty made
/// `unpark_names` save empty sets over it and destroy every persisted skip and stranded name. So "corrupt"
/// means exactly those two things. Valid JSON with a missing key, a non-array value or non-string entries is
/// NOT corrupt and still reads as empty, as it always did; a top-level value that is not an object (`[]`, `42`)
/// is valid JSON and reads the same way. Callers must not write over an Err. The alstore CLI exits 4 and
/// leaves the file in place, because a person runs it and decides; alcore's bodies pass moves the file aside
/// to `<name>.corrupt-<unix_ms>` and rebuilds the state from empty sets (chores.rs).
pub fn load_pass_state(p: &Path) -> std::io::Result<(HashSet<String>, HashSet<String>)> {
    let raw = match fs::read_to_string(p) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok((Default::default(), Default::default())),
        Err(e) => return Err(std::io::Error::new(e.kind(), format!("{}: {e}", p.display()))),
    };
    let v: serde_json::Value = serde_json::from_str(&raw).map_err(|e| {
        std::io::Error::new(std::io::ErrorKind::InvalidData, format!("{}: not valid JSON: {e}", p.display()))
    })?;
    let set = |k: &str| {
        v.get(k)
            .and_then(|a| a.as_array())
            .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect())
            .unwrap_or_default()
    };
    Ok((set("skipNames"), set("strandedNames")))
}

/// Write the pass state. Sorted so the file is diffable and its content is a function of the SET,
/// not of HashSet iteration order — otherwise every pass rewrites a byte-different file. Temp +
/// rename so a crash mid-write cannot leave a truncated state under the real name.
pub fn save_pass_state(p: &Path, skip: &HashSet<String>, stranded: &HashSet<String>) -> std::io::Result<()> {
    let mut skip_v: Vec<&String> = skip.iter().collect();
    let mut str_v: Vec<&String> = stranded.iter().collect();
    skip_v.sort();
    str_v.sort();
    let json = serde_json::json!({ "skipNames": skip_v, "strandedNames": str_v });
    let tmp = p.with_extension("json.tmp");
    // WHY a Result (TRDD-ZR3OGSAV): the old `if write.is_ok() { let _ = rename }` swallowed a full
    // disk / permission error, so a lost stranded or skip name vanished without a trace. Every
    // failure is now returned for the caller to surface; the temp+rename atomicity is kept.
    // WHY sync_all (TRDD-FINMFYDE): without it the rename can reach the disk before the data does, so a
    // power cut leaves a zero-byte state under the real name. A zero-byte file is an Err for the CLI (exit 4)
    // and a move-aside for alcore, so a save must not produce one. The directory sync after the rename makes
    // the rename itself durable; its failure is returned like any other.
    {
        let mut file = fs::File::create(&tmp)?;
        file.write_all(json.to_string().as_bytes())?;
        file.sync_all()?;
    }
    if let Err(e) = fs::rename(&tmp, p) {
        // A rename that failed leaves the temp file behind; remove it so it does not linger. Its own
        // removal error is irrelevant: the rename error is the one to report.
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    let dir = p.parent().filter(|d| !d.as_os_str().is_empty()).unwrap_or_else(|| Path::new("."));
    fs::File::open(dir)?.sync_all()?;
    Ok(())
}

/// The state file's name inside a store dir. ONE definition — the CLI and alcore must not each
/// spell it, or they would keep separate state for the same store.
pub const PASS_STATE_FILE: &str = ".pass-state.json";

pub struct PassOptions {
    pub bodies_dir: PathBuf,
    pub max_age_ms: i64,
    pub max_bytes_per_pass: u64,
    pub delete_after: bool,
    pub batch_size: usize,
    pub durable_source: bool,
    pub relocate_stranded_to: Option<PathBuf>,
}

impl Default for PassOptions {
    fn default() -> Self {
        PassOptions {
            bodies_dir: PathBuf::new(),
            max_age_ms: 0,
            max_bytes_per_pass: DEFAULT_MAX_BYTES_PER_PASS,
            delete_after: true,
            batch_size: DEFAULT_BATCH,
            durable_source: false,
            relocate_stranded_to: None,
        }
    }
}

#[derive(Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PassResult {
    pub ingested: u64,
    pub deleted: u64,
    pub bytes_in: u64,
    pub bytes_stored: u64,
    pub reclaimed_durable: u64,
    /// TRDD-6SPXOV0P option A: a durable body whose ONLY verify failure was `stored ts !=
    /// capture time` — a re-emit of the same bytes under a fresh mtime, not a corruption (see
    /// the reclaim comment below). Counted separately from `reclaimed_durable` so a pass report
    /// can say "N re-emitted bodies reclaimed" instead of collapsing it into the ordinary path.
    pub reclaimed_reemitted: u64,
    /// A delete ABORTED because the file on disk was not the bytes this pass verified — a
    /// re-emission landed between the verify and the delete. Counted SEPARATELY from `failed`,
    /// because a caught re-emission is the guard WORKING, while a `failed` entry is a genuine
    /// problem (a store error, an fsync failure, an unreadable file). Collapsing the two would
    /// make a pass that correctly refused to lose data indistinguishable from a broken pass.
    pub delete_aborted_reemission: u64,
    pub bytes_freed: u64,
    pub failed: Vec<String>,
    pub stranded_ts: Vec<String>,
    pub stranded_relocated: u64,
    pub throttled: bool,
}

struct BodyFile {
    p: PathBuf,
    name: String,
    mtime_ms: i64,
    size: u64,
}

/// One listing of a bodies dir. `files` are the body files readable this pass. `names` are EVERY body name
/// present as a directory entry, including the ones that cannot be statted: a name that exists stays
/// present for the prune even when it cannot be ingested. `unstatable` holds those names with their stat
/// error. `unreadable_entries` are directory entries that could not be read at all (no name), so a file
/// may be missing from the listing entirely.
struct Listing {
    files: Vec<BodyFile>,
    names: Vec<String>,
    unstatable: Vec<(String, String)>,
    unreadable_entries: Vec<String>,
}

/// List the body files in `dir`. Err only when the directory itself cannot be read.
fn body_files(dir: &Path) -> std::io::Result<Listing> {
    let mut out = Vec::new();
    let mut names = Vec::new();
    let mut unstatable = Vec::new();
    let mut unreadable_entries = Vec::new();
    for entry in fs::read_dir(dir)? {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                unreadable_entries.push(e.to_string());
                continue;
            }
        };
        let name = entry.file_name();
        let Some(name) = name.to_str().map(str::to_owned) else { continue };
        if !name.ends_with(".request.json") && !name.ends_with(".response.json") {
            continue;
        }
        names.push(name.clone());
        let p = entry.path();
        let st = match fs::metadata(&p) {
            Ok(st) => st,
            // Gone between the listing and the stat: not on the spool any more, nothing to ingest.
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => {
                unstatable.push((name, e.to_string()));
                continue;
            }
        };
        let mtime_ms = st
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        out.push(BodyFile { p, name, mtime_ms, size: st.len() });
    }
    out.sort_by_key(|f| f.mtime_ms); // OLDEST FIRST — the true turn order, which is what dedups
    Ok(Listing { files: out, names, unstatable, unreadable_entries })
}

/// The outcome of the content gate on one file.
enum ContentGate {
    /// The file still holds exactly the bytes this pass verified — the delete may proceed.
    Unchanged,
    /// The file holds DIFFERENT bytes: a re-emission landed between the verify and the delete.
    /// The delete must be aborted and the new bytes must stay on disk.
    Reemitted(String),
    /// The file could not be read. The delete must be aborted too — a file we cannot read is
    /// not a file we can prove — but this is a DIFFERENT event from a re-emission and must not
    /// be counted as one.
    Unreadable(String),
}

/// Compare a body file's CURRENT bytes against the bytes this pass VERIFIED.
///
/// WHY content and not metadata: the corpus is live and a body can be re-emitted under the same
/// path with new bytes between the verify and the delete. That re-emission can preserve BOTH the
/// size and the mtime (a `mv` back, a `cp -p`), so a size/mtime comparison CANNOT see the change
/// — the metadata guard was bypassable exactly that way.
///
/// WHY a BYTE COMPARISON and not a digest comparison: the pass already HOLDS the verified bytes
/// in memory — `verified` is the exact `String` the verify was performed on, and it is the exact
/// bytes the store ingested. Comparing the file against it needs no digest of the expected side,
/// so it cannot drift from what was verified (a hex-rendering change, a truncation, a different
/// hashing of the stored form — none of them apply to a plain byte equality), and it needs no
/// second implementation of "lowercase hex" that could disagree with the store's own.
///
/// The file is read in 1 MiB chunks and compared against the in-memory bytes as it goes: the file
/// is never held in memory a second time (the corpus is tens of GB and the pass already holds the
/// verified `raw` in full). A read failure is an ABORT, never a delete — a file we cannot read is
/// not a file we can prove.
///
/// WHY `verified.as_bytes()` IS THE FILE'S BYTES: `verified` came from `fs::read_to_string`, which
/// VALIDATES UTF-8 and copies every byte — it does not strip a BOM and does not normalise
/// newlines. So for every body that reaches this gate the in-memory string IS the file's byte
/// sequence, and the comparison is byte-for-byte. A body that is NOT valid UTF-8 never reaches
/// this gate at all: `read_to_string` fails on it, and the pass skips it (it is never ingested and
/// never deleted), so the gate's guarantee covers exactly the bodies the store can hold.
///
/// WHY THE EXPECTED SIDE IS THE PASS'S OWN MEMORY AND NOT THE STORE'S KEY: both are the same
/// value. The store indexes bodies by `body_id_of(raw)` = `sha256_hex(raw)` (lib.rs:335), and the
/// VERIFY that runs immediately before this gate already proves the store's copy against that
/// same `raw` — it reconstructs the body from the store's parts and compares
/// `sha256_hex(rebuilt) != sha256_hex(&it.raw)` (lib.rs:800), and it JOINS the store's rows on
/// `body_id_of(raw)`. So by the time a delete is considered, the chain is already proven:
/// the store reconstructs to this `raw`, and this gate proves the file still IS this `raw`. The
/// gate does not need to re-derive a digest of the expected side to close that chain — it needs
/// to answer one question the chain has not answered: has the FILE changed since the `raw` was
/// read? Only the file's current bytes can answer that.
fn content_unchanged_since_read(p: &Path, verified: &str) -> ContentGate {
    let name = p
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| p.to_string_lossy().into_owned());
    let expected = verified.as_bytes();
    let mut f = match fs::File::open(p) {
        Ok(f) => f,
        Err(e) => return ContentGate::Unreadable(format!("{name}: re-read before delete failed — kept ({e})")),
    };
    let mut buf = vec![0u8; 1024 * 1024];
    let mut offset = 0usize;
    loop {
        let n = match f.read(&mut buf) {
            Ok(n) => n,
            Err(e) => return ContentGate::Unreadable(format!("{name}: re-read before delete failed — kept ({e})")),
        };
        if n == 0 {
            break;
        }
        let end = offset + n;
        if end > expected.len() || buf[..n] != expected[offset..end] {
            return ContentGate::Reemitted(format!(
                "{name}: delete ABORTED — content changed since the verify (the file on disk is not the bytes the store proved it can reproduce); the store holds the older bytes, the new bytes stay on disk"
            ));
        }
        offset = end;
    }
    if offset != expected.len() {
        return ContentGate::Reemitted(format!(
            "{name}: delete ABORTED — content changed since the verify (the file on disk is {offset} bytes, the verified bytes are {}); the store holds the older bytes, the new bytes stay on disk",
            expected.len()
        ));
    }
    ContentGate::Unchanged
}
fn fsync_path(p: &Path) -> std::io::Result<()> {
    let f = fs::File::open(p)?;
    match f.sync_all() {
        Ok(()) => Ok(()),
        // Directory fsync is a POSIX nicety some platforms refuse — swallow for dirs ONLY;
        // a failed FILE fsync must propagate (an unlink gated on a silent fsync failure is the
        // page-cache hole reopened).
        Err(e) => {
            if fs::metadata(p).map(|m| m.is_dir()).unwrap_or(false) {
                Ok(())
            } else {
                Err(e)
            }
        }
    }
}

/// TS `relocateStrandedFile`: verify-before-unlink, mtime preserved (the capture record).
fn relocate_stranded_file(f: &BodyFile, dest_dir: &Path) -> Result<(), String> {
    let dst = dest_dir.join(&f.name);
    let raw = fs::read(&f.p).map_err(|e| e.to_string())?;
    if dst.exists() {
        let existing = fs::read(&dst).map_err(|e| e.to_string())?;
        if existing != raw {
            return Err("destination exists with different bytes".into());
        }
    } else {
        fs::create_dir_all(dest_dir).map_err(|e| e.to_string())?;
        let tmp = dest_dir.join(format!("{}.reloc.tmp", f.name));
        fs::write(&tmp, &raw).map_err(|e| e.to_string())?;
        set_mtime_ms(&tmp, f.mtime_ms).map_err(|e| e.to_string())?;
        fs::rename(&tmp, &dst).map_err(|e| e.to_string())?;
        let back = fs::read(&dst).map_err(|e| e.to_string())?;
        if back != raw {
            let _ = fs::remove_file(&dst);
            return Err("destination verify mismatch after copy".into());
        }
        fsync_path(&dst).map_err(|e| e.to_string())?;
    }
    fs::remove_file(&f.p).map_err(|e| e.to_string())
}

/// mtime via utimensat-style std API (stable since 1.75: File::set_times).
fn set_mtime_ms(p: &Path, mtime_ms: i64) -> std::io::Result<()> {
    let t = std::time::UNIX_EPOCH + std::time::Duration::from_millis(mtime_ms.max(0) as u64);
    let f = fs::OpenOptions::new().write(true).open(p)?;
    f.set_times(fs::FileTimes::new().set_modified(t))
}

struct BatchItem {
    p: PathBuf,
    name: String,
    mtime_ms: i64,
    size: u64,
    durable: bool,
}

/// Run one ingest pass. `skip_names`/`stranded_names` persist across passes (the caller owns
/// them — the CLI persists to a state file; a server holds them in memory).
pub fn ingest_pass(
    store: &mut Store,
    opts: &PassOptions,
    skip_names: &mut HashSet<String>,
    stranded_names: &mut HashSet<String>,
    fsynced_parts: &mut HashSet<PathBuf>,
) -> PassResult {
    ingest_pass_observed_with(store, opts, skip_names, stranded_names, fsynced_parts, None, None, None)
}

/// `observer(file_name, file_text)`.
pub type BodyObserver<'a> = dyn FnMut(&str, &str) + 'a;

/// `prefix_extractor(parsed_body) -> prefix_json` — the QSFYIHUO step-2 seam. agentlens-core
/// injects its `extract_turn_prefix` + serialization here because the store cannot depend on that
/// crate (cycle). `None` (alstore CLI, tests) leaves `prefix_json` NULL, the read site's fallback
/// signal. COST MODEL: `ingest_body` parses the body PRIVATELY (inside `append_body_row`), so the
/// pass cannot reuse that `Value` — with an extractor installed this seam causes a REAL second
/// `serde_json` parse of each non-response file (same bytes the ingest parse reads); without one,
/// no extra parse happens at all.
pub type PrefixExtractor<'a> = dyn FnMut(Option<&serde_json::Value>) -> Option<String> + 'a;

/// `raw_facts_extractor(raw_text) -> RawFacts` — the QSFYIHUO step-3 seam (A2 hoist). agentlens-core
/// imports the helpers from `crate::raw_facts` and injects a thin wrapper; no parse is involved —
/// the extractor reads the RAW text the pass already holds, replicating scan_request's bounds.
/// `None` (alstore CLI, tests) leaves `raw_facts_v`/the trio NULL, the read site's fallback key.
pub type RawFactsExtractor<'a> = dyn FnMut(&str) -> (i32, crate::raw_facts::RawFacts) + 'a;

/// `ingest_pass` plus an optional observer, called as `observer(file_name, file_text)` for every
/// body file this pass ingested into the store (only AFTER `ingest_body` succeeded, so a file that
/// is retried is observed once; a name already in `skip_names` was ingested by an earlier pass and
/// is not observed). The observer does no file IO of its own here: the text is the one this pass
/// already read.
pub fn ingest_pass_observed(
    store: &mut Store,
    opts: &PassOptions,
    skip_names: &mut HashSet<String>,
    stranded_names: &mut HashSet<String>,
    fsynced_parts: &mut HashSet<PathBuf>,
    observer: Option<&mut BodyObserver<'_>>,
) -> PassResult {
    ingest_pass_observed_with(store, opts, skip_names, stranded_names, fsynced_parts, observer, None, None)
}

/// `ingest_pass_observed` plus the optional prefix extractor, run at INGEST time (before the body
/// file is deleted by the settle gate) so the serialized TurnPrefix lands on the api_call row while
/// the bytes are still in hand.
#[allow(clippy::too_many_arguments)] // 3 seams + observer are the point of this entrypoint
pub fn ingest_pass_observed_with(
    store: &mut Store,
    opts: &PassOptions,
    skip_names: &mut HashSet<String>,
    stranded_names: &mut HashSet<String>,
    fsynced_parts: &mut HashSet<PathBuf>,
    mut observer: Option<&mut BodyObserver<'_>>,
    mut prefix_extractor: Option<&mut PrefixExtractor<'_>>,
    mut raw_facts_extractor: Option<&mut RawFactsExtractor<'_>>,
) -> PassResult {
    let mut res = PassResult::default();
    let mut relocate_failures = 0u32;
    // One span cache for the WHOLE pass — later settle chunks mostly re-reference the spans
    // earlier chunks already store-proved (consecutive turns dedup against each other), so this
    // turns the per-chunk full-blob-corpus scan into a handful per pass (measured 17min → see
    // reconstruct_chunk's doc). Bounded by the pass throttle bytes by construction.
    let mut span_cache = crate::SpanCache::new();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let cutoff = if opts.max_age_ms > 0 { now_ms - opts.max_age_ms } else { i64::MAX };
    // A listing problem is reported once per tick by prune_pass_names, never here: ingestion reads every
    // file it can, and only a directory that cannot be read at all stops the pass.
    let listing = match body_files(&opts.bodies_dir) {
        Ok(listing) => listing,
        Err(e) => {
            res.failed.push(format!("bodies dir unreadable — pass skipped, state kept ({e})"));
            return res;
        }
    };
    // The AGE gate is the ONLY list-level filter: a skip-named file must still reach the
    // verify+delete gate (excluding it here is what stranded 3,615 bodies on a full spool).
    let all: Vec<BodyFile> = listing.files.into_iter().filter(|f| f.mtime_ms < cutoff).collect();
    if all.is_empty() {
        return res;
    }

    let mut batch: Vec<BatchItem> = Vec::new();

    // settle: flush → (fsync barrier) → verify in chunks → delete/park. Returns nothing; all
    // outcomes land in `res`.
    macro_rules! settle {
        () => {{
            if !batch.is_empty() {
                match flush_detailed(store) {
                    Ok(flushed) => {
                        let mut barrier_ok = true;
                        if opts.durable_source {
                            // The barrier covers EVERY part that can hold a batch body's bytes —
                            // a reclaimed body's parts were flushed in an EARLIER settle and
                            // flushed.part_paths never names them.
                            let mut dirs: HashSet<PathBuf> = HashSet::new();
                            'barrier: for sub in [BLOBS_DIR, BODIES_DIR, PARTS_DIR, API_CALLS_DIR] {
                                let d = store.dir.join(sub);
                                let Ok(rd) = fs::read_dir(&d) else { continue };
                                let mut any = false;
                                for e in rd.flatten() {
                                    let p = e.path();
                                    if p.extension().is_none_or(|x| x != "parquet") {
                                        continue;
                                    }
                                    if fsynced_parts.contains(&p) {
                                        continue;
                                    }
                                    if let Err(e) = fsync_path(&p) {
                                        for b in &batch {
                                            res.failed.push(format!("{}: fsync barrier failed — kept ({e})", b.name));
                                        }
                                        barrier_ok = false;
                                        break 'barrier;
                                    }
                                    fsynced_parts.insert(p);
                                    any = true;
                                }
                                if any || flushed.part_paths.iter().any(|p| p.parent() == Some(d.as_path())) {
                                    dirs.insert(d);
                                }
                            }
                            if barrier_ok {
                                for d in &dirs {
                                    if let Err(e) = fsync_path(d) {
                                        for b in &batch {
                                            res.failed.push(format!("{}: fsync barrier failed — kept ({e})", b.name));
                                        }
                                        barrier_ok = false;
                                        break;
                                    }
                                }
                            }
                        }
                        if barrier_ok {
                            // Group by BYTES, not file count: every verify call costs a fixed
                            // number of corpus-priced queries however many files it carries, so
                            // the group should be as large as memory allows (raw + rebuilt
                            // strings ≈ 2× group bytes). 32-file groups made a 1,251-file pass
                            // issue ~40× the queries for the same proof (2026-08-18).
                            let mut groups: Vec<&[BatchItem]> = Vec::new();
                            {
                                let mut start = 0usize;
                                let mut bytes = 0u64;
                                for (i, b) in batch.iter().enumerate() {
                                    if i > start && bytes + b.size > SETTLE_GROUP_BYTES {
                                        groups.push(&batch[start..i]);
                                        start = i;
                                        bytes = 0;
                                    }
                                    bytes += b.size;
                                }
                                groups.push(&batch[start..]);
                            }
                            for chunk in groups {
                                let mut items: Vec<(&BatchItem, String)> = Vec::new();
                                for b in chunk {
                                    match fs::read_to_string(&b.p) {
                                        Ok(raw) => items.push((b, raw)),
                                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                                        Err(e) => res.failed.push(format!("{}: {e}", b.name)),
                                    }
                                }
                                if items.is_empty() {
                                    continue;
                                }

                                // BORROW the content, never clone it: `items` already owns every body in this
                                // settle group, so cloning it here held the group's bytes TWICE in the Rust
                                // heap (the third copy was DuckDB staging it). The gate takes references —
                                // the SAME bytes, the SAME proof, the SAME outcomes — and the delete path
                                // still re-reads `items` content below.
                                let verify_items: Vec<VerifyItemRef<'_>> = items
                                    .iter()
                                    .map(|(b, raw)| VerifyItemRef { src_name: b.name.as_str(), raw: raw.as_str(), ts_ms: Some(b.mtime_ms) })
                                    .collect();
                                let results = match crate::verify_bodies_in_store_cached_ref(store, &verify_items, &mut span_cache) {
                                    Ok(r) => r,
                                    Err(e) => {
                                        // Per-chunk isolation: a store error costs THIS chunk its
                                        // verify — never the rest of the batch or the pass.
                                        for (b, _) in &items {
                                            res.failed.push(format!("{}: verify errored — kept ({e})", b.name));
                                        }
                                        continue;
                                    }
                                };

                                for (b, raw) in &items {
                                    let v = results.get(&b.name);
                                    match v {
                                        // Gated on the CONTENT: the corpus is live and a re-emission must
                                        // not be deleted against the store's older bytes. A re-emission can
                                        // preserve the size AND the mtime (a `mv` back, a `cp -p`), so the
                                        // guard compares the file's CURRENT BYTES against the bytes this
                                        // pass VERIFIED — content, never metadata. The three outcomes are
                                        // kept apart: a re-emission is the guard WORKING (its own counter),
                                        // an unreadable file is a genuine failure, and only the unchanged
                                        // case deletes.
                                        Some(v) if v.ok => {
                                            if opts.delete_after {
                                                match content_unchanged_since_read(&b.p, raw) {
                                                    ContentGate::Unchanged => match fs::remove_file(&b.p) {
                                                        Ok(()) => {
                                                            res.deleted += 1;
                                                            res.bytes_freed += b.size;
                                                            if b.durable {
                                                                res.reclaimed_durable += 1;
                                                            }
                                                        }
                                                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                                                        Err(e) => res.failed.push(format!("{}: {e}", b.name)),
                                                    },
                                                    ContentGate::Reemitted(msg) => {
                                                        res.delete_aborted_reemission += 1;
                                                        res.failed.push(msg);
                                                    }
                                                    ContentGate::Unreadable(msg) => res.failed.push(msg),
                                                }
                                            }
                                        }
                                        Some(v) => {
                                            let reason = v.reason.clone().unwrap_or_else(|| b.name.clone());
                                            // TRDD-6SPXOV0P option A: a ts-only failure is BENIGN whether the body is durable or not, and is reclaimed
                                            // like an ok verify. Why it is safe: verify_bodies_in_store_cached (its row lookup is keyed on body_id
                                            // AND src_name, and its ts check comes after it) runs the sha256-reconstruction check and the row-existence check
                                            // strictly BEFORE the ts check, each with its own continue on failure. So reaching "stored ts != capture time"
                                            // implies the store reproduces this file bit-exact AND already holds a row for this same src_name: the
                                            // failure is a re-emission of this name. A fresh ingest writes ts = mtime, so only a pre-existing row can
                                            // mismatch. The row is the truer value (it holds the ORIGINAL capture time); the file mtime is the
                                            // impostor (Claude Code re-emits the same name and bytes at a new mtime). So reclaim, leave the row alone,
                                            // and do NOT park: parking here looped, because the "repair rows from mtimes" remedy would overwrite the
                                            // true capture time with the re-emit mtime, and the next pass would park it again forever.
                                            if reason.contains("stored ts ") && reason.contains("!= capture time") {

                                                // Gated on the CONTENT, exactly like the verified arm above: the
                                                // re-emission can preserve the size AND the mtime (a `mv` back, a
                                                // `cp -p`), so only a comparison of the file's CURRENT BYTES
                                                // against the bytes this pass VERIFIED can see it.
                                                match content_unchanged_since_read(&b.p, raw) {
                                                    ContentGate::Reemitted(msg) => {
                                                        res.delete_aborted_reemission += 1;
                                                        res.failed.push(msg);
                                                    }
                                                    ContentGate::Unreadable(msg) => res.failed.push(msg),
                                                    ContentGate::Unchanged => {
                                                        if opts.delete_after {
                                                            match fs::remove_file(&b.p) {
                                                                Ok(()) => {
                                                                    res.deleted += 1;
                                                                    res.bytes_freed += b.size;
                                                                    res.reclaimed_reemitted += 1;
                                                                }
                                                                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                                                                Err(e) => res.failed.push(format!("{}: {e}", b.name)),
                                                            }
                                                        }
                                                    }
                                                }
                                                continue;
                                            }
                                            res.failed.push(reason);
                                            // A byte mismatch converges through re-ingest.
                                            if b.durable {
                                                skip_names.remove(&b.name);
                                            }
                                        }
                                        None => res.failed.push(format!("{}: missing verify result", b.name)),
                                    }
                                }
                            }
                        }
                    }
                    Err(e) => {
                        for b in &batch {
                            res.failed.push(format!("{}: flush failed — kept ({e})", b.name));
                        }
                    }
                }
                batch.clear();
            }
        }};
    }

    for f in all {
        if res.bytes_in + f.size > opts.max_bytes_per_pass && res.bytes_in > 0 {
            res.throttled = true;
            break;
        }
        if stranded_names.contains(&f.name) {
            if let Some(dest) = &opts.relocate_stranded_to {
                if relocate_failures < 3 {
                    match relocate_stranded_file(&f, dest) {
                        Ok(()) => {
                            res.stranded_relocated += 1;
                            res.bytes_freed += f.size;
                        }
                        Err(e) => {
                            relocate_failures += 1;
                            res.failed.push(format!("{}: stranded relocate failed — kept on spool ({e})", f.name));
                        }
                    }
                }
                continue;
            }
            // TRDD-6SPXOV0P: a persisted stranded name is a LEGACY park. The only thing a durable
            // body was ever parked for — `stored ts != capture time` — is reclaimed at the gate
            // below now, so the park has no reason left: route the file to the gate as the durable
            // body it is (every stranded name was a skip name first; on this machine 307/307
            // overlapped) and forget the park. A clean or ts-only verify reclaims it; a byte
            // mismatch drops the skip name so the next pass re-ingests — the same convergence every
            // other durable body gets. Keeping the old `continue` here is exactly what left 307
            // files parked for a week AFTER the reclaim fix landed: the fix could never see them.
            stranded_names.remove(&f.name);
            skip_names.insert(f.name.clone());
        }
        if skip_names.contains(&f.name) {
            // Already durable: straight to the gate — the verify still re-reads and re-proves.
            res.bytes_in += f.size;
            batch.push(BatchItem { p: f.p, name: f.name, mtime_ms: f.mtime_ms, size: f.size, durable: true });
        } else {
            let raw = match fs::read_to_string(&f.p) {
                Ok(r) => r,
                Err(_) => continue, // vanished mid-pass — fine
            };
            // QSFYIHUO step 2: serialize the prefix while the bytes are in hand. Request files
            // only — a response has no TurnPrefix (mirrors extract_api_call_meta's kind test), so
            // the parse+extract is skipped for .response. files rather than discarded at the row.
            // ONE parse shared with ingest_body_with's meta extraction is not possible (that parse
            // lives inside append_body_row), so this is the pass's own parse — but only when an
            // extractor is installed, never on the CLI/test path.
            let prefix_json = if f.name.contains(".response.") {
                None
            } else {
                prefix_extractor.as_deref_mut().and_then(|ex| {
                    let parsed = serde_json::from_str::<serde_json::Value>(&raw).ok();
                    ex(parsed.as_ref())
                })
            };
            // QSFYIHUO step 3 (A1/A3a): raw-text facts for request files only — responses carry
            // NULL on raw_facts_v + the trio (write-boundary guard in append_api_call_row is the
            // backstop). NO parse: the extractor reads the raw text the pass already holds, with
            // scan_request's exact bounds (6 MiB cap, chunked carry, early break).
            let raw_facts = if f.name.contains(".response.") {
                None
            } else {
                raw_facts_extractor.as_deref_mut().map(|ex| ex(&raw))
            };
            match ingest_body_with(store, &f.name, &raw, f.mtime_ms, prefix_json, raw_facts) {
                Ok(r) => {
                    if let Some(observe) = observer.as_mut() {
                        observe(&f.name, &raw);
                    }
                    res.ingested += 1;
                    res.bytes_in += f.size;
                    res.bytes_stored += r.new_bytes;
                    skip_names.insert(f.name.clone());
                    batch.push(BatchItem { p: f.p, name: f.name, mtime_ms: f.mtime_ms, size: f.size, durable: false });
                }
                Err(e) => {
                    res.failed.push(format!("{}: {e}", f.name));
                    continue;
                }
            }
        }
        // TRDD-2JOIAH2G R2 — bound the pass transient. The DuckDB staging tables are RAM until
        // flush_detailed, and the file-count batch alone lets a backlog of large bodies stage
        // ~2× max_bytes_per_pass (≈1GB) before the first flush — a spike the RSS-cap kill
        // (which fires only BETWEEN passes) cannot see. Settle on the batch's SOURCE bytes at
        // SETTLE_GROUP_BYTES too (the same ceiling the verify grouping below uses; staged rows
        // ≈ 2× source), so peak in-flight is one group + one file, not the whole pass budget.
        if batch.len() >= opts.batch_size || batch.iter().map(|b| b.size).sum::<u64>() >= SETTLE_GROUP_BYTES {
            settle!();
        }
    }
    settle!();
    res
}

/// TRDD-8TM7I49X: remove names from the persisted stranded set — the operator's recovery path
/// (the pass itself now drains a stranded name through the gate on sight, TRDD-6SPXOV0P; this
/// verb remains for a store whose pass is not running, and for `store repair-parked`). MUST be
/// called with the pass lock held (the bin takes it): the state file is shared with every pass
/// engine, and an unlocked read-modify-write can interleave with a pass's own load→save,
/// silently resurrecting or dropping names in either set. Returns (requested, removed,
/// stranded_remaining). skipNames is preserved untouched — an unparked name stays skip-listed,
/// which is exactly what routes it to the delete gate instead of a re-ingest.
pub fn unpark_names(state_file: &Path, names: &[String]) -> std::io::Result<(usize, usize, usize)> {
    // WHY the `?` (TRDD-FINMFYDE): a state file that cannot be read must stop the unpark before the save below.
    // Saving the empty sets a failed load would return writes over the real file and destroy every persisted name.
    let (skip, mut stranded) = load_pass_state(state_file)?;
    let before = stranded.len();
    for n in names {
        stranded.remove(n);
    }
    let removed = before - stranded.len();
    // TRDD-ZR3OGSAV: a failed save means the unpark did NOT happen; reporting success would lie.
    save_pass_state(state_file, &skip, &stranded)?;
    Ok((names.len(), removed, stranded.len()))
}

/// Prune the persisted name sets against EVERY bodies dir of a tick (TRDD-2HRA270Y). Call it ONCE per tick,
/// inside the pass lock and after the state is loaded: the sets are shared by all the dirs, so a prune
/// against one dir listing would drop the names of the other dirs. A name is dropped only when it is absent
/// from the union of all the listings. Nothing is pruned unless every listing is complete: an unreadable
/// dir (NotFound included: no dir in the list is optional) or an unreadable directory entry could hide a
/// live name. A name that exists but cannot be statted is still present. Returns one summary line when any
/// listing problem was met, None when the listings were clean.
pub fn prune_pass_names(
    dirs: &[PathBuf],
    skip_names: &mut HashSet<String>,
    stranded_names: &mut HashSet<String>,
) -> Option<String> {
    if dirs.is_empty() {
        return Some("no bodies dir given; prune skipped".to_owned());
    }
    let mut present: HashSet<String> = HashSet::new();
    let mut complete = true;
    let mut problems = 0usize;
    let mut sample: Option<String> = None;
    for dir in dirs {
        match body_files(dir) {
            Ok(listing) => {
                present.extend(listing.names);
                for (name, err) in listing.unstatable {
                    problems += 1;
                    sample.get_or_insert_with(|| format!("{name}: {err}"));
                }
                for err in listing.unreadable_entries {
                    complete = false;
                    problems += 1;
                    sample.get_or_insert_with(|| format!("an entry of {}: {err}", dir.display()));
                }
            }
            Err(e) => {
                complete = false;
                problems += 1;
                sample.get_or_insert_with(|| format!("{}: {e}", dir.display()));
            }
        }
    }
    if complete {
        skip_names.retain(|n| present.contains(n));
        stranded_names.retain(|n| present.contains(n));
    }
    if problems == 0 {
        return None;
    }
    let outcome = if complete { "prune ran" } else { "prune skipped" };
    Some(format!("listing problems: {problems} (e.g. {}); {outcome}", sample.unwrap_or_default()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpark_removes_only_named_stranded_and_preserves_skip() {
        let dir = std::env::temp_dir().join(format!("al-unpark-{}", std::process::id()));
        fs::remove_dir_all(&dir).ok(); // robust to a leftover from a crashed earlier run
        fs::create_dir_all(&dir).unwrap();
        let state = dir.join(PASS_STATE_FILE);
        let skip: HashSet<String> = ["a.request.json", "b.request.json"].iter().map(|s| s.to_string()).collect();
        let stranded: HashSet<String> = ["a.request.json", "c.response.json"].iter().map(|s| s.to_string()).collect();
        save_pass_state(&state, &skip, &stranded).unwrap();

        // Remove one present name, one absent name — removed counts only what was actually there.
        let (req, removed, remaining) =
            unpark_names(&state, &["a.request.json".to_string(), "zzz.request.json".to_string()]).unwrap();
        assert_eq!((req, removed, remaining), (2, 1, 1));

        let (skip2, stranded2) = load_pass_state(&state).unwrap();
        assert_eq!(skip2, skip, "skipNames must survive an unpark byte-for-byte");
        assert!(stranded2.contains("c.response.json") && !stranded2.contains("a.request.json"));
        fs::remove_dir_all(&dir).ok();
    }

    /// TRDD-ZR3OGSAV: a write failure must surface. The TEMP path is an existing directory, so the
    /// temp write fails with EISDIR (21 on macOS and Linux). WHY this shape: if the write error were
    /// swallowed, the rename of that directory onto the free state path would SUCCEED, so the test
    /// goes red; a write failure under a missing/non-directory parent would not (the rename fails too).
    #[test]
    fn save_pass_state_reports_a_write_failure() {
        let dir = std::env::temp_dir().join(format!("al-save-write-fail-{}", std::process::id()));
        fs::remove_dir_all(&dir).ok(); // robust to a leftover from a crashed earlier run
        let state = dir.join(PASS_STATE_FILE);
        fs::create_dir_all(state.with_extension("json.tmp")).unwrap();
        let none: HashSet<String> = HashSet::new();
        let err = save_pass_state(&state, &none, &none).expect_err("a failed temp write must be an Err");
        assert_eq!(err.raw_os_error(), Some(21), "expected EISDIR from the temp write, got {err:?}");
        assert!(!state.exists(), "a failed write must not produce a state file");
        fs::remove_dir_all(&dir).ok();
    }

    /// TRDD-ZR3OGSAV: a rename failure must surface AND leave no stale `.json.tmp`. The state path
    /// is an existing non-empty directory, so the temp write succeeds and the rename onto it fails.
    #[test]
    fn save_pass_state_reports_a_rename_failure_and_removes_the_temp_file() {
        let dir = std::env::temp_dir().join(format!("al-save-rename-fail-{}", std::process::id()));
        fs::remove_dir_all(&dir).ok(); // robust to a leftover from a crashed earlier run
        let state = dir.join(PASS_STATE_FILE);
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join("occupant"), b"x").unwrap();
        let none: HashSet<String> = HashSet::new();
        assert!(save_pass_state(&state, &none, &none).is_err(), "a failed rename must be an Err");
        assert!(!state.with_extension("json.tmp").exists(), "the failed rename must not leave its temp file");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_content_gate_sees_a_reemission_that_preserves_the_size_and_the_mtime() {
        // THE `cp -p` CASE, tested on the gate itself. A re-emission can land between the verify
        // and the delete carrying DIFFERENT bytes while preserving BOTH the size and the mtime
        // (a `mv` back, a `cp -p`), so a size/mtime comparison cannot see it — the metadata guard
        // this replaced was bypassable exactly that way. The gate compares the file's CURRENT
        // BYTES against the bytes that were verified, and must report a re-emission.
        let dir = std::env::temp_dir().join(format!("al-cgate-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("body.json");

        let verified = "the bytes the store ingested and proved it can reproduce";
        fs::write(&p, verified).unwrap();
        // Capture the mtime, then re-emit DIFFERENT bytes of the SAME LENGTH with it restored.
        let mtime = fs::metadata(&p).unwrap().modified().unwrap();
        let reemitted = "the bytes that LANDED after the verify, the same length!";
        assert_eq!(reemitted.len(), verified.len(), "the re-emission must preserve the LENGTH");
        fs::write(&p, reemitted).unwrap();
        let f = fs::OpenOptions::new().write(true).open(&p).unwrap();
        f.set_times(fs::FileTimes::new().set_modified(mtime)).unwrap();
        // The size AND the mtime are now identical to the verified file's — a metadata guard sees
        // nothing; only the content differs.
        let st = fs::metadata(&p).unwrap();
        assert_eq!(st.len(), verified.len() as u64, "the size is preserved");
        assert_eq!(st.modified().unwrap(), mtime, "the mtime is preserved");

        match content_unchanged_since_read(&p, verified) {
            ContentGate::Reemitted(msg) => {
                assert!(msg.contains("body.json"), "the message names the file: {msg}");
                assert!(msg.contains("content changed"), "the message says WHY: {msg}");
            }
            ContentGate::Unchanged => panic!("the gate must SEE a content change it must not delete"),
            ContentGate::Unreadable(msg) => panic!("the file is readable: {msg}"),
        }

        // And the file is still there: the gate never deletes.
        assert!(p.exists(), "the gate does not delete — the caller does, and only on Unchanged");
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn the_content_gate_passes_unchanged_bytes_and_reports_an_unreadable_file_separately() {
        let dir = std::env::temp_dir().join(format!("al-cgate2-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let p = dir.join("body.json");
        let verified = "unchanged bytes";
        fs::write(&p, verified).unwrap();

        assert!(
            matches!(content_unchanged_since_read(&p, verified), ContentGate::Unchanged),
            "identical bytes must pass the gate — a guard that aborts every delete would wedge the drain"
        );

        // A file that cannot be read is NOT a re-emission, and the two are counted apart: one is
        // the guard working, the other is a genuine problem.
        let missing = dir.join("gone.json");
        match content_unchanged_since_read(&missing, verified) {
            ContentGate::Unreadable(msg) => assert!(msg.contains("re-read before delete failed"), "{msg}"),
            _ => panic!("a missing file must be Unreadable, not Unchanged and not Reemitted"),
        }
        fs::remove_dir_all(&dir).ok();
    }

    /// TRDD-FINMFYDE: an absent state file is the first-run state and loads as empty sets, not an error.
    #[test]
    fn load_pass_state_absent_file_is_empty() {
        let dir = std::env::temp_dir().join(format!("al-load-absent-{}", std::process::id()));
        fs::remove_dir_all(&dir).ok(); // robust to a leftover from a crashed earlier run
        fs::create_dir_all(&dir).unwrap();
        let (skip, stranded) = load_pass_state(&dir.join(PASS_STATE_FILE)).expect("an absent file is not an error");
        assert!(skip.is_empty() && stranded.is_empty());
        fs::remove_dir_all(&dir).ok();
    }

    /// TRDD-FINMFYDE: a present file that is not valid JSON is an Err, never empty sets: empty sets are what
    /// unpark would save over the file.
    #[test]
    fn load_pass_state_corrupt_file_is_an_error() {
        let dir = std::env::temp_dir().join(format!("al-load-corrupt-{}", std::process::id()));
        fs::remove_dir_all(&dir).ok(); // robust to a leftover from a crashed earlier run
        fs::create_dir_all(&dir).unwrap();
        let state = dir.join(PASS_STATE_FILE);
        fs::write(&state, b"{not json").unwrap();
        let err = load_pass_state(&state).expect_err("a corrupt file must be an Err");
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData, "{err}");
        assert!(err.to_string().contains(&state.display().to_string()), "the error must name the path: {err}");
        fs::remove_dir_all(&dir).ok();
    }

    /// TRDD-FINMFYDE: unpark over a corrupt state file is refused, and the file bytes are left as they were.
    #[test]
    fn unpark_names_refuses_a_corrupt_state_file_and_leaves_it_byte_identical() {
        let dir = std::env::temp_dir().join(format!("al-unpark-corrupt-{}", std::process::id()));
        fs::remove_dir_all(&dir).ok(); // robust to a leftover from a crashed earlier run
        fs::create_dir_all(&dir).unwrap();
        let state = dir.join(PASS_STATE_FILE);
        let original = b"{not json";
        fs::write(&state, original).unwrap();
        assert!(unpark_names(&state, &["a.request.json".to_string()]).is_err(), "unpark over a corrupt file must be an Err");
        assert_eq!(fs::read(&state).unwrap(), original, "the corrupt state file must not be overwritten");
        assert!(!state.with_extension("json.tmp").exists(), "a refused unpark must not leave a temp file");
        fs::remove_dir_all(&dir).ok();
    }
}

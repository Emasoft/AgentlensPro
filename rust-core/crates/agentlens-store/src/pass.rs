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
//! record — with a 3-strike per-pass breaker on relocation failures), which still wins.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::{flush_detailed, ingest_body, Store, VerifyItem, BLOBS_DIR, BODIES_DIR, PARTS_DIR};

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
/// A missing or unparseable file is EMPTY, not an error: the state is an optimization plus a
/// quarantine list, and refusing to run because it is corrupt would stop the drain entirely. The
/// cost of starting empty is one slow pass.
pub fn load_pass_state(p: &Path) -> (HashSet<String>, HashSet<String>) {
    let Ok(raw) = fs::read_to_string(p) else { return (Default::default(), Default::default()) };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) else {
        return (Default::default(), Default::default());
    };
    let set = |k: &str| {
        v.get(k)
            .and_then(|a| a.as_array())
            .map(|a| a.iter().filter_map(|s| s.as_str().map(str::to_owned)).collect())
            .unwrap_or_default()
    };
    (set("skipNames"), set("strandedNames"))
}

/// Write the pass state. Sorted so the file is diffable and its content is a function of the SET,
/// not of HashSet iteration order — otherwise every pass rewrites a byte-different file. Temp +
/// rename so a crash mid-write cannot leave a truncated state that reads back as "nothing is
/// stranded".
pub fn save_pass_state(p: &Path, skip: &HashSet<String>, stranded: &HashSet<String>) {
    let mut skip_v: Vec<&String> = skip.iter().collect();
    let mut str_v: Vec<&String> = stranded.iter().collect();
    skip_v.sort();
    str_v.sort();
    let json = serde_json::json!({ "skipNames": skip_v, "strandedNames": str_v });
    let tmp = p.with_extension("json.tmp");
    if fs::write(&tmp, json.to_string()).is_ok() {
        let _ = fs::rename(&tmp, p);
    }
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

fn body_files(dir: &Path) -> Vec<BodyFile> {
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(dir) else { return out };
    for entry in rd.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str().map(str::to_owned) else { continue };
        if !name.ends_with(".request.json") && !name.ends_with(".response.json") {
            continue;
        }
        let p = entry.path();
        let Ok(st) = fs::metadata(&p) else { continue }; // raced with a writer — next pass
        let mtime_ms = st
            .modified()
            .ok()
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);
        out.push(BodyFile { p, name, mtime_ms, size: st.len() });
    }
    out.sort_by_key(|f| f.mtime_ms); // OLDEST FIRST — the true turn order, which is what dedups
    out
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
    // The AGE gate is the ONLY list-level filter: a skip-named file must still reach the
    // verify+delete gate (excluding it here is what stranded 3,615 bodies on a full spool).
    let all: Vec<BodyFile> = body_files(&opts.bodies_dir).into_iter().filter(|f| f.mtime_ms < cutoff).collect();
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
                            'barrier: for sub in [BLOBS_DIR, BODIES_DIR, PARTS_DIR] {
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
                                let verify_items: Vec<VerifyItem> = items
                                    .iter()
                                    .map(|(b, raw)| VerifyItem { src_name: b.name.clone(), raw: raw.clone(), ts_ms: Some(b.mtime_ms) })
                                    .collect();
                                let results = match crate::verify_bodies_in_store_cached(store, &verify_items, &mut span_cache) {
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
                                for (b, _) in &items {
                                    let v = results.get(&b.name);
                                    match v {
                                        Some(v) if v.ok => {
                                            if opts.delete_after {
                                                match fs::remove_file(&b.p) {
                                                    Ok(()) => {
                                                        res.deleted += 1;
                                                        res.bytes_freed += b.size;
                                                        if b.durable {
                                                            res.reclaimed_durable += 1;
                                                        }
                                                    }
                                                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                                                    Err(e) => res.failed.push(format!("{}: {e}", b.name)),
                                                }
                                            }
                                        }
                                        Some(v) => {
                                            let reason = v.reason.clone().unwrap_or_else(|| b.name.clone());
                                            // TRDD-6SPXOV0P option A: a ts-only failure on a durable
                                            // body is BENIGN, not a park case. `verify_bodies_in_store_cached`
                                            // runs the sha256-reconstruction check and the row-existence
                                            // check strictly BEFORE the ts check (each with its own
                                            // `continue` on failure — lib.rs), so reaching "stored ts !=
                                            // capture time" mathematically implies the store already
                                            // reproduces this file bit-exact. The row is the truer value
                                            // (it holds the ORIGINAL capture time); the file's mtime is the
                                            // impostor — Claude Code re-emitted the same name+bytes at a
                                            // new mtime. So: reclaim like an ok verify, leave the row
                                            // alone, and do NOT park (parking here is what looped: the
                                            // "repair rows from mtimes" remedy would overwrite the true
                                            // capture time with the re-emit's mtime, then next pass parks
                                            // it again forever).
                                            if b.durable && reason.contains("stored ts ") && reason.contains("!= capture time") {
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
            match ingest_body(store, &f.name, &raw, f.mtime_ms) {
                Ok(r) => {
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
        if batch.len() >= opts.batch_size {
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
pub fn unpark_names(state_file: &Path, names: &[String]) -> (usize, usize, usize) {
    let (skip, mut stranded) = load_pass_state(state_file);
    let before = stranded.len();
    for n in names {
        stranded.remove(n);
    }
    let removed = before - stranded.len();
    save_pass_state(state_file, &skip, &stranded);
    (names.len(), removed, stranded.len())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unpark_removes_only_named_stranded_and_preserves_skip() {
        let dir = std::env::temp_dir().join(format!("al-unpark-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let state = dir.join(PASS_STATE_FILE);
        let skip: HashSet<String> = ["a.request.json", "b.request.json"].iter().map(|s| s.to_string()).collect();
        let stranded: HashSet<String> = ["a.request.json", "c.response.json"].iter().map(|s| s.to_string()).collect();
        save_pass_state(&state, &skip, &stranded);

        // Remove one present name, one absent name — removed counts only what was actually there.
        let (req, removed, remaining) =
            unpark_names(&state, &["a.request.json".to_string(), "zzz.request.json".to_string()]);
        assert_eq!((req, removed, remaining), (2, 1, 1));

        let (skip2, stranded2) = load_pass_state(&state);
        assert_eq!(skip2, skip, "skipNames must survive an unpark byte-for-byte");
        assert!(stranded2.contains("c.response.json") && !stranded2.contains("a.request.json"));
        fs::remove_dir_all(&dir).ok();
    }
}

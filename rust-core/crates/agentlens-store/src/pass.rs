//! The ingest pass — port of `src/store/ingestPass.ts` (TRDD-DMWOBWFH P3c).
//!
//! THIS DELETES THE USER'S FILES, so the ordering IS the contract and must not be "simplified":
//!   1. ingest  — GATE 1 already refuses anything that does not reconstruct byte-identically.
//!   2. FLUSH   — the spans reach an immutable Parquet part. durableSource additionally fsyncs
//!                every part file + the part dirs BEFORE any delete (the page-cache hole).
//!   3. verify  — reconstruct FROM THE FLUSHED STORE and compare against the file's own bytes,
//!                plus the (src_name, ts) row — metadata is data too.
//!   4. delete  — and only now.
//! A crash loses at most the un-flushed batch; sources are still there. It is also THROTTLED
//! (512MB/pass default): the archiver this replaced burned 694 MB/min of device writes on boot.
//!
//! Stranded parking (the livelock fix): a durable-named file failing ONLY on capture-ts can
//! never be repaired by re-ingest (dedup never updates ts) — park it (zero I/O next pass),
//! optionally RELOCATE it off the volatile spool (verify-before-unlink, mtime preserved — the
//! mtime IS the capture record), with a 3-strike per-pass breaker on relocation failures.

use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};

use crate::{flush_detailed, ingest_body, verify_bodies_in_store, Store, VerifyItem, BLOBS_DIR, BODIES_DIR, PARTS_DIR};

pub const DEFAULT_MAX_BYTES_PER_PASS: u64 = 512 * 1024 * 1024;
pub const DEFAULT_BATCH: usize = 200;
pub const SETTLE_READ_CHUNK: usize = 32;

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
                            for chunk in batch.chunks(SETTLE_READ_CHUNK) {
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
                                let results = match verify_bodies_in_store(store, &verify_items) {
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
                                            // The ts-only livelock: bytes proven, row ts wrong —
                                            // park it; re-ingest can never repair that row.
                                            if b.durable && reason.contains("stored ts ") && reason.contains("!= capture time") {
                                                stranded_names.insert(b.name.clone());
                                                res.stranded_ts.push(b.name.clone());
                                                res.failed.push(reason);
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
            }
            continue;
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

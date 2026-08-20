//! The bodies admin routes' engine (TRDD-DMWOBWFH, freeze rows 14–15) — ports the READER half
//! of src/bodyArchive.ts (the WAD volume format), bodyStore.ts::exportBodiesFromStore, and
//! archiveVerify.ts::verifyVolumeInStore, behind POST /api/bodies/export and
//! POST /api/bodies/purge (ui.rs).
//!
//! NOT PORTED, on purpose: `appendToArchive` and the retention `purgeArchiveVolumes` — the
//! archive WRITER stays the TS retention subsystem's (one writer implementation is the WAD
//! format's own design law; this side only READS, extracts, verifies and — after per-lump
//! proof — deletes). The `.idx` sidecar is ALWAYS kept: capture-time provenance at ~0.05% of
//! the volume's size.
//!
//! THE DELETE GATE (TRDD-K3WDPR7M, USER directive 2026-07-15): a volume is deleted ONLY after
//! EVERY one of its lumps is proven in the durable store — exact bytes AND the (src_name,
//! capture-ts) row, through agentlens-store's verify gate (the same facts the TS per-file
//! verifyBodyInStore proves; the bulk shape is the measured KB17X5G2 throughput fix, chunked
//! byte-bounded so a multi-GB volume never sits decompressed in RAM at once). Failure REASON
//! text follows the Rust store's wording where the engines differ (ms timestamps instead of the
//! TS per-file ISO strings) — the status and shape are the contract, diagnostic text is not,
//! the same rule the /api/import parse-error path already applies.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{json, Map, Value};

/// server.ts BODIES_ARCHIVE_DIR.
pub fn archive_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("otel-bodies-archive")
}

/// bodyArchive.ts VOLUME_RE — `^bodies-\d{4}-\d{2}\.wad$`.
pub fn is_volume_name(name: &str) -> bool {
    let Some(stem) = name.strip_prefix("bodies-").and_then(|s| s.strip_suffix(".wad")) else { return false };
    let b = stem.as_bytes();
    b.len() == 7 && b[4] == b'-' && b.iter().enumerate().all(|(i, c)| i == 4 || c.is_ascii_digit())
}

/// One lump's directory row (ArchivedBody — the entry plus the volume holding it).
#[derive(Clone, Debug)]
pub struct ArchiveEntry {
    pub name: String,
    pub offset: u64,
    pub compressed_length: u64,
    /// Original (uncompressed) size — informational; the read trusts the gzip stream.
    pub size: u64,
    /// Original file mtime, ms — preserved so time-window scans stay correct.
    pub mtime_ms: f64,
    pub volume: PathBuf,
}

/// loadVolumeIndex — one volume's directory; corrupt lines (crash-truncated tail) are skipped,
/// never fatal.
pub fn load_volume_index(volume_path: &Path) -> Vec<ArchiveEntry> {
    let idx = PathBuf::from(format!("{}.idx", volume_path.display()));
    let Ok(raw) = std::fs::read_to_string(&idx) else { return Vec::new() };
    let mut out = Vec::new();
    for line in raw.split('\n') {
        if line.is_empty() {
            continue;
        }
        let Ok(j) = serde_json::from_str::<Value>(line) else { continue }; // truncated tail line — skip
        let s = |k: &str| j.get(k).and_then(Value::as_str).unwrap_or("").to_owned();
        let n = |k: &str| j.get(k).and_then(Value::as_f64).unwrap_or(0.0);
        out.push(ArchiveEntry {
            name: s("n"),
            offset: n("o") as u64,
            compressed_length: n("l") as u64,
            size: n("s") as u64,
            mtime_ms: n("m"),
            volume: volume_path.to_path_buf(),
        });
    }
    out
}

/// listArchiveEntries — every archived body across all volumes, oldest volume first
/// (lexicographic sort of the month-named files IS chronological).
pub fn list_archive_entries(dir: &Path) -> Vec<ArchiveEntry> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut names: Vec<String> = rd
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_owned))
        .filter(|n| is_volume_name(n))
        .collect();
    names.sort();
    names.into_iter().flat_map(|v| load_volume_index(&dir.join(v))).collect()
}

/// readArchiveEntry — random access: seek + bounded read + gunzip; a short read is an error
/// (the TS throws the same way), never a silent truncation.
pub fn read_archive_entry(entry: &ArchiveEntry) -> std::io::Result<Vec<u8>> {
    use std::io::{Seek, SeekFrom};
    let mut fd = std::fs::File::open(&entry.volume)?;
    fd.seek(SeekFrom::Start(entry.offset))?;
    let mut gz = vec![0u8; entry.compressed_length as usize];
    fd.read_exact(&mut gz).map_err(|e| {
        std::io::Error::other(format!(
            "short read on {} at {}: {e}",
            entry.volume.file_name().and_then(|n| n.to_str()).unwrap_or("?"),
            entry.offset
        ))
    })?;
    let mut out = Vec::with_capacity(entry.size as usize);
    flate2::read::GzDecoder::new(&gz[..]).read_to_end(&mut out)?;
    Ok(out)
}

/// extractArchive — archived bodies (optionally windowed) back into plain files at destDir,
/// original mtimes restored.
pub fn extract_archive(
    dir: &Path,
    dest: &Path,
    mut filter: impl FnMut(&ArchiveEntry) -> bool,
) -> std::io::Result<(u64, u64)> {
    std::fs::create_dir_all(dest)?;
    let (mut files, mut bytes) = (0u64, 0u64);
    for e in list_archive_entries(dir) {
        if !filter(&e) {
            continue;
        }
        let data = read_archive_entry(&e)?;
        let out = dest.join(&e.name);
        std::fs::write(&out, &data)?;
        let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs_f64((e.mtime_ms / 1000.0).max(0.0));
        let f = std::fs::OpenOptions::new().append(true).open(&out)?;
        let _ = f.set_times(std::fs::FileTimes::new().set_accessed(t).set_modified(t));
        files += 1;
        bytes += data.len() as u64;
    }
    Ok((files, bytes))
}

fn open_body_store(data_dir: &Path) -> Result<agentlens_store::Store, String> {
    let threads = std::thread::available_parallelism().map(|n| n.get().saturating_sub(2).max(4)).unwrap_or(4);
    agentlens_store::open_store(&data_dir.join("store"), agentlens_store::DEFAULT_MEMORY_LIMIT, threads).map_err(|e| e.to_string())
}

/// exportBodiesFromStore — the store half of the export (TRDD-K3WDPR7M): once ingestPass
/// reclaims a source file, the content-addressed store is the ONLY place that body exists;
/// without this an export window would return only what the legacy .wad holds and the caller
/// would read the gap as "no traffic". Skip-existing makes the two halves compose (identical
/// bytes either way). Failures are NAMED, never silently skipped.
pub fn export_bodies_from_store(
    store: &agentlens_store::Store,
    dest: &Path,
    since_ms: f64,
    until_ms: f64,
) -> Result<(u64, u64, Vec<String>), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    // `ts` is capture time for bodies ingested after the tsMs plumbing, INGEST time for the
    // first backfill — over-inclusive beats silently missing, so the window filters what we have.
    let until = if until_ms.is_finite() { until_ms.floor() as i64 } else { 9_007_199_254_740_991 }; // Number.MAX_SAFE_INTEGER
    let sql = format!(
        "SELECT body_id, src_name FROM {} WHERE epoch_ms(ts) >= {} AND epoch_ms(ts) <= {until}",
        agentlens_store::all_of(store, "body"),
        since_ms.floor() as i64
    );
    let rows: Vec<(String, String)> = {
        let mut stmt = store.con.prepare(&sql).map_err(|e| e.to_string())?;
        let it = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        it.flatten().collect()
    };
    let (mut files, mut bytes) = (0u64, 0u64);
    let mut failed: Vec<String> = Vec::new();
    for (body_id, name) in rows {
        // Path safety: src_name is DATA — never let it climb out of destDir. Node's basename
        // keeps ".." (whose write then fails as EISDIR); Rust's file_name refuses it — either
        // way the escape cannot happen and the entry lands in `failed` by name.
        let Some(base) = Path::new(&name).file_name() else {
            failed.push(format!("{name}: unsafe src_name (no basename)"));
            continue;
        };
        let out = dest.join(base);
        if out.exists() {
            continue; // the archive half already produced it
        }
        match agentlens_store::reconstruct_body(store, &body_id) {
            Ok(raw) => {
                if let Err(e) = std::fs::write(&out, &raw) {
                    failed.push(format!("{name}: {e}"));
                    continue;
                }
                files += 1;
                bytes += raw.len() as u64;
            }
            Err(e) => failed.push(format!("{name}: {e}")),
        }
    }
    Ok((files, bytes, failed))
}

/// verifyVolumeInStore — prove the store fully holds one archive volume. Fail-safe by
/// construction: no readable index while the volume has bytes ⇒ NOT verifiable ⇒ ok=false (a
/// volume we cannot enumerate must not be deleted); any lump failing bytes/row/ts ⇒ ok=false,
/// entry named. Chunked byte-bounded (the pass's settle-group lesson) with ONE SpanCache across
/// chunks so the blob-corpus scan runs once, not once per chunk.
pub struct VolumeVerifyResult {
    pub ok: bool,
    pub entries: u64,
    pub verified: u64,
    pub failed: Vec<String>,
}

const VERIFY_CHUNK_BYTES: usize = 128 * 1024 * 1024;

pub fn verify_volume_in_store(store: &agentlens_store::Store, dir: &Path, volume_name: &str) -> VolumeVerifyResult {
    let volume_path = dir.join(volume_name);
    let entries: Vec<ArchiveEntry> = list_archive_entries(dir).into_iter().filter(|e| e.volume == volume_path).collect();
    let mut res = VolumeVerifyResult { ok: false, entries: entries.len() as u64, verified: 0, failed: Vec::new() };
    if entries.is_empty() {
        let bytes = std::fs::metadata(&volume_path).map(|m| m.len()).unwrap_or(0);
        res.failed.push(if bytes > 0 {
            format!("{volume_name}: has {bytes} bytes but no readable index entries — unverifiable, refusing to bless")
        } else {
            format!("{volume_name}: no such volume / empty")
        });
        return res;
    }
    let mut cache = agentlens_store::SpanCache::new();
    let mut chunk: Vec<agentlens_store::VerifyItem> = Vec::new();
    let mut chunk_bytes = 0usize;
    let flush = |chunk: &mut Vec<agentlens_store::VerifyItem>, res: &mut VolumeVerifyResult, cache: &mut agentlens_store::SpanCache| {
        if chunk.is_empty() {
            return;
        }
        match agentlens_store::verify_bodies_in_store_cached(store, chunk, cache) {
            Ok(map) => {
                // Entry order preserved by looking results up in the chunk's own order. Two
                // lumps sharing one src_name collapse to one map row — both report its verdict.
                for it in chunk.iter() {
                    match map.get(&it.src_name) {
                        Some(v) if v.ok => res.verified += 1,
                        Some(v) => res.failed.push(v.reason.clone().unwrap_or_else(|| it.src_name.clone())),
                        None => res.failed.push(format!("{}: verify returned no verdict", it.src_name)),
                    }
                }
            }
            Err(e) => res.failed.push(format!("{volume_name}: verify batch failed: {e}")),
        }
        chunk.clear();
    };
    for e in &entries {
        match read_archive_entry(e) {
            Ok(data) => {
                chunk_bytes += data.len();
                chunk.push(agentlens_store::VerifyItem {
                    src_name: e.name.clone(),
                    // Buffer.toString('utf8') is lossy on invalid sequences; so is this.
                    raw: String::from_utf8_lossy(&data).into_owned(),
                    ts_ms: Some(e.mtime_ms as i64),
                });
                if chunk_bytes >= VERIFY_CHUNK_BYTES {
                    flush(&mut chunk, &mut res, &mut cache);
                    chunk_bytes = 0;
                }
            }
            Err(err) => res.failed.push(format!("{}: unreadable lump ({err})", e.name)),
        }
    }
    flush(&mut chunk, &mut res, &mut cache);
    res.ok = res.failed.is_empty() && res.verified == res.entries;
    res
}

// ── the two route bodies (server.ts:3664 / 3711) ─────────────────────────────────────────────

/// POST /api/bodies/export — archive half + store half, replied as ONE combined shape. The
/// archive half failing throws into the caller's 500; the store half failing after a
/// successful archive half is reported in `failed`, NEVER silently (a partial export must say
/// so). Returns (status, body).
pub fn bodies_export(data_dir: &Path, body: &[u8]) -> (u16, Value) {
    let err = |status: u16, msg: String| (status, json!({ "error": msg }));
    let parsed: Value = match serde_json::from_slice(body) {
        Ok(v) => v,
        // The TS parse failure lands in the outer catch → 500 (not a 400); the message text is
        // serde's, not V8's — the status and shape are the contract.
        Err(e) => return err(500, e.to_string()),
    };
    let dest = parsed.get("destDir").and_then(Value::as_str).unwrap_or("");
    if dest.is_empty() || !Path::new(dest).is_absolute() {
        return err(400, "destDir (absolute path) is required".to_owned());
    }
    let arch = archive_dir(data_dir);
    // The TS guard is a STRING-prefix test on resolved paths — a sibling dir sharing the
    // archive's name as a prefix is (over-)refused there too; mirrored, safe direction.
    if dest.starts_with(&arch.display().to_string()) {
        return err(400, "destDir must not be inside the archive itself".to_owned());
    }
    let since = parsed.get("sinceMs").and_then(Value::as_f64).unwrap_or(0.0);
    let until = parsed.get("untilMs").and_then(Value::as_f64).unwrap_or(f64::INFINITY);
    let dest_p = Path::new(dest);
    let (a_files, a_bytes) = match extract_archive(&arch, dest_p, |e| e.mtime_ms >= since && e.mtime_ms <= until) {
        Ok(r) => r,
        Err(e) => return err(500, e.to_string()),
    };
    // The store half (TRDD-K3WDPR7M): its failure NEVER fails the whole export — the archive
    // half already succeeded — but it is always named.
    let (s_files, s_bytes, failed) = match open_body_store(data_dir).and_then(|store| export_bodies_from_store(&store, dest_p, since, until))
    {
        Ok(r) => r,
        Err(e) => (0, 0, vec![format!("store export failed: {e}")]),
    };
    println!(
        "alcore: bodies export: {a_files} archive + {s_files} store file(s), {:.1}MB → {dest}{}",
        (a_bytes + s_bytes) as f64 / 1048576.0,
        if failed.is_empty() { String::new() } else { format!(" ({} FAILED)", failed.len()) }
    );
    (
        200,
        json!({
            "files": a_files + s_files, "bytes": a_bytes + s_bytes,
            "fromArchive": a_files, "fromStore": s_files,
            "failed": failed, "destDir": dest,
        }),
    )
}

/// POST /api/bodies/purge — destruction is EARNED, never assumed: each volume is deleted ONLY
/// after every lump is proven in the store; a volume that fails stays on disk with its
/// failures named (first 5 sampled). The `.idx` sidecars are ALWAYS kept.
pub fn bodies_purge(data_dir: &Path) -> (u16, Value) {
    let store = match open_body_store(data_dir) {
        Ok(s) => s,
        Err(e) => return (500, json!({ "error": e })),
    };
    let arch = archive_dir(data_dir);
    let mut names: Vec<String> = std::fs::read_dir(&arch)
        .map(|rd| rd.flatten().filter_map(|e| e.file_name().to_str().map(str::to_owned)).filter(|n| is_volume_name(n)).collect())
        .unwrap_or_default();
    // The TS iterates raw readdir order (platform-dependent); sorted here — order is not part
    // of the frozen shape, determinism is worth having.
    names.sort();
    let mut removed: Vec<Value> = Vec::new();
    let mut kept: Vec<Value> = Vec::new();
    let mut freed_bytes = 0u64;
    for v in names {
        let proof = verify_volume_in_store(&store, &arch, &v);
        if !proof.ok {
            let mut k = Map::new();
            k.insert("volume".into(), Value::from(v));
            k.insert("verified".into(), Value::from(proof.verified));
            k.insert("entries".into(), Value::from(proof.entries));
            k.insert("failedSample".into(), Value::Array(proof.failed.into_iter().take(5).map(Value::from).collect()));
            kept.push(Value::Object(k));
            continue;
        }
        let p = arch.join(&v);
        if let Ok(m) = std::fs::metadata(&p) {
            if std::fs::remove_file(&p).is_ok() {
                freed_bytes += m.len();
                removed.push(Value::from(v));
            } // raced — as in TS, silently not-removed
        }
    }
    println!(
        "alcore: bodies archive purge: removed {} verified volume(s) ({:.2}GB), kept {} unproven; .idx sidecars retained",
        removed.len(),
        freed_bytes as f64 / (1024u64.pow(3)) as f64,
        kept.len()
    );
    (200, json!({ "removed": removed, "kept": kept, "freedBytes": freed_bytes }))
}

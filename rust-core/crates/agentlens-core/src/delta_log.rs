//! Port of src/store/deltaLog.ts (TRDD-K3WDPR7M) for the P5e durable state (TRDD-DMWOBWFH):
//! a keyed record collection persisted as `<name>.snapshot.ndjson` + `<name>.delta.ndjson`,
//! appending ONLY what changed. The on-disk format is BYTE-COMPATIBLE with the TS engine —
//! `{"k":key,"v":record}` / `{"k":key,"d":1}` lines, later lines win, a tombstone deletes — so a
//! cutover restart reads either engine's files. (The per-key "last written" hash is in-memory
//! only, so it need not match TS's sha256; a 64-bit std hash of the serialized record is enough.)
//!
//! Durability rules carried over verbatim: an append is one write of complete lines, so load()
//! tolerates ONE torn TRAILING line and REFUSES a corrupt line anywhere else (that is real damage,
//! not a torn tail); compaction writes `<snapshot>.tmp`, re-reads it FROM DISK and verifies count +
//! every record before the rename, and deletes the delta only after the rename — a short or
//! corrupt snapshot write keeps the old snapshot AND the delta intact.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Write;
use std::path::{Path, PathBuf};

use indexmap::IndexMap;
use serde_json::Value;

/// Compact when the delta grows past this multiple of the snapshot …
pub const COMPACT_RATIO: f64 = 1.0;
/// … but always allow a small delta first, so a tiny snapshot does not compact on every append.
pub const COMPACT_MIN_BYTES: u64 = 256 * 1024;

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SaveResult {
    pub appended: usize,
    pub deleted: usize,
    /// Bytes actually written to the device — the number that matters.
    pub bytes: u64,
    pub compacted: bool,
}

pub struct DeltaLog {
    snapshot_path: PathBuf,
    delta_path: PathBuf,
    /// key → hash of the last SERIALIZED form persisted; what makes an unchanged save a no-op.
    written: IndexMap<String, u64>,
}

fn hash_json(s: &str) -> u64 {
    let mut h = DefaultHasher::new();
    s.hash(&mut h);
    h.finish()
}

fn size_of(p: &Path) -> u64 {
    fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/// TRDD-0R0NGVK6 — before any append, repair a delta whose last line has no '\n'. A kill or a
/// partial write mid-append can leave one; the next append would be glued onto it, and the glued
/// line, once another line follows, is a corrupt MID-FILE line every later load() refuses (for
/// log-offsets alcore then exits at every start). The repair follows replay's own rule: a
/// trailing fragment that does not decode as UTF-8 JSON is a torn tail replay already ignores,
/// so it is truncated away (nothing load() returned is dropped); a trailing line that IS a
/// complete record (under 16 MiB; a longer fragment is treated as torn) only lacks its '\n', so
/// a '\n' is appended instead. Whether a dropped torn record is persisted again depends on how
/// `written` was seeded: after load() (log-offsets on every start, log-sessions on a refused reuse,
/// body-links at boot) its key is absent and the next full save() re-appends it; after
/// seed_written (log-sessions' reuse path) the key is present and the record stays missing from
/// the snapshot pair until that card changes — the lag seed_written already documents
/// (cards.duckdb still holds it). Concurrency: appends to one delta are serialized in-process (the
/// sweeper thread for log-sessions/log-offsets, the state lock for body-links) and pid_lock gives
/// one server per data dir, so no append races the repair; the body-links SQL reader
/// (cache_turns_sql.rs install_body_links) reads through load(), which drops a torn tail exactly as
/// replay does, so the repair cannot make it worse. Checks the last byte first; block-scans
/// backwards only when needed.
fn heal_torn_tail(file: &Path) -> Result<(), String> {
    use std::io::{Read, Seek, SeekFrom};
    const BLOCK: u64 = 64 * 1024;
    // A trailing fragment at least this long is treated as torn without decoding it (bounded read).
    const MAX_DECODE: u64 = 16 * 1024 * 1024;
    let err = |e: std::io::Error| format!("{}: heal torn tail: {e}", file.display());
    let mut f = match fs::OpenOptions::new().read(true).write(true).open(file) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(err(e)),
    };
    let len = f.metadata().map_err(err)?.len();
    if len == 0 {
        return Ok(());
    }
    let mut last = [0u8; 1];
    f.seek(SeekFrom::Start(len - 1)).map_err(err)?;
    f.read_exact(&mut last).map_err(err)?;
    if last[0] == b'\n' {
        return Ok(()); // clean tail — the common case, one byte read
    }
    let mut buf = vec![0u8; BLOCK as usize];
    let mut end = len;
    let keep = loop {
        if end == 0 {
            break 0;
        }
        let start = end.saturating_sub(BLOCK);
        let n = (end - start) as usize;
        f.seek(SeekFrom::Start(start)).map_err(err)?;
        f.read_exact(&mut buf[..n]).map_err(err)?;
        if let Some(p) = buf[..n].iter().rposition(|b| *b == b'\n') {
            break start + p as u64 + 1;
        }
        end = start;
    };
    let frag_len = len - keep;
    if frag_len < MAX_DECODE {
        let mut frag = vec![0u8; frag_len as usize];
        f.seek(SeekFrom::Start(keep)).map_err(err)?;
        f.read_exact(&mut frag).map_err(err)?;
        let complete = std::str::from_utf8(&frag).ok().is_some_and(|s| serde_json::from_str::<Value>(s).is_ok());
        if complete {
            // A complete record missing only its '\n': replay returned it, so keep it.
            f.seek(SeekFrom::End(0)).map_err(err)?;
            f.write_all(b"\n").map_err(err)?;
            println!("{} alcore: delta-log: appended the missing newline after a complete last line of {}", crate::log_ts(), file.display());
            return Ok(());
        }
    }
    f.set_len(keep).map_err(err)?;
    println!("{} alcore: delta-log: healed torn tail of {} ({} byte(s) dropped)", crate::log_ts(), file.display(), frag_len);
    Ok(())
}

impl DeltaLog {
    pub fn new(dir: &Path, name: &str) -> DeltaLog {
        DeltaLog {
            snapshot_path: dir.join(format!("{name}.snapshot.ndjson")),
            delta_path: dir.join(format!("{name}.delta.ndjson")),
            written: IndexMap::new(),
        }
    }

    /// Read one NDJSON file: blank lines skipped, ONE torn trailing line tolerated, a corrupt line
    /// anywhere else is an error (the file is damaged — say so instead of silently dropping
    /// records the caller believes are persisted). A missing file is empty.
    ///
    /// TRDD-0R0NGVK6 — read BYTES and decode per line. The old `read_to_string(..) else empty`
    /// turned a torn multi-byte UTF-8 char at the tail (or ANY read error) into an empty file,
    /// silently dropping every record in it. Now only not-found is empty; any other error is Err,
    /// and a line that fails UTF-8 decoding takes the same torn-tail rule as one that fails JSON.
    /// Behaviour change: a permission or I/O error used to read as an empty file; it is now an Err —
    /// fail-fast for log-sessions/log-offsets (the start exits, naming the path), and body-links' boot
    /// path logs it and skips its compaction (it used to compact a silently-empty delta away).
    fn read_lines(file: &Path) -> Result<Vec<Value>, String> {
        let raw = match fs::read(file) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => return Err(format!("{}: {e}", file.display())),
        };
        let blank = |l: &[u8]| l.iter().all(u8::is_ascii_whitespace);
        let lines: Vec<&[u8]> = raw.split(|b| *b == b'\n').collect();
        let mut out = Vec::new();
        for (i, ln) in lines.iter().enumerate() {
            if blank(ln) {
                continue;
            }
            match std::str::from_utf8(ln).ok().and_then(|s| serde_json::from_str::<Value>(s).ok()) {
                Some(v) => out.push(v),
                None => {
                    if lines[i + 1..].iter().all(|l| blank(l)) {
                        break;
                    }
                    return Err(format!("{}: corrupt line {} (not a torn tail — the file is damaged)", file.display(), i + 1));
                }
            }
        }
        Ok(out)
    }

    /// Replay files in order into a fresh map — the ONE definition of "how lines become state",
    /// shared by load() and compaction's verify.
    fn replay(files: &[&Path]) -> Result<IndexMap<String, Value>, String> {
        let mut map = IndexMap::new();
        for file in files {
            for l in Self::read_lines(file)? {
                let Some(k) = l.get("k").and_then(Value::as_str) else { continue };
                if l.get("d").and_then(Value::as_u64) == Some(1) {
                    map.shift_remove(k);
                } else if let Some(v) = l.get("v") {
                    map.insert(k.to_owned(), v.clone());
                }
            }
        }
        Ok(map)
    }

    /// Snapshot, then deltas, later lines win. Seeds the written-hashes so the first save after a
    /// restart does not re-append every record.
    pub fn load(&mut self) -> Result<IndexMap<String, Value>, String> {
        let map = Self::replay(&[&self.snapshot_path, &self.delta_path])?;
        self.written = map.iter().map(|(k, v)| (k.clone(), hash_json(&serde_json::to_string(v).unwrap_or_default()))).collect();
        Ok(map)
    }


    /// TRDD-9VX3WTGU — seed the written-hashes from `records` WITHOUT reading the files, for a
    /// start that reused `cards.duckdb` and so has no reason to load (parse + re-serialize) the
    /// 72 MB snapshot. `records` must be exactly what the next `save` will compute, so an
    /// unchanged corpus costs zero bytes. Known gap, by design: a record the snapshot lags behind
    /// the database on (changed after the last pre-crash save) is not re-appended until it changes
    /// again — the snapshot is only the FALLBACK for a database that cannot be reused.
    pub fn seed_written(&mut self, records: &IndexMap<String, Value>) {
        self.written = records.iter().map(|(k, v)| (k.clone(), hash_json(&serde_json::to_string(v).unwrap_or_default()))).collect();
    }

    /// Rewrite the snapshot from `records`, VERIFY it from disk, then drop the delta.
    fn compact(&self, records: &IndexMap<String, Value>) -> Result<u64, String> {
        let mut body = String::new();
        for (k, v) in records {
            body.push_str(&serde_json::to_string(&serde_json::json!({ "k": k, "v": v })).unwrap_or_default());
            body.push('\n');
        }
        let tmp = PathBuf::from(format!("{}.tmp", self.snapshot_path.display()));
        fs::write(&tmp, &body).map_err(|e| format!("{}: {e}", tmp.display()))?;
        // PROVE the snapshot before committing to it: read the candidate BACK FROM DISK and confirm
        // it reproduces exactly the saved record set (count + every record).
        let reloaded = Self::replay(&[&tmp])?;
        let mismatch = if reloaded.len() != records.len() {
            Some(format!("holds {} records, expected {}", reloaded.len(), records.len()))
        } else {
            records.iter().find(|(k, v)| reloaded.get(*k) != Some(*v)).map(|(k, _)| format!("record {k:?} is not durable in the snapshot"))
        };
        if let Some(m) = mismatch {
            let _ = fs::remove_file(&tmp);
            return Err(format!("{}: compaction verify failed ({m}); delta KEPT, snapshot NOT replaced — no records lost", self.snapshot_path.display()));
        }
        fs::rename(&tmp, &self.snapshot_path).map_err(|e| format!("{}: rename: {e}", self.snapshot_path.display()))?;
        // Only AFTER the snapshot is durable AND verified.
        let _ = fs::remove_file(&self.delta_path);
        Ok(body.len() as u64)
    }

    /// The shared half of `save`/`append_changed`: appends the ndjson `{"k":...,"v":...}` line for
    /// every record whose hash changed (or is new), updates `self.written`, returns the body text
    /// plus how many lines were appended. Records whose hash is unchanged cost nothing — no line,
    /// no write.
    fn changed_lines(&mut self, records: &IndexMap<String, Value>) -> (String, usize) {
        let mut body = String::new();
        let mut appended = 0usize;
        for (k, v) in records {
            let json = serde_json::to_string(v).unwrap_or_default();
            let h = hash_json(&json);
            if self.written.get(k) == Some(&h) {
                continue; // unchanged — the whole saving
            }
            body.push_str(&format!("{{\"k\":{},\"v\":{json}}}\n", serde_json::to_string(k).unwrap_or_default()));
            self.written.insert(k.clone(), h);
            appended += 1;
        }
        (body, appended)
    }

    /// Persist `records`, writing ONLY what changed. Nothing changed ⇒ ZERO bytes written.
    /// `records` MUST be the FULL record set — deletion-diffing (below) and compaction both
    /// assume any key missing from `records` was deleted. A caller with only a subset must use
    /// `append_changed` instead.
    pub fn save(&mut self, records: &IndexMap<String, Value>) -> Result<SaveResult, String> {
        if let Some(dir) = self.snapshot_path.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let (mut body, appended) = self.changed_lines(records);
        let mut deleted = 0usize;
        let gone: Vec<String> = self.written.keys().filter(|k| !records.contains_key(*k)).cloned().collect();
        for k in gone {
            body.push_str(&format!("{{\"k\":{},\"d\":1}}\n", serde_json::to_string(&k).unwrap_or_default())); // tombstone
            self.written.shift_remove(&k);
            deleted += 1;
        }
        if body.is_empty() {
            return Ok(SaveResult::default());
        }
        let snap_bytes = size_of(&self.snapshot_path);
        let delta_bytes = size_of(&self.delta_path) + body.len() as u64;
        if delta_bytes > COMPACT_MIN_BYTES && delta_bytes as f64 > snap_bytes as f64 * COMPACT_RATIO {
            let bytes = self.compact(records)?;
            return Ok(SaveResult { appended, deleted, bytes, compacted: true });
        }
        // TRDD-0R0NGVK6: append branch only (compaction above rewrites the snapshot and removes the
        // delta). Cut a torn tail a kill mid-append left, or this body is glued onto it and becomes
        // a corrupt mid-file line every later load() refuses; replay already ignored the fragment.
        heal_torn_tail(&self.delta_path)?;
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.delta_path)
            .map_err(|e| format!("{}: {e}", self.delta_path.display()))?;
        f.write_all(body.as_bytes()).map_err(|e| format!("{}: {e}", self.delta_path.display()))?;
        Ok(SaveResult { appended, deleted, bytes: body.len() as u64, compacted: false })
    }

    /// TRDD-ORGJ0E3G follow-up — append-only persistence for a KNOWN SUBSET of records (e.g. one
    /// backfill chunk's patched cards), never the whole store. Unlike `save`, this NEVER
    /// deletion-diffs (`gone` needs the full key set — a caller passing only 200 of 30k cards
    /// would otherwise see every other card as "missing" and tombstone it) and NEVER compacts
    /// (`compact` rewrites the snapshot from exactly `records` — from a partial set that would
    /// discard everything else in the snapshot). Both stay correct because the periodic full
    /// `DurableState::tick()` → `save_cards()` still runs `save()` with the complete record set on
    /// its own cadence; this path only shortens how long a subset of fresh writes sits unflushed.
    pub fn append_changed(&mut self, records: &IndexMap<String, Value>) -> Result<SaveResult, String> {
        if let Some(dir) = self.snapshot_path.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let (body, appended) = self.changed_lines(records);
        if body.is_empty() {
            return Ok(SaveResult::default());
        }
        // TRDD-0R0NGVK6: same torn-tail heal as save()'s append branch — a kill mid-append must not
        // leave a fragment this body gets glued onto (a corrupt mid-file line load() refuses).
        heal_torn_tail(&self.delta_path)?;
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.delta_path)
            .map_err(|e| format!("{}: {e}", self.delta_path.display()))?;
        f.write_all(body.as_bytes()).map_err(|e| format!("{}: {e}", self.delta_path.display()))?;
        Ok(SaveResult { appended, deleted: 0, bytes: body.len() as u64, compacted: false })
    }

    /// TRDD-N6A8VX3G — unconditional compaction for boot, bypassing save()'s size gate: after
    /// load(), one verified snapshot rewrite drops the delta, bounding it to per-boot volume and
    /// healing a torn trailing line a hard kill can leave (read_lines tolerates ONE torn tail, and
    /// the body-links SQL consumer reads through load() too — cache_turns_sql.rs install_body_links —
    /// so this is cleanup, not a precondition for reading).
    /// No-op while the delta is empty: the snapshot already holds everything.
    pub fn compact_now(&mut self, records: &IndexMap<String, Value>) -> Result<u64, String> {
        if size_of(&self.delta_path) == 0 {
            return Ok(0);
        }
        self.compact(records)
    }
    /// Total bytes on disk (both files).
    pub fn disk_bytes(&self) -> u64 {
        size_of(&self.snapshot_path) + size_of(&self.delta_path)
    }
}

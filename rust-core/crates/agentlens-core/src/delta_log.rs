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
    fn read_lines(file: &Path) -> Result<Vec<Value>, String> {
        let Ok(raw) = fs::read_to_string(file) else { return Ok(Vec::new()) };
        let lines: Vec<&str> = raw.split('\n').collect();
        let mut out = Vec::new();
        for (i, ln) in lines.iter().enumerate() {
            if ln.trim().is_empty() {
                continue;
            }
            match serde_json::from_str::<Value>(ln) {
                Ok(v) => out.push(v),
                Err(_) => {
                    if lines[i + 1..].iter().all(|l| l.trim().is_empty()) {
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

    /// Persist `records`, writing ONLY what changed. Nothing changed ⇒ ZERO bytes written.
    pub fn save(&mut self, records: &IndexMap<String, Value>) -> Result<SaveResult, String> {
        if let Some(dir) = self.snapshot_path.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let mut body = String::new();
        let mut appended = 0usize;
        let mut deleted = 0usize;
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
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.delta_path)
            .map_err(|e| format!("{}: {e}", self.delta_path.display()))?;
        f.write_all(body.as_bytes()).map_err(|e| format!("{}: {e}", self.delta_path.display()))?;
        Ok(SaveResult { appended, deleted, bytes: body.len() as u64, compacted: false })
    }

    /// Total bytes on disk (both files).
    pub fn disk_bytes(&self) -> u64 {
        size_of(&self.snapshot_path) + size_of(&self.delta_path)
    }
}

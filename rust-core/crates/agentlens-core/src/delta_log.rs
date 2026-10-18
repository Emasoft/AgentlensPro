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

use std::borrow::Borrow;
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


/// TRDD-AJGTQ007 — a live key's winning line: (position of its file in the replay's file list,
/// byte offset of the line's first byte in that file).
type LineLoc = (usize, u64);

/// TRDD-AJGTQ007 — a replay file as pass 1 left it: its path (for messages), its handle (None =
/// not found = an empty file), and how many bytes pass 1 read. WHY keep the handle open for pass
/// 2: compaction renames a new snapshot over the old one and deletes the delta; the open handle
/// still reads the inode pass 1 indexed, so the offsets stay valid. WHY the length: pass 2 never
/// reads past it, so an append that lands between the passes is not half-seen.
struct ReplayFile {
    path: PathBuf,
    file: Option<fs::File>,
    len: u64,
}

/// TRDD-AJGTQ007 — pass 1's result: every replay file, plus live key → winning line in REPLAY
/// order. The order rule is the old map's: `insert` on a present key keeps its position, a
/// tombstone `shift_remove`s it, so a key re-inserted after its tombstone moves to the end.
struct ReplayIndex {
    files: Vec<ReplayFile>,
    live: IndexMap<String, LineLoc>,
}

impl ReplayIndex {
    /// Every winning line as (file, offset, replay position), sorted by (file, offset) so pass 2
    /// reads each file once, front to back. Two keys never share a line, so no ties.
    fn winners(&self) -> Vec<(usize, u64, usize)> {
        let mut w: Vec<(usize, u64, usize)> = self.live.values().enumerate().map(|(i, &(f, o))| (f, o, i)).collect();
        w.sort_unstable();
        w
    }
}

/// The 64 KiB read buffer each replay pass streams a file through.
const REPLAY_BUF: usize = 64 * 1024;

fn is_blank(l: &[u8]) -> bool {
    l.iter().all(u8::is_ascii_whitespace)
}

/// One NDJSON line as the replay rule reads it: UTF-8, then a whole-line `Value` parse. WHY a full
/// `Value` and not a borrowed `{k, d}` header with `v` ignored (TRDD-AJGTQ007): this parse IS the
/// corrupt-line test, and serde's ignore path skips checks the `Value` parse makes (it accepts a
/// lone UTF-16 surrogate escape, which `Value` refuses), so a header would accept lines the old
/// replay called damaged. The `Value` lives for one line only, so the memory goal is unaffected.
fn parse_line(ln: &[u8]) -> Option<Value> {
    std::str::from_utf8(ln).ok().and_then(|s| serde_json::from_str::<Value>(s).ok())
}


/// TRDD-1RJBOEI1 — a compaction's `<snapshot>.tmp`, written ONE record at a time through a
/// 64 KiB buffer. WHY: compaction used to build the whole snapshot body as one String before
/// fs::write (271 MB at 700k body-links records) on top of the records it was given; streaming
/// keeps compaction's own write footprint at one serialized record.
struct TmpSnapshot {
    path: PathBuf,
    w: std::io::BufWriter<fs::File>,
    bytes: u64,
}

impl TmpSnapshot {
    /// Create (or truncate) `<snapshot>.tmp`, as fs::write did.
    fn create(snapshot: &Path) -> Result<TmpSnapshot, String> {
        let path = PathBuf::from(format!("{}.tmp", snapshot.display()));
        let f = fs::File::create(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(TmpSnapshot { path, w: std::io::BufWriter::with_capacity(REPLAY_BUF, f), bytes: 0 })
    }

    /// Append `{"k":<key>,"v":<json>}\n`, `json` being `serde_json::to_string(v)`. WHY spelled out
    /// and not `to_string(&json!({"k": k, "v": v}))`: that cloned every `v`; this writes the same
    /// bytes (compact formatter, `k` before `v`), which the byte-for-byte compaction test pins.
    fn push(&mut self, k: &str, json: &str) -> Result<(), String> {
        let key = serde_json::to_string(k).unwrap_or_default();
        let io = |e: std::io::Error| format!("{}: {e}", self.path.display());
        for part in [b"{\"k\":".as_slice(), key.as_bytes(), b",\"v\":", json.as_bytes(), b"}\n"] {
            self.w.write_all(part).map_err(io)?;
            self.bytes += part.len() as u64;
        }
        Ok(())
    }

    /// Flush, SYNC (TRDD-O8MGRU72) and CLOSE the file (an unflushed buffer would make the from-disk
    /// verify read a short file, and Windows will not rename a file that is still open). Returns
    /// (path, bytes written).
    fn finish(self) -> Result<(PathBuf, u64), String> {
        let TmpSnapshot { path, w, bytes } = self;
        let f = match w.into_inner() {
            Ok(f) => f,
            Err(e) => {
                let m = format!("{}: {}", path.display(), e.error());
                // TRDD-1RJBOEI1: a failed flush is a failed write — close the file, then remove it, so
                // no stray `<snapshot>.tmp` is left behind.
                drop(e);
                let _ = fs::remove_file(&path);
                return Err(m);
            }
        };
        // TRDD-O8MGRU72: SYNC before the file is closed and returned. The data must be on stable
        // storage BEFORE commit_verified renames it over the snapshot and deletes the delta: the
        // from-disk verify can be served from the page cache, so it proves nothing about the device,
        // and a power loss right after the rename could otherwise leave an empty or partial snapshot
        // as the only copy. On macOS std issues F_FULLFSYNC here (a drive-cache flush, not just
        // fsync). A failed sync is a failed write: close the file, remove it, Err.
        if let Err(e) = f.sync_all() {
            let m = format!("{}: sync: {e}", path.display());
            drop(f);
            let _ = fs::remove_file(&path);
            return Err(m);
        }
        Ok((path, bytes))
    }

    /// TRDD-1RJBOEI1 — abandon a compaction whose write or source failed: close the file and remove
    /// `<snapshot>.tmp`. A TmpSnapshot never touches the old snapshot or the delta, so they stay intact.
    fn discard(self) {
        let TmpSnapshot { path, w, .. } = self;
        drop(w);
        let _ = fs::remove_file(path);
    }
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
/// (cache_turns_sql.rs install_body_links) reads through for_each_live, the same replay as load(), which drops a torn tail exactly as
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


/// TRDD-O8MGRU72 — true when a directory sync failed because the FILESYSTEM cannot sync a
/// directory (some network, FUSE and exFAT mounts), not because the sync itself failed. WHY a
/// separate function: commit_verified treats only this class as "durability not provable here,
/// proceed"; the unit tests pin the classification without a production fault hook.
#[cfg(unix)]
fn dir_sync_unsupported(e: &std::io::Error) -> bool {
    e.kind() == std::io::ErrorKind::Unsupported || matches!(e.raw_os_error(), Some(c) if c == libc::EINVAL || c == libc::ENOTSUP || c == libc::EOPNOTSUPP)
}

impl DeltaLog {
    pub fn new(dir: &Path, name: &str) -> DeltaLog {
        DeltaLog {
            snapshot_path: dir.join(format!("{name}.snapshot.ndjson")),
            delta_path: dir.join(format!("{name}.delta.ndjson")),
            written: IndexMap::new(),
        }
    }

    /// Pass 1 of the replay (TRDD-AJGTQ007): stream each file line by line, never collecting, and
    /// index live key → winning line. It is also the VALIDATION pass, with read_lines' old rules:
    /// blank lines skipped, ONE torn trailing line tolerated per file, a corrupt line anywhere else
    /// an Err, so a damaged file fails before pass 2 hands anyone a record. A missing file is empty.
    ///
    /// TRDD-0R0NGVK6 — decode bytes per line: a line that fails UTF-8 takes the same torn-tail rule
    /// as one that fails JSON, only not-found is empty, and any other open or read error is an Err
    /// (a permission or I/O error used to read as an empty file, silently dropping its records).
    /// WHY stream (TRDD-AJGTQ007): the old read_lines held the whole file plus a parsed `Value` of
    /// EVERY line, and replay then cloned each `v` into the map, about 7x the on-disk size at the
    /// peak (1993 MiB for a 271 MB body-links log, docs_dev/20261016-gva8ttjf-memory-gate-report.md).
    fn index_files(files: &[&Path]) -> Result<ReplayIndex, String> {
        use std::io::{BufRead, BufReader};
        let mut ix = ReplayIndex { files: Vec::with_capacity(files.len()), live: IndexMap::new() };
        for (fi, path) in files.iter().enumerate() {
            let file = match fs::File::open(path) {
                Ok(f) => f,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                    ix.files.push(ReplayFile { path: path.to_path_buf(), file: None, len: 0 });
                    continue;
                }
                Err(e) => return Err(format!("{}: {e}", path.display())),
            };
            let io = |e: std::io::Error| format!("{}: {e}", path.display());
            let mut rd = BufReader::with_capacity(REPLAY_BUF, &file);
            let mut buf = Vec::new();
            let (mut off, mut line_no) = (0u64, 0usize);
            let mut torn: Option<usize> = None;
            loop {
                buf.clear();
                let n = rd.read_until(b'\n', &mut buf).map_err(io)?;
                if n == 0 {
                    break;
                }
                line_no += 1;
                let start = off;
                off += n as u64;
                let ln = buf.strip_suffix(b"\n").unwrap_or(&buf);
                if is_blank(ln) {
                    continue;
                }
                // A bad line is tolerated only when nothing but blank lines follows it.
                if let Some(bad) = torn {
                    return Err(format!("{}: corrupt line {bad} (not a torn tail — the file is damaged)", path.display()));
                }
                let Some(l) = parse_line(ln) else {
                    torn = Some(line_no);
                    continue;
                };
                // The replay rule itself, unchanged: a line without a string `k` is ignored, `d`
                // equal to 1 deletes, otherwise a present `v` (even null) wins.
                let Some(k) = l.get("k").and_then(Value::as_str) else { continue };
                if l.get("d").and_then(Value::as_u64) == Some(1) {
                    ix.live.shift_remove(k);
                } else if l.get("v").is_some() {
                    match ix.live.get_mut(k) {
                        Some(loc) => *loc = (fi, start),
                        None => {
                            ix.live.insert(k.to_owned(), (fi, start));
                        }
                    }
                }
            }
            drop(rd);
            ix.files.push(ReplayFile { path: path.to_path_buf(), file: Some(file), len: off });
        }
        Ok(ix)
    }

    /// Pass 2 of the replay (TRDD-AJGTQ007): re-read each file front to back, only up to pass 1's
    /// length, and hand each WINNING line's `v` to `f(replay position, key, v)` by move, in
    /// (file, offset) order. Superseded and tombstoned lines are skipped unparsed, and nothing is
    /// kept: the peak is pass 1's index plus whatever `f` keeps. Every winner reaches `f` exactly
    /// once, or this is an Err.
    fn visit_winners(
        files: &[ReplayFile],
        winners: &[(usize, u64, usize)],
        mut f: impl FnMut(usize, String, Value) -> Result<(), String>,
    ) -> Result<(), String> {
        use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
        let mut next = winners.iter().peekable();
        for (fi, rf) in files.iter().enumerate() {
            if next.peek().is_none_or(|w| w.0 != fi) {
                continue; // no winner in this file: do not read it again
            }
            let Some(file) = rf.file.as_ref() else {
                return Err(format!("{}: pass 2 found no handle for a file pass 1 indexed", rf.path.display()));
            };
            let io = |e: std::io::Error| format!("{}: {e}", rf.path.display());
            let mut fr: &fs::File = file;
            fr.seek(SeekFrom::Start(0)).map_err(io)?;
            let mut rd = BufReader::with_capacity(REPLAY_BUF, fr.take(rf.len));
            let mut buf = Vec::new();
            let mut off = 0u64;
            while let Some(&&(wf, woff, pos)) = next.peek() {
                if wf != fi {
                    break;
                }
                buf.clear();
                let n = rd.read_until(b'\n', &mut buf).map_err(io)?;
                let start = off;
                off += n as u64;
                if n == 0 || start > woff {
                    return Err(format!("{}: the line at byte {woff} that pass 1 indexed is gone", rf.path.display()));
                }
                if start < woff {
                    continue;
                }
                next.next();
                let ln = buf.strip_suffix(b"\n").unwrap_or(&buf);
                let changed = || format!("{}: the line at byte {woff} changed after pass 1 indexed it", rf.path.display());
                let Some(Value::Object(mut l)) = parse_line(ln) else { return Err(changed()) };
                let Some(Value::String(k)) = l.remove("k") else { return Err(changed()) };
                let Some(v) = l.remove("v") else { return Err(changed()) };
                f(pos, k, v)?;
            }
        }
        match next.next() {
            Some(&(wf, woff, _)) => Err(format!("{}: the line at byte {woff} that pass 1 indexed was never reached", files[wf].path.display())),
            None => Ok(()),
        }
    }

    /// Replay files in order into a fresh map — the ONE definition of "how lines become state",
    /// used only by load(). for_each_live and compaction's verify (commit_verified) call index_files
    /// and visit_winners directly, the same two passes. TRDD-AJGTQ007: built on the two
    /// streaming passes, so the map holds each live record ONCE. WHY placeholders: pass 1 fixes
    /// the order, pass 2 delivers values in file order (not the same: insert a, insert b, update a
    /// is order a, b but file order b, a), so each value is dropped into its slot by position.
    fn replay(files: &[&Path]) -> Result<IndexMap<String, Value>, String> {
        let ix = Self::index_files(files)?;
        let winners = ix.winners();
        let ReplayIndex { files, live } = ix;
        let mut map: IndexMap<String, Value> = live.into_keys().map(|k| (k, Value::Null)).collect();
        Self::visit_winners(&files, &winners, |pos, k, v| {
            let Some((key, slot)) = map.get_index_mut(pos) else { return Err(format!("replay position {pos} out of range")) };
            if *key != k {
                return Err(format!("replay position {pos} holds {key:?}, the winning line says {k:?}"));
            }
            *slot = v;
            Ok(())
        })?;
        Ok(map)
    }

    /// TRDD-AJGTQ007 — stream every live record of [snapshot, delta] to `f(key, v)` WITHOUT
    /// building the map: the same two passes as `replay`, so the same last-wins, tombstone and
    /// torn-tail rules, but the records arrive in file and line order of their winning lines, not
    /// in replay order, and `self.written` is not touched. For a consumer that copies records
    /// elsewhere (cache_turns_sql.rs install_body_links). Returns how many records it visited.
    pub fn for_each_live(&self, mut f: impl FnMut(&str, Value) -> Result<(), String>) -> Result<usize, String> {
        let ix = Self::index_files(&[&self.snapshot_path, &self.delta_path])?;
        let winners = ix.winners();
        Self::visit_winners(&ix.files, &winners, |pos, k, v| {
            if ix.live.get_index(pos).map(|(key, _)| key.as_str()) != Some(k.as_str()) {
                return Err(format!("replay position {pos} does not hold {k:?}"));
            }
            f(&k, v)
        })?;
        Ok(ix.live.len())
    }

    /// Snapshot, then deltas, later lines win. Seeds the written-hashes so the first save after a
    /// restart does not re-append every record.
    ///
    /// TRDD-AJGTQ007: the replay underneath streams (index_files, then visit_winners), so the peak
    /// is the returned map plus a key index, not the files' bytes plus every line's `Value` plus a
    /// clone of each `v`. WHY the seeding still re-serializes each record: save(empty) tombstones
    /// only the keys seeded here, which the TRDD-6B7VV2Z7 fix relies on, and a hash of
    /// `serde_json::to_string(v)` is exactly what changed_lines compares against. The `v` handed
    /// over is the same parser's output from the same bytes as before, so the hashes are
    /// byte-identical to the old load's; hashing the raw line bytes instead would not be (key order
    /// and number spelling can differ from what to_string prints).
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
    ///
    /// TRDD-2JOIAH2G: takes a stream, not a map. WHY: the caller used to build every stripped card
    /// into an IndexMap first, a full copy of the corpus that was live at the same time as the
    /// resident layer (~540 MB committed at restore, measured); now each record is hashed and
    /// dropped before the next is built. A key that appears twice keeps its FIRST position and its
    /// LAST value's hash — what collecting into the IndexMap gave.
    pub fn seed_written(&mut self, records: impl IntoIterator<Item = (String, Value)>) {
        self.written = records.into_iter().map(|(k, v)| {
            let h = hash_json(&serde_json::to_string(&v).unwrap_or_default());
            (k, h)
        }).collect();
    }

    /// Rewrite the snapshot from `records`, VERIFY it from disk, then drop the delta.
    ///
    /// TRDD-1RJBOEI1: streams. Each record is serialized and written on its own (TmpSnapshot), and
    /// the verify re-indexes the file instead of replaying it into a second map, so compaction adds
    /// about one key index to the `records` the caller already holds — it used to add the whole
    /// body as a String plus a full second map (3337 MiB peak at 700k body-links records,
    /// docs_dev/20261017-ajgtq007-streaming-report.md). Same contract as before: the snapshot is
    /// exactly `records`, in its order (save() calls this BEFORE its changed lines reach the delta,
    /// so `records`, not the files, is the source of truth here).
    ///
    /// TRDD-2JOIAH2G: `records` is an iterator (save_from's pass 2), consumed once, so its records
    /// are never collected (save_cards used to build every stripped card into a map first, a full
    /// copy of the corpus every 300 s and at shutdown). `expected` is how many records the caller's
    /// previous pass over the same source saw; a different count here means the source changed
    /// between the passes, so the snapshot is refused before the verify. WHY the verify compares
    /// a (key hash, value hash) pair recorded while writing, not the records: there is no second
    /// iteration to compare against (each one rebuilds every record), and compact_from_disk already
    /// verifies by hash. 16 bytes per record, no key or value cloned. A key repeated in `records`
    /// is written twice, replays as one, and so fails the verify's count check: Err, delta kept.
    fn compact<K: AsRef<str>, V: Borrow<Value>>(&self, records: impl Iterator<Item = (K, V)>, expected: usize) -> Result<u64, String> {
        let mut tmp = TmpSnapshot::create(&self.snapshot_path)?;
        let mut sums: Vec<(u64, u64)> = Vec::with_capacity(expected);
        for (k, v) in records {
            let (k, v): (&str, &Value) = (k.as_ref(), v.borrow());
            let json = serde_json::to_string(v).unwrap_or_default();
            // TRDD-1RJBOEI1: a failed write removes `<snapshot>.tmp` before returning; a bare `?`
            // here used to leave the half-written temp file next to the snapshot.
            if let Err(e) = tmp.push(k, &json) {
                tmp.discard();
                return Err(e);
            }
            sums.push((hash_json(k), hash_json(&json)));
        }
        if sums.len() != expected {
            tmp.discard();
            return Err(format!("{}: compaction saw {} records, the pass before it saw {expected}; delta KEPT, snapshot NOT replaced", self.snapshot_path.display(), sums.len()));
        }
        let (tmp, bytes) = tmp.finish()?;
        self.commit_verified(&tmp, sums.len(), |pos, k, v| sums.get(pos) == Some(&(hash_json(k), hash_json(&serde_json::to_string(v).unwrap_or_default()))))?;
        Ok(bytes)
    }


    /// PROVE the candidate before committing to it, then commit: re-read `tmp` BACK FROM DISK and
    /// confirm it holds exactly `keys` (count, every key, in order) and that `same(pos, v)` holds
    /// for every record's value as parsed back. Only then rename it over the snapshot, and only
    /// AFTER the rename delete the delta — a short or corrupt write keeps the old snapshot AND the
    /// delta intact.
    ///
    /// TRDD-1RJBOEI1: the read-back is the replay's own two passes (index_files, then visit_winners)
    /// over `tmp`, so the verify holds one key index, never a second record map, and checks the
    /// same parse and torn-tail rules a later load() applies. WHY a torn or corrupt `tmp` now counts
    /// as a failed verify (it used to return the replay error and leave `tmp` behind): it IS a
    /// failed verify, and the old snapshot and delta are untouched either way.
    ///
    /// TRDD-2JOIAH2G: `expected` (a count) and `same(pos, key, v)` replace an ordered key list,
    /// because the streamed compact() has no key list to hand over (it keeps one hash pair per
    /// record instead of cloning the keys). WHY that is still the old "every key, in order" check:
    /// the count matches, and visit_winners hands every winner over exactly once with its replay
    /// position, so `same` judges each position's key and value once.
    fn commit_verified(
        &self,
        tmp: &Path,
        expected: usize,
        mut same: impl FnMut(usize, &str, &Value) -> bool,
    ) -> Result<(), String> {
        let verified = (|| -> Result<(), String> {
            let ix = Self::index_files(&[tmp])?;
            if ix.live.len() != expected {
                return Err(format!("holds {} records, expected {expected}", ix.live.len()));
            }
            let winners = ix.winners();
            Self::visit_winners(&ix.files, &winners, |pos, k, v| if same(pos, &k, &v) { Ok(()) } else { Err(format!("record {k:?} is not durable in the snapshot")) })
            // `ix` drops here, closing `tmp` before the rename (Windows refuses to rename an open file).
        })();
        if let Err(m) = verified {
            let _ = fs::remove_file(tmp);
            return Err(format!("{}: compaction verify failed ({m}); delta KEPT, snapshot NOT replaced — no records lost", self.snapshot_path.display()));
        }
        fs::rename(tmp, &self.snapshot_path).map_err(|e| format!("{}: rename: {e}", self.snapshot_path.display()))?;
        // TRDD-O8MGRU72: make the RENAME durable before the delta, the only other copy, is deleted.
        // finish() synced the file contents; the rename itself is a directory entry change that can
        // still be lost on a power loss until the parent directory is synced. On Linux fsync on a
        // read-only directory fd is the documented way; on macOS std issues F_FULLFSYNC, which APFS
        // accepts on a directory fd (observed in the delta_log tests on this machine). A failed
        // directory sync returns Err and KEEPS the delta (never delete the only other copy while
        // durability is unproven), except where the filesystem cannot sync a directory at all (see
        // dir_sync_unsupported). What a later load() then sees: from compact_from_disk, the same
        // records (the snapshot is the replay of snapshot + that delta); from compact() via save(),
        // every key at either its new value or the value its last delta line holds, never a
        // fabricated record: the same "this save did not persist" outcome a failed verify already
        // has, and save() returns the Err.
        //
        // WHY unix-only: Windows is not a release target (publish.yml builds no win32 leg; see the
        // comment there on why win32-x64 is absent, near publish.yml:219), and Windows has no
        // portable directory fsync (a directory handle needs FILE_FLAG_BACKUP_SEMANTICS, and
        // FlushFileBuffers on it is not a documented durability guarantee).
        #[cfg(unix)]
        {
            let dir = match self.snapshot_path.parent() {
                Some(d) if !d.as_os_str().is_empty() => d,
                _ => Path::new("."),
            };
            let d = fs::File::open(dir).map_err(|e| format!("{}: open for directory sync after compaction failed ({e}); snapshot replaced, delta KEPT", dir.display()))?;
            if let Err(e) = d.sync_all() {
                // WHY tolerate these and only these: some network, FUSE and exFAT mounts reject
                // fsync on a directory outright (EINVAL / ENOTSUP / EOPNOTSUPP). There it fails on
                // EVERY compaction, so keeping the delta would make it grow without bound while
                // durability can never be proven there anyway. Any other error (EIO and the like)
                // is a real failure on a filesystem that does sync directories: Err, delta KEPT.
                if !dir_sync_unsupported(&e) {
                    return Err(format!("{}: directory sync after compaction failed ({e}); snapshot replaced, delta KEPT", dir.display()));
                }
                eprintln!("{} alcore: {}: directory sync not supported by this filesystem ({e}); rename durability not provable here, removing the delta anyway", crate::log_ts(), dir.display());
            }
        }
        // Only AFTER the snapshot is durable AND verified.
        let _ = fs::remove_file(&self.delta_path);
        Ok(())
    }

    /// TRDD-1RJBOEI1 — the body-links boot step: what `load()` then `compact_now(&records)` did,
    /// without ever holding the record map. Seeds `self.written` exactly as load() does (same
    /// hashes, same replay order) and, when the delta is non-empty, rewrites the snapshot from the
    /// streaming replay, verified from disk like every compaction. Returns the snapshot bytes
    /// written (0 when the delta was empty).
    ///
    /// WHY it exists: log_reader.rs restore ran load() + compact_now at every boot, and load()'s
    /// map alone is 1564 MiB at 700k records, so no change inside compact() could bring that boot
    /// under alcore's 2048 MiB cap with room to spare (docs_dev/20261017-ajgtq007-streaming-report.md).
    ///
    /// It reads the winners in REPLAY order (one relative seek per record), not in visit_winners'
    /// file order. WHY: the snapshot must come out in the order load()'s map had (insert a, insert b,
    /// update a is order a, b but file order b, a), or every later load() order — and the bytes of
    /// the snapshot — would change. The cost of that order: the reads are sequential only for a log
    /// whose keys are never superseded, as in body-links (one line per key, unique per pointer),
    /// where each seek is a move inside the 64 KiB buffer. In a heavily updated log such as
    /// log-sessions a winner sits wherever its last update landed, so replay order seeks back and
    /// forth through both files and every jump outside the buffer is a real seek plus a refill. Do
    /// NOT use it there: it is built for body-links only.
    ///
    /// Failure semantics:
    /// - the source does not replay (load() would fail), or `<snapshot>.tmp` cannot be created or
    ///   written: Err at the first error, `written` untouched, `<snapshot>.tmp` removed, the old
    ///   snapshot and the delta in place;
    /// - the final flush, the sync (TRDD-O8MGRU72) or the from-disk verify fails: Err with `written`
    ///   already seeded (as load() succeeding, then compact_now failing), `<snapshot>.tmp` removed,
    ///   the old snapshot and the delta in place;
    /// - the directory sync after the rename fails (TRDD-O8MGRU72): Err with the new snapshot
    ///   installed and the delta KEPT; the next load() replays the same records from both.
    ///
    /// WHY a write error leaves `written` unseeded: body-links' only writer is append_changed with
    /// keys unique per pointer, so a missing hash costs at most one re-append of a record that is
    /// ingested again; reading the rest of the source to seed it would only feed a file about to be
    /// removed.
    pub fn compact_from_disk(&mut self) -> Result<u64, String> {
        use std::io::{BufRead, BufReader, Seek, SeekFrom};
        let delta_empty = size_of(&self.delta_path) == 0;
        let ix = Self::index_files(&[&self.snapshot_path, &self.delta_path])?;
        let mut written: IndexMap<String, u64> = IndexMap::with_capacity(ix.live.len());
        let mut readers: Vec<Option<(BufReader<&fs::File>, u64)>> = Vec::with_capacity(ix.files.len());
        for rf in &ix.files {
            readers.push(match rf.file.as_ref() {
                Some(file) => {
                    let mut fr: &fs::File = file;
                    fr.seek(SeekFrom::Start(0)).map_err(|e| format!("{}: {e}", rf.path.display()))?;
                    Some((BufReader::with_capacity(REPLAY_BUF, fr), 0))
                }
                None => None,
            });
        }
        // Created only after every `?` above, so no early return can leave it behind; a failed
        // create returns before anything is read.
        let mut out: Option<TmpSnapshot> = if delta_empty { None } else { Some(TmpSnapshot::create(&self.snapshot_path)?) };
        let mut buf = Vec::new();
        // The replay in a closure so that any error, read or write, can remove `tmp` below.
        let replayed = (|| -> Result<(), String> {
            for (key, &(fi, off)) in &ix.live {
                let rf = &ix.files[fi];
                let Some((rd, at)) = readers[fi].as_mut() else {
                    return Err(format!("{}: compaction found no handle for a file pass 1 indexed", rf.path.display()));
                };
                let io = |e: std::io::Error| format!("{}: {e}", rf.path.display());
                // A relative seek keeps the buffer when the line is already in it (the common case).
                rd.seek_relative(off as i64 - *at as i64).map_err(io)?;
                buf.clear();
                let n = rd.read_until(b'\n', &mut buf).map_err(io)?;
                *at = off + n as u64;
                // Never past pass 1's length, like visit_winners: an append after pass 1 is not seen.
                buf.truncate(rf.len.saturating_sub(off) as usize);
                let ln = buf.strip_suffix(b"\n").unwrap_or(&buf);
                let changed = || format!("{}: the line at byte {off} changed after pass 1 indexed it", rf.path.display());
                let Some(Value::Object(mut l)) = parse_line(ln) else { return Err(changed()) };
                if l.get("k").and_then(Value::as_str) != Some(key.as_str()) {
                    return Err(changed());
                }
                let Some(v) = l.remove("v") else { return Err(changed()) };
                let json = serde_json::to_string(&v).unwrap_or_default();
                // TRDD-1RJBOEI1: a write error stops the pass HERE. It used to keep reading every
                // remaining record to seed `written` and then leave `<snapshot>.tmp` behind.
                if let Some(t) = out.as_mut() {
                    t.push(key, &json)?;
                }
                written.insert(key.clone(), hash_json(&json));
            }
            Ok(())
        })();
        if let Err(e) = replayed {
            // `written` stays untouched and the half-written `tmp` is removed — the old snapshot and
            // the delta were never touched.
            if let Some(t) = out.take() {
                t.discard();
            }
            return Err(e);
        }
        // Close the source handles before the rename and the delta delete (Windows).
        drop(readers);
        drop(ix);
        self.written = written;
        let Some(tmp) = out else { return Ok(0) };
        let (tmp, bytes) = tmp.finish()?;
        let written = &self.written;
        self.commit_verified(&tmp, written.len(), |pos, k, v| {
            // WHY a hash and not the record: there is no record map here, by design. The seeded hash
            // is of `to_string(v)` as written; the parsed-back `v` must serialize to the same bytes.
            written.get_index(pos).is_some_and(|(key, h)| key == k && *h == hash_json(&serde_json::to_string(v).unwrap_or_default()))
        })?;
        Ok(bytes)
    }

    /// The shared half of `save`/`append_changed`: appends the ndjson `{"k":...,"v":...}` line for
    /// every record whose hash changed (or is new), updates `self.written`, returns the body text
    /// plus how many lines were appended. Records whose hash is unchanged cost nothing — no line,
    /// no write.
    fn changed_lines(&mut self, records: &IndexMap<String, Value>) -> (String, usize) {
        let mut body = String::new();
        let mut appended = 0usize;
        for (k, v) in records {
            if self.note_record(k, v, &mut body).1 {
                appended += 1;
            }
        }
        (body, appended)
    }

    /// One record of `changed_lines` / `save_from`'s pass 1: hash its serialized form and, when the
    /// hash differs from `written` (or the key is new), push its `{"k":...,"v":...}` line onto `body`
    /// and record the new hash. Returns (the key's index in `written`, whether a line was pushed).
    /// TRDD-2JOIAH2G: one definition shared by both, so the streamed save cannot drift from
    /// append_changed in line format or in when `written` changes. WHY `written` is updated here,
    /// BEFORE the line reaches the disk: today's semantics, kept — a failed write leaves the record
    /// marked written, so it is not re-appended until it changes again.
    fn note_record(&mut self, k: &str, v: &Value, body: &mut String) -> (usize, bool) {
        let json = serde_json::to_string(v).unwrap_or_default();
        let h = hash_json(&json);
        let i = match self.written.get_full_mut(k) {
            Some((i, _, slot)) if *slot == h => return (i, false), // unchanged — the whole saving
            Some((i, _, slot)) => {
                *slot = h;
                i
            }
            None => self.written.insert_full(k.to_owned(), h).0,
        };
        body.push_str(&format!("{{\"k\":{},\"v\":{json}}}\n", serde_json::to_string(k).unwrap_or_default()));
        (i, true)
    }

    /// Persist `records`, writing ONLY what changed. Nothing changed ⇒ ZERO bytes written.
    /// `records` MUST be the FULL record set — deletion-diffing (below) and compaction both
    /// assume any key missing from `records` was deleted. A caller with only a subset must use
    /// `append_changed` instead.
    pub fn save(&mut self, records: &IndexMap<String, Value>) -> Result<SaveResult, String> {
        // TRDD-2JOIAH2G: the map is iterated BORROWED, twice at most — no key or value cloned.
        self.save_from(|| records.iter())
    }

    /// TRDD-2JOIAH2G — `save` over a record SOURCE instead of a map: `records()` yields the FULL
    /// record set, the same set in the same order every time it is called. WHY: save_cards used to
    /// build every stripped card into an IndexMap before saving, a full copy of the corpus held
    /// every 300 s and at shutdown (inferred, docs_dev/20261018_1210-measure-streaming-save.md); a
    /// source lets each record be built, hashed and dropped one at a time. Same contract as `save`
    /// (a missing key is a deletion), same bytes on disk for the same records.
    ///
    /// Pass 1 (`records()`): each record through `note_record`, as `changed_lines` does. Deletions
    /// are found without cloning a key: `seen` marks every pre-existing `written` index a record
    /// hit; a key first inserted in pass 1 lands at an index >= the original length and is never a
    /// deletion candidate. The unseen original keys are tombstoned in `written` order, as before.
    /// Pass 2 (`records()` again) happens only when the save compacts, and streams into compact().
    /// The keys must be unique: both callers guarantee it (an IndexMap; the card store's resident
    /// layer, keyed by the same sessionId-or-"" rule persist_record uses), and a repeated key makes
    /// the compaction verify fail (Err, delta kept) instead of writing a wrong snapshot.
    ///
    /// Out of scope, as before: on a mass change `body` still holds every changed line in memory.
    pub fn save_from<F, I, K, V>(&mut self, records: F) -> Result<SaveResult, String>
    where
        F: Fn() -> I,
        I: Iterator<Item = (K, V)>,
        K: AsRef<str>,
        V: Borrow<Value>,
    {
        if let Some(dir) = self.snapshot_path.parent() {
            fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let original = self.written.len();
        let mut seen = vec![false; original];
        let mut body = String::new();
        let (mut appended, mut count) = (0usize, 0usize);
        for (k, v) in records() {
            let v: &Value = v.borrow();
            let (i, pushed) = self.note_record(k.as_ref(), v, &mut body);
            if i < original {
                // WHY: keys must be unique (doc above); a repeated key must fail loudly in tests, not only at compaction's count check.
                debug_assert!(!seen[i], "save_from: key {:?} repeated in records", k.as_ref());
                seen[i] = true;
            }
            appended += usize::from(pushed);
            count += 1;
        }
        let mut deleted = 0usize;
        // `zip` stops at `seen`'s end, so only the original keys are candidates.
        for ((k, _), _) in self.written.iter().zip(&seen).filter(|(_, s)| !**s) {
            body.push_str(&format!("{{\"k\":{},\"d\":1}}\n", serde_json::to_string(k).unwrap_or_default())); // tombstone
            deleted += 1;
        }
        if deleted > 0 {
            // One ordered pass; pass 1 only appended, so index `i` here is the original index `i`.
            let mut i = 0usize;
            self.written.retain(|_, _| {
                let keep = i >= original || seen[i];
                i += 1;
                keep
            });
        }
        if body.is_empty() {
            return Ok(SaveResult::default());
        }
        let snap_bytes = size_of(&self.snapshot_path);
        let delta_bytes = size_of(&self.delta_path) + body.len() as u64;
        if delta_bytes > COMPACT_MIN_BYTES && delta_bytes as f64 > snap_bytes as f64 * COMPACT_RATIO {
            // Pass 2. `count` is pass 1's: compact() refuses a pass 2 that sees a different number.
            let bytes = self.compact(records(), count)?;
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

    /// TRDD-N6A8VX3G — unconditional compaction of a caller-supplied record map, bypassing save()'s
    /// size gate. On Ok the snapshot holds exactly `records`, verified from disk, and the delta file
    /// is gone; that also heals a torn trailing line a hard kill can leave (replay tolerates ONE
    /// torn tail, and the body-links SQL consumer reads through the same replay — cache_turns_sql.rs
    /// install_body_links, via for_each_live — so this is cleanup, not a precondition for reading).
    /// It bounds the delta only as often as its caller calls it; boot uses compact_from_disk.
    /// No-op while the delta is empty: the snapshot already holds everything.
    pub fn compact_now(&mut self, records: &IndexMap<String, Value>) -> Result<u64, String> {
        // TRDD-1RJBOEI1: boot no longer calls this after load(); log_reader.rs restore calls
        // compact_from_disk, which does the same without holding the record map. This stays for
        // callers that already hold the full `records` (cache_turns_sql.rs tests, the memgate harness).
        if size_of(&self.delta_path) == 0 {
            return Ok(0);
        }
        self.compact(records.iter(), records.len())
    }
    /// Total bytes on disk (both files).
    pub fn disk_bytes(&self) -> u64 {
        size_of(&self.snapshot_path) + size_of(&self.delta_path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// TRDD-O8MGRU72 — which directory-sync errors commit_verified tolerates. Only "this
    /// filesystem cannot sync a directory" (EINVAL, ENOTSUP, EOPNOTSUPP, ErrorKind::Unsupported)
    /// proceeds to remove the delta; a real I/O failure must not. WHY only the classifier: no real
    /// fixture on a local APFS/ext4 tmpdir makes a directory fsync return these, and the task
    /// forbids a production fault hook, so the end-to-end branch (eprintln + delta removed) is
    /// unexercised here.
    #[cfg(unix)]
    #[test]
    fn only_unsupported_directory_sync_errors_are_tolerated() {
        for c in [libc::EINVAL, libc::ENOTSUP, libc::EOPNOTSUPP] {
            assert!(dir_sync_unsupported(&std::io::Error::from_raw_os_error(c)), "os error {c} is tolerated");
        }
        assert!(dir_sync_unsupported(&std::io::Error::from(std::io::ErrorKind::Unsupported)));
        for c in [libc::EIO, libc::ENOSPC, libc::EACCES, libc::EBADF] {
            assert!(!dir_sync_unsupported(&std::io::Error::from_raw_os_error(c)), "os error {c} stays an Err");
        }
        assert!(!dir_sync_unsupported(&std::io::Error::other("x")));
    }

    /// TRDD-O8MGRU72 — the from-disk verify-failure path of commit_verified, driven directly. WHY a
    /// unit test and not a fixture in tests/delta_log.rs: since finish() syncs the temp file, no
    /// fixture can make a synced regular file read back different from what was written, so the
    /// only way to reach a failed verify without a production fault hook is to hand commit_verified
    /// a temp file whose content differs from the expected records. Two cases: a missing record
    /// (the count check) and a changed value (the per-record comparison). Each must Err naming the
    /// verify, remove the temp file, and leave the old snapshot and the delta byte for byte.
    #[test]
    fn a_temp_snapshot_that_differs_from_the_records_fails_verify_and_keeps_snapshot_and_delta() {
        let dir = std::env::temp_dir().join(format!("al-deltalog-unit-{}-verify", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let expected: IndexMap<String, Value> = [("a".to_string(), json!(1)), ("b".to_string(), json!({"x": 2}))].into_iter().collect();
        let cases = [
            ("missing", "{\"k\":\"a\",\"v\":1}\n"),
            ("changed", "{\"k\":\"a\",\"v\":1}\n{\"k\":\"b\",\"v\":{\"x\":3}}\n"),
        ];
        for (name, tmp_body) in cases {
            let log = DeltaLog::new(&dir, name);
            let snap_before = b"{\"k\":\"a\",\"v\":0}\n".to_vec();
            let delta_before = b"{\"k\":\"a\",\"v\":1}\n{\"k\":\"b\",\"v\":{\"x\":2}}\n".to_vec();
            fs::write(&log.snapshot_path, &snap_before).unwrap();
            fs::write(&log.delta_path, &delta_before).unwrap();
            let tmp = PathBuf::from(format!("{}.tmp", log.snapshot_path.display()));
            fs::write(&tmp, tmp_body).unwrap();
            let err = log
                .commit_verified(&tmp, expected.len(), |pos, k, v| expected.get_index(pos).is_some_and(|(key, r)| key == k && r == v))
                .unwrap_err();
            assert!(err.contains("verify failed"), "{name}: refused by the verify: {err}");
            assert!(fs::symlink_metadata(&tmp).is_err(), "{name}: the temp snapshot is removed");
            assert_eq!(fs::read(&log.snapshot_path).unwrap(), snap_before, "{name}: old snapshot byte-identical");
            assert_eq!(fs::read(&log.delta_path).unwrap(), delta_before, "{name}: delta still present");
        }
        let _ = fs::remove_dir_all(&dir);
    }


    fn unit_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("al-deltalog-unit-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// A file's text, "" when it does not exist.
    fn text(p: &Path) -> String {
        fs::read_to_string(p).unwrap_or_default()
    }


    /// TRDD-2JOIAH2G — the order half of "every key, in order": a `.tmp` holding exactly the right
    /// keys and values but in the WRONG order must fail the verify. `pos` is the record's position
    /// in replay (`ix.live`) order, and the `same` closure here is shaped like compact()'s (a
    /// (key hash, value hash) per position, recorded in the order the records were written), so a
    /// swap reads as a mismatch at position 0. WHY driven through commit_verified and not compact():
    /// compact() writes its own `.tmp` from `records`, so it cannot be handed a pre-made out-of-order
    /// file without a production fault hook. The control commits the same records in the right
    /// order, so the refusal is shown to be about order, not a closure that refuses everything.
    #[test]
    fn a_temp_snapshot_with_the_right_records_in_the_wrong_order_fails_verify() {
        let dir = unit_dir("order");
        let recs = [("a", json!(1)), ("b", json!({"x": 2}))];
        let sums: Vec<(u64, u64)> = recs.iter().map(|(k, v)| (hash_json(k), hash_json(&serde_json::to_string(v).unwrap()))).collect();
        let same = |pos: usize, k: &str, v: &Value| sums.get(pos) == Some(&(hash_json(k), hash_json(&serde_json::to_string(v).unwrap())));
        let in_order = "{\"k\":\"a\",\"v\":1}\n{\"k\":\"b\",\"v\":{\"x\":2}}\n";
        let reversed = "{\"k\":\"b\",\"v\":{\"x\":2}}\n{\"k\":\"a\",\"v\":1}\n";
        let snap_before = b"{\"k\":\"a\",\"v\":0}\n".to_vec();
        let delta_before = b"{\"k\":\"a\",\"v\":1}\n{\"k\":\"b\",\"v\":{\"x\":2}}\n".to_vec();
        for (name, tmp_body, ok) in [("reversed", reversed, false), ("in-order", in_order, true)] {
            let log = DeltaLog::new(&dir, name);
            fs::write(&log.snapshot_path, &snap_before).unwrap();
            fs::write(&log.delta_path, &delta_before).unwrap();
            let tmp = PathBuf::from(format!("{}.tmp", log.snapshot_path.display()));
            fs::write(&tmp, tmp_body).unwrap();
            let r = log.commit_verified(&tmp, recs.len(), same);
            assert!(fs::symlink_metadata(&tmp).is_err(), "{name}: the temp snapshot is gone either way");
            if ok {
                assert!(r.is_ok(), "{name}: the right order commits: {r:?}");
                assert_eq!(text(&log.snapshot_path), tmp_body, "{name}: the snapshot is the temp body");
                assert!(!log.delta_path.exists(), "{name}: the delta is removed");
            } else {
                let err = r.unwrap_err();
                assert!(err.contains("verify failed"), "{name}: refused by the verify: {err}");
                assert_eq!(fs::read(&log.snapshot_path).unwrap(), snap_before, "{name}: old snapshot byte-identical");
                assert_eq!(fs::read(&log.delta_path).unwrap(), delta_before, "{name}: delta still present");
            }
        }
        let _ = fs::remove_dir_all(&dir);
    }

    /// TRDD-2JOIAH2G — the streamed seed_written hashes each record exactly as load() and
    /// changed_lines do (`to_string`, not any other spelling), and a key streamed twice keeps its
    /// FIRST position with its LAST value's hash, which is what collecting into the old map gave.
    #[test]
    fn a_streamed_seed_hashes_like_load_and_a_repeated_key_keeps_first_position_last_value() {
        let dir = unit_dir("seed");
        let mut log = DeltaLog::new(&dir, "seed");
        let recs = vec![
            ("a".to_string(), json!({"x": 1, "y": [1, 2]})),
            ("b".to_string(), json!([1, 2])),
            ("a".to_string(), json!({"last": true})),
        ];
        log.seed_written(recs);
        let got: Vec<(String, u64)> = log.written.iter().map(|(k, h)| (k.clone(), *h)).collect();
        let want = vec![
            ("a".to_string(), hash_json(&serde_json::to_string(&json!({"last": true})).unwrap())),
            ("b".to_string(), hash_json(&serde_json::to_string(&json!([1, 2])).unwrap())),
        ];
        assert_eq!(got, want, "first position, last value, to_string hashes");
        let _ = fs::remove_dir_all(&dir);
    }

    /// TRDD-2JOIAH2G — save_from writes the same bytes save always wrote, checked against literal
    /// file contents: an insert, a change, a delete, an unchanged save (0 bytes), and a save where a
    /// change, an insert and a delete land together with a compaction, with an UNCHANGED record in
    /// the set (so a compaction that wrote only the changed records would show in the snapshot).
    #[test]
    fn save_from_writes_exactly_the_changed_lines_tombstones_and_a_full_compacted_snapshot() {
        let dir = unit_dir("save-from");
        let snap = dir.join("s.snapshot.ndjson");
        let delta = dir.join("s.delta.ndjson");
        let mut log = DeltaLog::new(&dir, "s");
        let save = |log: &mut DeltaLog, recs: &[(&str, Value)]| log.save_from(|| recs.iter().map(|(k, v)| (*k, v))).unwrap();

        let r = save(&mut log, &[("a", json!({"n": 1})), ("b", json!({"n": 2}))]);
        assert_eq!((r.appended, r.deleted, r.compacted), (2, 0, false), "insert");
        assert_eq!(text(&delta), "{\"k\":\"a\",\"v\":{\"n\":1}}\n{\"k\":\"b\",\"v\":{\"n\":2}}\n");
        assert_eq!(r.bytes, text(&delta).len() as u64);

        let r = save(&mut log, &[("a", json!({"n": 10})), ("b", json!({"n": 2})), ("c", json!({"n": 3})), ("e", json!({"n": 5}))]);
        assert_eq!((r.appended, r.deleted, r.compacted), (3, 0, false), "change + insert");
        let two = "{\"k\":\"a\",\"v\":{\"n\":1}}\n{\"k\":\"b\",\"v\":{\"n\":2}}\n\
                   {\"k\":\"a\",\"v\":{\"n\":10}}\n{\"k\":\"c\",\"v\":{\"n\":3}}\n{\"k\":\"e\",\"v\":{\"n\":5}}\n";
        assert_eq!(text(&delta), two);

        let after_delete = [("a", json!({"n": 10})), ("c", json!({"n": 3})), ("e", json!({"n": 5}))];
        let r = save(&mut log, &after_delete);
        assert_eq!((r.appended, r.deleted, r.compacted), (0, 1, false), "delete");
        assert_eq!(text(&delta), format!("{two}{{\"k\":\"b\",\"d\":1}}\n"), "one tombstone appended");
        let len = text(&delta).len();

        assert_eq!(save(&mut log, &after_delete), SaveResult::default(), "unchanged: nothing written");
        assert_eq!(text(&delta).len(), len);
        assert!(!snap.exists(), "nothing compacted yet");

        // Big enough to pass COMPACT_MIN_BYTES with no snapshot (ratio against 0 bytes).
        let big = "x".repeat(COMPACT_MIN_BYTES as usize + 1);
        let last = [("c", json!({"n": 3})), ("a", json!(big)), ("d", json!({"n": 4}))];
        let r = save(&mut log, &last);
        assert_eq!((r.appended, r.deleted, r.compacted), (2, 1, true), "change a + insert d + delete e, compacted");
        let want = format!("{{\"k\":\"c\",\"v\":{{\"n\":3}}}}\n{{\"k\":\"a\",\"v\":\"{big}\"}}\n{{\"k\":\"d\",\"v\":{{\"n\":4}}}}\n");
        assert!(text(&snap) == want, "the snapshot is exactly the full record set, in its order");
        assert_eq!(r.bytes, want.len() as u64);
        assert!(!delta.exists(), "the delta is removed after a compaction");
        assert!(!dir.join("s.snapshot.ndjson.tmp").exists());
        let back = DeltaLog::new(&dir, "s").load().unwrap();
        assert_eq!(back.keys().collect::<Vec<_>>(), ["c", "a", "d"]);
        assert_eq!(save(&mut log, &last), SaveResult::default(), "after the compaction `written` matches the snapshot");
        let _ = fs::remove_dir_all(&dir);
    }

    /// TRDD-2JOIAH2G — save_from over OWNED items (the shape log_reader's card stream has) and a
    /// non-card record set shaped like log-offsets: only the one record whose offset moved is
    /// appended, and an unchanged save writes nothing.
    #[test]
    fn save_from_owned_offsets_shaped_records_appends_only_the_moved_offset() {
        let dir = unit_dir("offsets");
        let delta = dir.join("o.delta.ndjson");
        let mut log = DeltaLog::new(&dir, "o");
        let off = |b: u64| json!({"bytesRead": b, "mtimeMs": 1785578400000.0, "ino": 42, "size": b});
        let mut recs: Vec<(String, Value)> = vec![("/p/one.jsonl".into(), off(120)), ("/p/two.jsonl".into(), off(7))];
        let r = log.save_from(|| recs.iter().cloned()).unwrap();
        assert_eq!((r.appended, r.deleted), (2, 0));
        let first = "{\"k\":\"/p/one.jsonl\",\"v\":{\"bytesRead\":120,\"mtimeMs\":1785578400000.0,\"ino\":42,\"size\":120}}\n\
                     {\"k\":\"/p/two.jsonl\",\"v\":{\"bytesRead\":7,\"mtimeMs\":1785578400000.0,\"ino\":42,\"size\":7}}\n";
        assert_eq!(text(&delta), first);
        recs[1].1 = off(9);
        let r = log.save_from(|| recs.iter().cloned()).unwrap();
        assert_eq!((r.appended, r.deleted), (1, 0));
        assert_eq!(text(&delta), format!("{first}{{\"k\":\"/p/two.jsonl\",\"v\":{{\"bytesRead\":9,\"mtimeMs\":1785578400000.0,\"ino\":42,\"size\":9}}}}\n"));
        assert_eq!(log.save_from(|| recs.iter().cloned()).unwrap(), SaveResult::default());
        let _ = fs::remove_dir_all(&dir);
    }
}

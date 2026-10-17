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

    /// Flush and CLOSE the file (an unflushed buffer would make the from-disk verify read a short
    /// file, and Windows will not rename a file that is still open). Returns (path, bytes written).
    fn finish(self) -> Result<(PathBuf, u64), String> {
        let TmpSnapshot { path, w, bytes } = self;
        w.into_inner().map_err(|e| format!("{}: {}", path.display(), e.error()))?;
        Ok((path, bytes))
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
    pub fn seed_written(&mut self, records: &IndexMap<String, Value>) {
        self.written = records.iter().map(|(k, v)| (k.clone(), hash_json(&serde_json::to_string(v).unwrap_or_default()))).collect();
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
    fn compact(&self, records: &IndexMap<String, Value>) -> Result<u64, String> {
        let mut tmp = TmpSnapshot::create(&self.snapshot_path)?;
        for (k, v) in records {
            tmp.push(k, &serde_json::to_string(v).unwrap_or_default())?;
        }
        let (tmp, bytes) = tmp.finish()?;
        // WHY Value equality and not a hash: `records` is in memory, so the exact old check (every
        // record equal) costs nothing extra.
        self.commit_verified(&tmp, records.keys().map(String::as_str), |pos, v| records.get_index(pos).map(|(_, r)| r) == Some(v))?;
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
    fn commit_verified<'a>(
        &self,
        tmp: &Path,
        keys: impl ExactSizeIterator<Item = &'a str>,
        mut same: impl FnMut(usize, &Value) -> bool,
    ) -> Result<(), String> {
        let verified = (|| -> Result<(), String> {
            let ix = Self::index_files(&[tmp])?;
            if ix.live.len() != keys.len() {
                return Err(format!("holds {} records, expected {}", ix.live.len(), keys.len()));
            }
            if let Some((got, want)) = ix.live.keys().zip(keys).find(|(got, want)| got.as_str() != *want) {
                return Err(format!("record {want:?} is not durable in the snapshot (found {got:?} in its place)"));
            }
            let winners = ix.winners();
            Self::visit_winners(&ix.files, &winners, |pos, k, v| if same(pos, &v) { Ok(()) } else { Err(format!("record {k:?} is not durable in the snapshot")) })
            // `ix` drops here, closing `tmp` before the rename (Windows refuses to rename an open file).
        })();
        if let Err(m) = verified {
            let _ = fs::remove_file(tmp);
            return Err(format!("{}: compaction verify failed ({m}); delta KEPT, snapshot NOT replaced — no records lost", self.snapshot_path.display()));
        }
        fs::rename(tmp, &self.snapshot_path).map_err(|e| format!("{}: rename: {e}", self.snapshot_path.display()))?;
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
    /// WHY the winners are read in REPLAY order (seeking per record) and not in visit_winners' file
    /// order: the snapshot must come out in the order load()'s map had (insert a, insert b, update
    /// a is order a, b but file order b, a), or every later load() order — and the bytes of the
    /// snapshot — would change. Reads are buffered and the order is mostly sequential, so a seek is
    /// a buffer move in the common case.
    ///
    /// Failure semantics mirror the old pair: a source that does not replay is an Err with
    /// `written` untouched (load() failing); a failed write or verify is an Err with `written`
    /// already seeded (load() succeeding, then compact_now failing), and the old snapshot and the
    /// delta stay in place.
    pub fn compact_from_disk(&mut self) -> Result<u64, String> {
        use std::io::{BufRead, BufReader, Seek, SeekFrom};
        let delta_empty = size_of(&self.delta_path) == 0;
        let ix = Self::index_files(&[&self.snapshot_path, &self.delta_path])?;
        let mut out: Result<Option<TmpSnapshot>, String> = if delta_empty { Ok(None) } else { TmpSnapshot::create(&self.snapshot_path).map(Some) };
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
        let mut buf = Vec::new();
        // The replay in a closure so that a source error can remove a half-written `tmp` below.
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
                written.insert(key.clone(), hash_json(&json));
                // A write error does not stop the pass: `written` must still be seeded (see above).
                let pushed = match &mut out {
                    Ok(Some(t)) => t.push(key, &json),
                    _ => Ok(()),
                };
                if let Err(e) = pushed {
                    out = Err(e);
                }
            }
            Ok(())
        })();
        if let Err(e) = replayed {
            // The source did not replay (load() would have failed): `written` stays untouched, and a
            // half-written `tmp` is removed — the old snapshot and the delta were never touched.
            if let Ok(Some(t)) = out {
                let path = t.path.clone();
                drop(t);
                let _ = fs::remove_file(path);
            }
            return Err(e);
        }
        // Close the source handles before the rename and the delta delete (Windows).
        drop(readers);
        drop(ix);
        self.written = written;
        let Some(tmp) = out? else { return Ok(0) };
        let (tmp, bytes) = tmp.finish()?;
        let written = &self.written;
        self.commit_verified(&tmp, written.keys().map(String::as_str), |pos, v| {
            // WHY a hash and not the record: there is no record map here, by design. The seeded hash
            // is of `to_string(v)` as written; the parsed-back `v` must serialize to the same bytes.
            written.get_index(pos).map(|(_, h)| *h) == Some(hash_json(&serde_json::to_string(v).unwrap_or_default()))
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

    /// TRDD-N6A8VX3G — unconditional compaction of a caller-supplied record map, bypassing save()'s size gate:
    /// one verified snapshot rewrite drops the delta, bounding it to per-boot volume and
    /// healing a torn trailing line a hard kill can leave (replay tolerates ONE torn tail, and
    /// the body-links SQL consumer reads through the same replay — cache_turns_sql.rs install_body_links,
    /// via for_each_live —
    /// so this is cleanup, not a precondition for reading).
    /// No-op while the delta is empty: the snapshot already holds everything. Boot uses compact_from_disk instead.
    pub fn compact_now(&mut self, records: &IndexMap<String, Value>) -> Result<u64, String> {
        // TRDD-1RJBOEI1: boot no longer calls this after load(); log_reader.rs restore calls
        // compact_from_disk, which does the same without holding the record map. This stays for
        // callers that already hold the full `records` (cache_turns_sql.rs tests, the memgate harness).
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

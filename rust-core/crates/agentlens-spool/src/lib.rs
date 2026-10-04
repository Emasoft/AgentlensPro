//! agentlens-spool — the spool writer: `append` one line to `<ingest_dir>/inbox/<spool>/current.ndjson`,
//! `seal` it into `<ingest_dir>/ready/<spool>/<ts_ns>-<pid>.ndjson` for `aldigest collect`
//! (crate agentlens-digest). Nothing here opens a database.
//!
//! Spool line: `{"ts_ns":<unix ns>,"payload":<one JSON object, byte-for-byte as given>}`.
//!
//! PROTOCOL. Appenders and sealers serialise on an exclusive kernel `flock` of `current.ndjson`.
//! A sealer renames the file away, so an appender (or another sealer) that opened the file BEFORE
//! the rename and got the lock AFTER it holds a descriptor of a file that is no longer at the
//! path. Every lock holder therefore compares the (device, inode) of its descriptor with the
//! path's before acting: a missing path or a different inode means "sealed meanwhile". An appender
//! then retries from the open; a sealer has lost the race and does nothing.
//!
//! The lock belongs to the open descriptor: dropping the `File` releases it. Nothing unlocks
//! explicitly, because an explicit unlock that failed after a successful write or rename would
//! report a failure for work that is done (a producer's retry would then duplicate the line).
//!
//! SIZE BOUND. `aldigest collect` loads a ready file in one memory-limited DuckDB transaction, so
//! the writer bounds the file size: an appender that finds `current.ndjson` at least `seal_bytes`
//! long after its own write seals it itself, still under the lock (the same rename as `seal`).
//! A ready file is therefore never larger than `seal_bytes` plus one line (`append_many`: plus one batch).
//!
//! No fsync: a killed process loses nothing it already wrote, a power loss may lose the tail of
//! the unsynced spool. A torn line (a write that failed half way) makes its sealed file fail at
//! collect, which is the loud outcome the digest pipeline wants.

use fs2::FileExt;
use serde_json::value::RawValue;
use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Write};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

/// Errors are plain messages, as in the neighbouring crates.
pub type Res<T> = Result<T, String>;

/// How often `append` reopens the file because it was sealed between open and lock.
pub const MAX_ATTEMPTS: u32 = 100;

/// `alspool append` seals `current.ndjson` itself once the file holds at least this many bytes,
/// so a ready file never exceeds this plus one line. It bounds the size of the files
/// `aldigest collect` loads (one memory-limited DuckDB transaction per file).
pub const DEFAULT_SEAL_BYTES: u64 = 4_194_304;

/// The loader's `maximum_object_size` (agentlens-digest `MAX_OBJECT_BYTES`; this crate does not
/// depend on that one, keep the two equal): a spool line larger than this fails its whole file at collect.
pub const MAX_LINE_BYTES: usize = 67_108_864;

/// Longest envelope around a payload: `{"ts_ns":` + 20 digits (a u64) + `,"payload":` + `}` + newline.
pub const LINE_OVERHEAD_MAX: usize = 9 + 20 + 11 + 1 + 1;

/// Spool names follow the manifest rule: non-empty ASCII letters, digits and underscores.
pub fn is_ident(s: &str) -> bool {
    !s.is_empty() && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn check_spool(spool: &str) -> Res<()> {
    if is_ident(spool) {
        Ok(())
    } else {
        Err(format!("spool {spool:?} must be non-empty ASCII letters, digits and underscores"))
    }
}

fn now_ns() -> Res<u128> {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).map_err(|e| format!("system clock is before 1970: {e}"))
}

/// The payload text of one stdin document: leading and trailing ASCII whitespace removed, then
/// valid UTF-8, no raw newline (a line is one line), and syntactically exactly one JSON object.
/// The text is returned verbatim, never re-serialised.
pub fn validate_payload(raw: &[u8]) -> Res<&str> {
    let text = std::str::from_utf8(raw).map_err(|e| format!("payload is not valid UTF-8: {e}"))?;
    let text = text.trim_matches(|c: char| c.is_ascii_whitespace());
    if text.is_empty() {
        return Err("payload is empty".to_owned());
    }
    // '\r' is rejected with '\n': a reader that splits lines on either would tear the line.
    if text.contains(['\n', '\r']) {
        return Err("payload contains a raw newline".to_owned());
    }
    if !text.starts_with('{') {
        return Err("payload must be one JSON object (its first byte must be `{`)".to_owned());
    }
    serde_json::from_str::<&RawValue>(text).map_err(|e| format!("payload is not valid JSON: {e}"))?;
    Ok(text)
}

/// True when `path` still names the very file `f` holds open. A missing path is "no", not an error.
fn path_names_file(f: &File, path: &Path) -> Res<bool> {
    let held = f.metadata().map_err(|e| format!("{}: {e}", path.display()))?;
    match std::fs::metadata(path) {
        Ok(at_path) => Ok(at_path.dev() == held.dev() && at_path.ino() == held.ino()),
        Err(e) if e.kind() == ErrorKind::NotFound => Ok(false),
        Err(e) => Err(format!("{}: {e}", path.display())),
    }
}

/// `write_all` that says so when the failure left a torn line behind.
fn write_line(mut f: &File, path: &Path, line: &[u8]) -> Res<()> {
    let mut written = 0;
    while written < line.len() {
        match f.write(&line[written..]) {
            Ok(0) => return Err(torn(path, written, line.len(), "write returned 0 bytes")),
            Ok(n) => written += n,
            Err(e) if e.kind() == ErrorKind::Interrupted => {}
            Err(e) => return Err(torn(path, written, line.len(), &e.to_string())),
        }
    }
    Ok(())
}

fn torn(path: &Path, written: usize, total: usize, why: &str) -> String {
    if written == 0 {
        format!("{}: write failed: {why}", path.display())
    } else {
        format!("{}: write failed after {written} of {total} bytes: {why}; the line is torn and the sealed file will fail at collect", path.display())
    }
}

/// What a successful `append` / `append_many` did.
#[derive(Debug, PartialEq, Eq)]
pub enum Appended {
    /// The lines are in `current.ndjson`.
    Written,
    /// The lines are written and the file had reached `seal_bytes`: this append sealed it into the ready file.
    Sealed(PathBuf),
    /// The lines are written (never retry them, that would duplicate them) but the seal that was due failed.
    SealFailed(String),
}

/// Append every payload as its own spool line under ONE lock hold; when the file then holds at
/// least `seal_bytes`, seal it before releasing the lock. Every payload is validated before
/// anything is created or written, so one bad payload writes nothing. Each line is stamped with
/// its own `ts_ns`, read under the lock and never smaller than the previous line's. Once the lines
/// are written nothing may turn the call into an `Err`: a later failure is `Appended::SealFailed`.
///
/// The seal check runs once per call, so a ready file can exceed `seal_bytes` by one whole batch:
/// callers keep a batch small (the alcore tap caps it at 1 MiB).
pub fn append_many(ingest_dir: &Path, spool: &str, payloads: &[&[u8]], seal_bytes: u64) -> Res<Appended> {
    check_spool(spool)?;
    if payloads.is_empty() {
        return Err("no payload given".to_owned());
    }
    let mut texts: Vec<&str> = Vec::with_capacity(payloads.len());
    let mut total = 0usize;
    for (i, raw) in payloads.iter().enumerate() {
        // A single payload keeps its bare message (the `alspool append` contract); a batch names the offender.
        let text = validate_payload(raw).map_err(|e| if payloads.len() == 1 { e } else { format!("payload {i}: {e}") })?;
        if text.len() + LINE_OVERHEAD_MAX > MAX_LINE_BYTES {
            return Err(format!("payload is {} bytes: its spool line would exceed {MAX_LINE_BYTES} bytes, the loader's maximum object size", text.len()));
        }
        total += text.len() + LINE_OVERHEAD_MAX;
        texts.push(text);
    }
    let dir = ingest_dir.join("inbox").join(spool);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = dir.join("current.ndjson");
    for _ in 0..MAX_ATTEMPTS {
        let f = OpenOptions::new().append(true).create(true).open(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        f.lock_exclusive().map_err(|e| format!("{}: lock: {e}", path.display()))?;
        // Sealed between open and lock: this descriptor is a file that left the path. Dropping it
        // closes it (and releases the lock); retry from the open.
        if !path_names_file(&f, &path)? {
            continue;
        }
        // The clock is read under the lock, so file order equals ts_ns order within a file; the
        // clock may step back between two reads, so a line never goes below its predecessor.
        let mut buf = String::with_capacity(total);
        let mut last = 0u128;
        for text in &texts {
            let ts = now_ns()?.max(last);
            last = ts;
            buf.push_str(&format!("{{\"ts_ns\":{ts},\"payload\":{text}}}\n"));
        }
        write_line(&f, &path, buf.as_bytes())?;
        // The lines are written: from here no failure may be reported as an `Err`, and the lock is
        // released by dropping `f` when this function returns (after the seal's rename).
        return Ok(match f.metadata() {
            Ok(m) if m.len() < seal_bytes => Appended::Written,
            Ok(_) => match seal_locked(&path, ingest_dir, spool) {
                Ok(ready) => Appended::Sealed(ready),
                Err(e) => Appended::SealFailed(e),
            },
            Err(e) => Appended::SealFailed(format!("{}: {e}", path.display())),
        });
    }
    Err(format!("{}: sealed {MAX_ATTEMPTS} times while waiting for the lock, giving up", path.display()))
}

/// Append `stdin` as one spool line (`append_many` of one payload).
pub fn append(ingest_dir: &Path, spool: &str, stdin: &[u8], seal_bytes: u64) -> Res<Appended> {
    append_many(ingest_dir, spool, &[stdin], seal_bytes)
}

/// Move `current.ndjson` to a fresh ready file. The caller holds the exclusive lock on the open
/// descriptor of that very file and has checked it is non-empty and still at `path`; the rename
/// runs while the lock is held, so no appender can write between the check and the move.
fn seal_locked(path: &Path, ingest_dir: &Path, spool: &str) -> Res<PathBuf> {
    let ready = ingest_dir.join("ready").join(spool);
    std::fs::create_dir_all(&ready).map_err(|e| format!("{}: {e}", ready.display()))?;
    let dest = ready.join(format!("{}-{}.ndjson", now_ns()?, std::process::id()));
    // rename(2) replaces silently; the name is unique per (ns, pid), so an existing one is a bug.
    if dest.exists() {
        return Err(format!("{}: already exists", dest.display()));
    }
    std::fs::rename(path, &dest).map_err(|e| format!("rename {} -> {}: {e}", path.display(), dest.display()))?;
    Ok(dest)
}

/// Seal one spool: `Some(ready file)` when a non-empty `current.ndjson` was moved, `None` when
/// there was nothing to do (absent, empty, or another seal won the race).
fn seal_one(ingest_dir: &Path, spool: &str) -> Res<Option<PathBuf>> {
    let path = ingest_dir.join("inbox").join(spool).join("current.ndjson");
    // No O_CREAT: sealing must never create the file an appender is about to create.
    let f = match OpenOptions::new().read(true).open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {e}", path.display())),
    };
    f.lock_exclusive().map_err(|e| format!("{}: lock: {e}", path.display()))?;
    // Absent or different inode: another seal moved the file while we waited for the lock.
    if !path_names_file(&f, &path)? {
        return Ok(None);
    }
    if f.metadata().map_err(|e| format!("{}: {e}", path.display()))?.len() == 0 {
        return Ok(None);
    }
    // `f` stays open, and so locked, until this function returns: after the rename.
    seal_locked(&path, ingest_dir, spool).map(Some)
}

/// Seal every spool directory of `<ingest_dir>/inbox` (or only `only`); returns the ready files
/// created. A missing inbox is nothing to seal; an unknown entry in it is an error (dot entries,
/// such as macOS `.DS_Store`, are ignored).
pub fn seal(ingest_dir: &Path, only: Option<&str>) -> Res<Vec<PathBuf>> {
    let mut spools: Vec<String> = Vec::new();
    match only {
        Some(s) => {
            check_spool(s)?;
            spools.push(s.to_owned());
        }
        None => {
            let inbox = ingest_dir.join("inbox");
            let entries = match std::fs::read_dir(&inbox) {
                Ok(rd) => rd,
                Err(e) if e.kind() == ErrorKind::NotFound => return Ok(Vec::new()),
                Err(e) => return Err(format!("{}: {e}", inbox.display())),
            };
            for entry in entries {
                let entry = entry.map_err(|e| format!("{}: {e}", inbox.display()))?;
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with('.') {
                    continue;
                }
                if !entry.path().is_dir() || !is_ident(&name) {
                    return Err(format!("{}: not a spool directory", entry.path().display()));
                }
                spools.push(name);
            }
        }
    }
    spools.sort();
    let mut sealed = Vec::new();
    for spool in &spools {
        sealed.extend(seal_one(ingest_dir, spool)?);
    }
    Ok(sealed)
}

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

/// The payload text of one stdin document: trailing ASCII whitespace removed, then valid UTF-8,
/// no raw newline (a line is one line), and syntactically exactly one JSON object. The text is
/// returned verbatim, never re-serialised.
pub fn validate_payload(raw: &[u8]) -> Res<&str> {
    let text = std::str::from_utf8(raw).map_err(|e| format!("payload is not valid UTF-8: {e}"))?;
    let text = text.trim_end_matches(|c: char| c.is_ascii_whitespace());
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

/// Append `stdin` as one spool line. Validation happens before anything is created.
pub fn append(ingest_dir: &Path, spool: &str, stdin: &[u8]) -> Res<()> {
    check_spool(spool)?;
    let payload = validate_payload(stdin)?;
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
        // The clock is read under the lock, so file order equals ts_ns order within a file.
        let line = format!("{{\"ts_ns\":{},\"payload\":{payload}}}\n", now_ns()?);
        write_line(&f, &path, line.as_bytes())?;
        FileExt::unlock(&f).map_err(|e| format!("{}: unlock: {e}", path.display()))?;
        return Ok(());
    }
    Err(format!("{}: sealed {MAX_ATTEMPTS} times while waiting for the lock, giving up", path.display()))
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
    let ready = ingest_dir.join("ready").join(spool);
    std::fs::create_dir_all(&ready).map_err(|e| format!("{}: {e}", ready.display()))?;
    let dest = ready.join(format!("{}-{}.ndjson", now_ns()?, std::process::id()));
    // rename(2) replaces silently; the name is unique per (ns, pid), so an existing one is a bug.
    if dest.exists() {
        return Err(format!("{}: already exists", dest.display()));
    }
    // Renamed while the lock is still held: no appender can write between the check and the move.
    std::fs::rename(&path, &dest).map_err(|e| format!("rename {} -> {}: {e}", path.display(), dest.display()))?;
    FileExt::unlock(&f).map_err(|e| format!("{}: unlock: {e}", path.display()))?;
    Ok(Some(dest))
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

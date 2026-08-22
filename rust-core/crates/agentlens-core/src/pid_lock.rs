//! The single-instance data-dir lock (TRDD-DMWOBWFH D1 prerequisite; port of
//! `src/serverRuntime.ts` `atomicExclusiveWriteFileSync`/`formatPidLock`/`parsePidLock`/
//! `processStartRef`/`lockTakeoverVerdict` + `standalone/server.ts:195-260`). Every property below
//! fixes a measured bug — see `docs_dev/d1-alcore-pidlock-brief.md`.

use std::io;
use std::path::{Path, PathBuf};
use std::process;

pub fn pidfile_path(data_dir: &Path) -> PathBuf {
    data_dir.join("server.pid")
}

/// The OS's own record of when `pid` started — used only to tell a live-but-RECYCLED pid apart
/// from the process that actually claimed the lock. `kill(pid,0)` alone answers "alive" for
/// whatever the OS reused the pid for, which is a measured double-owner window. `None` means
/// "could not determine" (process gone, `ps` unavailable) — callers MUST fall back to the
/// conservative kill-0-only rule, never treat it as "definitely recycled".
pub fn process_start_ref(pid: u32) -> Option<String> {
    // LC_ALL=C: `lstart` renders via strftime, so its day/month names follow LC_TIME. Without
    // pinning, a starter under a different locale than the lock's owner reads a different string
    // for the SAME live process and wrongly calls it recycled.
    let out = std::process::Command::new("ps")
        .args(["-o", "lstart=", "-p", &pid.to_string()])
        .env("LC_ALL", "C")
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_owned();
    if s.is_empty() { None } else { Some(s) }
}

pub struct PidLock {
    pub pid: u32,
    pub start: Option<String>,
}

/// `start: None` deliberately produces the legacy bare-numeric shape (not `"pid:null"`) so a
/// build that could not determine its own start reference still writes a file every pre-existing
/// reader/writer understands.
pub fn format_pid_lock(pid: u32, start: Option<&str>) -> String {
    match start {
        None => pid.to_string(),
        Some(s) => format!("{{\"pid\":{pid},\"start\":{}}}", serde_json::to_string(s).unwrap_or_else(|_| "null".to_owned())),
    }
}

/// Parses both the new JSON `{"pid":N,"start":"..."}` shape and the legacy bare-numeric shape.
/// Anything unparseable/empty is `None` — the caller treats that exactly like a missing lock.
pub fn parse_pid_lock(content: &str) -> Option<PidLock> {
    let trimmed = content.trim();
    if trimmed.is_empty() {
        return None;
    }
    if let Ok(pid) = trimmed.parse::<u32>() {
        return if pid > 0 { Some(PidLock { pid, start: None }) } else { None };
    }
    let v: serde_json::Value = serde_json::from_str(trimmed).ok()?;
    let pid = v.get("pid")?.as_u64()?;
    if pid == 0 {
        return None;
    }
    let start = v.get("start").and_then(|s| s.as_str()).map(|s| s.to_owned());
    Some(PidLock { pid: pid as u32, start })
}

/// Writes `data` to `file` atomically AND exclusively: full content to a private temp file first
/// (so it's never partially visible to a reader), fsync, then `link(2)` it onto `file` — link()
/// is atomic and fails EEXIST if the target already exists, which is exactly the exclusive-create
/// a single-instance lock needs. `O_CREAT|O_EXCL` + a separate write is NOT equivalent: that split
/// produced an observed interleaved-pid corruption. The temp file is always unlinked afterward.
fn atomic_exclusive_write(file: &Path, data: &str) -> io::Result<bool> {
    use std::fs;
    use std::io::Write;
    let tmp = file.with_extension(format!("tmp-{}-{}", process::id(), std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)));
    let result = (|| -> io::Result<bool> {
        {
            let mut f = fs::File::create(&tmp)?;
            f.write_all(data.as_bytes())?;
            let _ = f.sync_all(); // best-effort — some filesystems don't support fsync
        }
        match fs::hard_link(&tmp, file) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(false),
            Err(e) => Err(e),
        }
    })();
    let _ = fs::remove_file(&tmp); // already consumed by the link, or never created — fine either way
    result
}

fn read_pid_lock(path: &Path) -> Option<PidLock> {
    let content = std::fs::read_to_string(path).ok()?;
    parse_pid_lock(&content)
}

fn pid_alive(pid: u32) -> bool {
    // kill(pid, 0) sends no signal, just checks existence/permission. ESRCH => gone; EPERM => a
    // real process we don't own (still alive); 0 => alive and ours.
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    r == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

pub enum ClaimOutcome {
    Claimed,
    /// pid of the confirmed-live holder — refuse and exit.
    Refused { holder: u32 },
    /// wrote the lock but the read-back didn't match what we wrote — the lock's whole job is to
    /// be trusted, so this must fail loud rather than let two servers believe the guard passed.
    VerifyFailed,
}

pub fn claim(data_dir: &Path) -> ClaimOutcome {
    let path = pidfile_path(data_dir);
    let my_pid = process::id();
    let my_start = process_start_ref(my_pid);
    let content = format_pid_lock(my_pid, my_start.as_deref());

    // Two attempts: the first try, then — if the lock is stale/recycled — unlink and retry once.
    // A second EEXIST after the unlink+retry means someone else won the race; refuse rather than
    // loop, since a live process must have just published it.
    for _ in 0..2 {
        match atomic_exclusive_write(&path, &content) {
            Ok(true) => {
                let readback = read_pid_lock(&path);
                return match readback {
                    Some(l) if l.pid == my_pid && l.start == my_start => ClaimOutcome::Claimed,
                    _ => ClaimOutcome::VerifyFailed,
                };
            }
            Ok(false) => {
                let prior = read_pid_lock(&path);
                let Some(prior) = prior else {
                    // unreadable/missing lock — nothing to trust, treat as a dead holder and retry
                    let _ = std::fs::remove_file(&path);
                    continue;
                };
                if prior.pid == my_pid {
                    // our own stale lock from a prior run with this recycled pid — safe to reclaim
                    let _ = std::fs::remove_file(&path);
                    continue;
                }
                let alive = pid_alive(prior.pid);
                if !alive {
                    // dead-takeover
                    let _ = std::fs::remove_file(&path);
                    continue;
                }
                let current_start = process_start_ref(prior.pid);
                let recycled = match (&prior.start, &current_start) {
                    (Some(recorded), Some(current)) => recorded != current,
                    // legacy-kill0-only: no start ref on one side or the other — fall back to
                    // trusting kill(pid,0) as a live owner, never guess "recycled".
                    _ => false,
                };
                if !recycled {
                    return ClaimOutcome::Refused { holder: prior.pid };
                }
                // recycled-takeover
                let _ = std::fs::remove_file(&path);
                continue;
            }
            Err(_) => return ClaimOutcome::VerifyFailed,
        }
    }
    // Both attempts hit a live/racing holder.
    match read_pid_lock(&path) {
        Some(l) => ClaimOutcome::Refused { holder: l.pid },
        None => ClaimOutcome::VerifyFailed,
    }
}

/// Unlinks `server.pid` ONLY if it still names our own pid — never unconditionally, which would
/// release someone else's lock after a takeover race.
pub fn release(data_dir: &Path) {
    let path = pidfile_path(data_dir);
    if let Some(l) = read_pid_lock(&path) {
        if l.pid == process::id() {
            let _ = std::fs::remove_file(&path);
        }
    }
}

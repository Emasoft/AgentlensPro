//! The spool tap (TRDD-LHCHVK9Z): with `alcore serve --ingest-manifest M --aldigest-bin B` every
//! item alcore receives is ALSO written as one line of the spool format `aldigest collect` loads
//! (crate agentlens-spool), next to the existing stores and never instead of them. Flags absent =
//! no tap: no file, no directory, no extra work (every call site is one `Option` check).
//!
//! The tap inherits the user's capture switch: a hook event dropped by `captureEnabled=false` is
//! not spooled either (the tap call sits after that gate in `hook_events::ingest_hook_event`).
//!
//! WHAT IS WRITTEN, AND HOW. Hooks and API bodies keep the exact bytes that arrived (a re-serialised
//! `serde_json::Value` would alter integers beyond 64 bits and drop duplicate keys). The status line
//! (two CLI-added keys removed) and OTLP records/spans (attributes flattened out of their AnyValue
//! wrappers) cannot be verbatim and are necessarily re-serialised. An item whose (source, topic) the
//! manifest has no spool for is NEVER written and never invented into a spool: it is counted per
//! name and warned about once per process (owner ruling D-E: an unknown name is an anomaly).
//!
//! ERROR POLICY. A tap write that fails does NOT fail or delay the capture path that called it: it is
//! counted, and logged at most once a minute per spool. This is the ONE place an error is not
//! propagated, because during the transition the existing stores remain the system of record and the
//! digest copy must never be able to take capture down. For the same reason every hook, status-line
//! and OTLP write is queued (never blocking its caller, which may hold the global state lock) to ONE
//! writer thread owned by the tap (see `enqueue`): lines reach the files in arrival order, a spool
//! file lock held by another process stalls only that thread, and a full queue drops (and counts) the
//! batch instead of piling up. At graceful shutdown the queue is closed and drained (bounded wait)
//! before the final seal (if it cannot finish within 5 s the seal is skipped); only such a batch is
//! lost from the spool, never from the existing stores. The queue is bounded by count and by bytes; a
//! refused batch is counted (`droppedQueueFull`), and a dead writer shows as `writerDead`.
//! `ts_ns` of a spool line is stamped by the writer when the line is written (agentlens-spool), so
//! under a backlog it lags the moment of receipt by the queue delay; this is deliberate, not changed.
//!
//! SCHEDULE. `seal_and_collect` runs every `interval` (chores.rs): it seals every spool, then runs
//! `aldigest collect` as a CHILD process (one collect can reach ~730 MiB RSS; alcore is capped at
//! 2048 MB) under its own `.collect.lock`, never the cross-process chores lock, so a ten-minute
//! collect cannot block the bodies pass. At graceful shutdown only `seal_for_shutdown` runs: the
//! next start collects.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::mpsc::{channel, sync_channel, Receiver, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use agentlens_spool::{append_many, Appended, DEFAULT_SEAL_BYTES};
use fs2::FileExt;
use serde_json::{json, Map, Value};

use crate::{log_ts, CoreState};

pub const DEFAULT_INTERVAL_SECS: u64 = 60;
/// The sources `--ingest-sources` accepts.
pub const ALL_SOURCES: [&str; 5] = ["hooks", "statusline", "events", "spans", "bodies"];
/// What a tap writes when `--ingest-sources` is absent: everything except the API bodies, which
/// were MEASURED at about 7 GB/day of spool plus about 16 GB/day of events.duckdb growth (the typed
/// tables store each body's messages again, with no de-duplication) on a disk with 58 GB free.
pub const DEFAULT_SOURCES: [&str; 4] = ["hooks", "statusline", "events", "spans"];

/// Parse the comma separated `--ingest-sources` value; an unknown or empty entry is an error.
pub fn parse_sources(list: &str) -> Result<Vec<String>, String> {
    let mut out: Vec<String> = Vec::new();
    for s in list.split(',').map(str::trim) {
        if !ALL_SOURCES.contains(&s) {
            return Err(format!("--ingest-sources: unknown source {s:?} (valid: {})", ALL_SOURCES.join(",")));
        }
        if !out.iter().any(|o| o == s) {
            out.push(s.to_owned());
        }
    }
    Ok(out)
}
/// A collect that has not finished after this long is killed (its transaction rolls back).
const COLLECT_TIMEOUT: Duration = Duration::from_secs(600);
/// Files one `aldigest collect` process loads, and how many such processes one tick may start.
const COLLECT_MAX_FILES: u64 = 10;
const COLLECT_MAX_RUNS: u32 = 20;
const REGISTER_TIMEOUT: Duration = Duration::from_secs(120);
const VIEWS_TIMEOUT: Duration = Duration::from_secs(120);
const LEDGER_TIMEOUT: Duration = Duration::from_secs(120);

/// done/ names put to the ledger per tick (the window rotates, see `purge_done`). Test knob: `ALCORE_INGEST_PURGE_BATCH`.
const PURGE_BATCH: usize = 500;
const PURGE_BATCH_ENV: &str = "ALCORE_INGEST_PURGE_BATCH";

/// A done/ file name is put in a SQL string literal only if it is plain; anything else is skipped.
fn purge_name_ok(n: &str) -> bool {
    !n.is_empty() && n.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// Writer queue capacity in batches (one hook / status line / OTLP group each).
const QUEUE_CAPACITY: usize = 4096;
/// The writer queue also holds at most this many payload bytes: a count bound alone would let 4096
/// slots of 1 MiB OTLP batches pile up 4 GiB behind a stalled spool lock. A single batch larger than
/// the bound is still accepted when nothing is queued. Test knob: `ALCORE_INGEST_QUEUE_MAX_BYTES`.
const QUEUE_MAX_BYTES: usize = 64 << 20;
const QUEUE_MAX_BYTES_ENV: &str = "ALCORE_INGEST_QUEUE_MAX_BYTES";
/// How long graceful shutdown waits for the writer thread to drain the queue.
const WRITER_JOIN_TIMEOUT: Duration = Duration::from_secs(5);
/// Retention of loaded spool files in `done/<spool>/`. OFF unless the owner opts in by setting this
/// environment variable (a positive number of seconds; anything else is ignored with one warning):
/// an automatic delete is not ours to enable. The owner's design proposal suggests 600 s (done/
/// files kept 600 seconds, failed/ files NEVER deleted automatically): the rows are committed in
/// events.duckdb together with the ledger row before a file reaches done/, so the file is only a
/// copy, and the disk budget measured about 0.25 GB/day of spool for the default sources. When on, a
/// file is deleted only if the ledger (`_ingest.files`, status complete) names it and its
/// `completed_at` is at least that old; the file mtime is never consulted.
const DONE_RETENTION_ENV: &str = "ALCORE_INGEST_DONE_RETENTION_SECS";
/// One `append_many` call carries at most this many payload bytes (one lock hold, one bounded
/// batch): a ready file is therefore never larger than the 4 MiB seal threshold plus this plus a line.
const BATCH_MAX_BYTES: usize = 1 << 20;
/// Distinct unknown names tracked; further ones only add to `unknown_overflow` (a span name can
/// carry a model id, so the set of names is not bounded by the schemas).
const UNKNOWN_NAMES_MAX: usize = 1000;
const ERROR_LOG_EVERY: Duration = Duration::from_secs(60);
/// The two keys the CLI adds to a status-line sample; they are not part of Claude Code's payload.
const STATUSLINE_CLI_KEYS: [&str; 2] = ["hook_event_name", "statusline_stream"];

/// `SessionEnd` -> `session_end`: how the manifest topics of the hook producers were derived.
pub fn snake_case(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 4);
    let mut prev: Option<char> = None;
    for c in name.chars() {
        if c.is_ascii_uppercase() {
            if prev.is_some_and(|p| p.is_ascii_lowercase() || p.is_ascii_digit()) {
                out.push('_');
            }
            out.push(c.to_ascii_lowercase());
        } else {
            out.push(c);
        }
        prev = Some(c);
    }
    out
}

/// The topic of a span name: a leading `claude_code.` removed, dots become underscores.
fn span_topic(name: &str) -> String {
    name.strip_prefix("claude_code.").unwrap_or(name).replace('.', "_")
}

#[derive(Default)]
struct Stats {
    written: BTreeMap<String, u64>,
    unknown: BTreeMap<String, u64>,
    unknown_overflow: u64,
    write_errors: u64,
    write_errors_by_spool: BTreeMap<String, u64>,
    last_error_logged: HashMap<String, Instant>,
    bodies_skipped: u64,
    last_collect: Option<Value>,
    /// Outcome of the last `aldigest views` attempt; the views are rebuilt until one succeeds.
    views: Option<Value>,
    views_ok: bool,
    done_deleted: u64,
    done_deleted_bytes: u64,
    done_delete_errors: u64,
    /// Ledger queries the retention purge ATTEMPTED (counted before the child runs, so failed and timed-out ones count too); stays 0 while done/ holds no regular file.
    done_ledger_queries: u64,
    /// Last done/ file name examined by the rotating purge window; `None` = start from the head.
    done_cursor: Option<String>,
    /// done/ names put to the ledger, cumulative.
    done_examined: u64,
    /// Names examined on the last tick that the ledger did not return (not complete, or not old enough).
    done_unledgered: u64,
    /// A full batch that deleted nothing has been logged (once per process).
    done_stuck_logged: bool,
    dropped_queue_full: u64,
    dropped_after_shutdown: u64,
    /// Batches refused because the writer thread is gone (it panicked); `writer_dead` is the state.
    dropped_writer_dead: u64,
    writer_dead: bool,
    /// The last views / ledger-query failure text logged, so an unchanged failure is not logged every tick.
    views_logged: Option<String>,
    ledger_logged: Option<String>,
}

/// One writer-queue entry: a spool name and the lines to append to it, in order.
type Batch = (String, Vec<Vec<u8>>);

pub struct SpoolTap {
    ingest_dir: PathBuf,
    db: PathBuf,
    manifest: PathBuf,
    aldigest_bin: PathBuf,
    interval: Duration,
    /// Enabled sources (see ALL_SOURCES); a source not in the list is never written.
    sources: Vec<String>,
    /// `Some` only when `ALCORE_INGEST_DONE_RETENTION_SECS` opted in (see DONE_RETENTION_ENV).
    done_retention: Option<Duration>,
    /// Producer end of the writer queue; `None` before start finishes and after shutdown closed it.
    tx: Mutex<Option<SyncSender<Batch>>>,
    /// Signalled (or disconnected) when the writer thread exits; shutdown waits on it with a timeout.
    writer_done: Mutex<Option<Receiver<()>>>,
    /// Payload bytes queued or being written; bounded by `queue_max_bytes`.
    queued_bytes: AtomicUsize,
    queue_max_bytes: usize,
    /// done/ names examined per retention tick (PURGE_BATCH unless the test knob overrides it).
    purge_batch: usize,
    /// Spool names of the CURRENT (highest) version of every topic.
    spools: HashSet<String>,
    /// "source/topic" -> spool, current version only.
    topic_spool: HashMap<String, String>,
    stats: Mutex<Stats>,
}

/// Outcome of `start`.
pub enum Start {
    Tap(Arc<SpoolTap>),
    /// The tap could not be brought up; alcore boots without it and reports the reason.
    Disabled(String),
}

/// Plain serde_json on purpose: alcore must not link the digest crate (a second DuckDB).
fn parse_manifest(path: &Path) -> Result<(HashSet<String>, HashMap<String, String>), String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let doc: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    let producers = doc.get("producers").and_then(Value::as_array).ok_or_else(|| format!("{}: no `producers` array", path.display()))?;
    let mut best: HashMap<String, (i64, String)> = HashMap::new();
    for p in producers {
        let field = |k: &str| p.get(k).and_then(Value::as_str).ok_or_else(|| format!("{}: a producer has no string field `{k}`", path.display()));
        let (source, topic, spool) = (field("source")?, field("topic")?, field("spool")?);
        let version = p.get("version").and_then(Value::as_i64).ok_or_else(|| format!("{}: a producer has no integer `version`", path.display()))?;
        let key = format!("{source}/{topic}");
        if best.get(&key).is_none_or(|(v, _)| *v < version) {
            best.insert(key, (version, spool.to_owned()));
        }
    }
    let topic_spool: HashMap<String, String> = best.into_iter().map(|(k, (_, s))| (k, s)).collect();
    let spools = topic_spool.values().cloned().collect();
    Ok((spools, topic_spool))
}

struct ChildOut {
    code: Option<i32>,
    stdout: String,
    stderr: String,
    timed_out: bool,
}

/// Run `cmd` to completion, killing it after `timeout`. Output is read on threads so a full pipe
/// can never wedge the child.
fn run_child(mut cmd: Command, timeout: Duration) -> Result<ChildOut, String> {
    let name = cmd.get_program().to_string_lossy().into_owned();
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| format!("cannot run {name}: {e}"))?;
    fn reader(mut r: impl Read + Send + 'static) -> std::thread::JoinHandle<String> {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = r.read_to_end(&mut buf); // a read error only shortens the diagnostic text
            String::from_utf8_lossy(&buf).into_owned()
        })
    }
    let out = reader(child.stdout.take().expect("stdout is piped"));
    let err = reader(child.stderr.take().expect("stderr is piped"));
    let deadline = Instant::now() + timeout;
    let (status, timed_out) = loop {
        match child.try_wait() {
            Ok(Some(st)) => break (Some(st), false),
            Ok(None) if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break (None, true);
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(e) => return Err(format!("waiting for {name}: {e}")),
        }
    };
    Ok(ChildOut {
        code: status.and_then(|s| s.code()),
        stdout: out.join().unwrap_or_default(),
        stderr: err.join().unwrap_or_default(),
        timed_out,
    })
}

/// Bring the tap up: parse the manifest (an unreadable manifest is a startup error, `Err`), create
/// `<data_dir>/ingest`, run `aldigest register`. A failing register (for example a database of
/// another layout version) does NOT stop alcore: the existing stores are the system of record, so
/// the tap stays off for this process and the reason is reported loudly and by /api/ingest-status.
pub fn start(manifest: &Path, aldigest_bin: &Path, interval_secs: u64, sources: Vec<String>, data_dir: &Path) -> Result<Start, String> {
    let (spools, topic_spool) = parse_manifest(manifest)?;
    let ingest_dir = data_dir.join("ingest");
    // `ready/` is created up front: `aldigest collect` fails on an ingest dir without one, and the
    // writer only creates it at the first seal, so the start-up collect would otherwise fail.
    let ready = ingest_dir.join("ready");
    std::fs::create_dir_all(&ready).map_err(|e| format!("{}: {e}", ready.display()))?;
    let done_retention = match std::env::var(DONE_RETENTION_ENV) {
        Ok(v) => match v.trim().parse::<u64>() {
            Ok(n) if n > 0 => Some(Duration::from_secs(n)),
            _ => {
                eprintln!("{} alcore: spool tap: {DONE_RETENTION_ENV}={v:?} is not a positive integer — ignored, done/ files are kept", log_ts());
                None
            }
        },
        Err(_) => None,
    };
    let queue_max_bytes = match std::env::var(QUEUE_MAX_BYTES_ENV) {
        Ok(v) => match v.trim().parse::<usize>() {
            Ok(n) if n > 0 => n,
            _ => {
                eprintln!("{} alcore: spool tap: {QUEUE_MAX_BYTES_ENV}={v:?} is not a positive integer — ignored, using {QUEUE_MAX_BYTES}", log_ts());
                QUEUE_MAX_BYTES
            }
        },
        Err(_) => QUEUE_MAX_BYTES,
    };
    let purge_batch = match std::env::var(PURGE_BATCH_ENV) {
        Ok(v) => match v.trim().parse::<usize>() {
            Ok(n) if n > 0 => n,
            _ => {
                eprintln!("{} alcore: spool tap: {PURGE_BATCH_ENV}={v:?} is not a positive integer — ignored, using {PURGE_BATCH}", log_ts());
                PURGE_BATCH
            }
        },
        Err(_) => PURGE_BATCH,
    };
    let tap = SpoolTap {
        done_retention,
        purge_batch,
        tx: Mutex::new(None),
        writer_done: Mutex::new(None),
        queued_bytes: AtomicUsize::new(0),
        queue_max_bytes,
        db: ingest_dir.join("events.duckdb"),
        ingest_dir,
        manifest: manifest.to_path_buf(),
        aldigest_bin: aldigest_bin.to_path_buf(),
        interval: Duration::from_secs(interval_secs),
        sources,
        spools,
        topic_spool,
        stats: Mutex::new(Stats::default()),
    };
    match tap.register() {
        Ok(()) => {
            let tap = Arc::new(tap);
            let (tx, rx) = sync_channel::<Batch>(QUEUE_CAPACITY);
            let writer = Arc::clone(&tap);
            let (done_tx, done_rx) = channel::<()>();
            std::thread::Builder::new()
                .name("spool-tap-writer".into())
                .spawn(move || {
                    // A panic in write_loop must be visible without further traffic (enqueue only
                    // notices a dead writer on the next send), so the guard flags it on unwind.
                    struct DeathWatch<'a>(&'a SpoolTap);
                    impl Drop for DeathWatch<'_> {
                        fn drop(&mut self) {
                            if std::thread::panicking() {
                                self.0.stats().writer_dead = true;
                                eprintln!("{} alcore: spool tap: the writer thread panicked — spool writes are dropped from now on (the existing stores are unaffected)", log_ts());
                            }
                        }
                    }
                    {
                        let _watch = DeathWatch(&writer);
                        writer.write_loop(rx);
                    }
                    let _ = done_tx.send(());
                })
                .map_err(|e| format!("cannot start the spool tap writer thread: {e}"))?;
            *tap.tx.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
            *tap.writer_done.lock().unwrap_or_else(|e| e.into_inner()) = Some(done_rx);
            Ok(Start::Tap(tap))
        }
        Err(e) => {
            let reason = format!("aldigest register failed: {e}");
            eprintln!("{} alcore: SPOOL TAP DISABLED for this process — {reason}. The existing stores are unaffected.", log_ts());
            Ok(Start::Disabled(reason))
        }
    }
}

/// The body of `GET /api/ingest-status`.
pub fn status(st: &CoreState) -> Value {
    match &st.spool_tap {
        Some(tap) => tap.status_json(),
        None => json!({ "enabled": false, "reason": st.spool_tap_off_reason }),
    }
}

impl SpoolTap {
    pub fn interval(&self) -> Duration {
        self.interval
    }

    fn stats(&self) -> MutexGuard<'_, Stats> {
        self.stats.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn register(&self) -> Result<(), String> {
        let mut cmd = Command::new(&self.aldigest_bin);
        cmd.arg("register").arg("--db").arg(&self.db).arg("--manifest").arg(&self.manifest);
        let out = run_child(cmd, REGISTER_TIMEOUT)?;
        if out.timed_out {
            return Err(format!("no answer within {} s", REGISTER_TIMEOUT.as_secs()));
        }
        if out.code != Some(0) {
            return Err(format!("exit {:?}: {}", out.code, out.stderr.trim()));
        }
        println!("{} alcore: spool tap on: {}", log_ts(), out.stdout.trim());
        Ok(())
    }

    fn spool_of(&self, source: &str, topic: &str) -> Option<&str> {
        self.topic_spool.get(&format!("{source}/{topic}")).map(String::as_str)
    }

    fn note_unknown(&self, names: impl IntoIterator<Item = (String, u64)>) {
        let mut s = self.stats();
        for (key, n) in names {
            if let Some(c) = s.unknown.get_mut(&key) {
                *c += n;
            } else if s.unknown.len() >= UNKNOWN_NAMES_MAX {
                s.unknown_overflow += n;
            } else {
                eprintln!("{} alcore: spool tap: no spool for {key} in the manifest — not written, counted in /api/ingest-status", log_ts());
                s.unknown.insert(key, n);
            }
        }
    }

    fn note_error(&self, spool: &str, msg: &str) {
        let mut s = self.stats();
        s.write_errors += 1;
        *s.write_errors_by_spool.entry(spool.to_owned()).or_default() += 1;
        if s.last_error_logged.get(spool).is_none_or(|t| t.elapsed() >= ERROR_LOG_EVERY) {
            s.last_error_logged.insert(spool.to_owned(), Instant::now());
            eprintln!("{} alcore: spool tap: write to spool {spool} failed (capture unaffected): {msg}", log_ts());
        }
    }

    fn write(&self, spool: &str, payloads: &[&[u8]]) {
        let n = payloads.len() as u64;
        match append_many(&self.ingest_dir, spool, payloads, DEFAULT_SEAL_BYTES) {
            Ok(Appended::Written | Appended::Sealed(_)) => *self.stats().written.entry(spool.to_owned()).or_default() += n,
            Ok(Appended::SealFailed(why)) => {
                *self.stats().written.entry(spool.to_owned()).or_default() += n;
                self.note_error(spool, &format!("lines written, the seal that was due failed: {why}"));
            }
            Err(e) => self.note_error(spool, &e),
        }
    }

    /// `lines` in batches of at most BATCH_MAX_BYTES, each one lock hold.
    fn write_lines(&self, spool: &str, lines: &[Vec<u8>]) {
        let (mut start, mut bytes) = (0, 0);
        let flush = |range: std::ops::Range<usize>| {
            let refs: Vec<&[u8]> = lines[range].iter().map(Vec::as_slice).collect();
            self.write(spool, &refs);
        };
        for (i, l) in lines.iter().enumerate() {
            if i > start && bytes + l.len() > BATCH_MAX_BYTES {
                flush(start..i);
                (start, bytes) = (i, 0);
            }
            bytes += l.len();
        }
        flush(start..lines.len());
    }

    /// A hook payload, exactly the bytes that arrived (`raw`), into the spool of its event name.
    pub fn wants(&self, source: &str) -> bool {
        self.sources.iter().any(|s| s == source)
    }

    /// Hands one batch of lines of ONE spool to the writer thread; never blocks the caller (a hook,
    /// status-line or OTLP POST that may hold the global state lock). One thread and one FIFO channel
    /// keep the lines in arrival order and bound the memory a stalled spool lock can pile up: a full
    /// queue drops the batch and counts it in `droppedQueueFull` (the existing stores still have the
    /// item), logged at most once a minute. After shutdown closed the channel a batch is dropped the
    /// same way. Why not `spawn_blocking` per write: tasks of one session could reach the file out of
    /// order, and a stalled lock parked an unbounded number of them on tokio's shared blocking pool.
    fn enqueue(&self, spool: String, lines: Vec<Vec<u8>>) {
        let n: usize = lines.iter().map(Vec::len).sum();
        let prev = self.queued_bytes.fetch_add(n, Ordering::SeqCst);
        let refused = if prev != 0 && prev + n > self.queue_max_bytes {
            Some(("full", "the writer queue is over its byte bound"))
        } else {
            match self.tx.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
                Some(tx) => match tx.try_send((spool, lines)) {
                    Ok(()) => None,
                    Err(TrySendError::Full(_)) => Some(("full", "the writer queue is full")),
                    Err(TrySendError::Disconnected(_)) => Some(("dead", "the writer thread is dead")),
                },
                None => Some(("shutdown", "the tap is shut down")),
            }
        };
        let Some((kind, why)) = refused else { return };
        self.queued_bytes.fetch_sub(n, Ordering::SeqCst);
        let mut s = self.stats();
        match kind {
            "full" => s.dropped_queue_full += 1,
            "dead" => {
                s.dropped_writer_dead += 1;
                s.writer_dead = true;
            }
            _ => s.dropped_after_shutdown += 1,
        }
        // Once per process and kind: a stalled or dead writer would otherwise log per item.
        if s.last_error_logged.insert(format!("<queue:{kind}>"), Instant::now()).is_none() {
            eprintln!("{} alcore: spool tap: batch dropped, {why} (capture unaffected; counted in /api/ingest-status; logged once)", log_ts());
        }
    }

    pub fn hook(self: &Arc<Self>, event: &str, raw: &[u8]) {
        if !self.wants("hooks") {
            return;
        }
        let topic = snake_case(event);
        match self.spool_of("hook", &topic) {
            Some(spool) => self.enqueue(spool.to_owned(), vec![raw.to_vec()]),
            None => self.note_unknown([(format!("hook/{topic}"), 1)]),
        }
    }

    /// A status-line sample without the two keys the CLI adds. Re-serialised (a key is dropped), but
    /// each value is written with its own `to_string`, so nothing is cloned.
    pub fn statusline(self: &Arc<Self>, payload: &Map<String, Value>, stream: &str) {
        if !self.wants("statusline") {
            return;
        }
        let spool = if stream == "subagent" { "statusline_subagent" } else { "statusline_main" };
        if !self.spools.contains(spool) {
            self.note_unknown([(spool.to_owned(), 1)]);
            return;
        }
        let mut line = String::from("{");
        for (k, v) in payload.iter().filter(|(k, _)| !STATUSLINE_CLI_KEYS.contains(&k.as_str())) {
            if line.len() > 1 {
                line.push(',');
            }
            line.push_str(&Value::from(k.as_str()).to_string());
            line.push(':');
            line.push_str(&v.to_string());
        }
        line.push('}');
        self.enqueue(spool.to_owned(), vec![line.into_bytes()]);
    }

    /// One line per log record / span of a parsed OTLP POST. Called by the OTLP handler BEFORE
    /// `ingest_parsed` and outside the state lock: the request pays only for building the line
    /// strings; the file writes happen on the tap's writer thread (see `enqueue`).
    pub fn otlp(self: &Arc<Self>, kind: &str, payload: &Value) {
        let (source, items) = match kind {
            "logs" if !self.wants("events") => return,
            "traces" if !self.wants("spans") => return,
            "logs" => ("telemetry_event", agentlens_ingest::log_tap_records(payload)),
            "traces" => ("telemetry_span", agentlens_ingest::span_tap_records(payload)),
            _ => return,
        };
        let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
        let mut unknown: HashMap<String, u64> = HashMap::new();
        for (name, record) in items {
            let topic = if source == "telemetry_span" { span_topic(&name) } else { name };
            match self.spool_of(source, &topic) {
                Some(spool) => groups.entry(spool.to_owned()).or_default().push(Value::Object(record).to_string()),
                None => *unknown.entry(format!("{source}/{topic}")).or_default() += 1,
            }
        }
        if !unknown.is_empty() {
            self.note_unknown(unknown);
        }
        if groups.is_empty() {
            return;
        }
        for (spool, lines) in groups {
            self.enqueue(spool, lines.into_iter().map(String::into_bytes).collect());
        }
    }

    /// An API body file the bodies pass just ingested: the line is built by concatenation around the
    /// file text, never by parsing it. Only a JSON object is accepted (anything else is skipped and
    /// counted); the spool writer syntax-checks the finished line.
    pub fn body(&self, name: &str, raw: &str) {
        if !self.wants("bodies") {
            return;
        }
        let (stem, spool) = if let Some(s) = name.strip_suffix(".request.json") {
            (s, "api_request")
        } else if let Some(s) = name.strip_suffix(".response.json") {
            (s, "api_response")
        } else {
            self.skip_body(name, "not a .request.json / .response.json file");
            return;
        };
        let text = raw.trim_matches(|c: char| c.is_ascii_whitespace());
        if !text.starts_with('{') {
            self.skip_body(name, "not a JSON object");
            return;
        }
        if !self.spools.contains(spool) {
            self.note_unknown([(spool.to_owned(), 1)]);
            return;
        }
        let line = format!("{{\"link\":{{\"body_id\":{}}},\"body\":{text}}}", Value::from(stem));
        self.write(spool, &[line.as_bytes()]);
    }

    fn skip_body(&self, name: &str, why: &str) {
        self.stats().bodies_skipped += 1;
        eprintln!("{} alcore: spool tap: body file {name} skipped ({why}), counted in /api/ingest-status", log_ts());
    }

    fn seal_logged(&self) {
        match agentlens_spool::seal(&self.ingest_dir, None) {
            Ok(v) if v.is_empty() => {}
            Ok(v) => println!("{} alcore: ingest seal: {} spool file(s) sealed", log_ts(), v.len()),
            Err(e) => eprintln!("{} alcore: ingest seal failed: {e}", log_ts()),
        }
    }

    /// The writer thread: appends batches in arrival order until every sender is gone and the queue
    /// is drained.
    fn write_loop(&self, rx: Receiver<Batch>) {
        while let Ok((spool, lines)) = rx.recv() {
            self.write_lines(&spool, &lines);
            self.queued_bytes.fetch_sub(lines.iter().map(Vec::len).sum(), Ordering::SeqCst);
        }
    }

    /// Graceful shutdown: close the queue and wait up to WRITER_JOIN_TIMEOUT for the writer to drain
    /// it, then seal; the next start collects. Queued writes are flushed, not lost. If the writer does
    /// not finish in time (it may be blocked on a spool lock) the seal is skipped, since sealing would
    /// block on the same lock: no path may hang shutdown.
    pub fn seal_for_shutdown(&self) {
        drop(self.tx.lock().unwrap_or_else(|e| e.into_inner()).take());
        let done = self.writer_done.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(done) = done {
            // Ok (signalled) and Disconnected (the writer exited or panicked) both mean it is gone.
            if let Err(RecvTimeoutError::Timeout) = done.recv_timeout(WRITER_JOIN_TIMEOUT) {
                eprintln!("{} alcore: spool tap: the writer did not drain within {} s at shutdown — seal skipped, queued lines are lost from the spool (the existing stores have them)", log_ts(), WRITER_JOIN_TIMEOUT.as_secs());
                return;
            }
        }
        self.seal_logged();
    }

    /// The scheduled chore: seal, then `aldigest collect` as a child under `.collect.lock`.
    /// Blocking; call it from `spawn_blocking`.
    pub fn seal_and_collect(&self) {
        self.seal_logged();
        let lock_path = self.ingest_dir.join(".collect.lock");
        let lock = match std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(&lock_path) {
            Ok(f) => f,
            Err(e) => {
                eprintln!("{} alcore: ingest collect: cannot open {}: {e}", log_ts(), lock_path.display());
                return;
            }
        };
        if let Err(e) = lock.try_lock_exclusive() {
            if e.raw_os_error() == fs2::lock_contended_error().raw_os_error() {
                eprintln!("{} alcore: ingest collect skipped — the previous collect still holds .collect.lock", log_ts());
            } else {
                eprintln!("{} alcore: ingest collect: cannot lock {}: {e}", log_ts(), lock_path.display());
            }
            return;
        }
        // One collect process grows in RSS with every committed file (measured 65 to 687 MiB over 72
        // API-body files; DuckDB itself, no setting bounds it), so each run loads at most
        // COLLECT_MAX_FILES files and a fresh process takes the rest, up to COLLECT_MAX_RUNS per tick.
        let mut record = Value::Null;
        for run in 1..=COLLECT_MAX_RUNS {
            let mut cmd = Command::new(&self.aldigest_bin);
            cmd.arg("collect").arg("--db").arg(&self.db).arg("--ingest-dir").arg(&self.ingest_dir).arg("--max-files").arg(COLLECT_MAX_FILES.to_string());
            let started = Instant::now();
            let at_ms = crate::now_ms();
            let mut more = false;
            record = match run_child(cmd, COLLECT_TIMEOUT) {
                Ok(o) => {
                    let ok = o.code == Some(0) && !o.timed_out;
                    more = ok && o.stdout.split_whitespace().find_map(|w| w.strip_prefix("remaining=")).and_then(|n| n.parse::<u64>().ok()).is_some_and(|n| n > 0);
                    let line = format!(
                        "{} alcore: ingest collect (run {run}): exit={:?}{} in {} ms: {}{}",
                        log_ts(),
                        o.code,
                        if o.timed_out { " (TIMED OUT, killed)" } else { "" },
                        started.elapsed().as_millis(),
                        o.stdout.trim(),
                        if o.stderr.trim().is_empty() { String::new() } else { format!(" | stderr: {}", o.stderr.trim()) }
                    );
                    if ok {
                        println!("{line}");
                    } else {
                        eprintln!("{line}");
                    }
                    json!({ "atMs": at_ms, "runs": run, "exit": o.code, "timedOut": o.timed_out, "summary": o.stdout.trim(), "stderr": o.stderr.trim() })
                }
                Err(e) => {
                    eprintln!("{} alcore: ingest collect: {e}", log_ts());
                    json!({ "atMs": at_ms, "runs": run, "error": e })
                }
            };
            if !more {
                break;
            }
        }
        self.stats().last_collect = Some(record);
        // Both still under `.collect.lock`: `aldigest views` writes the database, so it must never
        // overlap a collect child.
        self.rebuild_views_once();
        self.purge_done();
        drop(lock);
    }

    /// `aldigest views` once per process (the catalog only changes at `register`, which ran at
    /// start); a failure is reported in the status, logged once per distinct message, and retried on
    /// the next tick; it never blocks the collect before it or the retention after it.
    fn rebuild_views_once(&self) {
        if self.stats().views_ok {
            return;
        }
        let mut cmd = Command::new(&self.aldigest_bin);
        cmd.arg("views").arg("--db").arg(&self.db);
        let at_ms = crate::now_ms();
        let (ok, msg, record) = match run_child(cmd, VIEWS_TIMEOUT) {
            Ok(o) => {
                let ok = o.code == Some(0) && !o.timed_out;
                let msg = format!("exit={:?}{}: {}{}", o.code, if o.timed_out { " (TIMED OUT, killed)" } else { "" }, o.stdout.trim(), if o.stderr.trim().is_empty() { String::new() } else { format!(" | stderr: {}", o.stderr.trim()) });
                (ok, msg, json!({ "atMs": at_ms, "exit": o.code, "timedOut": o.timed_out, "summary": o.stdout.trim(), "stderr": o.stderr.trim() }))
            }
            Err(e) => (false, e.clone(), json!({ "atMs": at_ms, "error": e })),
        };
        let mut s = self.stats();
        if ok {
            println!("{} alcore: ingest views: {msg}", log_ts());
        } else if s.views_logged.as_ref() != Some(&msg) {
            eprintln!("{} alcore: ingest views failed (retried every tick, logged once per distinct message): {msg}", log_ts());
            s.views_logged = Some(msg);
        }
        s.views = Some(record);
        s.views_ok = ok;
    }

    /// Of the given done/ file names, the ledger's complete (spool, name) rows whose `completed_at` is
    /// at least `min_age_s` old. `_ingest.files.completed_at` is TIMESTAMPTZ (agentlens-digest
    /// register.rs:78) and collect writes it with `get_current_timestamp()` (collect.rs:160), an
    /// absolute instant. The age is taken in SQL with `date_diff('second', completed_at,
    /// get_current_timestamp())`, both absolute, so it is correct in any machine time zone and never
    /// compares against a Rust clock (`-` on two DOUBLE epochs or two TIMESTAMPTZ has no binder in this
    /// DuckDB build, so date_diff it is). The query is bounded by `source_name IN (<names>)`: the names
    /// are at most `PURGE_BATCH`, each passed `purge_name_ok` (safe as a SQL string literal), so the
    /// result never exceeds the list asked about. `date_diff('second', …)` counts second boundaries, so
    /// a file may be due up to one second early.
    /// ponytail: at most PURGE_BATCH (500) done/ files are examined per tick, in a window that rotates
    /// through done/ (see `purge_done`), so a full pass over N files takes N/500 ticks and un-ledgered
    /// files at the head cannot starve the rest. Upgrade path: a purged mark in the ledger, or a larger batch.
    fn complete_ledger(&self, min_age_s: u64, names: &[&str]) -> Result<HashSet<(String, String)>, String> {
        self.stats().done_ledger_queries += 1;
        let list = names.iter().map(|n| format!("'{n}'")).collect::<Vec<_>>().join(",");
        let mut cmd = Command::new(&self.aldigest_bin);
        cmd.arg("query").arg("--db").arg(&self.db).arg("--sql").arg(format!("SELECT spool, source_name FROM _ingest.files WHERE status = 'complete' AND source_name IN ({list}) AND date_diff('second', completed_at, get_current_timestamp()) >= {min_age_s}"));
        let out = run_child(cmd, LEDGER_TIMEOUT)?;
        if out.timed_out || out.code != Some(0) {
            return Err(format!("exit {:?}{}: {}", out.code, if out.timed_out { " (TIMED OUT)" } else { "" }, out.stderr.trim()));
        }
        let mut ledger = HashSet::new();
        for line in out.stdout.lines().filter(|l| !l.trim().is_empty()) {
            let row: Value = serde_json::from_str(line).map_err(|e| format!("unreadable ledger row {line:?}: {e}"))?;
            let (Some(spool), Some(name)) = (row["spool"].as_str(), row["source_name"].as_str()) else {
                return Err(format!("unexpected ledger row {line:?}"));
            };
            ledger.insert((spool.to_owned(), name.to_owned()));
        }
        Ok(ledger)
    }

    /// Only when the owner opted in (`done_retention`): delete a regular file directly inside
    /// `done/<spool>/` (registered spools only) when the database ledger lists it as complete AND its
    /// `completed_at` is at least the retention old. A file with no complete ledger row is never
    /// deleted, and the file mtime is never consulted (a backfilled file has an old mtime; a clock jump
    /// must not delete everything). If the ledger cannot be read nothing is deleted this tick.
    /// `failed/`, `ready/` and `inbox/` are never touched; symlinks are never followed (a `done/<spool>`
    /// that is a symlink is skipped, and so is any entry that is not a regular file). An error is
    /// logged and counted.
    /// The done/ listing comes FIRST: with no regular file there, no ledger query (no child) runs. At
    /// most `purge_batch` names are put to the ledger per tick, as a rotating window over the sorted
    /// names (they start with a nanosecond timestamp): each tick takes the next names AFTER the last
    /// one examined (`Stats::done_cursor`) and wraps to the start when the end is reached. A head-only
    /// window would be pinned forever by files with no complete ledger row, which never leave done/.
    /// A name outside `[0-9A-Za-z._-]` is never listed and never
    /// deleted (it is used as a SQL string literal, so it is not quoted, it is refused).
    /// ponytail: 500 names per tick is the ceiling; the window rotates, so a full pass over N files
    /// takes N/500 ticks. Upgrade path: a purged mark in the ledger, or a larger batch.
    fn purge_done(&self) {
        let Some(retention) = self.done_retention else { return };
        let errors = std::cell::Cell::new(0u64);
        let fail = |what: &str, e: &dyn std::fmt::Display| {
            errors.set(errors.get() + 1);
            eprintln!("{} alcore: ingest done retention: {what}: {e}", log_ts());
        };
        // (file name, spool, path) of every regular file in a registered done/<spool>/.
        let mut cands: Vec<(String, String, std::path::PathBuf)> = Vec::new();
        for spool in &self.spools {
            let dir = self.ingest_dir.join("done").join(spool);
            match std::fs::symlink_metadata(&dir) {
                Ok(m) if m.file_type().is_dir() => {}
                Ok(_) => continue,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                Err(e) => {
                    fail(&dir.display().to_string(), &e);
                    continue;
                }
            }
            let rd = match std::fs::read_dir(&dir) {
                Ok(rd) => rd,
                Err(e) => {
                    fail(&dir.display().to_string(), &e);
                    continue;
                }
            };
            for ent in rd {
                let ent = match ent {
                    Ok(ent) => ent,
                    Err(e) => {
                        fail(&dir.display().to_string(), &e);
                        continue;
                    }
                };
                let Some(name) = ent.file_name().to_str().filter(|n| purge_name_ok(n)).map(str::to_owned) else { continue };
                let path = ent.path();
                // A file that vanished between read_dir and here is not an error: skip it.
                match std::fs::symlink_metadata(&path) {
                    Ok(m) if m.file_type().is_file() => cands.push((name, spool.clone(), path)),
                    Ok(_) => {}
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                    Err(e) => fail(&path.display().to_string(), &e),
                }
            }
        }
        cands.sort();
        // Rotating window: the next `purge_batch` names after the cursor; an empty remainder wraps to the head.
        let cursor = self.stats().done_cursor.clone();
        let mut start = cursor.as_ref().map_or(0, |c| cands.partition_point(|x| x.0.as_str() <= c.as_str()));
        if start >= cands.len() {
            start = 0;
        }
        let end = (start + self.purge_batch).min(cands.len());
        let full_batch = end - start == self.purge_batch;
        // A window that reaches the end resets the cursor, so the next tick starts at the head.
        self.stats().done_cursor = if end < cands.len() { Some(cands[end - 1].0.clone()) } else { None };
        let cands: Vec<_> = cands.drain(start..end).collect();
        let (mut deleted, mut bytes) = (0u64, 0u64);
        if !cands.is_empty() {
            let names: Vec<&str> = cands.iter().map(|c| c.0.as_str()).collect();
            match self.complete_ledger(retention.as_secs(), &names) {
                Err(e) => {
                    errors.set(errors.get() + 1);
                    let mut s = self.stats();
                    if s.ledger_logged.as_ref() != Some(&e) {
                        eprintln!("{} alcore: ingest done retention: cannot read the ledger, deleting nothing this tick (logged once per distinct message): {e}", log_ts());
                        s.ledger_logged = Some(e);
                    }
                }
                Ok(ledger) => {
                    {
                        let mut s = self.stats();
                        s.ledger_logged = None;
                        s.done_examined += cands.len() as u64;
                        s.done_unledgered = cands.iter().filter(|c| !ledger.contains(&(c.1.clone(), c.0.clone()))).count() as u64;
                    }
                    for (name, spool, path) in &cands {
                        if !ledger.contains(&(spool.clone(), name.clone())) {
                            continue;
                        }
                        // Re-check: the entry may have changed since the listing.
                        let meta = match std::fs::symlink_metadata(path) {
                            Ok(m) => m,
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
                            Err(e) => {
                                fail(&path.display().to_string(), &e);
                                continue;
                            }
                        };
                        if !meta.file_type().is_file() {
                            continue;
                        }
                        match std::fs::remove_file(path) {
                            Ok(()) => {
                                deleted += 1;
                                bytes += meta.len();
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                            Err(e) => fail(&path.display().to_string(), &e),
                        }
                    }
                }
            }
        }
        let mut s = self.stats();
        if full_batch && deleted == 0 && errors.get() == 0 && !s.done_stuck_logged {
            s.done_stuck_logged = true;
            eprintln!("{} alcore: ingest done retention: a full batch of {} done/ names deleted nothing (none is complete in the ledger yet, or none is old enough); the window rotates on (logged once per process)", log_ts(), self.purge_batch);
        }
        s.done_deleted += deleted;
        s.done_deleted_bytes += bytes;
        s.done_delete_errors += errors.get();
    }

    pub fn status_json(&self) -> Value {
        let s = self.stats();
        json!({
            "enabled": true,
            "intervalSecs": self.interval.as_secs(),
            "sources": self.sources,
            "linesWritten": s.written.values().sum::<u64>(),
            "linesBySpool": s.written,
            "unknown": s.unknown,
            "unknownOverflow": s.unknown_overflow,
            "writeErrors": s.write_errors,
            "writeErrorsBySpool": s.write_errors_by_spool,
            "bodiesSkipped": s.bodies_skipped,
            "lastCollect": s.last_collect,
            "views": s.views,
            "doneDeleted": s.done_deleted,
            "doneDeletedBytes": s.done_deleted_bytes,
            "doneDeleteErrors": s.done_delete_errors,
            "doneLedgerQueries": s.done_ledger_queries,
            "doneExamined": s.done_examined,
            "doneUnledgered": s.done_unledgered,
            "doneRetentionSecs": self.done_retention.map(|d| d.as_secs()),
            "droppedQueueFull": s.dropped_queue_full,
            "droppedAfterShutdown": s.dropped_after_shutdown,
            "droppedWriterDead": s.dropped_writer_dead,
            "writerDead": s.writer_dead,
        })
    }
}

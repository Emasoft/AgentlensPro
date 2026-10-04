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
//! and OTLP write runs on the blocking pool, outside the global state lock its caller holds (see
//! `off_request_path`): a spool file lock held by another process stalls only that write. The price
//! is that a write queued but not yet started at shutdown is lost from the spool, not from the
//! existing stores.
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
}

pub struct SpoolTap {
    ingest_dir: PathBuf,
    db: PathBuf,
    manifest: PathBuf,
    aldigest_bin: PathBuf,
    interval: Duration,
    /// Enabled sources (see ALL_SOURCES); a source not in the list is never written.
    sources: Vec<String>,
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
    let tap = SpoolTap {
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
        Ok(()) => Ok(Start::Tap(Arc::new(tap))),
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
    fn write_lines(&self, spool: &str, lines: &[String]) {
        let (mut start, mut bytes) = (0, 0);
        let flush = |range: std::ops::Range<usize>| {
            let refs: Vec<&[u8]> = lines[range].iter().map(|l| l.as_bytes()).collect();
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

    /// Runs `work` on the blocking pool so the caller (which holds the global state lock) never waits
    /// on a spool file lock; outside a tokio runtime (a unit test) it runs inline.
    /// Every tap write (hook, status line, OTLP) runs on the blocking pool, off the request path and
    /// outside the global state lock the callers hold: a spool file lock held by another process
    /// stalls only that write, never a POST or a chore (ERROR POLICY: the tap must not delay capture).
    /// At shutdown a write queued but not yet started on the pool can be lost from the spool (the
    /// existing stores still have the item). Outside a tokio runtime (a unit test) it runs inline.
    fn off_request_path(self: &Arc<Self>, work: impl FnOnce(&SpoolTap) + Send + 'static) {
        if tokio::runtime::Handle::try_current().is_ok() {
            let tap = Arc::clone(self);
            // ponytail: unbounded queue of detached writers; see otlp.
            tokio::task::spawn_blocking(move || work(&tap));
        } else {
            work(self);
        }
    }

    pub fn hook(self: &Arc<Self>, event: &str, raw: &[u8]) {
        if !self.wants("hooks") {
            return;
        }
        let topic = snake_case(event);
        match self.spool_of("hook", &topic) {
            Some(spool) => {
                let (spool, raw) = (spool.to_owned(), raw.to_vec());
                self.off_request_path(move |tap| tap.write(&spool, &[&raw]));
            }
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
        self.off_request_path(move |tap| tap.write(spool, &[line.as_bytes()]));
    }

    /// One line per log record / span of a parsed OTLP POST. Called by the OTLP handler BEFORE
    /// `ingest_parsed` and outside the state lock: the request pays only for building the line
    /// strings; the file writes run on the blocking pool, not awaited by the request.
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
        let tap = Arc::clone(self);
        // ponytail: unbounded queue of detached writers; a stalled disk lets them pile up. Bound it
        // with a semaphore if that is ever observed.
        tokio::task::spawn_blocking(move || {
            for (spool, lines) in &groups {
                tap.write_lines(spool, lines);
            }
        });
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

    /// Graceful shutdown: seal only; the next start collects.
    pub fn seal_for_shutdown(&self) {
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
        drop(lock);
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
        })
    }
}

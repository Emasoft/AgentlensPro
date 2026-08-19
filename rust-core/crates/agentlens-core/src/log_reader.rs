//! The log reader as a LIBRARY call (TRDD-DMWOBWFH P5b): discovery → parallel parse → the
//! finish step → cards the core can `put_log_session`. Port of the TS boot path
//! (standalone/server.ts startup batch + src/rustLogScan.ts::finishRustTranscript), minus the
//! exec: the logscan crate is linked, so a ParsedTranscript never crosses a pipe.
//!
//! The finish step mirrors `finishRustTranscript` field for field:
//!   - speedBlendedCostUsd — Σ calc_token_cost_usd over blend_turns (present ONLY for a
//!     mixed-speed session, exactly when the parser emits blend_turns), appended as the card's
//!     LAST key (TS assigns it onto the finished card object).
//!   - hot-age strip — the PARENT card loses its timeline when the session's last activity is
//!     older than timeline_hot_age_ms (child cards keep their one tiny entry, as in TS).
//!   DEFERRED (recorded in the TRDD STATE, not bugs): accountId (needs the call-body registry the
//!   core does not have yet), generated-files attach (src/generatedFiles.ts fs heuristics), the
//!   statusline overlay (a separate subsystem), and the OpenCode per-message JSON fallback
//!   (TS takes it on a db error; here the error is logged and the db skipped).

use std::collections::HashMap;
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::Instant;

use agentlens_logscan::discovery::{discover_all, DiscoveredFile, Env, LogSource};
use agentlens_logscan::{ClaudeAccum, ParsedTranscript};
use agentlens_logscan::codex::CodexAccum;
use indexmap::IndexMap;
use rayon::prelude::*;
use serde_json::{Map, Value};

use crate::pricing::calc_token_cost_usd;
use crate::summarize::helpers;
use crate::summarize::retention::{timeline_hot_age_ms, timeline_max_bytes, timeline_max_entries};

/// One scanned file's outcome: its cards (parent first, then children) and the file state the
/// tailer records for it (the offset gate's single source of truth for "what has been read").
pub struct ScannedFile {
    pub file: String,
    pub file_size_bytes: u64,
    pub state: FileState,
    pub cards: Vec<Value>,
}

/// TS `FileState` (logReader.ts): the tail offset plus the file's identity, so a later sweep can
/// tell "unchanged" (skip), "grew" (resume) and "replaced/shrunk" (re-read from 0) apart.
/// `ino` 0 = no identity claim (a platform without inodes; the TS optional `ino`).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct FileState {
    pub bytes_read: u64,
    pub mtime_ms: f64,
    pub ino: u64,
    pub size: u64,
}

fn stat(path: &Path) -> Option<(f64, u64, u64)> {
    let m = std::fs::metadata(path).ok()?;
    let mtime_ms = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs_f64() * 1000.0);
    #[cfg(unix)]
    let ino = { use std::os::unix::fs::MetadataExt; m.ino() };
    #[cfg(not(unix))]
    let ino = 0u64;
    Some((mtime_ms, ino, m.len()))
}

pub struct ScanStats {
    pub files: usize,
    pub parsed: usize,
    pub cards: usize,
    pub elapsed_ms: u128,
}

/// finishRustTranscript — the card(s) for one parsed transcript, as the TS wrapper would hand
/// them to putLogSession. `state` is what the tailer records for the file (its bytes_read is
/// the parse's own consumed length, as the TS wrapper seeds fileState from fileSizeBytes).
pub fn finish_transcript(mut parsed: ParsedTranscript, now_ms: i64, state: FileState) -> ScannedFile {
    let hot_age = timeline_hot_age_ms();
    let last = parsed.last_timestamp_ms;
    if last > 0 && now_ms - last > hot_age {
        parsed.card.strip_timeline();
    }
    let blended = parsed.blend_turns.as_ref().map(|turns| {
        turns
            .iter()
            .fold(0.0, |sum, t| sum + calc_token_cost_usd(t.input, t.cache_read, t.cache_create, t.output, &t.model, 0.0, None, now_ms as f64))
    });
    let mut cards: Vec<Value> = Vec::with_capacity(1 + parsed.child_cards.len());
    let mut parent = card_value(&parsed.card);
    if let (Some(cost), Some(obj)) = (blended, parent.as_object_mut()) {
        obj.insert("speedBlendedCostUsd".to_owned(), helpers::num(cost));
    }
    cards.push(parent);
    for child in &parsed.child_cards {
        cards.push(card_value(child));
    }
    ScannedFile { file: parsed.file, file_size_bytes: parsed.file_size_bytes, state, cards }
}

/// The state a from-0 whole-file parse records: bytes_read = what the parse consumed.
fn state_after(parsed: &ParsedTranscript, st: (f64, u64, u64)) -> FileState {
    FileState { bytes_read: parsed.file_size_bytes, mtime_ms: st.0, ino: st.1, size: st.2 }
}

/// A Card as the wire Value: the typed struct's f64 counters serialize as `180.0`, while every
/// other served card (the summarizer's Value-literal builders, the TS engine) prints an integral
/// number bare (`180`). Normalizing here keeps one number shape across the whole served
/// summary — and lets the oracle test compare Values directly.
fn card_value(card: &agentlens_logscan::Card) -> Value {
    let mut v = serde_json::to_value(card).unwrap_or(Value::Null);
    bare_integral_numbers(&mut v);
    v
}

fn bare_integral_numbers(v: &mut Value) {
    match v {
        Value::Number(n) => {
            if let Some(f) = n.as_f64().filter(|_| n.is_f64()) {
                *v = helpers::num(f);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(bare_integral_numbers),
        Value::Object(o) => o.values_mut().for_each(bare_integral_numbers),
        _ => {}
    }
}

fn parse_one(f: &DiscoveredFile) -> Option<ParsedTranscript> {
    let path = f.path.to_str()?;
    match f.source {
        LogSource::Claude => agentlens_logscan::parse_transcript(path, timeline_max_entries(), timeline_max_bytes()).ok()?,
        LogSource::Codex => agentlens_logscan::codex::parse_codex_transcript(path).ok()?,
        LogSource::CopilotCli => agentlens_logscan::copilot::parse_copilot_cli(path).ok()?,
        LogSource::CopilotVscode => agentlens_logscan::copilot::parse_copilot_vscode(path).ok()?,
        LogSource::CopilotVscodeJson => agentlens_logscan::copilot::parse_copilot_vscode_json(path).ok()?,
        LogSource::OpenCodeDb => None, // one db → many sessions; handled sequentially below
    }
}

/// The cold boot scan: every discovered session file, parsed in parallel (a file that cannot
/// be read or yields no timestamps is skipped, as the TS sweep does), finished, in discovery
/// order. OpenCode dbs are parsed sequentially (rusqlite, native WAL read).
pub fn cold_scan(env: &Env, now_ms: i64) -> (Vec<ScannedFile>, ScanStats) {
    let t0 = Instant::now();
    let files = discover_all(env);
    let mut out: Vec<ScannedFile> = files
        .par_iter()
        .filter_map(|f| {
            // Stat BEFORE the parse: a file that grows while we read it then shows a newer
            // mtime/size than the state we record, and the next sweep re-reads it — the
            // conservative-safe direction (TS seeds fileState from the sidecar's fileSizeBytes).
            let st = stat(&f.path)?;
            parse_one(f).map(|p| {
                let state = state_after(&p, st);
                finish_transcript(p, now_ms, state)
            })
        })
        .collect();
    for f in files.iter().filter(|f| f.source == LogSource::OpenCodeDb) {
        if let Some((_, scanned)) = parse_opencode(&f.path, now_ms) {
            out.extend(scanned);
        }
    }
    let cards = out.iter().map(|s| s.cards.len()).sum();
    let stats = ScanStats { files: files.len(), parsed: out.len(), cards, elapsed_ms: t0.elapsed().as_millis() };
    (out, stats)
}

/// OpenCode: one db → MANY cards, each ScannedFile carrying the db's state. Errors are logged
/// and the db skipped (TS routes a db error to its per-message JSON fallback, an older on-disk
/// format, and counts `logReader.opencodeDbFallback`; that parser is not ported — deferred).
fn parse_opencode(db: &Path, now_ms: i64) -> Option<(FileState, Vec<ScannedFile>)> {
    let state = opencode_state(db)?;
    let path = db.to_string_lossy();
    match agentlens_logscan::opencode::parse_opencode_db(&path, timeline_max_entries(), timeline_max_bytes()) {
        Ok(r) => {
            if r.schema_unsupported {
                eprintln!("alcore: opencode schema unsupported ({path}): session table lacks model/tokens columns; skipping");
            }
            Some((state, r.results.into_iter().map(|p| finish_transcript(p, now_ms, state)).collect()))
        }
        Err(e) => {
            eprintln!("alcore: opencode db error {path}: {e} (sessions from this db not ingested)");
            None
        }
    }
}

/// The OpenCode 2-stat gate (TS _scanOpenCode): OpenCode writes to the `-wal` sibling, not the
/// `.db` file, so the effective mtime is the newer of the two; bytes_read = the db size.
fn opencode_state(db: &Path) -> Option<FileState> {
    let (mtime, ino, size) = stat(db)?;
    let mut wal = PathBuf::from(db.as_os_str());
    wal.set_extension("db-wal");
    let wal_mtime = stat(&wal).map_or(0.0, |s| s.0);
    Some(FileState { bytes_read: size, mtime_ms: mtime.max(wal_mtime), ino, size })
}

// ── The incremental tailer (TS LogReader.fileState + accumCache + _incrementalParse) ────────────

const ACCUM_CACHE_MAX: usize = 24;
/// TS MAX_ARRAY_READ_BYTES — the whole-file re-read path (Copilot logs) refuses oversized files.
const MAX_ARRAY_READ_BYTES: u64 = 256 * 1024 * 1024;

enum Accum {
    Claude(ClaudeAccum),
    Codex(CodexAccum),
}

/// A sweep's counters — `incremental_reads`/`full_reads` make the tail-vs-from-0 decision
/// observable (TS `_recordReadKind`).
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct SweepStats {
    pub files: usize,
    pub changed: usize,
    pub parsed: usize,
    pub cards: usize,
    pub incremental_reads: u64,
    pub full_reads: u64,
    pub elapsed_ms: u128,
}

/// Owns the per-file offset gate and the bounded accumulator cache. `!Send` (the accumulators
/// hold Rc entries) — it lives on ONE thread: the boot sweep, then every periodic sweep.
#[derive(Default)]
pub struct LogTailer {
    pub file_state: HashMap<PathBuf, FileState>,
    /// LRU (insertion order, re-inserted on touch) of the last ACCUM_CACHE_MAX parsed files.
    accums: IndexMap<PathBuf, Accum>,
}

impl LogTailer {
    fn lru_put(&mut self, path: PathBuf, accum: Accum) {
        self.accums.shift_remove(&path);
        self.accums.insert(path, accum);
        while self.accums.len() > ACCUM_CACHE_MAX {
            self.accums.shift_remove_index(0);
        }
    }

    /// The unchanged-file short-circuit: same mtime, size == bytes read, and the same inode when
    /// one is recorded (a rename-replace can land on identical mtime+size — TS _processFile).
    fn unchanged(prev: Option<&FileState>, st: (f64, u64, u64)) -> bool {
        prev.is_some_and(|p| st.0 == p.mtime_ms && st.2 == p.bytes_read && (p.ino == 0 || st.1 == p.ino))
    }

    /// One full sweep over every discovered file. With NO state yet (boot) it is the parallel
    /// cold scan and seeds the state; afterwards only files whose stat moved are touched, each
    /// through the accumulator path (resume when the accumulator is cached AND the file is the
    /// same and did not shrink, else from 0 — which CACHES the accumulator, so the next growth
    /// tails). Returns the changed files' cards and the counters.
    pub fn sweep(&mut self, env: &Env, now_ms: i64) -> (Vec<ScannedFile>, SweepStats) {
        if self.file_state.is_empty() {
            let (scanned, s) = cold_scan(env, now_ms);
            for f in &scanned {
                self.file_state.insert(PathBuf::from(&f.file), f.state);
            }
            let stats = SweepStats {
                files: s.files,
                changed: s.files,
                parsed: s.parsed,
                cards: s.cards,
                incremental_reads: 0,
                full_reads: s.parsed as u64,
                elapsed_ms: s.elapsed_ms,
            };
            return (scanned, stats);
        }
        let t0 = Instant::now();
        let files = discover_all(env);
        let mut out: Vec<ScannedFile> = Vec::new();
        let mut stats = SweepStats { files: files.len(), ..SweepStats::default() };
        for f in &files {
            match f.source {
                LogSource::OpenCodeDb => {
                    let Some(st) = opencode_state(&f.path) else { continue };
                    if self.file_state.get(&f.path).is_some_and(|p| p.mtime_ms == st.mtime_ms && p.bytes_read == st.size) {
                        continue;
                    }
                    stats.changed += 1;
                    self.file_state.insert(f.path.clone(), st);
                    if let Some((_, scanned)) = parse_opencode(&f.path, now_ms) {
                        stats.full_reads += 1;
                        stats.parsed += scanned.len();
                        out.extend(scanned);
                    }
                }
                LogSource::Claude | LogSource::Codex => {
                    let Some(st) = stat(&f.path) else { continue };
                    if Self::unchanged(self.file_state.get(&f.path), st) {
                        continue;
                    }
                    stats.changed += 1;
                    match self.tail_one(f, st, now_ms) {
                        Some((resumed, scanned)) => {
                            if resumed { stats.incremental_reads += 1 } else { stats.full_reads += 1 }
                            if let Some(s) = scanned {
                                stats.parsed += 1;
                                out.push(s);
                            }
                        }
                        None => {}
                    }
                }
                _ => {
                    // Copilot logs are small: whole-file re-read on change (TS _readNewLines).
                    let Some(st) = stat(&f.path) else { continue };
                    if Self::unchanged(self.file_state.get(&f.path), st) {
                        continue;
                    }
                    stats.changed += 1;
                    if st.2 > MAX_ARRAY_READ_BYTES {
                        // Recorded so the next sweep skips it instead of re-logging every pass.
                        self.file_state.insert(f.path.clone(), FileState { bytes_read: st.2, mtime_ms: st.0, ino: st.1, size: st.2 });
                        eprintln!("alcore: skipping oversized non-incremental log {} ({}MB)", f.path.display(), st.2 / 1_048_576);
                        continue;
                    }
                    stats.full_reads += 1;
                    let state = FileState { bytes_read: st.2, mtime_ms: st.0, ino: st.1, size: st.2 };
                    self.file_state.insert(f.path.clone(), state);
                    if let Some(p) = parse_one(f) {
                        stats.parsed += 1;
                        out.push(finish_transcript(p, now_ms, state));
                    }
                }
            }
        }
        stats.cards = out.iter().map(|s| s.cards.len()).sum();
        stats.elapsed_ms = t0.elapsed().as_millis();
        (out, stats)
    }

    /// _incrementalParse for one Claude/Codex file. Returns (resumed?, the finished file or None
    /// when the accumulator has no timestamps yet — the state is recorded either way, as in TS).
    fn tail_one(&mut self, f: &DiscoveredFile, st: (f64, u64, u64), now_ms: i64) -> Option<(bool, Option<ScannedFile>)> {
        let (mtime_ms, ino, size) = st;
        let prev = self.file_state.get(&f.path).copied();
        let prev_offset = prev.map_or(0, |p| p.bytes_read);
        // Resume only when the file is provably the SAME file: size alone is not identity (Claude
        // Code ≥2.1.208 prunes transcripts by replace-by-rename; a prune+append inside one sweep
        // can leave the new file at size ≥ the old offset).
        let same_file = prev.is_none_or(|p| p.ino == 0 || p.ino == ino);
        let cached = self.accums.shift_remove(&f.path);
        let can_resume = cached.is_some() && prev_offset > 0 && size >= prev_offset && same_file;
        let mut accum = match (can_resume, cached) {
            (true, Some(a)) => a,
            _ => match f.source {
                LogSource::Codex => Accum::Codex(CodexAccum::default()),
                _ => Accum::Claude(ClaudeAccum::new(timeline_max_entries(), timeline_max_bytes())),
            },
        };
        let from = if can_resume { prev_offset } else { 0 };
        let (lines, consumed) = match read_lines_from(&f.path, from) {
            Ok(x) => x,
            Err(e) => {
                eprintln!("alcore: read error {}: {e}", f.path.display());
                return None;
            }
        };
        for line in &lines {
            let Ok(v) = serde_json::from_slice::<Value>(line) else { continue };
            if let Value::Object(entry) = v {
                match &mut accum {
                    Accum::Claude(a) => agentlens_logscan::on_entry(a, &entry),
                    Accum::Codex(a) => agentlens_logscan::codex::on_entry(a, &entry),
                }
            }
        }
        let state = FileState { bytes_read: consumed, mtime_ms, ino, size };
        self.file_state.insert(f.path.clone(), state);
        let path_str = f.path.to_string_lossy();
        // A SHALLOW clone (Rc entries) handed to build_result, which only reads the entries and
        // copies them into the Card; the live accumulator goes back into the cache.
        let parsed = match &accum {
            Accum::Claude(a) => agentlens_logscan::build_result(&path_str, a.clone()),
            Accum::Codex(a) => agentlens_logscan::codex::build_result(&path_str, a.clone()),
        };
        self.lru_put(f.path.clone(), accum);
        Some((can_resume, parsed.map(|mut p| {
            p.file_size_bytes = consumed;
            finish_transcript(p, now_ms, state)
        })))
    }
}

/// TS `_streamLinesFrom`: the complete lines from `from` to EOF and the offset just past the last
/// '\n' — a trailing partial line is NOT consumed (it is re-read, whole, on the next sweep).
fn read_lines_from(path: &Path, from: u64) -> std::io::Result<(Vec<Vec<u8>>, u64)> {
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(from))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)?;
    let Some(last_nl) = buf.iter().rposition(|b| *b == b'\n') else { return Ok((Vec::new(), from)) };
    let lines = buf[..last_nl].split(|b| *b == b'\n').filter(|l| !l.iter().all(u8::is_ascii_whitespace)).map(<[u8]>::to_vec).collect();
    Ok((lines, from + last_nl as u64 + 1))
}

/// The log reader's thread: the boot sweep (returned once ingested, so the caller can bind its
/// listeners with the card map already populated — the TS server's synchronous boot batch), then
/// a sweep every `interval` forever (TS falls back to a 5s full poll when fs.watch is
/// unavailable; a notify-based watcher with the 60s backstop is a later slice). The tailer is
/// `!Send`, so it is created ON this thread and never leaves it.
pub fn start_sweeper(
    state: std::sync::Arc<std::sync::Mutex<crate::CoreState>>,
    env: Env,
    interval: std::time::Duration,
) -> Result<SweepStats, String> {
    let (tx, rx) = std::sync::mpsc::channel::<SweepStats>();
    std::thread::Builder::new()
        .name("log-sweeper".into())
        .spawn(move || {
            let mut tailer = LogTailer::default();
            let (scanned, stats) = tailer.sweep(&env, crate::now_ms());
            state.lock().expect("core state").ingest_scanned(scanned);
            let _ = tx.send(stats);
            loop {
                std::thread::sleep(interval);
                let (scanned, _) = tailer.sweep(&env, crate::now_ms());
                if !scanned.is_empty() {
                    state.lock().expect("core state").ingest_scanned(scanned);
                }
            }
        })
        .map_err(|e| format!("log-sweeper thread: {e}"))?;
    rx.recv().map_err(|_| "log-sweeper died during the boot sweep".to_owned())
}

/// A card's last-active instant for the global timeline tier: Date.parse(startTime) + durationMs
/// (server.ts demoteColdTimelines::lastActive; an unparseable start counts as 0).
pub fn last_active_ms(card: &Value) -> f64 {
    let start = card.get("startTime").and_then(Value::as_str).and_then(helpers::parse_iso_ms).unwrap_or(0.0);
    let dur = card.get("durationMs").and_then(Value::as_f64).unwrap_or(0.0);
    start + if dur > 0.0 { dur } else { 0.0 }
}

/// server.ts stripTimeline on a Value card (the TS holder shape): headers stay, the truncation
/// counter absorbs the dropped entries, retainedBytes pins to 0.
pub fn strip_timeline_value(card: &mut Map<String, Value>) {
    let n = card.get("timeline").and_then(Value::as_array).map_or(0, Vec::len);
    if n == 0 {
        return;
    }
    let prev = card.get("timelineTruncatedCount").and_then(Value::as_u64).unwrap_or(0);
    card.insert("timelineTruncatedCount".to_owned(), Value::from(prev + n as u64));
    card.insert("timeline".to_owned(), Value::Array(Vec::new()));
    card.insert("timelineRetainedBytes".to_owned(), Value::from(0));
}

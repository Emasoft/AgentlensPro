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
    // Node's `stats.mtimeMs` is `sec * 1e3 + nsec / 1e6` (lib/internal/fs/utils.js
    // msFromTimeSpec) — reproduce that exact float, not `as_secs_f64() * 1000`: the two round
    // differently in the last ulp, and a persisted TS offset then fails the equality gate for
    // ~25% of unchanged files (measured: 3,345 of 13,528 re-parsed on a cross-engine restore).
    let mtime_ms = m
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0.0, |d| d.as_secs() as f64 * 1000.0 + d.subsec_nanos() as f64 / 1e6);
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
            self.process_file(f, now_ms, &mut stats, &mut out);
        }
        stats.cards = out.iter().map(|s| s.cards.len()).sum();
        stats.elapsed_ms = t0.elapsed().as_millis();
        (out, stats)
    }

    /// The TARGETED sweep (LogReader._scanPaths, TRDD-X2E6OSWK): stat + parse ONLY the paths a
    /// watcher named — one stat per changed file instead of one per discovered file. Same
    /// per-file gate as the full sweep (`process_file`), so the two modes can never double-read a
    /// byte: the offsets are the single source of truth for "what has been read", not the mode.
    /// The OpenCode DBs are always re-checked (their writes land on the `-wal` sibling). NOT a
    /// correctness substitute for the full sweep — a watcher coalesces and can drop events.
    pub fn sweep_paths(&mut self, env: &Env, paths: &[PathBuf], now_ms: i64) -> (Vec<ScannedFile>, SweepStats) {
        let t0 = Instant::now();
        let roots = agentlens_logscan::discovery::LogRoots::resolve(env);
        let mut seen: std::collections::HashSet<&PathBuf> = std::collections::HashSet::new();
        let mut out: Vec<ScannedFile> = Vec::new();
        let mut stats = SweepStats::default();
        for path in paths {
            if !seen.insert(path) {
                continue; // a watch burst names the same file many times
            }
            let Some(source) = roots.classify(path) else { continue };
            stats.files += 1;
            let f = DiscoveredFile { source, path: path.clone() };
            self.process_file(&f, now_ms, &mut stats, &mut out);
        }
        for f in agentlens_logscan::discovery::discover_opencode(env) {
            stats.files += 1;
            self.process_file(&f, now_ms, &mut stats, &mut out);
        }
        stats.cards = out.iter().map(|s| s.cards.len()).sum();
        stats.elapsed_ms = t0.elapsed().as_millis();
        (out, stats)
    }

    /// LogReader._processFile — the ONE per-file change gate both sweep modes go through.
    fn process_file(&mut self, f: &DiscoveredFile, now_ms: i64, stats: &mut SweepStats, out: &mut Vec<ScannedFile>) {
        match f.source {
            LogSource::OpenCodeDb => {
                let Some(st) = opencode_state(&f.path) else { return };
                if self.file_state.get(&f.path).is_some_and(|p| p.mtime_ms == st.mtime_ms && p.bytes_read == st.size) {
                    return;
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
                let Some(st) = stat(&f.path) else { return };
                if Self::unchanged(self.file_state.get(&f.path), st) {
                    return;
                }
                stats.changed += 1;
                if let Some((resumed, scanned)) = self.tail_one(f, st, now_ms) {
                    if resumed { stats.incremental_reads += 1 } else { stats.full_reads += 1 }
                    if let Some(s) = scanned {
                        stats.parsed += 1;
                        out.push(s);
                    }
                }
            }
            _ => {
                // Copilot logs are small: whole-file re-read on change (TS _readNewLines).
                let Some(st) = stat(&f.path) else { return };
                if Self::unchanged(self.file_state.get(&f.path), st) {
                    return;
                }
                stats.changed += 1;
                if st.2 > MAX_ARRAY_READ_BYTES {
                    // Recorded so the next sweep skips it instead of re-logging every pass.
                    self.file_state.insert(f.path.clone(), FileState { bytes_read: st.2, mtime_ms: st.0, ino: st.1, size: st.2 });
                    eprintln!("alcore: skipping oversized non-incremental log {} ({}MB)", f.path.display(), st.2 / 1_048_576);
                    return;
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

// ── Durable state (P5e — server.ts TRDD-PJC8N1HO + the delta logs of TRDD-K3WDPR7M) ────────────

/// src/collectorState.ts LOG_INGEST_VERSION — the semantics stamp of the persisted cards/offsets.
/// A restart trusts the delta logs ONLY when `log-delta-version.json` carries this value; a bump
/// forces the cold rescan. Kept in lockstep with the TS constant by a test that reads the TS
/// source (tests/log_reader_parity.rs) until the cutover retires the TS side.
pub const LOG_INGEST_VERSION: u64 = 7;

/// TS `PersistedFileState` — the offset record as it sits in `log-offsets.*.ndjson`.
fn file_state_record(s: &FileState) -> Value {
    serde_json::json!({ "bytesRead": s.bytes_read, "mtimeMs": s.mtime_ms, "ino": s.ino, "size": s.size })
}

impl LogTailer {
    /// exportFileState — the offset map as delta-log records keyed by path.
    pub fn export_file_state(&self) -> IndexMap<String, Value> {
        self.file_state.iter().map(|(p, s)| (p.to_string_lossy().into_owned(), file_state_record(s))).collect()
    }

    /// importFileState — seed the gate from persisted records so the first sweep SKIPS every
    /// unchanged file. Each record is identity-checked against the file on disk (FAIL-FAST): a
    /// malformed record, a missing file, a different inode (rotated) or a size below the offset
    /// (truncated) is skipped → that file cold-reads. The accumulator is NOT restored, so a file
    /// that grew across the restart re-reads from 0 (complete card); the win is that thousands of
    /// unchanged files are never touched. Returns (imported, skipped).
    pub fn import_file_state(&mut self, records: &IndexMap<String, Value>) -> (usize, usize) {
        let (mut imported, mut skipped) = (0usize, 0usize);
        for (path, rec) in records {
            let (Some(bytes_read), Some(mtime_ms)) = (rec.get("bytesRead").and_then(Value::as_u64), rec.get("mtimeMs").and_then(Value::as_f64)) else {
                skipped += 1;
                continue;
            };
            let p = PathBuf::from(path);
            let Some((_, ino, size)) = stat(&p) else {
                skipped += 1;
                continue;
            };
            let rec_ino = rec.get("ino").and_then(Value::as_u64);
            if rec_ino.is_some_and(|i| i != 0 && i != ino) || size < bytes_read {
                skipped += 1;
                continue;
            }
            self.file_state.insert(
                p,
                FileState { bytes_read, mtime_ms, ino: rec_ino.unwrap_or(0), size: rec.get("size").and_then(Value::as_u64).unwrap_or(size) },
            );
            imported += 1;
        }
        (imported, skipped)
    }
}

/// stripCardForPersist — the persisted card keeps headers only: no timeline, no fileOps, no
/// background spans, no generated files (all rebuilt from the transcript on demand).
pub fn strip_card_for_persist(card: &Value) -> Value {
    let mut c = card.as_object().cloned().unwrap_or_default();
    c.insert("timeline".into(), Value::Array(Vec::new()));
    c.shift_remove("fileOps");
    c.insert("backgroundSpans".into(), Value::Array(Vec::new()));
    c.shift_remove("generatedFiles");
    c.shift_remove("generatedFilesTruncated");
    Value::Object(c)
}

/// The durable-state sidecars under the data dir, the save cadence, and the restore.
pub struct DurableState {
    cards: crate::delta_log::DeltaLog,
    offsets: crate::delta_log::DeltaLog,
    version_file: PathBuf,
    offsets_save: std::time::Duration,
    cards_save: std::time::Duration,
    /// The TS durable-save timer fires every offsets_save; both cadences are measured from it.
    last_timer: Instant,
    last_cards_save: Instant,
    offsets_dirty: bool,
    cards_dirty: bool,
}

fn env_ms(key: &str, default: u64, floor: u64) -> std::time::Duration {
    let v = std::env::var(key).ok().and_then(|s| s.trim().parse::<u64>().ok()).unwrap_or(default);
    std::time::Duration::from_millis(v.max(floor))
}

impl DurableState {
    /// server.ts: `log-sessions` + `log-offsets` delta logs, `log-delta-version.json`, offsets
    /// every AGENTLENS_OFFSETS_SAVE_MS (default 60s, floor 10s), cards every
    /// AGENTLENS_CARDS_SAVE_MS (default 5min, floor 30s) — cadence, not debounce, is the lever
    /// against SSD wear.
    pub fn open(data_dir: &Path) -> DurableState {
        let now = Instant::now();
        DurableState {
            cards: crate::delta_log::DeltaLog::new(data_dir, "log-sessions"),
            offsets: crate::delta_log::DeltaLog::new(data_dir, "log-offsets"),
            version_file: data_dir.join("log-delta-version.json"),
            offsets_save: env_ms("AGENTLENS_OFFSETS_SAVE_MS", 60_000, 10_000),
            cards_save: env_ms("AGENTLENS_CARDS_SAVE_MS", 300_000, 30_000),
            last_timer: now,
            last_cards_save: now,
            offsets_dirty: false,
            cards_dirty: false,
        }
    }

    fn version_is_current(&self) -> bool {
        std::fs::read_to_string(&self.version_file)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|v| v.get("v").and_then(Value::as_u64))
            == Some(LOG_INGEST_VERSION)
    }

    fn stamp_version(&self) {
        let tmp = PathBuf::from(format!("{}.tmp", self.version_file.display()));
        if std::fs::write(&tmp, format!("{{\"v\":{LOG_INGEST_VERSION}}}")).is_ok() {
            let _ = std::fs::rename(&tmp, &self.version_file);
        }
    }

    /// The restore (server.ts startup): when the delta logs are CURRENT, restored cards go into
    /// the map (timelines capped, then the global tier) and the offsets seed the tailer's gate.
    /// Returns (restored cards, imported offsets, skipped offsets); version-stale logs restore
    /// nothing and are tombstoned by the next save.
    pub fn restore(&mut self, tailer: &mut LogTailer, state: &mut crate::CoreState) -> Result<(usize, usize, usize), String> {
        let cards = self.cards.load()?;
        let offsets = self.offsets.load()?;
        if !self.version_is_current() {
            if !cards.is_empty() || !offsets.is_empty() {
                eprintln!("alcore: log-ingest semantics changed (v{LOG_INGEST_VERSION}) — cold-rescanning; stale delta-log entries are tombstoned on the next durable save");
            }
            return Ok((0, 0, 0));
        }
        let restored = cards.len();
        if restored > 0 {
            let (max_entries, max_bytes) = (timeline_max_entries(), timeline_max_bytes());
            for (_, mut card) in cards {
                // Normalize on restore (TRDD-66IXMIGN): a log written before the cap may hold giant
                // timelines; loading them uncapped rebuilds the very heap the cap prevents.
                if let Some(obj) = card.as_object_mut() {
                    if let Some(Value::Array(tl)) = obj.get_mut("timeline") {
                        let evicted = crate::summarize::retention::cap_timeline(tl, max_entries, max_bytes);
                        if evicted > 0 {
                            let prev = obj.get("timelineTruncatedCount").and_then(Value::as_u64).unwrap_or(0);
                            obj.insert("timelineTruncatedCount".into(), Value::from(prev + evicted as u64));
                        }
                    }
                }
                state.put_log_session(card);
            }
            state.demote_cold_timelines(crate::summarize::retention::timeline_hot_cards());
        }
        let (imported, skipped) = tailer.import_file_state(&offsets);
        Ok((restored, imported, skipped))
    }

    /// scheduleDurableSave — a sweep produced cards: both sidecars are dirty.
    pub fn mark_dirty(&mut self) {
        self.offsets_dirty = true;
        self.cards_dirty = true;
    }

    /// saveOffsetsNow — a save that wrote bytes counts as one write (persistStats.offsetsWrites).
    fn save_offsets(&mut self, tailer: &LogTailer, state: &std::sync::Mutex<crate::CoreState>) {
        match self.offsets.save(&tailer.export_file_state()) {
            Ok(r) if r.bytes > 0 => {
                self.stamp_version();
                if let Ok(mut st) = state.lock() {
                    st.persist.offsets_writes += 1;
                    st.persist.offsets_bytes += r.bytes;
                }
            }
            Ok(_) => {}
            Err(e) => eprintln!("alcore: could not save log offsets: {e}"),
        }
    }

    fn save_cards(&mut self, state: &std::sync::Mutex<crate::CoreState>) {
        let records: IndexMap<String, Value> = {
            let st = state.lock().expect("core state");
            st.log_sessions.iter().map(|(id, c)| (id.clone(), strip_card_for_persist(c))).collect()
        };
        match self.cards.save(&records) {
            Ok(r) if r.bytes > 0 => {
                self.stamp_version();
                if let Ok(mut st) = state.lock() {
                    st.persist.cards_writes += 1;
                    st.persist.cards_bytes += r.bytes;
                }
            }
            Ok(_) => {}
            Err(e) => eprintln!("alcore: could not save log cards: {e}"),
        }
        self.last_cards_save = Instant::now();
    }

    /// The durable-save timer (server.ts): every offsets_save — offsets when dirty, cards when
    /// dirty AND their own (slower) cadence elapsed. `force` (shutdown) flushes both now — a
    /// graceful stop loses nothing; an unchanged save costs zero bytes either way.
    pub fn tick(&mut self, tailer: &LogTailer, state: &std::sync::Mutex<crate::CoreState>, force: bool) {
        if force {
            self.save_offsets(tailer, state);
            self.save_cards(state);
            self.offsets_dirty = false;
            self.cards_dirty = false;
            return;
        }
        let now = Instant::now();
        if now.duration_since(self.last_timer) < self.offsets_save {
            return;
        }
        self.last_timer = now;
        if self.offsets_dirty {
            self.offsets_dirty = false;
            self.save_offsets(tailer, state);
        }
        if self.cards_dirty && now.duration_since(self.last_cards_save) >= self.cards_save {
            self.cards_dirty = false;
            self.save_cards(state);
        }
    }
}

/// What the sweeper thread reports once the boot sequence has run.
#[derive(Clone, Copy, Debug, Default)]
pub struct BootReport {
    pub restored_cards: usize,
    pub offsets_imported: usize,
    pub offsets_skipped: usize,
    pub sweep: SweepStats,
    /// setupLogWatcher: how many log roots got a recursive watcher, and how many did not (they
    /// refresh only on the backstop sweep). 0 attached ⇒ the backstop runs at the fast cadence.
    pub watch_attached: usize,
    pub watch_failed: usize,
}

/// server.ts FULL_RESCAN_MS — the correctness backstop behind the watcher: a recursive watcher
/// coalesces (and, on macOS FSEvents, can drop) events, and a root that did not exist at boot
/// never got a watcher, so a periodic full sweep is the only guarantee no file is missed.
pub const FULL_RESCAN: std::time::Duration = std::time::Duration::from_secs(60);
/// server.ts scheduleWatchScan — events arrive in bursts (one JSONL append emits several); the
/// debounce collapses a burst into ONE targeted sweep over the union of the paths it named.
pub const WATCH_DEBOUNCE: std::time::Duration = std::time::Duration::from_millis(300);

enum Msg {
    Stop,
    /// Paths a watch event named (absolute).
    Changed(Vec<PathBuf>),
    /// An event with NO path (the platform coalesced it away): the next sweep is promoted to a
    /// full one — guessing would silently drop a session's new lines.
    Unnamed,
}

/// A handle to stop the sweeper: `stop()` wakes the thread, which flushes the durable state and
/// exits; the join makes the flush complete before the process does.
pub struct SweeperHandle {
    stop: std::sync::mpsc::Sender<Msg>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl SweeperHandle {
    pub fn stop(mut self) {
        let _ = self.stop.send(Msg::Stop);
        if let Some(j) = self.join.take() {
            let _ = j.join();
        }
    }
}

/// setupLogWatcher: one recursive watcher per log root, events forwarded to the sweeper thread.
/// A root that cannot be watched (typically: does not exist yet) is reported, not fatal — the
/// backstop sweep still covers it. The watcher is returned so it lives as long as the thread.
fn attach_watchers(env: &Env, tx: std::sync::mpsc::Sender<Msg>) -> (Option<notify::RecommendedWatcher>, usize, Vec<PathBuf>) {
    use notify::Watcher;
    let dirs = agentlens_logscan::discovery::watch_dirs(env);
    // FSEvents (and a symlinked root anywhere) reports the CANONICAL path (`/private/var/…` for
    // a `/var/…` root), while discovery — and so every file_state key — spells the root as
    // configured. Rebase each event path onto the configured spelling, or the classifier would
    // disown it and a matching file would be tracked twice under two keys. (fs.watch hands the TS
    // a root-relative name, which it resolves against the configured root — same outcome.)
    let rebase: Vec<(PathBuf, PathBuf)> = dirs
        .iter()
        .filter_map(|d| std::fs::canonicalize(d).ok().filter(|c| c != d).map(|c| (c, d.clone())))
        .collect();
    let mut watcher = match notify::recommended_watcher(move |res: Result<notify::Event, notify::Error>| {
        let msg = match res {
            Ok(ev) if ev.paths.is_empty() => Msg::Unnamed,
            Ok(ev) => Msg::Changed(
                ev.paths
                    .into_iter()
                    .map(|p| match rebase.iter().find(|(c, _)| p.starts_with(c)) {
                        Some((c, root)) => root.join(p.strip_prefix(c).unwrap_or(&p)),
                        None => p,
                    })
                    .collect(),
            ),
            // A watcher error (queue overflow, a root vanishing) is the same ignorance as an
            // unnamed event: only a full sweep is safe.
            Err(_) => Msg::Unnamed,
        };
        let _ = tx.send(msg);
    }) {
        Ok(w) => w,
        Err(_) => return (None, 0, dirs),
    };
    let (mut attached, mut failed) = (0usize, Vec::new());
    for dir in dirs {
        match watcher.watch(&dir, notify::RecursiveMode::Recursive) {
            Ok(()) => attached += 1,
            Err(_) => failed.push(dir),
        }
    }
    (Some(watcher), attached, failed)
}

/// The log reader's thread: restore the durable state, run the boot sweep (reported once
/// ingested, so the caller binds its listeners with the card map already populated — the TS
/// server's synchronous boot batch), then steady state: a recursive watcher names the changed
/// paths and a debounced TARGETED sweep stats only those (TRDD-X2E6OSWK), while a FULL sweep
/// every `FULL_RESCAN` is the correctness backstop — or every `poll_interval` when not one
/// watcher attached (server.ts's 5s full-poll fallback). Offsets/cards save on their cadences.
/// The tailer is `!Send`, so it is created ON this thread and never leaves it.
pub fn start_sweeper(
    state: std::sync::Arc<std::sync::Mutex<crate::CoreState>>,
    env: Env,
    data_dir: PathBuf,
    poll_interval: std::time::Duration,
) -> Result<(BootReport, SweeperHandle), String> {
    let (boot_tx, boot_rx) = std::sync::mpsc::channel::<Result<BootReport, String>>();
    let (tx, rx) = std::sync::mpsc::channel::<Msg>();
    let stop_tx = tx.clone();
    let join = std::thread::Builder::new()
        .name("log-sweeper".into())
        .spawn(move || {
            let mut tailer = LogTailer::default();
            let mut durable = DurableState::open(&data_dir);
            let restored = {
                let mut st = state.lock().expect("core state");
                durable.restore(&mut tailer, &mut st)
            };
            let (restored_cards, offsets_imported, offsets_skipped) = match restored {
                Ok(r) => r,
                Err(e) => {
                    let _ = boot_tx.send(Err(e));
                    return;
                }
            };
            // Attach BEFORE the boot sweep: a write landing during the sweep is then named by an
            // event instead of waiting for the backstop (its stat gate makes a double-visit free).
            let (_watcher, watch_attached, watch_failed) = attach_watchers(&env, tx);
            let (scanned, sweep) = tailer.sweep(&env, crate::now_ms());
            if !scanned.is_empty() {
                durable.mark_dirty();
            }
            state.lock().expect("core state").ingest_scanned(scanned);
            let _ = boot_tx.send(Ok(BootReport {
                restored_cards,
                offsets_imported,
                offsets_skipped,
                sweep,
                watch_attached,
                watch_failed: watch_failed.len(),
            }));

            let backstop = if watch_attached > 0 { FULL_RESCAN } else { poll_interval };
            let mut next_full = Instant::now() + backstop;
            let mut pending: Vec<PathBuf> = Vec::new();
            let mut needs_full = false;
            loop {
                // recv_timeout doubles as the sleep: an event or a stop wakes the loop at once.
                let wait = next_full.saturating_duration_since(Instant::now());
                let first = rx.recv_timeout(wait);
                match first {
                    Ok(Msg::Stop) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        durable.tick(&tailer, &state, true);
                        return;
                    }
                    Ok(Msg::Changed(p)) => pending.extend(p),
                    Ok(Msg::Unnamed) => needs_full = true,
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => needs_full = true,
                }
                // Debounce: keep draining until the burst has been quiet for WATCH_DEBOUNCE.
                if !needs_full {
                    loop {
                        match rx.recv_timeout(WATCH_DEBOUNCE) {
                            Ok(Msg::Stop) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                                durable.tick(&tailer, &state, true);
                                return;
                            }
                            Ok(Msg::Changed(p)) => pending.extend(p),
                            Ok(Msg::Unnamed) => {
                                needs_full = true;
                                break;
                            }
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                        }
                    }
                }
                let (scanned, _) = if needs_full {
                    // A full sweep subsumes every pending hint and re-arms the backstop.
                    pending.clear();
                    needs_full = false;
                    next_full = Instant::now() + backstop;
                    tailer.sweep(&env, crate::now_ms())
                } else {
                    let paths = std::mem::take(&mut pending);
                    tailer.sweep_paths(&env, &paths, crate::now_ms())
                };
                if !scanned.is_empty() {
                    durable.mark_dirty();
                    state.lock().expect("core state").ingest_scanned(scanned);
                }
                durable.tick(&tailer, &state, false);
            }
        })
        .map_err(|e| format!("log-sweeper thread: {e}"))?;
    let report = boot_rx.recv().map_err(|_| "log-sweeper died during the boot sweep".to_owned())??;
    Ok((report, SweeperHandle { stop: stop_tx, join: Some(join) }))
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

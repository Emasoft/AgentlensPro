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
//!
//! DEFERRED (recorded in the TRDD STATE, not bugs): accountId (needs the call-body registry the
//!   core does not have yet), generated-files attach (src/generatedFiles.ts fs heuristics), the
//!   statusline overlay (a separate subsystem), and the OpenCode per-message JSON fallback
//!   (TS takes it on a db error; here the error is logged and the db skipped).

use std::collections::HashMap;
use std::io::{Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Instant;

use agentlens_logscan::discovery::{discover_all, DiscoveredFile, Env, LogSource};
use agentlens_logscan::{ClaudeAccum, ParsedTranscript};
use agentlens_logscan::codex::CodexAccum;
use indexmap::IndexMap;
use rayon::prelude::*;
use serde_json::{Map, Value};

use crate::pricing::calc_token_cost_usd;
use crate::LockTimed;
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
            .fold(0.0, |sum, t| sum + calc_token_cost_usd(t.input, t.cache_read, t.cache_create, t.output, &t.model, t.cache_create_1h, None, now_ms as f64))
    });
    let mut cards: Vec<Value> = Vec::with_capacity(1 + parsed.child_cards.len());
    let mut parent = card_value(&parsed.card);
    if let Some(obj) = parent.as_object_mut() {
        if let Some(cost) = blended {
            obj.insert("speedBlendedCostUsd".to_owned(), helpers::num(cost));
        }
        // finishRustTranscript: the harvested scratch paths + the session's scratch tree onto the
        // PARENT card (children untouched). Runs after the hot-age strip here where the TS runs it
        // before — equivalent: the per-entry refs die with the stripped timeline either way, the
        // card-level group survives.
        let harvested: Vec<(String, Option<String>)> = parsed.gen_files.iter().map(|g| (g.path.clone(), g.span_id.clone())).collect();
        crate::generated_files::attach_generated_files(obj, &harvested, None, crate::generated_files::SCRATCH_INDEX_MAX_FILES);
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

/// TRDD-2JOIAH2G R5 (bound-boot-scan-memory) — the boot scan's chunk size, matching the proven
/// RESTORE_CHUNK of the card-store restore (TRDD-5JZQFVO8, same crash-loop family, same N):
/// at the measured ~50 KB/file a chunk in flight is ~100 MB, far under the 2048 MB cap's
/// headroom over the ~1.1-1.3 GB steady state.
pub const SCAN_CHUNK: usize = 2_000;

/// The cold boot scan: every discovered session file, parsed in parallel (a file that cannot
/// be read or yields no timestamps is skipped, as the TS sweep does), finished, in discovery
/// order. OpenCode dbs are parsed sequentially (rusqlite, native WAL read). Collects EVERY
/// parsed file in one Vec — test/tooling ONLY, UNBOUNDED memory (the whole corpus resident
/// at once; TRDD-2JOIAH2G R5). Production boots go through [`cold_scan_chunked`].
pub fn cold_scan(env: &Env, now_ms: i64) -> (Vec<ScannedFile>, ScanStats) {
    let mut all: Vec<ScannedFile> = Vec::new();
    let (remainder, stats, _) = cold_scan_chunked(env, now_ms, &mut |chunk: Vec<ScannedFile>| all.extend(chunk));
    all.extend(remainder);
    (all, stats)
}

/// TRDD-2JOIAH2G R5 (bound-boot-scan-memory): the cold scan in chunks of [`SCAN_CHUNK`] files.
/// Boot churn alone crossed the 2048 MB phys_footprint cap (R0a: boot-phase peak 2539 MB with
/// ZERO bodies passes; 93 of 238 kills boot-phase) because the scan collected every parsed
/// file's cards in one Vec before the caller ingested — ~26k transcripts is the whole corpus
/// resident at once. Each full chunk is handed to `flush` (the boot site ingests + drops it
/// under a short state lock) and only the final partial chunk is returned, so the scan's own
/// peak is one chunk, not the corpus. `states` carries the (path, offset) of EVERY parsed file
/// — flushed or not — because the caller seeds its change gate from them; dropping a flushed
/// file's state would make the next sweep re-parse the whole corpus.
/// Returns (unflushed remainder, stats, all parsed files' states).
pub fn cold_scan_chunked(env: &Env, now_ms: i64, flush: &mut dyn FnMut(Vec<ScannedFile>)) -> (Vec<ScannedFile>, ScanStats, Vec<(PathBuf, FileState)>) {
    let t0 = Instant::now();
    // WHY THIS IS INSTRUMENTED (TRDD-HFV4AIT7). The scan uses ~3.2 of 14 cores, and SIX candidate
    // causes have now been ruled out by removing them and re-measuring: the LISTING mutex, the
    // allocator, the rayon thread count, and the per-session stat fan-out. Every one of those was
    // a guess about the INSIDE of the parallel region — but `discover_all` runs SEQUENTIALLY here,
    // before `par_iter` starts, and no measurement has ever separated the two. Amdahl caps the
    // whole scan at `1 / serial_fraction` cores no matter how perfect the parallel half is, so the
    // serial fraction has to be known before any further work goes into the parallel half.
    //
    // `AGENTLENS_SCAN_PROFILE=1` also samples how many workers are actually inside the body at
    // once, which is the number the core count is a proxy for. Off by default: an env read once
    // per scan, and a sampler thread only when asked.
    let profile = std::env::var("AGENTLENS_SCAN_PROFILE").is_ok_and(|v| v != "0" && !v.is_empty());
    let t_discover = Instant::now();
    let files = discover_all(env);
    let discover_ms = t_discover.elapsed().as_millis();

    // Live count of workers inside the parallel body. Relaxed is right: this is a statistical
    // sample, not a synchronisation point, and making it stronger would perturb what it measures.
    let inflight = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let sampling = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let sampler = if profile {
        let inflight = inflight.clone();
        let sampling = sampling.clone();
        Some(std::thread::spawn(move || {
            // Histogram of concurrency, indexed by worker count. 128 is above any plausible
            // rayon pool here; a wider pool saturates the last bucket rather than panicking.
            let mut hist = vec![0u64; 128];
            while sampling.load(std::sync::atomic::Ordering::Relaxed) {
                let n = inflight.load(std::sync::atomic::Ordering::Relaxed).min(127);
                hist[n] += 1;
                std::thread::sleep(std::time::Duration::from_millis(2));
            }
            hist
        }))
    } else {
        None
    };

    let t_par = Instant::now();
    // Chunked (TRDD-2JOIAH2G R5): `collect` over the whole corpus held every parsed file at
    // once. The file list is walked in SCAN_CHUNK-sized slices, each slice parsed in parallel
    // and its results flushed + dropped before the next slice fills — the in-flight peak is one
    // chunk of parsed files, not the corpus. (rayon's `chunks` needs an indexed iterator, which
    // `filter_map` erases; slicing the input first gives the same bound on the output side.)
    let mut remainder: Vec<ScannedFile> = Vec::new();
    let mut states: Vec<(PathBuf, FileState)> = Vec::with_capacity(files.len());
    // Whole-scan counters: flushed chunks are counted BEFORE the handoff (the flush drops them),
    // the remainder at the end — `parsed`/`cards` stay whole-scan figures as before R5.
    let mut parsed_total = 0usize;
    let mut cards_total = 0usize;
    for slice in files.chunks(SCAN_CHUNK) {
        let parsed: Vec<ScannedFile> = slice
            .par_iter()
            .filter_map(|f| {
                // Counted around the WHOLE body, so "inside" means the same thing as the work the
                // core count is measuring — including the time a worker sits blocked in a syscall.
                let _guard = profile.then(|| InflightGuard::new(&inflight));
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
        parsed_total += parsed.len();
        cards_total += parsed.iter().map(|s| s.cards.len()).sum::<usize>();
        states.extend(parsed.iter().map(|s| (PathBuf::from(&s.file), s.state)));
        flush(parsed);
    }
    let par_ms = t_par.elapsed().as_millis();
    sampling.store(false, std::sync::atomic::Ordering::Relaxed);
    let t_seq = Instant::now();
    for f in files.iter().filter(|f| f.source == LogSource::OpenCodeDb) {
        if let Some((_, scanned)) = parse_opencode(&f.path, now_ms) {
            states.extend(scanned.iter().map(|s| (PathBuf::from(&s.file), s.state)));
            remainder.extend(scanned);
        }
    }
    let opencode_ms = t_seq.elapsed().as_millis();
    if let Some(h) = sampler {
        let hist = h.join().unwrap_or_default();
        let total: u64 = hist.iter().sum();
        // Mean concurrency INCLUDING idle samples — this is the number the "3 of 14 cores" figure
        // is a proxy for, and it is what tells a starved pool apart from a serial phase.
        let weighted: u64 = hist.iter().enumerate().map(|(n, c)| n as u64 * c).sum();
        let mean = if total > 0 { weighted as f64 / total as f64 } else { 0.0 };
        let zero_pct = if total > 0 { 100.0 * hist[0] as f64 / total as f64 } else { 0.0 };
        let top: Vec<String> = {
            let mut idx: Vec<usize> = (0..hist.len()).filter(|&i| hist[i] > 0).collect();
            idx.sort_by_key(|&i| std::cmp::Reverse(hist[i]));
            idx.iter().take(6).map(|&i| format!("{}:{:.1}%", i, 100.0 * hist[i] as f64 / total as f64)).collect()
        };
        println!(
            "{} scan-profile: total={}ms discover={}ms (serial {:.1}%) par={}ms opencode={}ms | mean_inflight={:.2} zero={:.1}% top={}",
            crate::log_ts(),
            t0.elapsed().as_millis(),
            discover_ms,
            100.0 * discover_ms as f64 / t0.elapsed().as_millis().max(1) as f64,
            par_ms,
            opencode_ms,
            mean,
            zero_pct,
            top.join(" "),
        );
    }
    parsed_total += remainder.len();
    cards_total += remainder.iter().map(|s| s.cards.len()).sum::<usize>();
    let stats = ScanStats { files: files.len(), parsed: parsed_total, cards: cards_total, elapsed_ms: t0.elapsed().as_millis() };
    (remainder, stats, states)
}

/// Increments a live-worker counter for the lifetime of the value. A guard rather than a manual
/// pair, because the body it wraps has `?`/`None` early exits — a hand-written decrement would be
/// skipped on exactly the paths (unreadable file, unparseable transcript) most likely to be slow,
/// and the counter would drift upward and overstate concurrency forever.
struct InflightGuard<'a>(&'a std::sync::atomic::AtomicUsize);
impl<'a> InflightGuard<'a> {
    fn new(c: &'a Arc<std::sync::atomic::AtomicUsize>) -> Self {
        c.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        Self(c)
    }
}
impl Drop for InflightGuard<'_> {
    fn drop(&mut self) {
        self.0.fetch_sub(1, std::sync::atomic::Ordering::Relaxed);
    }
}

/// _sessionIdForFile (logReader.ts:418) — the per-agent filename/dirname stem convention. Like
/// `path.basename(p, ext)`, the extension strips only when present.
pub fn session_id_for_file(path: &Path, source: &LogSource) -> String {
    fn stem(p: &Path, ext: &str) -> String {
        let name = p.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
        name.strip_suffix(ext).map(str::to_owned).unwrap_or(name)
    }
    match source {
        // The CLI's directory name is the session UUID.
        LogSource::CopilotCli => path.parent().and_then(|d| d.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default(),
        LogSource::CopilotVscodeJson => stem(path, ".json"),
        _ => stem(path, ".jsonl"),
    }
}

/// The single discovered file backing `session_id`, or None. ONE definition of the walk, shared
/// by `reparse_session` (which needs the whole `DiscoveredFile`) and `transcript_path_for` (which
/// needs only its path) — the TS splits the same lookup the same way (logReader.ts:452 "Same
/// lookup reparseSession uses"). OpenCode is excluded because its db backs MANY sessions, so no
/// single file "is" the session.
fn discovered_for_session(env: &Env, session_id: &str) -> Option<DiscoveredFile> {
    discover_all(env)
        .into_iter()
        .filter(|f| f.source != LogSource::OpenCodeDb)
        .find(|f| session_id_for_file(&f.path, &f.source) == session_id)
}

/// transcriptPathFor (logReader.ts:452, TRDD-CXPLAT01) — the file backing `session_id` WITHOUT
/// parsing it, so a caller that only needs a bounded tail read never pays the full parse of a
/// 60MB+ transcript. None when no single file backs the id (an OTEL-only session, OpenCode, or a
/// deleted log) — and None must stay distinguishable from "found it, but it records no request":
/// the first is `verdict: unknown`, the second is a real measurement.
pub fn transcript_path_for(env: &Env, session_id: &str) -> Option<PathBuf> {
    discovered_for_session(env, session_id).map(|f| f.path)
}

/// reparseSession (logReader.ts:434, TRDD-PJC8N1HO) — a fresh FULL parse of the single file
/// backing `session_id`, the lazy timeline rebuild for a card RESTORED stripped from the
/// persisted-card log. None when nothing backs the id (an OTEL-only session, OpenCode — a
/// multi-session db, not one card per file — or a deleted log). Bounded: one file, on demand.
/// The parse-time hot-age strip applies here exactly as in TS: a session idle past
/// AGENTLENS_TIMELINE_HOT_AGE_HOURS reparses to a stripped card in BOTH engines.
///
/// The TS also drops the reader's cached offset/accumulator for the file; the Rust tailer lives
/// on the sweeper thread (Rc accumulators, !Send) and is deliberately NOT touched — benign: its
/// state describes the same fully-consumed file, and the file's next growth re-parses through
/// the accumulator or from 0, either of which rebuilds the same card.
pub fn reparse_session(env: &Env, session_id: &str, now_ms: i64) -> Option<ScannedFile> {
    let f = discovered_for_session(env, session_id)?;
    let st = stat(&f.path)?;
    let p = parse_one(&f)?;
    let state = state_after(&p, st);
    Some(finish_transcript(p, now_ms, state))
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
                eprintln!("{} alcore: opencode schema unsupported ({path}): session table lacks model/tokens columns; skipping", crate::log_ts());
            }
            Some((state, r.results.into_iter().map(|p| finish_transcript(p, now_ms, state)).collect()))
        }
        Err(e) => {
            eprintln!("{} alcore: opencode db error {path}: {e} (sessions from this db not ingested)", crate::log_ts());
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

// Variants differ a lot in size, but at most ACCUM_CACHE_MAX (24) of these ever exist at
// once, so boxing the big one would trade ~1 KB of stack for 24 heap allocations and an
// indirection on the hot per-line parse path. Revisit only if the cache bound grows.
#[allow(clippy::large_enum_variant)]
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
    /// LogReader.clearFileState — every offset and accumulator forgotten; the next sweep is
    /// the parallel cold path from byte 0.
    pub fn clear(&mut self) {
        self.file_state.clear();
        self.accums.clear();
    }

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
    ///
    /// TRDD-2JOIAH2G R5 (bound-boot-scan-memory): when `ingest` is given, changed files are
    /// flushed to it in SCAN_CHUNK-sized batches (each dropped before the next parses), and only
    /// the final partial batch is returned — the restart boot after a mid-boot kill re-parses
    /// thousands of lagged files and previously held every parsed card in one Vec until the
    /// caller's single bulk ingest (boot-phase peak 2539 MB, zero bodies passes). With `ingest`
    /// = None the behavior is exactly the unbounded-collect form (tests, tooling).
    pub fn sweep(&mut self, env: &Env, now_ms: i64, mut ingest: Option<&mut dyn FnMut(Vec<ScannedFile>)>) -> (Vec<ScannedFile>, SweepStats) {
        if self.file_state.is_empty() {
            // Seed the change gate from the chunked cold scan's returned states — flushed
            // chunks' offsets included, or the next sweep would re-parse the whole corpus.
            // With `ingest` = None the flush ACCUMULATES the chunks into the returned Vec
            // (the exact pre-R5 semantics) — test/tooling ONLY, UNBOUNDED memory (TRDD-2JOIAH2G
            // R5); production must pass Some. With Some, each chunk
            // is handed to the caller's ingest and dropped, bounding the boot's peak.
            let mut unflushed: Vec<ScannedFile> = Vec::new();
            let (remainder, s, states) = cold_scan_chunked(env, now_ms, &mut |chunk| {
                match ingest.as_mut() {
                    Some(st) => st(chunk),
                    None => unflushed.extend(chunk),
                }
            });
            unflushed.extend(remainder);
            for (path, state) in states {
                self.file_state.insert(path, state);
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
            return (unflushed, stats);
        }
        let t0 = Instant::now();
        let files = discover_all(env);
        let mut out: Vec<ScannedFile> = Vec::new();
        let mut stats = SweepStats { files: files.len(), ..SweepStats::default() };
        let mut cards_seen: usize = 0; // F-3 closeout (TRDD-2JOIAH2G): whole-sweep cards — flushed chunks counted here, the returned tail below.
        for f in &files {
            self.process_file(f, now_ms, &mut stats, &mut out);
            // Bound the accumulation (TRDD-2JOIAH2G R5): hand every SCAN_CHUNK files to the
            // caller's ingest and drop them; only the last partial batch is returned. The
            // dropped files' gate states are already in `file_state` (process_file inserts
            // them), so a flush can never cause a re-parse.
            if let Some(st) = ingest.as_mut() {
                if out.len() >= SCAN_CHUNK {
                    cards_seen += out.iter().map(|s| s.cards.len()).sum::<usize>();
                    st(std::mem::take(&mut out));
                }
            }
        }
        // F-3 closeout (TRDD-2JOIAH2G): the whole sweep's cards — flushed chunks (cards_seen)
        // plus the returned partial tail. With `ingest: Some` the tail is a fraction of the
        // sweep, and alcore.rs's boot summary logs `cards=` from this field.
        stats.cards = cards_seen + out.iter().map(|s| s.cards.len()).sum::<usize>();
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
                    eprintln!("{} alcore: skipping oversized non-incremental log {} ({}MB)", crate::log_ts(), f.path.display(), st.2 / 1_048_576);
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
        // WHY the Err arm is safe with a half-fed accumulator: lines may already have reached
        // `accum` before an I/O error, but `accum` was taken out of the cache (shift_remove) and is
        // dropped on this path with no file_state.insert and no lru_put, so the next sweep re-reads
        // from 0. Keep it that way (TRDD-735Q3JF4).
        let consumed = match read_lines_from(&f.path, from, |line| {
            let Ok(v) = serde_json::from_slice::<Value>(line) else { return };
            if let Value::Object(entry) = v {
                match &mut accum {
                    Accum::Claude(a) => agentlens_logscan::on_entry(a, &entry),
                    Accum::Codex(a) => agentlens_logscan::codex::on_entry(a, &entry),
                }
            }
        }) {
            Ok(x) => x,
            Err(e) => {
                eprintln!("{} alcore: read error {}: {e}", crate::log_ts(), f.path.display());
                return None;
            }
        };
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
/// WHY streaming: the whole-file read held ~850 MiB of free-in-page commit after a 1990-file warm
/// boot sweep (TRDD-735Q3JF4, docs_dev/20261029_031000+0100-735Q3JF4-diff1-streaming.md); TS
/// `_streamLinesFrom` (src/logReader.ts) already streams.
fn read_lines_from(path: &Path, from: u64, mut on_line: impl FnMut(&[u8])) -> std::io::Result<u64> {
    use std::io::BufRead;
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(from))?;
    let mut rd = std::io::BufReader::with_capacity(64 * 1024, file);
    let mut line: Vec<u8> = Vec::new();
    let mut consumed = from;
    loop {
        line.clear();
        let n = rd.read_until(b'\n', &mut line)?;
        if n == 0 || line.last() != Some(&b'\n') {
            break;
        }
        consumed += n as u64;
        line.pop();
        if line.iter().all(u8::is_ascii_whitespace) {
            continue;
        }
        on_line(&line);
    }
    Ok(consumed)
}

// ── Durable state (P5e — server.ts TRDD-PJC8N1HO + the delta logs of TRDD-K3WDPR7M) ────────────

/// src/collectorState.ts LOG_INGEST_VERSION — the semantics stamp of the persisted cards/offsets.
/// A restart trusts the delta logs ONLY when `log-delta-version.json` carries this value; a bump
/// forces the cold rescan. Kept in lockstep with the TS constant by a test that reads the TS
/// source (tests/log_reader_parity.rs) until the cutover retires the TS side.
///
/// A 7→8 bump was proposed then RETRACTED for TRDD-ORGJ0E3G (a card missing
/// `cache_create_1h_tokens` reads it as 0, permanently under-billing at the 5m rate): `restore()`
/// treats a stale version as "restore nothing", and the cold rescan that follows only rebuilds
/// cards from transcripts STILL ON DISK — so any session whose transcript Claude Code had already
/// deleted (`cleanupPeriodDays`) or whose Codex/Copilot/OpenCode source had rotated would vanish
/// from the dashboard permanently, an unbounded history loss to fix a bounded field. A second
/// design (dropping the flagged file's saved offset so the next sweep re-parses and rebuilds the
/// WHOLE card) was also retracted, post-deploy-measurement (TRDD-TWDGR75R): the re-parse un-strips
/// fields the persisted form had dropped, which roughly doubled `cards.duckdb`'s on-disk size on
/// boot and blew its 256 MiB buffer-pool ceiling on the first `cards_json()` call. `restore()` now
/// keeps every card unconditionally and never rebuilds one; a card missing the field just has its
/// `(session_id, transcript path)` queued for a USAGE-ONLY backfill pass
/// (`DurableState::run_1h_backfill`) that patches only that one field in place. Version stays 7 —
/// nothing about the delta-log SHAPE changed, so there is nothing to cold-rescan for.
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


/// persistence record builder: the delta log's records for a set of resident cards, keyed by
/// sessionId ("" when absent, the contract put_log_session keeps). DA0GN1CS: built from the resident
/// layer in first-insert order, so no DuckDB scan is needed.
pub fn persist_records_from(cards: &[Arc<Value>]) -> IndexMap<String, Value> {
    cards.iter().map(persist_record).collect()
}

/// One card's delta-log record: (sessionId or "", the persist-stripped card). TRDD-2JOIAH2G: the
/// ONE definition restore_reused's seed and save_cards' stream both use, so the seeded hashes and
/// the saved records cannot drift; both stream it one card at a time instead of collecting a map
/// (a full stripped copy of the corpus at restore and at every save).
fn persist_record(card: &Arc<Value>) -> (String, Value) {
    (card.get("sessionId").and_then(Value::as_str).unwrap_or("").to_owned(), strip_card_for_persist(card))
}


/// A Claude card that wrote cache but is missing the 1h-tier field (TRDD-ORGJ0E3G): a candidate
/// for the usage-only backfill. A pure predicate on the card, shared by both restore branches.
fn needs_1h_field(obj: &Map<String, Value>) -> bool {
    obj.get("source").and_then(Value::as_str) == Some("claude_code")
        && !obj.contains_key("cacheCreate1hTokens")
        && obj.get("cacheCreateTokens").and_then(Value::as_f64).unwrap_or(0.0) > 0.0
}

/// Built once, not per card: a walk of every discovered Claude transcript, keyed by the session id
/// it backs. `discover_all` is a full filesystem walk, so it runs only when a candidate exists
/// (`any_candidates`) — an in-memory pre-scan of the cards decides, with no disk I/O.
fn claude_transcript_paths(env: &Env, any_candidates: bool) -> HashMap<String, PathBuf> {
    if !any_candidates {
        return HashMap::new();
    }
    discover_all(env)
        .into_iter()
        .filter(|f| f.source == LogSource::Claude)
        .map(|f| (session_id_for_file(&f.path, &f.source), f.path))
        .collect()
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
    /// `(session_id, transcript path)` flagged this boot for the usage-only 1h-tier backfill
    /// (TRDD-ORGJ0E3G, replacing the full-card re-parse that caused TRDD-TWDGR75R): populated by
    /// `restore`, drained by `run_1h_backfill` once the boot report has been sent — a card is
    /// never rebuilt, only this one field is patched onto it.
    pending_1h_backfill: Vec<(String, PathBuf)>,
}

/// TRDD-ORGJ0E3G review item 1: bounding the one-time migration's scale. ~8,500 top-level cards
/// on this machine qualify for the targeted backfill — flagging every one of them makes the first
/// boot's candidate list close to a full corpus walk. A file untouched this long is an idle
/// session already past every cost view's own horizon, so it keeps the 5m-rate cost it shows
/// today (the field just stays absent, same as before this fix) instead of paying I/O to correct
/// a number nothing displays anymore.
const REPARSE_MAX_AGE: std::time::Duration = std::time::Duration::from_secs(30 * 24 * 60 * 60);

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
            pending_1h_backfill: Vec::new(),
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

    /// The restore (server.ts startup) from the card snapshot, for a store that was not reused:
    /// when the delta logs are CURRENT, restored cards go into the map (timelines capped, then the
    /// global tier). Returns (restored cards, 0, 0): the saved read positions are never imported
    /// on this path — they are tombstoned and the boot sweep re-reads every file (TRDD-6B7VV2Z7,
    /// B'; WHY at the tombstone below). Version-stale logs restore nothing: both logs are
    /// tombstoned and then the version stamped, at once (TRDD-A2KNXCNH, TRDD-6B7VV2Z7).
    ///
    /// TRDD-ORGJ0E3G (usage-only backfill, replacing both the 7→8 whole-corpus version bump AND
    /// the full-card re-parse this superseded — see `LOG_INGEST_VERSION`'s doc comment and
    /// TRDD-TWDGR75R for why each was retracted): a card whose file has since been deleted or
    /// rotated (Claude Code's own `cleanupPeriodDays`, or a Codex/Copilot/OpenCode source that
    /// rotated) is the ONLY copy of that session's history, so the restore keeps every card it
    /// finds. The restore itself never rebuilds ANY card; it only queues `(session_id, path)` for
    /// a card that is missing a field added by a later parser (`cacheCreate1hTokens`, currently)
    /// AND whose source file still exists, for `run_1h_backfill` to patch after boot with a
    /// usage-only pass over that one file.
    fn restore_from_snapshot(&mut self, state: &mut crate::CoreState, env: &Env) -> Result<(usize, usize, usize), String> {
        let cards = self.cards.load()?;
        let offsets = self.offsets.load()?;
        if !self.version_is_current() {
            if !cards.is_empty() || !offsets.is_empty() {
                eprintln!("{} alcore: log-ingest semantics changed (v{LOG_INGEST_VERSION}) — cold-rescanning; stale read positions and card entries tombstoned now", crate::log_ts());
            }
            // TRDD-A2KNXCNH: tombstone the stale read positions and stamp the version NOW, before
            // the cold rescan. WHY: the rescan appends per-chunk positions with `append_changed`,
            // which fills `written`; the first tick may then write 0 offset bytes and skip
            // `stamp_version` (it stamps only when bytes > 0), and a death before the first card
            // save would leave current positions under a stale stamp — the next boot would discard
            // the whole scan.
            // TRDD-6B7VV2Z7 (B'): tombstone log-sessions here too. WHY: a death before the first
            // card save would otherwise leave the stale snapshot under a CURRENT stamp, and the next
            // refused reuse would restore it as if it described this ingest version. No new loss:
            // this branch puts no card into the store and `self.cards.load()` above seeded
            // `written` with every stale key, so the first full `save_cards` after the rescan would
            // tombstone every key the rescan did not rebuild anyway (gone-file cards included) —
            // this only does it earlier.
            // ORDER: both tombstones BEFORE `stamp_version`. A death between them leaves the stale
            // stamp, so the next boot repeats this branch, which is idempotent; the reverse order
            // would leave a current stamp over stale cards. The `?` fails the start on a disk error
            // (fail-fast) rather than rescanning onto logs that still hold stale entries.
            self.offsets.save(&IndexMap::new())?;
            self.cards.save(&IndexMap::new())?;
            self.stamp_version();
            return Ok((0, 0, 0));
        }
        let restored = cards.len();
        let mut backfill_candidates = 0usize;
        let mut too_old = 0usize;
        if restored > 0 {
            let (max_entries, max_bytes) = (timeline_max_entries(), timeline_max_bytes());
            // Review finding (TRDD-ORGJ0E3G): `discover_all` is a full filesystem walk. Gating it
            // on `restored > 0` alone would run it on EVERY restart forever, not just the one-time
            // migration — on a ~12k-file corpus that is a permanent tax paid long after every
            // eligible card has already been backfilled. A cheap in-memory pre-scan of the already-
            // loaded `cards` map (no disk I/O) decides whether the walk is needed AT ALL this boot;
            // once every flagged card has been reparsed once, this is `false` forever after.
            let any_candidates = cards.values().any(|c| c.as_object().is_some_and(needs_1h_field));
            let claude_paths = claude_transcript_paths(env, any_candidates);
            // Bounded chunks, not one transaction over the whole corpus (TRDD-5JZQFVO8, 2026-09-08):
            // an open DuckDB transaction's rows are charged to card_store::MEMORY_LIMIT (256 MiB)
            // until COMMIT, and at 35,258 cards / 64 MB the pool filled part-way through, `put`
            // panicked, and the sweeper's death exited the process at every boot. Whether the PK
            // index also needs the checkpoint a COMMIT gives it is measured by the boot on the real
            // corpus, not asserted here. Atomicity across the whole restore protected nothing: the
            // store is empty here (`CardStore::open` found nothing reusable and `restore_complete`
            // stays 0 until the final commit below, so a kill mid-restore is rebuilt), and this thread holds the
            // state lock for the whole restore, so no reader can see a half-loaded store.
            // ponytail: rows-only chunking; the honest ceiling is bytes (2,000 × 100 KB cards would
            // be 200 MB) — add a byte accumulator if cards ever grow past ~10 KB on average.
            const RESTORE_CHUNK: usize = 500;
            state.cards.begin();
            let now = std::time::SystemTime::now();
            for (n, (_, mut card)) in cards.into_iter().enumerate() {
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
                    // Missing the 1h-tier field (TRDD-ORGJ0E3G) and it actually wrote cache — queue
                    // its (session_id, path) for the post-boot usage-only backfill, iff the file
                    // still exists. Never touches the card or its offset here.
                    self.queue_1h_candidate(obj, &claude_paths, now, &mut backfill_candidates, &mut too_old);
                }
                state.put_log_session(card);
                if (n + 1) % RESTORE_CHUNK == 0 {
                    state.cards.commit();
                    state.cards.begin();
                }
            }
            state.cards.commit();
            state.demote_cold_timelines(crate::summarize::retention::timeline_hot_cards());
        }
        // Every card is restored untouched — flagged or not — so a deleted/rotated source never
        // loses history. The flagged list is only a plan for `run_1h_backfill`; nothing here does I/O.
        if backfill_candidates > 0 || too_old > 0 {
            eprintln!("{} alcore: log-ingest 1h-tier backfill — flagged {backfill_candidates} transcript(s) for a usage-only cache_create_1h pass after boot ({too_old} skipped, older than {} days)", crate::log_ts(), REPARSE_MAX_AGE.as_secs() / 86_400);
        }
        // TRDD-6B7VV2Z7 (B'): the saved read positions are NOT imported on this path; they are
        // tombstoned NOW and the boot sweep re-reads every file. WHY: positions always run ahead
        // of the card snapshot after a crash — `ingest_chunk` appends them per chunk and `tick`
        // saves offsets more often than cards — so importing them would mark as unchanged every
        // file whose card the snapshot lacks or holds stale, and that card would stay missing or
        // stale until its file changed again. The rescan rebuilds every card whose file exists;
        // the snapshot puts above keep the gone-file cards. The tombstone is eager, not left to the
        // next offsets save, so a death before that save cannot hand the stale positions to a
        // later reused boot (`restore_reused` imports them). It relies on `self.offsets.load()`
        // above: `save` tombstones only keys that load seeded into `written`.
        self.offsets.save(&IndexMap::new())?;
        Ok((restored, 0, 0))
    }


    /// The restore (server.ts startup), TRDD-9VX3WTGU edition: when `cards.duckdb` was REUSED
    /// (`CardStore::open`'s gate passed) the corpus is already in the store and the 40k inserts are
    /// skipped; otherwise the full restore from the card snapshot + offsets pair runs, unchanged.
    /// Either way, once it returns `Ok`, the store is marked `restore_complete` — WHY it is set
    /// here and not by the store: only the restore knows the corpus is whole (a kill mid-restore
    /// returns early / never gets here, so the next boot sees 0 and rebuilds).
    pub fn restore(&mut self, tailer: &mut LogTailer, state: &mut crate::CoreState, env: &Env) -> Result<(usize, usize, usize), String> {
        // TRDD-N6A8VX3G: load the body-link rows and compact them into the verified snapshot
        // immediately — compact_now bypasses save()'s size gate, so the delta stays bounded to
        // per-boot volume and a torn trailing line left by a hard kill is healed before any
        // SQL consumer reads the file. Append-only facts: no deletion-diffing ever runs on them.
        // TRDD-1RJBOEI1: compact_from_disk, not load() + compact_now(&records): the same seeding of
        // `written` and the same verified snapshot, streamed, so this boot step never holds the
        // record map (load() alone peaked at 1564 MiB at 700k rows, and the old pair at 3337 MiB,
        // over alcore's 2048 MiB cap — docs_dev/20261017-1rjboei1-streaming-compact-report.md).
        if let Err(e) = state.body_links.compact_from_disk() {
            eprintln!("{} alcore: could not load or compact body-links: {e}", crate::log_ts());
        }
        let out = if state.cards.reused() { self.restore_reused(tailer, state, env)? } else { self.restore_from_snapshot(state, env)? };
        state.cards.mark_restore_complete();
        Ok(out)
    }

    /// TRDD-9VX3WTGU — the reuse branch of [`DurableState::restore`]. The parsed layer and
    /// `next_seq` were rebuilt by `CardStore::open`; this seeds the delta-log hashes, recomputes
    /// the 1h-backfill candidates, demotes once, bumps `data_version` once and imports the offsets
    /// — all before the caller binds its listeners (the state lock is held for the whole restore).
    fn restore_reused(&mut self, tailer: &mut LogTailer, state: &mut crate::CoreState, env: &Env) -> Result<(usize, usize, usize), String> {
        if !self.version_is_current() {
            // WHY not reuse: the offsets (and the card snapshot) are stamped with another ingest
            // semantics — or not stamped at all — so the offsets about to be imported would not
            // describe this corpus. Discard the rows and take the legacy path, which sees the same
            // stale stamp, restores nothing, and tombstones BOTH logs before re-stamping the version
            // (TRDD-A2KNXCNH, TRDD-6B7VV2Z7). That path loads both logs first, which is what seeds
            // the keys those tombstones name; skipping the load would leave the stale entries in
            // the snapshot to be trusted as current once the version is re-stamped.
            eprintln!("{} alcore: card store reuse refused — the offsets log is stamped with another ingest version; discarding the cards and cold-rescanning", crate::log_ts());
            state.cards.discard_cards();
            return self.restore_from_snapshot(state, env);
        }
        let offsets = self.offsets.load()?;
        let restored = state.cards.len();
        // Backfill candidates are recomputed from the parsed cards (the queue is in-memory only,
        // so a crash mid-backfill would otherwise never resume). `discover_all` only if any card
        // qualifies — the same gate as the full restore.
        let parsed = state.cards.parsed_cards();
        let any_candidates = parsed.iter().any(|c| c.as_object().is_some_and(needs_1h_field));
        let claude_paths = claude_transcript_paths(env, any_candidates);
        let now = std::time::SystemTime::now();
        let (mut backfill_candidates, mut too_old) = (0usize, 0usize);
        if any_candidates {
            for c in &parsed {
                if let Some(obj) = c.as_object() {
                    self.queue_1h_candidate(obj, &claude_paths, now, &mut backfill_candidates, &mut too_old);
                }
            }
        }
        drop(parsed);
        // Idempotent (rows already demoted are skipped); needed because the hot-set size may have
        // changed between boots. Once, not per card.
        state.demote_cold_timelines(crate::summarize::retention::timeline_hot_cards());
        // Seed the delta-log hashes with exactly what `save_cards` would compute. Both map
        // `persist_record` over the resident layer, so the seeded hashes and the saved records
        // cannot drift, and the 72 MB snapshot is never loaded. Without the seed the first save would
        // append the whole corpus (72 MB) and compact. WHY AFTER the demotion (keep this order): cards
        // demoted at this start are persisted stripped; hashing them before the demotion would make the
        // first save see them as changed and append them again.
        // TRDD-2JOIAH2G: streamed, one stripped card at a time, into the seed. It used to collect every
        // stripped card into a map first, a full copy of the corpus on top of the resident layer at
        // restore (measured ~540 MB committed, reports/rss-crash-loop/20261018_114500+0200-head-paired-run.md).
        let parsed = state.cards.parsed_cards();
        self.cards.seed_written(parsed.iter().map(persist_record));
        drop(parsed);
        // The full restore bumps `data_version` once per card; a reused store would stay at 0 and
        // version-keyed caches (summary, SSE pusher) would see no change after the build.
        state.data_version += 1;
        if backfill_candidates > 0 || too_old > 0 {
            eprintln!("{} alcore: log-ingest 1h-tier backfill — flagged {backfill_candidates} transcript(s) for a usage-only cache_create_1h pass after boot ({too_old} skipped, older than {} days)", crate::log_ts(), REPARSE_MAX_AGE.as_secs() / 86_400);
        }
        let (imported, skipped) = tailer.import_file_state(&offsets);
        Ok((restored, imported, skipped))
    }

    /// Queue `(session_id, path)` for the post-boot usage-only 1h backfill when the card is
    /// missing the field, actually wrote cache, its transcript still exists and is recent. Never
    /// touches the card or its offset. Shared by the full restore and the reuse branch.
    fn queue_1h_candidate(
        &mut self,
        obj: &Map<String, Value>,
        claude_paths: &HashMap<String, PathBuf>,
        now: std::time::SystemTime,
        backfill_candidates: &mut usize,
        too_old: &mut usize,
    ) {
        if !needs_1h_field(obj) {
            return;
        }
        let Some(session_id) = obj.get("sessionId").and_then(Value::as_str) else { return };
        let Some(path) = claude_paths.get(session_id) else { return };
        // Item 1: skip a file older than REPARSE_MAX_AGE — see the constant's comment. An
        // unreadable mtime is treated as "too old" (fail closed: never force I/O on a file we
        // can't even stat).
        let recent = std::fs::metadata(path)
            .and_then(|m| m.modified())
            .ok()
            .and_then(|mtime| now.duration_since(mtime).ok())
            .is_some_and(|age| age <= REPARSE_MAX_AGE);
        if recent {
            self.pending_1h_backfill.push((session_id.to_string(), path.clone()));
            *backfill_candidates += 1;
        } else {
            *too_old += 1;
        }
    }

    /// TRDD-ORGJ0E3G — one bounded slice of the usage-only backfill, replacing the full-card
    /// re-parse (513623fe/80958154) that caused TRDD-TWDGR75R (re-parsing un-strips fields, which
    /// roughly doubled `cards.duckdb`'s on-disk size on boot and blew its 256 MiB buffer-pool
    /// ceiling on the very first `cards_json()` call). `restore()` never rebuilds a card; it only
    /// queues `(session_id, path)` in `pending_1h_backfill`. This drains AT MOST one
    /// `BACKFILL_CHUNK` (200 files) from that queue per call: the chunk's transcripts are streamed
    /// with `agentlens_logscan::sum_cache_create_1h` (a lean line-by-line pass — no timeline, no
    /// tool records, no child cards, the SAME first-row-per-`message.id` dedup rule the full
    /// parser uses) WITHOUT holding the state lock, then the lock is taken only long enough to
    /// patch that one field onto each already-restored card. A card whose file vanished between
    /// `restore()` and this call, or whose transcript turns out unparseable, reads 0 tokens (same
    /// as its absence already implied) and is never retried.
    ///
    /// Review fix (this session): the original design drained the WHOLE queue inside one call
    /// made BEFORE `start_sweeper`'s watch/FULL_RESCAN loop started, so a corpus with thousands of
    /// flagged files (measured: ~6.5 minutes for 8,846) left every real transcript write from
    /// every other agent queued and unprocessed in the sweeper's own event channel for that whole
    /// span — the loop that drains `rx` never got to run until the backfill call returned. Callers
    /// now invoke this per loop iteration (see `start_sweeper`) so a real ingestion event is always
    /// handled within one iteration, never blocked behind the backfill. Returns `true` when more
    /// chunks remain (the caller should keep calling on subsequent iterations).
    pub fn run_1h_backfill_step(&mut self, state: &std::sync::Mutex<crate::CoreState>) -> bool {
        const BACKFILL_CHUNK: usize = 200;
        if self.pending_1h_backfill.is_empty() {
            return false;
        }
        let total_before = self.pending_1h_backfill.len();
        let take = BACKFILL_CHUNK.min(self.pending_1h_backfill.len());
        let chunk: Vec<(String, PathBuf)> = self.pending_1h_backfill.drain(..take).collect();
        let sums: Vec<(String, f64)> = chunk
            .iter()
            .map(|(session_id, path)| (session_id.clone(), agentlens_logscan::sum_cache_create_1h(&path.to_string_lossy())))
            .collect();
        // The "already filled" check is re-derived from the LIVE card, taken fresh under this
        // lock — not a value captured before the unlocked I/O above — so a concurrent sweep that
        // already re-parsed and wrote this same file's card (a normal watcher event can fire
        // mid-backfill) is always seen here and skipped: this chunk's now-stale `sum` never
        // clobbers a fresher value the sweep just wrote.
        let mut chunk_filled = 0usize;
        let mut patched_ids: Vec<String> = Vec::with_capacity(take);
        {
            {
                let mut st = state.lock_timed();
                for (session_id, sum) in sums {
                    let Some(mut card) = st.cards.get(&session_id) else { continue };
                    let already_filled = card.as_object().is_some_and(|o| o.contains_key("cacheCreate1hTokens"));
                    if already_filled {
                        continue; // patched by a later sweep meanwhile — never overwrite
                    }
                    if let Some(obj) = card.as_object_mut() {
                        let cache_create = obj.get("cacheCreateTokens").and_then(Value::as_f64).unwrap_or(0.0);
                        // Clamp down, never up: `cacheCreateTokens` is never expected to shrink between
                        // this card being queued (restore()) and being patched (here) — the card
                        // lifecycle is upsert-replace, not decrement — so a sum that would exceed it
                        // signals the two numbers came from different card states, and the safe,
                        // bounded choice is to cap the write rather than either error or trust an
                        // inconsistent pair blindly.
                        obj.insert("cacheCreate1hTokens".into(), Value::from(sum.clamp(0.0, cache_create)));
                    }
                    st.put_log_session(card);
                    patched_ids.push(session_id);
                    chunk_filled += 1;
                }
            }
            // `st` (if acquired) drops here, releasing the lock before the durable write below
            // (`save_cards_for` takes its own short lock) — never hold the state lock across file I/O.
        }
        // TRDD-ORGJ0E3G review fix: a chunk's patches were previously only marked dirty AFTER
        // every chunk in the whole backfill finished, so the periodic save timer never had
        // anything to flush mid-run. The RSS hard-cap guard (rss_guard.rs) exits via
        // `std::process::exit`, which skips all cleanup — a corpus large enough to trip that cap
        // (measured: 9 of 45 chunks before the cap fired) would silently lose every already-
        // applied chunk, undoing the whole run. Force each chunk's patches onto the delta-append
        // path BEFORE returning, so a hard exit loses at most one in-flight chunk.
        //
        // TRDD-ORGJ0E3G follow-up: this used to call `save_cards`, which persisted the WHOLE store once
        // per 200-file chunk (~45 times on the measured 8,846-file corpus), the suspected driver behind
        // the RSS-cap exits this backfill exists to reduce (TRDD-WKLD508O/TWDGR75R). `save_cards_for`
        // below persists ONLY the session_ids this chunk actually patched, so the cost is proportional
        // to the chunk (≤200 cards), not the corpus.
        if chunk_filled > 0 {
            self.mark_dirty();
            self.save_cards_for(state, &patched_ids);
        }
        eprintln!(
            "{} alcore: log-ingest 1h-tier backfill — filled cacheCreate1hTokens on {chunk_filled} of {} flagged card(s) ({} remaining)",
            crate::log_ts(),
            chunk.len(),
            total_before - chunk.len()
        );
        !self.pending_1h_backfill.is_empty()
    }

    /// Test/tooling convenience: drains the WHOLE `pending_1h_backfill` queue in one call by
    /// repeatedly running `run_1h_backfill_step`. Production (`start_sweeper`) calls the step
    /// function directly, once per sweeper-loop iteration, so ingestion is never starved — see
    /// that function's doc comment.
    pub fn run_1h_backfill(&mut self, state: &std::sync::Mutex<crate::CoreState>) {
        while self.run_1h_backfill_step(state) {}
    }

    /// scheduleDurableSave — a sweep produced cards: both sidecars are dirty.
    pub fn mark_dirty(&mut self) {
        self.offsets_dirty = true;
        self.cards_dirty = true;
    }

    /// TRDD-A2KNXCNH — ingest one flushed sweep chunk and persist ITS read positions now, so a
    /// long sweep killed partway resumes from the last chunk instead of restarting from the first
    /// file (before this, no position was written until the sweep returned and the 60 s tick ran).
    ///
    /// Each record key is derived exactly as `LogTailer::export_file_state` derives it
    /// (`PathBuf::from(&s.file).to_string_lossy()`): a different spelling would make the next
    /// full `save_offsets` see every key as new-plus-missing and tombstone and re-append it.
    /// `append_changed` (never `save`) because the chunk is a SUBSET — `save` would tombstone
    /// every other file's position. It also fills the log's `written` hashes, so the next tick
    /// writes only what changed since.
    ///
    /// A poisoned lock panics at the first `lock_timed()` (TRDD-TYJSS45N), so neither the puts
    /// nor the offsets append run. Offsets are still appended strictly after the card puts of this
    /// chunk (TRDD-9VX3WTGU): the positions are built before the lock and appended only after the
    /// guard is dropped, and each put is a committed DuckDB statement, so a position on disk never
    /// describes a file whose card is not in the database.
    pub fn ingest_chunk(&mut self, state: &std::sync::Mutex<crate::CoreState>, chunk: Vec<ScannedFile>) {
        let positions: IndexMap<String, Value> =
            chunk.iter().map(|s| (PathBuf::from(&s.file).to_string_lossy().into_owned(), file_state_record(&s.state))).collect();
        // WHY: a poisoned state lock must fail loud here, not skip the chunk (the 2026-10-14 stall hid one for 28+ hours).
        {
            let mut core = state.lock_timed();
            core.ingest_scanned(chunk);
            self.mark_dirty();
        }
        match self.offsets.append_changed(&positions) {
            Ok(r) if r.bytes > 0 => {
                {
                    let mut st = state.lock_timed();
                    st.persist.offsets_writes += 1;
                    st.persist.offsets_bytes += r.bytes;
                }
            }
            Ok(_) => {}
            Err(e) => eprintln!("{} alcore: could not append chunk read positions: {e}", crate::log_ts()),
        }
    }

    /// saveOffsetsNow — a save that wrote bytes counts as one write (persistStats.offsetsWrites).
    ///
    /// TRDD-9VX3WTGU ORDERING CONTRACT — reuse of `cards.duckdb` depends on it. Offsets are written
    /// from exactly two places, both on the sweeper thread and both AFTER the cards they describe
    /// were put (each `put_arc` is a committed, WAL-fsynced DuckDB statement): this full save, run
    /// from `tick` after the sweep's puts, and `ingest_chunk`'s per-chunk append (TRDD-A2KNXCNH),
    /// run after that chunk's puts. The offsets log is written WITHOUT an fsync. So an offset on
    /// disk never describes a file whose card is not already durable in the database. Saving
    /// offsets before the puts, or from another thread, would let a reused database sit BEHIND its
    /// offsets: the file reads as unchanged and the stale card is never refreshed.
    fn save_offsets(&mut self, tailer: &LogTailer, state: &std::sync::Mutex<crate::CoreState>) {
        match self.offsets.save(&tailer.export_file_state()) {
            Ok(r) if r.bytes > 0 => {
                self.stamp_version();
                {
                    let mut st = state.lock_timed();
                    st.persist.offsets_writes += 1;
                    st.persist.offsets_bytes += r.bytes;
                }
            }
            Ok(_) => {}
            Err(e) => eprintln!("{} alcore: could not save log offsets: {e}", crate::log_ts()),
        }
    }

    fn save_cards(&mut self, state: &std::sync::Mutex<crate::CoreState>) {
        // DA0GN1CS: the state lock covers only a copy of the resident layer's Arc handles (one
        // refcount bump per card). WHY: the previous whole-store persist ran
        // `SELECT session_id, card FROM cards ORDER BY seq` under this lock, the OOM site that panicked
        // the sweeper while it held the lock and poisoned the mutex (2026-10-03 and 2026-10-14). The
        // resident layer is the same corpus in the same order, so the records are built from the snapshot
        // after the lock is released.
        let snap = {
            let st = state.lock_timed();
            st.cards.persist_snapshot()
        };
        // TRDD-2JOIAH2G: the records are streamed from the Arc snapshot, each stripped card built and
        // dropped in turn (twice when the save compacts), instead of collected into a map first — a
        // full stripped copy of the corpus every 300 s and at shutdown.
        let saved = self.cards.save_from(|| snap.iter().map(persist_record));
        drop(snap);
        match saved {
            Ok(r) if r.bytes > 0 => {
                self.stamp_version();
                {
                    let mut st = state.lock_timed();
                    st.persist.cards_writes += 1;
                    st.persist.cards_bytes += r.bytes;
                }
            }
            Ok(_) => {}
            Err(e) => eprintln!("{} alcore: could not save log cards: {e}", crate::log_ts()),
        }
        self.last_cards_save = Instant::now();
    }

    /// TRDD-ORGJ0E3G follow-up — `run_1h_backfill_step`'s own persistence path. Unlike
    /// `save_cards` above (a whole-store persist: every card stripped and diffed against the delta
    /// log — cheap at shutdown/timer cadence, expensive called ~45x per backfill),
    /// this locks the state ONLY to fetch the handful of `session_ids` this one chunk patched
    /// (`st.cards.get(id)`, bounded by chunk size — never a whole-store read under the lock) and
    /// appends just those records via `DeltaLog::append_changed`, which — unlike `DeltaLog::save`
    /// — skips deletion-diffing and compaction: both require the FULL record set to stay correct,
    /// and computing them against a partial chunk would wrongly tombstone every card outside it
    /// (deletion) or discard the rest of the snapshot (compaction). The periodic `tick()` still
    /// calls the full `save_cards` on its own cadence — `mark_dirty()` (called by the caller
    /// before this) keeps that catch-up scheduled, so deletion/compaction correctness is not lost,
    /// only deferred to the next full save.
    fn save_cards_for(&mut self, state: &std::sync::Mutex<crate::CoreState>, session_ids: &[String]) {
        let records: IndexMap<String, Value> = {
            let st = state.lock_timed();
            session_ids.iter().filter_map(|id| st.cards.get(id).map(|c| (id.clone(), strip_card_for_persist(&c)))).collect()
        };
        match self.cards.append_changed(&records) {
            Ok(r) if r.bytes > 0 => {
                self.stamp_version();
                {
                    let mut st = state.lock_timed();
                    st.persist.cards_writes += 1;
                    st.persist.cards_bytes += r.bytes;
                }
            }
            Ok(_) => {}
            Err(e) => eprintln!("{} alcore: could not save log cards (partial): {e}", crate::log_ts()),
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
    /// POST /api/clear: forget every tail offset + accumulator, then a FULL sweep from byte 0.
    Clear,
}

/// LogReader.getLogScanStats — cumulative since boot; `/api/debug/log-scan-stats`. `files_statted`
/// is the metric the watcher slice is judged on: a full sweep stats every log file on the
/// machine, a targeted one only the paths the watcher named — a steady climb by thousands per
/// sweep means the incremental path regressed to a full sweep.
#[derive(Clone, Copy, Debug, Default)]
pub struct LogScanStats {
    pub incremental_reads: u64,
    pub full_reads: u64,
    pub files_statted: u64,
}

impl LogScanStats {
    fn add(&mut self, s: &SweepStats) {
        self.incremental_reads += s.incremental_reads;
        self.full_reads += s.full_reads;
        self.files_statted += s.files as u64;
    }
}

/// The UI's handle on the sweeper thread (CoreState.sweeper).
#[derive(Clone)]
pub struct SweeperControl {
    tx: std::sync::mpsc::Sender<Msg>,
}

impl SweeperControl {
    pub fn clear_and_rescan(&self) {
        let _ = self.tx.send(Msg::Clear);
    }
}

/// A handle to stop the sweeper: `stop()` wakes the thread, which flushes the durable state and
/// exits; the join makes the flush complete before the process does.
pub struct SweeperHandle {
    stop: std::sync::mpsc::Sender<Msg>,
    join: Option<std::thread::JoinHandle<()>>,
}

impl SweeperHandle {
    /// Wake the sweeper thread without waiting for it — the first half of a bounded stop
    /// (TRDD-N60JUWU3): the caller can `signal()` every long-running stop step up front, then
    /// join each one within its own slice of one shared shutdown budget.
    pub fn signal(&self) {
        let _ = self.stop.send(Msg::Stop);
    }

    /// Wait up to `budget` for the (already `signal()`ed) sweeper thread to finish, polling
    /// `is_finished()` rather than blocking on `join()` — `join()` would wait unboundedly on
    /// `save_cards`'s own `lock_timed()` (TRDD-N60JUWU3 root cause #2: the sweeper's final flush
    /// can itself be stuck behind the same contended state lock the caller is also waiting on).
    /// Returns `true` if the thread finished in time.
    pub fn join_within(mut self, budget: std::time::Duration) -> bool {
        let deadline = std::time::Instant::now() + budget;
        loop {
            match self.join.as_ref() {
                None => return true,
                Some(j) if j.is_finished() => {
                    let _ = self.join.take().unwrap().join();
                    return true;
                }
                Some(_) => {
                    if std::time::Instant::now() >= deadline {
                        return false;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(20));
                }
            }
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
/// TRDD-ORGJ0E3G follow-up — pure predicate for "has the FULL_RESCAN backstop deadline passed".
/// Extracted so `start_sweeper`'s loop can check it from more than one place (the top of the loop
/// AND the `RecvTimeoutError::Timeout` arm) without duplicating the comparison, and so it is
/// unit-testable without spinning up the sweeper thread. `next_full` is re-armed by the caller
/// (`next_full = Instant::now() + backstop`) after every full sweep, whatever triggered it — this
/// function only answers "is it due right now", never "has it ever been due".
fn should_full_sweep(now: Instant, next_full: Instant) -> bool {
    now >= next_full
}

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
                let mut st = state.lock_timed();
                durable.restore(&mut tailer, &mut st, &env)
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
            let (_watcher, watch_attached, watch_failed) = attach_watchers(&env, tx.clone());
            // TRDD-2JOIAH2G R5: the boot sweep ingests each SCAN_CHUNK under a short state lock
            // and drops it — the only residual is the final partial chunk. TRDD-A2KNXCNH: every
            // chunk goes through `ingest_chunk`, which puts its cards, marks both sidecars dirty
            // and THEN appends that chunk's read positions — a boot sweep killed partway resumes
            // from the last persisted chunk instead of re-reading the whole corpus.
            let mut ingest_boot = |chunk: Vec<ScannedFile>| durable.ingest_chunk(&state, chunk);
            let (scanned, sweep) = tailer.sweep(&env, crate::now_ms(), Some(&mut ingest_boot));
            // The remainder takes the same path, BEFORE the lock below: `ingest_chunk` takes the
            // state lock itself, and std Mutex is not reentrant.
            if !scanned.is_empty() {
                durable.ingest_chunk(&state, scanned);
            }
            {
                let mut st = state.lock_timed();
                st.log_scan.add(&sweep);
                st.sweeper = Some(SweeperControl { tx });
            }
            let _ = boot_tx.send(Ok(BootReport {
                restored_cards,
                offsets_imported,
                offsets_skipped,
                sweep,
                watch_attached,
                watch_failed: watch_failed.len(),
            }));
            // TRDD-RVKQDLRD: this thread DELIBERATELY stays at normal priority (no background QoS).
            // Most of its lock holds are short (sweep ingestion is chunked, SCAN_CHUNK per lock;
            // the 1h backfill is bounded, <=200 cards per lock), but each non-empty ingest batch
            // (ingest_scanned returns early on an empty one), once the corpus exceeds the hot set
            // (demote_cold returns early below it), ends in demote_cold's keys-only candidate query
            // plus, per demoted card, one primary-key fetch and UPDATE, under the lock
            // (TRDD-KMF02UEX); a forced 30-card pass (hot_cards 1) took 0.58-1.64 s on scratch
            // clones (cold, no lock, timer including the connection open; the upper figure on a
            // synthetic regrowth), almost all of it per-card fetch and UPDATE (TRDD-074C0DK8); the
            // hold under the real lock is unmeasured. At background QoS that hold would be
            // preempted while request threads wait on the lock (priority inversion), so lowering
            // this thread would make requests slower, not the machine quieter. Since
            // DA0GN1CS the periodic save no longer adds a full-corpus scan under the lock;
            // re-decide this under RVKQDLRD.
            let backstop = if watch_attached > 0 { FULL_RESCAN } else { poll_interval };
            let mut next_full = Instant::now() + backstop;
            let mut pending: Vec<PathBuf> = Vec::new();
            let mut needs_full = false;
            // TRDD-9VX3WTGU: `/api/clear` emptied the card store and set `clear_in_progress` in
            // its meta table; it stays set until the full rescan this flag tracks has put every
            // card back (see `CardStore::clear`). Residual window, accepted: a SECOND clear that
            // lands while the first rescan runs has its flag reset by the first rescan's end; the
            // second rescan then runs with the flag already 0 (a crash inside it would be reused
            // as an incomplete corpus). Two clears back to back are an operator action, and the
            // alternative is a counter threaded through the clear message.
            let mut clear_pending = false;
            loop {
                // TRDD-ORGJ0E3G follow-up: drain every message ALREADY queued (non-blocking,
                // try_recv until Empty) before even considering a backfill chunk. Without this a
                // burst of real transcript writes sitting in `rx` would still wait behind
                // whatever backfill chunk the loop chose to run first each iteration; draining
                // first means a chunk only ever runs once the channel is genuinely empty right
                // now.
                loop {
                    match rx.try_recv() {
                        Ok(Msg::Stop) => {
                            durable.tick(&tailer, &state, true);
                            return;
                        }
                        Ok(Msg::Changed(p)) => pending.extend(p),
                        Ok(Msg::Unnamed) => needs_full = true,
                        Ok(Msg::Clear) => {
                            tailer.clear();
                            needs_full = true;
                            clear_pending = true;
                        }
                        Err(std::sync::mpsc::TryRecvError::Empty) => break,
                        Err(std::sync::mpsc::TryRecvError::Disconnected) => {
                            durable.tick(&tailer, &state, true);
                            return;
                        }
                    }
                }
                // The backstop deadline is checked HERE, unconditionally, every iteration — not
                // only inside the `RecvTimeoutError::Timeout` arm below, which a steady stream of
                // real events (each arriving before `wait` elapses) would never reach, starving
                // FULL_RESCAN indefinitely. `should_full_sweep` re-checked below (after the
                // blocking recv) is the freshest read right when a wait actually elapses; this one
                // is what catches the "busy channel" case.
                if should_full_sweep(Instant::now(), next_full) {
                    needs_full = true;
                }
                // TRDD-ORGJ0E3G: one bounded chunk (<=200 files) of the usage-only 1h-tier
                // backfill per loop iteration, not the whole queue in one blocking call BEFORE
                // this loop starts — a corpus with thousands of flagged transcripts (measured:
                // ~6.5 minutes for 8,846) previously left every real transcript write from every
                // other agent queued and unprocessed in `rx` for that whole span, since nothing
                // drained the channel until the call returned. Interleaving it here means a real
                // `Msg::Changed`/`Msg::Stop` is always handled within one iteration. Gated on
                // `pending.is_empty() && !needs_full` (on top of the try_recv drain above): a
                // message that arrived in the tiny window between the drain and here still takes
                // priority over starting another chunk.
                let backfill_pending = !durable.pending_1h_backfill.is_empty();
                if backfill_pending && pending.is_empty() && !needs_full {
                    durable.run_1h_backfill_step(&state);
                }
                // recv_timeout doubles as the sleep: an event or a stop wakes the loop at once.
                // Cap the wait while a backfill chunk remains so idle time between real events
                // doesn't stall backfill progress behind FULL_RESCAN's up-to-60s backstop.
                let mut wait = next_full.saturating_duration_since(Instant::now());
                if backfill_pending {
                    wait = wait.min(std::time::Duration::from_millis(50));
                }
                let first = rx.recv_timeout(wait);
                match first {
                    Ok(Msg::Stop) | Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                        durable.tick(&tailer, &state, true);
                        return;
                    }
                    Ok(Msg::Changed(p)) => pending.extend(p),
                    Ok(Msg::Unnamed) => needs_full = true,
                    Ok(Msg::Clear) => {
                        tailer.clear();
                        needs_full = true;
                        clear_pending = true;
                    }
                    // Review fix: `wait` above is capped to 50ms while a backfill chunk is
                    // pending, so a Timeout here does NOT mean the FULL_RESCAN backstop (up to
                    // 60s) actually elapsed — only that our artificially short wait did. Setting
                    // `needs_full` unconditionally on every such tick would turn one full
                    // filesystem sweep per 60s into one every ~50ms for the whole backfill
                    // duration (caught by review). Only the genuine backstop deadline forces a
                    // full sweep; an early return from the capped wait falls through to the next
                    // iteration having done nothing, which is correct (that's the whole point of
                    // the cap: give `run_1h_backfill_step` another turn soon).
                    Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                        if should_full_sweep(Instant::now(), next_full) {
                            needs_full = true;
                        }
                    }
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
                            Ok(Msg::Clear) => {
                                tailer.clear();
                                needs_full = true;
                                clear_pending = true;
                                break;
                            }
                            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => break,
                        }
                    }
                }
                let full_sweep = needs_full;
                let (scanned, sweep) = if needs_full {
                    // A full sweep subsumes every pending hint and re-arms the backstop.
                    // TRDD-2JOIAH2G R5: chunks flush straight into the card map under a short
                    // lock; only the final partial chunk comes back through `scanned`.
                    pending.clear();
                    needs_full = false;
                    next_full = Instant::now() + backstop;
                    // TRDD-A2KNXCNH: each flushed chunk goes through `ingest_chunk`, which puts its
                    // cards and THEN appends its read positions, so a sweep killed partway resumes
                    // from the last chunk instead of re-reading everything.
                    let mut ingest_loop = |chunk: Vec<ScannedFile>| durable.ingest_chunk(&state, chunk);
                    let (scanned, sweep) = tailer.sweep(&env, crate::now_ms(), Some(&mut ingest_loop));
                    // The full sweep's remainder takes the same path. WHY here and not in the
                    // post-sweep block below: that block holds the state lock, and `ingest_chunk`
                    // takes it itself (std Mutex is not reentrant). Nothing is returned, so the
                    // block below only records the stats for a full sweep.
                    if !scanned.is_empty() {
                        durable.ingest_chunk(&state, scanned);
                    }
                    (Vec::new(), sweep)
                } else {
                    let paths = std::mem::take(&mut pending);
                    tailer.sweep_paths(&env, &paths, crate::now_ms())
                };
                {
                    let mut st = state.lock_timed();
                    st.log_scan.add(&sweep);
                    if !scanned.is_empty() {
                        durable.mark_dirty();
                        st.ingest_scanned(scanned);
                    }
                }
                // The rescan of a `/api/clear` has put every card (flushed chunks + the remainder
                // ingested just above): the corpus is whole again, so the next boot may reuse it.
                if clear_pending && full_sweep {
                    clear_pending = false;
                    state.lock_timed().cards.finish_clear();
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

#[cfg(test)]
mod sweeper_backstop_tests {
    use super::should_full_sweep;
    use std::time::{Duration, Instant};

    /// The pre-streaming whole-file implementation, kept verbatim as the oracle (TRDD-735Q3JF4).
    fn old_read_lines_from(path: &std::path::Path, from: u64) -> std::io::Result<(Vec<Vec<u8>>, u64)> {
        use std::io::{Read, Seek, SeekFrom};
        let mut file = std::fs::File::open(path)?;
        file.seek(SeekFrom::Start(from))?;
        let mut buf = Vec::new();
        file.read_to_end(&mut buf)?;
        let Some(last_nl) = buf.iter().rposition(|b| *b == b'\n') else { return Ok((Vec::new(), from)) };
        let lines = buf[..last_nl].split(|b| *b == b'\n').filter(|l| !l.iter().all(u8::is_ascii_whitespace)).map(<[u8]>::to_vec).collect();
        Ok((lines, from + last_nl as u64 + 1))
    }

    /// The streaming read must yield the same lines and the same consumed offset as the whole-file oracle.
    #[test]
    fn streaming_read_lines_from_matches_the_whole_file_oracle() {
        let mut long = vec![b'x'; 200_000];
        long.extend_from_slice(b"\npartial");
        let mut partial_tail = b"a\n".to_vec();
        partial_tail.extend(vec![b'y'; 100_000]);
        let mut boundary = vec![b'z'; 65_535];
        boundary.extend_from_slice(b"\nnext\n");
        let cases: Vec<(&str, Vec<u8>, u64)> = vec![
            ("empty", vec![], 0),
            ("no newline", b"abc".to_vec(), 0),
            ("one complete line", b"{\"a\":1}\n".to_vec(), 0),
            ("trailing partial", b"one\ntwo\npart".to_vec(), 0),
            ("blank lines", b"\n\n".to_vec(), 0),
            ("whitespace-only line", b"a\n  \t\nb\n".to_vec(), 0),
            ("crlf", b"a\r\nb\r\n".to_vec(), 0),
            ("lone crlf", b"\r\n".to_vec(), 0),
            ("invalid utf8", b"a\xff\xfe\nb\n".to_vec(), 0),
            ("from mid-line", b"abcdef\nghi\njk".to_vec(), 3),
            ("from == len", b"abc\ndef\n".to_vec(), 8),
            ("line longer than buffer", long, 0),
            ("partial tail longer than buffer", partial_tail, 0),
            ("newline on the buffer boundary", boundary, 0),
        ];
        let nanos = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
        let dir = std::env::temp_dir().join(format!("alcore-rlf-{}-{nanos}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        for (i, (name, bytes, from)) in cases.iter().enumerate() {
            let p = dir.join(format!("case{i}.jsonl"));
            std::fs::write(&p, bytes).unwrap();
            let mut got: Vec<Vec<u8>> = Vec::new();
            let off = super::read_lines_from(&p, *from, |l| got.push(l.to_vec())).unwrap();
            let (want, want_off) = old_read_lines_from(&p, *from).unwrap();
            assert_eq!(got, want, "lines differ for case {name}");
            assert_eq!(off, want_off, "offset differs for case {name}");
        }
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// TRDD-ORGJ0E3G follow-up: the backstop must fire exactly once it is due, and stay quiet
    /// both before the deadline and after being re-armed to a later deadline — the loop re-arms
    /// `next_full` to `now + backstop` after every full sweep, so the same wall-clock instant must
    /// read as "not due" once `next_full` has moved past it again.
    #[test]
    fn fires_once_past_the_deadline_then_not_again_until_rearmed() {
        let start = Instant::now();
        let next_full = start + Duration::from_millis(100);

        assert!(!should_full_sweep(start, next_full), "not due yet at t=0");
        assert!(
            !should_full_sweep(start + Duration::from_millis(50), next_full),
            "a 50ms wakeup well before the 100ms deadline must not fire"
        );
        assert!(should_full_sweep(start + Duration::from_millis(100), next_full), "exactly at the deadline it must fire");
        assert!(should_full_sweep(start + Duration::from_millis(150), next_full), "still due after the deadline, until re-armed");

        // Re-arm: the caller sets next_full = now + backstop after running the full sweep.
        let rearmed_now = start + Duration::from_millis(150);
        let rearmed_next_full = rearmed_now + Duration::from_secs(60);
        assert!(!should_full_sweep(rearmed_now, rearmed_next_full), "must not fire again immediately after being re-armed");
    }
}

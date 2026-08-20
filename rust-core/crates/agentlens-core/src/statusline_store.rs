//! The high-frequency status-line sample store (TRDD-DMWOBWFH, freeze row 5) — port of
//! src/statuslineStore.ts. Samples measured at ~609/min ≈ 1.29 GB/day raw at 20 instances get
//! their OWN store (they evicted the 600-slot lifecycle ring down to an ~87s span when they
//! shared the hook-event buckets), columnar + compressed:
//!
//!   <root>/<stream>/YYYY-MM-DD/part-<epochMs>-<pid>-<seq>.parquet   sealed, immutable
//!   <root>/<stream>/YYYY-MM-DD/wal-<pid>.ndjson                     active, un-sealed
//!
//! Every layout choice is the TS module's measured one (parquet+zstd over zstd-NDJSON, flat
//! dotted keys, no row packing, no UUID typing, large SEAL_ROWS) — the header there carries the
//! numbers. WAL-then-seal with ONE fsync per BATCH; verify-before-delete on every seal (the WAL
//! is the only other copy); the inference-collapse refusal keeps a WAL whose record structure
//! read_json_auto gave up on (sealing it would write all-NULL rows and destroy the raw JSON
//! while the row-count verify waved it through).
//!
//! CROSS-ENGINE LAW: both engines WRITE this store (the TS server today, alcore after cutover),
//! so the on-disk shapes must stay mutually readable — the parity test queries a TS-sealed
//! parquet part through this reader.
//!
//! Deliberate ports of TS accidents, kept: `walRows` is NOT ported — the TS map is write-only
//! (set/read only inside its own update expression; verified by grep), dead accounting with no
//! observable behavior. NOT PORTED (consumers recorded in their own modules): the
//! StatuslineUsageAgg live aggregates (statuslineUsage.ts — feeds the timeline overlay and
//! getBillingEvents, both already marked unported).

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use agentlens_store::duckdb::Connection;
use serde_json::{Map, Value};

use crate::summarize::helpers::{iso_from_ms, num};

pub const STATUSLINE_STREAMS: [&str; 2] = ["main", "subagent"];

/// Rows per sealed part — large on purpose (parquet's footer metadata dominates below ~1k
/// rows). Read per call from the vars snapshot so tests and operators can change it.
pub fn seal_rows(vars: &HashMap<String, String>) -> f64 {
    vars.get("AGENTLENS_STATUSLINE_SEAL_ROWS")
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(10_000.0)
}

/// Day-partitions older than this are purged whole.
pub fn retention_days(vars: &HashMap<String, String>) -> f64 {
    vars.get("AGENTLENS_STATUSLINE_RETENTION_DAYS")
        .and_then(|s| s.parse::<f64>().ok())
        .filter(|v| v.is_finite() && *v > 0.0)
        .unwrap_or(90.0)
}

const FLUSH_MAX_RECORDS: usize = 32;
const FLUSH_MAX_BYTES: usize = 16 * 1024;

/// flattenSample — nested OBJECTS to dotted-with-underscore keys; ARRAYS and scalars (null
/// included) untouched: `tasks[]` must stay a LIST so DuckDB can `unnest` it — flattening it
/// would create an unbounded, drifting column space.
pub fn flatten_sample(v: &Map<String, Value>, prefix: &str) -> Map<String, Value> {
    let mut out = Map::new();
    for (k, val) in v {
        let key = format!("{prefix}{k}");
        match val {
            Value::Object(o) => out.extend(flatten_sample(o, &format!("{key}_"))),
            other => {
                out.insert(key, other.clone());
            }
        }
    }
    out
}

/// UTC day key — the partition directory name.
pub fn day_key(ts_ms: f64) -> String {
    iso_from_ms(ts_ms)[..10].to_owned()
}

/// ndjsonBuckets.dayKeyMs — a calendar-real 'YYYY-MM-DD' name → its UTC day-start ms; anything
/// else is None (a foreign or malformed directory is IGNORED, never touched or purged).
fn day_ms_of(name: &str) -> Option<i64> {
    agentlens_spanstore::segment_day_ms(&format!("{name}.ndjson"))
}

/// A part name that CANNOT collide across concurrent writers — epoch-ms + pid + seq, copied
/// deliberately from the body store: DuckDB's COPY TO silently OVERWRITES an existing file, so
/// a repeatable name silently destroys a sealed chunk.
fn part_name(seq: u64) -> String {
    format!("part-{}-{}-{seq}.parquet", crate::now_ms(), std::process::id())
}

fn q(p: &str) -> String {
    format!("'{}'", p.replace('\'', "''"))
}

fn list_files(dir: &Path, pred: impl Fn(&str) -> bool) -> Vec<PathBuf> {
    let Ok(rd) = std::fs::read_dir(dir) else { return Vec::new() };
    let mut out: Vec<PathBuf> = rd
        .flatten()
        .filter(|e| e.file_name().to_str().is_some_and(&pred))
        .map(|e| e.path())
        .collect();
    // readdir order is platform-arbitrary; sorted so relation SQL and seal order are
    // deterministic (the TS leaves readdir order — not part of any frozen shape).
    out.sort();
    out
}

/// dayPartitions — every day-partition of a stream, oldest first.
pub fn day_partitions(root: &Path, stream: &str) -> Vec<(PathBuf, i64)> {
    let base = root.join(stream);
    let Ok(rd) = std::fs::read_dir(&base) else { return Vec::new() };
    let mut out: Vec<(PathBuf, i64)> = rd
        .flatten()
        .filter_map(|e| {
            let name = e.file_name();
            let ms = day_ms_of(name.to_str()?)?;
            Some((base.join(name), ms))
        })
        .collect();
    out.sort_by_key(|(_, ms)| *ms);
    out
}

/// One extra day of slack on each end of a window's PARTITION selection: flush files a batch
/// under the day it is WRITTEN, so a pre-midnight append flushed post-midnight lands in the
/// NEXT day's partition — without slack that record reads as BLIND while existing and matching
/// the window. Widening only admits candidate FILES; query_statusline still filters rows on ts.
const PARTITION_SLACK_MS: i64 = 86_400_000;

/// filesInWindow — sealed parts + un-sealed WALs, window applied at DAY granularity + slack.
pub fn files_in_window(root: &Path, stream: &str, since_ms: Option<f64>, until_ms: Option<f64>) -> (Vec<PathBuf>, Vec<PathBuf>) {
    let mut parts = Vec::new();
    let mut wals = Vec::new();
    for (dir, day_ms) in day_partitions(root, stream) {
        if let Some(since) = since_ms {
            if ((day_ms + 86_400_000 + PARTITION_SLACK_MS) as f64) <= since {
                continue;
            }
        }
        if let Some(until) = until_ms {
            if day_ms as f64 > until + PARTITION_SLACK_MS as f64 {
                continue;
            }
        }
        parts.extend(list_files(&dir, |f| f.ends_with(".parquet")));
        wals.extend(list_files(&dir, |f| f.starts_with("wal-") && f.ends_with(".ndjson")));
    }
    (parts, wals)
}

/// The columns a query may reference even when NO file in the window carries them — without
/// this, absence is a Binder ERROR rather than an empty result (measured: one sample lacking
/// the optional rate_limits/current_usage blocks killed all five main-stream views). A
/// CONTRACT, not a schema: files still contribute every other column they carry.
const GUARANTEED_COLUMNS: [(&str, &str); 24] = [
    ("ts", "BIGINT"),
    ("session_id", "VARCHAR"),
    ("model_display_name", "VARCHAR"),
    ("model_id", "VARCHAR"),
    ("effort_level", "VARCHAR"),
    ("context_window_used_percentage", "DOUBLE"),
    ("context_window_total_input_tokens", "BIGINT"),
    ("context_window_current_usage_input_tokens", "BIGINT"),
    ("context_window_current_usage_output_tokens", "BIGINT"),
    ("context_window_current_usage_cache_creation_input_tokens", "BIGINT"),
    ("context_window_current_usage_cache_read_input_tokens", "BIGINT"),
    ("cost_total_cost_usd", "DOUBLE"),
    ("rate_limits_five_hour_used_percentage", "DOUBLE"),
    ("rate_limits_seven_day_used_percentage", "DOUBLE"),
    ("rate_limits_five_hour_resets_at", "BIGINT"),
    ("workspace_project_dir", "VARCHAR"),
    ("workspace_current_dir", "VARCHAR"),
    ("cwd", "VARCHAR"),
    ("workspace_repo_owner", "VARCHAR"),
    ("workspace_repo_name", "VARCHAR"),
    ("version", "VARCHAR"),
    ("session_name", "VARCHAR"),
    ("fast_mode", "BOOLEAN"),
    ("thinking_enabled", "BOOLEAN"),
    // `exceeds_200k_tokens` + `rate_limits_seven_day_resets_at` complete the TS list below.
];

fn column_template() -> String {
    let cols: Vec<String> = GUARANTEED_COLUMNS
        .iter()
        .map(|(c, t)| format!("NULL::{t} AS {c}"))
        .chain([
            "NULL::BOOLEAN AS exceeds_200k_tokens".to_owned(),
            "NULL::BIGINT AS rate_limits_seven_day_resets_at".to_owned(),
        ])
        .collect();
    format!("SELECT {} WHERE false", cols.join(", "))
}

/// varcharSessionId — normalize ONE source: guarantee the contract columns bind AND force
/// session_id to VARCHAR. DuckDB infers a UUID-shaped string as the UUID type PER FILE; a
/// union of a UUID-typed part with a VARCHAR-typed WAL reconciles to UUID and ONE non-UUID id
/// kills every view with `Could not convert string to INT128` — the cast must wrap each file's
/// own relation (a SELECT-list cast is too late, the failure happens in the union).
fn varchar_session_id(inner: &str) -> String {
    format!(
        "SELECT * REPLACE (CAST(session_id AS VARCHAR) AS session_id) FROM ({} UNION ALL BY NAME {inner})",
        column_template()
    )
}

/// relationFor — sealed parts UNION the live WALs (parts alone are stale by up to a chunk,
/// WALs alone see nothing older than the last seal). None when the window holds nothing — the
/// caller must report BLIND, and must never hand DuckDB a bare glob (an ERROR on an empty dir).
pub fn relation_for(root: &Path, stream: &str, since_ms: Option<f64>, until_ms: Option<f64>) -> Option<String> {
    let (parts, wals) = files_in_window(root, stream, since_ms, until_ms);
    let rels: Vec<String> = parts
        .iter()
        .map(|p| varchar_session_id(&format!("SELECT * FROM read_parquet({})", q(&p.to_string_lossy()))))
        .chain(
            wals.iter()
                .map(|w| varchar_session_id(&format!("SELECT * FROM read_json_auto({}, ignore_errors=true)", q(&w.to_string_lossy())))),
        )
        .collect();
    if rels.is_empty() {
        return None;
    }
    Some(format!("({})", rels.join(" UNION ALL BY NAME ")))
}

/// The fileless DuckDB every read and seal uses — ':memory:' is measured, not a preference
/// (a persistent .duckdb showed 300x write amplification); no temp spill (an over-limit query
/// must fail loudly, not quietly write gigabytes).
fn open_duck(vars: &HashMap<String, String>) -> Result<Connection, String> {
    let con = Connection::open_in_memory().map_err(|e| e.to_string())?;
    let limit = vars
        .get("AGENTLENS_DUCKDB_MEMORY_LIMIT")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or("2GB");
    con.execute_batch(&format!(
        "SET memory_limit='{}'; SET threads=2; SET temp_directory=''; SET preserve_insertion_order=false;",
        limit.replace('\'', "''")
    ))
    .map_err(|e| e.to_string())?;
    Ok(con)
}

fn count_lines(file: &Path) -> usize {
    std::fs::read_to_string(file).map(|raw| raw.split('\n').filter(|l| !l.is_empty()).count()).unwrap_or(0)
}

/// The seal/durability counters — shared with the seal task, surfaced by stats().
#[derive(Default)]
pub struct SealCounters {
    pub sealed_parts: std::sync::atomic::AtomicU64,
    /// WALs (or lump counts) the seal REFUSED or lost — non-zero means raw JSON sits unsealed
    /// or a torn line became a NULL row; visible here rather than silent.
    pub corrupt_wals: std::sync::atomic::AtomicU64,
}

/// One instance per server process. append() runs at the full sample rate — a push onto a
/// buffer; everything expensive happens on the flush/seal boundaries.
pub struct StatuslineStore {
    pub root: PathBuf,
    buffers: HashMap<&'static str, Vec<String>>,
    buffered_bytes: HashMap<&'static str, usize>,
    pub counters: std::sync::Arc<SealCounters>,
    pub dropped_rows: u64,
    /// First-append-failure logging latch (the TS statuslineIngestErrors).
    ingest_errors: u64,
}

impl StatuslineStore {
    pub fn new(root: PathBuf) -> StatuslineStore {
        StatuslineStore {
            root,
            buffers: HashMap::new(),
            buffered_bytes: HashMap::new(),
            counters: std::sync::Arc::new(SealCounters::default()),
            dropped_rows: 0,
            ingest_errors: 0,
        }
    }

    fn stream_key(stream: &str) -> &'static str {
        if stream == "subagent" { "subagent" } else { "main" }
    }

    /// Buffer one sample: flatten to dotted keys and stamp `ts` (server receive time — the
    /// payload carries no timestamp and every query and partition boundary needs one). A
    /// payload that already carries a top-level `ts` keeps its key POSITION, value replaced —
    /// the JS assignment's exact behavior, which IndexMap-backed insert reproduces.
    pub fn append(&mut self, payload: &Map<String, Value>, stream: &str, ts_ms: f64) {
        let mut flat = flatten_sample(payload, "");
        flat.insert("ts".to_owned(), num(ts_ms));
        let line = Value::Object(flat).to_string();
        let key = Self::stream_key(stream);
        let buf = self.buffers.entry(key).or_default();
        buf.push(line.clone());
        let len = buf.len();
        // Threshold accounting in BYTES (the TS counts UTF-16 units — only the trigger point
        // can differ, never the data).
        let bytes = self.buffered_bytes.entry(key).or_insert(0);
        *bytes += line.len() + 1;
        if len >= FLUSH_MAX_RECORDS || *bytes >= FLUSH_MAX_BYTES {
            self.flush(Some(key));
        }
    }

    fn wal_path(&self, stream: &str, ts_ms: f64) -> PathBuf {
        self.root.join(stream).join(day_key(ts_ms)).join(format!("wal-{}.ndjson", std::process::id()))
    }

    /// Append the buffered batch to the day's WAL — one open, one write, ONE fsync per BATCH.
    /// Never panics: a write failure re-buffers the batch IN FRONT so the next flush retries in
    /// order, dropping only when the backlog becomes absurd (a full disk must not OOM us).
    /// Partitioning is by the day the batch is WRITTEN (see PARTITION_SLACK_MS — the pair).
    pub fn flush(&mut self, only: Option<&str>) {
        for stream in STATUSLINE_STREAMS {
            if only.is_some_and(|o| o != stream) {
                continue;
            }
            let Some(batch) = self.buffers.get_mut(stream).filter(|b| !b.is_empty()) else { continue };
            let batch: Vec<String> = std::mem::take(batch);
            self.buffered_bytes.insert(stream, 0);
            let wal = self.wal_path(stream, crate::now_ms() as f64);
            let lines = format!("{}\n", batch.join("\n"));
            let write = || -> std::io::Result<()> {
                use std::io::Write;
                if let Some(dir) = wal.parent() {
                    std::fs::create_dir_all(dir)?;
                }
                let mut fd = std::fs::OpenOptions::new().append(true).create(true).open(&wal)?; // O_APPEND: atomic at EOF
                fd.write_all(lines.as_bytes())?;
                fd.sync_all() // durability once per BATCH, never per record
            };
            if let Err(e) = write() {
                self.ingest_errors += 1;
                if self.ingest_errors == 1 {
                    eprintln!("alcore: statusline sample append FAILED: {e}");
                }
                let cur = self.buffers.entry(stream).or_default();
                if cur.len() + batch.len() > FLUSH_MAX_RECORDS * 200 {
                    self.dropped_rows += batch.len() as u64;
                } else {
                    let mut merged = batch;
                    merged.extend(std::mem::take(cur));
                    *cur = merged;
                    *self.buffered_bytes.entry(stream).or_insert(0) += lines.len();
                }
            }
        }
    }

    /// stats() — the /api/server-stats `statusline` section's inputs.
    pub fn stats(&self) -> Value {
        let (mut parts, mut part_bytes, mut wal_bytes) = (0u64, 0u64, 0u64);
        for stream in STATUSLINE_STREAMS {
            for (dir, _) in day_partitions(&self.root, stream) {
                for f in list_files(&dir, |_| true) {
                    let Ok(m) = std::fs::metadata(&f) else { continue };
                    let name = f.to_string_lossy();
                    if name.ends_with(".parquet") {
                        parts += 1;
                        part_bytes += m.len();
                    } else if name.ends_with(".ndjson") {
                        wal_bytes += m.len();
                    }
                }
            }
        }
        let buffered: usize = self.buffers.values().map(Vec::len).sum();
        serde_json::json!({
            "parts": parts, "partBytes": part_bytes, "walBytes": wal_bytes,
            "bufferedRows": buffered,
            "sealedParts": self.counters.sealed_parts.load(std::sync::atomic::Ordering::Relaxed),
            "droppedRows": self.dropped_rows,
            "corruptWals": self.counters.corrupt_wals.load(std::sync::atomic::Ordering::Relaxed),
        })
    }
}

/// base36 of a non-negative integer — Date.now().toString(36) for the rotation suffix.
fn to_base36(mut n: u64) -> String {
    const D: &[u8; 36] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    if n == 0 {
        return "0".to_owned();
    }
    let mut out = Vec::new();
    while n > 0 {
        out.push(D[(n % 36) as usize]);
        n /= 36;
    }
    out.reverse();
    String::from_utf8(out).expect("base36 digits")
}

/// maybeSeal — every WAL that is full, or belongs to a past day, or is an ORPHAN (a pid not
/// ours: every restart strands one) becomes an immutable parquet part. A FREE function on
/// purpose: sealing runs DuckDB over whole WALs and must never sit inside the CoreState lock —
/// it only touches files, the shared counters, and the vars snapshot. Runs on ONE 60s task, so
/// the TS re-entrancy latch is unnecessary by construction (noted, not dropped silently).
pub fn maybe_seal(root: &Path, counters: &SealCounters, vars: &HashMap<String, String>, now_ms: f64) -> u64 {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let today = day_key(now_ms);
    let mut sealed = 0u64;
    for stream in STATUSLINE_STREAMS {
        for (dir, _) in day_partitions(root, stream) {
            let is_past_day = dir.file_name().and_then(|n| n.to_str()) != Some(today.as_str());
            for wal in list_files(&dir, |f| f.starts_with("wal-") && f.ends_with(".ndjson")) {
                let mut rows = count_lines(&wal);
                if rows == 0 {
                    if is_past_day {
                        let _ = std::fs::remove_file(&wal); // raced — fine
                    }
                    continue;
                }
                let own_live = format!("wal-{}.ndjson", std::process::id());
                let orphan = wal.file_name().and_then(|n| n.to_str()) != Some(own_live.as_str());
                if !is_past_day && !orphan && (rows as f64) < seal_rows(vars) {
                    continue;
                }
                let mut target = wal.clone();
                if !is_past_day && !orphan {
                    // ROTATE our own LIVE WAL first: flush keeps appending to the fixed per-pid
                    // name, so sealing it in place races the appender (COPY reads more rows than
                    // counted, the verify fails, a whole DuckDB instance is wasted per tick).
                    // After the atomic rename the file can never grow again.
                    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                    let rot = dir.join(format!("wal-{}.rot-{}{seq}.ndjson", std::process::id(), to_base36(crate::now_ms() as u64)));
                    if std::fs::rename(&wal, &rot).is_err() {
                        continue; // raced with a purge — next tick
                    }
                    target = rot;
                    rows = count_lines(&target); // appends between count and rename landed here
                    if rows == 0 {
                        continue;
                    }
                }
                if seal_one(&target, rows, counters, vars) {
                    sealed += 1;
                }
            }
        }
    }
    counters.sealed_parts.fetch_add(sealed, std::sync::atomic::Ordering::Relaxed);
    sealed
}

/// Did read_json_auto give up on the RECORD structure and fall back to one opaque `json`
/// column? Sealing that file would write all-NULL rows and DELETE the raw JSON while the
/// row-count verify waves it through — the nastiest failure this store can have (measured: ONE
/// bare-scalar line triggers it). Refuse deliberately, keep the raw lines, COUNT it.
fn inference_collapsed(cols: &[String]) -> bool {
    cols.len() == 1 && cols[0] == "json"
}

/// Convert ONE WAL to a parquet part and delete it — only after PROVING the part holds every
/// row. Never panics out of the seal path; every failure removes the untrustworthy part and
/// keeps the WAL for the next tick.
fn seal_one(wal: &Path, expect_rows: usize, counters: &SealCounters, vars: &HashMap<String, String>) -> bool {
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let dir = wal.parent().expect("wal lives in a partition dir");
    let out = dir.join(part_name(SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
    if out.exists() {
        // Defence in depth behind the collision-free name: COPY TO silently overwrites, and an
        // overwritten part is destroyed data. Refuse; the naming invariant is broken.
        eprintln!("alcore: refusing to overwrite existing part {} — part naming must be collision-free", out.display());
        return false;
    }
    let run = || -> Result<bool, String> {
        let con = open_duck(vars)?;
        let wal_q = q(&wal.to_string_lossy());
        let cols: Vec<String> = {
            let mut stmt = con
                .prepare(&format!(
                    "SELECT column_name FROM (DESCRIBE SELECT * FROM read_json_auto({wal_q}, union_by_name=true, ignore_errors=true))"
                ))
                .map_err(|e| e.to_string())?;
            let it = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
            it.flatten().collect()
        };
        if inference_collapsed(&cols) {
            counters.corrupt_wals.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            return Ok(false); // keep the WAL: its raw JSON is the only readable copy
        }
        // ORDER BY session_id measured 1.24x better compression (clusters near-identical
        // consecutive samples into dictionary/RLE runs); sealing session_id as VARCHAR is the
        // ROOT fix for the UUID-inference trap — new parts need no read-time repair.
        con.execute_batch(&format!(
            "COPY (SELECT * FROM ({}) ORDER BY session_id, ts) TO {} (FORMAT PARQUET, COMPRESSION ZSTD)",
            varchar_session_id(&format!("SELECT * FROM read_json_auto({wal_q}, union_by_name=true, ignore_errors=true)")),
            q(&out.to_string_lossy())
        ))
        .map_err(|e| e.to_string())?;
        let count = |sql: &str| -> Result<i64, String> {
            con.query_row(sql, [], |r| r.get::<_, i64>(0)).map_err(|e| e.to_string())
        };
        let got = count(&format!("SELECT count(*) FROM read_parquet({})", q(&out.to_string_lossy())))?;
        if got != expect_rows as i64 {
            // Do NOT delete the WAL — remove the untrustworthy part and leave the raw rows. A
            // short part means rows LOST in conversion; count it or the WAL re-fails forever
            // while stats() shows nothing wrong.
            let _ = std::fs::remove_file(&out);
            if got < expect_rows as i64 {
                counters.corrupt_wals.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            }
            return Ok(false);
        }
        // ignore_errors lands an unparseable line as an all-NULL row (count still matches):
        // a torn line becomes a NULL row — acceptable, never silent. append() writes ts on
        // every record, so count(ts) < count(*) can only mean broken source lines.
        let with_ts = count(&format!("SELECT count(ts) FROM read_parquet({})", q(&out.to_string_lossy())))?;
        if with_ts < got {
            counters.corrupt_wals.fetch_add((got - with_ts) as u64, std::sync::atomic::Ordering::Relaxed);
        }
        std::fs::remove_file(wal).map_err(|e| e.to_string())?;
        Ok(true)
    };
    match run() {
        Ok(ok) => ok,
        Err(_) => {
            let _ = std::fs::remove_file(&out); // best effort
            false // never panic out of the seal path — the next tick retries
        }
    }
}

/// purge — delete whole day-partitions older than the retention window. Malformed directory
/// names are ignored, never deleted (the day_partitions gate): deleting an unrecognised
/// directory is how a store eats something that was not its own.
pub fn purge(root: &Path, days: f64, now_ms: f64) -> (Vec<String>, u64) {
    let mut removed = Vec::new();
    let mut freed = 0u64;
    let cutoff_ms = day_ms_of(&day_key(now_ms - days * 86_400_000.0)).unwrap_or(0);
    for stream in STATUSLINE_STREAMS {
        for (dir, day_ms) in day_partitions(root, stream) {
            if day_ms >= cutoff_ms {
                continue;
            }
            if let Ok(rd) = std::fs::read_dir(&dir) {
                for e in rd.flatten() {
                    freed += e.metadata().map(|m| m.len()).unwrap_or(0);
                }
            }
            if std::fs::remove_dir_all(&dir).is_ok() {
                removed.push(dir.strip_prefix(root).unwrap_or(&dir).to_string_lossy().into_owned());
            }
        }
    }
    (removed, freed)
}

/// queryStatusline — one read-only SELECT against a stream; `sql` references the relation as
/// `samples`. None when the window holds no data at all, which the caller MUST surface as
/// BLIND rather than "nothing happened" (burnInvestigator's coverage honesty contract).
pub fn query_statusline(
    root: &Path,
    stream: &str,
    sql: &str,
    since_ms: Option<f64>,
    until_ms: Option<f64>,
    vars: &HashMap<String, String>,
) -> Result<Option<Vec<Map<String, Value>>>, String> {
    let Some(rel) = relation_for(root, stream, since_ms, until_ms) else { return Ok(None) };
    let con = open_duck(vars)?;
    let mut wheres: Vec<String> = Vec::new();
    if let Some(since) = since_ms {
        wheres.push(format!("ts >= {}", crate::summarize::helpers::fmt_js_num(since)));
    }
    if let Some(until) = until_ms {
        wheres.push(format!("ts <= {}", crate::summarize::helpers::fmt_js_num(until)));
    }
    let scoped = if wheres.is_empty() { rel } else { format!("(SELECT * FROM {rel} WHERE {})", wheres.join(" AND ")) };
    let mut stmt = con.prepare(&format!("WITH samples AS {scoped} {sql}")).map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    let mut names: Option<Vec<String>> = None;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        // Column metadata binds once the statement executed — read it off the first row's
        // statement handle.
        let names = names.get_or_insert_with(|| row.as_ref().column_names().into_iter().map(|s| s.to_owned()).collect());
        let mut m = Map::new();
        for (i, name) in names.iter().enumerate() {
            let v: agentlens_store::duckdb::types::Value = row.get(i).map_err(|e| e.to_string())?;
            m.insert(name.clone(), duck_to_json(v)?);
        }
        out.push(m);
    }
    Ok(Some(out))
}

/// DuckDB scalar → the JSON shape the TS getRowObjects round-trip produces (BIGINT → number,
/// DOUBLE via the integral-bare shape). Non-scalar types (LIST/STRUCT — `tasks[]`) are not
/// needed by any current consumer and answer an explicit error rather than a lossy guess.
fn duck_to_json(v: agentlens_store::duckdb::types::Value) -> Result<Value, String> {
    use agentlens_store::duckdb::types::Value as D;
    Ok(match v {
        D::Null => Value::Null,
        D::Boolean(b) => Value::Bool(b),
        D::TinyInt(n) => Value::from(n),
        D::SmallInt(n) => Value::from(n),
        D::Int(n) => Value::from(n),
        D::BigInt(n) => Value::from(n),
        D::HugeInt(n) => num(n as f64),
        D::UTinyInt(n) => Value::from(n),
        D::USmallInt(n) => Value::from(n),
        D::UInt(n) => Value::from(n),
        D::UBigInt(n) => Value::from(n),
        D::Float(n) => num(n as f64),
        D::Double(n) => num(n),
        D::Text(s) => Value::from(s),
        other => return Err(format!("unsupported duckdb value in statusline query: {other:?}")),
    })
}

//! agentlens-store — the bodies→DuckDB pipeline in Rust (TRDD-DMWOBWFH P3c), a port of
//! `src/store/{db,bodyStore,verifyInStore,ingestPass}.ts`.
//!
//! THE SHAPE IS DICTATED BY MEASUREMENT (see db.ts's header): NEVER a persistent .duckdb file —
//! DuckDB rewrites row-groups in place and a persistent db burned 300× the device writes.
//! FILELESS instance, staging tables in RAM, flushed to IMMUTABLE zstd Parquet parts written
//! once and never rewritten. The on-disk parts are the compatibility boundary: a store written
//! by either engine must read identically in the other (both are DuckDB Parquet).
//!
//! Contracts ported deliberately:
//! - part names are epoch-ms + pid + per-store seq — COPY TO silently OVERWRITES, so name
//!   collisions destroy data; the refuse-to-overwrite check stays as defence in depth.
//! - `temp_directory` is `<store>/tmp` — an over-limit query spills there (latency + disk) instead
//!   of ballooning the process past its cap and getting it killed.
//! - parquet reads use `union_by_name := true` AND staging unions use `UNION ALL BY NAME`
//!   (TRDD-219K7C1N: two schema generations otherwise silently drop or loudly break columns).
//! - GATE 1: a body must reconstruct byte-identically BEFORE anything is written; GATE 2:
//!   re-ingesting the same bytes writes nothing (ingest probes the native `known_blob` and
//!   `body_durable` tables, rebuilt from the durable parts at open; flush anti-joins against them).

pub mod api_call;
pub mod pass;
pub mod bodies_evidence;
pub mod sections;
pub mod transcript_sql;
pub mod raw_facts;
pub mod cores;

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

// Re-exported so downstream crates (agentlens-core's statusline store) share ONE duckdb build —
// a second `duckdb` dependency would compile the bundled engine twice and risk version skew.
pub use duckdb;

use duckdb::Connection;
use sections::{reassemble, sectionize, sha256_hex, Part};

pub const BLOBS_DIR: &str = "blobs";
pub const BODIES_DIR: &str = "bodies";
pub const PARTS_DIR: &str = "parts";
/// TRDD-9SYRK6SW — the per-call cache facts captured before the bodies pass deletes a body.
pub const API_CALLS_DIR: &str = "api_calls";
pub const DEFAULT_MEMORY_LIMIT: &str = "8GB";
/// Every server-resident DuckDB connection (statusline, evidence, transcript SQL, summaries, the
/// bodies pass) caps here: the process runs under a 2048 MB cap and DuckDB's allocator is invisible
/// to mimalloc but counts in phys_footprint, so the per-connection limits must sum well below it.
pub const SERVER_MEMORY_LIMIT: &str = "512MiB";

/// The bodies-store connection ceiling (owner choice, TRDD-DKBGT7MQ: one store instance is about
/// 1.5 GB). The store keeps its dedup index as DuckDB tables (`known_blob`, `body_durable`) instead
/// of Rust sets. The store holds known_blob (~181 MiB) and body_durable (~860 MiB) on the real store,
/// plus their ART indexes, which cannot spill; at 512MiB the sha probe ran out of memory (measured
/// 2026-10-22, TRDD-2HRA270Y). The server caller (agentlens-core chores.rs bodies pass) passes it to
/// open_store; SERVER_MEMORY_LIMIT stays for every other connection.
pub const STORE_MEMORY_LIMIT: &str = "1536MB";

/// The `alstore` CLI DuckDB memory ceiling (TRDD-CQ4652DQ) — the ceiling the OFFLINE bodies
/// pass runs under. It is NOT the server 512MiB: the CLI is a standalone process with no
/// 2048 MB server cap to fit under, but it is still BOUNDED. The CLI used to ask for
/// DEFAULT_MEMORY_LIMIT (8GB) with available_parallelism() threads, and a live pass grew to
/// 4.8 GB RSS on a 64 GB machine — the janitor memory-guard logged it as the largest process
/// on the box with 99 MB of free memory. 1GiB holds the store's own default per-pass budget
/// (DEFAULT_MAX_BYTES_PER_PASS = 512 MiB of raw bodies) plus the DuckDB scan overhead, and
/// cuts the ceiling by 8x. A deliberate bulk backfill raises it with
/// AGENTLENS_DUCKDB_MEMORY_LIMIT; a value DuckDB cannot use falls back to this default with
/// a message, never to 8GB and never to a panic.
pub const CLI_MEMORY_LIMIT: &str = "1GiB";
/// The CLI DuckDB thread count. Two, like the in-process server path (chores.rs, TRDD-768NEX6E):
/// available_parallelism() is what made the pass the machine-dominant IO/CPU load in the
/// measurement that card records. Bounded, and raisable with AGENTLENS_DUCKDB_THREADS.
pub const CLI_THREADS: usize = 2;
/// The env var an operator sets to raise the CLI ceiling for a deliberate bulk backfill.
pub const DUCKDB_MEMORY_LIMIT_ENV: &str = "AGENTLENS_DUCKDB_MEMORY_LIMIT";
/// The env var that overrides the CLI thread count.
pub const DUCKDB_THREADS_ENV: &str = "AGENTLENS_DUCKDB_THREADS";

/// The DuckDB sizing the CLI runs with, plus any fallback message the operator must see.
pub struct Sizing {
    /// The `memory_limit` string handed to DuckDB.
    pub memory_limit: String,
    /// The DuckDB thread count.
    pub threads: usize,
    /// One line per rejected override. Empty on a clean run.
    pub warnings: Vec<String>,
}

/// Resolve the CLI DuckDB sizing from an environment MAP.
///
/// WHY A MAP AND NOT `std::env`: cargo runs the tests of one binary as parallel THREADS in one
/// process, so a test that sets a real env var races every other test in the binary. The repo
/// precedent is `agentlens_core::chores::hook_events_retention_days`, which takes a
/// `&HashMap<String, String>` for the same reason.
///
/// A REJECTED override falls back to the bounded default and says so. It never falls back to
/// the old 8GB (the defect) and never panics: the pass must run, loudly, at a size the operator
/// can predict. An EMPTY value is an ABSENCE, not an error — the TS store treats it the same
/// way (`src/store/db.ts` memoryLimit), so setting the var to "" must not be a new failure mode.
pub fn cli_sizing(vars: &HashMap<String, String>) -> Sizing {
    let mut warnings = Vec::new();
    let memory_limit = match vars.get(DUCKDB_MEMORY_LIMIT_ENV).map(|s| s.trim()) {
        None | Some("") => CLI_MEMORY_LIMIT.to_owned(),
        Some(raw) => match memory_limit_rejection(raw) {
            None => raw.to_owned(),
            Some(why) => {
                warnings.push(format!(
                    "{DUCKDB_MEMORY_LIMIT_ENV}={raw} is not a usable DuckDB memory limit ({why}); using the default {CLI_MEMORY_LIMIT}"
                ));
                CLI_MEMORY_LIMIT.to_owned()
            }
        },
    };
    let threads = match vars.get(DUCKDB_THREADS_ENV).map(|s| s.trim()) {
        None | Some("") => CLI_THREADS,
        Some(raw) => match raw.parse::<usize>() {
            Ok(n) if (1..=64).contains(&n) => n,
            _ => {
                warnings.push(format!(
                    "{DUCKDB_THREADS_ENV}={raw} is not a thread count between 1 and 64; using the default {CLI_THREADS}"
                ));
                CLI_THREADS
            }
        },
    };
    Sizing { memory_limit, threads, warnings }
}

/// Why a `memory_limit` string cannot be handed to DuckDB, or `None` when it can.
///
/// The value is only VALIDATED here, never converted: DuckDB owns the unit semantics, so the
/// string that passes here is the string DuckDB receives. The check exists because an
/// unparseable value used to reach DuckDB as a SQL literal and fail the whole store open —
/// and because the value is interpolated into `SET memory_limit = ...` (open_store), so a
/// value carrying a quote is rejected here rather than reaching the SQL at all.
fn memory_limit_rejection(s: &str) -> Option<&'static str> {
    let trimmed = s.trim();
    if trimmed.is_empty() {
        return Some("it is empty");
    }
    let split = trimmed
        .find(|c: char| c.to_digit(10).is_none() && c != '.')
        .unwrap_or(trimmed.len());
    let (num, unit) = trimmed.split_at(split);
    if num.is_empty() {
        return Some("it does not start with a number");
    }
    let value: f64 = match num.parse() {
        Ok(v) => v,
        Err(_) => return Some("its number does not parse"),
    };
    if !value.is_finite() || value <= 0.0 {
        return Some("its value is not a positive number");
    }
    let unit = unit.trim();
    if !unit.is_empty()
        && !matches!(
            unit.to_ascii_uppercase().as_str(),
            "B" | "K" | "KB" | "M" | "MB" | "G" | "GB" | "T" | "TB" | "KIB" | "MIB" | "GIB" | "TIB"
        )
    {
        return Some("its unit is not one of B, KB, MB, GB, TB, KiB, MiB, GiB, TiB");
    }
    None
}

/// Spill directory name under a store/statusline dir.
pub const TMP_DIR: &str = "tmp";

/// Create `dir` and return the `SET temp_directory` statement for it. Past `memory_limit` DuckDB
/// spills here, so an over-limit query costs latency + disk instead of getting the process killed.
pub fn spill_sql(dir: &Path) -> std::io::Result<String> {
    fs::create_dir_all(dir)?;
    Ok(format!("SET temp_directory = '{}';", dir.to_string_lossy().replace('\'', "''")))
}
pub const TS_TOLERANCE_MS: i64 = 2000;

pub struct Store {
    pub con: Connection,
    pub dir: PathBuf,
    // WHY no dedup sets here any more: the four Rust sets this struct used to hold (every durable
    // blob sha, sha to owning part file, every body_id, every (body_id, src_name)) were the heap
    // growth of the bodies pass (~4 GB on the real store: 3.87M shas + 1.52M body keys) and a CPU
    // hot spot (SipHash inserts at open, after DuckDB had already materialized the SELECT DISTINCT).
    // Owner rule: corpus-sized state lives in DuckDB tables, the Rust heap holds none. They are now
    // `known_blob` + `part_file` (open_store) and the existing `body_durable`, probed with ONE
    // indexed query per ingested body (ingest_body_with) and anti-joined at flush.
    next_part: u64,
    // The next `part_file.id`, seeded at open from the listed file count (max id + 1) and bumped
    // only after a registration commits. WHY a Rust counter and not `coalesce(max(id)+1,0)` in SQL
    // (TRDD-2HRA270Y step 3): a long-lived store registers files from flush AND from
    // sync_new_parts, and a counter owned by the one `&mut Store` cannot hand out the same id twice.
    next_file_id: i32,
    // WHY counters (TRDD-1FWN9XBS): a full-corpus fallback in part_fetch_sql / blob_fetch_sql is the
    // cost the known_part / known_blob index exists to remove, so each one is counted here (and logged).
    // Atomic, not a plain counter, because the read functions take `&Store`.
    pub part_fetch_fallbacks: std::sync::atomic::AtomicU64,
    pub blob_fetch_fallbacks: std::sync::atomic::AtomicU64,
}

/// The four part directories, in the order open_store lists them. part_file records which of them
/// each registered file lives in (`dir`), so sync_new_parts can diff each listing on its own.
pub const PART_DIRS: [&str; 4] = [BLOBS_DIR, PARTS_DIR, BODIES_DIR, API_CALLS_DIR];

/// A READ-ONLY handle on a Store's database: a second connection (`try_clone`) to the same
/// in-memory DuckDB, for request handlers (bodies export) that must not wait on a running pass.
/// WHY a newtype (TRDD-2HRA270Y step 3, A9): it hands out only `&Store`, and every function that
/// writes (ingest_body*, flush_detailed, sync_new_parts) takes `&mut Store`, so a reader cannot
/// flush, ingest or register a file. Its inner counters are never used.
pub struct StoreReader(Store);

impl StoreReader {
    /// The store for the read functions (all_of, reconstruct_body, verify_*).
    pub fn as_store(&self) -> &Store {
        &self.0
    }
}

impl Store {
    /// A reader on this store's database. It sees the same tables, staging included, so a caller
    /// that must judge DURABLE rows only (the purge delete gate) has to use the writer instead and
    /// check staged_rows first.
    pub fn reader(&self) -> duckdb::Result<StoreReader> {
        // WHY own counters: the reader is a second handle, so its fallbacks count here, not on the writer's
        // Store (each is also logged, so the cost stays visible from either handle).
        Ok(StoreReader(Store {
            con: self.con.try_clone()?,
            dir: self.dir.clone(),
            next_part: 0,
            next_file_id: 0,
            part_fetch_fallbacks: Default::default(),
            blob_fetch_fallbacks: Default::default(),
        }))
    }
}

fn q(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// Make a literal path safe to hand to a DuckDB `read_*` function, which treats its argument as a glob.
/// WHY (TRDD-C6W0SWUT): DuckDB expands `*`, `?` and `[` in a read path as a file pattern, so a data dir
/// holding one of them read the wrong set of files (or none) while the apostrophe doubling of `q` looked
/// correct. A one-character class (`[*]`, `[?]`, `[[]`) matches the character literally. A path with a
/// backslash is left as is, the same rule as src/duckPath.ts `sqPath` (a Windows path, whose separator is a
/// backslash, would not survive the class); it is not measured here. COPY TO targets and
/// ATTACH paths are write paths, not globs: they keep plain `q`. Keep an intended glob suffix (`/*.parquet`)
/// OUT of the argument: escape the directory, then append the suffix.
pub fn glob_escape(p: &str) -> String {
    if p.contains('\\') {
        return p.to_owned();
    }
    let mut out = String::with_capacity(p.len());
    for c in p.chars() {
        match c {
            '*' | '?' | '[' => {
                out.push('[');
                out.push(c);
                out.push(']');
            }
            _ => out.push(c),
        }
    }
    out
}

/// A quoted SQL literal for a read path: `glob_escape`, then `q`.
pub fn sq_path(p: &str) -> String {
    q(&glob_escape(p))
}

fn part_files(dir: &Path, sub: &str) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = fs::read_dir(dir.join(sub))
        .map(|rd| {
            rd.flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|e| e == "parquet"))
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

/// `part_files` for the sync listing: the same `.parquet` filter and sort, but every error is returned
/// instead of an empty list. The one exception is a dir that does not exist (NotFound on open), an empty
/// listing, because its parts are gone. Each entry is read with `?`, so an entry that fails mid-listing is
/// an error and is never skipped. WHY NOT part_files: it maps every error to an empty list, and an empty
/// listing makes every registered file look removed, so the sync would delete its dedup rows.
fn part_files_strict(dir: &Path, sub: &str) -> std::io::Result<Vec<PathBuf>> {
    let rd = match fs::read_dir(dir.join(sub)) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut out = Vec::new();
    for entry in rd {
        let path = entry?.path();
        if path.extension().is_some_and(|e| e == "parquet") {
            out.push(path);
        }
    }
    out.sort();
    Ok(out)
}

/// Every Parquet part as a readable relation, or None when none exist (a bare glob over an
/// empty dir is an ERROR in DuckDB, not an empty set).
pub fn parquet_scan(dir: &Path, sub: &str) -> Option<String> {
    let files = part_files(dir, sub);
    if files.is_empty() {
        return None;
    }
    let list = files
        .iter()
        .filter_map(|p| p.to_str())
        .map(sq_path)
        .collect::<Vec<_>>()
        .join(",");
    Some(format!("read_parquet([{list}], union_by_name := true)"))
}

/// Durable parts + staging as one relation — `UNION ALL BY NAME` (see module doc).
pub fn all_of(store: &Store, table: &str) -> String {
    if table == "body" {
        // The bodies corpus lives in the native `body_durable` mirror (open-time load +
        // flush's read-back appends), so its full view never touches parquet — see open_store.
        // WHY EXCLUDE (file_id) (TRDD-2HRA270Y step 3, F4 round 2): body_durable carries the internal file_id
        // column that sync_new_parts uses to delete a vanished bodies part's rows. Readers of all_of(body) must
        // see the same columns as before that column existed, so it is excluded here.
        return "(SELECT * EXCLUDE (file_id) FROM body_durable UNION ALL BY NAME SELECT * FROM body)".to_owned();
    }
    let sub = match table {
        "blob" => BLOBS_DIR,
        "body" => BODIES_DIR,
        // Explicit, because the fallthrough is PARTS_DIR: without this arm `all_of(store,
        // "api_call")` would silently read the parts corpus and return plausible-looking rows.
        "api_call" => API_CALLS_DIR,
        _ => PARTS_DIR,
    };
    match parquet_scan(&store.dir, sub) {
        Some(scan) => format!("(SELECT * FROM {scan} UNION ALL BY NAME SELECT * FROM {table})"),
        None => format!("(SELECT * FROM {table})"),
    }
}

/// Boot-phase probe slot (TRDD-2HRA270Y): called by `open_store` with a phase name and the seconds since
/// the open began, so the host binary can log net mimalloc commit per open window. WHY a slot: this
/// crate cannot depend on agentlens-core (which owns the mimalloc counters and depends on this crate), and
/// the 7 `open_store` callers stay unchanged. Unset (tests, the alstore CLI) = `phase` is a no-op. It stays
/// as a permanent, cheap boot diagnostic (up to six calls per open; open_known_part fires only when the parts dir has files).
pub static OPEN_PHASE_PROBE: std::sync::OnceLock<fn(&str, f64)> = std::sync::OnceLock::new();

fn phase(name: &str, t_open: f64) {
    if let Some(probe) = OPEN_PHASE_PROBE.get() {
        probe(name, t_open);
    }
}

pub fn open_store(dir: &Path, memory_limit: &str, threads: usize) -> duckdb::Result<Store> {
    let open_began = std::time::Instant::now();
    for sub in [BLOBS_DIR, BODIES_DIR, PARTS_DIR, API_CALLS_DIR] {
        let _ = fs::create_dir_all(dir.join(sub));
    }
    // Spill under <store>/tmp so an over-limit query becomes latency + disk, not a process kill.
    let spill = spill_sql(&dir.join(TMP_DIR)).map_err(|e| duckdb::Error::ToSqlConversionFailure(Box::new(e)))?;
    let con = Connection::open_in_memory()?;
    con.execute_batch(&format!(
        "SET memory_limit = '{memory_limit}';
         SET threads = {threads};
         {spill}
         -- TRDD-2HRA270Y step 3 (A7): the server now keeps this store open for the life of the
         -- process, and periodic spill cleanup skips <store>/tmp while it is open, so nothing else
         -- bounds the spill files. 4GB caps them: an over-cap query fails loudly instead of
         -- filling the disk. Set here so the alstore CLI gets the same bound.
         SET max_temp_directory_size = '4GB';
         SET preserve_insertion_order = false;
         SET enable_object_cache = true;
         CREATE TABLE blob (sha VARCHAR, n INTEGER, data VARCHAR);
         CREATE TABLE body (
           body_id VARCHAR, src_name VARCHAR, kind VARCHAR, session_id VARCHAR, ts TIMESTAMP,
           model VARCHAR, raw_bytes BIGINT, body_sha256 VARCHAR
         );
         CREATE TABLE part (
           body_id VARCHAR, pos INTEGER, kind VARCHAR, lit VARCHAR,
           sha VARCHAR, path VARCHAR, idx INTEGER, n INTEGER
         );
         -- TRDD-9SYRK6SW. TWO ROW KINDS in ONE table (nullable columns for the other kind's
         -- fields), coalesced by union_by_name at read time. Types are load-bearing:
         --   session_id VARCHAR — SEALED, never left to DuckDB's per-file UUID inference (one
         --     non-UUID id then kills every view that unions two parts);
         --   ts_ms BIGINT epoch ms — the statusline store's own `ts` unit, so the join needs no
         --     epoch conversion;
         --   breakpoint_positions VARCHAR — a comma-joined list, never a STRUCT, so
         --     `union_by_name := true` stays stable as the schema grows.
         -- No cost_usd (pricing lives in agentlens-core, which depends on THIS crate) and no
         -- device_id/account_uuid (no-identities doctrine).
         CREATE TABLE api_call (
           stem VARCHAR, kind VARCHAR, ts_ms BIGINT, model VARCHAR, raw_bytes BIGINT,
           session_id VARCHAR, billing_header VARCHAR, cc_prev_req VARCHAR,
           previous_message_id VARCHAR, system_fps VARCHAR, tools_fp VARCHAR, first_user_fp VARCHAR,
           breakpoint_positions VARCHAR, tool_choice VARCHAR, thinking_config VARCHAR,
           msg_id VARCHAR, stop_reason VARCHAR, input_tokens BIGINT, output_tokens BIGINT,
           cache_read_tokens BIGINT, cache_creation_tokens BIGINT, tier_5m_tokens BIGINT,
           tier_1h_tokens BIGINT, cache_missed_input_tokens BIGINT, cache_miss_reason VARCHAR,
           service_tier VARCHAR,
           -- QSFYIHUO step 2: the serialized TurnPrefix (v:1 envelope) captured at ingest, so the
           -- cache-break timeline classifies turns with the body file deleted. Nullable: NULL rows
           -- and pre-extractor parts (union_by_name fills the column with NULL) fall back to the
           -- body scan at the read site.
           prefix_json VARCHAR,
           -- QSFYIHUO step 3: raw-text-only request facts (A1). raw_facts_v is THE fallback key:
           -- NULL (pre-step-3 rows, responses) means the three fact columns are NOT trusted and
           -- the consumer scans the body; non-NULL (1 = current extractor) means they are trusted
           -- as extracted, including legitimately-empty values (workspace empty, image_bytes 0,
           -- fp_2600 empty when the post-messages tail is at most 2600 UTF-16 units).
           -- No backfill: a NULL-version row whose body file has been settled away is permanently
           -- unservable; the burn scan serves only rows ingested from this version forward.
           raw_facts_v INTEGER, workspace VARCHAR, fp_2600 VARCHAR, image_bytes BIGINT
         );"
    ))?;
    phase("open_schema", open_began.elapsed().as_secs_f64());
    // `part_file` + `known_blob` replace the old Rust `known` set and `blob_files` map (measured
    // ~4 GB heap growth + SipHash CPU on the real store). The instance stays FILELESS
    // (open_in_memory): these tables are rebuilt from the immutable parquet parts at every open and
    // never persisted (a persistent .duckdb burned 300x the SSD writes, see the module doc). sha is
    // stored as BLOB (unhex of the hex digest): measured 181 MiB vs 420 MiB as VARCHAR for 3.87M
    // shas. Hex VARCHAR stays everywhere else, so the parquet schema is unchanged.
    con.execute_batch(
        "CREATE TABLE part_file (id INTEGER, path VARCHAR, dir VARCHAR);
         CREATE TABLE known_blob (sha BLOB, file_id INTEGER);
         -- TRDD-1FWN9XBS: one row per (body, parts file). NO unique constraint and NO index: a body CAN sit in
         -- two parts files after an out-of-band delete and re-ingest, so the measured 1:1 body-to-file ratio
         -- is a corpus fact, not an invariant the schema may rely on.
         CREATE TABLE known_part (body_id BLOB, file_id INTEGER);",
    )?;
    // ONE directory listing per part dir feeds both part_file and the scans below. Two listings
    // raced: a part landing between them was scanned but had no part_file row, and the orphan
    // check failed the open. With one list, every scanned file has a part_file row spelled exactly
    // as DuckDB reports it in `filename`, so the orphan check is a true invariant. All FOUR dirs
    // are registered (TRDD-2HRA270Y step 3): sync_new_parts diffs each listing against part_file to
    // find the parts another writer added after this open.
    let listed = |sub: &str| -> Vec<String> { part_files(dir, sub).iter().filter_map(|p| p.to_str()).map(str::to_owned).collect() };
    let blob_parts = listed(BLOBS_DIR);
    let body_parts = listed(BODIES_DIR);
    seed_blob_index(&con, 0, &blob_parts, &blob_parts)?;
    phase("open_blob_seed", open_began.elapsed().as_secs_f64());
    let mut next_file_id = blob_parts.len() as i32;
    for (sub, files) in [(PARTS_DIR, listed(PARTS_DIR)), (BODIES_DIR, body_parts.clone()), (API_CALLS_DIR, listed(API_CALLS_DIR))] {
        register_part_files(&con, next_file_id, sub, &files)?;
        if sub == PARTS_DIR {
            // WHY (TRDD-1FWN9XBS): the parts bodies are indexed here, from the SAME listing that registered the
            // files, so part_fetch_sql can scope a reconstruct from the first query. The seed reads every parts
            // file once (a DISTINCT over the raw (body, file) pairs, no NOT EXISTS: TRDD-R36S0PS9),
            // which is why it is timed and logged.
            let started = std::time::Instant::now();
            let rows = index_part_bodies(&con, &files)?;
            eprintln!("[info] known_part seeded: {rows} rows from {} parts files in {:.1}s", files.len(), started.elapsed().as_secs_f64());
            phase("open_known_part", open_began.elapsed().as_secs_f64());
        }
        next_file_id += files.len() as i32;
    }
    // `body_durable` — a native mirror of the bodies parquet corpus, loaded ONCE here and kept
    // current by flush's read-back append. It is about 860 MiB on the real store (measured), so
    // this is a memory cost, paid to let all_of("body") skip the parquet corpus on every later query
    // (a full-scan class of the 2026-08-18 17-minute pass). Cloned from the staging schema, then loaded
    // BY NAME so parts from an older schema generation fill absent columns with NULL
    // (TRDD-219K7C1N: BY NAME, never positional). It is also the body-key dedup source that
    // replaced the old Rust `body_ids` / `bodies_named` sets.
    // WHY file_id (TRDD-2HRA270Y step 3, F4): sync_new_parts removes the rows of a vanished part file by
    // id, so every body row must name the file it came from. CAST NULL keeps the staging schema.
    con.execute_batch("CREATE TABLE body_durable AS SELECT *, CAST(NULL AS INTEGER) AS file_id FROM body WHERE 1=0;")?;
    // From the SAME listing that registered the body parts above, never a second parquet_scan
    // listing (TRDD-2HRA270Y step 3, A3): a part landing between two listings would be loaded here
    // but unregistered, and sync_new_parts would then load its rows a second time.
    if !body_parts.is_empty() {
        let list = body_parts.iter().map(|p| sq_path(p)).collect::<Vec<_>>().join(",");
        // The id comes from the part_file row the listing registered (the same path invariant
        // index_blob_shas relies on). EXCLUDE drops the filename column the join needs; BY NAME keeps
        // the load tolerant of older schema generations.
        con.execute_batch(&format!(
            "INSERT INTO body_durable BY NAME
             SELECT s.* EXCLUDE (filename), pf.id AS file_id
             FROM read_parquet([{list}], union_by_name := true, filename := true) s
             LEFT JOIN part_file pf ON pf.path = s.filename;"
        ))?;
        let orphans: i64 = con.query_row("SELECT count(*) FROM body_durable WHERE file_id IS NULL", [], |r| r.get(0))?;
        if orphans > 0 {
            return Err(duckdb::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(format!(
                "{orphans} body rows could not be matched to their part file (parquet filename != listed path)"
            )))));
        }
    }
    phase("open_body_durable", open_began.elapsed().as_secs_f64());
    // ART indexes, built AFTER the bulk load (one build, not millions of incremental inserts). They
    // make the per-body probes in ingest_body_with point lookups instead of full table scans.
    con.execute_batch(
        "CREATE INDEX known_blob_sha ON known_blob (sha);
         CREATE INDEX body_durable_id ON body_durable (body_id);",
    )?;
    phase("open_index", open_began.elapsed().as_secs_f64());
    phase("open_done", open_began.elapsed().as_secs_f64());
    Ok(Store {
        con,
        dir: dir.to_path_buf(),
        next_part: 0,
        next_file_id,
        part_fetch_fallbacks: Default::default(),
        blob_fetch_fallbacks: Default::default(),
    })
}

/// `read_parquet` over exactly `files`, or None when there are none.
fn scan_of(files: &[String]) -> Option<String> {
    if files.is_empty() {
        return None;
    }
    let list = files.iter().map(|p| sq_path(p)).collect::<Vec<_>>().join(",");
    Some(format!("read_parquet([{list}], union_by_name := true)"))
}

/// Append `files` to part_file under `dir`, ids `first_id..`. Appender: open_store registers
/// thousands of files on the real store, one INSERT each would be slow.
fn register_part_files(con: &Connection, first_id: i32, dir: &str, files: &[String]) -> duckdb::Result<()> {
    if files.is_empty() {
        return Ok(());
    }
    let mut app = con.appender("part_file")?;
    for (i, p) in files.iter().enumerate() {
        app.append_row(duckdb::params![first_id + i as i32, p, dir])?;
    }
    app.flush()
}

/// Fill `part_file` from `listed` (ids from `first_id`) and `known_blob` from a `filename := true`
/// scan of `scanned`. open_store passes the SAME list twice; the two parameters exist only so a
/// unit test can drive the orphan check to its error path deterministically (a scanned file with
/// no part_file row).
fn seed_blob_index(con: &Connection, first_id: i32, listed: &[String], scanned: &[String]) -> duckdb::Result<()> {
    if listed.is_empty() && scanned.is_empty() {
        return Ok(());
    }
    register_part_files(con, first_id, BLOBS_DIR, listed)?;
    if scanned.is_empty() {
        return Ok(());
    }
    index_blob_shas(con, scanned).map(|_| ())
}

/// Insert the shas of the blob parts `scanned` (already registered in part_file) into known_blob.
/// A sha already in known_blob is skipped (anti-join): first-file-wins, the rule the open-time seed
/// always had, extended across sync_new_parts calls so a sha a second writer re-wrote keeps one
/// index row (readers tolerate two, see blob_fetch_sql, but one is the invariant we keep).
fn index_blob_shas(con: &Connection, scanned: &[String]) -> duckdb::Result<usize> {
    let list = scanned.iter().map(|p| sq_path(p)).collect::<Vec<_>>().join(",");
    // ONE INSERT ... SELECT: the rows never round-trip through Rust. min(file id) keeps the old
    // first-file-wins rule (a sha lives in one part only; ingest dedups before writing).
    // LEFT JOIN + the check below, never a bare inner join: a scanned file with no matching
    // part_file row would otherwise silently drop its shas, and every one would be re-written
    // (GATE 2 broken with no error). Fail the open loudly instead.
    // WHY execute and not execute_batch (TRDD-2HRA270Y step 3, F4): the returned row count is the
    // new-blob stat sync_new_parts reports, so it must come from this statement itself.
    let inserted = con.execute(
        &format!(
            "INSERT INTO known_blob SELECT unhex(s.sha), min(pf.id)
             FROM read_parquet([{list}], union_by_name := true, filename := true) s
             LEFT JOIN part_file pf ON pf.path = s.filename
             WHERE NOT EXISTS (SELECT 1 FROM known_blob k WHERE k.sha = unhex(s.sha))
             GROUP BY s.sha;"
        ),
        [],
    )?;
    let orphans: i64 = con.query_row("SELECT count(*) FROM known_blob WHERE file_id IS NULL", [], |r| r.get(0))?;
    if orphans > 0 {
        return Err(duckdb::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(format!(
            "{orphans} blob shas could not be matched to their part file (parquet filename != listed path)"
        )))));
    }
    Ok(inserted)
}

/// Insert the bodies of the parts files `scanned` (already registered in part_file) into known_part, one
/// row per (body, file). WHY (TRDD-1FWN9XBS): part_fetch_sql names only the files that hold a body; without
/// this index every reconstruct would read every parts file. Same LEFT JOIN and orphan check as
/// index_blob_shas, for the same reason: a file with no part_file row must fail loudly, not index NULL files.
fn index_part_bodies(con: &Connection, scanned: &[String]) -> duckdb::Result<usize> {
    // WHY the guard: read_parquet([]) is a DuckDB error, and a fresh store has no parts files at open.
    if scanned.is_empty() {
        return Ok(0);
    }
    let list = scanned.iter().map(|p| sq_path(p)).collect::<Vec<_>>().join(",");
    // WHY (TRDD-R36S0PS9): the parts corpus is ~438.8M rows for only ~1.5M distinct (body_id, file) pairs
    // (docs_dev/20261023-seed-spill-measure-report.md), so DISTINCT must run on the raw pair BEFORE the join,
    // and there is NO correlated NOT EXISTS: that anti-join ran per parts row and exhausted the 4GB spill cap
    // on the real store. Safe without it: called at open (known_part empty) and by sync_new_parts for newly
    // listed files only, each with a fresh file id in one transaction; a duplicate pair would be harmless
    // anyway, because part_fetch_sql checks coverage with count(DISTINCT) and groups owning files by path.
    let inserted = con.execute(
        &format!(
            "INSERT INTO known_part SELECT unhex(s.body_id), pf.id
             FROM (SELECT DISTINCT body_id, filename FROM read_parquet([{list}], union_by_name := true, filename := true)) s
             LEFT JOIN part_file pf ON pf.path = s.filename;"
        ),
        [],
    )?;
    let orphans: i64 = con.query_row("SELECT count(*) FROM known_part WHERE file_id IS NULL", [], |r| r.get(0))?;
    if orphans > 0 {
        return Err(duckdb::Error::ToSqlConversionFailure(Box::new(std::io::Error::other(format!(
            "{orphans} part bodies could not be matched to their part file (parquet filename != listed path)"
        )))));
    }
    Ok(inserted)
}

#[derive(Debug, Default)]
pub struct FlushResult {
    pub n: u64,
    pub part_paths: Vec<PathBuf>,
}

fn count(store: &Store, table: &str) -> duckdb::Result<u64> {
    store
        .con
        .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get::<_, i64>(0))
        .map(|n| n as u64)
}

/// Flush staging to NEW immutable Parquet parts, then clear staging (RAM — free).
///
/// Dedup is SQL here (it used to be Rust sets at ingest). ingest_body_with already probes
/// `known_blob` / `body_durable`, so these anti-joins normally drop nothing: they are the
/// correctness net that keeps GATE 2 true by construction — a staged row that is already durable,
/// or duplicated within this batch, never reaches a parquet part. Each anti-join reads one staging
/// table (batch-sized) against an indexed native table; nothing is copied into Rust.
///
/// ORDER IS LOAD-BEARING: blob, part, body, api_call, each staging table cleared right after its
/// own COPY. The part filter reads `body_durable`, which the body mirror appends to — so parts
/// must be written BEFORE bodies. If a later COPY fails, the earlier tables are already durable
/// and cleared, and a retry re-filters only what is still staged; with the opposite order a body
/// mirrored before a failed part COPY would make the retry drop that body's parts forever.
pub fn flush_detailed(store: &mut Store) -> Result<FlushResult, String> {
    // ALL FOUR staging tables, not only blob + body (TRDD-2HRA270Y step 3): a flush whose api_call
    // COPY failed leaves rows in api_call alone (blob, part, body are already durable and cleared),
    // and an early return on blob + body would then skip them on every retry. With the store open
    // for the life of the process those rows would sit in staging forever.
    if staged_rows(store).map_err(|e| e.to_string())? == 0 {
        return Ok(FlushResult::default());
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tag = part_file_name(now_ms, std::process::id(), store.next_part);
    store.next_part += 1;
    let mut part_paths = Vec::new();
    let mut n = 0u64;
    for (table, sub) in [("blob", BLOBS_DIR), ("part", PARTS_DIR), ("body", BODIES_DIR), ("api_call", API_CALLS_DIR)] {
        // The rows of this table that are genuinely NEW: not durable yet, one per key.
        let select_new = match table {
            "blob" => "SELECT sha, any_value(n) AS n, any_value(data) AS data FROM blob b
                       WHERE NOT EXISTS (SELECT 1 FROM known_blob k WHERE k.sha = unhex(b.sha))
                       GROUP BY sha",
            "part" => "SELECT * FROM part p
                       WHERE NOT EXISTS (SELECT 1 FROM body_durable d WHERE d.body_id = p.body_id)
                       QUALIFY row_number() OVER (PARTITION BY body_id, pos) = 1",
            "body" => "SELECT * FROM body b
                       WHERE NOT EXISTS (SELECT 1 FROM body_durable d
                                         WHERE d.body_id = b.body_id AND d.src_name = b.src_name)
                       QUALIFY row_number() OVER (PARTITION BY body_id, src_name ORDER BY ts) = 1",
            // api_call rows are written only alongside a new body row (append_body_row), so the
            // ingest probe already dedups them; no durable native mirror exists to anti-join with.
            _ => "SELECT * FROM api_call",
        };
        store
            .con
            .execute_batch(&format!("CREATE OR REPLACE TEMP TABLE flush_new AS {select_new};"))
            .map_err(|e| e.to_string())?;
        let c = count(store, "flush_new").map_err(|e| e.to_string())?;
        if c == 0 {
            store
                .con
                .execute_batch(&format!("DELETE FROM {table}; DROP TABLE flush_new;"))
                .map_err(|e| e.to_string())?;
            continue;
        }
        let out = store.dir.join(sub).join(&tag);
        // Defence in depth behind the unique name: COPY TO silently overwrites.
        if out.exists() {
            return Err(format!("refusing to overwrite existing part {} — part naming must be collision-free", out.display()));
        }
        let out_str = out.to_str().ok_or("non-utf8 store path")?;
        // EVERY file this flush writes is registered in part_file, in the same transaction as the
        // staging DELETE (TRDD-2HRA270Y step 3): sync_new_parts treats an unregistered file as
        // another writer's, so an unregistered own body part would be loaded into body_durable a
        // second time on the next tick. The id comes from the Store counter, never max(id)+1.
        let file_id = store.next_file_id;
        let register = format!("INSERT INTO part_file VALUES ({file_id}, {}, {}); ", q(out_str), q(sub));
        let after = match table {
            // Index the new part file's shas in SQL (the old Rust `blob_files` / `known` updates),
            // from the batch just written — never from ingest RAM.
            "blob" => format!("INSERT INTO known_blob SELECT unhex(sha), {file_id} FROM flush_new; "),
            // WHY (TRDD-1FWN9XBS): the index of a flushed parts file is written in the same transaction as its
            // part_file row, so part_fetch_sql never names a file for a body the index does not know. DISTINCT:
            // a body has one row per part position, and the index holds one row per (body, file).
            "part" => format!("INSERT INTO known_part SELECT DISTINCT unhex(body_id), {file_id} FROM flush_new; "),
            // The body table is additionally MIRRORED into the native `body_durable` by READING BACK
            // the parquet just written — the read-back is the encoding proof (the flushed part
            // parses to rows), durability stays the fsync barrier's job, and all_of("body") never
            // has to scan the parquet corpus again (the third full-scan class of the 2026-08-18
            // 17-minute pass). Mirror BEFORE the staging DELETE so a read-back failure leaves the
            // staging rows in place and fails the flush loudly.
            // WHY file_id (TRDD-2HRA270Y step 3, F4): the mirror row names the part file it came from, so
            // sync_new_parts can remove it by id if that file later vanishes.
            "body" => format!(
                "INSERT INTO body_durable BY NAME SELECT *, {file_id} AS file_id FROM read_parquet([{}], union_by_name := true); ",
                sq_path(out_str)
            ),
            _ => String::new(),
        };
        if let Err(e) = store.con.execute_batch(&format!("COPY flush_new TO {} (FORMAT PARQUET, COMPRESSION ZSTD);", q(out_str))) {
            // WHY remove a partial output (TRDD-2HRA270Y step 3): open_store and sync_new_parts
            // list every .parquet in the part dirs, and a half-written file fails read_parquet, so
            // it would fail every later open. `out` did not exist before this COPY (refused above),
            // so whatever is there now is this flush's own partial output; staging is untouched.
            let cleanup = if out.exists() {
                fs::remove_file(&out).err().map(|r| format!("; could not remove partial {}: {r}", out.display())).unwrap_or_default()
            } else {
                String::new()
            };
            return Err(format!("COPY of {table} failed: {e}{cleanup}"));
        }
        // The native-table updates that follow the COPY (part_file + known_blob, or the body
        // mirror, then the staging DELETE and the DROP) are ONE transaction. As separate autocommit
        // statements, a failure between them left the index moved while staging still held the
        // rows (or the reverse), and the retry wrote a duplicate part. The COPY stays OUTSIDE: if
        // the transaction rolls back, staging and the index are exactly as before, the retry
        // re-filters from scratch, and the part file just written is indexed by nothing — so it
        // is removed here (it is this flush's own output, regenerable from the intact staging), or
        // a reopen would load it and the retry would write the same rows a second time.
        let txn = format!("BEGIN TRANSACTION; {register}{after}DELETE FROM {table}; DROP TABLE flush_new; COMMIT;");
        if let Err(e) = store.con.execute_batch(&txn) {
            let rollback = store.con.execute_batch("ROLLBACK;").err().map(|r| format!("; ROLLBACK failed: {r}")).unwrap_or_default();
            let cleanup = fs::remove_file(&out).err().map(|r| format!("; could not remove {}: {r}", out.display())).unwrap_or_default();
            return Err(format!("flush of {table} rolled back after COPY: {e}{rollback}{cleanup}"));
        }
        store.next_file_id += 1;
        if table == "blob" {
            n = c;
        }
        part_paths.push(out);
    }
    Ok(FlushResult { n, part_paths })
}

/// The one place that builds a flush part name, so the writer and `api_call_part_epoch_ms` cannot drift.
pub fn part_file_name(now_ms: u128, pid: u32, n: u64) -> String {
    format!("part-{now_ms}-{pid}-{n}.parquet")
}

/// The flush time in epoch ms carried by a part name built by `part_file_name`; None for any other name
/// (prefix `part-`, three `-` separated unsigned integers, suffix `.parquet`).
pub fn api_call_part_epoch_ms(name: &str) -> Option<u64> {
    let fields: Vec<&str> = name.strip_prefix("part-")?.strip_suffix(".parquet")?.split('-').collect();
    if fields.len() != 3 || !fields.iter().all(|f| !f.is_empty() && f.bytes().all(|b| b.is_ascii_digit())) {
        return None;
    }
    fields[1].parse::<u32>().ok()?;
    fields[2].parse::<u64>().ok()?;
    fields[0].parse::<u64>().ok()
}

/// TRDD-OBJ4FK2T: removes the api_calls parts whose name epoch is strictly older than `retention_days`.
/// WHY by name: a part is named at flush time, so its age needs no query and no mtime (a copied or restored
/// file keeps its name). WHY a name that does not parse is never removed: the dir can hold files this
/// writer did not make. WHY non-finite, non-positive or underflowing retention removes NOTHING: a bad knob
/// must never read as "older than now" and wipe the store. A vanished part is dropped from the `part_file`
/// catalog by the next `sync_new_parts`, so no second update is needed here.
pub fn purge_api_call_parts(store_dir: &Path, retention_days: f64, now_ms: u64) -> std::io::Result<Vec<String>> {
    let mut removed = Vec::new();
    if !retention_days.is_finite() || retention_days <= 0.0 {
        return Ok(removed);
    }
    let span_ms = retention_days * 86_400_000.0;
    if !span_ms.is_finite() || span_ms >= now_ms as f64 {
        return Ok(removed);
    }
    let cutoff = now_ms - span_ms as u64;
    let dir = store_dir.join(API_CALLS_DIR);
    let entries = match fs::read_dir(&dir) {
        Ok(rd) => rd,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(removed),
        Err(e) => return Err(e),
    };
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if api_call_part_epoch_ms(&name).is_some_and(|epoch| epoch < cutoff) {
            fs::remove_file(entry.path())?;
            removed.push(name);
        }
    }
    Ok(removed)
}

/// Rows in the four staging tables (blob, part, body, api_call) — RAM not yet flushed.
pub fn staged_rows(store: &Store) -> duckdb::Result<u64> {
    let mut total = 0;
    for table in ["blob", "part", "body", "api_call"] {
        total += count(store, table)?;
    }
    Ok(total)
}

/// Empty the four staging tables. Only for leftovers whose flush failed: their sources are still
/// on disk (the pass deletes nothing whose flush failed), so dropping the RAM copy loses nothing.
pub fn clear_staging(store: &Store) -> duckdb::Result<()> {
    store.con.execute_batch("DELETE FROM blob; DELETE FROM part; DELETE FROM body; DELETE FROM api_call;")
}

/// What `flush_or_clear_leftovers` did with the staging rows a previous tick left behind.
#[derive(Debug)]
pub enum Leftovers {
    /// Staging was empty.
    None,
    /// The leftovers were flushed to parts.
    Flushed(FlushResult),
    /// The flush failed with this error and staging was emptied.
    Cleared(String),
}

/// Tick-start handling of staging rows a failed flush left in a long-lived store (TRDD-2HRA270Y
/// step 3): flush them, and if that fails, empty staging. WHY never keep them: staging must not
/// grow across ticks. The sources stay on disk and skip-named; the verify gate then finds no
/// durable row, drops their skip names, and they re-ingest on a later tick.
pub fn flush_or_clear_leftovers(store: &mut Store) -> Result<Leftovers, String> {
    if staged_rows(store).map_err(|e| e.to_string())? == 0 {
        return Ok(Leftovers::None);
    }
    match flush_detailed(store) {
        Ok(r) => Ok(Leftovers::Flushed(r)),
        Err(e) => {
            clear_staging(store).map_err(|c| format!("flush failed ({e}) and clearing staging failed: {c}"))?;
            Ok(Leftovers::Cleared(e))
        }
    }
}

/// What one `sync_new_parts` call registered and removed.
#[derive(Debug, Default)]
pub struct SyncStats {
    /// New files registered, per dir, in PART_DIRS order (blobs, parts, bodies, api_calls).
    pub new_files: [u64; 4],
    /// Files that vanished from their dir after registration, per dir in PART_DIRS order. Their
    /// part_file rows and the known_blob / body_durable rows they indexed are deleted in the same
    /// call (TRDD-2HRA270Y step 3, F4).
    pub removed_files: [u64; 4],
    /// Blob shas added to known_blob.
    pub new_blob_shas: u64,
    /// Rows added to body_durable.
    pub new_body_rows: u64,
    /// Files that could not be read, with the error. They stay unregistered and are retried on
    /// the next call (a partial file from a writer that is still writing it).
    pub skipped: Vec<(String, String)>,
}

impl SyncStats {
    /// All new files registered, every dir.
    pub fn total_new_files(&self) -> u64 {
        self.new_files.iter().sum()
    }
}

/// Register the parts another writer added since open (or since the last call), remove the parts
/// that vanished, and load their dedup facts: blob shas into known_blob, body rows into body_durable.
/// parts/ and api_calls/ files are registered only (reads list those dirs directly through all_of).
///
/// WHY (TRDD-2HRA270Y step 3): the server now keeps ONE store open for the life of the process, and
/// its dedup tables are built at open. Without this, a part written by `alstore pass` between two
/// ticks stays invisible to ingest probes forever and the next ingest writes its blobs again.
/// Flush registers its own files, so a call right after a flush finds nothing.
///
/// WHY both anti-joins run in DuckDB (F4, owner rule: corpus state lives in tables, not Rust sets):
/// the listing of each dir is loaded into the TEMP table sync_listing, and only the small result of
/// the new-file anti-join is collected into a Vec. Removals run before registrations, so a sha that
/// a rewritten file indexes again is not deleted by the removal of its old file.
///
/// ONE TRANSACTION PER NEW FILE: a file that fails to read (half-written by a writer still running) is
/// rolled back, left unregistered, reported in `skipped`, and retried next call. A file is never
/// registered without its facts loaded, or the next call would skip it for good.
pub fn sync_new_parts(store: &mut Store) -> duckdb::Result<SyncStats> {
    let mut stats = SyncStats::default();
    for (slot, sub) in PART_DIRS.iter().enumerate() {
        load_sync_listing(&store.con, &store.dir, sub)?;
        stats.removed_files[slot] = remove_vanished_files(&store.con, sub)?;
        let new_files: Vec<String> = {
            let mut stmt = store.con.prepare(
                "SELECT l.path FROM sync_listing l
                 WHERE NOT EXISTS (SELECT 1 FROM part_file p WHERE p.dir = ? AND p.path = l.path)
                 ORDER BY l.path",
            )?;
            let rows = stmt.query_map([sub], |r| r.get::<_, String>(0))?;
            rows.collect::<Result<_, _>>()?
        };
        for file in &new_files {
            let id = store.next_file_id;
            let one = [file.to_owned()];
            let scan = scan_of(&one).expect("one file");
            let loaded = (|| -> duckdb::Result<(usize, usize)> {
                store.con.execute_batch("BEGIN TRANSACTION;")?;
                store.con.execute_batch(&format!("INSERT INTO part_file VALUES ({id}, {}, {});", q(file), q(sub)))?;
                // execute returns the rows each INSERT wrote, so the stats count what was added
                // (TRDD-2HRA270Y step 3, F4) instead of a count(*) taken before and after.
                let rows = match *sub {
                    BLOBS_DIR => (index_blob_shas(&store.con, &one)?, 0),
                    BODIES_DIR => (0, store.con.execute(&format!("INSERT INTO body_durable BY NAME SELECT *, {id} AS file_id FROM {scan};"), [])?),
                    // WHY (TRDD-1FWN9XBS): the bodies of a parts file join known_part in the same transaction as its
                    // part_file row, or part_fetch_sql would fall back to a full scan for them. The INSERT reads the
                    // file, so an unreadable file still fails here, rolls back and is retried, as before.
                    PARTS_DIR => {
                        index_part_bodies(&store.con, &one)?;
                        (0, 0)
                    }
                    // Registered only, but read once, so a file that cannot be read is never
                    // registered (all_of would then fail every later query on it).
                    _ => {
                        store.con.query_row(&format!("SELECT count(*) FROM {scan}"), [], |r| r.get::<_, i64>(0))?;
                        (0, 0)
                    }
                };
                store.con.execute_batch("COMMIT;")?;
                Ok(rows)
            })();
            match loaded {
                Ok((blobs, bodies)) => {
                    store.next_file_id += 1;
                    stats.new_files[slot] += 1;
                    stats.new_blob_shas += blobs as u64;
                    stats.new_body_rows += bodies as u64;
                }
                Err(e) => {
                    // A failed statement may already have aborted the transaction; a ROLLBACK error
                    // then only says there was nothing left to roll back.
                    let _ = store.con.execute_batch("ROLLBACK;");
                    stats.skipped.push((file.to_owned(), e.to_string()));
                }
            }
        }
    }
    Ok(stats)
}

/// The listing of one part dir, loaded into the TEMP table sync_listing so both anti-joins run in
/// DuckDB (TRDD-2HRA270Y step 3, F4). An unreadable dir never deletes rows: part_files_strict returns
/// every error (ENOTDIR, EACCES, EIO, or an entry that fails mid-listing), so the removal for that dir
/// never runs. The one exception is a missing dir, an empty listing, because its files are gone and
/// their rows must go. WHY ONE OBSERVATION: the dir is listed by a single read_dir, never by a readability
/// probe followed by a second listing. Two reads can see two states: a dir that turns unreadable between
/// them would give a short second listing, and every file missing from it would lose its dedup rows.
fn load_sync_listing(con: &Connection, dir: &Path, sub: &str) -> duckdb::Result<()> {
    let files = part_files_strict(dir, sub).map_err(|e| duckdb::Error::ToSqlConversionFailure(Box::new(e)))?;
    con.execute_batch("CREATE OR REPLACE TEMP TABLE sync_listing (path VARCHAR);")?;
    let mut app = con.appender("sync_listing")?;
    for file in files.iter().filter_map(|p| p.to_str()) {
        app.append_row(duckdb::params![file])?;
    }
    app.flush()
}

/// Delete every registered file of `sub` that is no longer listed, with the known_blob and
/// body_durable rows it indexed, in one transaction. Returns the number of files removed.
/// WHY (TRDD-2HRA270Y step 3, F4): the store is no longer rebuilt per tick, so a part deleted out of
/// band would leave its shas in known_blob, and the probe would then report a blob as present that
/// no longer exists, so a body would be written with a dangling blob reference.
fn remove_vanished_files(con: &Connection, sub: &str) -> duckdb::Result<u64> {
    let gone = format!(
        "SELECT p.id FROM part_file p WHERE p.dir = {} AND NOT EXISTS (SELECT 1 FROM sync_listing l WHERE l.path = p.path)",
        q(sub)
    );
    let n: i64 = con.query_row(&format!("SELECT count(*) FROM ({gone})"), [], |r| r.get(0))?;
    if n == 0 {
        return Ok(0);
    }
    let txn = format!(
        "BEGIN TRANSACTION;
         DELETE FROM known_blob WHERE file_id IN ({gone});
         DELETE FROM body_durable WHERE file_id IN ({gone});
         -- TRDD-1FWN9XBS: a vanished parts file must also leave known_part, or part_fetch_sql would name a
         -- file that no longer exists and the reconstruct read would fail on it.
         DELETE FROM known_part WHERE file_id IN ({gone});
         DELETE FROM part_file WHERE id IN ({gone});
         COMMIT;"
    );
    if let Err(e) = con.execute_batch(&txn) {
        let _ = con.execute_batch("ROLLBACK;");
        return Err(e);
    }
    Ok(n as u64)
}

// ── bodyStore.ts ─────────────────────────────────────────────────────────────────

#[derive(Debug)]
pub struct IngestResult {
    pub body_id: String,
    pub raw_bytes: u64,
    pub new_blobs: u64,
    pub new_bytes: u64,
    pub existed: bool,
}

pub fn body_id_of(raw: &str) -> String {
    sha256_hex(raw)
}

/// extractMeta: tolerant by design — an unparseable body still stores; it just gets null metadata.
/// Takes the ALREADY-PARSED value so one file is never parsed twice (TRDD-9SYRK6SW).
fn extract_meta(parsed: Option<&serde_json::Value>, src_name: &str) -> (Option<String>, Option<String>, &'static str) {
    let kind = if src_name.contains(".response.") { "response" } else { "request" };
    let mut session_id = None;
    let mut model = None;
    if let Some(d) = parsed {
        model = d.get("model").and_then(|m| m.as_str()).map(str::to_owned);
        // The session id hides in metadata.user_id as an EMBEDDED JSON STRING.
        if let Some(uid) = d.get("metadata").and_then(|m| m.get("user_id")).and_then(|u| u.as_str()) {
            if let Ok(u) = serde_json::from_str::<serde_json::Value>(uid) {
                session_id = u.get("session_id").and_then(|s| s.as_str()).map(str::to_owned);
            }
        }
    }
    (session_id, model, kind)
}

/// The api_call row for one ingested FILE (TRDD-9SYRK6SW). Reuses the caller's parsed `Value` —
/// `raw` is never parsed a second time. `prefix_json` is the caller's (extractor-backed) serialized
/// TurnPrefix for request rows — the store cannot derive it itself (agentlens-core's extractor,
/// crate cycle) — and None leaves the column NULL, the read site's body-scan fallback signal.
/// `raw_facts` is the step-3 seam product (raw-text-only facts + version); it is stamped
/// REQUEST-only here, same write-boundary discipline as prefix_json.
#[allow(clippy::too_many_arguments)] // positional appender feed: 26 (now 30) values, one per column
fn append_api_call_row(
    store: &mut Store,
    parsed: &serde_json::Value,
    src_name: &str,
    raw_bytes: u64,
    ts_ms: i64,
    session_id: Option<&str>,
    prefix_json: Option<String>,
    raw_facts: Option<(i32, raw_facts::RawFacts)>,
) -> Result<(), String> {
    let r = api_call::extract_api_call_meta(parsed, src_name, ts_ms, raw_bytes, session_id);
    // Write-boundary guard (QSFYIHUO step 2): prefix_json is REQUEST-only. A caller that hands a
    // prefix for a response file (or a misrouted extractor) must not pollute response rows — the
    // column's NULL-on-response is part of the read contracts.
    let prefix_json = if r.kind == "request" { prefix_json } else { None };
    // Same boundary for the step-3 trio + version (A1): responses carry NULL on all four.
    let (rfv, workspace, fp_2600, image_bytes) = match r.kind {
        "request" => match raw_facts {
            Some((v, f)) => (Some(v), Some(f.workspace), Some(f.fp_2600), Some(f.image_bytes as i64)),
            None => (None, None, None, None),
        },
        _ => (None, None, None, None),
    };
    let mut app = store.con.appender("api_call").map_err(|e| e.to_string())?;
    app.append_row(duckdb::params![
        r.stem,
        r.kind,
        r.ts_ms,
        r.model,
        r.raw_bytes,
        r.session_id,
        r.billing_header,
        r.cc_prev_req,
        r.previous_message_id,
        r.system_fps,
        r.tools_fp,
        r.first_user_fp,
        r.breakpoint_positions,
        r.tool_choice,
        r.thinking_config,
        r.msg_id,
        r.stop_reason,
        r.input_tokens,
        r.output_tokens,
        r.cache_read_tokens,
        r.cache_creation_tokens,
        r.tier_5m_tokens,
        r.tier_1h_tokens,
        r.cache_missed_input_tokens,
        r.cache_miss_reason,
        r.service_tier,
        prefix_json,
        rfv,
        workspace,
        fp_2600,
        image_bytes,
    ])
    .map_err(|e| e.to_string())?;
    app.flush().map_err(|e| e.to_string())
}

#[allow(clippy::too_many_arguments)] // same positional feed, threaded through to the api_call row
fn append_body_row(
    store: &mut Store,
    body_id: &str,
    src_name: &str,
    raw: &str,
    raw_bytes: u64,
    ts_ms: i64,
    prefix_json: Option<String>,
    raw_facts: Option<(i32, raw_facts::RawFacts)>,
) -> Result<(), String> {
    // ONE parse per file, shared by both extractors — never a second `serde_json::from_str` over
    // `raw` (TRDD-9SYRK6SW acceptance). The nested parse inside `extract_meta` is a DIFFERENT
    // string (the embedded `metadata.user_id` JSON), not a re-parse of the body.
    let parsed = serde_json::from_str::<serde_json::Value>(raw).ok();
    let (session_id, model, kind) = extract_meta(parsed.as_ref(), src_name);
    // Written HERE, not at `ingest_body`'s two call sites, so the content-dedup path is covered
    // by construction and a future third caller cannot forget it — and written BEFORE the body
    // INSERT below: if it failed AFTER it, the staged body row would claim the file (the ingest
    // probe reads staging), the next ingest would short-circuit as `existed`, and the delete gate
    // would never see a complete body. Failing first leaves the store un-ingested and the retry is clean.
    // A body that is not JSON gets no api_call row (its bytes stay reconstructible from the
    // store, so the facts are re-derivable); the `body` row still lands, as it always has.
    if let Some(p) = parsed.as_ref() {
        append_api_call_row(store, p, src_name, raw_bytes, ts_ms, session_id.as_deref(), prefix_json, raw_facts)?;
    }
    let sql = format!(
        "INSERT INTO body VALUES ({}, {}, {}, {}, make_timestamp({}), {}, {}, {})",
        q(body_id),
        q(src_name),
        q(kind),
        session_id.as_deref().map(q).unwrap_or("NULL".into()),
        (ts_ms as i128) * 1000, // ms → µs
        model.as_deref().map(q).unwrap_or("NULL".into()),
        raw_bytes,
        q(body_id),
    );
    store.con.execute_batch(&sql).map_err(|e| e.to_string())?;
    // No Rust-side bookkeeping: this staged row IS the existence record. ingest_body_with probes
    // the staging `body` table together with `body_durable`, so the row and its dedup entry
    // cannot drift apart.
    Ok(())
}

/// ingestBody: idempotent, and GATE 1 — refuses anything that does not reconstruct
/// byte-identically BEFORE a single row is written.
pub fn ingest_body(store: &mut Store, src_name: &str, raw: &str, ts_ms: i64) -> Result<IngestResult, String> {
    ingest_body_with(store, src_name, raw, ts_ms, None, None)
}

/// `ingest_body` plus the QSFYIHUO step-2 prefix capture: `prefix_json` (the caller-injected
/// extractor's serialized TurnPrefix for a REQUEST row, v:1 envelope) is persisted on the api_call
/// row. Both ingest paths — content-dedup and fresh — carry it, so a re-emitted body also keeps its
/// prefix. `None` writes NULL (alstore CLI, tests, pre-extractor callers), the read site's
/// fallback signal.
pub fn ingest_body_with(
    store: &mut Store,
    src_name: &str,
    raw: &str,
    ts_ms: i64,
    prefix_json: Option<String>,
    raw_facts: Option<(i32, raw_facts::RawFacts)>,
) -> Result<IngestResult, String> {
    let body_id = body_id_of(raw);
    let raw_bytes = raw.len() as u64;

    // ONE probe per body for its keys (replaces the Rust `body_ids` / `bodies_named` sets, part of
    // the measured ~4 GB heap). Indexed point lookup on body_durable plus the batch-sized staging
    // table. This is NOT the 2026-08-18 runaway class: that was all_of("body") re-binding thousands
    // of parquet files per probe; this never touches parquet.
    let (existed, named) = body_probe(store, &body_id, src_name)?;
    if existed {
        // Content dedup — but each capture event still gets its own (src_name, ts) body row.
        if !named {
            append_body_row(store, &body_id, src_name, raw, raw_bytes, ts_ms, prefix_json, raw_facts)?;
        }
        return Ok(IngestResult { body_id, raw_bytes, new_blobs: 0, new_bytes: 0, existed: true });
    }

    let sec = sectionize(raw)?;
    // GATE 1 — prove reconstruction BEFORE anything is written.
    let rebuilt = reassemble(&sec.parts, |sha| sec.blobs.get(sha).cloned())?;
    if sha256_hex(&rebuilt) != sha256_hex(raw) {
        return Err(format!("refusing to store {src_name}: it does not reconstruct byte-identically"));
    }

    // ONE probe for ALL of this body's span shas (replaces the Rust `known` set): known_blob via its
    // ART index plus the staging blob table. Never one query per span. `seen` dedups within this
    // body only, so it is body-sized, not corpus-sized.
    let present = shas_present(store, &sec.blob_order)?;
    let mut seen: HashSet<&str> = HashSet::new();
    let mut new_blobs = 0u64;
    let mut new_bytes = 0u64;
    {
        let mut app = store.con.appender("blob").map_err(|e| e.to_string())?;
        for sha in &sec.blob_order {
            if present.contains(sha) || !seen.insert(sha.as_str()) {
                continue;
            }
            let span = &sec.blobs[sha];
            app.append_row(duckdb::params![sha, span.len() as i32, span]).map_err(|e| e.to_string())?;
            new_blobs += 1;
            new_bytes += span.len() as u64;
        }
        app.flush().map_err(|e| e.to_string())?;
    }

    append_body_row(store, &body_id, src_name, raw, raw_bytes, ts_ms, prefix_json, raw_facts)?;

    {
        let mut app = store.con.appender("part").map_err(|e| e.to_string())?;
        for (pos, part) in sec.parts.iter().enumerate() {
            match part {
                Part::Lit { text } => app
                    .append_row(duckdb::params![
                        &body_id,
                        pos as i32,
                        "lit",
                        text,
                        None::<String>,
                        None::<String>,
                        None::<i32>,
                        None::<i32>
                    ])
                    .map_err(|e| e.to_string())?,
                Part::Blob { sha, n, path, idx } => app
                    .append_row(duckdb::params![
                        &body_id,
                        pos as i32,
                        "blob",
                        None::<String>,
                        sha,
                        path,
                        *idx as i32,
                        *n as i32
                    ])
                    .map_err(|e| e.to_string())?,
            }
        }
        app.flush().map_err(|e| e.to_string())?;
    }

    Ok(IngestResult { body_id, raw_bytes, new_blobs, new_bytes, existed: false })
}

/// Whether `body_id` has any row (durable or staged), and whether it has one under `src_name`.
/// One query: an ART point lookup on `body_durable(body_id)` UNION ALL a scan of the staging
/// `body` table (batch-sized, RAM).
fn body_probe(store: &Store, body_id: &str, src_name: &str) -> Result<(bool, bool), String> {
    let sql = format!(
        "SELECT count(*), coalesce(bool_or(src_name = {n}), false) FROM (
           SELECT src_name FROM body_durable WHERE body_id = {id}
           UNION ALL SELECT src_name FROM body WHERE body_id = {id})",
        id = q(body_id),
        n = q(src_name)
    );
    store
        .con
        .query_row(&sql, [], |r| Ok((r.get::<_, i64>(0)? > 0, r.get::<_, bool>(1)?)))
        .map_err(|e| e.to_string())
}

/// The subset of `shas` already stored (durable in `known_blob`, or staged in `blob`), as hex.
/// One query for the whole list: `known_blob` compares in BLOB form (unhex) so its ART index
/// serves the IN list; staging keeps hex VARCHAR like the parquet schema.
fn shas_present(store: &Store, shas: &[String]) -> Result<HashSet<String>, String> {
    if shas.is_empty() {
        return Ok(HashSet::new());
    }
    let sql = sha_probe_sql(shas);
    let mut stmt = store.con.prepare(&sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
    rows.collect::<Result<HashSet<String>, _>>().map_err(|e| e.to_string())
}

/// The single statement shas_present runs (public only so the real-store measurement test can
/// EXPLAIN ANALYZE exactly this SQL): known_blob compared in BLOB form so its ART index serves the
/// IN list, UNION the staging blob table (hex VARCHAR, batch-sized). `shas` must be non-empty.
/// ONE IN list, not chunked: measured on the real store with EXPLAIN ANALYZE, a 3,546-sha list
/// (the largest body) still executes as an Index Scan (188 ms) and splitting it into 200-sha
/// branches was slower (281 ms). A plain EXPLAIN prints "Sequential Scan" for these lists because
/// DuckDB picks the index scan at execution time — do not judge this from EXPLAIN alone.
#[doc(hidden)]
pub fn sha_probe_sql(shas: &[String]) -> String {
    let hex = shas.iter().map(|s| q(s)).collect::<Vec<_>>().join(",");
    let bin = shas.iter().map(|s| format!("unhex({})", q(s))).collect::<Vec<_>>().join(",");
    format!("SELECT lower(hex(sha)) AS sha FROM known_blob WHERE sha IN ({bin}) UNION SELECT sha FROM blob WHERE sha IN ({hex})")
}

/// reconstructBody: reads ONLY this body's parts + their blobs, through known_part/known_blob (falling back
/// to a full scan when an id is unindexed); the sha256 gate is end-to-end
/// (body_id IS the hash of the original bytes).
pub fn reconstruct_body(store: &Store, body_id: &str) -> Result<String, String> {
    // WHY (TRDD-1FWN9XBS): part_fetch_sql reads only the parts files that own this body, not every
    // parts file. The ORDER BY is appended to its bare SELECT, which carries none.
    let sql = format!("{} ORDER BY pos", part_fetch_sql(store, &[body_id], "pos, kind, lit, sha")?);
    let mut stmt = store.con.prepare(&sql).map_err(|e| e.to_string())?;
    let rows: Vec<(String, Option<String>, Option<String>)> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?)))
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();
    if rows.is_empty() {
        return Err(format!("unknown body {body_id}"));
    }
    let shas: Vec<String> = {
        let mut seen = HashSet::new();
        rows.iter().filter_map(|(_, _, sha)| sha.clone()).filter(|s| seen.insert(s.clone())).collect()
    };
    let mut spans = std::collections::HashMap::new();
    if !shas.is_empty() {
        // WHY (TRDD-1FWN9XBS): blob_fetch_sql scopes this read to the parts files that own the shas.
        let sql = blob_fetch_sql(store, &shas)?;
        let mut stmt = store.con.prepare(&sql).map_err(|e| e.to_string())?;
        let got = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        for g in got.flatten() {
            spans.insert(g.0, g.1);
        }
    }
    let parts: Vec<Part> = rows
        .into_iter()
        .map(|(kind, lit, sha)| {
            if kind == "lit" {
                Part::Lit { text: lit.unwrap_or_default() }
            } else {
                Part::Blob { sha: sha.unwrap_or_default(), n: 0, path: String::new(), idx: -1 }
            }
        })
        .collect();
    let raw = reassemble(&parts, |sha| spans.get(sha).cloned())?;
    if sha256_hex(&raw) != body_id {
        return Err(format!("RECONSTRUCTION MISMATCH for {body_id} — the store cannot return what it was given"));
    }
    Ok(raw)
}

/// Bulk reconstruction for the verify gate: ONE part query + ONE blob query per chunk. WHY:
/// every all_of query re-binds the full parquet file LIST (~seconds each at 4,215 parts), so
/// the per-body form cost 2 queries × N bodies — the verify half of the 2026-08-18 pass
/// runaway (TRDD-DMWOBWFH P4b). Same rows, same reassembly, same per-body sha gate as
/// reconstruct_body; only the fetch is batched.
/// Pass-scoped sha→span cache for the verify gate. Intrinsically bounded: distinct spans are
/// substrings of the bodies being verified, so the cache never exceeds the pass throttle's
/// bytes (512MB default, typically far less — the cross-turn overlap is the point).
pub type SpanCache = std::collections::HashMap<String, String>;

/// Builds the SQL for the verify gate's blob fetch, scoped to just the parquet part files that
/// own the requested shas (`known_blob JOIN part_file`, which replaced the Rust `blob_files` map —
/// measured heap, see Store) instead of the whole blob corpus. The bytes still come from the same
/// durable parquet file(s) on disk — only the file SET shrinks — so the delete-gate proof (a
/// verify reads DURABLE bytes, never ingest RAM) is unchanged.
///
/// Falls back to the full `all_of("blob")` scan when ANY requested sha is missing from the
/// index (e.g. it is still sitting in RAM staging, not yet flushed to a part file). Never
/// silently drops a sha from the query — the delete gate must still be a real read of every
/// requested sha, so an unindexed sha widens the whole query rather than being skipped.
pub(crate) fn blob_fetch_sql(store: &Store, shas: &[String]) -> Result<String, String> {
    let list = shas.iter().map(|s| q(s)).collect::<Vec<_>>().join(",");
    let full = format!("SELECT sha, data FROM {} WHERE sha IN ({list})", all_of(store, "blob"));
    let distinct: HashSet<&str> = shas.iter().map(String::as_str).collect();
    if distinct.is_empty() {
        return Ok(full);
    }
    let bin = distinct.iter().map(|s| format!("unhex({})", q(s))).collect::<Vec<_>>().join(",");
    // WHY matched is ONE count over the whole request, not a sum of per-file counts: a sha indexed
    // under two part files appears in two file groups, so a per-group sum counts it twice. That sum
    // can reach distinct.len() while another requested sha is unindexed, and then the full-corpus
    // fallback below would be skipped. count(DISTINCT) over the request counts each indexed sha once.
    // One IN list on the BLOB key: executes as an ART index scan (see sha_probe_sql).
    let matched_sql = format!(
        "SELECT count(DISTINCT k.sha) FROM known_blob k JOIN part_file pf ON pf.id = k.file_id
         WHERE k.sha IN ({bin})"
    );
    let matched: i64 = store.con.query_row(&matched_sql, [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if matched < distinct.len() as i64 {
        // WHY counted and logged (TRDD-1FWN9XBS): a full-corpus read on the verify gate is the cost this
        // index exists to remove, so every fallback must be visible rather than silent.
        store.blob_fetch_fallbacks.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        eprintln!("[info] blob_fetch_sql: {} of {} shas are not indexed, reading the full blob corpus", distinct.len() as i64 - matched, distinct.len());
        return Ok(full);
    }
    // The owning part files of the requested shas, one row per file.
    let sql = format!(
        "SELECT pf.path FROM known_blob k JOIN part_file pf ON pf.id = k.file_id
         WHERE k.sha IN ({bin}) GROUP BY pf.path ORDER BY pf.path"
    );
    let mut stmt = store.con.prepare(&sql).map_err(|e| e.to_string())?;
    let files = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| e.to_string())?;
    let file_list = files.iter().map(|f| sq_path(f)).collect::<Vec<_>>().join(",");
    Ok(format!("SELECT sha, data FROM read_parquet([{file_list}], union_by_name := true) WHERE sha IN ({list})"))
}

/// The SQL for the reconstruct gate's part fetch, scoped to the parts files that own the requested
/// bodies (`known_part JOIN part_file`) instead of every parts file (`all_of("part")`, 10,048 files on
/// the real store). `cols` is the projection; the caller appends its own ORDER BY, because the SQL
/// returned here carries none.
///
/// WHY the scoped read is complete (TRDD-1FWN9XBS): ALL parts rows of one body are written by ONE flush into
/// ONE parts file. Ingest stages a whole body in one call (ingest_body_with appends every part row of the body
/// in one appender batch), and flush writes every staged row of the table to one file, indexing that file in
/// the same transaction. So the owning-files lookup names every file that holds a body's rows. A body whose rows
/// sit in a file the index does not name would be read short, and the sha gate refuses the short bytes. The
/// same gate refuses a copy of a body's rows in two indexed files, which is read twice (TRDD-23TSWT9M).
///
/// Falls back to the full `all_of("part")` scan when ANY requested body is missing from the index
/// (e.g. its parts are still in RAM staging). WHY ANY and not per body: a missing body widens the whole
/// query instead of being dropped, so no requested body is ever reconstructed from a partial read.
#[doc(hidden)]
pub fn part_fetch_sql(store: &Store, body_ids: &[&str], cols: &str) -> Result<String, String> {
    let list = body_ids.iter().map(|s| q(s)).collect::<Vec<_>>().join(",");
    let full = format!("SELECT {cols} FROM {} WHERE body_id IN ({list})", all_of(store, "part"));
    let distinct: HashSet<&str> = body_ids.iter().copied().collect();
    if distinct.is_empty() {
        return Ok(full);
    }
    let bin = distinct.iter().map(|s| format!("unhex({})", q(s))).collect::<Vec<_>>().join(",");
    // WHY matched is ONE count over the whole request, not a sum of per-file counts: a body indexed under
    // two part files appears in two file groups, so a per-group sum counts it twice and can reach the
    // request size while another requested body is unindexed (the same trap blob_fetch_sql guards).
    let matched_sql = format!(
        "SELECT count(DISTINCT k.body_id) FROM known_part k JOIN part_file pf ON pf.id = k.file_id
         WHERE k.body_id IN ({bin})"
    );
    let matched: i64 = store.con.query_row(&matched_sql, [], |r| r.get(0)).map_err(|e| e.to_string())?;
    if matched < distinct.len() as i64 {
        // WHY counted and logged (TRDD-1FWN9XBS): the same visibility rule as blob_fetch_sql.
        store.part_fetch_fallbacks.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        eprintln!("[info] part_fetch_sql: {} of {} bodies are not indexed, reading the full parts corpus", distinct.len() as i64 - matched, distinct.len());
        return Ok(full);
    }
    // The owning part files of the requested bodies, one row per file.
    let sql = format!(
        "SELECT pf.path FROM known_part k JOIN part_file pf ON pf.id = k.file_id
         WHERE k.body_id IN ({bin}) GROUP BY pf.path ORDER BY pf.path"
    );
    let mut stmt = store.con.prepare(&sql).map_err(|e| e.to_string())?;
    let files = stmt
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?
        .collect::<Result<Vec<String>, _>>()
        .map_err(|e| e.to_string())?;
    let file_list = files.iter().map(|f| sq_path(f)).collect::<Vec<_>>().join(",");
    Ok(format!("SELECT {cols} FROM read_parquet([{file_list}], union_by_name := true) WHERE body_id IN ({list})"))
}

fn reconstruct_chunk(
    store: &Store,
    ids: &[&String],
    span_cache: &mut SpanCache,
) -> Result<std::collections::HashMap<String, Result<String, String>>, String> {
    // WHY (TRDD-1FWN9XBS): part_fetch_sql returns a bare SELECT, so the ORDER BY the reassembly needs is
    // appended to its text here, unchanged in effect from the old inline `ORDER BY body_id, pos`.
    let body_ids: Vec<&str> = ids.iter().map(|s| s.as_str()).collect();
    let sql = format!("{} ORDER BY body_id, pos", part_fetch_sql(store, &body_ids, "body_id, kind, lit, sha")?);
    let mut stmt = store.con.prepare(&sql).map_err(|e| e.to_string())?;
    let rows: Vec<(String, String, Option<String>, Option<String>)> = stmt
        .query_map([], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, Option<String>>(3)?))
        })
        .map_err(|e| e.to_string())?
        .flatten()
        .collect();
    // Fetch ONLY cache-miss shas, and SKIP the blob query outright when there are none. The blob
    // query is the pass's dominant cost: `WHERE sha IN (…)` gets no zone-map pruning (parts are
    // insertion-ordered, so every row group's sha range spans everything) and therefore
    // decompresses the ENTIRE blob corpus per query. Consecutive turns dedup against each other,
    // so without the cache each chunk re-paid that full scan for mostly the SAME spans — the
    // second half of the 2026-08-18 17-minute pass. The cache is filled ONLY from store query
    // results (never from ingest RAM), so the delete gate's proof stands: every sha used in a
    // verify was returned by the DURABLE store at least once this pass, and parts are immutable.
    let shas: Vec<String> = {
        let mut seen = HashSet::new();
        rows.iter()
            .filter_map(|(_, _, _, sha)| sha.clone())
            .filter(|s| !span_cache.contains_key(s))
            .filter(|s| seen.insert(s.clone()))
            .collect()
    };
    if !shas.is_empty() {
        let sql = blob_fetch_sql(store, &shas)?;
        let mut stmt = store.con.prepare(&sql).map_err(|e| e.to_string())?;
        let got = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
            .map_err(|e| e.to_string())?;
        for g in got.flatten() {
            span_cache.insert(g.0, g.1);
        }
    }
    let spans = &*span_cache;
    let mut out = std::collections::HashMap::new();
    for id in ids {
        let parts: Vec<Part> = rows
            .iter()
            .filter(|(b, _, _, _)| b == *id)
            .map(|(_, kind, lit, sha)| {
                if kind == "lit" {
                    Part::Lit { text: lit.clone().unwrap_or_default() }
                } else {
                    Part::Blob { sha: sha.clone().unwrap_or_default(), n: 0, path: String::new(), idx: -1 }
                }
            })
            .collect();
        if parts.is_empty() {
            out.insert((*id).clone(), Err(format!("unknown body {id}")));
            continue;
        }
        let r = reassemble(&parts, |sha| spans.get(sha).cloned()).and_then(|raw| {
            if sha256_hex(&raw) != **id {
                Err(format!("RECONSTRUCTION MISMATCH for {id} — the store cannot return what it was given"))
            } else {
                Ok(raw)
            }
        });
        out.insert((*id).clone(), r);
    }
    Ok(out)
}

// ── verifyInStore.ts (the bulk delete gate) ───────────────────────────────────────

#[derive(Debug)]
pub struct VerifyResult {
    pub ok: bool,
    pub reason: Option<String>,
}

/// True when a failed verdict's reason is the ts-only failure: `stored ts != capture time`. Why that text
/// PROVES bytes and row: `verify_bodies_in_store_cached` runs the sha256-reconstruction check and the
/// row-existence check (keyed on body_id AND src_name) strictly BEFORE the ts check, each with its own
/// `continue` on failure. So this reason can only be produced when the store reproduces the file bit-exact
/// AND already holds a row for the same src_name, i.e. a re-emission of that name at a fresh mtime
/// (TRDD-6SPXOV0P option A, TRDD-7NHUU6GK). Keep the text here in lockstep with that format string.
pub fn is_ts_only_failure(reason: &str) -> bool {
    // Anchored on the TAIL, not a substring: every other reason embeds the lump name, which comes from the archive's
    // own .idx, and every other reason ends in fixed text, so only the real format ends in `stored ts <int> != capture time <int>`.
    let Some((head, want)) = reason.rsplit_once(" != capture time ") else { return false };
    let Some((_, stored)) = head.rsplit_once(" stored ts ") else { return false };
    want.parse::<i64>().is_ok() && stored.parse::<i64>().is_ok()
}

pub struct VerifyItem {
    pub src_name: String,
    pub raw: String,
    pub ts_ms: Option<i64>,
}

/// The BORROWING form of `VerifyItem`. A caller that already holds the body content must NOT
/// have to clone it to run the gate: the pass holds a whole settle group's content in Rust
/// heap, and cloning it for the gate doubled that peak (the clone is what the pass memory
/// blew up on). This struct carries the same three fields as references, so the gate
/// behaviour is byte-identical — only the ownership differs.
pub struct VerifyItemRef<'a> {
    pub src_name: &'a str,
    pub raw: &'a str,
    pub ts_ms: Option<i64>,
}

/// The batched delete gate: bytes + row + ts for a whole batch in a handful of round trips.
pub fn verify_bodies_in_store(store: &Store, items: &[VerifyItem]) -> Result<std::collections::HashMap<String, VerifyResult>, String> {
    verify_bodies_in_store_cached(store, items, &mut SpanCache::new())
}

/// Same gate with a CALLER-scoped span cache — the pass threads one cache across all its settle
/// chunks so the full-blob-corpus scan runs once per novel span set, not once per chunk (the
/// reconstruct_chunk doc has the measured WHY). One-shot callers use verify_bodies_in_store.
pub fn verify_bodies_in_store_cached(
    store: &Store,
    items: &[VerifyItem],
    span_cache: &mut SpanCache,
) -> Result<std::collections::HashMap<String, VerifyResult>, String> {
    // Borrow, never clone: the owned items already hold the content, so the refs cost nothing.
    let refs: Vec<VerifyItemRef<'_>> = items
        .iter()
        .map(|it| VerifyItemRef { src_name: it.src_name.as_str(), raw: it.raw.as_str(), ts_ms: it.ts_ms })
        .collect();
    verify_bodies_in_store_cached_ref(store, &refs, span_cache)
}

/// The gate BORROWING implementation — the ONE copy of the logic, so the owned and the borrowed
/// entry points can never disagree about a delete decision. Same proof, same order, same
/// outcomes as the gate has always had: reconstruct-from-the-store first, then the
/// (src_name, ts) row, and only a fully-ok result lets the caller delete a source file.
pub fn verify_bodies_in_store_cached_ref(
    store: &Store,
    items: &[VerifyItemRef<'_>],
    span_cache: &mut SpanCache,
) -> Result<std::collections::HashMap<String, VerifyResult>, String> {
    let mut results = std::collections::HashMap::new();
    if items.is_empty() {
        return Ok(results);
    }
    let with_ids: Vec<(&VerifyItemRef<'_>, String)> = items.iter().map(|it| (it, body_id_of(it.raw))).collect();

    // ROW+TS — one VALUES-join query for the whole batch.
    let values = with_ids
        .iter()
        .map(|(it, id)| format!("({}, {})", q(id), q(it.src_name)))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "WITH keys(body_id, src_name) AS (VALUES {values})
         SELECT b.body_id, b.src_name, CAST(epoch_ms(b.ts) AS BIGINT)
         FROM {} b JOIN keys k ON b.body_id = k.body_id AND b.src_name = k.src_name",
        all_of(store, "body")
    );
    let mut row_map = std::collections::HashMap::new();
    {
        let mut stmt = store.con.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))
            .map_err(|e| e.to_string())?;
        for r in rows.flatten() {
            row_map.insert(format!("{} {}", r.0, r.1), r.2);
        }
    }

    // ONE part query + at most ONE blob query for the WHOLE call (reconstruct_chunk doc has the
    // measured WHY — each of those queries decompresses entire parquet corpora, so their count,
    // not their row volume, is the pass's cost). The caller bounds memory by bounding the bytes
    // it passes per call; dedupe ids — one body_id can appear under several src_names.
    let ids: Vec<&String> = {
        let mut seen = HashSet::new();
        with_ids.iter().filter(|(_, id)| seen.insert(id.as_str())).map(|(_, id)| id).collect()
    };
    let rebuilt = reconstruct_chunk(store, &ids, span_cache)?;
    {
        let chunk = &with_ids;
        for (it, body_id) in chunk.iter() {
            match rebuilt.get(body_id).expect("reconstruct_chunk answers every id it was given") {
                Err(e) => {
                    results.insert(it.src_name.to_string(), VerifyResult { ok: false, reason: Some(format!("{}: {e}", it.src_name)) });
                    continue;
                }
                Ok(back) => {
                    if sha256_hex(back) != sha256_hex(it.raw) {
                        results.insert(
                            it.src_name.to_string(),
                            VerifyResult { ok: false, reason: Some(format!("{}: reconstruction != source bytes", it.src_name)) },
                        );
                        continue;
                    }
                }
            }
            let Some(&ts_ms) = row_map.get(&format!("{} {}", body_id, it.src_name)) else {
                results.insert(
                    it.src_name.to_string(),
                    VerifyResult {
                        ok: false,
                        reason: Some(format!("{}: no body row for this src_name (content may exist under another name)", it.src_name)),
                    },
                );
                continue;
            };
            if let Some(want) = it.ts_ms {
                if (ts_ms - want).abs() > TS_TOLERANCE_MS {
                    results.insert(
                        it.src_name.to_string(),
                        VerifyResult { ok: false, reason: Some(format!("{}: stored ts {ts_ms} != capture time {want}", it.src_name)) },
                    );
                    continue;
                }
            }
            results.insert(it.src_name.to_string(), VerifyResult { ok: true, reason: None });
        }
    }
    Ok(results)
}


#[cfg(test)]
mod blob_fetch_sql_tests {
    use super::*;

    fn tmp_store(tag: &str) -> Store {
        let dir = std::env::temp_dir().join(format!("al-store-blobsql-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        open_store(&dir, "256MB", crate::cores::duckdb_threads()).expect("open")
    }

    /// A fake hex sha (64 chars of one digit) — the index stores unhex(sha), so it must be hex.
    fn sha(digit: &str) -> String {
        digit.repeat(64)
    }

    /// Seeds the SQL index the way open_store / flush do: part_file rows + known_blob rows.
    fn index(store: &Store, files: &[(i32, &str)], shas: &[(String, i32)]) {
        for (id, path) in files {
            store.con.execute_batch(&format!("INSERT INTO part_file VALUES ({id}, {}, 'blobs');", q(path))).expect("part_file");
        }
        for (s, id) in shas {
            store.con.execute_batch(&format!("INSERT INTO known_blob VALUES (unhex({}), {id});", q(s))).expect("known_blob");
        }
    }

    /// TRDD-768NEX6E box 4: once shas are indexed, the verify fetch reads only their owning
    /// part file(s) — not the whole blob corpus (`all_of("blob")`).
    #[test]
    fn indexed_shas_scope_the_query_to_their_owning_files() {
        let store = tmp_store("indexed");
        index(
            &store,
            &[(0, "/store/blobs/part-1.parquet"), (1, "/store/blobs/part-2.parquet")],
            &[(sha("a"), 0), (sha("b"), 0), (sha("c"), 1)],
        );

        let sql = blob_fetch_sql(&store, &[sha("a"), sha("c")]).expect("sql");
        assert!(sql.contains("part-1.parquet"), "must scan sha-a's owning file: {sql}");
        assert!(sql.contains("part-2.parquet"), "must scan sha-c's owning file: {sql}");
        assert!(!sql.contains("all_of") && !sql.contains(" body "), "scoped query, not the all-parts scan: {sql}");

        let _ = fs::remove_dir_all(&store.dir);
    }

    /// A sha absent from the index (e.g. still in RAM staging, never flushed) must widen the
    /// whole query to the full blob corpus rather than being silently skipped — the delete
    /// gate must still read every requested sha from a real source.
    #[test]
    fn a_missing_sha_falls_back_to_the_full_corpus_scan() {
        let store = tmp_store("fallback");
        index(&store, &[(0, "/store/blobs/part-1.parquet")], &[(sha("a"), 0)]);

        let unindexed = sha("9");
        let sql = blob_fetch_sql(&store, &[sha("a"), unindexed.clone()]).expect("sql");
        // No parquet parts exist in this fixture, so all_of("blob") degrades to the bare
        // staging table — still the whole-corpus form (`all_of`), not the file-scoped one.
        assert!(sql.contains("FROM (SELECT * FROM blob)"), "must fall back to all_of(blob): {sql}");
        assert!(!sql.contains("part-1.parquet"), "must not name the file-scoped index: {sql}");
        assert!(sql.contains(&sha("a")) && sql.contains(&unindexed), "must still ask for every sha: {sql}");

        let _ = fs::remove_dir_all(&store.dir);
    }

    /// A sha indexed under two part files must count once toward the coverage check: the unindexed
    /// sha requested beside it must still widen the query to the full corpus, not be skipped.
    #[test]
    fn a_sha_indexed_in_two_files_does_not_mask_an_unindexed_sha() {
        let store = tmp_store("dupsha");
        index(
            &store,
            &[(0, "/store/blobs/part-1.parquet"), (1, "/store/blobs/part-2.parquet")],
            &[(sha("a"), 0), (sha("a"), 1)],
        );

        let unindexed = sha("9");
        let sql = blob_fetch_sql(&store, &[sha("a"), unindexed.clone()]).expect("sql");
        assert!(sql.contains("FROM (SELECT * FROM blob)"), "an unindexed sha must force the full-corpus fallback: {sql}");

        let _ = fs::remove_dir_all(&store.dir);
    }
}

#[cfg(test)]
mod seed_blob_index_tests {
    use super::*;

    /// A store dir holding exactly one flushed blob part; returns (dir, that part path).
    fn one_blob_part(tag: &str) -> (PathBuf, String) {
        let dir = std::env::temp_dir().join(format!("al-store-seed-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let mut store = open_store(&dir, "256MB", crate::cores::duckdb_threads()).expect("open");
        let raw = format!("{{\"model\":\"m\",\"messages\":[{{\"role\":\"user\",\"content\":\"{}\"}}]}}", "s".repeat(600));
        ingest_body(&mut store, "s.request.json", &raw, 1_787_000_000_000).expect("ingest");
        flush_detailed(&mut store).expect("flush");
        drop(store);
        let parts: Vec<String> = part_files(&dir, BLOBS_DIR).iter().filter_map(|p| p.to_str()).map(str::to_owned).collect();
        assert_eq!(parts.len(), 1, "fixture must hold exactly one blob part");
        (dir, parts[0].clone())
    }

    fn bare_index_tables() -> Connection {
        let con = Connection::open_in_memory().expect("con");
        con.execute_batch(
            "CREATE TABLE part_file (id INTEGER, path VARCHAR, dir VARCHAR);
             CREATE TABLE known_blob (sha BLOB, file_id INTEGER);",
        )
        .expect("tables");
        con
    }

    /// The open_store shape: part_file and the scan come from ONE listing, so every scanned
    /// sha finds its part_file row and the index is complete.
    #[test]
    fn one_listing_seeds_every_sha_with_its_part_file() {
        let (dir, part) = one_blob_part("ok");
        let con = bare_index_tables();
        seed_blob_index(&con, 0, std::slice::from_ref(&part), std::slice::from_ref(&part)).expect("seed");
        let (n, orphans): (i64, i64) = con
            .query_row("SELECT count(*), count(*) FILTER (WHERE file_id IS NULL) FROM known_blob", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .expect("count");
        assert!(n > 0, "the part shas are indexed");
        assert_eq!(orphans, 0);
        let _ = fs::remove_dir_all(&dir);
    }

    /// The orphan check error path: a scanned file with no part_file row (what the old
    /// two-listing race produced) must fail loudly, never index the sha with a NULL file.
    #[test]
    fn a_scanned_file_missing_from_part_file_fails_the_seed() {
        let (dir, part) = one_blob_part("orphan");
        let con = bare_index_tables();
        let err = seed_blob_index(&con, 0, &[], std::slice::from_ref(&part)).expect_err("orphans must fail");
        assert!(err.to_string().contains("could not be matched to their part file"), "{err}");
        let _ = fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod part_files_strict_tests {
    use super::*;

    /// A regular file where the parts dir should be is an error, not an empty listing: part_files returns
    /// nothing for it, and the sync would then delete every row of that dir. MUTATION CHECK: make
    /// part_files_strict return Ok(part_files(dir, sub)) and this test fails.
    #[test]
    fn a_regular_file_in_place_of_the_dir_is_an_error_not_an_empty_listing() {
        let root = std::env::temp_dir().join(format!("al-store-strict-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).expect("create root");
        fs::write(root.join(BLOBS_DIR), b"not a dir").expect("write blobs as a file");
        let listed = part_files_strict(&root, BLOBS_DIR);
        let _ = fs::remove_dir_all(&root);
        assert!(listed.is_err(), "a regular file in place of the dir must be an error: {listed:?}");
    }
}

#[cfg(test)]
mod index_part_bodies_spill_tests {
    use super::*;

    const FILES: usize = 4;
    const ROWS_PER_FILE: usize = 1_250_000;
    const BODIES: usize = 1000;

    /// Removes its directory on drop, so a panic in any `expect` in the test still cleans up.
    struct RemoveOnDrop(std::path::PathBuf);

    impl Drop for RemoveOnDrop {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    /// TRDD-R36S0PS9 regression: seeding known_part from a parts corpus with many rows per body must not
    /// exhaust the spill cap. open_store hard-codes a 4GB cap, so this drives index_part_bodies on a bare
    /// connection with a tiny cap. MUTATION CHECK: restore the pre-fix SQL (DISTINCT outside the join plus a
    /// per-row NOT EXISTS) and this test fails with a temp-directory-size error. The pass margin depends on
    /// DuckDB's aggregate memory behaviour at 64MB / 1 thread, so if a DuckDB upgrade makes it fail, diagnose
    /// the seed SQL's memory before deleting or loosening the test.
    #[test]
    fn seeding_many_rows_per_body_stays_within_a_tiny_spill_cap() {
        let root = std::env::temp_dir().join(format!("al-store-spill-{}", std::process::id()));
        let _guard = RemoveOnDrop(root.clone());
        let _ = fs::remove_dir_all(&root);
        let tmp = root.join("tmp");
        fs::create_dir_all(&tmp).expect("create tmp");
        let con = Connection::open_in_memory().expect("con");
        con.execute_batch(&format!(
            "SET threads=1; SET memory_limit='64MB'; SET max_temp_directory_size='32MB'; SET temp_directory={};
             CREATE TABLE part_file (id INTEGER, path VARCHAR, dir VARCHAR);
             CREATE TABLE known_part (body_id BLOB, file_id INTEGER);",
            q(tmp.to_str().expect("utf8"))
        ))
        .expect("setup");
        let mut files = Vec::new();
        for f in 0..FILES {
            let path = root.join(format!("parts-{f}.parquet")).to_str().expect("utf8").to_owned();
            con.execute_batch(&format!(
                "COPY (SELECT md5((i % {BODIES})::VARCHAR) || md5((i % {BODIES})::VARCHAR) AS body_id, i AS pos
                       FROM range({ROWS_PER_FILE}) t(i)) TO {} (FORMAT parquet);
                 INSERT INTO part_file VALUES ({f}, {}, 'parts');",
                q(&path),
                q(&path)
            ))
            .expect("write parts file");
            files.push(path);
        }
        let inserted = index_part_bodies(&con, &files).expect("seed must not exhaust the spill cap");
        let (rows, orphans): (i64, i64) = con
            .query_row("SELECT count(*), count(*) FILTER (WHERE file_id IS NULL) FROM known_part", [], |r| Ok((r.get(0)?, r.get(1)?)))
            .expect("count");
        assert_eq!(inserted as i64, (FILES * BODIES) as i64, "one row per distinct (body, file) pair");
        assert_eq!(rows, (FILES * BODIES) as i64);
        // belt-and-braces, index_part_bodies already returns Err on any NULL file_id.
        assert_eq!(orphans, 0);
    }

    /// The REAL reason `verify_bodies_in_store_cached` emits for a moved ts is recognised, and a lump name that embeds the phrase on another failure is not.
    #[test]
    fn the_real_ts_reason_is_recognised_and_a_crafted_name_is_not() {
        let dir = std::env::temp_dir().join(format!("al-store-tsonly-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let mut store = open_store(&dir, "256MB", crate::cores::duckdb_threads()).expect("open");
        let raw = "{\"model\":\"claude-opus-5\",\"messages\":[{\"role\":\"user\",\"content\":\"ts-only\"}]}";
        ingest_body(&mut store, "aaaa0000.request.json", raw, 1_000_000).expect("ingest");
        flush_detailed(&mut store).expect("flush");
        let items = [VerifyItem { src_name: "aaaa0000.request.json".into(), raw: raw.into(), ts_ms: Some(1_000_000 + 60_000) }];
        let map = verify_bodies_in_store(&store, &items).expect("verify");
        let reason = map["aaaa0000.request.json"].reason.clone().expect("a ts failure has a reason");
        assert_eq!(reason, "aaaa0000.request.json: stored ts 1000000 != capture time 1060000");
        assert!(is_ts_only_failure(&reason));
        assert!(!is_ts_only_failure("x stored ts 1 != capture time 2: no body row for this src_name (content may exist under another name)"));
        assert!(!is_ts_only_failure("x: reconstruction != source bytes"));
        let _ = fs::remove_dir_all(&dir);
    }
}

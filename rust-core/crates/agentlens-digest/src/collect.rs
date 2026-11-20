//! `collect`: load spool files exactly once through the registered digest macros.
//!
//! Layout: `<ingest_dir>/ready/<spool>/*.ndjson`, then `done/<spool>/` or `failed/<spool>/`.
//!
//! Exactly-once rests on one DuckDB transaction per file (ledger row + one INSERT per producer
//! of the spool + ledger `complete`), a rename AFTER the COMMIT, and a reconcile pass that moves
//! a ready file whose ledger row is already `complete` (a crash between COMMIT and rename).
//! A load that raises is rolled back, recorded as a `failed` ledger row in its own transaction
//! (failed rows are append-only history and never make a file skippable) and the file moves to
//! `failed/` with `<name>.error.txt`; the next file is still attempted.

use crate::schema::{qident, sha256_hex};
use crate::Res;
use duckdb::{params, Connection, Statement};
use std::path::{Path, PathBuf};

#[derive(Debug, Default, PartialEq, Eq)]
pub struct Summary {
    pub files_loaded: u64,
    pub rows: u64,
    pub files_failed: u64,
    /// Ready files skipped because the ledger already holds a `complete` row for their name.
    pub files_reconciled: u64,
}

/// Points of `collect_with` an observer may watch; the `aldigest` binary uses them for the
/// test-only crash points (cargo feature `crashpoints`), nothing in this library acts on them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stage {
    /// Every INSERT of the file returned; the transaction is still open.
    AfterInsert,
    /// COMMIT returned; the file has not been renamed yet.
    AfterCommit,
}

struct Spool {
    name: String,
    /// sha256 of the sorted concatenation of the spool's producer schema hashes.
    schema_sha256: String,
    /// (producer_type, `INSERT INTO <table> (<all columns but _meta_event_id>) SELECT * FROM <macro>(?, ?, ?)`)
    inserts: Vec<(String, String)>,
}

fn err(ctx: &str, e: impl std::fmt::Display) -> String {
    format!("{ctx}: {e}")
}

fn load_catalog(conn: &Connection) -> Res<Vec<Spool>> {
    let mut stmt = conn
        .prepare("SELECT spool, producer_type, duckdb_schema, schema_sha256 FROM _ingest.producer_types ORDER BY spool, producer_type")
        .map_err(|e| err("catalog (was register run?)", e))?;
    let rows: Vec<(String, String, String, String)> = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
        .and_then(|it| it.collect())
        .map_err(|e| err("catalog", e))?;
    let mut cols_stmt = conn
        .prepare("SELECT column_name FROM duckdb_columns() WHERE schema_name = ? AND table_name = 'events' ORDER BY column_index")
        .map_err(|e| err("catalog columns", e))?;
    let mut spools: Vec<Spool> = Vec::new();
    let mut hashes: Vec<Vec<String>> = Vec::new();
    for (spool, producer_type, duckdb_schema, sha) in rows {
        let cols: Vec<String> = cols_stmt
            .query_map(params![duckdb_schema], |r| r.get::<_, String>(0))
            .and_then(|it| it.collect())
            .map_err(|e| err(&producer_type, e))?;
        let cols: Vec<String> = cols.into_iter().filter(|c| c != "_meta_event_id").map(|c| qident(&c)).collect();
        if cols.is_empty() {
            return Err(format!("producer {producer_type}: table {duckdb_schema}.events not found"));
        }
        let sql = format!(
            "INSERT INTO {}.{} ({}) SELECT * FROM {}.{}(?::VARCHAR, ?::BIGINT, ?::TIMESTAMPTZ)",
            qident(&duckdb_schema),
            qident("events"),
            cols.join(", "),
            qident("_ingest"),
            qident(&format!("digest_{producer_type}")),
        );
        if spools.last().is_none_or(|s| s.name != spool) {
            spools.push(Spool { name: spool, schema_sha256: String::new(), inserts: Vec::new() });
            hashes.push(Vec::new());
        }
        spools.last_mut().expect("just pushed").inserts.push((producer_type, sql));
        hashes.last_mut().expect("just pushed").push(sha);
    }
    for (s, mut h) in spools.iter_mut().zip(hashes) {
        h.sort();
        s.schema_sha256 = sha256_hex(&h.concat());
    }
    Ok(spools)
}

/// Destination inside `dir` that never overwrites: `name`, else `name.dup1`, `name.dup2`, ...
fn move_unique(src: &Path, dir: &Path, name: &str) -> Res<PathBuf> {
    std::fs::create_dir_all(dir).map_err(|e| err(&dir.display().to_string(), e))?;
    let mut dest = dir.join(name);
    let mut n = 0;
    while dest.exists() {
        n += 1;
        dest = dir.join(format!("{name}.dup{n}"));
    }
    std::fs::rename(src, &dest).map_err(|e| format!("move {} -> {}: {e}", src.display(), dest.display()))?;
    Ok(dest)
}

fn ndjson_files(dir: &Path) -> Res<Vec<PathBuf>> {
    let mut files = Vec::new();
    for entry in std::fs::read_dir(dir).map_err(|e| err(&dir.display().to_string(), e))? {
        let entry = entry.map_err(|e| err(&dir.display().to_string(), e))?;
        // Dot entries (macOS `.DS_Store`, editor temp files) are never spool files.
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        let path = entry.path();
        if path.is_file() && path.extension().is_some_and(|x| x == "ndjson") {
            files.push(path);
        }
    }
    files.sort();
    Ok(files)
}

fn is_complete(conn: &Connection, spool: &str, name: &str) -> Res<bool> {
    let n: i64 = conn
        .query_row("SELECT count(*) FROM _ingest.files WHERE spool = ? AND source_name = ? AND status = 'complete'", params![spool, name], |r| r.get(0))
        .map_err(|e| err("ledger", e))?;
    Ok(n > 0)
}

fn load_in_transaction(
    conn: &Connection,
    spool: &Spool,
    stmts: &mut [(&str, Statement<'_>)],
    file: &Path,
    name: &str,
    size: u64,
    on_stage: &mut dyn FnMut(Stage),
) -> Res<u64> {
    let (ingest_id, ingested_at): (i64, String) = conn
        .query_row(
            "INSERT INTO _ingest.files (spool, source_name, source_size_bytes, schema_sha256, ingested_at, status)
             VALUES (?, ?, ?, ?, now(), 'loading') RETURNING ingest_id, CAST(ingested_at AS VARCHAR)",
            params![spool.name, name, size, spool.schema_sha256],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|e| err("ledger insert", e))?;
    let path = file.to_str().ok_or_else(|| format!("{}: path is not UTF-8", file.display()))?;
    // WHY (TRDD-C6W0SWUT): the macro hands this path to `read_ndjson`, and DuckDB glob-expands even a bound parameter, so a spool path holding `*`, `?` or `[`
    // read every sibling the pattern matched (rows of other files loaded under this ingest id). `glob_escape` makes the value match only itself; no quoting, it is bound.
    let path = agentlens_store::glob_escape(path);
    let mut rows: Option<u64> = None;
    for (producer_type, stmt) in stmts.iter_mut() {
        let n = stmt.execute(params![path, ingest_id, ingested_at]).map_err(|e| err(producer_type, e))? as u64;
        match rows {
            None => rows = Some(n),
            Some(first) if first != n => return Err(format!("{producer_type}: loaded {n} rows, the other producers of spool {} loaded {first}", spool.name)),
            Some(_) => {}
        }
    }
    let rows = rows.ok_or_else(|| format!("spool {} has no producer", spool.name))?;
    on_stage(Stage::AfterInsert);
    // now() is the transaction start in DuckDB; get_current_timestamp() is the wall clock.
    conn.execute(
        "UPDATE _ingest.files SET status = 'complete', record_count = ?, completed_at = get_current_timestamp() WHERE ingest_id = ?",
        params![rows, ingest_id],
    )
    .map_err(|e| err("ledger complete", e))?;
    Ok(rows)
}

/// One transaction per file; ROLLBACK on any error.
fn load_file(
    conn: &Connection,
    spool: &Spool,
    stmts: &mut [(&str, Statement<'_>)],
    file: &Path,
    name: &str,
    size: u64,
    on_stage: &mut dyn FnMut(Stage),
) -> Res<u64> {
    conn.execute_batch("BEGIN").map_err(|e| err("begin", e))?;
    match load_in_transaction(conn, spool, stmts, file, name, size, on_stage) {
        Ok(rows) => {
            conn.execute_batch("COMMIT").map_err(|e| err("commit", e))?;
            Ok(rows)
        }
        Err(e) => {
            conn.execute_batch("ROLLBACK").map_err(|r| format!("{e}; rollback also failed: {r}"))?;
            Err(e)
        }
    }
}

fn record_failure(conn: &Connection, spool: &Spool, name: &str, size: u64, message: &str) -> Res<()> {
    conn.execute(
        "INSERT INTO _ingest.files (spool, source_name, source_size_bytes, schema_sha256, ingested_at, status, completed_at, error_message)
         VALUES (?, ?, ?, ?, now(), 'failed', get_current_timestamp(), ?)",
        params![spool.name, name, size, spool.schema_sha256, message],
    )
    .map_err(|e| err("ledger failed row", e))?;
    Ok(())
}

fn collect_spool(conn: &Connection, root: &Path, spool: &Spool, files: Vec<PathBuf>, on_stage: &mut dyn FnMut(Stage), sum: &mut Summary, budget: &mut Budget) -> Res<()> {
    let done_dir = root.join("done").join(&spool.name);
    let failed_dir = root.join("failed").join(&spool.name);
    let mut pending = Vec::new();
    for file in files {
        let name = file.file_name().and_then(|n| n.to_str()).ok_or_else(|| format!("{}: file name is not UTF-8", file.display()))?.to_owned();
        if is_complete(conn, &spool.name, &name)? {
            move_unique(&file, &done_dir, &name)?;
            sum.files_reconciled += 1;
        } else {
            pending.push((file, name));
        }
    }
    if pending.is_empty() {
        return Ok(());
    }
    let mut stmts: Vec<(&str, Statement<'_>)> = Vec::new();
    for (producer_type, sql) in &spool.inserts {
        stmts.push((producer_type.as_str(), conn.prepare(sql).map_err(|e| err(producer_type, e))?));
    }
    for (file, name) in pending {
        if !budget.take() {
            budget.remaining += 1;
            continue;
        }
        let size = std::fs::metadata(&file).map_err(|e| err(&file.display().to_string(), e))?.len();
        match load_file(conn, spool, &mut stmts, &file, &name, size, on_stage) {
            Ok(rows) => {
                on_stage(Stage::AfterCommit);
                move_unique(&file, &done_dir, &name)?;
                sum.files_loaded += 1;
                sum.rows += rows;
            }
            Err(message) => {
                record_failure(conn, spool, &name, size, &message)?;
                let dest = move_unique(&file, &failed_dir, &name)?;
                let mut error_name = dest.file_name().expect("moved file has a name").to_os_string();
                error_name.push(".error.txt");
                std::fs::write(failed_dir.join(error_name), &message).map_err(|e| err("error file", e))?;
                sum.files_failed += 1;
            }
        }
    }
    Ok(())
}

/// Load every ready file of every registered spool.
pub fn collect(conn: &Connection, ingest_dir: &Path) -> Res<Summary> {
    collect_with(conn, ingest_dir, &mut |_| {})
}

/// [`collect`] with an observer called at each [`Stage`].
pub fn collect_with(conn: &Connection, ingest_dir: &Path, on_stage: &mut dyn FnMut(Stage)) -> Res<Summary> {
    collect_limited(conn, ingest_dir, None, on_stage).map(|(sum, _)| sum)
}

/// How many more files this run may load or fail (`None` = no limit), and how many ready files it left.
struct Budget {
    left: Option<u64>,
    remaining: u64,
}

impl Budget {
    /// Claim one file slot; false when the run is out of slots.
    fn take(&mut self) -> bool {
        match &mut self.left {
            None => true,
            Some(0) => false,
            Some(n) => {
                *n -= 1;
                true
            }
        }
    }
}

/// [`collect_with`] that stops after `max_files` files were loaded or failed (reconciled files do
/// not count) and returns how many ready files it left behind. MEASURED reason: one `aldigest
/// collect` process grows in RSS with every committed API-body file (65 to 687 MiB over 72 files;
/// it is DuckDB itself, no setting bounds it) and stays under 300 MiB when it handles about 10, so
/// a caller bounds a process by file count and starts a fresh one for the rest.
pub fn collect_limited(conn: &Connection, ingest_dir: &Path, max_files: Option<u64>, on_stage: &mut dyn FnMut(Stage)) -> Res<(Summary, u64)> {
    let root = std::fs::canonicalize(ingest_dir).map_err(|e| err(&ingest_dir.display().to_string(), e))?;
    let ready = root.join("ready");
    crate::register::check_layout(conn)?;
    let spools = load_catalog(conn)?;
    let entries = std::fs::read_dir(&ready).map_err(|e| err(&ready.display().to_string(), e))?;
    for entry in entries {
        let entry = entry.map_err(|e| err("ready", e))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        // Dot entries (macOS `.DS_Store`) are ignored; every other unknown entry is an error.
        if name.starts_with('.') {
            continue;
        }
        if !entry.path().is_dir() || !spools.iter().any(|s| s.name == name) {
            return Err(format!("{}: not a directory named after a registered spool", entry.path().display()));
        }
    }
    let mut sum = Summary::default();
    let mut budget = Budget { left: max_files, remaining: 0 };
    for spool in &spools {
        let dir = ready.join(&spool.name);
        if dir.is_dir() {
            let files = ndjson_files(&dir)?;
            if budget.left == Some(0) {
                budget.remaining += files.len() as u64;
            } else {
                collect_spool(conn, &root, spool, files, on_stage, &mut sum, &mut budget)?;
            }
        }
    }
    Ok((sum, budget.remaining))
}

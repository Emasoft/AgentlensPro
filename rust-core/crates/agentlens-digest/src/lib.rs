//! agentlens-digest — spool NDJSON → typed native DuckDB tables, through precompiled SQL macros.
//!
//! Layout (owner directive D-H, TRDD-LHCHVK9Z; slice 1 TRDD-VXD881R6):
//! * [`schema`] reads `schemas/manifest.json` and compiles each producer's JSON Schema into a
//!   table layout (port of the prototype `setup_duckdb_native_v2.py`).
//! * [`register`] installs the catalog (`_ingest`), one table and one table macro
//!   `_ingest.digest_<producer_type>(dg_path, dg_ingest_id, dg_ingested_at)` per producer.
//! * [`collect`] loads spool files `<ingest_dir>/ready/<spool>/*.ndjson` exactly once.
//!
//! Spool line: `{"ts_ns": <unix ns>, "payload": <native JSON exactly as emitted>}`.
//!
//! SPOOL GROUPS (owner ruling D-A: a change to one topic versions only that topic's table).
//! Several producers (topics) may share one spool. A file in that spool is one ledger row with
//! one `ingest_id`; each producer of the spool loads its own columns from every line with that
//! same `ingest_id`. The rows of ONE event are therefore joined across the topic tables on
//! (`_meta_ingest_id`, `_meta_record_ordinal`).

pub mod collect;
pub mod register;
pub mod schema;

use duckdb::Connection;
use std::path::Path;

/// Errors are plain messages, as in the neighbouring crates.
pub type Res<T> = Result<T, String>;

/// Provisional DuckDB settings of every connection (binary and tests): one place.
pub const THREADS: u32 = 1;
pub const MEMORY_LIMIT: &str = "256MB";
pub const PRESERVE_INSERTION_ORDER: bool = true;
/// DuckDB's default `maximum_object_size` is 16 MiB; one spool line may exceed it.
pub const MAX_OBJECT_BYTES: u64 = 67_108_864;

/// Apply the three provisional settings. `preserve_insertion_order` is what makes
/// `row_number() OVER ()` equal the line position (the record ordinal).
pub fn configure(conn: &Connection) -> Res<()> {
    conn.execute_batch(&format!(
        "SET threads = {THREADS}; SET memory_limit = '{MEMORY_LIMIT}'; SET preserve_insertion_order = {PRESERVE_INSERTION_ORDER};"
    ))
    .map_err(|e| format!("configure: {e}"))
}

/// Open (or create) the database file and configure the connection.
pub fn open(db: &Path) -> Res<Connection> {
    let conn = Connection::open(db).map_err(|e| format!("open {}: {e}", db.display()))?;
    configure(&conn)?;
    Ok(conn)
}


/// Open an EXISTING database file READ-ONLY (a missing file is an error, never created) and
/// configure the connection. Used by `aldigest query`: a reader must not be able to change, or
/// even lock out writers of, the database.
pub fn open_read_only(db: &Path) -> Res<Connection> {
    let config = duckdb::Config::default().access_mode(duckdb::AccessMode::ReadOnly).map_err(|e| format!("open {}: {e}", db.display()))?;
    let conn = Connection::open_with_flags(db, config).map_err(|e| format!("open {} read-only: {e}", db.display()))?;
    configure(&conn)?;
    Ok(conn)
}

/// Run one SELECT (no trailing semicolon) and return each result row as one JSON object text:
/// column name -> value, produced by DuckDB's `to_json` over the whole row.
pub fn query_json_rows(conn: &Connection, sql: &str) -> Res<Vec<String>> {
    let mut stmt = conn.prepare(&format!("SELECT CAST(to_json(q) AS VARCHAR) FROM ({sql}) AS q")).map_err(|e| format!("query: {e}"))?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| format!("query: {e}"))?;
    rows.collect::<Result<Vec<String>, _>>().map_err(|e| format!("query: {e}"))
}

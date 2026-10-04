//! `register`: install the `_ingest` catalog and, per producer, its schema, `events` table and
//! digest macro — in ONE transaction, idempotent.

use crate::schema::{canonical_json, qident, Producer};
use crate::{Res, MAX_OBJECT_BYTES};
use duckdb::{params, Connection, OptionalExt};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

const COMPILER_VERSION: &str = "3.0-rust-spool";

/// Layout version of the `_ingest` catalog, stored in `_ingest.catalog_meta`.
///
/// MUST be bumped whenever the catalog tables (`SHARED_DDL`, the `events` table layout of
/// `META_DDL`/`table_ddl`) OR the generated macro body (`macro_ddl`) change: an installed table
/// or macro is never regenerated, so a database written by another layout has to be refused,
/// never silently mixed with this build's output.
pub const LAYOUT_VERSION: i32 = 1;

/// The six pipeline columns of every `events` table, in table order (the first one is the
/// table-only surrogate key, filled by its DEFAULT and not produced by the digest macro).
const META_DDL: [&str; 6] = [
    "\"_meta_event_id\" BIGINT NOT NULL DEFAULT nextval('_ingest.event_id_seq')",
    "\"_meta_ingest_id\" BIGINT NOT NULL",
    "\"_meta_record_ordinal\" UBIGINT NOT NULL",
    "\"_meta_recorded_at_ns\" HUGEINT NOT NULL",
    "\"_meta_recorded_at\" TIMESTAMPTZ NOT NULL",
    "\"_meta_ingested_at\" TIMESTAMPTZ NOT NULL",
];

// No PRIMARY KEY / UNIQUE / FOREIGN KEY anywhere: DuckDB backs them with ART indexes, which cost
// load time and buy nothing for an append-only pipeline whose exactly-once guard is the ledger.
//
/// The shared catalog DDL, run on every register (all `IF NOT EXISTS` except the view).
///
/// `_ingest.table_timeline`: `valid_to` of a version is the `valid_from` of its successor, so it
/// is NULL whenever the successor has no `valid_from` (null = since the beginning). The test for
/// "this is the current version" is therefore `superseded_by IS NULL`, never `valid_to IS NULL`.
const SHARED_DDL: [&str; 7] = [
    "CREATE SCHEMA IF NOT EXISTS \"_ingest\"",
    "CREATE SEQUENCE IF NOT EXISTS _ingest.ingest_id_seq START 1",
    "CREATE SEQUENCE IF NOT EXISTS _ingest.event_id_seq START 1",
    // Exactly one row: the LAYOUT_VERSION this catalog was created with.
    "CREATE TABLE IF NOT EXISTS \"_ingest\".\"catalog_meta\" (layout_version INTEGER NOT NULL)",
    // Binds each schema to its table and is the timeline index. valid_to / superseded_by are
    // computed from the integer `version` within source+topic, never from install order.
    "CREATE TABLE IF NOT EXISTS \"_ingest\".\"producer_types\" (
        producer_type VARCHAR NOT NULL,
        source VARCHAR NOT NULL,
        topic VARCHAR NOT NULL,
        version BIGINT NOT NULL,
        claude_code_version VARCHAR NOT NULL,
        spool VARCHAR NOT NULL,
        duckdb_schema VARCHAR NOT NULL,
        schema_sha256 VARCHAR NOT NULL,
        schema_json JSON NOT NULL,
        reader_columns_sql VARCHAR NOT NULL,
        compiler_version VARCHAR NOT NULL,
        digest_macro VARCHAR NOT NULL,
        valid_from DATE,
        valid_to DATE,
        superseded_by VARCHAR,
        replaces_json JSON NOT NULL,
        installed_at TIMESTAMPTZ NOT NULL DEFAULT current_timestamp
    )",
    // One row per spool file attempt. A failed row is append-only history; only `complete`
    // makes a file skippable. schema_sha256 = sha256 of the sorted concatenation of the
    // spool's producer hashes.
    "CREATE TABLE IF NOT EXISTS \"_ingest\".\"files\" (
        ingest_id BIGINT NOT NULL DEFAULT nextval('_ingest.ingest_id_seq'),
        spool VARCHAR NOT NULL,
        source_name VARCHAR NOT NULL,
        source_size_bytes UBIGINT NOT NULL,
        schema_sha256 VARCHAR NOT NULL,
        ingested_at TIMESTAMPTZ NOT NULL,
        record_count UBIGINT,
        status VARCHAR NOT NULL,
        completed_at TIMESTAMPTZ,
        error_message VARCHAR
    )",
    // valid_to is NULL when the successor has no valid_from: it is NOT the current-version test.
    // `superseded_by IS NULL` is.
    "CREATE OR REPLACE VIEW \"_ingest\".\"table_timeline\" AS
        SELECT source, topic, version, producer_type, duckdb_schema, valid_from, valid_to, superseded_by
        FROM \"_ingest\".\"producer_types\"",
];

fn err(ctx: &str, e: impl std::fmt::Display) -> String {
    format!("{ctx}: {e}")
}

fn has_catalog_table(conn: &Connection, table: &str) -> Res<bool> {
    let n: i64 = conn
        .query_row("SELECT count(*) FROM duckdb_tables() WHERE schema_name = '_ingest' AND table_name = ?", params![table], |r| r.get(0))
        .map_err(|e| err("catalog", e))?;
    Ok(n > 0)
}

/// Refuse a database whose catalog layout is not [`LAYOUT_VERSION`]: `_ingest.catalog_meta` must
/// exist and hold exactly one row equal to it. A catalog with `producer_types` but no
/// `catalog_meta` predates layout versions and is refused as an old layout.
pub fn check_layout(conn: &Connection) -> Res<()> {
    if !has_catalog_table(conn, "catalog_meta")? {
        return Err(if has_catalog_table(conn, "producer_types")? {
            format!("catalog has _ingest.producer_types but no _ingest.catalog_meta: an old layout, this build needs layout version {LAYOUT_VERSION}")
        } else {
            "no _ingest catalog (was register run?)".to_owned()
        });
    }
    let mut stmt = conn.prepare("SELECT layout_version FROM _ingest.catalog_meta").map_err(|e| err("catalog_meta", e))?;
    let versions: Vec<i32> = stmt.query_map([], |r| r.get(0)).and_then(|it| it.collect()).map_err(|e| err("catalog_meta", e))?;
    match versions.as_slice() {
        [v] if *v == LAYOUT_VERSION => Ok(()),
        [v] => Err(format!("catalog layout version {v} != {LAYOUT_VERSION}, the layout version of this build")),
        other => Err(format!("_ingest.catalog_meta must hold exactly one row, found {}", other.len())),
    }
}

fn table_ddl(p: &Producer) -> String {
    let mut defs: Vec<String> = META_DDL.iter().map(|s| (*s).to_owned()).collect();
    defs.extend(p.columns.iter().map(|c| format!("{} {}{}", qident(&c.name), c.ty, if c.not_null { " NOT NULL" } else { "" })));
    format!("CREATE TABLE {} (\n    {}\n)", p.qualified_table(), defs.join(",\n    "))
}

/// The precompiled digest: a fixed SELECT over one explicit `read_ndjson`, returning every table
/// column except `_meta_event_id`, in table order. `ignore_errors` is never true: a bad line
/// fails the statement and with it the file. The timestamp is the UTC instant of `ts_ns`
/// truncated to microseconds.
///
/// The parameters are `dg_`-prefixed and `dg_*` is a reserved payload property name (schema.rs),
/// so no payload property can collide with a macro parameter.
///
/// A line whose `payload` is absent or null fails the file (owner ruling D-E: an anomaly is an
/// error), even for a producer with no NOT NULL column: the `error()` runs only for such a row,
/// inside the query, with no per-line work outside SQL. A payload of `{}` is NOT an error: for a
/// producer without NOT NULL columns every optional field may be absent, and the row loads with
/// NULLs.
fn macro_ddl(p: &Producer) -> String {
    let payload_cols: Vec<String> = p.columns.iter().map(|c| format!("payload.{q} AS {q}", q = qident(&c.name))).collect();
    format!(
        "CREATE MACRO {name}(dg_path, dg_ingest_id, dg_ingested_at) AS TABLE
SELECT
    dg_ingest_id AS \"_meta_ingest_id\",
    CAST(row_number() OVER () - 1 AS UBIGINT) AS \"_meta_record_ordinal\",
    CAST(ts_ns AS HUGEINT) AS \"_meta_recorded_at_ns\",
    make_timestamptz(ts_ns // 1000) AS \"_meta_recorded_at\",
    dg_ingested_at AS \"_meta_ingested_at\",
    {cols}
FROM read_ndjson(dg_path, columns = {reader}, ignore_errors = false, maximum_object_size = {MAX_OBJECT_BYTES})
WHERE payload IS NOT NULL OR error('digest: a spool line has an absent or null payload (ts_ns ' || coalesce(CAST(ts_ns AS VARCHAR), 'null') || ')')",
        name = p.qualified_macro(),
        cols = payload_cols.join(",\n    "),
        reader = p.reader_columns_sql(),
    )
}

/// `{new_column: old_column}` from the `x-replaces` keywords; `{}` when none.
fn replaces_json(p: &Producer) -> String {
    let mut map = Map::new();
    for c in &p.columns {
        if let Some(old) = &c.replaces {
            map.insert(c.name.clone(), Value::String(old.clone()));
        }
    }
    canonical_json(&Value::Object(map))
}

fn install_producer(conn: &Connection, p: &Producer) -> Res<()> {
    let clash: Option<String> = conn
        .query_row(
            "SELECT producer_type FROM _ingest.producer_types WHERE spool = ? AND source = ? AND topic = ?",
            params![p.spool, p.source, p.topic],
            |r| r.get(0),
        )
        .optional()
        .map_err(|e| err(&p.producer_type, e))?;
    if let Some(other) = clash {
        // Two versions of one topic in one spool would load every line into both tables.
        return Err(format!("producer {}: spool {} already feeds {other} for the same source+topic", p.producer_type, p.spool));
    }
    conn.execute_batch(&format!("CREATE SCHEMA {}", qident(&p.duckdb_schema))).map_err(|e| err(&p.producer_type, e))?;
    conn.execute_batch(&table_ddl(p)).map_err(|e| err(&format!("{} table", p.producer_type), e))?;
    conn.execute_batch(&macro_ddl(p)).map_err(|e| err(&format!("{} macro", p.producer_type), e))?;
    conn.execute(
        "INSERT INTO _ingest.producer_types
            (producer_type, source, topic, version, claude_code_version, spool, duckdb_schema, schema_sha256,
             schema_json, reader_columns_sql, compiler_version, digest_macro, valid_from, replaces_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, ?, CAST(? AS DATE), CAST(? AS JSON))",
        params![
            p.producer_type,
            p.source,
            p.topic,
            p.version,
            p.claude_code_version,
            p.spool,
            p.duckdb_schema,
            p.sha256,
            canonical_json(&p.schema_json),
            p.reader_columns_sql(),
            COMPILER_VERSION,
            p.macro_name(),
            p.valid_from,
            replaces_json(p),
        ],
    )
    .map_err(|e| err(&format!("{} catalog row", p.producer_type), e))?;
    Ok(())
}

/// valid_to of version n = valid_from of version n+1 (same source+topic); superseded_by names it.
/// Ordered by the integer version, never by install order. A successor without valid_from leaves
/// valid_to NULL (see `SHARED_DDL`: `superseded_by IS NULL` is the current-version test).
fn refresh_timeline(conn: &Connection, source: &str, topic: &str) -> Res<()> {
    let mut stmt = conn
        .prepare("SELECT producer_type, CAST(valid_from AS VARCHAR) FROM _ingest.producer_types WHERE source = ? AND topic = ? ORDER BY version")
        .map_err(|e| err("timeline", e))?;
    let rows: Vec<(String, Option<String>)> =
        stmt.query_map(params![source, topic], |r| Ok((r.get(0)?, r.get(1)?))).and_then(|it| it.collect()).map_err(|e| err("timeline", e))?;
    for pair in rows.windows(2) {
        conn.execute(
            "UPDATE _ingest.producer_types SET valid_to = CAST(? AS DATE), superseded_by = ? WHERE producer_type = ?",
            params![pair[1].1, pair[1].0, pair[0].0],
        )
        .map_err(|e| err("timeline", e))?;
    }
    Ok(())
}

fn install(conn: &Connection, producers: &[Producer]) -> Res<usize> {
    // A catalog that already exists must have this build's layout before anything is added to it.
    if has_catalog_table(conn, "producer_types")? || has_catalog_table(conn, "catalog_meta")? {
        check_layout(conn)?;
    } else {
        for sql in SHARED_DDL {
            conn.execute_batch(sql).map_err(|e| err("catalog", e))?;
        }
        conn.execute("INSERT INTO _ingest.catalog_meta (layout_version) VALUES (?)", params![LAYOUT_VERSION]).map_err(|e| err("catalog_meta", e))?;
    }
    let mut installed = 0;
    let mut touched: BTreeSet<(&str, &str)> = BTreeSet::new();
    for p in producers {
        // (schema hash, spool, whether the manifest's valid_from differs from the installed one;
        // IS DISTINCT FROM so null-to-date and date-to-null both count as a change)
        let existing: Option<(String, String, bool)> = conn
            .query_row(
                "SELECT schema_sha256, spool, valid_from IS DISTINCT FROM CAST(? AS DATE) FROM _ingest.producer_types WHERE producer_type = ?",
                params![p.valid_from, p.producer_type],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()
            .map_err(|e| err(&p.producer_type, e))?;
        match existing {
            // Owner ruling D-A: a change is a new producer_type, never an edit.
            Some((sha, _, _)) if sha != p.sha256 => {
                return Err(format!(
                    "producer {} is installed with schema sha256 {sha}, the manifest has {}; a change needs a new producer_type",
                    p.producer_type, p.sha256
                ))
            }
            // The spool is baked into where collect looks for this producer's files: not editable either.
            Some((_, spool, _)) if spool != p.spool => {
                return Err(format!(
                    "producer {} is installed with spool {spool}, the manifest has {}; a change needs a new producer_type",
                    p.producer_type, p.spool
                ))
            }
            // A new valid_from is a calendar fact, not a schema change: applied, timeline refreshed.
            Some((_, _, true)) => {
                conn.execute("UPDATE _ingest.producer_types SET valid_from = CAST(? AS DATE) WHERE producer_type = ?", params![p.valid_from, p.producer_type])
                    .map_err(|e| err(&format!("{} valid_from", p.producer_type), e))?;
                touched.insert((&p.source, &p.topic));
            }
            Some(_) => {}
            None => {
                install_producer(conn, p)?;
                installed += 1;
                touched.insert((&p.source, &p.topic));
            }
        }
    }
    for (source, topic) in touched {
        refresh_timeline(conn, source, topic)?;
    }
    Ok(installed)
}

/// Install every producer not yet installed; returns how many were new. A producer already
/// installed with the same sha256 and spool is a no-op (a changed `valid_from` is applied and the
/// timeline refreshed); with a different sha256 or spool the whole call fails and writes nothing.
/// A database with another catalog layout version is refused (see [`check_layout`]).
pub fn register(conn: &Connection, producers: &[Producer]) -> Res<usize> {
    conn.execute_batch("BEGIN").map_err(|e| err("register begin", e))?;
    match install(conn, producers) {
        Ok(n) => {
            conn.execute_batch("COMMIT").map_err(|e| err("register commit", e))?;
            Ok(n)
        }
        Err(e) => {
            conn.execute_batch("ROLLBACK").map_err(|r| format!("{e}; rollback also failed: {r}"))?;
            Err(e)
        }
    }
}

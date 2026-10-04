//! `register`: install the `_ingest` catalog and, per producer, its schema, `events` table and
//! digest macro — in ONE transaction, idempotent.

use crate::schema::{canonical_json, qident, Producer};
use crate::{Res, MAX_OBJECT_BYTES};
use duckdb::{params, Connection, OptionalExt};
use serde_json::{Map, Value};
use std::collections::BTreeSet;

const COMPILER_VERSION: &str = "3.0-rust-spool";
// The prototype's recorded-at catalog columns, kept with their now constant, truthful values:
// the spool line's `ts_ns` (unix nanoseconds) is the only clock and there are no order pointers.
const RECORDED_AT_POINTER: &str = "/ts_ns";
const RECORDED_AT_ENCODING: &str = "unix_ns";

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
const SHARED_DDL: [&str; 6] = [
    "CREATE SCHEMA IF NOT EXISTS \"_ingest\"",
    "CREATE SEQUENCE IF NOT EXISTS _ingest.ingest_id_seq START 1",
    "CREATE SEQUENCE IF NOT EXISTS _ingest.event_id_seq START 1",
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
        recorded_at_pointer VARCHAR NOT NULL,
        recorded_at_encoding VARCHAR NOT NULL,
        order_pointers_json JSON NOT NULL,
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
    "CREATE OR REPLACE VIEW \"_ingest\".\"table_timeline\" AS
        SELECT source, topic, version, producer_type, duckdb_schema, valid_from, valid_to, superseded_by
        FROM \"_ingest\".\"producer_types\"",
];

fn err(ctx: &str, e: impl std::fmt::Display) -> String {
    format!("{ctx}: {e}")
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
fn macro_ddl(p: &Producer) -> String {
    let payload_cols: Vec<String> = p.columns.iter().map(|c| format!("payload.{q} AS {q}", q = qident(&c.name))).collect();
    format!(
        "CREATE MACRO {name}(path, ingest_id, ingested_at) AS TABLE
SELECT
    ingest_id AS \"_meta_ingest_id\",
    CAST(row_number() OVER () - 1 AS UBIGINT) AS \"_meta_record_ordinal\",
    CAST(ts_ns AS HUGEINT) AS \"_meta_recorded_at_ns\",
    make_timestamptz(ts_ns // 1000) AS \"_meta_recorded_at\",
    ingested_at AS \"_meta_ingested_at\",
    {cols}
FROM read_ndjson(path, columns = {reader}, ignore_errors = false, maximum_object_size = {MAX_OBJECT_BYTES})",
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
             schema_json, recorded_at_pointer, recorded_at_encoding, order_pointers_json, reader_columns_sql,
             compiler_version, digest_macro, valid_from, replaces_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?, CAST(? AS JSON), ?, ?, ?, CAST(? AS DATE), CAST(? AS JSON))",
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
            RECORDED_AT_POINTER,
            RECORDED_AT_ENCODING,
            "[]",
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
/// Ordered by the integer version, never by install order.
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
    for sql in SHARED_DDL {
        conn.execute_batch(sql).map_err(|e| err("catalog", e))?;
    }
    let mut installed = 0;
    let mut touched: BTreeSet<(&str, &str)> = BTreeSet::new();
    for p in producers {
        let existing: Option<String> = conn
            .query_row("SELECT schema_sha256 FROM _ingest.producer_types WHERE producer_type = ?", params![p.producer_type], |r| r.get(0))
            .optional()
            .map_err(|e| err(&p.producer_type, e))?;
        match existing {
            // Owner ruling D-A: a change is a new producer_type, never an edit.
            Some(sha) if sha != p.sha256 => {
                return Err(format!(
                    "producer {} is installed with schema sha256 {sha}, the manifest has {}; a change needs a new producer_type",
                    p.producer_type, p.sha256
                ))
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
/// installed with the same sha256 is a no-op; with a different sha256 the whole call fails and
/// writes nothing.
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

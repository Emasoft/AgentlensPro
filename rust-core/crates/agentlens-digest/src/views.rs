//! `aldigest views`: (re)generate every query-unification object of schema `u` from the catalog
//! (TRDD-LHCHVK9Z). Per source+topic: a view `u."<source>__<topic>"` that unions all installed
//! versions of the topic by name (renamed columns carry their canonical name, columns missing in
//! an old version are NULL), a table macro `u."<source>__<topic>_between"(t_from, t_to)` over
//! `[t_from, t_to)` of `_meta_recorded_at`, and per multi-topic source a view `u."<source>__all"`
//! joining its topics on (`_meta_ingest_id`, `_meta_record_ordinal`). Hence `__` may not occur in
//! a source or topic name (schema.rs). The generator is SQL (`views.sql`, sections split by the
//! `-- @@ name` marker lines) because it reads the catalog and DuckDB's own column types.
//!
//! Schema `u` is owned by this command: every run drops it with everything in it and recreates it
//! from the catalog, so anything a user creates in `u` is removed by the next run.

use crate::register::check_layout;
use crate::Res;
use duckdb::Connection;
use std::collections::BTreeSet;

const GENERATOR_SQL: &str = include_str!("views.sql");

/// What one run created.
#[derive(Debug, PartialEq, Eq)]
pub struct ViewsSummary {
    pub topic_views: usize,
    pub macros: usize,
    pub all_views: usize,
}

/// The body of section `name` of the generator file.
fn section(name: &str) -> Res<&'static str> {
    let marker = format!("-- @@ {name}\n");
    let start = GENERATOR_SQL.find(&marker).ok_or_else(|| format!("views.sql has no section {name}"))? + marker.len();
    let rest = &GENERATOR_SQL[start..];
    Ok(&rest[..rest.find("\n-- @@ ").map_or(rest.len(), |i| i + 1)])
}

/// The four sections `views` needs (prelude, A, B, C), checked once up front.
fn sections() -> Res<[&'static str; 4]> {
    Ok([section("prelude")?, section("A")?, section("B")?, section("C")?])
}

/// One generator row: (kind, source, topic, statement, error); exactly one of statement and error is set.
type Row = (String, String, Option<String>, Option<String>, Option<String>);

fn generate(conn: &Connection, name: &str, sql: &str) -> Res<Vec<Row>> {
    let mut stmt = conn.prepare(sql).map_err(|e| format!("views generator {name}: {e}"))?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).map_err(|e| format!("views generator {name}: {e}"))?;
    rows.collect::<Result<Vec<Row>, _>>().map_err(|e| format!("views generator {name}: {e}"))
}

/// Inside ONE transaction (so generation and execution see one catalog snapshot): generate every
/// statement, refuse the whole run if the generator reports any error row (it names source, topic
/// and column), drop schema `u` and recreate it, then execute topic views, macros and `__all`
/// views. Any failure rolls back, leaving the previous `u` intact; the generator temp objects are
/// created inside the transaction, so the rollback removes them too. Touches only schema `u`
/// (and temp objects of this connection), never `_ingest` or a producer table.
pub fn views(conn: &Connection) -> Res<ViewsSummary> {
    check_layout(conn)?;
    let [prelude, qa, qb, qc] = sections()?;
    conn.execute_batch("BEGIN").map_err(|e| format!("views: {e}"))?;
    let run = (|| -> Res<ViewsSummary> {
        conn.execute_batch(prelude).map_err(|e| format!("views generator prelude: {e}"))?;
        let (a, b, c) = (generate(conn, "A", qa)?, generate(conn, "B", qb)?, generate(conn, "C", qc)?);
        // Query A and B both return the topic errors: report each message once.
        let errors: BTreeSet<String> = a.iter().chain(&b).chain(&c).filter_map(|r| r.4.as_ref().map(|e| format!("{}.{}: {e}", r.1, r.2.as_deref().unwrap_or("*")))).collect();
        if !errors.is_empty() {
            return Err(format!("cannot generate the unified views, nothing was written:\n  {}", errors.into_iter().collect::<Vec<_>>().join("\n  ")));
        }
        let count = |rows: &[Row]| rows.iter().filter(|r| r.3.is_some()).count();
        let summary = ViewsSummary { topic_views: count(&a), macros: count(&b), all_views: count(&c) };
        // Drop first: a view, macro or `__all` view of a topic no longer in the catalog must not survive.
        conn.execute_batch("DROP SCHEMA IF EXISTS u CASCADE; CREATE SCHEMA u").map_err(|e| format!("views: {e}"))?;
        for stmt in a.iter().chain(&b).chain(&c).filter_map(|r| r.3.as_deref()) {
            conn.execute_batch(stmt).map_err(|e| format!("views: {e}\n  statement: {stmt}"))?;
        }
        Ok(summary)
    })();
    match run {
        Ok(summary) => {
            conn.execute_batch("COMMIT").map_err(|e| format!("views: commit: {e}"))?;
            Ok(summary)
        }
        // The statement error is the cause worth reporting; a failed rollback is appended, never hidden.
        Err(e) => Err(match conn.execute_batch("ROLLBACK") {
            Ok(()) => e,
            Err(r) => format!("{e}\n  rollback also failed: {r}"),
        }),
    }
}

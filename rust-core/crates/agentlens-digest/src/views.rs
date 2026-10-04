//! `aldigest views`: (re)generate every query-unification object of schema `u` from the catalog
//! (TRDD-LHCHVK9Z). Per source+topic: a view `u."<source>__<topic>"` that unions all installed
//! versions of the topic by name (renamed columns carry their canonical name, columns missing in
//! an old version are NULL), a table macro `u."<source>__<topic>_between"(t_from, t_to)` over
//! `[t_from, t_to)` of `_meta_recorded_at`, and per multi-topic source a view `u."<source>__all"`
//! joining its topics on (`_meta_ingest_id`, `_meta_record_ordinal`). Hence `__` may not occur in
//! a source or topic name (schema.rs). The generator is SQL (`views.sql`, sections split by the
//! `-- @@ name` marker lines) because it reads the catalog and DuckDB's own column types.

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
fn section(name: &str) -> &'static str {
    let marker = format!("-- @@ {name}\n");
    let start = GENERATOR_SQL.find(&marker).unwrap_or_else(|| panic!("views.sql has no section {name}")) + marker.len();
    let rest = &GENERATOR_SQL[start..];
    &rest[..rest.find("\n-- @@ ").map_or(rest.len(), |i| i + 1)]
}

/// One generator row: (kind, source, topic, statement, error); exactly one of statement and error is set.
type Row = (String, String, Option<String>, Option<String>, Option<String>);

fn generate(conn: &Connection, name: &str) -> Res<Vec<Row>> {
    let mut stmt = conn.prepare(section(name)).map_err(|e| format!("views generator {name}: {e}"))?;
    let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?))).map_err(|e| format!("views generator {name}: {e}"))?;
    rows.collect::<Result<Vec<Row>, _>>().map_err(|e| format!("views generator {name}: {e}"))
}

/// Generate every statement, refuse the whole run if the generator reports any error row (it
/// names source, topic and column), then execute topic views, macros and `__all` views in one
/// transaction. Idempotent (`CREATE OR REPLACE`); touches only schema `u` (and temp objects of
/// this connection), never `_ingest` or a producer table.
pub fn views(conn: &Connection) -> Res<ViewsSummary> {
    check_layout(conn)?;
    conn.execute_batch(section("prelude")).map_err(|e| format!("views generator prelude: {e}"))?;
    let (a, b, c) = (generate(conn, "A")?, generate(conn, "B")?, generate(conn, "C")?);
    // Query A and B both return the topic errors: report each message once.
    let errors: BTreeSet<String> = a.iter().chain(&b).chain(&c).filter_map(|r| r.4.as_ref().map(|e| format!("{}.{}: {e}", r.1, r.2.as_deref().unwrap_or("*")))).collect();
    if !errors.is_empty() {
        return Err(format!("cannot generate the unified views, nothing was written:\n  {}", errors.into_iter().collect::<Vec<_>>().join("\n  ")));
    }
    let count = |rows: &[Row]| rows.iter().filter(|r| r.3.is_some()).count();
    let summary = ViewsSummary { topic_views: count(&a), macros: count(&b), all_views: count(&c) };
    conn.execute_batch("BEGIN").map_err(|e| format!("views: {e}"))?;
    let run = (|| -> Res<()> {
        conn.execute_batch("CREATE SCHEMA IF NOT EXISTS u").map_err(|e| format!("views: {e}"))?;
        for stmt in a.iter().chain(&b).chain(&c).filter_map(|r| r.3.as_deref()) {
            conn.execute_batch(stmt).map_err(|e| format!("views: {e}\n  statement: {stmt}"))?;
        }
        Ok(())
    })();
    match run {
        Ok(()) => conn.execute_batch("COMMIT").map_err(|e| format!("views: commit: {e}"))?,
        Err(e) => {
            // The statement error is the cause worth reporting; a failed rollback is appended, never hidden.
            return Err(match conn.execute_batch("ROLLBACK") {
                Ok(()) => e,
                Err(r) => format!("{e}\n  rollback also failed: {r}"),
            });
        }
    }
    Ok(summary)
}

//! Port of src/store/bodiesEvidence.ts (TRDD-DMWOBWFH P4x.2h) — the COMPLETE evidence base for
//! raw-body diagnostics, and the unported prerequisite `cacheBreakTimeline` was blocked on.
//!
//! WHY IT EXISTS — measured, not theorized. `get_cache_break_timeline` used to list `*.request.json`
//! files in the spool and parse each one. Two consequences, both observed on 2026-08-13:
//!   1. VOLATILE EVIDENCE. The ingest drain deletes a raw file the moment the Parquet store provably
//!      holds its bytes, so a break event classifiable at 01:40 was GONE by 02:00 (one session's
//!      turn count visibly shrank 172 → 145 across two runs over identical history). The tool's
//!      answer depended on when you asked.
//!   2. WRONG COST SHAPE. Selecting one session's turns required reading EVERY file — 13.5 s of
//!      measured file reads for what is a millisecond column-pruned Parquet scan, because the
//!      `body` table carries `session_id` and `ts` as first-class columns.
//!
//! THE INVARIANT THAT MAKES THIS CORRECT: the delete gate ("verify-before-delete", USER directive
//! 2026-07-15) removes a spool file ONLY after the flushed store provably holds its exact bytes and
//! its (src_name, ts) row. So at every instant a captured body is in the SPOOL, or in the SEALED
//! PARQUET, or briefly in both — never in neither. The union queried here is complete BY
//! CONSTRUCTION. (Bodies ingested but not yet flushed sit in the store's in-memory staging, unseen
//! by a parquet-only reader, and that is fine: their spool file cannot have been deleted yet.)
//!
//! Division of labour: SELECTION is DuckDB over Parquet (pushdown on session/ts/kind — pay for what
//! you ask about); LOADING is per-body and CHUNKED, never the corpus (200 × ~881 KB is ~176 MB of
//! strings in one result set, the named memory risk of TRDD-KB17X5G2 and the standing suspect for
//! the server's silent RSS kills). Reconstruction re-proves byte identity against the stored sha256
//! on every load — and since the body_id IS that sha, the proof is end-to-end, not self-consistency.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use crate::sections::{reassemble, sha256_hex, Part};
use crate::{parquet_scan, BLOBS_DIR, BODIES_DIR, PARTS_DIR};

#[derive(Debug, Clone, PartialEq)]
pub struct EvidenceRow {
    pub src_name: String,
    /// sha256 of the original bytes for store rows; None for a spool row (not yet ingested/known).
    pub body_id: Option<String>,
    /// Known for store rows (a first-class Parquet column); None for spool rows — the spool file
    /// name is an opaque uuid, and reading the file to learn its session would reintroduce the
    /// exact read-everything cost this module removes. Callers filtering by session must KEEP the
    /// null rows and filter them after parsing; the drain keeps the spool small, so that cost is
    /// bounded by current inflow, never by history.
    pub session_id: Option<String>,
    pub ts_ms: Option<f64>,
    pub raw_bytes: f64,
    /// "request" | "response".
    pub kind: String,
    /// "store" | "spool".
    pub location: String,
}

#[derive(Debug, Clone, Default)]
pub struct EvidenceFilter {
    pub session_id: Option<String>,
    pub ts_from_ms: Option<f64>,
    pub ts_to_ms: Option<f64>,
    pub kind: Option<String>,
}

/// Single-quote a SQL literal. Every value reaching here is interpolated into DuckDB SQL, so the
/// doubling is the injection boundary — a src_name or session id is attacker-adjacent data.
fn sq(v: &str) -> String {
    format!("'{}'", v.replace('\'', "''"))
}

/// Fileless DuckDB, opened PER CALL. `:memory:` is not a preference — a persistent .duckdb measured
/// 300× write amplification. No temp_directory: an over-limit query must fail LOUDLY, never quietly
/// write gigabytes to the SSD. Opened per call because evidence queries are occasional and the
/// parquet metadata scan is milliseconds; a resident instance would hold RSS for nothing.
fn with_duck<T>(f: impl FnOnce(&duckdb::Connection) -> Result<T, String>) -> Result<T, String> {
    let con = duckdb::Connection::open_in_memory().map_err(|e| format!("duckdb open: {e}"))?;
    let mem = std::env::var("AGENTLENS_DUCKDB_MEMORY_LIMIT")
        .ok()
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "2GB".to_owned());
    for stmt in [
        format!("SET memory_limit = {}", sq(&mem)),
        "SET threads = 2".to_owned(),
        "SET temp_directory = ''".to_owned(),
        "SET preserve_insertion_order = false".to_owned(),
    ] {
        con.execute_batch(&stmt).map_err(|e| format!("duckdb {stmt}: {e}"))?;
    }
    f(&con)
}

/// Every column is read as a nullable STRING because DuckDB hands back mixed integer widths across
/// parquet parts written at different times — a typed getter that guesses `i64` fails at runtime on
/// the part that stored `i32`. `duckdb::types::Value` has no `Display`, so the widths are spelled
/// out; anything genuinely non-scalar becomes None rather than a debug-formatted lie.
fn cell_to_string(v: duckdb::types::ValueRef<'_>) -> Option<String> {
    use duckdb::types::ValueRef as V;
    match v {
        V::Null => None,
        V::Text(t) | V::Blob(t) => Some(String::from_utf8_lossy(t).into_owned()),
        V::Boolean(b) => Some(b.to_string()),
        V::TinyInt(n) => Some(n.to_string()),
        V::SmallInt(n) => Some(n.to_string()),
        V::Int(n) => Some(n.to_string()),
        V::BigInt(n) => Some(n.to_string()),
        V::HugeInt(n) => Some(n.to_string()),
        V::UTinyInt(n) => Some(n.to_string()),
        V::USmallInt(n) => Some(n.to_string()),
        V::UInt(n) => Some(n.to_string()),
        V::UBigInt(n) => Some(n.to_string()),
        V::Float(n) => Some(n.to_string()),
        V::Double(n) => Some(n.to_string()),
        V::Timestamp(_, n) => Some(n.to_string()),
        _ => None,
    }
}

fn query_rows(con: &duckdb::Connection, sql: &str, cols: usize) -> Result<Vec<Vec<Option<String>>>, String> {
    let mut stmt = con.prepare(sql).map_err(|e| format!("duckdb prepare: {e}"))?;
    let mut rows = stmt.query([]).map_err(|e| format!("duckdb query: {e}"))?;
    let mut out = Vec::new();
    // Read every column as a nullable string: DuckDB hands back mixed integer widths across
    // parquet parts, and a typed getter that guesses wrong fails at runtime on the OTHER part.
    while let Some(r) = rows.next().map_err(|e| format!("duckdb next: {e}"))? {
        let mut vals = Vec::with_capacity(cols);
        for i in 0..cols {
            vals.push(r.get_ref(i).ok().and_then(cell_to_string));
        }
        out.push(vals);
    }
    Ok(out)
}

/// Every body the diagnostics may reason about, selected by pushdown where the columns exist.
///
/// Store rows come pre-filtered by DuckDB; spool rows are appended UNFILTERED on session/ts (their
/// metadata is unknown until parsed) except for `kind`, which the file suffix carries. A body
/// present in both places yields ONE row — the store one, whose metadata is richer and whose bytes
/// are proven — so a caller never double-counts a turn mid-drain.
pub fn list_body_evidence(
    store_dir: &Path,
    spool_dir: Option<&Path>,
    f: &EvidenceFilter,
) -> Result<Vec<EvidenceRow>, String> {
    let mut rows: Vec<EvidenceRow> = Vec::new();
    if let Some(scan) = parquet_scan(store_dir, BODIES_DIR) {
        let mut where_parts: Vec<String> = Vec::new();
        if let Some(s) = &f.session_id {
            where_parts.push(format!("session_id = {}", sq(s)));
        }
        if let Some(k) = &f.kind {
            where_parts.push(format!("kind = {}", sq(k)));
        }
        if let Some(t) = f.ts_from_ms {
            where_parts.push(format!("ts >= epoch_ms({})", t.floor()));
        }
        if let Some(t) = f.ts_to_ms {
            where_parts.push(format!("ts <= epoch_ms({})", t.floor()));
        }
        let where_sql =
            if where_parts.is_empty() { String::new() } else { format!("WHERE {}", where_parts.join(" AND ")) };
        let sql = format!(
            "SELECT src_name, body_id, session_id, epoch_ms(ts) AS ts_ms, raw_bytes, kind FROM {scan} {where_sql}"
        );
        for r in with_duck(|con| query_rows(con, &sql, 6))? {
            rows.push(EvidenceRow {
                src_name: r[0].clone().unwrap_or_default(),
                // NOT null-guarded, matching the TS `String(r.body_id)` — a store row without a
                // body_id is a corrupt store, and turning it into None here would hide that behind
                // a later "needs resolution" path instead of failing where it happened.
                body_id: Some(r[1].clone().unwrap_or_else(|| "null".to_owned())),
                session_id: r[2].clone(),
                ts_ms: r[3].as_ref().and_then(|s| s.parse::<f64>().ok()),
                raw_bytes: r[4].as_ref().and_then(|s| s.parse::<f64>().ok()).unwrap_or(0.0),
                kind: if r[5].as_deref() == Some("response") { "response" } else { "request" }.to_owned(),
                location: "store".to_owned(),
            });
        }
    }
    if let Some(spool) = spool_dir {
        // Built from the rows we KEPT, so a body filtered out of the store half can still be
        // appended from the spool. That is the TS behaviour and it is the conservative one: a row
        // the filter excluded is not evidence that the spool copy is a duplicate of a kept row.
        let in_store: HashSet<String> = rows.iter().map(|r| r.src_name.clone()).collect();
        let names: Vec<String> = match std::fs::read_dir(spool) {
            Ok(rd) => rd.flatten().map(|e| e.file_name().to_string_lossy().into_owned()).collect(),
            Err(_) => Vec::new(), // no spool = an empty half, not an error
        };
        for name in names {
            // A name carrying NEITHER marker falls through to "request" — the TS ternary's final
            // branch, not an oversight.
            let kind = if name.contains(".response.") { "response" } else { "request" };
            if !name.ends_with(".json") || in_store.contains(&name) {
                continue;
            }
            if f.kind.as_deref().is_some_and(|k| k != kind) {
                continue;
            }
            let Ok(md) = std::fs::metadata(spool.join(&name)) else { continue }; // drained mid-list
            rows.push(EvidenceRow {
                src_name: name,
                body_id: None,
                session_id: None,
                ts_ms: None,
                raw_bytes: md.len() as f64,
                kind: kind.to_owned(),
                location: "spool".to_owned(),
            });
        }
    }
    Ok(rows)
}

/// Load the selected bodies' raw text, src_name → bytes-as-string.
///
/// Spool rows are plain reads; a file drained BETWEEN list and load falls through to the store by
/// name (the delete gate guarantees it arrived there first) rather than failing — that race is
/// routine, not exceptional. Store rows reconstruct in CHUNKS of `chunk` bodies (default 32, the
/// bound TRDD-KB17X5G2 measured against ~176 MB single-result blowups), each proven against its
/// sha256 before it is handed back. A body that fails its proof is an ERROR: handing back bytes we
/// cannot prove are the original would quietly poison every diagnosis built on them.
///
/// `selection` is `&mut` because the TS mutates the caller's rows in place when it resolves a
/// fallen-through spool row's body_id.
pub fn load_body_texts(
    store_dir: &Path,
    spool_dir: Option<&Path>,
    selection: &mut [EvidenceRow],
    chunk: usize,
) -> Result<HashMap<String, String>, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    let mut from_store: Vec<usize> = Vec::new();
    for (i, row) in selection.iter().enumerate() {
        if row.location == "spool" {
            if let Some(spool) = spool_dir {
                if let Ok(text) = std::fs::read_to_string(spool.join(&row.src_name)) {
                    out.insert(row.src_name.clone(), text);
                    continue;
                }
                // drained since listing — the store must hold it now; fall through
            }
        }
        from_store.push(i);
    }
    if from_store.is_empty() {
        return Ok(out);
    }

    let part_scan = parquet_scan(store_dir, PARTS_DIR);
    let blob_scan = parquet_scan(store_dir, BLOBS_DIR);
    let body_scan = parquet_scan(store_dir, BODIES_DIR);
    let (Some(part_scan), Some(body_scan)) = (part_scan, body_scan) else {
        return Err(format!(
            "bodiesEvidence: {} body(ies) need the store but {} has no sealed parts",
            from_store.len(),
            store_dir.display()
        ));
    };

    with_duck(|con| {
        // A spool row that fell through carries no body_id — resolve it by src_name first.
        let unresolved: Vec<usize> = from_store.iter().copied().filter(|i| selection[*i].body_id.is_none()).collect();
        if !unresolved.is_empty() {
            let names = unresolved.iter().map(|i| sq(&selection[*i].src_name)).collect::<Vec<_>>().join(",");
            let got = query_rows(
                con,
                &format!("SELECT src_name, body_id FROM {body_scan} WHERE src_name IN ({names})"),
                2,
            )?;
            let by_name: HashMap<String, String> = got
                .iter()
                .filter_map(|r| Some((r[0].clone()?, r[1].clone().unwrap_or_else(|| "null".to_owned()))))
                .collect();
            for i in unresolved {
                // Neither place holds it ⇒ the verify-before-delete invariant is broken. Refusing
                // here is the point: continuing would silently drop evidence and every downstream
                // count would be quietly short.
                let id = by_name.get(&selection[i].src_name).ok_or_else(|| {
                    format!(
                        "bodiesEvidence: {} is in neither the spool nor the store — the verify-before-delete invariant is broken, refuse to continue",
                        selection[i].src_name
                    )
                })?;
                selection[i].body_id = Some(id.clone());
            }
        }
        for batch in from_store.chunks(chunk.max(1)) {
            let ids = batch
                .iter()
                .map(|i| sq(selection[*i].body_id.as_deref().unwrap_or("")))
                .collect::<Vec<_>>()
                .join(",");
            let parts = query_rows(
                con,
                &format!("SELECT body_id, pos, kind, lit, sha FROM {part_scan} WHERE body_id IN ({ids}) ORDER BY body_id, pos"),
                5,
            )?;
            let shas: Vec<String> = {
                let mut seen: Vec<String> = Vec::new();
                for p in &parts {
                    if let Some(s) = &p[4] {
                        if !seen.contains(s) {
                            seen.push(s.clone());
                        }
                    }
                }
                seen
            };
            let mut spans: HashMap<String, String> = HashMap::new();
            if !shas.is_empty() {
                if let Some(bs) = &blob_scan {
                    let list = shas.iter().map(|s| sq(s)).collect::<Vec<_>>().join(",");
                    for g in query_rows(con, &format!("SELECT sha, data FROM {bs} WHERE sha IN ({list})"), 2)? {
                        if let (Some(sha), Some(data)) = (g[0].clone(), g[1].clone()) {
                            spans.insert(sha, data);
                        }
                    }
                }
            }
            let mut by_body: HashMap<String, Vec<Part>> = HashMap::new();
            for p in &parts {
                let body_id = p[0].clone().unwrap_or_default();
                let part = if p[2].as_deref() == Some("lit") {
                    Part::Lit { text: p[3].clone().unwrap_or_default() }
                } else {
                    // n/path/idx are placeholders: reassemble only ever reads `sha`, and the real
                    // values live in the parquet the blob was loaded from.
                    Part::Blob { sha: p[4].clone().unwrap_or_default(), n: 0, path: String::new(), idx: -1 }
                };
                by_body.entry(body_id).or_default().push(part);
            }
            for i in batch {
                let row_body_id = selection[*i].body_id.clone().unwrap_or_default();
                let part_list = by_body.get(&row_body_id).ok_or_else(|| {
                    format!("bodiesEvidence: store has no parts for {} ({row_body_id})", selection[*i].src_name)
                })?;
                let raw = reassemble(part_list, |sha| spans.get(sha).cloned())?;
                // The body_id IS the sha of the original bytes, so this proves the round trip
                // end-to-end rather than merely self-consistent.
                if sha256_hex(&raw) != row_body_id {
                    return Err(format!(
                        "RECONSTRUCTION MISMATCH for {} — the store cannot return what it was given",
                        selection[*i].src_name
                    ));
                }
                out.insert(selection[*i].src_name.clone(), raw);
            }
        }
        Ok(())
    })?;
    Ok(out)
}

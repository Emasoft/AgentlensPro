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
//! - `SET temp_directory=''` — an over-limit query FAILS instead of silently spilling GBs.
//! - parquet reads use `union_by_name := true` AND staging unions use `UNION ALL BY NAME`
//!   (TRDD-219K7C1N: two schema generations otherwise silently drop or loudly break columns).
//! - GATE 1: a body must reconstruct byte-identically BEFORE anything is written; GATE 2:
//!   re-ingesting the same bytes writes nothing (the `known` sha set reloads from durable
//!   parts at open).

pub mod pass;
pub mod bodies_evidence;
pub mod sections;

use std::collections::HashSet;
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
pub const DEFAULT_MEMORY_LIMIT: &str = "8GB";
pub const TS_TOLERANCE_MS: i64 = 2000;

pub struct Store {
    pub con: Connection,
    pub dir: PathBuf,
    /// sha256 of every span already durable — the cross-part dedup set (Parquet has no
    /// cross-file content addressing, so the dedup is OURS).
    pub known: HashSet<String>,
    /// Every body_id with at least one row, and every (body_id, src_name) pair — the same
    /// seed-once-then-mutate design as `known`, and for the same measured reason: an
    /// `all_of("body")` query re-binds the full parquet file LIST (4,215 files on the real
    /// store, ~seconds per query), so per-body existence probes made a 1,300-file pass take
    /// an hour instead of a minute (2026-08-18 live runaway, TRDD-DMWOBWFH P4b).
    body_ids: HashSet<String>,
    bodies_named: HashSet<String>,
    next_part: u64,
}

/// Key for `bodies_named` — 0x1F separator: cannot appear in a hex body_id and no writer of
/// ours puts control chars in a body filename.
fn named_key(body_id: &str, src_name: &str) -> String {
    format!("{body_id}\u{1f}{src_name}")
}

fn q(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
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
        .map(q)
        .collect::<Vec<_>>()
        .join(",");
    Some(format!("read_parquet([{list}], union_by_name := true)"))
}

/// Durable parts + staging as one relation — `UNION ALL BY NAME` (see module doc).
pub fn all_of(store: &Store, table: &str) -> String {
    if table == "body" {
        // The bodies corpus lives in the native `body_durable` mirror (open-time load +
        // flush read-back appends), so its full view never touches parquet — see open_store.
        return "(SELECT * FROM body_durable UNION ALL BY NAME SELECT * FROM body)".to_owned();
    }
    let sub = match table {
        "blob" => BLOBS_DIR,
        "body" => BODIES_DIR,
        _ => PARTS_DIR,
    };
    match parquet_scan(&store.dir, sub) {
        Some(scan) => format!("(SELECT * FROM {scan} UNION ALL BY NAME SELECT * FROM {table})"),
        None => format!("(SELECT * FROM {table})"),
    }
}

pub fn open_store(dir: &Path, memory_limit: &str, threads: usize) -> duckdb::Result<Store> {
    for sub in [BLOBS_DIR, BODIES_DIR, PARTS_DIR] {
        let _ = fs::create_dir_all(dir.join(sub));
    }
    let con = Connection::open_in_memory()?;
    con.execute_batch(&format!(
        "SET memory_limit = '{memory_limit}';
         SET threads = {threads};
         SET temp_directory = '';
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
         );"
    ))?;
    let mut known = HashSet::new();
    if let Some(scan) = parquet_scan(dir, BLOBS_DIR) {
        let mut stmt = con.prepare(&format!("SELECT DISTINCT sha FROM {scan}"))?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
        for r in rows.flatten() {
            known.insert(r);
        }
    }
    // `body_durable` — a native mirror of the bodies parquet corpus, loaded ONCE here and kept
    // current by flush's read-back append. Body rows are small metadata, so this is the cheap
    // trade that lets all_of("body") skip the parquet corpus on every later query (a full-scan
    // class of the 2026-08-18 17-minute pass). Cloned from the staging schema, then loaded
    // BY NAME so parts from an older schema generation fill absent columns with NULL
    // (TRDD-219K7C1N: BY NAME, never positional).
    con.execute_batch("CREATE TABLE body_durable AS SELECT * FROM body WHERE 1=0;")?;
    if let Some(scan) = parquet_scan(dir, BODIES_DIR) {
        con.execute_batch(&format!("INSERT INTO body_durable BY NAME SELECT * FROM {scan};"))?;
    }
    let mut body_ids = HashSet::new();
    let mut bodies_named = HashSet::new();
    {
        let mut stmt = con.prepare("SELECT DISTINCT body_id, src_name FROM body_durable")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
        for (id, name) in rows.flatten() {
            bodies_named.insert(named_key(&id, &name));
            body_ids.insert(id);
        }
    }
    Ok(Store { con, dir: dir.to_path_buf(), known, body_ids, bodies_named, next_part: 0 })
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
pub fn flush_detailed(store: &mut Store) -> Result<FlushResult, String> {
    let n = count(store, "blob").map_err(|e| e.to_string())?;
    let bodies = count(store, "body").map_err(|e| e.to_string())?;
    if n == 0 && bodies == 0 {
        return Ok(FlushResult::default());
    }
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tag = format!("part-{now_ms}-{}-{}.parquet", std::process::id(), store.next_part);
    store.next_part += 1;
    let mut part_paths = Vec::new();
    for (table, sub) in [("blob", BLOBS_DIR), ("body", BODIES_DIR), ("part", PARTS_DIR)] {
        let c = count(store, table).map_err(|e| e.to_string())?;
        if c == 0 {
            continue;
        }
        let out = store.dir.join(sub).join(&tag);
        // Defence in depth behind the unique name: COPY TO silently overwrites.
        if out.exists() {
            return Err(format!("refusing to overwrite existing part {} — part naming must be collision-free", out.display()));
        }
        let out_str = out.to_str().ok_or("non-utf8 store path")?;
        // The body table is additionally MIRRORED into the native `body_durable` by READING BACK
        // the parquet just written — the read-back is the encoding proof (the flushed part
        // parses to rows), durability stays the fsync barrier's job, and all_of("body") never
        // has to scan the parquet corpus again (the third full-scan class of the 2026-08-18
        // 17-minute pass). Mirror BEFORE the staging DELETE so a read-back failure leaves the
        // staging rows in place and fails the flush loudly.
        let mirror = if table == "body" {
            format!(
                "INSERT INTO body_durable BY NAME SELECT * FROM read_parquet([{}], union_by_name := true); ",
                q(out_str)
            )
        } else {
            String::new()
        };
        store
            .con
            .execute_batch(&format!(
                "COPY {table} TO {} (FORMAT PARQUET, COMPRESSION ZSTD); {mirror}DELETE FROM {table};",
                q(out_str)
            ))
            .map_err(|e| e.to_string())?;
        part_paths.push(out);
    }
    Ok(FlushResult { n, part_paths })
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
fn extract_meta(raw: &str, src_name: &str) -> (Option<String>, Option<String>, &'static str) {
    let kind = if src_name.contains(".response.") { "response" } else { "request" };
    let mut session_id = None;
    let mut model = None;
    if let Ok(d) = serde_json::from_str::<serde_json::Value>(raw) {
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

fn append_body_row(store: &mut Store, body_id: &str, src_name: &str, raw: &str, raw_bytes: u64, ts_ms: i64) -> Result<(), String> {
    let (session_id, model, kind) = extract_meta(raw, src_name);
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
    // The in-memory sets are the ONLY existence probes ingest uses (never an all_of query —
    // see the field doc), so a row and its set entries must be written together, here.
    store.body_ids.insert(body_id.to_owned());
    store.bodies_named.insert(named_key(body_id, src_name));
    Ok(())
}

/// ingestBody: idempotent, and GATE 1 — refuses anything that does not reconstruct
/// byte-identically BEFORE a single row is written.
pub fn ingest_body(store: &mut Store, src_name: &str, raw: &str, ts_ms: i64) -> Result<IngestResult, String> {
    let body_id = body_id_of(raw);
    let raw_bytes = raw.len() as u64;

    if store.body_ids.contains(&body_id) {
        // Content dedup — but each capture event still gets its own (src_name, ts) body row.
        if !store.bodies_named.contains(&named_key(&body_id, src_name)) {
            append_body_row(store, &body_id, src_name, raw, raw_bytes, ts_ms)?;
        }
        return Ok(IngestResult { body_id, raw_bytes, new_blobs: 0, new_bytes: 0, existed: true });
    }

    let sec = sectionize(raw)?;
    // GATE 1 — prove reconstruction BEFORE anything is written.
    let rebuilt = reassemble(&sec.parts, |sha| sec.blobs.get(sha).cloned())?;
    if sha256_hex(&rebuilt) != sha256_hex(raw) {
        return Err(format!("refusing to store {src_name}: it does not reconstruct byte-identically"));
    }

    let mut new_blobs = 0u64;
    let mut new_bytes = 0u64;
    {
        let mut app = store.con.appender("blob").map_err(|e| e.to_string())?;
        for sha in &sec.blob_order {
            if store.known.contains(sha) {
                continue;
            }
            store.known.insert(sha.clone());
            let span = &sec.blobs[sha];
            app.append_row(duckdb::params![sha, span.len() as i32, span]).map_err(|e| e.to_string())?;
            new_blobs += 1;
            new_bytes += span.len() as u64;
        }
        app.flush().map_err(|e| e.to_string())?;
    }

    append_body_row(store, &body_id, src_name, raw, raw_bytes, ts_ms)?;

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

/// reconstructBody: reads ONLY this body's parts + their blobs; the sha256 gate is end-to-end
/// (body_id IS the hash of the original bytes).
pub fn reconstruct_body(store: &Store, body_id: &str) -> Result<String, String> {
    let sql = format!(
        "SELECT pos, kind, lit, sha FROM {} WHERE body_id = {} ORDER BY pos",
        all_of(store, "part"),
        q(body_id)
    );
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
        let list = shas.iter().map(|s| q(s)).collect::<Vec<_>>().join(",");
        let sql = format!("SELECT sha, data FROM {} WHERE sha IN ({list})", all_of(store, "blob"));
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

fn reconstruct_chunk(
    store: &Store,
    ids: &[&String],
    span_cache: &mut SpanCache,
) -> Result<std::collections::HashMap<String, Result<String, String>>, String> {
    let list = ids.iter().map(|s| q(s)).collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT body_id, kind, lit, sha FROM {} WHERE body_id IN ({list}) ORDER BY body_id, pos",
        all_of(store, "part")
    );
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
        let list = shas.iter().map(|s| q(s)).collect::<Vec<_>>().join(",");
        let sql = format!("SELECT sha, data FROM {} WHERE sha IN ({list})", all_of(store, "blob"));
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

pub struct VerifyItem {
    pub src_name: String,
    pub raw: String,
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
    let mut results = std::collections::HashMap::new();
    if items.is_empty() {
        return Ok(results);
    }
    let with_ids: Vec<(&VerifyItem, String)> = items.iter().map(|it| (it, body_id_of(&it.raw))).collect();

    // ROW+TS — one VALUES-join query for the whole batch.
    let values = with_ids
        .iter()
        .map(|(it, id)| format!("({}, {})", q(id), q(&it.src_name)))
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
                    results.insert(it.src_name.clone(), VerifyResult { ok: false, reason: Some(format!("{}: {e}", it.src_name)) });
                    continue;
                }
                Ok(back) => {
                    if sha256_hex(back) != sha256_hex(&it.raw) {
                        results.insert(
                            it.src_name.clone(),
                            VerifyResult { ok: false, reason: Some(format!("{}: reconstruction != source bytes", it.src_name)) },
                        );
                        continue;
                    }
                }
            }
            let Some(&ts_ms) = row_map.get(&format!("{} {}", body_id, it.src_name)) else {
                results.insert(
                    it.src_name.clone(),
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
                        it.src_name.clone(),
                        VerifyResult { ok: false, reason: Some(format!("{}: stored ts {ts_ms} != capture time {want}", it.src_name)) },
                    );
                    continue;
                }
            }
            results.insert(it.src_name.clone(), VerifyResult { ok: true, reason: None });
        }
    }
    Ok(results)
}


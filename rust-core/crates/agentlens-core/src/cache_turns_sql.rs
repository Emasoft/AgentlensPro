//! cache_turns_sql — the api_calls + statusline join views (TRDD-GVA8TTJF).
//!
//! Three pure relation builders + one query entry, mirroring statusline_store's patterns:
//! `relation_for` (sealed parts UNION ALL BY NAME live WALs, VARCHAR-sealed), `open_duck`
//! (in-memory + spill), `query_statusline` (CTE-named entry). open_duck/varchar_session_id are
//! fn-private in statusline_store — the 4-15 line forms are duplicated here with citation, the
//! established pattern for cross-module SQL helpers.
//!
//! THE JOIN: statusline samples (one row per ~3s tick) join api_calls (one coalesced row per
//! LLM call) on session_id + |ts_ms - ts| <= 60_000. The card's WHAT names "4 raw token-bucket
//! columns" as join keys too — READ AS DEVIATION: the statusline's current_usage_* are per-tick
//! cumulative views, not the api_call's per-request buckets; a 4-column token equality join
//! would over-constrain to near-zero matches. Session+time is the join; tokens are the PAYLOAD.
//!
//! PAIRING (request ↔ response) goes through the body-links DeltaLog (TRDD-N6A8VX3G): rows carry
//! request_body_id / span_id on BOTH sides. Pre-2.1.274 traffic has request_body_id = '' on BOTH
//! kinds, so every equality join on it MUST carry <> '' guards — '' matches '' across DIFFERENT
//! calls (NULL would have been join-safe; the guard is the named defect of the row format).
//!
//! stem BRIDGE: a link row's `stem` is body_ref — an ABSOLUTE PATH (rawBodyContext.ts:35);
//! an api_call row's `stem` is the bare filename stem (pass.rs feeds file_name(); stem_of
//! strips .request.json/.response.json). DuckDB parse_filename(link.stem, true) extracts the
//! bare stem; a path-less body_ref (inline bodies) yields NULL → the row drops out of the
//! coalesce, honestly.
//!
//! NO device_id/account_uuid anywhere (no-identities doctrine).

use std::collections::HashMap;
use std::path::Path;

use serde_json::{Map, Value};

use agentlens_store::duckdb::Connection;

/// Copy of statusline_store::varchar_session_id (fn-private there): cast session_id to VARCHAR
/// PER FILE before any union — DuckDB infers UUID per file and one non-UUID id kills the union.
fn varchar_session_id(inner: &str) -> String {
    format!("SELECT * REPLACE (CAST(session_id AS VARCHAR) AS session_id) FROM ({inner})")
}

/// Copy of statusline_store::open_duck (fn-private there): ':memory:' is measured (a persistent
/// .duckdb showed 300x write amplification); over-limit queries spill instead of ballooning.
fn open_duck(spill_root: &Path, vars: &HashMap<String, String>) -> Result<Connection, String> {
    let con = Connection::open_in_memory().map_err(|e| e.to_string())?;
    let limit = vars
        .get("AGENTLENS_DUCKDB_MEMORY_LIMIT")
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .unwrap_or(agentlens_store::SERVER_MEMORY_LIMIT);
    let spill = agentlens_store::spill_sql(&spill_root.join(agentlens_store::TMP_DIR))
        .map_err(|e| format!("cache-turns spill dir: {e}"))?;
    con.execute_batch(&format!(
        "SET memory_limit='{}'; SET threads=2; {spill} SET preserve_insertion_order=false;",
        limit.replace('\'', "''")
    ))
    .map_err(|e| e.to_string())?;
    Ok(con)
}

/// The table `install_body_links` creates in the query's connection and `api_calls_relation`
/// reads. The connection is ':memory:' (open_duck), so the table dies with it.
const BODY_LINKS_TABLE: &str = "body_links";

/// The 8 fields of a body-links record (lib.rs body_link_row), in the table's column order.
const BODY_LINK_FIELDS: [&str; 8] =
    ["session_id", "span_id", "kind", "stem", "request_id", "request_body_id", "message_id", "ts_ms"];

/// Materialize the body-links DeltaLog (TRDD-N6A8VX3G) into `con` as table `body_links`, every
/// column VARCHAR at creation. MUST run on the connection before any SQL that embeds
/// `api_calls_relation` (both query entries below do it right after open_duck).
///
/// WHY replay in Rust (review B1, TRDD-GVA8TTJF): the files hold `{"k":key,"v":record}` lines and
/// `{"k":key,"d":1}` tombstones, and later lines win (delta_log.rs module doc). DeltaLog::load is
/// DeltaLog::replay over [snapshot, delta] in file and line order — the ONE definition of how lines
/// become state. Reading the files with read_ndjson_auto instead got all of it wrong: `v` comes back
/// as a STRUCT (binding `t.session_id` is a Binder Error on any real file), every superseded and
/// tombstoned line is still a row, and there is no line-number column, so a last-wins ROW_NUMBER
/// "ordered by line" has no sound order under a parallel scan — and it would be a second source of
/// truth drifting from replay.
/// WHY VARCHAR at creation (review B2): read_ndjson_auto infers UUID per file, and real session_ids
/// and request_body_ids ARE UUIDs; a UUID column then fails `COALESCE` against the VARCHAR api_call
/// side (Binder Error) and the `<> ''` guards (Conversion Error). A column declared VARCHAR leaves
/// nothing to infer. ts_ms is cast to BIGINT once, in the projection.
/// Errors surface: load() tolerates ONE torn trailing line (a concurrent append in flight) and
/// refuses a corrupt line anywhere else — that Err fails the query, never an empty table.
fn install_body_links(con: &Connection, data_dir: &Path) -> Result<(), String> {
    let records = crate::delta_log::DeltaLog::new(data_dir, "body-links").load()?;
    let cols = BODY_LINK_FIELDS.iter().map(|f| format!("{f} VARCHAR")).collect::<Vec<_>>().join(", ");
    con.execute_batch(&format!("CREATE TABLE {BODY_LINKS_TABLE} ({cols});"))
        .map_err(|e| e.to_string())?;
    let mut app = con.appender(BODY_LINKS_TABLE).map_err(|e| e.to_string())?;
    for v in records.values() {
        let row: Vec<Option<String>> = BODY_LINK_FIELDS
            .iter()
            .map(|f| match v.get(*f) {
                None | Some(Value::Null) => None,
                Some(Value::String(s)) => Some(s.clone()),
                // ts_ms is a JSON number; its decimal text casts back to BIGINT in the projection.
                Some(other) => Some(other.to_string()),
            })
            .collect();
        app.append_row(agentlens_store::duckdb::appender_params_from_iter(row)).map_err(|e| e.to_string())?;
    }
    app.flush().map_err(|e| e.to_string())
}

/// The api_calls COALESCED relation — one row per CALL: request facts (fingerprints, billing) + response facts (token buckets, miss reason), session_id resolved for BOTH kinds via the link table. None when no api_call parquet parts exist (blind, never a bare glob).
/// The SQL reads table `body_links`: run it only on a connection install_body_links has prepared.
pub fn api_calls_relation(store_dir: &Path) -> Option<String> {
    let parts = agentlens_store::parquet_scan(store_dir, agentlens_store::API_CALLS_DIR)?;
    // A5 (QSFYIHUO step 2): SELECT * over the parts projection named — the coalesce below reads
    // only these 21 columns, and naming them keeps the api_calls view narrow as the row grows.
    // prefix_json is deliberately excluded (nothing in this view consumes it); so are
    // cache_missed_input_tokens and service_tier (pre-existing wide columns this view never read).
    const API_VIEW_COLUMNS: &str = "stem, kind, ts_ms, model, session_id, system_fps, tools_fp, \
         first_user_fp, breakpoint_positions, billing_header, cc_prev_req, previous_message_id, \
         cache_read_tokens, cache_creation_tokens, cache_miss_reason, input_tokens, output_tokens, \
         tier_5m_tokens, tier_1h_tokens, stop_reason, msg_id";
    let parts = varchar_session_id(&format!("SELECT {API_VIEW_COLUMNS} FROM {parts}"));
    // The link side reads the table install_body_links created on the query's connection: one row
    // per LIVE key (DeltaLog replay — last line wins, tombstones dropped), every column VARCHAR.
    // No links ever written ⇒ the table is empty, and the coalesce still yields request rows with
    // their OWN session_id and response rows with none.
    let links = format!(
        "SELECT session_id AS link_session_id, span_id AS link_span_id, kind AS link_kind, \
         stem AS link_stem, request_id AS link_request_id, request_body_id AS link_rbid, \
         message_id AS link_msg_id, CAST(ts_ms AS BIGINT) AS link_ts FROM {BODY_LINKS_TABLE}"
    );
    // Pair request-kind links to response-kind links, request_body_id FIRST (exact key,
    // CC >=2.1.274), else span_id. EVERY guarded key carries <> '' — pre-2.1.274 traffic has
    // '' on both kinds and '' = '' would cross-match different calls.
    let pairs = format!(
        "WITH links AS ({links}), \
         req_links AS (SELECT * FROM links WHERE link_kind = 'request'), \
         resp_links AS (SELECT * FROM links WHERE link_kind = 'response'), \
         pairs AS ( \
           SELECT r.link_session_id AS session_id, r.link_span_id AS req_span, s.link_span_id AS resp_span, \
                  regexp_replace(parse_filename(r.link_stem, true), '\\.(request|response)$', '') AS req_stem, regexp_replace(parse_filename(s.link_stem, true), '\\.(request|response)$', '') AS resp_stem, \
                  s.link_request_id, s.link_msg_id, s.link_ts \
           FROM resp_links s JOIN req_links r \
             ON (s.link_rbid <> '' AND s.link_rbid = r.link_rbid) \
             OR (COALESCE(s.link_rbid,'') = '' AND s.link_span_id <> '' AND s.link_span_id = r.link_span_id) \
         )"
    );

    Some(format!(
        "{pairs}, \
         api_parts AS ({parts}), \
         reqs AS (SELECT * FROM api_parts WHERE kind = 'request'), \
         resps AS (SELECT * FROM api_parts WHERE kind = 'response'), \
         calls AS ( \
           SELECT \
             req.stem AS call_stem, \
             COALESCE(req.session_id, pr.session_id) AS session_id, \
             req.ts_ms AS ts_ms, \
             req.model AS model, \
             resp.cache_read_tokens, resp.cache_creation_tokens, resp.cache_miss_reason, \
             resp.input_tokens, resp.output_tokens, resp.tier_5m_tokens, resp.tier_1h_tokens, \
             resp.stop_reason, resp.msg_id, \
             req.system_fps, req.tools_fp, req.first_user_fp, req.breakpoint_positions, \
             req.billing_header, req.cc_prev_req, req.previous_message_id, \
             true AS request_paired, resp.stem IS NOT NULL AS response_paired, \
             pr.link_request_id, pr.link_msg_id \
           FROM reqs req            LEFT JOIN pairs pr ON pr.req_stem = req.stem            LEFT JOIN resps resp ON resp.stem = pr.resp_stem \
           UNION ALL BY NAME            SELECT \
             resp.stem AS call_stem, \
             COALESCE(resp.session_id, rl.link_session_id) AS session_id, \
             resp.ts_ms AS ts_ms, resp.model AS model, \
             resp.cache_read_tokens, resp.cache_creation_tokens, resp.cache_miss_reason, \
             resp.input_tokens, resp.output_tokens, resp.tier_5m_tokens, resp.tier_1h_tokens, \
             resp.stop_reason, resp.msg_id, \
             NULL::VARCHAR AS system_fps, NULL::VARCHAR AS tools_fp, NULL::VARCHAR AS first_user_fp, \
             NULL::VARCHAR AS breakpoint_positions, NULL::VARCHAR AS billing_header, \
             NULL::VARCHAR AS cc_prev_req, NULL::VARCHAR AS previous_message_id, \
             false AS request_paired, false AS response_paired, \
             rl.link_request_id, rl.link_msg_id \
           FROM resps resp            LEFT JOIN pairs pr ON pr.resp_stem = resp.stem            LEFT JOIN (SELECT link_stem, link_request_id, link_msg_id, link_session_id FROM links WHERE link_kind = 'response') rl \
             ON regexp_replace(parse_filename(rl.link_stem, true), '\\.(request|response)$', '') = resp.stem \
           WHERE pr.resp_stem IS NULL \
         ) \
         SELECT * FROM calls"
    ))
}

/// The cache_turns relation: statusline samples collapsed to one row per TURN, joined to the
/// coalesced api_calls within the 60s window. None when the statusline window holds nothing.
/// `since_ms` scopes the statusline side only (relation_for's window); the api_calls side is
/// deliberately unscoped — a small store scan keeps the join honest for old sessions.
pub fn cache_turns_relation(store_dir: &Path, data_dir: &Path, since_ms: Option<f64>) -> Option<String> {
    let sl_root = data_dir.join("statusline");
    let statusline = crate::statusline_store::relation_for(&sl_root, "main", since_ms, None)?;
    let api = api_calls_relation(store_dir)?;
    // WHY writePct = 100 * write / (write + read), NULL when both are 0 (review B4, TRDD-GVA8TTJF):
    // this is the ONE established statusline write% — src/cli/statuslineHistoryCli.ts `write_pct`
    // (`total > 0 ? (100 * write) / total : null`, a null column read as 0), the
    // `statusline-history cache` view CLAUDE.md names as the falsifier. The acceptance query exists
    // to cross-check that view, so any other formula disagrees by construction: the old
    // creation / (input + read) fraction left the write out of its denominator and gave ~33,333
    // for a full cold write.
    Some(format!(
        "WITH \
         turns AS ( \
           SELECT * FROM ( \
             SELECT sl.*, \
               ROW_NUMBER() OVER ( \
                 PARTITION BY sl.session_id, COALESCE(sl.prompt_id, 'tick:' || CAST(sl.ts AS VARCHAR)) \
                 ORDER BY sl.ts DESC \
               ) AS rn \
             FROM {statusline} sl \
           ) WHERE rn = 1 \
         ), \
         api_calls AS ({api}) \
         SELECT \
           sl.session_id, sl.ts, sl.model_id AS model, \
           COALESCE(sl.prompt_id, '') AS prompt_id, \
           sl.prompt_cache_ttl, \
           api.cache_miss_reason, \
           api.cache_read_tokens, api.cache_creation_tokens, \
           api.input_tokens, api.output_tokens, api.tier_5m_tokens, api.tier_1h_tokens, \
           CASE WHEN COALESCE(sl.context_window_current_usage_cache_creation_input_tokens, 0) \
                     + COALESCE(sl.context_window_current_usage_cache_read_input_tokens, 0) > 0 \
                THEN 100.0 * CAST(COALESCE(sl.context_window_current_usage_cache_creation_input_tokens, 0) AS DOUBLE) \
                     / (CAST(COALESCE(sl.context_window_current_usage_cache_creation_input_tokens, 0) AS DOUBLE) \
                        + CAST(COALESCE(sl.context_window_current_usage_cache_read_input_tokens, 0) AS DOUBLE)) \
                ELSE NULL END AS writePct, \
           api.call_stem, api.request_paired, api.response_paired \
         FROM turns sl \
         LEFT JOIN api_calls api \
           ON api.session_id = sl.session_id AND abs(COALESCE(api.ts_ms, 0) - sl.ts) <= 60_000"
    ))
}

/// run_cache_turns_sql — the query entry, mirroring query_statusline's CTE shape: the caller's
/// `sql` references `turns`, `api_calls` and `statusline`. BLIND (None) when either side's
/// relation is absent — surfaced, never "nothing happened".
pub fn run_cache_turns_sql(
    store_dir: &Path,
    data_dir: &Path,
    sql: &str,
    limit: Option<f64>,
    since_ms: Option<f64>,
    vars: &HashMap<String, String>,
) -> Result<Option<Vec<Map<String, Value>>>, String> {
    // api_calls is the PRIMARY relation: queryable alone (the guard + survival tests exercise
    // it without any statusline data). The statusline/turns CTEs are added only when their
    // side exists — a query referencing a missing CTE is then an honest DuckDB error naming
    // the absent side, not a fake empty result.
    let Some(api_alone) = api_calls_relation(store_dir) else { return Ok(None) };
    let statusline_rel = crate::statusline_store::relation_for(&data_dir.join("statusline"), "main", since_ms, None);
    let turns_rel = match &statusline_rel {
        // cache_turns_relation re-derives both; reuse the pieces to keep one SQL shape.
        Some(_) => cache_turns_relation(store_dir, data_dir, since_ms),
        None => None,
    };
    let mut withs = vec![format!("api_calls AS ({api_alone})")];
    if let Some(s) = &statusline_rel {
        withs.push(format!("statusline AS ({s})"));
    }
    if let Some(t) = &turns_rel {
        withs.push(format!("turns AS ({t})"));
    }
    let lim = limit
        .map(|l| format!("LIMIT {}", l as i64))
        .unwrap_or_default();
    let con = open_duck(data_dir, vars)?;
    install_body_links(&con, data_dir)?;
    let mut stmt = con
        .prepare(&format!("WITH {} {sql} {lim}", withs.join(", ")))
        .map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    let mut names: Option<Vec<String>> = None;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let names = names
            .get_or_insert_with(|| row.as_ref().column_names().into_iter().map(|s| s.to_owned()).collect());
        let mut m = Map::new();
        for (i, name) in names.iter().enumerate() {
            let v: agentlens_store::duckdb::types::Value = row.get(i).map_err(|e| e.to_string())?;
            m.insert(name.clone(), duck_to_json(v)?);
        }
        out.push(m);
    }
    Ok(Some(out))
}

/// The acceptance SQL (CAJ5RCP9 box 3): every cold write in the last N hours with its miss
/// reason and the statusline write% for the same turn. Documented here AND on the card.
pub const ACCEPTANCE_SQL: &str = "SELECT session_id, ts, model, prompt_id, cache_miss_reason, cache_read_tokens, cache_creation_tokens, writePct FROM turns WHERE cache_miss_reason IS NOT NULL ORDER BY ts DESC LIMIT 100";

/// The entry the ui.rs dispatch arm calls: `preset` names a canned query, `sql` is raw caller
/// SQL over the `api_calls`/`statusline`/`turns` CTEs. window_hours scopes the statusline side.
/// CONTRACT SPLIT (review round 3): this entry requires BOTH sides (Err naming the absent one)
/// because its flagship preset is the acceptance SQL, which needs `turns`;
/// run_cache_turns_sql instead adds the statusline/turns CTEs only when present and serves
/// api_calls-only queries during a statusline-blind window. Do not "unify" them in either
/// direction.
pub fn run_preset_or_sql(
    data_dir: &Path,
    preset: Option<&str>,
    sql: Option<&str>,
    window_hours: Option<f64>,
    limit: Option<f64>,
) -> Result<Value, String> {
    let store_dir = data_dir.join("store");
    let vars = HashMap::new();
    let since_ms = window_hours.map(|h| crate::now_ms() as f64 - h * 3_600_000.0);
    let chosen: String = match (preset, sql) {
        (Some("acceptance"), _) => ACCEPTANCE_SQL.to_owned(),
        (Some(other), _) => return Err(format!("unknown preset {other:?} (only \"acceptance\")")),
        (_, Some(s)) => s.to_owned(),
        _ => return Err("pass preset or sql".into()),
    };
    // ALWAYS build the full WITH — extra CTEs are harmless to an api_calls-only query, and a
    // heuristic sniffing "from turns" in caller SQL misses newline variants (review round 2).
    let api_rel = api_calls_relation(&store_dir).ok_or("BLIND: no api_call parts")?;
    let sl_rel = crate::statusline_store::relation_for(&data_dir.join("statusline"), "main", since_ms, None)
        .ok_or("BLIND: no statusline samples")?;
    let turns_rel = cache_turns_relation(&store_dir, data_dir, since_ms).ok_or("BLIND: cache_turns")?;
    let sql_text = format!("WITH api_calls AS ({api_rel}), statusline AS ({sl_rel}), turns AS ({turns_rel}) {chosen}");
    let lim = limit.map(|l| format!(" LIMIT {}", l as i64)).unwrap_or_default();
    let con = open_duck(data_dir, &vars)?;
    install_body_links(&con, data_dir)?;
    let mut stmt = con.prepare(&format!("{sql_text}{lim}")).map_err(|e| e.to_string())?;
    let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
    let mut names: Option<Vec<String>> = None;
    let mut out = Vec::new();
    while let Some(row) = rows.next().map_err(|e| e.to_string())? {
        let names = names.get_or_insert_with(|| row.as_ref().column_names().into_iter().map(|s| s.to_owned()).collect());
        let mut m = Map::new();
        for (i, name) in names.iter().enumerate() {
            let v: agentlens_store::duckdb::types::Value = row.get(i).map_err(|e| e.to_string())?;
            m.insert(name.clone(), duck_to_json(v)?);
        }
        out.push(m);
    }
    Ok(Value::Array(out.into_iter().map(Value::Object).collect()))
}

/// Local copy of statusline_store::duck_to_json (fn-private there; widening its visibility for
/// one caller is a bigger blast radius than the ~20-line scalar mapping). Same semantics:
/// BIGINT → number, DOUBLE via the integral-bare shape; LIST/STRUCT answer an explicit error.
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
        D::UBigInt(n) => num(n as f64),
        D::Float(f) => num(f as f64),
        D::Double(f) => num(f),
        D::Decimal(_) | D::Timestamp(_, _) => num(0.0),
        D::Text(s) => Value::String(s),
        D::Blob(_) => return Err("cache-turns: BLOB column not JSON-able".into()),
        D::Date32(_) | D::Time64(_, _) => return Err("cache-turns: date/time not JSON-able".into()),
        D::Interval { .. } => return Err("cache-turns: interval not JSON-able".into()),
        D::List(_) | D::Struct(_) => return Err("cache-turns: LIST/STRUCT not JSON-able (statusline_store::duck_to_json's contract)".into()),
        _ => return Err("cache-turns: unsupported DuckDB scalar".into()),
    })
}

fn num(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 9.0e15 {
        Value::from(f as i64)
    } else {
        Value::from(f)
    }
}

#[cfg(test)]
mod cache_turns_sql_tests {
    use super::super::cache_turns_sql::{api_calls_relation, cache_turns_relation, run_cache_turns_sql};
    use crate::delta_log::DeltaLog;
    use indexmap::IndexMap;
    use serde_json::{json, Map, Value};
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};

    /// One realistic REQUEST body + one RESPONSE body for the same call, ingested through the
    /// REAL writer (ingest_body → append_api_call_row → flush_detailed) — real-writer fixtures,
    /// never a hand-built parquet. Stems: request `<uuid>.request.json`, response
    /// `req_<id>.response.json` (api_call.rs header).
    fn request_body(session: &str, model: &str) -> String {
        json!({
            "model": model,
            "system": [{"type": "text", "text": "you are a fixture"}],
            "messages": [{"role": "user", "content": "hello"}],
            "metadata": {"user_id": "session_x"}
        })
        .to_string()
        .replace("session_x", session)
    }

    fn response_body(msg_id: &str, model: &str) -> String {
        json!({
            "id": msg_id,
            "model": model,
            "stop_reason": "end_turn",
            "usage": {
                "input_tokens": 100, "output_tokens": 20,
                "cache_read_input_tokens": 900, "cache_creation_input_tokens": 50,
                "cache_creation": {"ephemeral_5m_input_tokens": 50, "ephemeral_1h_input_tokens": 0}
            },
            "diagnostics": {"cache_miss_reason": {"type": "below_min_cacheable", "cache_missed_input_tokens": 300}}
        })
        .to_string()
        .replace("claude-x", model)
    }

    /// One body-link record in production's exact shape: lib.rs body_link_row's key
    /// (`span:kind:ts`) and its 8-field value. Persisted only through DeltaLog (seed_links).
    fn link_row(session: &str, span: &str, kind: &str, stem: &str, rbid: &str, msg: &str, ts: i64) -> (String, Value) {
        (
            format!("{span}:{kind}:{ts}"),
            json!({
                "session_id": session, "span_id": span, "kind": kind, "stem": stem,
                "request_id": if kind == "response" { format!("req-{msg}") } else { "".to_string() },
                "request_body_id": rbid, "message_id": msg, "ts_ms": ts
            }),
        )
    }

    fn tmp(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("gva-{}-{tag}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(d.join("store")).unwrap();
        std::fs::create_dir_all(d.join("statusline")).unwrap();
        d
    }

    /// Seed api_call parts through the REAL writer (ingest_body → flush_detailed).
    fn seed_store(data: &Path, bodies: &[(&str, String, i64)]) {
        let mut store = agentlens_store::open_store(
            &data.join("store"), agentlens_store::DEFAULT_MEMORY_LIMIT, 4).unwrap();
        for (name, raw, ts) in bodies {
            agentlens_store::ingest_body(&mut store, name, raw, *ts).unwrap();
        }
        agentlens_store::flush_detailed(&mut store).unwrap();
    }

    /// Persist link records through DeltaLog ITSELF, the way production does: ingest appends with
    /// append_changed, boot folds the delta into the snapshot with compact_now. The files are then
    /// byte-for-byte production's on-disk format (`{"k":key,"v":record}` lines) — the old fixture
    /// hand-wrote FLAT rows production never writes, so the tests passed against a fiction (review B1).
    fn seed_links(data: &Path, rows: &[(String, Value)]) {
        let recs: IndexMap<String, Value> = rows.iter().cloned().collect();
        let mut log = DeltaLog::new(data, "body-links");
        log.append_changed(&recs).unwrap();
        log.compact_now(&recs).unwrap();
    }

    /// One sealed statusline part through the REAL store (append → flush → seal), never a
    /// hand-built parquet. prompt_id is a TOP-LEVEL payload key (statuslineCapture.ts:15).
    fn seed_statusline(data: &Path, session: &str, prompt: Option<&str>, ts: i64) {
        seed_statusline_usage(data, session, prompt, ts, 500, 3000);
    }

    /// seed_statusline with the turn's cache split chosen: `write` = cache_creation, `read` = cache_read.
    fn seed_statusline_usage(data: &Path, session: &str, prompt: Option<&str>, ts: i64, write: i64, read: i64) {
        use crate::statusline_store::StatuslineStore;
        let mut st = StatuslineStore::new(data.join("statusline"));
        let mut m = Map::new();
        m.insert("session_id".into(), json!(session));
        m.insert("model_id".into(), json!("claude-opus-5"));
        m.insert("prompt_id".into(), json!(prompt));
        m.insert("prompt_cache_ttl".into(), json!("1h"));
        m.insert("context_window_current_usage_input_tokens".into(), json!(1000));
        m.insert("context_window_current_usage_output_tokens".into(), json!(200));
        m.insert("context_window_current_usage_cache_creation_input_tokens".into(), json!(write));
        m.insert("context_window_current_usage_cache_read_input_tokens".into(), json!(read));
        st.append(&m, "main", ts as f64);
        st.flush(None);
    }

    const T0: i64 = 1_700_000_000_000;

    #[test]
    fn paired_call_coalesces_and_joins_the_statusline_turn() {
        let data = tmp("pair");
        seed_store(&data, &[
            ("2f8c1a2b.request.json", request_body("sess-a", "claude-opus-5"), T0),
            ("req_r1.response.json", response_body("msg_1", "claude-opus-5"), T0 + 900),
        ]);
        seed_links(&data, &[
            link_row("sess-a", "span-a", "request", "/b/2f8c1a2b.request.json", "rbid-1", "", T0),
            link_row("sess-a", "span-a", "response", "/b/req_r1.response.json", "rbid-1", "msg_1", T0 + 900),
        ]);
        seed_statusline(&data, "sess-a", Some("p1"), T0 + 500);

        cache_turns_relation(&data.join("store"), &data, None).expect("cache_turns_relation blind");
        let rows = run_cache_turns_sql(&data.join("store"), &data,
            "SELECT session_id, ts, model, prompt_id, cache_miss_reason, cache_read_tokens, cache_creation_tokens, writePct, call_stem, response_paired FROM turns",
            None, None, &HashMap::new()).expect("run outer").expect("run inner");
        assert_eq!(rows.len(), 1, "one turn row, got {rows:?}");
        let r = &rows[0];
        assert_eq!(r["session_id"], json!("sess-a"));
        assert_eq!(r["cache_miss_reason"], json!("below_min_cacheable"));
        assert_eq!(r["cache_read_tokens"], json!(900));
        assert_eq!(r["cache_creation_tokens"], json!(50));
        // writePct = 100 * 500 / (500 + 3000) = 14.2857… (statusline write%, review B4)
        assert!((r["writePct"].as_f64().unwrap() - 100.0 * 500.0 / 3500.0).abs() < 1e-9, "writePct was {:?}", r["writePct"]);
        assert_eq!(r["call_stem"], json!("2f8c1a2b"), "request stem wins via the pair");
        assert_eq!(r["response_paired"], json!(true));
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn full_cold_write_turn_reads_write_pct_100() {
        // Review B4: a full cold write (cache_read 0) is 100% write on the statusline scale. The old
        // creation / (input + read) fraction gave 500 / 1000 = 0.5 here, so this pins the scale too.
        let data = tmp("cold");
        seed_store(&data, &[
            ("2f8c1a2b.request.json", request_body("sess-c", "claude-opus-5"), T0),
            ("req_r1.response.json", response_body("msg_1", "claude-opus-5"), T0 + 900),
        ]);
        seed_links(&data, &[
            link_row("sess-c", "span-c", "request", "/b/2f8c1a2b.request.json", "rbid-1", "", T0),
            link_row("sess-c", "span-c", "response", "/b/req_r1.response.json", "rbid-1", "msg_1", T0 + 900),
        ]);
        seed_statusline_usage(&data, "sess-c", Some("p1"), T0 + 500, 500, 0);

        let rows = run_cache_turns_sql(&data.join("store"), &data, "SELECT writePct FROM turns",
            None, None, &HashMap::new()).expect("run outer").expect("run inner");
        assert_eq!(rows.len(), 1, "one turn row, got {rows:?}");
        assert!((rows[0]["writePct"].as_f64().unwrap() - 100.0).abs() < 1e-9, "writePct was {:?}", rows[0]["writePct"]);
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn empty_request_body_id_cannot_cross_match_two_calls() {
        let data = tmp("guard");
        // TWO calls, both link rows carry request_body_id = '' (pre-2.1.274 shape) and
        // DIFFERENT span_ids — the span pairing must NOT fire and the '' equality must NOT
        // cross-match call 1's request with call 2's response.
        seed_store(&data, &[
            ("aaaa1111.request.json", request_body("sess-b", "claude-opus-5"), T0),
            ("req_r1.response.json", response_body("msg_1", "claude-opus-5"), T0 + 900),
            ("bbbb2222.request.json", request_body("sess-b", "claude-opus-5"), T0 + 10_000),
            ("req_r2.response.json", response_body("msg_2", "claude-opus-5"), T0 + 10_900),
        ]);
        seed_links(&data, &[
            link_row("sess-b", "span-a", "request", "/b/aaaa1111.request.json", "", "", T0),
            link_row("sess-b", "span-z", "response", "/b/req_r1.response.json", "", "msg_1", T0 + 900),
            link_row("sess-b", "span-b", "request", "/b/bbbb2222.request.json", "", "", T0 + 10_000),
            link_row("sess-b", "span-y", "response", "/b/req_r2.response.json", "", "msg_2", T0 + 10_900),
        ]);
        let rows = run_cache_turns_sql(&data.join("store"), &data,
            "SELECT call_stem, session_id, cache_read_tokens, response_paired FROM api_calls ORDER BY call_stem",
            None, None, &HashMap::new()).expect("run outer").expect("run inner");
        // The coalesce yields one row per CALL (4 rows: 2 requests + 2 responses, none paired
        // because span_ids differ and rbid='' is guarded). The defect this pins: '' = '' pairing
        // would merge call 1's request with call 2's response.
        assert_eq!(rows.len(), 4, "four unpaired call-half rows, got {rows:?}");
        for r in &rows {
            assert_eq!(r["response_paired"], json!(false), "no '' cross-match: {r:?}");
        }
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn unpaired_response_half_survives_in_api_calls_with_its_own_session() {
        // THE SEVENTH CHECK (exit-review): an UNPAIRED-half survival test at the api_calls level.
        // A response link row with request_body_id='' and a span_id matching NO request link
        // row must SURVIVE in api_calls_relation's OWN output, with session_id resolved from
        // its OWN link row. NOT asserted at the final statusline join (unpaired halves do not
        // survive there by design — LEFT/interval semantics).
        let data = tmp("survive");
        seed_store(&data, &[
            ("req_r9.response.json", response_body("msg_9", "claude-opus-5"), T0),
        ]);
        seed_links(&data, &[
            link_row("sess-c", "span-orphan", "response", "/b/req_r9.response.json", "", "msg_9", T0),
        ]);
        let rows = run_cache_turns_sql(&data.join("store"), &data,
            "SELECT call_stem, session_id, cache_read_tokens, cache_miss_reason, request_paired, response_paired FROM api_calls",
            None, None, &HashMap::new()).expect("run outer").expect("run inner");
        assert_eq!(rows.len(), 1, "the unpaired response half survives: {rows:?}");
        let r = &rows[0];
        assert_eq!(r["call_stem"], json!("req_r9"));
        assert_eq!(r["session_id"], json!("sess-c"), "session from its OWN link row");
        assert_eq!(r["cache_read_tokens"], json!(900));
        assert_eq!(r["cache_miss_reason"], json!("below_min_cacheable"));
        assert_eq!(r["request_paired"], json!(false));
        assert_eq!(r["response_paired"], json!(false), "present but unpaired");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn blind_when_store_or_statusline_are_empty() {
        let data = tmp("blind");
        assert!(api_calls_relation(&data.join("store")).is_none(), "no parts → None, never a bare glob");
        assert!(cache_turns_relation(&data.join("store"), &data, None).is_none());
        seed_statusline(&data, "sess-d", Some("p1"), T0);
        // statusline exists but no api_call parts → still blind (the join needs both sides).
        assert!(cache_turns_relation(&data.join("store"), &data, None).is_none());
        let _ = std::fs::remove_dir_all(&data);
    }


    #[test]
    fn uuid_shaped_session_and_request_body_ids_pair_and_join() {
        // Review B2: real session_ids and request_body_ids ARE UUIDs. read_ndjson_auto inferred a
        // UUID column for such a file, and the VARCHAR COALESCE / `<> ''` guards then failed to
        // bind or convert. Every id here is UUID-shaped, so any untyped read of the links reaches
        // the joins as UUID and this test errors instead of passing.
        const SESS: &str = "0b1c2d3e-4f50-4a6b-8c7d-9e0f1a2b3c4d";
        const RBID: &str = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
        const RBID_ORPHAN: &str = "e2f3a4b5-c6d7-4e8f-9a0b-1c2d3e4f5a6b";
        let data = tmp("uuid");
        seed_store(&data, &[
            ("3c4d5e6f.request.json", request_body(SESS, "claude-opus-5"), T0),
            ("req_u1.response.json", response_body("msg_u1", "claude-opus-5"), T0 + 900),
            ("req_u2.response.json", response_body("msg_u2", "claude-opus-5"), T0 + 5_000),
        ]);
        seed_links(&data, &[
            link_row(SESS, "span-u", "request", "/b/3c4d5e6f.request.json", RBID, "", T0),
            link_row(SESS, "span-u", "response", "/b/req_u1.response.json", RBID, "msg_u1", T0 + 900),
            // Matches no request: exercises the orphan arm's COALESCE with the link session.
            link_row(SESS, "span-v", "response", "/b/req_u2.response.json", RBID_ORPHAN, "msg_u2", T0 + 5_000),
        ]);
        seed_statusline(&data, SESS, Some("p1"), T0 + 500);
        let calls = run_cache_turns_sql(&data.join("store"), &data,
            "SELECT call_stem, session_id, response_paired FROM api_calls ORDER BY call_stem",
            None, None, &HashMap::new()).expect("run outer").expect("run inner");
        assert_eq!(calls.len(), 2, "one paired call + one orphan response: {calls:?}");
        assert_eq!(calls[0]["call_stem"], json!("3c4d5e6f"));
        assert_eq!(calls[0]["session_id"], json!(SESS));
        assert_eq!(calls[0]["response_paired"], json!(true), "UUID request_body_id pairs");
        assert_eq!(calls[1]["call_stem"], json!("req_u2"));
        assert_eq!(calls[1]["session_id"], json!(SESS), "session from its own UUID link row");
        assert_eq!(calls[1]["response_paired"], json!(false));
        let turns = run_cache_turns_sql(&data.join("store"), &data,
            "SELECT session_id, call_stem FROM turns ORDER BY call_stem",
            None, None, &HashMap::new()).expect("run outer").expect("run inner");
        assert_eq!(turns.len(), 2, "both calls join the UUID session's turn: {turns:?}");
        for t in &turns {
            assert_eq!(t["session_id"], json!(SESS));
        }
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn a_repeated_key_takes_its_last_line_across_snapshot_and_delta() {
        // Review B1: DeltaLog lines are last-wins per key. The STALE record sits in the snapshot
        // and the FRESH one, under the same key, in the delta: the view must hold exactly one
        // link row for the key, and it must be the fresh one.
        let data = tmp("lastwins");
        seed_store(&data, &[("req_r7.response.json", response_body("msg_7", "claude-opus-5"), T0)]);
        let (key, stale) = link_row("sess-stale", "span-7", "response", "/b/req_r7.response.json", "", "msg_7", T0);
        seed_links(&data, &[(key.clone(), stale)]);
        let (fresh_key, fresh) = link_row("sess-fresh", "span-7", "response", "/b/req_r7.response.json", "", "msg_7", T0);
        assert_eq!(key, fresh_key, "the same production key");
        let mut log = DeltaLog::new(&data, "body-links");
        log.load().unwrap();
        log.append_changed(&[(fresh_key, fresh)].into_iter().collect()).unwrap();
        assert!(data.join("body-links.snapshot.ndjson").is_file(), "stale line in the snapshot");
        assert!(data.join("body-links.delta.ndjson").is_file(), "fresh line in the delta");
        let rows = run_cache_turns_sql(&data.join("store"), &data,
            "SELECT call_stem, session_id FROM api_calls",
            None, None, &HashMap::new()).expect("run outer").expect("run inner");
        assert_eq!(rows.len(), 1, "one row per live key, never one per line: {rows:?}");
        assert_eq!(rows[0]["session_id"], json!("sess-fresh"), "the later line wins");
        let _ = std::fs::remove_dir_all(&data);
    }

    #[test]
    fn a_tombstoned_key_is_gone_from_the_view() {
        // Review B1: a `{"k":key,"d":1}` tombstone deletes the key. The record sits in the
        // snapshot, its tombstone in the delta; the response part survives, but with no link
        // its session cannot be resolved.
        let data = tmp("tomb");
        seed_store(&data, &[("req_r8.response.json", response_body("msg_8", "claude-opus-5"), T0)]);
        seed_links(&data, &[link_row("sess-dead", "span-8", "response", "/b/req_r8.response.json", "", "msg_8", T0)]);
        let mut log = DeltaLog::new(&data, "body-links");
        log.load().unwrap();
        // save() with the full record set minus the key appends the tombstone line.
        let r = log.save(&IndexMap::new()).unwrap();
        assert_eq!(r.deleted, 1, "one tombstone written");
        assert!(!r.compacted, "the tombstone must sit in the delta, the record in the snapshot");
        let rows = run_cache_turns_sql(&data.join("store"), &data,
            "SELECT call_stem, session_id, link_msg_id FROM api_calls",
            None, None, &HashMap::new()).expect("run outer").expect("run inner");
        assert_eq!(rows.len(), 1, "the response part itself survives: {rows:?}");
        assert_eq!(rows[0]["call_stem"], json!("req_r8"));
        assert_eq!(rows[0]["session_id"], Value::Null, "its only link was tombstoned");
        assert_eq!(rows[0]["link_msg_id"], Value::Null);
        let _ = std::fs::remove_dir_all(&data);
    }
}

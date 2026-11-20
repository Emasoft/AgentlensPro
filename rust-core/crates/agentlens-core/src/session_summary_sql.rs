//! TRDD-FSMISF5K — the per-session OTEL aggregates as ONE DuckDB query over the span segments,
//! instead of a Rust pass over a resident 24-hour span window.
//!
//! USER architecture ruling (TRDD-7YPQWKPG, 2026-09-02): *"duckdb is your memory! the rust code
//! should only make queries and report the ephemeral answers"*. `SpanWindow::boot_load` replays
//! the last `summaryWindowHours` (default 24h) of the segmented store into
//! `Vec<Arc<serde_json::Value>>` — measured 2026-09-06 at **528,219 spans** and a 13.2 GB process
//! peak that the allocator never gives back (reports/7ypqwkpg/20260906_043059+0200-…). This module
//! answers the same aggregate question by streaming the SAME segment files through DuckDB, which
//! materializes ~N session rows instead of ~500k span trees.
//!
//! ## What it computes, and what it deliberately does not
//!
//! ONLY the per-session AGGREGATES of `claude_code` sessions: the four disjoint token buckets, the
//! call/tool/error counts, the model and the start instant. It does NOT build a session CARD —
//! `timeline`, `filesRead/Searched/Changed/Written`, `toolCounts`, `userRequest` and the
//! loop signals stay in `summarize::claude`, per the card: *"timeline / synthetic-root / subagent
//! logic stays Rust but runs PER SESSION ON DEMAND"*. Codex and Copilot sessions are out of scope
//! here: their builders read different attributes and produce differently-shaped cards, and one
//! source proved end-to-end is worth more than three asserted.
//!
//! ## Why the SQL is verbose instead of clever
//!
//! Every column below names the exact TS/Rust rule it mirrors, because the parity bar is
//! byte-level and the failure mode of a "clever" query is a silently different number:
//!
//! * `attr_pick` reproduces `helpers::attr_value` — an attribute list is searched by key and the
//!   FIRST match wins (`arg_min(val, idx)`), not the last, and not an arbitrary one.
//! * the `coalesce(intValue, doubleValue, stringValue)` order is `helpers::get_attr_num`'s, which
//!   is NOT the same order `get_attr_str` uses. Reading a number through the string order would
//!   silently prefer a `stringValue` twin where the TS prefers the int.
//! * `num()` is JS `Number(x) || 0`: `''` and `'   '` are 0, junk is NaN → 0 (`try_cast` → NULL).
//! * `first_nonzero` is a CASE ladder in the SAME key order as `helpers::extract_token_counts`;
//!   a zero in an earlier key falls through, which is why it cannot be a `coalesce`.
//! * `clamp` is `if n.is_finite() && n > 0.0 { n } else { 0.0 }` — `CASE WHEN x > 0` gives exactly
//!   that, because `NaN > 0` is false in SQL as in Rust.
//!
//! ## Fail-fast
//!
//! Same doctrine as `card_store`: a fixed schema, a process-local in-memory database, paths this
//! process discovered itself. A failure here is a bug or an OOM, so the statement panics with the
//! offending SQL rather than reporting an empty summary, which would look exactly like "no
//! sessions" — the silent-loss failure this project treats as worse than a crash.
//!
//! `ignore_errors=true` on the reader is the ONE exception, and it is not silence: a segment's
//! last line can be torn by a crash mid-append (the writer appends `lines.join('\n') + '\n'`, so
//! a partial write leaves one bad line), and refusing the whole day's spans over one torn tail
//! would lose far more than it protects. `load_range` skips such a line for the same reason.

use std::path::{Path, PathBuf};

use agentlens_store::duckdb::Connection;

/// One session's OTEL aggregate — the SQL-derived counterpart of the fields
/// `summarize::claude::build_interaction_card` computes by walking the trace.
#[derive(Debug, Clone, PartialEq)]
pub struct SessionAggregate {
    pub session_id: String,
    pub model: String,
    /// The session's earliest span start, in ms (the card's `startTime` before ISO formatting).
    pub start_ms: f64,
    pub input_tokens: f64,
    pub output_tokens: f64,
    pub cache_read_tokens: f64,
    pub cache_create_tokens: f64,
    pub total_llm_calls: f64,
    pub total_tool_calls: f64,
    pub errors: f64,
}

/// The segment files one refresh reads: today's and yesterday's, either form (`.ndjson` /
/// `.ndjson.gz`), oldest key first.
///
/// TWO DAYS, not one, and not all of them. One day would drop everything before local midnight —
/// a session running at 00:05 would lose its whole first half — and the whole store would put the
/// 24-hour boot replay back in, just inside DuckDB. Two days always covers the 24-hour summary
/// window; the `startTime` filter the caller applies decides what is actually in it.
///
/// The day key is the segment's own naming (`YYYY-MM-DD`, local civil day), so this uses the same
/// `civil_from_days` split the writer buckets by — never a formatted clock string, which would
/// disagree with the writer under a different `TZ`.
pub fn recent_segment_files(spans_dir: &Path, now_ms: i64) -> Vec<PathBuf> {
    const DAY_MS: i64 = 86_400_000;
    let keys: [String; 2] = [segment_key(now_ms - DAY_MS), segment_key(now_ms)];
    let mut out = Vec::new();
    for key in keys {
        for name in [format!("{key}.ndjson"), format!("{key}.ndjson.gz")] {
            let p = spans_dir.join(name);
            if p.is_file() {
                out.push(p);
            }
        }
    }
    out
}

fn segment_key(ts_ms: i64) -> String {
    let (y, m, d) = agentlens_spanstore::civil_from_days(ts_ms.div_euclid(86_400_000));
    format!("{y:04}-{m:02}-{d:02}")
}

/// The table's shape, spelled once. It MUST list the same names and types the aggregate query's
/// final SELECT projects — a `CREATE OR REPLACE TABLE … AS SELECT` would silently accept a
/// different shape, and `rows()` would then fail at the first refresh instead of at construction.
/// `SessionSummarySql::new()` + `rows()` on the empty table is the check that keeps them honest.
const SCHEMA_COLUMNS: &str = "session_id VARCHAR, model VARCHAR, start_ms DOUBLE,
     input_tokens DOUBLE, output_tokens DOUBLE, cache_read_tokens DOUBLE, cache_create_tokens DOUBLE,
     total_llm_calls DOUBLE, total_tool_calls DOUBLE, errors DOUBLE";

pub struct SessionSummarySql {
    conn: Connection,
}

impl SessionSummarySql {
    /// `tmp_dir` is the DuckDB spill directory (`<data_dir>/tmp/session-summary`), created here.
    pub fn new(tmp_dir: &Path) -> SessionSummarySql {
        let conn = Connection::open_in_memory().expect("open the session-summary database");
        // `crate::cores::duckdb_threads()` (TRDD-YH822LDI) and a memory limit, for the same reasons transcript_sql gives: this is a
        // streaming scan of at most two segment files on a machine that is also serving, not the
        // only workload on the box. An over-limit query spills to `tmp_dir` (latency + disk)
        // instead of ballooning the process past its cap (TRDD-9VX3WTGU Phase B).
        let spill = agentlens_store::spill_sql(tmp_dir).expect("create the session-summary spill dir");
        conn.execute_batch(&format!("SET threads={}; SET memory_limit='{}'; {spill}", crate::cores::duckdb_threads(), agentlens_store::SERVER_MEMORY_LIMIT))
            .expect("configure the session-summary database");
        conn.execute_batch(&format!("CREATE TABLE session_summary ({SCHEMA_COLUMNS});"))
            .expect("create the empty session_summary table");
        SessionSummarySql { conn }
    }

    /// Re-materialize `session_summary` from `files`. Returns the row count.
    ///
    /// CREATE OR REPLACE, not INSERT: the aggregate of a segment changes as the segment grows, so
    /// an incremental insert would double-count every session that spans two refreshes. The whole
    /// table is at most a few thousand rows of scalars — rebuilding it is cheaper than the
    /// bookkeeping that would make an incremental path correct.
    ///
    /// NO FILES IS A REAL STATE, NOT AN ERROR — a server booted before its first span has an empty
    /// spans dir, and `read_ndjson_objects([])` is an `IO Error`, not an empty result. Emptying the
    /// table is the honest answer: "no segments ⇒ no sessions", never a stale previous refresh.
    pub fn refresh(&mut self, files: &[PathBuf]) -> usize {
        if files.is_empty() {
            self.conn.execute_batch("DELETE FROM session_summary").expect("empty session_summary");
            return 0;
        }
        let list = files
            .iter()
            .map(|p| agentlens_store::sq_path(&p.to_string_lossy()))
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("CREATE OR REPLACE TABLE session_summary AS {};", aggregate_sql(&format!("[{list}]")));
        self.conn.execute_batch(&sql).expect("refresh session_summary");
        self.len()
    }

    pub fn len(&self) -> usize {
        self.conn
            .query_row("SELECT count(*) FROM session_summary", [], |r| r.get::<_, i64>(0))
            .expect("count session_summary") as usize
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }

    /// Every row, ordered by session id so a caller's output is stable across refreshes.
    pub fn rows(&self) -> Vec<SessionAggregate> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT session_id, model, start_ms, input_tokens, output_tokens, cache_read_tokens,
                        cache_create_tokens, total_llm_calls, total_tool_calls, errors
                 FROM session_summary ORDER BY session_id",
            )
            .expect("prepare the session_summary scan");
        let rows = stmt
            .query_map([], |r| {
                Ok(SessionAggregate {
                    session_id: r.get(0)?,
                    model: r.get(1)?,
                    start_ms: r.get(2)?,
                    input_tokens: r.get(3)?,
                    output_tokens: r.get(4)?,
                    cache_read_tokens: r.get(5)?,
                    cache_create_tokens: r.get(6)?,
                    total_llm_calls: r.get(7)?,
                    total_tool_calls: r.get(8)?,
                    errors: r.get(9)?,
                })
            })
            .expect("scan session_summary");
        rows.map(|r| r.expect("read a session_summary row")).collect()
    }

    pub fn get(&self, session_id: &str) -> Option<SessionAggregate> {
        self.rows().into_iter().find(|r| r.session_id == session_id)
    }
}

/// The one query. `files` is a bracketed DuckDB list literal built by the caller from paths this
/// process discovered — never from a request — single quotes are doubled and the glob characters are escaped
/// (agentlens_store::sq_path, TRDD-C6W0SWUT).
fn aggregate_sql(files: &str) -> String {
    format!(
        r#"
WITH raw AS (
    SELECT json FROM read_ndjson_objects({files}, ignore_errors=true, maximum_object_size=33554432)
),
span AS (
    SELECT
        row_number() OVER () AS sid,
        json,
        json_extract_string(json, '$.traceId')   AS trace_id,
        json_extract_string(json, '$.spanId')    AS span_id,
        json_extract_string(json, '$.name')      AS name,
        json_extract_string(json, '$.startTime') AS start_time,
        CAST(json_extract(json, '$.status.code') AS BIGINT) IS NOT DISTINCT FROM 2 AS is_error
    FROM raw
),
attr AS (
    SELECT
        sid,
        unnest(range(1, len(elems) + 1)) AS idx,
        unnest(elems)                    AS elem
    FROM (SELECT sid, json_extract(json, '$.attributes[*]') AS elems FROM span)
    WHERE elems IS NOT NULL
),
attr_kv AS (
    SELECT
        sid,
        idx,
        json_extract_string(elem, '$.key') AS key,
        coalesce(
            json_extract_string(elem, '$.value.intValue'),
            json_extract_string(elem, '$.value.doubleValue'),
            json_extract_string(elem, '$.value.stringValue')
        ) AS val
    FROM attr
),
attr_pick AS (
    SELECT
        sid,
        arg_min(val, idx) FILTER (WHERE key = 'session.id')                             AS a_session_id,
        arg_min(val, idx) FILTER (WHERE key = 'gen_ai.request.model')                   AS a_model_req,
        arg_min(val, idx) FILTER (WHERE key = 'gen_ai.response.model')                  AS a_model_resp,
        arg_min(val, idx) FILTER (WHERE key = 'model')                                  AS a_model_plain,
        arg_min(val, idx) FILTER (WHERE key = 'gen_ai.usage.input_tokens')              AS a_in_gen,
        arg_min(val, idx) FILTER (WHERE key = 'input_tokens')                           AS a_in_plain,
        arg_min(val, idx) FILTER (WHERE key = 'prompt_tokens')                          AS a_in_prompt,
        arg_min(val, idx) FILTER (WHERE key = 'input_token_count')                      AS a_in_count,
        arg_min(val, idx) FILTER (WHERE key = 'codex.turn.token_usage.input_tokens')    AS a_in_codex,
        arg_min(val, idx) FILTER (WHERE key = 'gen_ai.usage.cache_read.input_tokens')   AS a_cr_gen,
        arg_min(val, idx) FILTER (WHERE key = 'cache_read_tokens')                      AS a_cr_plain,
        arg_min(val, idx) FILTER (WHERE key = 'cached_token_count')                     AS a_cr_count,
        arg_min(val, idx) FILTER (WHERE key = 'codex.turn.token_usage.cached_input_tokens') AS a_cr_codex,
        arg_min(val, idx) FILTER (WHERE key = 'gen_ai.usage.cache_creation.input_tokens')   AS a_cc_gen,
        arg_min(val, idx) FILTER (WHERE key = 'cache_creation_tokens')                  AS a_cc_plain,
        arg_min(val, idx) FILTER (WHERE key = 'gen_ai.usage.output_tokens')             AS a_out_gen,
        arg_min(val, idx) FILTER (WHERE key = 'output_tokens')                          AS a_out_plain,
        arg_min(val, idx) FILTER (WHERE key = 'completion_tokens')                      AS a_out_completion,
        arg_min(val, idx) FILTER (WHERE key = 'codex.turn.token_usage.output_tokens')   AS a_out_codex,
        arg_min(val, idx) FILTER (WHERE key = 'output_token_count')                     AS a_out_count,
        arg_min(val, idx) FILTER (WHERE key = 'reasoning_token_count')                  AS a_reasoning
    FROM attr_kv
    GROUP BY sid
),
-- `nanoToMs`: the OTLP start is a unix-NANOSECOND string. `//` is integer division, which is the
-- BigInt truncation toward zero the TS does; a non-numeric value yields NULL and is treated as
-- absent (the TS prefix-parse fallback yields 0 for the shapes that reach here).
sp AS (
    SELECT
        s.sid, s.trace_id, s.span_id, s.name, s.is_error,
        TRY_CAST(s.start_time AS HUGEINT) // 1000000                                    AS start_ms,
        coalesce(nullif(p.a_session_id, ''), '')                                        AS sess_id,
        coalesce(nullif(p.a_model_req, ''), nullif(p.a_model_resp, ''), nullif(p.a_model_plain, ''), '') AS model,
        {input}                                                                          AS in_raw,
        {cache_read}                                                                     AS cr_raw,
        {cache_create}                                                                   AS cc_raw,
        CASE WHEN {output_std} <> 0 THEN {output_std} ELSE {num_out_count} + {num_reasoning} END AS out_raw
    FROM span s LEFT JOIN attr_pick p USING (sid)
),
-- One row per trace: does it have a real `claude_code.interaction` root, and which session does it
-- belong to? The two branches are `build_claude_sessions`' two paths — a real root keys on ITS OWN
-- `session.id` (empty ⇒ the slice card keeps `sessionId = interaction.spanId`), a synthesized root
-- keys on the first `session.id` seen anywhere in the trace, in file order (`synth-<traceId[..12]>`
-- when none carries one).
trace AS (
    SELECT
        trace_id,
        count(*) FILTER (WHERE name = 'claude_code.interaction') > 0 AS has_root,
        count(*) FILTER (WHERE name IN ('claude_code.llm_request', 'claude_code.tool',
                                        'claude_code.api_request', 'claude_code.compaction',
                                        'claude_code.api_error', 'claude_code.api_retries_exhausted')) > 0
            AS has_claude_spans,
        arg_min(sess_id, sid) FILTER (WHERE name = 'claude_code.interaction')            AS root_sess_id,
        arg_min(span_id, sid) FILTER (WHERE name = 'claude_code.interaction')            AS root_span_id,
        arg_min(start_ms, sid) FILTER (WHERE name = 'claude_code.interaction')           AS root_start_ms,
        arg_min(sess_id, sid) FILTER (WHERE sess_id <> '')                               AS any_sess_id,
        min(sid)                                                                          AS trace_ord
    FROM sp
    WHERE trace_id <> ''
    GROUP BY trace_id
),
keyed AS (
    SELECT
        trace_id,
        has_root,
        root_start_ms,
        trace_ord,
        CASE
            WHEN has_root THEN coalesce(nullif(root_sess_id, ''), root_span_id)
            ELSE coalesce(nullif(any_sess_id, ''), 'synth-' || substr(trace_id, 1, 12))
        END AS session_id
    FROM trace
    WHERE has_root OR has_claude_spans
),
-- ONE ROW PER SLICE CARD (`build_interaction_card`), i.e. per trace. The root interaction span is
-- EXCLUDED from the visited set (the Rust filters `spanId != interaction.spanId`) and only
-- `llm_request` / `tool` spans are visited (`top_spans`) — an `api_request` span contributes
-- neither a call nor a token, which is why `sessB` in the parity fixture reports one LLM call over
-- two token-carrying spans.
--
-- `model` is `arg_max` BY START TIME, not `arg_min` by file position, and that is not cosmetic:
-- the Rust loops `top_spans` sorted by start ASC and OVERWRITES `model` on every `llm_request`
-- that carries one, so the card reports the LAST model of the slice. A session that switches
-- model mid-way — routine on this machine — is exactly where the two disagree, and
-- `sql_takes_the_last_model_of_a_slice_like_the_rust_engine` is the test that separates them.
-- KNOWN EDGE: two `llm_request` spans with the IDENTICAL `startTime` and DIFFERENT models resolve
-- arbitrarily here, where the Rust's stable sort keeps the later file position. Not chased: it
-- needs a deterministic file-order key, and `read_ndjson_objects` exposes none.
--
-- `start_ms` follows the same split as the session key: a REAL root contributes its own
-- `startTime` (`build_interaction_card` reads the interaction span), a SYNTHESIZED one the
-- earliest span in its trace (`sorted[0].startTime`).
per_trace AS (
    SELECT
        k.session_id,
        k.trace_ord,
        CASE WHEN k.has_root THEN k.root_start_ms ELSE min(sp.start_ms) END               AS start_ms,
        coalesce(arg_max(sp.model, sp.start_ms)
                 FILTER (WHERE sp.name = 'claude_code.llm_request' AND sp.model <> ''), '') AS model,
        sum(CASE WHEN sp.name = 'claude_code.llm_request' AND sp.in_raw > 0 THEN sp.in_raw ELSE 0 END)  AS input_tokens,
        sum(CASE WHEN sp.name = 'claude_code.llm_request' AND sp.out_raw > 0 THEN sp.out_raw ELSE 0 END) AS output_tokens,
        sum(CASE WHEN sp.name = 'claude_code.llm_request' AND sp.cr_raw > 0 THEN sp.cr_raw ELSE 0 END)  AS cache_read_tokens,
        sum(CASE WHEN sp.name = 'claude_code.llm_request' AND sp.cc_raw > 0 THEN sp.cc_raw ELSE 0 END)  AS cache_create_tokens,
        count(*) FILTER (WHERE sp.name = 'claude_code.llm_request')                      AS total_llm_calls,
        count(*) FILTER (WHERE sp.name = 'claude_code.tool')                             AS total_tool_calls,
        count(*) FILTER (WHERE sp.name IN ('claude_code.llm_request', 'claude_code.tool') AND sp.is_error) AS errors
    FROM keyed k JOIN sp USING (trace_id)
    GROUP BY k.session_id, k.trace_id, k.trace_ord, k.has_root, k.root_start_ms
),
-- `merge_interaction_slices`: the counters SUM across a session's slices, `startTime` is the
-- earliest, and `model` is `firstNonEmpty` — the FIRST slice that has one, in slice order.
-- KNOWN EDGE: slice order is approximated by each trace's first span position, which differs from
-- the Rust only for a session that mixes a real root with a SYNTHESIZED one (the synth roots are
-- appended after every real one).
agg AS (
    SELECT
        session_id,
        min(start_ms)                                                 AS start_ms,
        arg_min(model, trace_ord) FILTER (WHERE model <> '')          AS model,
        sum(input_tokens)                                             AS input_tokens,
        sum(output_tokens)                                            AS output_tokens,
        sum(cache_read_tokens)                                        AS cache_read_tokens,
        sum(cache_create_tokens)                                      AS cache_create_tokens,
        sum(total_llm_calls)                                          AS total_llm_calls,
        sum(total_tool_calls)                                         AS total_tool_calls,
        sum(errors)                                                   AS errors
    FROM per_trace
    GROUP BY session_id
)
SELECT
    session_id,
    coalesce(model, '')                    AS model,
    CAST(coalesce(start_ms, 0) AS DOUBLE)  AS start_ms,
    CAST(input_tokens AS DOUBLE)           AS input_tokens,
    CAST(output_tokens AS DOUBLE)          AS output_tokens,
    CAST(cache_read_tokens AS DOUBLE)      AS cache_read_tokens,
    CAST(cache_create_tokens AS DOUBLE)    AS cache_create_tokens,
    CAST(total_llm_calls AS DOUBLE)        AS total_llm_calls,
    CAST(total_tool_calls AS DOUBLE)       AS total_tool_calls,
    CAST(errors AS DOUBLE)                 AS errors
FROM agg
"#,
        files = files,
        input = first_nonzero(&["a_in_gen", "a_in_plain", "a_in_prompt", "a_in_count", "a_in_codex"]),
        cache_read = first_nonzero(&["a_cr_gen", "a_cr_plain", "a_cr_count", "a_cr_codex"]),
        cache_create = first_nonzero(&["a_cc_gen", "a_cc_plain"]),
        output_std = first_nonzero(&["a_out_gen", "a_out_plain", "a_out_completion", "a_out_codex"]),
        num_out_count = num("a_out_count"),
        num_reasoning = num("a_reasoning"),
    )
}

/// `helpers::get_attr_num` on ONE already-picked attribute: JS `Number(x) || 0`, where `''` and
/// whitespace are 0 and anything unparseable is NaN → 0.
fn num(col: &str) -> String {
    format!("coalesce(TRY_CAST(nullif(trim(p.{col}), '') AS DOUBLE), 0)")
}

/// `helpers::first_nonzero`: the first key whose numeric value is non-zero, in the SAME order the
/// Rust lists them. A CASE ladder rather than a `coalesce`, because the fall-through condition is
/// "reads as zero", not "is absent" — a present `output_tokens: 0` must fall through to the codex
/// split counters, which `coalesce` would not do.
fn first_nonzero(cols: &[&str]) -> String {
    let mut sql = String::from("CASE ");
    for c in cols {
        sql.push_str(&format!("WHEN {n} <> 0 THEN {n} ", n = num(c)));
    }
    sql.push_str("ELSE 0 END");
    sql
}

#[cfg(test)]
mod spill_tests {
    use super::*;

    /// `new` declares the 512MiB server limit and a real spill dir at the given path.
    #[test]
    fn new_declares_512mib_and_the_given_spill_dir() {
        let tmp = std::env::temp_dir().join(format!("al-ss-spill-{}", std::process::id())).join("tmp/session-summary");
        let s = SessionSummarySql::new(&tmp);
        let lim: String = s.conn.query_row("SELECT current_setting('memory_limit')", [], |r| r.get(0)).unwrap();
        let dir: String = s.conn.query_row("SELECT current_setting('temp_directory')", [], |r| r.get(0)).unwrap();
        assert_eq!(lim, "512.0 MiB");
        assert_eq!(dir, tmp.to_string_lossy());
        assert!(tmp.is_dir());
        let _ = std::fs::remove_dir_all(tmp.parent().unwrap().parent().unwrap());
    }
}

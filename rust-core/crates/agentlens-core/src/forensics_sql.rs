//! `run_diagnostics_sql` — the TS `src/forensicsSql.ts` engine (TRDD-FB5RG4P1 design §6, ported
//! under TRDD-DMWOBWFH).
//!
//! Two modes over the forensics fact DB:
//!   preset — a curated, parameterized read-only query from the frozen library (§6.5);
//!   sql    — RAW read-only SELECT/WITH gated to a single read statement + the custom cost fns.
//!
//! SAFETY (§6.2): raw SQL runs on a read-only handle (`forensics_db::open_readonly_snapshot`),
//! passes a statement gate (single SELECT/WITH; DML/DDL/ATTACH/PRAGMA rejected; no second `;`),
//! params are BOUND (never concatenated), and every result is row-capped. Presets skip the gate
//! (they are frozen, not user-supplied) but still bind params + apply the cap.
//!
//! WHY THE ENGINE IS STILL SQLITE: this surface hands the caller's own SQL to the database. Moving
//! the fact tables to DuckDB would change the dialect under queries this project does not own.

use std::path::Path;
use std::sync::OnceLock;

use regex::Regex;
use rusqlite::Connection;
use serde_json::{Map, Value};

use crate::forensics_db::open_readonly_snapshot;
use crate::summarize::helpers::{fmt_js_num, js_slice, js_to_fixed_str, utf16_len};

const HARD_MAX_ROWS: f64 = 2000.0;
/// Token-lean default (the TS lowered this from 200) — pass a bigger `limit` explicitly for more.
const DEFAULT_ROWS: f64 = 50.0;
/// One wide TEXT/JSON column (e.g. a diff summary) must not blow up the payload.
const MAX_CELL_CHARS: usize = 500;

// ── Statement gate (design §6.2) ────────────────────────────────────────────────

/// `(?-u:\b)` — an ASCII word boundary, and it is load-bearing rather than pedantic.
///
/// JavaScript's `\b` is ASCII-only; the `regex` crate's is UNICODE by default. They disagree on
/// exactly the inputs this gate exists to catch: in `éDROP` the `é` is NOT a word character to JS,
/// so a boundary exists and the TS REJECTS the statement — while to Rust `é` IS one, so there is no
/// boundary, no match, and the gate would ACCEPT what the TS refuses. Measured both ways before
/// this was changed. A read-only gate that fails OPEN on a non-ASCII prefix is worse than no gate,
/// because callers believe it held.
const WORD_BOUNDARY: &str = r"(?-u:\b)";

fn forbidden() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(&format!(
            r"(?i){WORD_BOUNDARY}(ATTACH|DETACH|PRAGMA|INSERT|UPDATE|DELETE|DROP|CREATE|ALTER|REPLACE|VACUUM|REINDEX|TRIGGER){WORD_BOUNDARY}"
        ))
        .expect("forbidden-keyword regex")
    })
}

fn strip_comments(sql: &str) -> String {
    static LINE: OnceLock<Regex> = OnceLock::new();
    static BLOCK: OnceLock<Regex> = OnceLock::new();
    let line = LINE.get_or_init(|| Regex::new(r"--[^\n]*").expect("line-comment regex"));
    // `[\s\S]*?` in the TS — a non-greedy any-including-newline, which is `(?s).*?` here.
    let block = BLOCK.get_or_init(|| Regex::new(r"(?s)/\*.*?\*/").expect("block-comment regex"));
    let once = line.replace_all(sql, " ");
    block.replace_all(&once, " ").into_owned()
}

/// `Err` with a clear message when `sql` is not exactly one read-only SELECT/WITH statement.
/// Fail-closed — the TS throws here and the caller turns it into an `{error}` payload.
pub fn assert_read_only_select(raw_sql: &str) -> Result<String, String> {
    static TRAILING: OnceLock<Regex> = OnceLock::new();
    static HEAD: OnceLock<Regex> = OnceLock::new();
    let cleaned = strip_comments(raw_sql).trim().to_owned();
    if cleaned.is_empty() {
        return Err("Empty SQL.".to_owned());
    }
    // Allow at most ONE trailing semicolon; a semicolon anywhere else = a second statement.
    let trailing = TRAILING.get_or_init(|| Regex::new(r";\s*$").expect("trailing-semicolon regex"));
    let no_trailing = trailing.replace(&cleaned, "").into_owned();
    if no_trailing.contains(';') {
        return Err("Only a single statement is allowed (a second \";\" was found).".to_owned());
    }
    let head = HEAD.get_or_init(|| {
        Regex::new(&format!(r"(?i)^(SELECT|WITH){WORD_BOUNDARY}")).expect("head regex")
    });
    if !head.is_match(&no_trailing) {
        return Err("Only read-only SELECT or WITH queries are allowed.".to_owned());
    }
    if forbidden().is_match(&no_trailing) {
        return Err("DDL/DML/ATTACH/PRAGMA keywords are rejected — this surface is read-only.".to_owned());
    }
    Ok(no_trailing)
}

// ── Preset library (design §6.5) ────────────────────────────────────────────────
// Every preset optionally windows on :since (a ts cutoff derived from params.window hours).
// Lift/spike presets take :mult (params.k, default 5) and :minCount (default 3). All params are
// bound. A SLICE, not a map, because `list` mode ships the library in DECLARATION order.

/// The `${TIME}` fragment the TS interpolates into nearly every preset.
const TIME: &str = "(:since IS NULL OR a.ts >= :since)";

pub struct Preset {
    pub name: &'static str,
    pub description: &'static str,
    /// `{TIME}` is substituted at build time — the TS template literal, kept as a marker so the two
    /// files diff line-for-line.
    sql: &'static str,
}

pub const PRESETS: &[Preset] = &[
    Preset {
        name: "worst_configs_by_cache_creation",
        description: "Worst spawn_kind × model on avg cache_creation.",
        sql: "SELECT COALESCE(a.spawn_kind,'unresolved') AS spawn_kind, COALESCE(a.model,'(unknown)') AS model,
      COUNT(*) AS calls, AVG(a.cache_creation_tokens) AS avg_cc, SUM(a.cache_creation_tokens) AS sum_cc,
      SUM(a.billable_weight) AS billable_usd
      FROM api_calls a WHERE {TIME}
      GROUP BY a.spawn_kind, a.model ORDER BY avg_cc DESC",
    },
    Preset {
        name: "fork_vs_fresh",
        description: "Forked vs fresh subagents, side by side (avg/sum cache_creation + output + billable).",
        sql: "SELECT a.spawn_kind, COUNT(*) AS calls, AVG(a.cache_creation_tokens) AS avg_cc,
      AVG(a.output_tokens) AS avg_out, SUM(a.billable_weight) AS billable_usd
      FROM api_calls a WHERE a.spawn_kind IN ('fork','fresh') AND {TIME}
      GROUP BY a.spawn_kind ORDER BY avg_cc DESC",
    },
    Preset {
        name: "worktree_cost_delta",
        description: "Worktree vs non-worktree per-call billable cost.",
        sql: "SELECT CASE WHEN a.spawn_kind='worktree' THEN 'worktree' ELSE 'rest' END AS bucket,
      COUNT(*) AS calls, AVG(a.billable_weight) AS avg_billable, AVG(a.cache_creation_tokens) AS avg_cc
      FROM api_calls a WHERE {TIME} GROUP BY bucket ORDER BY avg_billable DESC",
    },
    Preset {
        name: "chronic_offenders",
        description: "Recurring (break_cause, culprit_fingerprint) pairs (≥ :minCount) by total cache_creation.",
        sql: "SELECT a.break_cause, a.culprit_fingerprint, COUNT(*) AS hits, SUM(a.cache_creation_tokens) AS sum_cc
      FROM api_calls a WHERE a.break_cause IS NOT NULL AND {TIME}
      GROUP BY a.break_cause, a.culprit_fingerprint HAVING COUNT(*) >= :minCount ORDER BY sum_cc DESC",
    },
    Preset {
        name: "output_peaks_by_skill",
        description: "Skills present on output-token spikes (≥ :mult× the mean output), ranked by spike count.",
        sql: "SELECT ci.name AS skill, COUNT(*) AS spike_calls, AVG(a.output_tokens) AS avg_out
      FROM api_calls a JOIN call_injections ci ON ci.call_id=a.call_id AND ci.kind='skill'
      WHERE a.output_tokens >= :mult * (SELECT AVG(output_tokens) FROM api_calls) AND {TIME}
      GROUP BY ci.name ORDER BY spike_calls DESC",
    },
    Preset {
        name: "cache_by_skill",
        description: "Per-skill avg cache_creation LIFT vs the global mean (≥ :minCount calls).",
        sql: "SELECT ci.name AS skill, COUNT(*) AS calls, AVG(a.cache_creation_tokens) AS avg_cc,
      AVG(a.cache_creation_tokens) / NULLIF((SELECT AVG(cache_creation_tokens) FROM api_calls),0) AS lift
      FROM api_calls a JOIN call_injections ci ON ci.call_id=a.call_id AND ci.kind='skill'
      WHERE {TIME} GROUP BY ci.name HAVING COUNT(*) >= :minCount ORDER BY lift DESC",
    },
    Preset {
        name: "cache_by_mcp",
        description: "Per-MCP-server avg cache_creation LIFT vs the global mean (≥ :minCount calls).",
        sql: "SELECT ci.name AS mcp, COUNT(*) AS calls, AVG(a.cache_creation_tokens) AS avg_cc,
      AVG(a.cache_creation_tokens) / NULLIF((SELECT AVG(cache_creation_tokens) FROM api_calls),0) AS lift
      FROM api_calls a JOIN call_injections ci ON ci.call_id=a.call_id AND ci.kind='mcp'
      WHERE {TIME} GROUP BY ci.name HAVING COUNT(*) >= :minCount ORDER BY lift DESC",
    },
    Preset {
        name: "cache_by_rule",
        description: "Per-rule avg cache_creation LIFT vs the global mean (≥ :minCount calls).",
        sql: "SELECT ci.name AS rule, COUNT(*) AS calls, AVG(a.cache_creation_tokens) AS avg_cc,
      AVG(a.cache_creation_tokens) / NULLIF((SELECT AVG(cache_creation_tokens) FROM api_calls),0) AS lift
      FROM api_calls a JOIN call_injections ci ON ci.call_id=a.call_id AND ci.kind='rule'
      WHERE {TIME} GROUP BY ci.name HAVING COUNT(*) >= :minCount ORDER BY lift DESC",
    },
    Preset {
        name: "content_tag_ranking",
        description: "cache_creation & output by content tag.",
        sql: "SELECT cc.tag, COUNT(*) AS calls, SUM(a.cache_creation_tokens) AS sum_cc, SUM(a.output_tokens) AS sum_out
      FROM api_calls a JOIN call_content cc ON cc.call_id=a.call_id
      WHERE {TIME} GROUP BY cc.tag ORDER BY sum_cc DESC",
    },
    Preset {
        name: "image_burn",
        description: "Calls carrying images, ranked by cache_creation.",
        sql: "SELECT a.call_id, a.session_id, a.model, a.cache_creation_tokens, cc.tokens AS image_tokens, a.response_ref
      FROM api_calls a JOIN call_content cc ON cc.call_id=a.call_id AND cc.tag='image'
      WHERE {TIME} ORDER BY a.cache_creation_tokens DESC",
    },
    Preset {
        name: "model_effort_matrix",
        description: "model × effort avg cache_creation + output.",
        sql: "SELECT COALESCE(a.model,'(unknown)') AS model, a.effort, COUNT(*) AS calls,
      AVG(a.cache_creation_tokens) AS avg_cc, AVG(a.output_tokens) AS avg_out
      FROM api_calls a WHERE {TIME} GROUP BY a.model, a.effort ORDER BY avg_cc DESC",
    },
    Preset {
        name: "break_cause_ranking",
        description: "break_cause by total cache_creation & count (needs cacheBreakTimeline-populated causes).",
        sql: "SELECT a.break_cause, COUNT(*) AS hits, SUM(a.cache_creation_tokens) AS sum_cc
      FROM api_calls a WHERE a.break_cause IS NOT NULL AND {TIME}
      GROUP BY a.break_cause ORDER BY sum_cc DESC",
    },
    Preset {
        name: "root_cause_leaderboard",
        description: "culprit_fingerprint by total cache_creation with a representative response_ref to drill.",
        sql: "SELECT a.culprit_fingerprint, a.break_cause, COUNT(*) AS hits, SUM(a.cache_creation_tokens) AS sum_cc,
      MIN(a.response_ref) AS sample_ref
      FROM api_calls a WHERE a.culprit_fingerprint IS NOT NULL AND {TIME}
      GROUP BY a.culprit_fingerprint ORDER BY sum_cc DESC",
    },
    Preset {
        name: "unresolved_audit",
        description: "Coverage of unresolved spawn attribution (count / tokens / share).",
        sql: "SELECT a.spawn_resolution, COUNT(*) AS calls, SUM(a.cache_creation_tokens) AS sum_cc,
      SUM(a.billable_weight) AS billable_usd
      FROM api_calls a WHERE {TIME} GROUP BY a.spawn_resolution ORDER BY calls DESC",
    },
    Preset {
        name: "session_hotlist",
        description: "Sessions by total billable_weight + spawn_kind (heaviest first).",
        sql: "SELECT a.session_id, MIN(a.spawn_kind) AS spawn_kind, COUNT(*) AS calls,
      SUM(a.billable_weight) AS billable_usd, SUM(a.cache_creation_tokens) AS sum_cc
      FROM api_calls a WHERE a.session_id IS NOT NULL AND {TIME}
      GROUP BY a.session_id ORDER BY billable_usd DESC",
    },
    Preset {
        name: "tier_split_by_config",
        description: "5m vs 1h cache tier share per spawn_kind (heartbeat relevance).",
        sql: "SELECT COALESCE(a.spawn_kind,'unresolved') AS spawn_kind, COUNT(*) AS calls,
      SUM(a.tier_5m_tokens) AS tier_5m, SUM(a.tier_1h_tokens) AS tier_1h
      FROM api_calls a WHERE {TIME} GROUP BY a.spawn_kind ORDER BY (tier_5m + tier_1h) DESC",
    },
    Preset {
        name: "unclassified_events",
        description: "Cache-write spikes (≥ :mult× the mean) with NO classified break cause — the drill-down list an UNCLASSIFIED investigation starts from.",
        // Born from a real investigation (2026-08-13): a spike the CLI reported as UNCLASSIFIED took
        // minutes of ad-hoc scanning to even LIST. This is that list, one preset call.
        sql: "SELECT a.call_id, a.session_id, a.model, a.ts, a.cache_creation_tokens, a.tier_1h_tokens,
      a.break_cause, a.response_ref
      FROM api_calls a
      WHERE (a.break_cause IS NULL OR a.break_cause = 'UNCLASSIFIED')
        AND a.cache_creation_tokens >= :mult * (SELECT AVG(cache_creation_tokens) FROM api_calls)
        AND {TIME}
      ORDER BY a.cache_creation_tokens DESC",
    },
    Preset {
        name: "schema",
        description: "The fact DB tables and their CREATE statements — write raw `sql` mode queries against this instead of guessing columns.",
        sql: "SELECT m.name AS table_name, m.sql AS create_sql
      FROM sqlite_master m WHERE m.type = 'table' ORDER BY m.name",
    },
];

fn preset_sql(p: &Preset) -> String {
    p.sql.replace("{TIME}", TIME)
}

/// DELIBERATE DIVERGENCE, in the port's favour. The TS `PRESETS` is a plain object literal, so it
/// inherits from `Object.prototype`: `PRESETS["toString"]` is a truthy inherited FUNCTION, the
/// `if (!p)` unknown-preset branch never fires, and `p.sql` is `undefined` — producing the
/// malformed `SELECT * FROM (undefined) LIMIT :__cap` and a confusing `Query failed:` message for
/// ~8 preset names. Verified truthy against the compiled TS. A slice has no prototype chain, so
/// every unknown name here gets the clean "Unknown preset" answer. Reproducing a
/// prototype-fallthrough bug is not parity, it is copying a defect.
fn find_preset(name: &str) -> Option<&'static Preset> {
    PRESETS.iter().find(|p| p.name == name)
}

// ── param binding ───────────────────────────────────────────────────────────────
// Bind ONLY the :names actually referenced by the final SQL, drawn from a pool of {user params +
// derived since/mult/minCount + the row cap}. A referenced-but-unprovided known param binds NULL.

fn build_param_pool(params: Option<&Map<String, Value>>, cap: f64, now_ms: f64) -> Map<String, Value> {
    let empty = Map::new();
    let user = params.unwrap_or(&empty);
    let n = |k: &str| user.get(k).and_then(Value::as_f64);
    let (window_h, k, min_count) = (n("window"), n("k"), n("minCount"));

    // The TS spreads `user` FIRST, so the four derived keys below override any same-named user key.
    let mut pool = user.clone();
    pool.insert(
        "since".into(),
        // `windowH && windowH > 0` — a window of 0 is falsy in the TS and falls through to
        // `user.since ?? null` rather than becoming "now".
        match window_h {
            Some(w) if w > 0.0 => crate::summarize::helpers::num(now_ms - w * 3_600_000.0),
            _ => match user.get("since") {
                Some(v) if !v.is_null() => v.clone(),
                _ => Value::Null,
            },
        },
    );
    // `k ?? user.mult ?? 5` — user.mult is used RAW (any type) when k is absent.
    pool.insert(
        "mult".into(),
        match k {
            Some(v) => crate::summarize::helpers::num(v),
            None => match user.get("mult") {
                Some(v) if !v.is_null() => v.clone(),
                _ => Value::from(5),
            },
        },
    );
    // A non-numeric minCount is REPLACED by 3 (the TS narrows with `typeof === 'number'` first).
    pool.insert("minCount".into(), Value::from(min_count.unwrap_or(3.0)));
    pool.insert("__cap".into(), crate::summarize::helpers::num(cap));
    pool
}

/// The `:name` occurrences the TS scans for. Names that SQLite does not actually expose as
/// parameters (e.g. a `:word` inside a string literal) are skipped at bind time — which is exactly
/// what sql.js's `bindFromObject` does when `sqlite3_bind_parameter_index` returns 0.
fn param_names(sql: &str) -> Vec<String> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r":([a-zA-Z_][a-zA-Z0-9_]*)").expect("param-name regex"));
    re.captures_iter(sql).map(|c| c[1].to_owned()).collect()
}

/// Bind one pool value. Scalars only — sql.js throws "Wrong API use" on an array/object, which the
/// TS surfaces through the same `Query failed:` path this Err takes.
fn bind_value(stmt: &mut rusqlite::Statement<'_>, idx: usize, v: &Value) -> Result<(), String> {
    use rusqlite::types::Value as SqlValue;
    let bound = match v {
        Value::Null => SqlValue::Null,
        Value::Bool(b) => SqlValue::Integer(i64::from(*b)),
        Value::Number(n) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            // sql.js's exact rule: `num === (num | 0) ? bind_int : bind_double` — INT32, not 2^53.
            // The threshold was 2^53 here, which disagreed with both sql.js and the sibling helper
            // in forensics_compare; SQLite's numeric affinity makes the two indistinguishable in a
            // comparison, but `typeof()` reports them differently and one rule is better than two.
            if f.fract() == 0.0 && f.is_finite() && f.abs() <= f64::from(i32::MAX) {
                SqlValue::Integer(f as i64)
            } else {
                SqlValue::Real(f)
            }
        }
        Value::String(s) => SqlValue::Text(s.clone()),
        // DELIBERATE DIVERGENCE. sql.js THROWS on a plain object (so the TS call fails) but binds an
        // ARRAY as a BLOB (so the TS call succeeds against a value that can never equal a TEXT or
        // numeric column). Both are ways of saying "this parameter is a caller bug"; erroring on
        // both says it once, and says it clearly, instead of half-succeeding on the array.
        _ => return Err("tried to bind a value of an unknown type (array/object)".to_owned()),
    };
    stmt.raw_bind_parameter(idx, bound).map_err(|e| sql_err(&e))
}

struct Rows {
    columns: Vec<String>,
    rows: Vec<Value>,
}

/// The message the CALLER sees for a bad query. rusqlite's `SqlInputError` Display appends
/// ` in <the whole statement> at offset N`; sql.js surfaces only SQLite's own `errmsg`. Both come
/// from the same C string, so taking `msg` alone is byte-identical to the TS — and it also keeps the
/// full (capped-and-wrapped) SQL out of an error payload that is re-read on every later turn.
fn sql_err(e: &rusqlite::Error) -> String {
    match e {
        rusqlite::Error::SqlInputError { msg, .. } => msg.clone(),
        other => other.to_string(),
    }
}

fn exec_rows(conn: &Connection, sql: &str, pool: &Map<String, Value>) -> Result<Rows, String> {
    let mut stmt = conn.prepare(sql).map_err(|e| sql_err(&e))?;
    for name in param_names(sql) {
        // `pool[name] !== undefined ? pool[name] : null` — a referenced but unknown name binds NULL.
        let v = pool.get(&name).cloned().unwrap_or(Value::Null);
        if let Some(idx) = stmt.parameter_index(&format!(":{name}")).map_err(|e| sql_err(&e))? {
            bind_value(&mut stmt, idx, &v)?;
        }
    }
    let col_names: Vec<String> = stmt.column_names().iter().map(|s| (*s).to_owned()).collect();

    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Value> = Vec::new();
    let mut cursor = stmt.raw_query();
    while let Some(r) = cursor.next().map_err(|e| sql_err(&e))? {
        let mut obj = Map::new();
        for (i, c) in col_names.iter().enumerate() {
            let v = match r.get_ref(i).map_err(|e| sql_err(&e))? {
                rusqlite::types::ValueRef::Null => Value::Null,
                rusqlite::types::ValueRef::Integer(v) => Value::from(v),
                rusqlite::types::ValueRef::Real(v) => crate::summarize::helpers::num(v),
                rusqlite::types::ValueRef::Text(b) => Value::String(String::from_utf8_lossy(b).into_owned()),
                // No fact column is a BLOB; a JS object would carry a Uint8Array here.
                rusqlite::types::ValueRef::Blob(_) => Value::Null,
            };
            // A duplicate column name overwrites in place, exactly as a JS object literal does.
            obj.insert(c.clone(), v);
        }
        for c in obj.keys() {
            if !columns.iter().any(|k| k == c) {
                columns.push(c.clone());
            }
        }
        rows.push(Value::Object(obj));
    }
    Ok(Rows { columns, rows })
}

// Cap any single wide cell (a TEXT/JSON column can otherwise dominate the whole payload) — applied
// to every row BEFORE it reaches the caller, so json/table/markdown all see the same bounded values.
fn truncate_cell(v: &Value) -> Value {
    if let Value::String(s) = v {
        let len = utf16_len(s);
        if len > MAX_CELL_CHARS {
            return Value::String(format!(
                "{}…(+{} chars, cell truncated)",
                js_slice(s, MAX_CELL_CHARS),
                len - MAX_CELL_CHARS
            ));
        }
    }
    v.clone()
}

fn truncate_rows(rows: &[Value]) -> Vec<Value> {
    rows.iter()
        .map(|r| match r {
            Value::Object(m) => {
                Value::Object(m.iter().map(|(k, v)| (k.clone(), truncate_cell(v))).collect())
            }
            other => other.clone(),
        })
        .collect()
}

// ── formats ─────────────────────────────────────────────────────────────────────

/// `cell(v)` — the TS renders a number as a bare integer or `toFixed(3)`, everything else through
/// `String(v)`, and null/undefined as the empty string.
fn cell(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::Number(n)) => {
            let f = n.as_f64().unwrap_or(f64::NAN);
            // `Number.isInteger` is false for NaN/±Infinity, so those take the toFixed path — where
            // JS prints "NaN"/"Infinity" and Rust's formatter would print "inf".
            if f.is_nan() {
                "NaN".to_owned()
            } else if f.is_infinite() {
                if f > 0.0 { "Infinity".to_owned() } else { "-Infinity".to_owned() }
            } else if f.fract() == 0.0 {
                fmt_js_num(f)
            } else {
                js_to_fixed_str(f, 3)
            }
        }
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(other) => other.to_string(),
    }
}

/// `String.prototype.padEnd` in UTF-16 units, inline rather than through `helpers::pad_end`: that
/// helper pads by CHAR count under a documented "every value here is ASCII" premise, and a table
/// cell is arbitrary database text. Width and padding must use the same unit as the TS or an
/// astral character silently misaligns the column it sits in.
fn pad_end_u16(s: &str, width: usize) -> String {
    let len = utf16_len(s);
    if len >= width {
        return s.to_owned();
    }
    format!("{}{}", s, " ".repeat(width - len))
}

fn render_table(columns: &[String], rows: &[Value]) -> String {
    if columns.is_empty() {
        return "(no rows)".to_owned();
    }
    let widths: Vec<usize> = columns
        .iter()
        .map(|c| {
            rows.iter()
                .map(|r| utf16_len(&cell(r.get(c))))
                .chain([utf16_len(c), 3])
                .max()
                .unwrap_or(3)
        })
        .collect();
    let bar = |l: &str, mid: &str, rgt: &str, fill: &str| {
        let body: Vec<String> = widths.iter().map(|w| fill.repeat(w + 2)).collect();
        format!("{l}{}{rgt}", body.join(mid))
    };
    let mut out: Vec<String> = Vec::new();
    out.push(bar("┏", "┳", "┓", "━"));
    out.push(format!(
        "┃ {} ┃",
        columns
            .iter()
            .enumerate()
            .map(|(i, c)| pad_end_u16(c, widths[i]))
            .collect::<Vec<_>>()
            .join(" ┃ ")
    ));
    out.push(bar("┡", "╇", "┩", "━"));
    for r in rows {
        out.push(format!(
            "│ {} │",
            columns
                .iter()
                .enumerate()
                .map(|(i, c)| pad_end_u16(&cell(r.get(c)), widths[i]))
                .collect::<Vec<_>>()
                .join(" │ ")
        ));
    }
    out.push(bar("└", "┴", "┘", "─"));
    out.join("\n")
}

fn render_markdown(columns: &[String], rows: &[Value]) -> String {
    if columns.is_empty() {
        return "(no rows)".to_owned();
    }
    let head = format!("| {} |", columns.join(" | "));
    let sep = format!("| {} |", columns.iter().map(|_| "---").collect::<Vec<_>>().join(" | "));
    let body = rows
        .iter()
        .map(|r| format!("| {} |", columns.iter().map(|c| cell(r.get(c))).collect::<Vec<_>>().join(" | ")))
        .collect::<Vec<_>>()
        .join("\n");
    [head, sep, body].join("\n")
}

// ── entry point ─────────────────────────────────────────────────────────────────

#[derive(Default)]
pub struct RunDiagnosticsSqlOptions<'a> {
    pub preset: Option<&'a str>,
    pub sql: Option<&'a str>,
    pub params: Option<&'a Map<String, Value>>,
    pub format: Option<&'a str>,
    pub limit: Option<f64>,
}

/// Insert only when present — a JS `{ preset: undefined }` key vanishes on the wire, and the
/// parity oracle compares the key SET and ORDER.
fn put(m: &mut Map<String, Value>, k: &str, v: Option<Value>) {
    if let Some(v) = v {
        m.insert(k.to_owned(), v);
    }
}

fn obj(pairs: Vec<(&str, Option<Value>)>) -> Value {
    let mut m = Map::new();
    for (k, v) in pairs {
        put(&mut m, k, v);
    }
    Value::Object(m)
}

/// Run a preset or a raw read-only query over forensics.db. The MCP handler runs
/// `ensure_fresh_index` first. Returns `dbAvailable:false` with a note when the fact DB is
/// unavailable, or an `{error}` object (never a panic) when the statement gate rejects a query.
pub fn run_diagnostics_sql(db_path: &Path, opts: &RunDiagnosticsSqlOptions<'_>, now_ms: f64) -> Value {
    let format = opts.format.unwrap_or("json");
    // A NaN limit cannot arrive over the wire (serde_json cannot hold one, so `as_f64` never yields
    // NaN), but a direct Rust caller could pass one — and NaN survives `clamp`, binds as SQL NULL,
    // and `LIMIT NULL` means NO LIMIT. That is the one failure this cap exists to prevent, so NaN
    // falls back to the default instead.
    //
    // DELIBERATE, MEASURED DIVERGENCE: the TS reaches a different place. sql.js binds a REAL NaN,
    // and SQLite answers `LIMIT NaN` with a `datatype mismatch` error, so the TS returns
    // `Query failed: datatype mismatch`. An earlier comment here claimed both sides bound NULL;
    // that was wrong, and the check that disproved it was one sql.js call. A bounded default beats
    // both an unbounded scan and an error, on a path no client can reach.
    let cap = opts.limit.filter(|l| !l.is_nan()).unwrap_or(DEFAULT_ROWS).clamp(1.0, HARD_MAX_ROWS);
    // Empty strings are falsy in the TS — `preset: ""` means "no preset", not "the preset named ''".
    let preset = opts.preset.filter(|s| !s.is_empty());
    let sql = opts.sql.filter(|s| !s.is_empty());

    // No mode → list the preset library.
    if preset.is_none() && sql.is_none() {
        let presets: Vec<Value> = PRESETS
            .iter()
            .map(|p| serde_json::json!({ "name": p.name, "description": p.description }))
            .collect();
        return obj(vec![
            ("mode", Some(Value::from("list"))),
            ("dbAvailable", Some(Value::Bool(true))),
            ("presets", Some(Value::Array(presets))),
        ]);
    }
    if preset.is_some() && sql.is_some() {
        return obj(vec![
            ("mode", Some(Value::from("sql"))),
            ("dbAvailable", Some(Value::Bool(true))),
            ("error", Some(Value::from("Provide EITHER preset OR sql, not both."))),
        ]);
    }

    let (inner, mode) = if let Some(name) = preset {
        match find_preset(name) {
            Some(p) => (preset_sql(p), "preset"),
            None => {
                return obj(vec![
                    ("mode", Some(Value::from("preset"))),
                    ("dbAvailable", Some(Value::Bool(true))),
                    (
                        "error",
                        Some(Value::String(format!(
                            "Unknown preset \"{name}\". Call with no args to list the library."
                        ))),
                    ),
                ])
            }
        }
    } else {
        match assert_read_only_select(sql.expect("sql is Some when preset is None")) {
            Ok(s) => (s, "sql"),
            Err(msg) => {
                return obj(vec![
                    ("mode", Some(Value::from("sql"))),
                    ("dbAvailable", Some(Value::Bool(true))),
                    ("error", Some(Value::String(msg))),
                ])
            }
        }
    };
    let preset_field = || preset.map(Value::from);

    let Some(conn) = open_readonly_snapshot(db_path, now_ms) else {
        return obj(vec![
            ("mode", Some(Value::from(mode))),
            ("preset", preset_field()),
            ("dbAvailable", Some(Value::Bool(false))),
            ("note", Some(Value::from("forensics.db unavailable (no OTEL bodies indexed yet, or sql.js unavailable in this runtime)."))),
        ]);
    };

    let capped = format!("SELECT * FROM ({inner}) LIMIT :__cap");
    let pool = build_param_pool(opts.params, cap, now_ms);
    let Rows { columns, rows } = match exec_rows(&conn, &capped, &pool) {
        Ok(r) => r,
        Err(msg) => {
            return obj(vec![
                ("mode", Some(Value::from(mode))),
                ("preset", preset_field()),
                ("dbAvailable", Some(Value::Bool(true))),
                ("error", Some(Value::String(format!("Query failed: {msg}")))),
            ])
        }
    };
    let rows = truncate_rows(&rows);
    // Row-cap honesty: hitting the cap exactly doesn't PROVE more rows exist (the true count is
    // never queried — that would cost a second full scan), but it's the only cheap signal, so say so.
    let note = (rows.len() as f64 >= cap).then(|| {
        Value::String(format!(
            "Row cap reached ({}). There may be more — raise `limit` to see them (hard max {}).",
            fmt_js_num(cap),
            fmt_js_num(HARD_MAX_ROWS)
        ))
    });

    if format == "table" || format == "markdown" {
        // Summary-first default: the rendered string carries the same data as `rows` — returning
        // both would double the payload, so json is the only mode that ships raw rows.
        let rendered = if format == "table" {
            render_table(&columns, &rows)
        } else {
            render_markdown(&columns, &rows)
        };
        return obj(vec![
            ("mode", Some(Value::from(mode))),
            ("preset", preset_field()),
            ("rowCount", Some(Value::from(rows.len()))),
            ("rendered", Some(Value::String(rendered))),
            ("dbAvailable", Some(Value::Bool(true))),
            ("note", note),
        ]);
    }
    obj(vec![
        ("mode", Some(Value::from(mode))),
        ("preset", preset_field()),
        ("columns", Some(Value::Array(columns.into_iter().map(Value::from).collect()))),
        ("rows", Some(Value::Array(rows.clone()))),
        ("rowCount", Some(Value::from(rows.len()))),
        ("dbAvailable", Some(Value::Bool(true))),
        ("note", note),
    ])
}

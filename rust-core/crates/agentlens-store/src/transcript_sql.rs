//! Port of `src/transcriptSql.ts` (TRDD-DMWOBWFH P4x.2o) — `run_transcript_sql`: ad-hoc DuckDB SQL
//! over the Claude session transcripts, as ONE relation built from a BOUNDED file list.
//!
//! It lives in `agentlens-store` rather than `agentlens-core` for one reason: this crate owns the
//! DuckDB binding, and `core` already depends on it. Putting it the other way round would add a
//! second native dependency edge for the same engine.
//!
//! BOUNDING (the disk half of the same lesson the store learned): the projects tree holds 17k+
//! transcripts, so the view is NEVER built over the whole corpus. Files are pre-filtered in Rust —
//! one file for a sessionId query, else an mtime window — and passed as an EXPLICIT LIST, never a
//! bare glob, because an empty glob is a DuckDB ERROR rather than an empty set.
//!
//! SAFETY: the statement gate admits exactly one read-only SELECT/WITH. No caller string is ever
//! interpolated into SQL — a sessionId selects FILES in Rust, and the only embedded values are
//! validated integers and paths this module itself walked.

use std::path::{Path, PathBuf};

use serde_json::{Map, Value};

/// DuckDB's per-object cap for `read_ndjson_auto`. A single transcript record can be large (a whole
/// tool result), and the default rejects the file outright rather than the record.
pub const MAX_OBJECT_SIZE: u64 = 268_435_456;

const HARD_MAX_ROWS: i64 = 2000;
/// Token-lean default, same rationale as `run_diagnostics_sql`.
const DEFAULT_ROWS: i64 = 50;
const DEFAULT_WINDOW_HOURS: f64 = 24.0;

/// The frozen preset library, in the TS's declaration order — which is also the order `list` prints
/// and the order the "Valid: …" error lists. The SQL is copied verbatim; the view already contains
/// ONLY the bounded file set, so presets need no windowing of their own.
///
/// Sparse-schema discipline (`union_by_name`): filter `type='assistant'` BEFORE touching
/// `message.usage.*`, and `TRY_CAST` the numbers so one odd-shaped record degrades to NULL instead
/// of failing the whole aggregate.
pub const TRANSCRIPT_PRESETS: &[(&str, &str, &str)] = &[
    (
        "record_type_histogram",
        "What record shapes exist in the queried transcripts (the schema-discovery entry point).",
        "SELECT type, count(*) AS records FROM transcripts GROUP BY type ORDER BY records DESC",
    ),
    (
        "usage_by_model",
        "Per-model assistant records + token buckets (input/output/cache read/cache create).",
        "SELECT message.model AS model, count(*) AS assistant_records,
            sum(TRY_CAST(message.usage.input_tokens AS BIGINT)) AS input_tokens,
            sum(TRY_CAST(message.usage.output_tokens AS BIGINT)) AS output_tokens,
            sum(TRY_CAST(message.usage.cache_read_input_tokens AS BIGINT)) AS cache_read_tokens,
            sum(TRY_CAST(message.usage.cache_creation_input_tokens AS BIGINT)) AS cache_create_tokens
          FROM transcripts WHERE type = 'assistant' AND message.usage IS NOT NULL
          GROUP BY 1 ORDER BY output_tokens DESC",
    ),
    (
        "cache_heavy_turns",
        "Assistant records ranked by cache_creation tokens — where the expensive prefix re-writes are.",
        "SELECT filename, \"timestamp\", message.model AS model,
            TRY_CAST(message.usage.cache_creation_input_tokens AS BIGINT) AS cache_create_tokens,
            TRY_CAST(message.usage.cache_read_input_tokens AS BIGINT) AS cache_read_tokens
          FROM transcripts
          WHERE type = 'assistant' AND message.usage.cache_creation_input_tokens IS NOT NULL
          ORDER BY cache_create_tokens DESC",
    ),
    (
        "sessions_by_output",
        "Per-session assistant records + output tokens, heaviest first.",
        "SELECT coalesce(\"sessionId\", filename) AS session, count(*) AS assistant_records,
            sum(TRY_CAST(message.usage.output_tokens AS BIGINT)) AS output_tokens
          FROM transcripts WHERE type = 'assistant'
          GROUP BY 1 ORDER BY output_tokens DESC",
    ),
];

fn preset(name: &str) -> Option<&'static (&'static str, &'static str, &'static str)> {
    TRANSCRIPT_PRESETS.iter().find(|(n, _, _)| *n == name)
}

#[derive(Default)]
pub struct TranscriptSqlOptions<'a> {
    pub preset: Option<&'a str>,
    pub sql: Option<&'a str>,
    /// Query exactly this session's transcript (fast path — one file, no window).
    pub session_id: Option<&'a str>,
    /// Only files modified in the last N hours feed the view (default 24; ignored with sessionId).
    pub window_hours: Option<f64>,
    pub limit: Option<f64>,
    pub projects_dirs: Vec<PathBuf>,
}

/// `stripComments` + the single-statement / read-only checks, fail-CLOSED.
///
/// Comments are stripped FIRST, which is the whole point: `SELECT 1 /* x */ ; DROP TABLE t` hides a
/// second statement behind a comment, and a gate that scanned the raw text for `;` would see the
/// semicolon inside no comment at all and still have to reject it — but one that stripped nothing
/// would mis-handle a `;` INSIDE a comment. Strip, then count.
pub fn assert_read_only_select(raw_sql: &str) -> Result<String, String> {
    let cleaned = strip_comments(raw_sql);
    let cleaned = cleaned.trim();
    if cleaned.is_empty() {
        return Err("Empty SQL.".to_owned());
    }
    // At most ONE trailing semicolon; a semicolon anywhere else is a second statement.
    let no_trailing = strip_trailing_semicolon(cleaned);
    if no_trailing.contains(';') {
        return Err("Only a single statement is allowed (a second \";\" was found).".to_owned());
    }
    let head = no_trailing.trim_start();
    if !(starts_with_word(head, "SELECT") || starts_with_word(head, "WITH")) {
        return Err("Only read-only SELECT or WITH queries are allowed.".to_owned());
    }
    if has_forbidden_keyword(no_trailing) {
        return Err("DDL/DML/ATTACH/PRAGMA keywords are rejected — this surface is read-only.".to_owned());
    }
    Ok(no_trailing.to_owned())
}

const FORBIDDEN: &[&str] = &[
    "ATTACH", "DETACH", "PRAGMA", "INSERT", "UPDATE", "DELETE", "DROP", "CREATE", "ALTER", "REPLACE",
    "VACUUM", "REINDEX", "TRIGGER",
];

/// `/\b(ATTACH|…)\b/i` without a regex engine. `\b` here is the ASCII word boundary JS uses:
/// `[A-Za-z0-9_]` on either side ends the match, everything else is a boundary.
fn has_forbidden_keyword(sql: &str) -> bool {
    let up = sql.to_ascii_uppercase();
    let b = up.as_bytes();
    let word = |c: u8| c.is_ascii_alphanumeric() || c == b'_';
    FORBIDDEN.iter().any(|kw| {
        let k = kw.as_bytes();
        up.match_indices(kw).any(|(i, _)| {
            let before = i == 0 || !word(b[i - 1]);
            let after = i + k.len() >= b.len() || !word(b[i + k.len()]);
            before && after
        })
    })
}

fn starts_with_word(s: &str, kw: &str) -> bool {
    let up: String = s.chars().take(kw.len() + 1).collect::<String>().to_ascii_uppercase();
    up.starts_with(kw)
        && up.as_bytes().get(kw.len()).is_none_or(|c| !(c.is_ascii_alphanumeric() || *c == b'_'))
}

/// `.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ')` — line comments first, then the
/// NON-GREEDY block form, both replaced by a space so `a--x\nb` cannot fuse into one token.
fn strip_comments(sql: &str) -> String {
    let mut out = String::with_capacity(sql.len());
    let b = sql.as_bytes();
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'-' && b.get(i + 1) == Some(&b'-') {
            out.push(' ');
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
        } else {
            out.push(b[i] as char);
            i += 1;
        }
    }
    // The TS applies the two regexes in sequence over the WHOLE string, so a block comment that
    // survived the line pass is stripped here regardless of where it sits.
    let mut res = String::with_capacity(out.len());
    let ob = out.as_bytes();
    let mut j = 0;
    while j < ob.len() {
        if ob[j] == b'/' && ob.get(j + 1) == Some(&b'*') {
            match out[j + 2..].find("*/") {
                Some(end) => {
                    res.push(' ');
                    j = j + 2 + end + 2;
                }
                // Unterminated: the regex does not match, so the text stays verbatim.
                None => {
                    res.push_str(&out[j..]);
                    break;
                }
            }
        } else {
            res.push(ob[j] as char);
            j += 1;
        }
    }
    res
}

/// `.replace(/;\s*$/, '')`.
fn strip_trailing_semicolon(s: &str) -> &str {
    let t = s.trim_end();
    t.strip_suffix(';').map_or(s, str::trim_end)
}

fn list_transcript_files(dirs: &[PathBuf]) -> Vec<(PathBuf, f64)> {
    let mut out = Vec::new();
    for dir in dirs {
        walk(dir, &mut out);
    }
    out
}

/// `fs.readdirSync(dir, {recursive:true})` — subagent transcripts live one level deeper
/// (`<parent>/subagents/agent-*.jsonl`), so a non-recursive listing silently under-reports.
fn walk(dir: &Path, out: &mut Vec<(PathBuf, f64)>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        match e.file_type() {
            Ok(t) if t.is_dir() => walk(&p, out),
            Ok(_) if p.extension().is_some_and(|x| x == "jsonl") => {
                if let Some(ms) = mtime_ms(&p) {
                    out.push((p, ms));
                }
            }
            _ => {}
        }
    }
}

fn mtime_ms(p: &Path) -> Option<f64> {
    let t = std::fs::metadata(p).ok()?.modified().ok()?;
    Some(t.duration_since(std::time::UNIX_EPOCH).ok()?.as_millis() as f64)
}

/// A JS number as JS prints it. Rust's `{}` already agrees for everything a window-hours value can
/// be (`24` not `24.0`, `0.001` not `1e-3`); the two diverge only at the exponential extremes.
fn num_str(n: f64) -> String {
    format!("{n}")
}

fn obj(pairs: Vec<(&str, Value)>) -> Value {
    let mut m = Map::new();
    for (k, v) in pairs {
        m.insert(k.to_owned(), v);
    }
    Value::Object(m)
}

fn s(v: &str) -> Value {
    Value::String(v.to_owned())
}

/// Run a preset or a gated raw query over the bounded transcript set. NEVER returns an Err: every
/// failure mode is a `{error}` field beside the coverage that explains WHAT was queried, because a
/// bare error with no coverage cannot be told apart from "the window was empty".
pub fn run_transcript_sql(opts: &TranscriptSqlOptions<'_>, now_ms: f64) -> Value {
    let all = list_transcript_files(&opts.projects_dirs);
    let mut window_hours: Option<f64> = None;
    let files: Vec<&(PathBuf, f64)> = if let Some(sid) = opts.session_id {
        let want = format!("{sid}.jsonl");
        all.iter().filter(|(p, _)| p.file_name().is_some_and(|n| n == want.as_str())).collect()
    } else {
        let h = opts.window_hours.filter(|h| *h > 0.0).unwrap_or(DEFAULT_WINDOW_HOURS);
        window_hours = Some(h);
        let cutoff = now_ms - h * 3_600_000.0;
        all.iter().filter(|(_, m)| *m >= cutoff).collect()
    };

    let note = match opts.session_id {
        Some(sid) => format!(
            "Queried the transcript of session {sid} ({} file(s) of {} on disk).",
            files.len(),
            all.len()
        ),
        None => format!(
            "Queried the {} transcript(s) modified in the last {}h (of {} on disk) — widen with windowHours, or target one file with sessionId.",
            files.len(),
            num_str(window_hours.unwrap_or(DEFAULT_WINDOW_HOURS)),
            all.len()
        ),
    };
    let coverage = |extra: &str| {
        let mut pairs = vec![
            ("filesTotal", Value::from(all.len())),
            ("filesQueried", Value::from(files.len())),
        ];
        if let Some(h) = window_hours {
            pairs.push(("windowHours", json_num(h)));
        }
        pairs.push(("note", Value::String(format!("{note}{extra}"))));
        obj(pairs)
    };

    if opts.preset.is_none() && opts.sql.is_none() {
        let presets: Vec<Value> = TRANSCRIPT_PRESETS
            .iter()
            .map(|(n, d, _)| obj(vec![("name", s(n)), ("description", s(d))]))
            .collect();
        return obj(vec![("mode", s("list")), ("presets", Value::Array(presets)), ("coverage", coverage(""))]);
    }
    if opts.preset.is_some() && opts.sql.is_some() {
        return obj(vec![
            ("mode", s("sql")),
            ("error", s("Pass preset OR sql, not both.")),
            ("coverage", coverage("")),
        ]);
    }

    // `mode` is decided BEFORE the query runs and never changes afterwards, so an error row is
    // attributable to the surface the caller used.
    let (mode, sql) = match opts.preset {
        Some(name) => match preset(name) {
            Some((_, _, sql)) => ("preset", (*sql).to_owned()),
            None => {
                let valid: Vec<&str> = TRANSCRIPT_PRESETS.iter().map(|(n, _, _)| *n).collect();
                return obj(vec![
                    ("mode", s("preset")),
                    ("preset", s(name)),
                    ("coverage", coverage("")),
                    ("error", Value::String(format!(
                        "Unknown preset '{name}'. Valid: {}",
                        valid.join(", ")
                    ))),
                ]);
            }
        },
        None => match assert_read_only_select(opts.sql.unwrap_or_default()) {
            Ok(sql) => ("sql", sql),
            Err(e) => {
                return obj(vec![("mode", s("sql")), ("error", Value::String(e)), ("coverage", coverage(""))])
            }
        },
    };
    let with_preset = |mut pairs: Vec<(&'static str, Value)>| -> Vec<(&'static str, Value)> {
        if let Some(p) = opts.preset {
            pairs.insert(1, ("preset", s(p)));
        }
        pairs
    };

    if files.is_empty() {
        let err = match opts.session_id {
            Some(sid) => format!("No transcript file found for session {sid}."),
            None => format!(
                "No transcripts modified in the last {}h — widen windowHours or pass a sessionId.",
                num_str(window_hours.unwrap_or(DEFAULT_WINDOW_HOURS))
            ),
        };
        return obj(with_preset(vec![
            ("mode", s(mode)),
            ("coverage", coverage("")),
            ("error", Value::String(err)),
        ]));
    }

    let limit = js_floor(opts.limit.unwrap_or(DEFAULT_ROWS as f64)).clamp(1, HARD_MAX_ROWS);
    let paths: Vec<&Path> = files.iter().map(|(p, _)| p.as_path()).collect();
    match query(&paths, &sql, limit) {
        Ok((columns, rows, capped, torn_lines)) => {
            let mut extra = String::new();
            if capped {
                extra.push_str(&format!(" Rows capped at {limit} — pass a larger limit (max {HARD_MAX_ROWS})."));
            }
            if torn_lines > 0 {
                extra.push_str(&format!(" {torn_lines} line(s) unparseable and excluded."));
            }
            let count = rows.len();
            obj(with_preset(vec![
                ("mode", s(mode)),
                ("columns", Value::Array(columns.into_iter().map(Value::String).collect())),
                ("rows", Value::Array(rows)),
                ("rowCount", Value::from(count)),
                ("coverage", coverage(&extra)),
            ]))
        }
        // Binder errors on sparse schemas ("no column message") surface honestly — the queried
        // window simply has no such records; the message says which column, the coverage says which
        // files were in scope.
        Err(e) => obj(with_preset(vec![
            ("mode", s(mode)),
            ("error", Value::String(format!("query failed: {e}"))),
            ("coverage", coverage("")),
        ])),
    }
}

/// `Math.floor` on a possibly-absurd f64, saturating instead of wrapping.
fn js_floor(n: f64) -> i64 {
    if n.is_nan() {
        return 0;
    }
    n.floor().clamp(i64::MIN as f64, i64::MAX as f64) as i64
}

/// A JS number in a JSON position: integral values print bare (`24`, not `24.0`).
fn json_num(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.007_199_254_740_992e15 {
        Value::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

/// Fileless DuckDB, opened per call — same reasoning as `bodies_evidence::with_duck`: a persistent
/// .duckdb measured 300x write amplification, and no `temp_directory` so an over-limit query fails
/// LOUDLY instead of quietly writing gigabytes to the SSD.
fn query(
    files: &[&Path],
    sql: &str,
    limit: i64,
) -> Result<(Vec<String>, Vec<Value>, bool, i64), String> {
    let con = duckdb::Connection::open_in_memory().map_err(|e| e.to_string())?;
    for stmt in ["SET memory_limit = '2GB'", "SET threads = 2", "SET temp_directory = ''"] {
        con.execute_batch(stmt).map_err(|e| e.to_string())?;
    }
    // Paths come from OUR directory walk (never from the caller); the quote-escape is
    // belt-and-braces.
    let list = files
        .iter()
        .map(|p| format!("'{}'", p.to_string_lossy().replace('\'', "''")))
        .collect::<Vec<_>>()
        .join(",");
    con.execute_batch(&format!(
        "CREATE VIEW transcripts AS SELECT * FROM read_ndjson_auto([{list}], union_by_name=true, ignore_errors=true, filename=true, maximum_object_size={MAX_OBJECT_SIZE})"
    ))
    .map_err(|e| e.to_string())?;

    // limit+1 so a cap is REPORTED, not silently applied as if it were the whole result.
    let mut stmt = con.prepare(&format!("SELECT * FROM ({sql}) LIMIT {}", limit + 1)).map_err(|e| e.to_string())?;
    let mut rows_iter = stmt.query([]).map_err(|e| e.to_string())?;
    let mut rows: Vec<Value> = Vec::new();
    let mut columns: Vec<String> = Vec::new();
    while let Some(r) = rows_iter.next().map_err(|e| e.to_string())? {
        if columns.is_empty() {
            columns = r.as_ref().column_names();
        }
        let mut m = Map::new();
        for (i, name) in columns.iter().enumerate() {
            let cell = r.get::<usize, duckdb::types::Value>(i).unwrap_or(duckdb::types::Value::Null);
            m.insert(name.clone(), cell_to_json(&cell));
        }
        rows.push(Value::Object(m));
    }
    drop(rows_iter);
    // A query returning ZERO rows still has columns, and the caller is entitled to them.
    if columns.is_empty() {
        columns = stmt.column_names();
    }
    let capped = rows.len() as i64 > limit;
    if capped {
        rows.truncate(limit as usize);
    }

    // Torn-line disclosure, only after the main query succeeded. A malformed line lands as an
    // all-NULL row under ignore_errors, NOT a dropped one — so count(*) alone would pass silently;
    // the comparison is against count(type), because 'type' is written on every real record while
    // 'timestamp'/'message' are omitted by some record shapes.
    let mut probe = con
        .prepare("SELECT count(*) AS total, count(type) AS withCol FROM transcripts")
        .map_err(|e| e.to_string())?;
    let mut probe_rows = probe.query([]).map_err(|e| e.to_string())?;
    let torn = match probe_rows.next().map_err(|e| e.to_string())? {
        Some(r) => {
            let total: i64 = r.get(0).unwrap_or(0);
            let with_col: i64 = r.get(1).unwrap_or(0);
            total - with_col
        }
        None => 0,
    };
    Ok((columns, rows, capped, torn))
}

/// One cell, as `getRowObjectsJson()` renders it — and the mapping is NOT what it looks like.
///
/// MEASURED against the node binding, one probe query per type, because guessing here is silently
/// wrong across the whole preset library. The mapping is not the intuitive one:
///
/// | DuckDB | JSON | | DuckDB | JSON |
/// |---|---|---|---|---|
/// | INTEGER | number `42` | | BIGINT / HUGEINT | **string** `"42"` |
/// | FLOAT | number `1.5` | | DECIMAL | **string** `"-12.340"` (scale kept) |
/// | DOUBLE | number `0.30000000000000004` | | TIMESTAMP / DATE | string, DuckDB's own rendering |
///
/// Every `count(*)`/`sum(...)` in the preset library is BIGINT, so a port that maps 64-bit integers
/// to JSON numbers disagrees with the TS on every aggregate row while looking entirely reasonable.
/// The rule that fits: a value JS could not carry EXACTLY in a `number` (64-bit ints) or would
/// reformat (a fixed-scale decimal) is stringified; everything a double holds losslessly is native.
/// Takes the OWNED value rather than the `ValueRef`: a LIST or a STRUCT arrives as a raw Arrow
/// array plus an index, and the owned form has already materialized both into nested `Value`s — so
/// the container cases become two recursive lines instead of a pile of Arrow downcasts.
fn cell_to_json(v: &duckdb::types::Value) -> Value {
    use duckdb::types::Value as V;
    match v {
        V::Null => Value::Null,
        V::Boolean(b) => Value::Bool(*b),
        V::TinyInt(n) => Value::from(*n),
        V::SmallInt(n) => Value::from(*n),
        V::Int(n) => Value::from(*n),
        V::UTinyInt(n) => Value::from(*n),
        V::USmallInt(n) => Value::from(*n),
        V::UInt(n) => Value::from(*n),
        V::Float(n) => json_num(f64::from(*n)),
        V::Double(n) => json_num(*n),
        V::BigInt(n) => Value::String(n.to_string()),
        V::UBigInt(n) => Value::String(n.to_string()),
        V::HugeInt(n) => Value::String(n.to_string()),
        V::UHugeInt(n) => Value::String(n.to_string()),
        V::Decimal(d) => Value::String(d.to_string()),
        V::Text(t) | V::Enum(t) => Value::String(t.clone()),
        V::Blob(b) | V::Geometry(b) => Value::String(String::from_utf8_lossy(b).into_owned()),
        V::Date32(days) => {
            let (y, m, d) = civil_from_days(i64::from(*days));
            Value::String(format!("{y:04}-{m:02}-{d:02}"))
        }
        V::Timestamp(unit, n) => Value::String(fmt_timestamp(*unit, *n)),
        V::List(items) | V::Array(items) => Value::Array(items.iter().map(cell_to_json).collect()),
        V::Struct(fields) => Value::Object(
            fields.iter().map(|(k, v)| (k.clone(), cell_to_json(v))).collect(),
        ),
        V::Union(inner) => cell_to_json(inner),
        // Time64, Interval and Map have no representation in a transcript record (they cannot come
        // out of `read_ndjson_auto`), so they are reachable only from a hand-written query. Debug is
        // an honest "this engine had no JSON form for it" rather than a fabricated one.
        other => Value::String(format!("{other:?}")),
    }
}

/// DuckDB's own timestamp rendering: `YYYY-MM-DD HH:MM:SS`, with a fractional part ONLY when there
/// is one (and trailing zeros trimmed). Not ISO — no `T`, no `Z` — which matters because the value
/// arrives in the transcripts AS an ISO string and comes back out in this other shape.
fn fmt_timestamp(unit: duckdb::types::TimeUnit, n: i64) -> String {
    use duckdb::types::TimeUnit as U;
    let (secs, frac_digits, frac) = match unit {
        U::Second => (n, 0, 0),
        U::Millisecond => (n.div_euclid(1_000), 3, n.rem_euclid(1_000)),
        U::Microsecond => (n.div_euclid(1_000_000), 6, n.rem_euclid(1_000_000)),
        U::Nanosecond => (n.div_euclid(1_000_000_000), 9, n.rem_euclid(1_000_000_000)),
    };
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, mo, d) = civil_from_days(days);
    let base = format!(
        "{y:04}-{mo:02}-{d:02} {:02}:{:02}:{:02}",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    );
    if frac == 0 {
        return base;
    }
    let f = format!("{frac:0width$}", width = frac_digits);
    format!("{base}.{}", f.trim_end_matches('0'))
}

/// Howard Hinnant's `civil_from_days` — days since the Unix epoch to (y, m, d), proleptic Gregorian.
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// A single DuckDB connection held open across several queries.
///
/// `burnSeismic` runs three statements against ONE connection (the aggregation, the torn-line probe
/// and the spawn listing) and its results are only consistent if they see the same session — so the
/// seam it needs is a session, not a one-shot query helper. Opening per query would also re-pay the
/// `read_json` scan setup each time.
pub struct DuckSession {
    con: duckdb::Connection,
}

impl DuckSession {
    /// Fileless, with the same settings as `bodies_evidence::with_duck`: a persistent .duckdb
    /// measured 300x write amplification, and no `temp_directory` so an over-limit query fails
    /// LOUDLY instead of quietly writing gigabytes to the SSD.
    pub fn open_in_memory() -> Result<Self, String> {
        let con = duckdb::Connection::open_in_memory().map_err(|e| e.to_string())?;
        for stmt in ["SET memory_limit = '2GB'", "SET threads = 2", "SET temp_directory = ''"] {
            con.execute_batch(stmt).map_err(|e| e.to_string())?;
        }
        Ok(Self { con })
    }

    /// Run one statement and materialize its rows as JSON objects.
    ///
    /// This is `getRowObjects()` semantics, NOT `getRowObjectsJson()`: a BIGINT becomes a JSON
    /// NUMBER here, where the json variant would make it a string. The distinction is not cosmetic —
    /// `run_transcript_sql` faithfully reproduces the string form because its rows go to the caller
    /// verbatim, while this session's rows are consumed as numbers (`numOf` = `Number(v)` in the
    /// TS). Using one converter for both would break whichever tool it was not written for.
    pub fn query(&self, sql: &str) -> Result<Vec<Value>, String> {
        let mut stmt = self.con.prepare(sql).map_err(|e| e.to_string())?;
        let mut rows = stmt.query([]).map_err(|e| e.to_string())?;
        let mut out = Vec::new();
        let mut columns: Vec<String> = Vec::new();
        while let Some(r) = rows.next().map_err(|e| e.to_string())? {
            if columns.is_empty() {
                columns = r.as_ref().column_names();
            }
            let mut m = Map::new();
            for (i, name) in columns.iter().enumerate() {
                let cell = r.get::<usize, duckdb::types::Value>(i).unwrap_or(duckdb::types::Value::Null);
                m.insert(name.clone(), cell_to_json_native(&cell));
            }
            out.push(Value::Object(m));
        }
        Ok(out)
    }

    /// Statements whose rows are not read (`INSTALL`, `LOAD`, `SET`).
    pub fn execute(&self, sql: &str) -> Result<(), String> {
        self.con.execute_batch(sql).map_err(|e| e.to_string())
    }
}

/// The numeric half of `getRowObjects()`: every integer and float width becomes a JSON number.
/// A value beyond f64's exact range would lose precision here, which is exactly what the TS's
/// `Number(bigint)` does — matching it is the point.
fn cell_to_json_native(v: &duckdb::types::Value) -> Value {
    use duckdb::types::Value as V;
    match v {
        V::BigInt(n) => json_num(*n as f64),
        V::UBigInt(n) => json_num(*n as f64),
        V::HugeInt(n) => json_num(*n as f64),
        V::UHugeInt(n) => json_num(*n as f64),
        V::Decimal(d) => d.to_string().parse::<f64>().map_or(Value::Null, json_num),
        other => cell_to_json(other),
    }
}

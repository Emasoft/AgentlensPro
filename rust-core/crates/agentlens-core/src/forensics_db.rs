//! forensicsIndex SLICE B1 — the FAL fact-store layer (port of `src/forensicsDb.ts`).
//!
//! A DEDICATED SQLite database at `<data>/forensics.db`, deliberately NOT tables inside
//! agentlens.db: the main DB's writer does a full `DELETE FROM sessions` on every rescan and would
//! clobber a derived fact table, the grain differs by two orders of magnitude (one row per SESSION
//! vs one row per API CALL), and keeping it a separate file is half of why `run_diagnostics_sql`
//! can hand raw caller SQL to a connection that cannot reach source session data.
//!
//! POINTER-ONLY, same guarantee the TS upholds: token counts, tier splits, ids, fingerprints and
//! file-path pointers only — never base64 image bytes, raw block text, the `metadata.user_id` blob,
//! or OAuth tokens.
//!
//! WHY THIS LIVES IN `agentlens-core` AND NOT IN `agentlens-store`, which owns storage: the custom
//! SQL functions below (`billable_weight`, `cost_usd`) are thin wrappers over the pricing table, and
//! pricing lives in core. `agentlens-core` depends on `agentlens-store`; the reverse edge does not
//! exist and adding it would cycle. So unlike `transcript_sql::DuckSession` — which stays in the
//! crate that owns the DuckDB binding because it needs nothing from core — the rusqlite handle has
//! to sit next to the rates it registers. `agentlens-logscan` already owns a direct rusqlite dep, so
//! this is not a new pattern for the workspace.

use std::path::{Path, PathBuf};

use rusqlite::functions::FunctionFlags;
use rusqlite::types::ValueRef;
use rusqlite::{Connection, OpenFlags};

use crate::pricing::{calc_token_cost_usd, lookup_rates};

/// `defaultForensicsDb()` / `defaultMainDb()`. Functions, not consts, for the same reason the TS
/// gives: a module-level const freezes the path at load time and then ignores a `$DATA_DIR` set
/// afterwards — which is exactly how the test suite isolates itself and how a relocated store is
/// meant to work. Here the data dir is threaded in explicitly (the convention `default_bodies_dir`
/// already set in this crate), which makes the same guarantee structural rather than remembered.
pub fn default_forensics_db(data_dir: &Path) -> PathBuf {
    data_dir.join("forensics.db")
}

pub fn default_main_db(data_dir: &Path) -> PathBuf {
    data_dir.join("agentlens.db")
}

/// The schema, kept BYTE-IDENTICAL to `FORENSICS_SCHEMA_SQL` in `src/forensicsDb.ts`. It is the
/// shared artifact between the two implementations, so it is copied rather than re-expressed —
/// a re-worded schema that happens to produce the same tables would still make every future
/// divergence invisible to a diff.
pub const FORENSICS_SCHEMA_SQL: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS api_calls (
  call_id               TEXT PRIMARY KEY,
  response_ref          TEXT NOT NULL,
  request_ref           TEXT,
  ts                    INTEGER NOT NULL,

  session_id            TEXT,
  account_uuid          TEXT,
  model                 TEXT,
  effort                TEXT,

  spawn_kind            TEXT,
  subagent_type         TEXT,
  spawn_model_override  TEXT,
  spawn_isolation       TEXT,
  is_sidechain          INTEGER NOT NULL DEFAULT 0,
  parent_session        TEXT,
  spawn_resolution      TEXT NOT NULL,

  input_tokens          INTEGER NOT NULL DEFAULT 0,
  output_tokens         INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens     INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  tier_5m_tokens        INTEGER NOT NULL DEFAULT 0,
  tier_1h_tokens        INTEGER NOT NULL DEFAULT 0,

  break_cause           TEXT,
  culprit_fingerprint   TEXT,
  gap_minutes           REAL,

  frontmatter_fp        TEXT,

  cost_usd              REAL NOT NULL DEFAULT 0,
  billable_weight       REAL NOT NULL DEFAULT 0,
  indexed_at            INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ac_ts          ON api_calls (ts DESC);
CREATE INDEX IF NOT EXISTS idx_ac_session     ON api_calls (session_id);
CREATE INDEX IF NOT EXISTS idx_ac_account     ON api_calls (account_uuid);
CREATE INDEX IF NOT EXISTS idx_ac_model       ON api_calls (model);
CREATE INDEX IF NOT EXISTS idx_ac_spawn_kind  ON api_calls (spawn_kind);
CREATE INDEX IF NOT EXISTS idx_ac_break_cause ON api_calls (break_cause);
CREATE INDEX IF NOT EXISTS idx_ac_frontmatter ON api_calls (frontmatter_fp);
CREATE INDEX IF NOT EXISTS idx_ac_culprit     ON api_calls (culprit_fingerprint);

CREATE TABLE IF NOT EXISTS call_content (
  call_id  TEXT NOT NULL REFERENCES api_calls(call_id) ON DELETE CASCADE,
  tag      TEXT NOT NULL,
  tokens   INTEGER NOT NULL DEFAULT 0,
  count    INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (call_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_cc_tag ON call_content (tag);

CREATE TABLE IF NOT EXISTS call_injections (
  call_id  TEXT NOT NULL REFERENCES api_calls(call_id) ON DELETE CASCADE,
  kind     TEXT NOT NULL,
  name     TEXT NOT NULL,
  tokens   INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (call_id, kind, name)
);
CREATE INDEX IF NOT EXISTS idx_ci_kind_name ON call_injections (kind, name);

CREATE TABLE IF NOT EXISTS index_state (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
"#;

// ── the JS coercions, reproduced exactly ────────────────────────────────────────
//
// sql.js hands a SQL value to a custom fn as a plain JS value, and every fn then runs it through
// `num()` = `typeof v === 'number' && isFinite(v) ? v : 0`. So a TEXT argument is NOT parsed — it
// is not a number, so it becomes 0. Porting these as `ctx.get::<f64>()` would instead make rusqlite
// COERCE '12' to 12.0 and disagree with the oracle on exactly the inputs a caller is most likely to
// get wrong in hand-written SQL.
fn arg_num(v: ValueRef<'_>) -> f64 {
    match v {
        ValueRef::Integer(i) => i as f64,
        ValueRef::Real(f) => {
            if f.is_finite() {
                f
            } else {
                0.0
            }
        }
        _ => 0.0,
    }
}

/// `typeof model === 'string' ? model : null` — an INTEGER model id is not a string in JS either,
/// so it is None here rather than being stringified.
fn arg_text(v: ValueRef<'_>) -> Option<String> {
    match v {
        ValueRef::Text(b) => std::str::from_utf8(b).ok().map(str::to_owned),
        _ => None,
    }
}

/// `Number(gap)` — the ONE place a string IS converted, because `tier_classify` calls `Number(gap)`
/// explicitly rather than going through `num()`. JS's `Number('')` is 0 (not NaN), `Number(' 12 ')`
/// is 12, and anything else unparseable is NaN, which `tierClassify` then maps to 'COLD' via its
/// `!isFinite` guard. Reproduced literally: a port that treated '' as NaN would classify an empty
/// string as COLD where the oracle says BREAK.
fn arg_js_number(v: ValueRef<'_>) -> Option<f64> {
    match v {
        ValueRef::Null => None,
        ValueRef::Integer(i) => Some(i as f64),
        ValueRef::Real(f) => Some(f),
        ValueRef::Text(b) => {
            let s = std::str::from_utf8(b).unwrap_or("").trim().to_owned();
            if s.is_empty() {
                Some(0.0)
            } else {
                Some(s.parse::<f64>().unwrap_or(f64::NAN))
            }
        }
        ValueRef::Blob(_) => Some(f64::NAN),
    }
}

// ── cost / weighting helpers (pure — shared by the index-time column AND the SQL fns) ───────────

/// `billableWeight` — the tier-aware "what did this call really cost me" number. The expensive
/// buckets dominate spend but hide in raw token counts: a cache write bills 1.25x (5m) / 2x (1h) the
/// input rate and output ≈5x, so collapsing every bucket onto one comparable number is what lets a
/// "worst config" ranking reflect dollars instead of token volume. 0 when the model's rates are
/// unknown — fail-soft, never a throw on an unseen model id.
///
/// `now_ms` is threaded in rather than read from the clock, matching every other `lookup_rates`
/// call site in this crate. That is not a style choice: the rates table is dated, so a function that
/// consulted the wall clock could not be pinned by a fixture.
pub fn billable_weight(
    cc5m: f64,
    cc1h: f64,
    cache_read: f64,
    output: f64,
    input: f64,
    model: Option<&str>,
    now_ms: f64,
) -> f64 {
    let Some(rates) = model.and_then(|m| lookup_rates(m, None, now_ms)) else {
        return 0.0;
    };
    let input_rate = rates.input_per_mtok / 1_000_000.0;
    let output_rate = rates.output_per_mtok / 1_000_000.0;
    fin(input) * input_rate
        + fin(cc5m) * 1.25 * input_rate
        + fin(cc1h) * 2.0 * input_rate
        + fin(cache_read) * 0.1 * input_rate
        + fin(output) * output_rate
}

/// The `num()` guard applied to an already-numeric argument: NaN/Infinity collapse to 0 exactly as
/// `isFinite` does in the TS.
fn fin(v: f64) -> f64 {
    if v.is_finite() {
        v
    } else {
        0.0
    }
}

/// `tierClassify` — the CCFORNSC gap taxonomy as a classifier. A null, non-finite or negative gap
/// (first call in a session, or an unattributed one) is 'COLD'.
pub fn tier_classify(gap_minutes: Option<f64>) -> &'static str {
    match gap_minutes {
        None => "COLD",
        Some(g) if !g.is_finite() || g < 0.0 => "COLD",
        Some(g) if g < 4.5 => "BREAK",
        Some(g) if g <= 6.0 => "TTL_5m",
        Some(g) if g <= 65.0 => "MID",
        Some(_) => "TTL_1h",
    }
}

/// Register `billable_weight` / `tier_classify` / `cost_usd` / `spike` on a connection. Registered
/// on BOTH the writable index DB and the read-only snapshot, so ad-hoc SQL from
/// `run_diagnostics_sql` can call them.
///
/// Every fn is null-tolerant because SQL NULL reaches a sql.js custom fn as JS null and the TS
/// handles it (a null model → 0 cost, a null gap → 'COLD').
pub fn register_custom_fns(conn: &Connection, now_ms: f64) -> rusqlite::Result<()> {
    // DETERMINISTIC is deliberately NOT set. These read the dated pricing table via `now_ms`, and
    // marking a function deterministic licenses SQLite to hoist it out of a loop or reuse a cached
    // result — correct for `spike`, but a lie for anything rate-dependent.
    let flags = FunctionFlags::SQLITE_UTF8;

    conn.create_scalar_function("billable_weight", 6, flags, move |ctx| {
        let cc5m = arg_num(ctx.get_raw(0));
        let cc1h = arg_num(ctx.get_raw(1));
        let cread = arg_num(ctx.get_raw(2));
        let out = arg_num(ctx.get_raw(3));
        let input = arg_num(ctx.get_raw(4));
        let model = arg_text(ctx.get_raw(5));
        Ok(billable_weight(
            cc5m,
            cc1h,
            cread,
            out,
            input,
            model.as_deref(),
            now_ms,
        ))
    })?;

    conn.create_scalar_function("tier_classify", 1, flags, |ctx| {
        Ok(tier_classify(arg_js_number(ctx.get_raw(0))).to_string())
    })?;

    conn.create_scalar_function("cost_usd", 5, flags, move |ctx| {
        let input = arg_num(ctx.get_raw(0));
        let cread = arg_num(ctx.get_raw(1));
        let cwrite = arg_num(ctx.get_raw(2));
        let out = arg_num(ctx.get_raw(3));
        // The TS is `typeof model === 'string' ? calcTokenCostUsd(...) : 0` — a non-string model
        // short-circuits to 0 WITHOUT consulting the rates table at all.
        Ok(match arg_text(ctx.get_raw(4)) {
            // The 1h portion is 0: the TS calls the 5-arg form, whose trailing 1h argument defaults
            // to 0 (all-5m behaviour). Passing anything else here would silently reprice every
            // cache write at the 2x tier.
            Some(model) => calc_token_cost_usd(input, cread, cwrite, out, &model, 0.0, None, now_ms),
            None => 0.0,
        })
    })?;

    conn.create_scalar_function("spike", 3, flags | FunctionFlags::SQLITE_DETERMINISTIC, |ctx| {
        let value = arg_num(ctx.get_raw(0));
        let median = arg_num(ctx.get_raw(1));
        let mult = arg_num(ctx.get_raw(2));
        Ok(i64::from(value >= median * mult))
    })?;

    Ok(())
}

/// Open (or create) forensics.db, apply the schema, register the custom fns.
///
/// The TS returns null when sql.js is unavailable and every caller degrades to "engine
/// unavailable". There is no equivalent failure here — rusqlite is statically linked with a bundled
/// SQLite, so the engine cannot be missing — and inventing an Option to mirror a condition that
/// cannot occur would push a dead `None` branch into every caller. A genuine I/O failure is
/// returned as an Err instead.
pub fn open_forensics_db(db_path: &Path, now_ms: f64) -> rusqlite::Result<Connection> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            rusqlite::Error::InvalidPath(PathBuf::from(format!("{}: {e}", parent.display())))
        })?;
    }
    let conn = Connection::open(db_path)?;
    conn.execute_batch(FORENSICS_SCHEMA_SQL)?;
    register_custom_fns(&conn, now_ms)?;
    Ok(conn)
}

/// The read-only handle `run_diagnostics_sql` answers from.
///
/// THIS IS THE ONE PLACE THE PORT DELIBERATELY DOES NOT COPY THE TS, and the reason is a bug that
/// exists only on this side. `openReadonlyForensicsSnapshot` reads the DB's FILE BYTES and hands
/// them to a fresh in-memory database. That is exact under sql.js, where the whole database IS
/// those bytes — `save()` serializes it in full and `PRAGMA journal_mode = WAL` is inert against an
/// in-memory DB. Under real SQLite the pragma takes effect, so committed rows can still be sitting
/// in the `-wal` sidecar: a byte-copy of `forensics.db` alone would silently answer from a
/// database missing its most recent commits, with no error to notice.
///
/// A read-only connection reads the WAL correctly and enforces the same guarantee the TS bought
/// with the copy — that a raw caller query cannot write — at the engine level rather than by
/// isolation. The property genuinely given up is snapshot isolation from a concurrent writer, which
/// for a diagnostics query means seeing fresher data, not wrong data.
pub fn open_readonly_snapshot(db_path: &Path, now_ms: f64) -> Option<Connection> {
    // The TS returns null when the file is absent; preserved, because "no facts indexed yet" is a
    // normal state that the caller reports rather than an error it raises.
    if !db_path.exists() {
        return None;
    }
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    register_custom_fns(&conn, now_ms).ok()?;
    Some(conn)
}

// ── index_state KV helpers ──────────────────────────────────────────────────────

/// `readIndexState`. The TS stringifies a non-string value (`String(v)`) rather than dropping it,
/// so a row written as an INTEGER still reads back; `query_row` with a `String` target would
/// instead fail the type conversion and lose it.
pub fn read_index_state(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT v FROM index_state WHERE k = ?1",
        [key],
        |row| match row.get_ref(0)? {
            ValueRef::Text(b) => Ok(String::from_utf8_lossy(b).into_owned()),
            ValueRef::Integer(i) => Ok(i.to_string()),
            ValueRef::Real(f) => Ok(f.to_string()),
            _ => Ok(String::new()),
        },
    )
    .ok()
}

pub fn write_index_state(conn: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT OR REPLACE INTO index_state (k, v) VALUES (?1, ?2)",
        [key, value],
    )?;
    Ok(())
}

//! `run_diagnostics_sql` parity (TRDD-DMWOBWFH) — the Rust port must Value-equal what the COMPILED
//! `src/forensicsSql.ts` produced, key SET and ORDER included, over the same committed fact DB.
//!
//! Regenerate the oracle after ANY change to the TS engine or the fixture:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-forensicssql-expected.mjs
//!
//! The case names here are the generator's keys verbatim: the matrix lives in ONE place, and this
//! file asserts that every case in it was reproduced — a case added there and forgotten here fails
//! the count assertion rather than silently going untested.

use std::path::PathBuf;

use agentlens_core::forensics_sql::{run_diagnostics_sql, RunDiagnosticsSqlOptions};
use serde_json::{Map, Value};

/// The fixture's own pinned clock. Nothing in the oracle depends on its exact value — every fact row
/// is time-independent and the one `window` case spans a million hours — but the custom SQL fns take
/// it, so it must be a real number rather than the wall clock.
const NOW_MS: f64 = 1_760_000_000_000.0;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/forensicssql")
}

fn oracle() -> Value {
    let p = fixtures().with_file_name("forensicssql-expected.json");
    let raw = std::fs::read_to_string(&p).expect("fixture missing — run gen-forensicssql-expected.mjs");
    serde_json::from_str(&raw.replace("<FIX>", &fixtures().to_string_lossy())).unwrap()
}

/// Key SET **and ORDER** — a JS object literal's order is the wire order, and an optional key the TS
/// leaves `undefined` must be ABSENT, never null.
fn same(got: &Value, want: &Value, path: &str) {
    match (got, want) {
        (Value::Object(g), Value::Object(w)) => {
            let gk: Vec<&String> = g.keys().collect();
            let wk: Vec<&String> = w.keys().collect();
            assert_eq!(gk, wk, "key set/order differs at {path}");
            for k in wk {
                same(&g[k], &w[k], &format!("{path}.{k}"));
            }
        }
        (Value::Array(g), Value::Array(w)) => {
            assert_eq!(g.len(), w.len(), "array length differs at {path}");
            for (i, (a, b)) in g.iter().zip(w.iter()).enumerate() {
                same(a, b, &format!("{path}[{i}]"));
            }
        }
        // An integer 0 and a float 0.0 are different Values; SQLite's column affinity decides which
        // one each side produced, so compare numerically and keep everything else exact.
        (Value::Number(a), Value::Number(b)) => {
            assert_eq!(a.as_f64(), b.as_f64(), "value differs at {path}")
        }
        _ => assert_eq!(got, want, "value differs at {path}"),
    }
}

struct Case {
    name: &'static str,
    preset: Option<&'static str>,
    sql: Option<&'static str>,
    params: Option<&'static str>,
    format: Option<&'static str>,
    limit: Option<f64>,
    /// The db-unavailable cases point at a path that does not exist.
    missing_db: bool,
}

const fn c(name: &'static str) -> Case {
    Case { name, preset: None, sql: None, params: None, format: None, limit: None, missing_db: false }
}
const fn p(name: &'static str, preset: &'static str) -> Case {
    Case { preset: Some(preset), ..c(name) }
}
const fn q(name: &'static str, sql: &'static str) -> Case {
    Case { sql: Some(sql), ..c(name) }
}

const ASTRAL: &str = "SELECT '🔥' AS e, 'ascii' AS b, 1.5 AS n, 7 AS i, NULL AS z";
const EMPTY_Q: &str = "SELECT call_id FROM api_calls WHERE 0";
const ALL_IDS: &str = "SELECT call_id FROM api_calls ORDER BY call_id";
const CUSTOM_FNS: &str = "SELECT call_id, tier_classify(gap_minutes) AS tier,
      spike(cache_creation_tokens, 1000, 2) AS sp,
      billable_weight(tier_5m_tokens, tier_1h_tokens, cache_read_tokens, output_tokens, input_tokens, model) AS bw,
      cost_usd(input_tokens, cache_read_tokens, cache_creation_tokens, output_tokens, model) AS cost
      FROM api_calls ORDER BY call_id";

fn cases() -> Vec<Case> {
    let mut v = vec![c("list_presets")];
    for pr in agentlens_core::forensics_sql::PRESETS {
        // Leaked into a &'static str so the table can stay one shape; the names are compile-time
        // constants either way.
        let name: &'static str = Box::leak(format!("preset_{}", pr.name).into_boxed_str());
        v.push(p(name, pr.name));
    }
    v.extend([
        Case { params: Some(r#"{"minCount":2}"#), ..p("params_min_count_2", "cache_by_skill") },
        Case { params: Some(r#"{"minCount":2}"#), ..p("params_chronic_min_count_2", "chronic_offenders") },
        Case { params: Some(r#"{"k":2}"#), ..p("params_mult_k2", "unclassified_events") },
        Case { params: Some(r#"{"mult":2}"#), ..p("params_mult_raw", "unclassified_events") },
        Case { params: Some(r#"{"minCount":"two"}"#), ..p("params_min_count_bogus", "cache_by_skill") },
        Case { params: Some(r#"{"minCount":2}"#), ..p("params_cache_by_mcp_min2", "cache_by_mcp") },
        Case { params: Some(r#"{"minCount":2}"#), ..p("params_cache_by_rule_min2", "cache_by_rule") },
        Case { params: Some(r#"{"since":1759999760000}"#), ..p("params_explicit_since", "session_hotlist") },
        Case { params: Some(r#"{"window":1000000}"#), ..p("params_window_wide", "session_hotlist") },
        Case { params: Some(r#"{"window":0,"since":1759999760000}"#), ..p("params_window_zero", "session_hotlist") },
        Case { format: Some("table"), ..p("format_table", "fork_vs_fresh") },
        Case { format: Some("markdown"), ..p("format_markdown", "fork_vs_fresh") },
        Case { format: Some("table"), ..q("format_table_empty", EMPTY_Q) },
        Case { format: Some("markdown"), ..q("format_markdown_empty", EMPTY_Q) },
        Case { format: Some("table"), ..q("format_table_astral", ASTRAL) },
        Case { format: Some("markdown"), ..q("format_markdown_astral", ASTRAL) },
        q("raw_select", "SELECT call_id, model, cache_creation_tokens FROM api_calls ORDER BY call_id"),
        q("raw_with_cte", "WITH t AS (SELECT call_id AS c FROM api_calls) SELECT c FROM t ORDER BY c"),
        q("raw_trailing_semicolon", "SELECT 1 AS one;"),
        q("raw_block_comment_stripped", "SELECT 1 AS one /* DROP TABLE api_calls */"),
        q("raw_custom_fns", CUSTOM_FNS),
        Case { params: Some(r#"{"since":42}"#), ..q("raw_param_in_string_literal", "SELECT ':notaparam' AS s, :since AS since") },
        q("raw_unknown_param_binds_null", "SELECT :nosuch AS v"),
        q("raw_cell_truncation", "SELECT call_id, frontmatter_fp FROM api_calls WHERE call_id = 'c9'"),
        q("raw_query_failure", "SELECT no_such_column FROM api_calls"),
        q("cap_default_no_note", ALL_IDS),
        Case { limit: Some(3.0), ..q("cap_three", ALL_IDS) },
        Case { limit: Some(0.0), ..q("cap_zero_clamps_to_one", ALL_IDS) },
        Case { limit: Some(99999.0), ..q("cap_above_hard_max", ALL_IDS) },
        q("gate_blank", "   "),
        q("gate_comment_only", "-- nothing here"),
        q("gate_two_statements", "SELECT 1; SELECT 2"),
        q("gate_not_a_select", "EXPLAIN SELECT 1"),
        q("gate_delete", "DELETE FROM api_calls"),
        q("gate_replace_function", "SELECT replace(model,'a','b') FROM api_calls"),
        q(
            "gate_pragma_prefixed_identifier_passes",
            "SELECT 1 FROM api_calls WHERE 1 = (SELECT 1) AND 1 -- x\nUNION SELECT 1 FROM pragma_table_info",
        ),
        p("mode_unknown_preset", "no_such_preset"),
        Case { sql: Some("SELECT 1"), ..p("mode_both_preset_and_sql", "schema") },
        Case { sql: Some(""), ..p("mode_empty_strings_list", "") },
        Case { missing_db: true, ..p("db_missing_preset", "schema") },
        Case { missing_db: true, ..q("db_missing_raw", "SELECT 1") },
    ]);
    v
}

fn run(case: &Case) -> Value {
    let db = if case.missing_db {
        fixtures().join("no-such-forensics.db")
    } else {
        fixtures().join("forensics.db")
    };
    let params: Option<Map<String, Value>> =
        case.params.map(|s| serde_json::from_str(s).expect("case params are valid JSON"));
    run_diagnostics_sql(
        &db,
        &RunDiagnosticsSqlOptions {
            preset: case.preset,
            sql: case.sql,
            params: params.as_ref(),
            format: case.format,
            limit: case.limit,
        },
        NOW_MS,
    )
}

#[test]
fn every_case_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let want = o["cases"].as_object().expect("cases object");
    let cases = cases();
    for case in &cases {
        let expected = want
            .get(case.name)
            .unwrap_or_else(|| panic!("no oracle case named {} — regenerate the fixture", case.name));
        same(&run(case), expected, case.name);
    }
    // A case added to the generator and forgotten here would otherwise never run.
    assert_eq!(cases.len(), want.len(), "the Rust matrix and the oracle matrix disagree in size");
}

/// The 500-char cell cap is measured and SLICED in UTF-16 units and the suffix reports the units
/// dropped — the fixture's 700-char value is the only place that fires, and it must fire.
#[test]
fn a_wide_cell_is_truncated_with_the_dropped_count() {
    let o = oracle();
    let long = o["longFpLength"].as_u64().unwrap() as usize;
    assert_eq!(long, 700);
    let got = run(&q("raw_cell_truncation", "SELECT call_id, frontmatter_fp FROM api_calls WHERE call_id = 'c9'"));
    let cell = got["rows"][0]["frontmatter_fp"].as_str().unwrap();
    assert!(cell.ends_with("…(+200 chars, cell truncated)"), "cell was not truncated: {cell}");
    assert_eq!(cell.chars().take_while(|c| *c != '…').count(), 500);
}

/// The gate is the whole read-only guarantee — a port that let ANY of these through would hand a
/// mutating statement to a connection that only happens to be read-only.
#[test]
fn the_statement_gate_fails_closed() {
    for bad in [
        "",
        "   ",
        "-- only a comment",
        "SELECT 1; SELECT 2",
        "SELECT 1; DROP TABLE api_calls",
        "DELETE FROM api_calls",
        "INSERT INTO api_calls (call_id) VALUES ('x')",
        "UPDATE api_calls SET ts = 0",
        "DROP TABLE api_calls",
        "ATTACH DATABASE 'x' AS y",
        "PRAGMA table_info(api_calls)",
        "VACUUM",
        "EXPLAIN SELECT 1",
        // JS `\b` is ASCII-only: `é` is not a word character, so there IS a boundary before DROP
        // and the TS REJECTS this (verified against the compiled gate). Rust's `regex` crate makes
        // `\b` UNICODE by default, where `é` IS a word character — no boundary, no match, and the
        // gate would fail OPEN on a statement the TS refuses. That is the wrong direction for the
        // one check standing between a caller's SQL and the database.
        "SELECT 1 FROM t WHERE éDROP TABLE api_calls",
        "SELECT 1 FROM t WHERE 日本語DELETE FROM api_calls",
    ] {
        assert!(
            agentlens_core::forensics_sql::assert_read_only_select(bad).is_err(),
            "the gate ACCEPTED {bad:?}"
        );
    }
    for good in [
        "SELECT 1",
        "select 1",
        "  WITH t AS (SELECT 1 AS x) SELECT * FROM t  ",
        "SELECT 1;",
        "SELECT 1 ;  ",
        "SELECT 1 /* comment */",
        "SELECT 1 -- comment",
        // Accepted, and deliberately so: the comment is stripped BEFORE the semicolon rule runs, so
        // what remains is one statement with a trailing `;`. Verified against the TS gate directly
        // — an earlier version of this test asserted the opposite and was the thing that was wrong.
        "SELECT 1 UNION SELECT 1; --",
    ] {
        assert!(
            agentlens_core::forensics_sql::assert_read_only_select(good).is_ok(),
            "the gate REJECTED {good:?}"
        );
    }
}

/// The read-only handle really is read-only: even a statement that slipped past the gate cannot
/// write. The gate and the connection flag are two independent guarantees and both must hold.
#[test]
fn the_snapshot_connection_refuses_a_write() {
    let conn = agentlens_core::forensics_db::open_readonly_snapshot(&fixtures().join("forensics.db"), NOW_MS)
        .expect("fixture db");
    assert!(conn.execute("DELETE FROM api_calls", []).is_err(), "the snapshot accepted a DELETE");
}

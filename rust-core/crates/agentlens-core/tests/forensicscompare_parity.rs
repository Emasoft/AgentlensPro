//! `build_compare_configs` parity (TRDD-DMWOBWFH) — the Rust port must Value-equal what the
//! COMPILED `src/forensicsCompare.ts` produced, key SET and ORDER included, over the same
//! committed fact DB the SQL-parity test also uses (`forensicssql/forensics.db` — the two
//! tools deliberately share one fixture).
//!
//! Regenerate the oracle after ANY change to the TS engine or the fixture:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-forensicscompare-expected.mjs
//!
//! The case names here are the GENERATOR's keys verbatim — `gen-forensicscompare-expected.mjs` is
//! the durable source of truth for the matrix, and this file asserts that every case in it was
//! reproduced. A case added there and forgotten here fails the count assertion rather than
//! silently going untested.

use std::path::PathBuf;

use agentlens_core::forensics_compare::{build_compare_configs, CompareConfigsOptions};
use serde_json::Value;

/// The fixture's own pinned clock. `filter_window_wide` spans ~114 years so the cutoff cannot
/// change which rows qualify on either side of the port no matter when this runs.
const NOW_MS: f64 = 1_760_000_000_000.0;

fn fixtures() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/forensicssql")
}

fn oracle() -> Value {
    let p = fixtures().with_file_name("forensicscompare-expected.json");
    let raw =
        std::fs::read_to_string(&p).expect("fixture missing — run gen-forensicscompare-expected.mjs");
    serde_json::from_str(&raw).unwrap()
}

/// Key SET **and ORDER** — a JS object literal's order is the wire order, and an optional key the
/// TS leaves `undefined` must be ABSENT, never null.
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
        // An integer 0 and a float 0.0 are different Values; the aggregation math decides which
        // one each side produced, so compare numerically and keep everything else exact.
        (Value::Number(a), Value::Number(b)) => {
            assert_eq!(a.as_f64(), b.as_f64(), "value differs at {path}")
        }
        _ => assert_eq!(got, want, "value differs at {path}"),
    }
}

struct Case {
    name: &'static str,
    group_by: Option<&'static str>,
    metric: Option<&'static str>,
    agg: Option<&'static str>,
    filter: Option<&'static str>,
    rank_order: Option<&'static str>,
    top_n: Option<f64>,
    /// The db-missing case points at a path that does not exist.
    missing_db: bool,
}

const fn c(name: &'static str) -> Case {
    Case {
        name,
        group_by: None,
        metric: None,
        agg: None,
        filter: None,
        rank_order: None,
        top_n: None,
        missing_db: false,
    }
}
const fn g(name: &'static str, group_by: &'static str) -> Case {
    Case { group_by: Some(group_by), ..c(name) }
}
const fn m(name: &'static str, metric: &'static str) -> Case {
    Case { metric: Some(metric), ..c(name) }
}
const fn a(name: &'static str, agg: &'static str) -> Case {
    Case { agg: Some(agg), ..c(name) }
}
const fn f(name: &'static str, filter: &'static str) -> Case {
    Case { filter: Some(filter), ..c(name) }
}

fn cases() -> Vec<Case> {
    vec![
        c("defaults"),
        g("group_model", "model"),
        g("group_effort", "effort"),
        g("group_isolation", "isolation"),
        g("group_subagent_type", "subagent_type"),
        g("group_frontmatter", "frontmatter"),
        g("group_break_cause", "break_cause"),
        g("group_account", "account"),
        g("group_session", "session"),
        g("group_skill", "skill"),
        g("group_mcp", "mcp"),
        g("group_rule", "rule"),
        g("group_content_tag", "content_tag"),
        m("metric_cache_read", "cache_read"),
        m("metric_output_tokens", "output_tokens"),
        m("metric_input_tokens", "input_tokens"),
        m("metric_total", "total"),
        m("metric_billable_weighted", "billable_weighted"),
        m("metric_breaks", "breaks"),
        a("agg_sum", "sum"),
        a("agg_median", "median"),
        a("agg_min", "min"),
        a("agg_max", "max"),
        a("agg_p95", "p95"),
        a("agg_count", "count"),
        Case { rank_order: Some("best-first"), ..c("rank_best_first") },
        Case { top_n: Some(2.0), ..c("top_n_two") },
        Case { top_n: Some(0.0), ..c("top_n_zero_clamps_to_one") },
        Case { top_n: Some(9999.0), ..c("top_n_above_max") },
        f("filter_model", r#"{"model":"claude-opus-5"}"#),
        f("filter_spawn_kind", r#"{"spawnKind":"fork"}"#),
        f("filter_subagent_type", r#"{"subagentType":"spark"}"#),
        f("filter_effort", r#"{"effort":"high"}"#),
        f("filter_isolation", r#"{"isolation":"worktree"}"#),
        f("filter_account", r#"{"accountUuid":"acct-1"}"#),
        f("filter_session", r#"{"sessionId":"sess-a"}"#),
        f("filter_break_cause", r#"{"breakCause":"MODEL_SWITCHED"}"#),
        f("filter_spawn_resolution", r#"{"spawnResolution":"unresolved"}"#),
        f("filter_min_cache_create", r#"{"minCacheCreate":1000}"#),
        f("filter_min_output_tokens", r#"{"minOutputTokens":100}"#),
        f("filter_empty_string_ignored", r#"{"model":""}"#),
        f("filter_window_zero_ignored", r#"{"window":0}"#),
        f("filter_window_wide", r#"{"window":1000000}"#),
        f("filter_has_skill", r#"{"hasSkill":["agentlenspro-diagnostics"]}"#),
        f("filter_has_skill_multi", r#"{"hasSkill":["agentlenspro-diagnostics","rust"]}"#),
        f("filter_has_mcp", r#"{"hasMcp":["chrome-devtools"]}"#),
        f("filter_has_rule", r#"{"hasRule":["commit-discipline","never-git-add-all"]}"#),
        f("filter_has_content_tag", r#"{"hasContentTag":["image"]}"#),
        f(
            "filter_combined",
            r#"{"model":"claude-opus-5","effort":"high","minCacheCreate":100,"hasSkill":["agentlenspro-diagnostics"]}"#,
        ),
        f("filter_matches_nothing", r#"{"model":"no-such-model"}"#),
        // Wrong-typed filter values. The TS BINDS them (sql.js coerces a number to INTEGER, a bool
        // to 1/0) so the result NARROWS to nothing; requiring a JSON string here would DROP the
        // filter and answer a broader question under the caller's label. `filter_model_numeric` is
        // the discriminating one — 0 groups vs 5 if the filter were dropped.
        f("filter_model_numeric", r#"{"model":123}"#),
        f("filter_model_bool", r#"{"model":true}"#),
        f("filter_window_string", r#"{"window":"1000000"}"#),
        f("filter_window_unparseable", r#"{"window":"soon"}"#),
        f("filter_has_skill_mixed_types", r#"{"hasSkill":["agentlenspro-diagnostics",123]}"#),
        f("filter_has_skill_empty_array", r#"{"hasSkill":[]}"#),
        Case { group_by: Some("spawn_kind"), metric: Some("output_tokens"), ..c("verdict_output_metric") },
        Case {
            group_by: Some("spawn_kind"),
            metric: Some("billable_weighted"),
            ..c("verdict_billable_metric")
        },
        Case { group_by: Some("skill"), agg: Some("count"), ..c("skill_group_with_agg_count") },
        Case { missing_db: true, ..c("db_missing") },
    ]
}

fn run(case: &Case) -> Value {
    let db = if case.missing_db {
        fixtures().join("no-such-forensics.db")
    } else {
        fixtures().join("forensics.db")
    };
    let filter: Option<Value> =
        case.filter.map(|s| serde_json::from_str(s).expect("case filter is valid JSON"));
    build_compare_configs(
        &db,
        &CompareConfigsOptions {
            group_by: case.group_by,
            metric: case.metric,
            agg: case.agg,
            filter: filter.as_ref(),
            rank_order: case.rank_order,
            top_n: case.top_n,
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
    // A case added to the matrix and forgotten here would otherwise never run.
    assert_eq!(cases.len(), want.len(), "the Rust matrix and the oracle matrix disagree in size");
}

/// The unresolved-spawn mass is NEVER hidden: the engine's own doc-comment names this an honesty
/// contract, so it gets its own named test rather than riding along inside the oracle diff.
#[test]
fn the_unresolved_bucket_is_never_hidden() {
    let got = run(&c("defaults"));
    let groups = got["groups"].as_array().expect("groups array");
    let unresolved =
        groups.iter().find(|grp| grp["key"] == "unresolved").expect("no 'unresolved' group in defaults");
    let calls = unresolved["calls"].as_u64().expect("calls is a number");
    assert_eq!(
        got["coverage"]["unresolvedCalls"].as_u64(),
        Some(calls),
        "coverage.unresolvedCalls must equal the unresolved group's own call count"
    );
}

/// Verdicts are computed on the FULL ranking before topN truncates it — a port that truncated
/// first would silently drop the fork/fresh/worktree comparisons whenever the loser fell off the
/// end of a short top-N list.
#[test]
fn top_n_truncates_the_ranking_but_not_the_verdict() {
    let got = run(&Case { group_by: Some("spawn_kind"), top_n: Some(1.0), ..c("top_n_verdict_probe") });
    assert_eq!(got["groups"].as_array().map(Vec::len), Some(1));
    assert!(
        !got["verdict"].as_array().expect("verdict array").is_empty(),
        "verdict must survive top_n truncation"
    );
}

/// THE ONE DELIBERATE OUTPUT DIVERGENCE, so it is asserted rather than left to be rediscovered.
///
/// groupBy/metric/agg are typed as bare `string` in the MCP schema with no enum, and the TS handler
/// casts without validating — so a typo reaches the engine from any client. The TS answers a typo
/// three different silently-wrong ways: an unknown `metric` throws a SQL parse error, an unknown
/// `agg` makes every sort comparison NaN and the ranking arbitrary, and an unknown `groupBy` quietly
/// returns spawn_kind rows. This port names the typo instead. There is deliberately NO oracle case
/// for these — the TS cannot be the oracle for behaviour we chose not to reproduce.
#[test]
fn an_out_of_enum_argument_is_named_not_silently_substituted() {
    for (label, case) in [
        ("metric", Case { metric: Some("cache_creaton"), ..c("bad_metric") }),
        ("agg", Case { agg: Some("avarage"), ..c("bad_agg") }),
        ("groupBy", Case { group_by: Some("sesion"), ..c("bad_group_by") }),
    ] {
        let got = run(&case);
        let err = got["error"].as_str().unwrap_or_else(|| panic!("{label} typo produced no error: {got}"));
        assert!(err.contains("unknown"), "{label} error should say what was unknown: {err}");
        // The whole point: no result-shaped payload that a caller would read as data.
        assert!(got.get("groups").is_none(), "{label} typo still returned a groups array");
    }
    // The valid neighbours of each typo must still work — a guard that rejects everything would
    // pass the assertions above and break the tool.
    for good in [
        Case { metric: Some("cache_creation"), ..c("ok_metric") },
        Case { agg: Some("avg"), ..c("ok_agg") },
        Case { group_by: Some("session"), ..c("ok_group_by") },
    ] {
        assert!(run(&good).get("groups").is_some(), "a valid argument was rejected");
    }
}

/// A missing DB reports unavailability honestly instead of inventing zeros dressed up as data:
/// no groups, no verdicts, and a coverage block that says so and nothing else.
#[test]
fn a_missing_db_reports_unavailable_without_inventing_numbers() {
    let got = run(&Case { missing_db: true, ..c("db_missing_probe") });
    assert_eq!(got["dbAvailable"], Value::Bool(false));
    assert_eq!(got["groups"].as_array().map(Vec::len), Some(0));
    assert_eq!(got["verdict"].as_array().map(Vec::len), Some(0));
    let coverage = got["coverage"].as_object().expect("coverage object");
    assert_eq!(coverage.keys().collect::<Vec<_>>(), vec!["note"], "coverage must carry only 'note'");
}

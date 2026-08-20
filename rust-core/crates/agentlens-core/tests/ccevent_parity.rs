//! Cross-engine parity for `get_cache_event_log` (TRDD-DMWOBWFH P4x.2d). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-ccevent-expected.mjs
//!
//! THE ZONE IS PINNED, NOT READ. The generator runs under TZ=UTC and the engine takes the zone as a
//! parameter (`DisplayZone::Fixed`), so this test asserts the same wall-clock strings on a machine
//! in any zone — and does it WITHOUT mutating the process environment, which would race the other
//! tests in this binary.
//!
//! MTIME ORACLE: the raw-body scan windows and orders by mtime and git does not preserve those —
//! the generator stamps a fixed table and publishes it; this test re-stamps from it.
//!
//! Every absolute path is REDACTED to `<BODIES>` / `<SPANS>` / `<NOSPANS>`, and the fixture's cwd
//! and CLAUDE_PROJECT_DIR are fake paths: a project SLUG is derived from a path, so a real cwd
//! would smuggle this machine's home directory into the oracle in a form redaction cannot see.

use std::path::PathBuf;

use agentlens_core::cache_event_log::{
    build_cache_event_log, format_cache_event_log, write_scale_of, CacheEventLogOptions, DisplayZone, LedgerEnv,
    WRITE_SCALE_THRESHOLDS,
};
use serde_json::Value;

fn fixtures() -> PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn bodies() -> PathBuf {
    fixtures().join("ccevent-bodies")
}
fn spans() -> PathBuf {
    fixtures().join("ccevent-spans")
}
fn no_spans() -> PathBuf {
    fixtures().join("no-such-spans")
}
fn projects_dirs() -> Vec<PathBuf> {
    vec![fixtures().join("ccevent-home/projects")]
}

fn oracle() -> Value {
    let o: Value =
        serde_json::from_str(&std::fs::read_to_string(fixtures().join("ccevent-expected.json")).unwrap()).unwrap();
    let dir = bodies();
    for (name, ms) in o["mtimes"].as_object().unwrap() {
        let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(ms.as_f64().unwrap() as u64);
        let f = std::fs::OpenOptions::new().append(true).open(dir.join(name)).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
    }
    o
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract `assert_eq!` cannot see (`preserve_order` makes `Value::Object` an
/// IndexMap whose `PartialEq` ignores order). Load-bearing here because a row carries EIGHT
/// nullable fields that the TS emits as explicit `null` — a port that DROPPED them instead would
/// compare equal field by field while shipping a different table.
fn same(got: &Value, exp: &Value, label: &str) {
    assert_eq!(keys(got), keys(exp), "{label}: key set/ORDER differs\n  got={got}\n  exp={exp}");
    match exp {
        Value::Object(o) => {
            for (k, ev) in o {
                same(&got[k], ev, &format!("{label}.{k}"));
            }
        }
        Value::Array(ea) => {
            let ga = got.as_array().cloned().unwrap_or_default();
            assert_eq!(ga.len(), ea.len(), "{label}: length\n  got={got}");
            for (i, (g, e)) in ga.iter().zip(ea).enumerate() {
                same(g, e, &format!("{label}[{i}]"));
            }
        }
        _ => assert_eq!(got, exp, "{label}"),
    }
}

fn strip(v: &Value) -> Value {
    let s = v
        .to_string()
        .replace(&bodies().to_string_lossy().into_owned(), "<BODIES>")
        .replace(&spans().to_string_lossy().into_owned(), "<SPANS>")
        .replace(&no_spans().to_string_lossy().into_owned(), "<NOSPANS>");
    serde_json::from_str(&s).unwrap()
}

fn utc() -> DisplayZone {
    DisplayZone::Fixed { name: "UTC".to_owned(), offset_secs: 0 }
}

struct Case {
    spans: PathBuf,
    project_env_dir: Option<String>,
}

impl Default for Case {
    fn default() -> Self {
        // The generator's own stubs: CLAUDE_PROJECT_DIR=/w/beta, process.cwd()=/w/alpha.
        Self { spans: spans(), project_env_dir: Some("/w/beta".to_owned()) }
    }
}

fn run(o: &Value, opts: &CacheEventLogOptions, c: &Case) -> Value {
    let dirs = projects_dirs();
    let zone = utc();
    let env = LedgerEnv {
        bodies_dir: &bodies(),
        spans_dir: &c.spans,
        projects_dirs: &dirs,
        project_env_dir: c.project_env_dir.as_deref(),
        cwd: "/w/alpha",
        zone: &zone,
        now_ms: o["nowMs"].as_f64().unwrap(),
    };
    strip(&build_cache_event_log(opts, &env))
}

fn raw(o: &Value, opts: &CacheEventLogOptions, c: &Case) -> Value {
    let dirs = projects_dirs();
    let zone = utc();
    let env = LedgerEnv {
        bodies_dir: &bodies(),
        spans_dir: &c.spans,
        projects_dirs: &dirs,
        project_env_dir: c.project_env_dir.as_deref(),
        cwd: "/w/alpha",
        zone: &zone,
        now_ms: o["nowMs"].as_f64().unwrap(),
    };
    build_cache_event_log(opts, &env)
}

fn alpha() -> CacheEventLogOptions {
    CacheEventLogOptions { project: Some("-w-alpha".to_owned()), ..Default::default() }
}

#[test]
fn write_scale_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let exp: Vec<f64> = o["writeScale"]["thresholds"].as_array().unwrap().iter().map(|v| v.as_f64().unwrap()).collect();
    assert_eq!(WRITE_SCALE_THRESHOLDS.to_vec(), exp);
    for (n, scale) in o["writeScale"]["samples"].as_object().unwrap() {
        let n: f64 = n.parse().unwrap();
        assert_eq!(write_scale_of(n) as f64, scale.as_f64().unwrap(), "writeScaleOf({n})");
    }
    // A warm turn gets NO marker — that is what makes a marker mean something.
    assert_eq!(write_scale_of(0.0), 0);
}

#[test]
fn project_resolution_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let c = Case::default();
    same(&run(&o, &alpha(), &c), &o["logDefault"], "logDefault");
    // The three sources, in precedence order.
    same(&run(&o, &CacheEventLogOptions::default(), &c), &o["logFromEnv"], "logFromEnv");
    // A whitespace-only project argument is FALSY, so it falls through to the env var rather than
    // resolving to the empty slug and excluding everything.
    let blank = CacheEventLogOptions { project: Some("   ".to_owned()), ..Default::default() };
    same(&run(&o, &blank, &c), &o["logBlankProject"], "logBlankProject");
    let no_env = Case { project_env_dir: None, ..Default::default() };
    same(&run(&o, &CacheEventLogOptions::default(), &no_env), &o["logFromCwd"], "logFromCwd");
    assert_eq!(o["logFromCwd"]["projectResolvedFrom"], "working directory");
    // A project with no sessions on disk prints nothing and says so — every call is another
    // project's, which is the boundary working, not a failure.
    let unknown = CacheEventLogOptions { project: Some("-w-nope".to_owned()), ..Default::default() };
    let none = run(&o, &unknown, &c);
    same(&none, &o["logUnknownProject"], "logUnknownProject");
    assert!(none["rows"].as_array().unwrap().is_empty());
}

#[test]
fn peak_and_recent_modes_reproduce_the_ts_oracle_exactly() {
    let o = oracle();
    let c = Case::default();
    let with = |f: &dyn Fn(&mut CacheEventLogOptions)| {
        let mut a = alpha();
        f(&mut a);
        run(&o, &a, &c)
    };
    same(&with(&|a| a.mode = Some("recent".into())), &o["logRecent"], "logRecent");
    same(&with(&|a| { a.mode = Some("recent".into()); a.limit = Some(1.0) }), &o["logRecentLimitOne"], "logRecentLimitOne");
    // limit clamps to [1, 200] — a limit of 0 is NOT "no rows".
    same(&with(&|a| { a.mode = Some("recent".into()); a.limit = Some(0.0) }), &o["logRecentLimitZero"], "logRecentLimitZero");
    same(&with(&|a| { a.mode = Some("recent".into()); a.limit = Some(999.0) }), &o["logRecentAll"], "logRecentAll");
    // contextEvents 0 leaves the peak alone; 999 clamps to 25 and takes everything.
    let zero = with(&|a| a.context_events = Some(0.0));
    same(&zero, &o["logContextZero"], "logContextZero");
    assert_eq!(zero["rows"].as_array().unwrap().len(), 1);
    assert_eq!(zero["rows"][0]["role"], "peak");
    same(&with(&|a| a.context_events = Some(999.0)), &o["logContextHuge"], "logContextHuge");
    same(&with(&|a| a.session_id = Some(o["sessions"]["a1"].as_str().unwrap().to_owned())), &o["logSessionFilter"], "logSessionFilter");
    same(&with(&|a| a.window_hours = Some(1.0)), &o["logWindowed"], "logWindowed");
}

/// Runs the RUST engine, NOT the oracle's stored rows. Reading `o["logRecentAll"]["rows"]` here
/// would document the TS and gate nothing — proven: with this test reading the oracle, a
/// deliberate break of the `from_body` TTL rule left it GREEN while three sibling tests went red.
#[test]
fn every_cost_source_and_ttl_branch_is_reached() {
    let o = oracle();
    let mut all = alpha();
    all.mode = Some("recent".into());
    all.limit = Some(999.0);
    let got = run(&o, &all, &Case::default());
    let rows = got["rows"].as_array().unwrap();
    let sources: Vec<&str> = rows.iter().map(|r| r["costSource"].as_str().unwrap()).collect();
    // A green suite over a fixture that only ever reached `harness` would gate almost nothing.
    for want in ["harness", "computed", "unpriced"] {
        assert!(sources.contains(&want), "costSource {want} never reached: {sources:?}");
    }
    // An UNKNOWN model still reads as 'computed' — calcTokenCostUsd returns 0, not null — while
    // its `weighted` is null, because that one goes through lookupRates and gets nothing. The two
    // fields disagreeing is the honest answer, and it is easy to "fix" into a lie.
    let unknown = rows.iter().find(|r| r["model"] == "not-a-real-model-9").expect("unknown-model row");
    assert_eq!(unknown["costSource"], "computed");
    assert_eq!(unknown["costUsd"], 0.0);
    assert!(unknown["weightedInputEquivalentTokens"].is_null());
    // Only a call with NO model reaches 'unpriced'.
    let unpriced = rows.iter().find(|r| r["costSource"] == "unpriced").expect("unpriced row");
    assert!(unpriced["model"].is_null() && unpriced["costUsd"].is_null());
    // TTL: 1-hour comes ONLY from the enriched body; an OTEL row with no body is null, NOT
    // 5-minute — OTEL reports one undifferentiated write and cannot assert the tier.
    assert!(rows.iter().any(|r| r["cacheWriteTtl"] == "1-hour"));
    assert!(rows.iter().any(|r| r["cacheWriteTokens"].as_f64().unwrap() > 0.0 && r["cacheWriteTtl"].is_null()));
}

#[test]
fn the_raw_body_fallback_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let c = Case { spans: no_spans(), ..Default::default() };
    let fallback = run(&o, &alpha(), &c);
    same(&fallback, &o["logRawBodies"], "logRawBodies");
    let mut recent = alpha();
    recent.mode = Some("recent".into());
    same(&run(&o, &recent, &c), &o["logRawBodiesRecent"], "logRawBodiesRecent");
    // The two feeds are not interchangeable, and the payload says which one it is: the body path
    // attributes through the FOLLOWING request's previous_message_id, so a session's newest call
    // and a compaction's own summarization call fall into `unattributable` instead of a row.
    assert_eq!(fallback["source"], "raw-bodies");
    assert_eq!(o["logDefault"]["source"], "otel");
    assert!(fallback["excluded"]["unattributable"].as_f64().unwrap() > 0.0);
    assert_ne!(fallback["excluded"]["note"], o["logDefault"]["excluded"]["note"]);
}

#[test]
fn ledger_formats_reproduce_the_ts_oracle_exactly() {
    let o = oracle();
    let c = Case::default();
    let log = raw(&o, &alpha(), &c);
    for (fmt, key) in [("table", "formatTable"), ("markdown", "formatMarkdown")] {
        same(&strip(&format_cache_event_log(&log, fmt)), &o[key], key);
    }
    // json is the ledger itself, NOT a { format, text } wrapper.
    same(&strip(&format_cache_event_log(&log, "json")), &o["formatJson"], "formatJson");

    // Column widths are driven by the widest CELL, and the flame marker is TWO terminal columns per
    // code point — sizing it by character count leaves every later column visibly out of line.
    let mut all = alpha();
    all.mode = Some("recent".into());
    all.limit = Some(999.0);
    same(&strip(&format_cache_event_log(&raw(&o, &all, &c), "table")), &o["formatTableAll"], "formatTableAll");

    // Zero rows still renders the title, the TOTAL row and the legend.
    let unknown = CacheEventLogOptions { project: Some("-w-nope".to_owned()), ..Default::default() };
    same(&strip(&format_cache_event_log(&raw(&o, &unknown, &c), "table")), &o["formatTableEmpty"], "formatTableEmpty");

    let fb = Case { spans: no_spans(), ..Default::default() };
    same(
        &strip(&format_cache_event_log(&raw(&o, &alpha(), &fb), "table")),
        &o["formatTableRawBodies"],
        "formatTableRawBodies",
    );
}

//! Cross-engine parity for the cache-creation REPORT half (TRDD-DMWOBWFH P4x.2d) —
//! buildCacheCreationReport / buildExpensiveWritesTrace / buildCacheBreakGapReport and their
//! formatters. Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-ccreport-expected.mjs
//!
//! MTIME ORACLE: the gap buckets are ENTIRELY a function of the spacing between the fixture files'
//! mtimes, and git does not preserve those — the generator stamps a fixed table and publishes it;
//! this test re-stamps from that same table. Two hardcoded copies would silently drift.
//!
//! Every absolute path in the oracle is REDACTED to `<BODIES>`, so this test applies the same
//! substitution to the Rust output before comparing. A fixture carrying a real path would both
//! fail `check-identities` and pin one machine's layout into the suite.

use std::path::PathBuf;

use agentlens_core::cache_creation_forensics::{
    bucket_value_of, build_cache_break_gap_report, build_cache_creation_report, build_expensive_writes_trace,
    format_cost_peaks, format_expensive_writes, token_counts_full_cost, token_counts_total, ScanOptions, TokenCounts,
    TraceFilters,
};
use agentlens_core::summarize::helpers::num;
use serde_json::{Map, Value};

fn fixtures() -> PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn bodies() -> PathBuf {
    fixtures().join("ccreport-bodies")
}

fn oracle() -> Value {
    let o: Value =
        serde_json::from_str(&std::fs::read_to_string(fixtures().join("ccreport-expected.json")).unwrap()).unwrap();
    repin(&o);
    o
}

fn repin(o: &Value) {
    let dir = bodies();
    for (name, ms) in o["mtimes"].as_object().unwrap() {
        let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(ms.as_f64().unwrap() as u64);
        let f = std::fs::OpenOptions::new().append(true).open(dir.join(name)).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
    }
}

fn now(o: &Value) -> f64 {
    o["nowMs"].as_f64().unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract `assert_eq!` cannot see (`preserve_order` makes `Value::Object` an
/// IndexMap whose `PartialEq` ignores order). It is load-bearing across this whole surface: the
/// spike rows, the trace events and the `filters` echo each DROP three to five optional keys, and a
/// `?? null` port would emit them — same values, different wire shape.
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
    let s = v.to_string().replace(&bodies().to_string_lossy().into_owned(), "<BODIES>");
    serde_json::from_str(&s).unwrap()
}

fn win(hours: Option<f64>) -> ScanOptions {
    ScanOptions { window_hours: hours, ..ScanOptions::default() }
}

fn report(o: &Value, opts: &ScanOptions, group_by: &str, bucket: &str, top_n: Option<f64>) -> Value {
    strip(&build_cache_creation_report(&bodies(), opts, group_by, bucket, top_n, now(o)))
}

fn trace(o: &Value, opts: &ScanOptions, f: &TraceFilters) -> Value {
    strip(&build_expensive_writes_trace(&bodies(), opts, f, now(o)))
}

fn gaps(o: &Value, opts: &ScanOptions, min_cc: Option<f64>) -> Value {
    strip(&build_cache_break_gap_report(&bodies(), opts, min_cc, now(o)))
}

const SESSION_A: &str = "aaaaaaaa-1111-1111-1111-111111111111";
const ACCOUNT_A: &str = "acct1111-2222-2222-2222-222222222222";

const OPUS: TokenCounts = TokenCounts {
    input_tokens: 120.0,
    cache_read_tokens: 50000.0,
    cache_create_tokens: 32000.0,
    output_tokens: 800.0,
    model: Some("claude-opus-5"),
};
const NO_MODEL: TokenCounts = TokenCounts { model: None, ..OPUS };

const BUCKETS: [&str; 5] = ["cache_creation", "output", "input", "total", "billable_weighted"];

/// Routed through `num`, not `Value::from(f64)`: serde_json's Number equality does NOT bridge a
/// PosInt against a Float, so a bare `Value::from(32000.0)` fails against the oracle's `32000`
/// while both sides mean the same count.
fn bucket_table(t: &TokenCounts, now_ms: f64) -> Value {
    let mut m = Map::new();
    for b in BUCKETS {
        m.insert(b.into(), num(bucket_value_of(t, b, now_ms)));
    }
    Value::Object(m)
}

#[test]
fn bucket_primitives_reproduce_the_ts_oracle_exactly() {
    let o = oracle();
    let n = now(&o);
    let p = &o["primitives"];
    assert_eq!(token_counts_total(&OPUS), p["total"].as_f64().unwrap());
    assert_eq!(token_counts_full_cost(&OPUS, n), p["fullCost"].as_f64().unwrap());
    // An unpriced (modelless) counts object weighs ZERO, never a guessed rate.
    assert_eq!(token_counts_full_cost(&NO_MODEL, n), p["fullCostNoModel"].as_f64().unwrap());
    same(&bucket_table(&OPUS, n), &p["buckets"], "buckets");
    same(&bucket_table(&NO_MODEL, n), &p["bucketsNoModel"], "bucketsNoModel");
    // The switch's `default:` arm is cache_creation, NOT zero — an unknown bucket still ranks by
    // the write rather than flattening every group to nothing.
    assert_eq!(bucket_value_of(&OPUS, "not-a-bucket", n), p["bucketUnknown"].as_f64().unwrap());
}

#[test]
fn cost_peak_report_groups_by_every_dimension_exactly() {
    let o = oracle();
    let d = win(None);
    same(&report(&o, &d, "session", "cache_creation", None), &o["reportDefault"], "reportDefault");
    // account: session B is ATTRIBUTED but carries no account_uuid, so it lands in the same
    // '(unattributed)' group as the genuinely unjoinable calls — being attributed and having an
    // account are separate facts.
    same(&report(&o, &d, "account", "cache_creation", None), &o["reportByAccount"], "reportByAccount");
    same(&report(&o, &d, "model", "cache_creation", None), &o["reportByModel"], "reportByModel");
    same(&report(&o, &d, "time", "cache_creation", None), &o["reportByTime"], "reportByTime");
}

#[test]
fn cost_peak_report_ranks_by_every_bucket_exactly() {
    let o = oracle();
    let d = win(None);
    same(&report(&o, &d, "session", "output", None), &o["reportBucketOutput"], "reportBucketOutput");
    same(&report(&o, &d, "session", "billable_weighted", None), &o["reportBucketWeighted"], "reportBucketWeighted");
    same(&report(&o, &d, "session", "total", None), &o["reportBucketTotal"], "reportBucketTotal");
    same(&report(&o, &d, "session", "input", None), &o["reportBucketInput"], "reportBucketInput");
}

#[test]
fn cost_peak_report_truncates_the_table_but_not_the_totals() {
    let o = oracle();
    let d = win(None);
    let one = report(&o, &d, "session", "cache_creation", Some(1.0));
    same(&one, &o["reportTopOne"], "reportTopOne");
    // The proof the truncation is presentational: the table is one row while the totals still
    // account for every event.
    assert_eq!(one["groups"].as_array().unwrap().len(), 1);
    assert_eq!(one["totalCacheCreateTokens"], o["reportDefault"]["totalCacheCreateTokens"]);
    // topN is clamped to 50 from above; the fixture has fewer groups than that, so a huge topN is
    // the full table rather than an error.
    same(&report(&o, &d, "session", "cache_creation", Some(999.0)), &o["reportTopHuge"], "reportTopHuge");
    same(&report(&o, &win(Some(2.0)), "session", "cache_creation", None), &o["reportWindowed"], "reportWindowed");
}

#[test]
fn cost_peak_formats_reproduce_the_ts_oracle_exactly() {
    let o = oracle();
    let d = win(None);
    let r = build_cache_creation_report(&bodies(), &d, "session", "cache_creation", None, now(&o));
    for (fmt, key) in [("table", "formatPeaksTable"), ("markdown", "formatPeaksMarkdown"), ("timeline", "formatPeaksTimeline")] {
        same(&strip(&format_cost_peaks(&r, fmt)), &o[key], key);
    }
    // json is the report itself, NOT a { format, text } wrapper.
    same(&strip(&format_cost_peaks(&r, "json")), &o["formatPeaksJson"], "formatPeaksJson");
}

#[test]
fn a_fractional_bucket_value_renders_with_three_fraction_digits() {
    let o = oracle();
    let r = build_cache_creation_report(&bodies(), &win(None), "session", "billable_weighted", None, now(&o));
    let got = strip(&format_cost_peaks(&r, "table"));
    same(&got, &o["formatPeaksWeightedTable"], "formatPeaksWeightedTable");
    // The reason this case exists: under billable_weighted the ranked value is a USD cost, and
    // `toLocaleString` keeps at most THREE fraction digits (rounded, not truncated). A port that
    // truncated would print "4" for a $4.5585 group — the same failure at every scale.
    assert!(got["text"].as_str().unwrap().contains("4.559"), "got={}", got["text"]);
}

#[test]
fn expensive_writes_trace_filters_reproduce_the_ts_oracle_exactly() {
    let o = oracle();
    let d = win(None);
    let f = |t: TraceFilters| trace(&o, &d, &t);
    same(&f(TraceFilters::default()), &o["traceDefault"], "traceDefault");
    same(&f(TraceFilters { top_n: Some(2.0), ..Default::default() }), &o["traceTopTwo"], "traceTopTwo");
    same(
        &f(TraceFilters { min_cache_create: Some(150000.0), ..Default::default() }),
        &o["traceMinCacheCreate"],
        "traceMinCacheCreate",
    );
    same(&f(TraceFilters { min_output_tokens: Some(500.0), ..Default::default() }), &o["traceMinOutput"], "traceMinOutput");
    same(&f(TraceFilters { session_id: Some(SESSION_A.into()), ..Default::default() }), &o["traceBySession"], "traceBySession");
    same(&f(TraceFilters { account_uuid: Some(ACCOUNT_A.into()), ..Default::default() }), &o["traceByAccount"], "traceByAccount");
    // model is a SUBSTRING match: "opus" selects claude-opus-5 without naming it.
    same(&f(TraceFilters { model: Some("opus".into()), ..Default::default() }), &o["traceByModelSubstring"], "traceByModelSubstring");
    // A filter that matches nothing is still a well-formed trace carrying its coverage — the
    // caller must be able to tell "nothing matched" from "nothing was scanned".
    let none = f(TraceFilters { session_id: Some("no-such-session".into()), ..Default::default() });
    same(&none, &o["traceNoMatch"], "traceNoMatch");
    assert!(none["events"].as_array().unwrap().is_empty());
    assert_eq!(none["coverage"]["responseFilesScanned"], o["traceDefault"]["coverage"]["responseFilesScanned"]);
}

#[test]
fn expensive_writes_trace_turn_and_time_ranges_reproduce_the_ts_oracle_exactly() {
    let o = oracle();
    let d = win(None);
    same(
        &trace(&o, &d, &TraceFilters { turn_from: Some(2.0), turn_to: Some(4.0), ..Default::default() }),
        &o["traceTurnRange"],
        "traceTurnRange",
    );
    let from = o["traceTimeRange"]["filters"]["timeFromIso"].as_str().unwrap().to_owned();
    let to = o["traceTimeRange"]["filters"]["timeToIso"].as_str().unwrap().to_owned();
    same(
        &trace(&o, &d, &TraceFilters { time_from_iso: Some(from), time_to_iso: Some(to), ..Default::default() }),
        &o["traceTimeRange"],
        "traceTimeRange",
    );
}

#[test]
fn expensive_writes_backward_chain_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let d = win(None);
    let chained = trace(
        &o,
        &d,
        &TraceFilters { session_id: Some(SESSION_A.into()), chain_depth: Some(3.0), ..Default::default() },
    );
    same(&chained, &o["traceChain"], "traceChain");
    // chainDepth is clamped to MAX_CHAIN_DEPTH (20) — 999 is not an unbounded walk back through
    // every request the session ever made.
    same(
        &trace(
            &o,
            &d,
            &TraceFilters { session_id: Some(SESSION_A.into()), chain_depth: Some(999.0), top_n: Some(1.0), ..Default::default() },
        ),
        &o["traceChainClamped"],
        "traceChainClamped",
    );
    same(&trace(&o, &d, &TraceFilters { top_n: Some(999.0), ..Default::default() }), &o["traceTopHuge"], "traceTopHuge");
}

#[test]
fn expensive_writes_formats_reproduce_the_ts_oracle_exactly() {
    let o = oracle();
    let d = win(None);
    let three = build_expensive_writes_trace(&bodies(), &d, &TraceFilters { top_n: Some(3.0), ..Default::default() }, now(&o));
    for (fmt, key) in [("table", "formatWritesTable"), ("markdown", "formatWritesMarkdown"), ("timeline", "formatWritesTimeline")] {
        same(&strip(&format_expensive_writes(&three, fmt)), &o[key], key);
    }
    let one = build_expensive_writes_trace(&bodies(), &d, &TraceFilters { top_n: Some(1.0), ..Default::default() }, now(&o));
    same(&strip(&format_expensive_writes(&one, "json")), &o["formatWritesJson"], "formatWritesJson");
    // The markdown chain sections are emitted only for events that HAVE a chain, and each turn is
    // labelled t-N counting back from the write.
    let chained = build_expensive_writes_trace(
        &bodies(),
        &d,
        &TraceFilters { session_id: Some(SESSION_A.into()), top_n: Some(2.0), chain_depth: Some(2.0), ..Default::default() },
        now(&o),
    );
    same(&strip(&format_expensive_writes(&chained, "markdown")), &o["formatWritesMarkdownChain"], "formatWritesMarkdownChain");
}

#[test]
fn cache_break_gap_report_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let d = win(None);
    let def = gaps(&o, &d, None);
    same(&def, &o["gapsDefault"], "gapsDefault");
    // Every one of the six buckets is populated by the fixture — a green suite over a report whose
    // classifier only ever reached two of them would gate almost nothing.
    for (i, b) in def["gapBuckets"].as_array().unwrap().iter().enumerate() {
        assert!(b["events"].as_f64().unwrap() > 0.0, "bucket {i} ({}) never fired", b["bucket"]);
    }
    // Lowering the threshold promotes a previously-ignored small call to "big", which changes the
    // classification of the call AFTER it: `i === 0` is positional within the session, not
    // "the previous big event".
    same(&gaps(&o, &d, Some(1000.0)), &o["gapsLowThreshold"], "gapsLowThreshold");
    // Above every event: the tier split still reports (it is computed over ALL events, not the big
    // ones), bigEventCount is 0, and every bucket is empty.
    let none = gaps(&o, &d, Some(10_000_000.0));
    same(&none, &o["gapsNoBigEvents"], "gapsNoBigEvents");
    assert_eq!(none["bigEventCount"].as_f64().unwrap(), 0.0);
    assert_eq!(none["tierSplit"]["totalCacheCreateTokens"], def["tierSplit"]["totalCacheCreateTokens"]);
    same(&gaps(&o, &win(Some(2.0)), None), &o["gapsWindowed"], "gapsWindowed");
}

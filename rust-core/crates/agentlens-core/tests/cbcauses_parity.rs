//! Cross-engine parity for the cacheBreakTimeline SLICE 4 reporters (TRDD-DMWOBWFH P4x.2l):
//! `buildCauseCostPeakReport`, `buildCacheBreakCauses` and `formatTimeline`. Oracle:
//!   pnpm run compile-tests \
//!     && node rust-core/crates/agentlens-core/tests/fixtures/gen-cbreport-expected.mjs \
//!     && node rust-core/crates/agentlens-core/tests/fixtures/gen-cbcauses-expected.mjs
//!
//! Reuses SLICE 3's fixture tree and its mtime table on purpose: all three builders read the same
//! scan, so a second spool would let them drift apart while both stayed green.

use std::path::{Path, PathBuf};

use agentlens_core::cache_break_timeline::{
    build_cache_break_causes, build_cache_break_timeline, build_cause_cost_peak_report, format_timeline,
    CacheBreakCausesOptions, CacheBreakTimelineOptions, CauseCostPeakOptions,
};
use serde_json::Value;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn read(name: &str) -> Value {
    serde_json::from_str(&std::fs::read_to_string(fixtures().join(name)).unwrap()).unwrap()
}

/// Re-stamp from SLICE 3's table — turn order and gaps come from spool mtimes, which git drops.
fn restamp() {
    let o = read("cbreport-expected.json");
    for (rel, ms) in o["mtimes"].as_object().unwrap() {
        let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(ms.as_f64().unwrap() as u64);
        let p = fixtures().join(rel);
        let f = std::fs::OpenOptions::new().append(true).open(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
        f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
    }
}

fn oracle() -> Value {
    restamp();
    let mut o = read("cbcauses-expected.json");
    let from = o["root"].as_str().unwrap().to_owned();
    let to = fixtures().join("cbreport").to_string_lossy().into_owned();
    rewrite(&mut o, &from, &to);
    o
}

fn rewrite(v: &mut Value, from: &str, to: &str) {
    match v {
        Value::String(s) => {
            if s.contains(from) {
                *s = s.replace(from, to);
            }
        }
        Value::Array(a) => a.iter_mut().for_each(|x| rewrite(x, from, to)),
        Value::Object(o) => o.iter_mut().for_each(|(_, x)| rewrite(x, from, to)),
        _ => {}
    }
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

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

fn root() -> PathBuf {
    fixtures().join("cbreport")
}

fn cost_peak_opts(case: &str) -> CauseCostPeakOptions {
    let r = root();
    let mut o = CauseCostPeakOptions::new(&r);
    o.bodies_dir = Some(r.join("spool"));
    o.store_dir = Some(r.join("no-such-store"));
    o.hook_events_dir = Some(r.join("hooks"));
    o.min_tokens = Some(100.0);
    match case {
        "default_bucket" => {}
        "bucket_output" => o.bucket = Some("output".to_owned()),
        "bucket_weighted" => o.bucket = Some("billable_weighted".to_owned()),
        "topn1" => o.top_n = Some(1.0),
        "topn_over_cap" => o.top_n = Some(999.0),
        "high_floor" => o.min_tokens = Some(26000.0),
        "no_evidence" => o.bodies_dir = Some(r.join("no-such-spool")),
        other => panic!("unknown costPeak case {other}"),
    }
    o
}

fn causes_opts(case: &str) -> CacheBreakCausesOptions {
    let r = root();
    let mut o = CacheBreakCausesOptions::new(&r);
    o.bodies_dir = Some(r.join("spool"));
    o.store_dir = Some(r.join("no-such-store"));
    o.hook_events_dir = Some(r.join("hooks"));
    o.min_tokens = Some(100.0);
    match case {
        "all" => {}
        "scoped" => o.scope = Some("sess-".to_owned()),
        "scoped_empty" => o.scope = Some("nothing-matches-".to_owned()),
        "topn1" => o.top_n = Some(1.0),
        "topn_clamped_low" => o.top_n = Some(0.0),
        "high_floor" => o.min_tokens = Some(26000.0),
        "no_evidence" => o.bodies_dir = Some(r.join("no-such-spool")),
        other => panic!("unknown causes case {other}"),
    }
    o
}

#[test]
fn cause_cost_peak_reports_match() {
    let o = oracle();
    for (name, exp) in o["costPeak"].as_object().unwrap() {
        let got = build_cause_cost_peak_report(&cost_peak_opts(name));
        same(&got, exp, &format!("buildCauseCostPeakReport({name})"));
    }
}

#[test]
fn cause_and_actor_reports_match() {
    let o = oracle();
    for (name, exp) in o["causes"].as_object().unwrap() {
        let got = build_cache_break_causes(&causes_opts(name));
        same(&got, exp, &format!("buildCacheBreakCauses({name})"));
    }
}

#[test]
fn formats_match() {
    let o = oracle();
    let r = root();
    let mut t = CacheBreakTimelineOptions::new(&r);
    t.bodies_dir = Some(r.join("spool"));
    t.store_dir = Some(r.join("no-such-store"));
    t.hook_events_dir = Some(r.join("hooks"));
    t.min_tokens = Some(100.0);
    t.session_id = Some("sess-alpha".to_owned());
    let full = build_cache_break_timeline(&t);
    t.top_n = Some(2.0);
    let capped = build_cache_break_timeline(&t);
    for (name, exp) in o["formats"].as_object().unwrap() {
        let (report, fmt) = match name.as_str() {
            "table_capped" => (&capped, "table"),
            "timeline_capped" => (&capped, "timeline"),
            other => (&full, other),
        };
        same(&format_timeline(report, fmt), exp, &format!("formatTimeline({name})"));
    }
}

//! Cross-engine parity for `buildCacheBreakTimeline` — cacheBreakTimeline SLICE 3
//! (TRDD-DMWOBWFH P4x.2k). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-cbreport-expected.mjs
//!
//! MTIME ORACLE: turn order, the inter-turn gap and the recency cap all come from spool file
//! mtimes, which git does not preserve — the generator stamps them and publishes the table; this
//! test re-stamps from it before scanning. Skipping that makes the fixture a different fixture on
//! every clone.
//!
//! PATH REWRITE: the oracle records the generator's ABSOLUTE fixture root (it reaches the wire in
//! `coverage.bodiesDir` and in two notes). The test rewrites it to its own root before comparing,
//! so a different checkout path is not a failure.

use std::path::{Path, PathBuf};

use agentlens_core::cache_break_timeline::{build_cache_break_timeline, CacheBreakTimelineOptions};
use serde_json::Value;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn oracle() -> Value {
    let p = fixtures().join("cbreport-expected.json");
    let mut o: Value = serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap();
    for (rel, ms) in o["mtimes"].as_object().unwrap() {
        let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(ms.as_f64().unwrap() as u64);
        let p = fixtures().join(rel);
        let f = std::fs::OpenOptions::new().append(true).open(&p).unwrap_or_else(|e| panic!("{}: {e}", p.display()));
        f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
    }
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

/// Key ORDER matters: `sessionId`/`accountUuid`/`model`/`eventsNote` and the event-level
/// `gapMinutes`/`ttlTier`/`model`/`rawDiffSummary`/`confidence`/`causeEvidence` are all OPTIONAL,
/// and `causeEvidence` in particular is assigned AFTER construction so it serializes LAST.
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

/// An EXISTING but empty bodies dir. Created on demand (see the `empty_spool` case below).
fn empty_spool(root: &Path) -> PathBuf {
    let p = root.join("empty-spool");
    std::fs::create_dir_all(&p).unwrap();
    p
}

fn opts(case: &str) -> CacheBreakTimelineOptions {
    let root = fixtures().join("cbreport");
    let mut o = CacheBreakTimelineOptions::new(&root);
    o.bodies_dir = Some(root.join("spool"));
    o.store_dir = Some(root.join("no-such-store"));
    o.hook_events_dir = Some(root.join("hooks"));
    o.min_tokens = Some(100.0);
    match case {
        "heaviest" => {}
        "scoped" => o.scope = Some("other-".to_owned()),
        "explicit_session" => o.session_id = Some("sess-alpha".to_owned()),
        "topn2" => {
            o.session_id = Some("sess-alpha".to_owned());
            o.top_n = Some(2.0);
        }
        "topn_clamped_low" => {
            o.session_id = Some("sess-alpha".to_owned());
            o.top_n = Some(0.0);
        }
        "high_floor" => {
            o.session_id = Some("sess-alpha".to_owned());
            o.min_tokens = Some(26000.0);
        }
        "lookback_bookkeeping" => o.session_id = Some("sess-delta".to_owned()),
        "hooks_evidence" => o.session_id = Some("sess-gamma".to_owned()),
        "hooks_absent" => {
            o.session_id = Some("sess-gamma".to_owned());
            o.hook_events_dir = Some(root.join("no-hooks"));
        }
        "subagent" => {
            o.session_id = Some("agent-kid".to_owned());
            o.projects_dirs = Some(vec![root.join("projects")]);
        }
        "subagent_missing" => {
            o.session_id = Some("agent-nope".to_owned());
            o.projects_dirs = Some(vec![root.join("projects")]);
        }
        "unknown_session" => o.session_id = Some("sess-nope".to_owned()),
        "no_evidence" => o.bodies_dir = Some(root.join("no-such-spool")),
        // The empty-spool cases MUST create the directory: they assert coverage.dirExists ==
        // true against a spool with no bodies in it, and git cannot track an empty directory —
        // so a committed fixture would silently vanish on every fresh clone (and in CI) and
        // turn "present but empty" into "absent", which is the opposite branch.
        "empty_spool" => o.bodies_dir = Some(empty_spool(&root)),
        "window_echo" => {
            o.bodies_dir = Some(empty_spool(&root));
            o.window_hours = Some(24.0);
        }
        other => panic!("unknown case {other} — add it here when the generator gains one"),
    }
    o
}

#[test]
fn timeline_reports_match_the_ts_engine() {
    let o = oracle();
    let cases = o["cases"].as_object().expect("cases");
    for (name, exp) in cases {
        let got = build_cache_break_timeline(&opts(name));
        same(&got, exp, &format!("buildCacheBreakTimeline({name})"));
    }
}

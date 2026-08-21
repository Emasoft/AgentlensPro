//! Cross-engine parity for `run_transcript_sql` (TRDD-DMWOBWFH P4x.2o). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-transcriptsql-expected.mjs
//!
//! The engine lives in `agentlens-store` (it owns the DuckDB binding); the fixture and the test
//! stay here with the rest of the corpus.
//!
//! MTIME ORACLE: file selection is an mtime window against wall-clock now, and git does not
//! preserve mtimes — a fresh checkout would select whatever the clone time makes it select. The
//! generator stamped each file at a fixed OFFSET from its own now and published the offsets; this
//! re-stamps with the same offsets before scanning, so what is pinned is "which files a 24h window
//! selects", not an accident of when the tree was written.

use std::path::{Path, PathBuf};

use agentlens_store::transcript_sql as ts;
use serde_json::Value;

fn fixtures() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

fn oracle() -> Value {
    let p = fixtures().join("transcriptsql-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
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

#[test]
fn run_transcript_sql_matches() {
    let o = oracle();
    let tree = fixtures().join("transcriptsql");
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_millis() as f64;

    for (rel, hours) in o["offsets"].as_object().unwrap() {
        let p = tree.join(rel);
        let at = now - hours.as_f64().unwrap() * 3_600_000.0;
        let f = std::fs::File::options().write(true).open(&p).unwrap_or_else(|e| panic!("{rel}: {e}"));
        f.set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_millis(at as u64)).unwrap();
    }

    let dirs = vec![tree.join("projA"), tree.join("projB")];
    let token = tree.to_string_lossy().into_owned();

    for (name, case) in o["cases"].as_object().unwrap() {
        let c = &case["opts"];
        let opts = ts::TranscriptSqlOptions {
            preset: c["preset"].as_str(),
            sql: c["sql"].as_str(),
            session_id: c["sessionId"].as_str(),
            window_hours: c["windowHours"].as_f64(),
            limit: c["limit"].as_f64(),
            projects_dirs: dirs.clone(),
        };
        let got = ts::run_transcript_sql(&opts, now);
        // Same redaction the generator applied: `filename=true` puts absolute paths in the result,
        // and a fixture carrying this machine's home directory is a leak the identity gate would
        // (correctly) refuse at `git add`.
        let got: Value =
            serde_json::from_str(&serde_json::to_string(&got).unwrap().replace(&token, "<FIXTURES>")).unwrap();
        let exp = &case["result"];

        if name == "binder_error" {
            // The message BODY is DuckDB's own prose — candidate bindings, a caret, a line echo —
            // and pinning it would assert the engine's wording rather than this port's behaviour.
            // What is ours is the prefix, the mode, and that the coverage still explains the scope.
            assert_eq!(keys(&got), keys(exp), "{name}: key set/ORDER");
            let msg = got["error"].as_str().unwrap_or_default();
            assert!(msg.starts_with("query failed: "), "{name}: prefix, got {msg}");
            assert!(msg.contains("nosuchcolumn"), "{name}: names the column, got {msg}");
            same(&got["coverage"], &exp["coverage"], &format!("{name}.coverage"));
            continue;
        }
        same(&got, exp, name);
    }
}

/// The statement gate on its own, beyond the shapes the ladder happens to reach. Fail-CLOSED is the
/// property under test: every rejection is a rejection, and the one ACCEPTED case exists so a gate
/// that simply refused everything could not pass.
#[test]
fn statement_gate() {
    for (sql, err) in [
        ("", "Empty SQL."),
        ("   \n  ", "Empty SQL."),
        ("-- just a comment", "Empty SQL."),
        ("/* only a block */", "Empty SQL."),
        ("DROP TABLE t", "Only read-only SELECT or WITH queries are allowed."),
        ("select 1; select 2", "Only a single statement is allowed (a second \";\" was found)."),
        // A comment cannot smuggle a second statement past the gate: comments are stripped BEFORE
        // the semicolon count, so what is counted is real SQL.
        ("SELECT 1 /* x */ ; DROP TABLE t", "Only a single statement is allowed (a second \";\" was found)."),
        ("SELECTED FROM t", "Only read-only SELECT or WITH queries are allowed."),
        ("WITH x AS (SELECT 1) INSERT INTO t SELECT * FROM x", "DDL/DML/ATTACH/PRAGMA keywords are rejected — this surface is read-only."),
        ("SELECT * FROM t WHERE a = 1 ATTACH", "DDL/DML/ATTACH/PRAGMA keywords are rejected — this surface is read-only."),
    ] {
        assert_eq!(ts::assert_read_only_select(sql).unwrap_err(), err, "sql={sql:?}");
    }

    // ACCEPTED, and each for a reason: one trailing semicolon is allowed; a forbidden word EMBEDDED
    // in an identifier is not a keyword (`\b` in the TS regex), so `created_at` and `updates` must
    // not trip a gate that only substring-matched.
    for sql in [
        "SELECT 1",
        "select 1;",
        "  WITH x AS (SELECT 1) SELECT * FROM x  ",
        "SELECT created_at, updates FROM t",
        "SELECT 1 -- trailing comment",
        // Comments are stripped BEFORE both checks, so a semicolon or a forbidden keyword INSIDE
        // one is not smuggling and must not be a false rejection either. Without the strip these
        // two are refused, and the gate becomes wrong in the direction nobody notices — legitimate
        // annotated SQL rejected — which is why they are pinned as ACCEPTED, not just as safe.
        "SELECT 1 -- ; DROP TABLE t",
        "/* ; DROP TABLE t */ SELECT 1",
    ] {
        assert!(ts::assert_read_only_select(sql).is_ok(), "sql={sql:?} should pass");
    }
}

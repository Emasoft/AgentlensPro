//! Cross-engine parity for the cache-risk command scan (TRDD-DMWOBWFH row 9): the committed
//! transcript fixture runs through both engines and every list — order, conditional keys,
//! classifier verdicts — must Value-equal the compiled-TS oracle.
//! After any TS change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-cacherisk-expected.mjs

use agentlens_core::cache_risk_commands::{classify_slash_command, parse_command_block, scan_cache_risk_commands};
use serde_json::{json, Value};

fn fixtures() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

#[test]
fn cache_risk_scan_reproduces_the_ts_oracle_exactly() {
    let o: Value = serde_json::from_str(&std::fs::read_to_string(fixtures().join("cacherisk-expected.json")).unwrap()).unwrap();
    let dirs = vec![fixtures().join("cacherisk-tree")];
    let now = o["now"].as_f64().unwrap();

    let arr = |v: Vec<Value>| Value::Array(v);
    assert_eq!(arr(scan_cache_risk_commands(&dirs, Some(0.0), None, None)), o["all"], "full scan");
    let kinds = vec!["MODEL_SWITCHED".to_owned(), "CLEAR".to_owned()];
    assert_eq!(arr(scan_cache_risk_commands(&dirs, Some(0.0), Some(&kinds), None)), o["kinds"], "kinds filter");
    assert_eq!(arr(scan_cache_risk_commands(&dirs, Some(0.0), None, Some(3))), o["limited"], "limit slice");
    // sinceMs also gates per-record ts, not just file mtime (the fixture files are freshly
    // written, so only the record filter separates these).
    assert_eq!(arr(scan_cache_risk_commands(&dirs, Some(now - 26_000.0), None, None)), o["tsWindow"], "ts window");

    // The classifier verdicts, JSON-shaped like the oracle's (tuples → [kind, mutation]).
    let classify = |name: &str, args: Option<&str>| -> Value {
        classify_slash_command(name, args).map(|(k, m)| json!({ "kind": k, "mutation": m })).unwrap_or(Value::Null)
    };
    let got = json!([
        classify("/Reload-Plugins", None),
        classify("/plugin", Some("PLUGINS  Marketplace add x")),
        classify("/model", Some("")),
        classify("/effort", Some("max")),
        classify("/quit", None),
    ]);
    assert_eq!(got, o["classify"]);

    let parse = |t: &str| -> Value {
        match parse_command_block(t) {
            None => Value::Null,
            Some((name, args)) => {
                // The TS returns {name, args?} with args absent (undefined) when empty.
                let mut m = serde_json::Map::new();
                m.insert("name".into(), Value::from(name));
                if let Some(a) = args {
                    m.insert("args".into(), Value::from(a));
                }
                Value::Object(m)
            }
        }
    };
    let got = json!([
        parse("<command-name>/x</command-name>"),
        parse("nope"),
        parse("<command-name></command-name>"),
        parse("<command-name>/y</command-name><command-args>  </command-args>"),
    ]);
    assert_eq!(got, o["parse"]);
}

//! Cross-engine parity for the instruction advisor + file detection (TRDD-DMWOBWFH rows
//! 19–21): ONE committed case list (instructions-expected.json, emitted by
//! gen-instructions-expected.mjs from the COMPILED instructionAdvisor.js/instructionFiles.js)
//! drives both engines; every suggestion — evidence strings included — must Value-equal, and
//! the workspace-fixture detection must match field-for-field (filePath is stored relative in
//! the oracle and reconstructed here — an absolute path would be a machine identity in a
//! committed file). After any TS change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-instructions-expected.mjs

use agentlens_core::instruction_advisor::generate_suggestions;
use agentlens_core::instruction_files::{detect_instruction_files, read_all_instruction_content};
use serde_json::Value;

fn fixtures() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// First-diverging-path reporting instead of two multi-KB trees.
fn assert_deep_eq(got: &Value, exp: &Value, path: &str) {
    if got == exp {
        return;
    }
    match (got, exp) {
        (Value::Object(g), Value::Object(e)) => {
            for (k, ev) in e {
                assert_deep_eq(g.get(k).unwrap_or(&Value::Null), ev, &format!("{path}.{k}"));
            }
            for k in g.keys() {
                assert!(e.contains_key(k), "{path}: extra key {k}");
            }
            panic!("{path}: objects diverge but no field diff fired");
        }
        (Value::Array(g), Value::Array(e)) => {
            assert_eq!(g.len(), e.len(), "{path}: array length (got {got})");
            for (i, (gv, ev)) in g.iter().zip(e.iter()).enumerate() {
                assert_deep_eq(gv, ev, &format!("{path}[{i}]"));
            }
            panic!("{path}: arrays diverge but no element diff fired");
        }
        _ => panic!("{path}: got {got} expected {exp}"),
    }
}

#[test]
fn advisor_reproduces_the_ts_oracle_exactly() {
    let oracle: Value =
        serde_json::from_str(&std::fs::read_to_string(fixtures().join("instructions-expected.json")).unwrap()).unwrap();
    let cases = oracle["cases"].as_array().unwrap();
    let expected = oracle["expected"].as_array().unwrap();
    for (c, exp) in cases.iter().zip(expected) {
        let sessions = c["sessions"].as_array().unwrap();
        let got = Value::Array(generate_suggestions(sessions, c["existing"].as_str().unwrap()));
        assert_deep_eq(&got, exp, c["name"].as_str().unwrap());
    }
}

#[test]
fn detect_instruction_files_matches_the_ts_probe() {
    let oracle: Value =
        serde_json::from_str(&std::fs::read_to_string(fixtures().join("instructions-expected.json")).unwrap()).unwrap();
    let tree = fixtures().join("instructions-tree");
    for ws in ["ws1", "ws2"] {
        let root = tree.join(ws);
        let got = detect_instruction_files(&root.to_string_lossy());
        let exp = oracle["detect"][ws].as_array().unwrap();
        assert_eq!(got.len(), exp.len(), "{ws}");
        for (g, x) in got.iter().zip(exp) {
            // filePath: the oracle stores it workspace-relative; both engines join identically.
            let expected_abs = root.join(x["filePath"].as_str().unwrap());
            assert_eq!(g["filePath"].as_str().unwrap(), expected_abs.to_string_lossy(), "{ws}");
            for k in ["agent", "label", "relativePath", "exists", "content"] {
                assert_eq!(&g[k], &x[k], "{ws} {k}");
            }
        }
    }
    assert_eq!(
        read_all_instruction_content(&tree.join("ws1").to_string_lossy()),
        oracle["detect"]["ws1AllContent"].as_str().unwrap()
    );
}

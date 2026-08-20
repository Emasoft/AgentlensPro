//! Cross-engine parity for the burn gate (TRDD-DMWOBWFH P4r.5): ONE committed case list
//! (tests/fixtures/agentgate-expected.json, emitted by gen-agentgate-expected.mjs from the
//! COMPILED agentGate.ts) drives BOTH engines — the gate state is a JSON object in both by
//! design, so every case replays verbatim and the decision (reason strings included) must
//! Value-equal. Transcript fixtures carry PINNED mtimes in the JSON: git checkout clobbers
//! mtimes, so this test re-pins each file before reading. After any TS change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-agentgate-expected.mjs

use agentlens_core::burn::agent_gate::{
    build_advisory, evaluate_agent_gate, evaluate_image_read_gate, evaluate_send_message_gate, is_keep_warm_pinger,
    read_transcript_context, resolve_message_target_liveness,
};
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
fn agent_gate_reproduces_the_ts_oracle_exactly() {
    let dir = fixtures();
    let tree = dir.join("agentgate-tree");
    let oracle: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("agentgate-expected.json")).unwrap()).unwrap();

    // Re-pin the transcript mtimes the oracle recorded — checkout time is not fixture data.
    for (name, meta) in oracle["transcripts"].as_object().unwrap() {
        let ms = meta["mtimeMs"].as_f64().unwrap();
        let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(ms as u64);
        let f = std::fs::OpenOptions::new().append(true).open(tree.join(name)).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
    }

    let cases = oracle["cases"].as_array().unwrap();
    let expected = oracle["expected"].as_array().unwrap();
    assert_eq!(cases.len(), expected.len());
    for (c, exp) in cases.iter().zip(expected) {
        let name = c["name"].as_str().unwrap();
        let state = c.get("state").unwrap_or(&Value::Null);
        let got = match c["fn"].as_str().unwrap() {
            "evaluateAgentGate" => evaluate_agent_gate(c.get("toolInput"), state),
            "evaluateSendMessageGate" => evaluate_send_message_gate(state),
            "evaluateImageReadGate" => evaluate_image_read_gate(c.get("toolInput"), state),
            "buildAdvisory" => build_advisory(state),
            "resolveMessageTargetLiveness" => {
                Value::from(resolve_message_target_liveness(c.get("target"), c["events"].as_array().unwrap()))
            }
            "isKeepWarmPinger" => Value::Bool(is_keep_warm_pinger(&c["input"])),
            "readTranscriptContext" => read_transcript_context(
                &tree.join(c["file"].as_str().unwrap()),
                c["now"].as_f64().unwrap(),
                c["tailBytes"].as_u64().unwrap(),
            ),
            other => panic!("unknown fn {other}"),
        };
        assert_deep_eq(&got, exp, name);
    }
}

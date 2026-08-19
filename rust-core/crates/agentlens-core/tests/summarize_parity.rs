//! Cross-engine parity for summarizeSpans (TRDD-DMWOBWFH P4d): the expected output was produced
//! by the COMPILED TS summarizer itself (tests/fixtures/gen-summarize-expected.mjs — the
//! oracle). Regenerate after any TS change in spanSummarizer.ts or the builders:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-summarize-expected.mjs

use serde_json::Value;

fn diff_cards(kind: &str, got: &Value, expected: &Value) {
    let (g, e) = (got.as_array().unwrap(), expected.as_array().unwrap());
    assert_eq!(g.len(), e.len(), "{kind} count");
    for (i, (gc, ec)) in g.iter().zip(e.iter()).enumerate() {
        if gc == ec {
            continue;
        }
        let (go, eo) = (gc.as_object().unwrap(), ec.as_object().unwrap());
        for key in eo.keys() {
            assert!(go.contains_key(key), "{kind} {i}: missing key {key}");
        }
        for key in go.keys() {
            assert!(eo.contains_key(key), "{kind} {i}: extra key {key}");
        }
        for (k, ev) in eo {
            let gv = go.get(k).expect("key checked");
            if let (Some(gt), Some(et)) = (gv.as_array(), ev.as_array()) {
                assert_eq!(gt.len(), et.len(), "{kind} {i} {k} length");
                for (j, (ge, ee)) in gt.iter().zip(et.iter()).enumerate() {
                    assert_eq!(ge, ee, "{kind} {i} {k}[{j}]");
                }
            } else {
                assert_eq!(gv, ev, "{kind} {i} field {k}");
            }
        }
    }
}

#[test]
fn summarize_spans_reproduces_the_ts_oracle_exactly() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures");
    let spans: Vec<Value> =
        serde_json::from_str(&std::fs::read_to_string(dir.join("summarize-spans.json")).unwrap()).unwrap();
    let expected: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("summarize-expected.json")).unwrap()).unwrap();

    // The oracle ran in a fresh Node process whose callBodyRegistry is empty — |_| None mirrors it.
    let empty = agentlens_core::summarize::summarizer::summarize_spans(&[], &|_| None);
    assert_eq!(&empty, expected.get("empty").unwrap(), "empty-input literal");

    let got = agentlens_core::summarize::summarizer::summarize_spans(&spans, &|_| None);
    let exp = expected.get("full").unwrap();
    if &got != exp {
        diff_cards("session", got.get("sessions").unwrap(), exp.get("sessions").unwrap());
        diff_cards("backgroundSpan", got.get("backgroundSpans").unwrap(), exp.get("backgroundSpans").unwrap());
        let (ge, ee) = (
            got.get("efficiency").unwrap().as_object().unwrap(),
            exp.get("efficiency").unwrap().as_object().unwrap(),
        );
        for (k, ev) in ee {
            assert_eq!(ge.get(k), Some(ev), "efficiency field {k}");
        }
        panic!("results diverge but no field-level diff fired");
    }
}

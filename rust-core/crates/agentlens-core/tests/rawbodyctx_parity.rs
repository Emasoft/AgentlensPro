//! Cross-engine parity for the raw-body → CallContext builder (TRDD-DMWOBWFH P4w.1b): the
//! committed oracle is generated from the COMPILED TS, and the Rust port must reproduce it
//! byte-for-byte INCLUDING key insertion order (the wire shape is a `Value` mirroring the TS
//! object literal — see the module's design law).
//!
//! Key order is asserted EXPLICITLY rather than relying on `assert_eq!` over two `Value`s: with
//! the `preserve_order` feature a `Value::Object` is an IndexMap, whose `PartialEq` is
//! order-INDEPENDENT — so a plain value comparison would pass on a reordered wire object and the
//! whole "insertion order is the contract" invariant would go untested.
//!
//! After any TS change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-rawbodyctx-expected.mjs

use agentlens_core::raw_body_context::{build_call_context_from_json, parse_user_id};
use serde_json::{Map, Value};

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/rawbodyctx-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Compare one wire object field-by-field. `text` is compared by LENGTH first so a mismatch on a
/// 20k-char truncation case reports the two lengths instead of dumping 40KB into the failure.
fn cmp_obj(got: &Value, exp: &Value, ctx: &str) {
    assert!(got.is_object(), "{ctx}: expected an object, got {got}");
    assert_eq!(keys(got), keys(exp), "{ctx}: key set/ORDER differs — an `undefined` value must be OMITTED (never null), and insertion order IS the wire order");
    for (k, ev) in exp.as_object().unwrap() {
        let gv = &got[k];
        if k == "text" {
            let (gs, es) = (gv.as_str().unwrap_or(""), ev.as_str().unwrap_or(""));
            assert_eq!(
                gs.encode_utf16().count(),
                es.encode_utf16().count(),
                "{ctx}.text: UTF-16 LENGTH differs (the cap counts code units, not bytes or chars)"
            );
            assert!(
                gs == es,
                "{ctx}.text: same length but different content\n  got: {:?}\n  exp: {:?}",
                gs.chars().take(120).collect::<String>(),
                es.chars().take(120).collect::<String>()
            );
            continue;
        }
        assert_eq!(gv, ev, "{ctx}.{k}");
    }
}

#[test]
fn parse_user_id_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, exp) in o["userIdCases"].as_array().unwrap().iter().zip(o["userIds"].as_array().unwrap()) {
        let p = parse_user_id(case);
        // Rebuild the TS return literal `{sessionId, accountUuid, deviceId}` in ITS key order,
        // omitting undefined — that is exactly what JSON.stringify produced in the oracle.
        let mut m = Map::new();
        if let Some(v) = &p.session_id {
            m.insert("sessionId".into(), Value::String(v.clone()));
        }
        if let Some(v) = &p.account_uuid {
            m.insert("accountUuid".into(), Value::String(v.clone()));
        }
        if let Some(v) = &p.device_id {
            m.insert("deviceId".into(), Value::String(v.clone()));
        }
        cmp_obj(&Value::Object(m), exp, &format!("parseUserId({case})"));
    }
}

#[test]
fn build_call_context_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let cases = o["bodyCases"].as_array().unwrap();
    let want = o["contexts"].as_array().unwrap();
    assert_eq!(cases.len(), want.len(), "oracle is internally inconsistent");
    for (i, (case, exp)) in cases.iter().zip(want).enumerate() {
        let ctx = format!("case[{i}]");
        let got = build_call_context_from_json(&case["body"], case["uncap"].as_bool().unwrap());
        // TS returns `null` for a null/non-object body; the generator serialized that as JSON null.
        if exp.is_null() {
            assert!(got.is_none(), "{ctx}: TS returned null, Rust returned {got:?}");
            continue;
        }
        let got = got.unwrap_or_else(|| panic!("{ctx}: TS returned a context, Rust returned None"));
        assert_eq!(keys(&got), keys(exp), "{ctx}: top-level key set/ORDER differs");

        let (gb, eb) = (got["blocks"].as_array().unwrap(), exp["blocks"].as_array().unwrap());
        assert_eq!(
            gb.iter().map(|b| b["id"].as_str().unwrap_or("?")).collect::<Vec<_>>(),
            eb.iter().map(|b| b["id"].as_str().unwrap_or("?")).collect::<Vec<_>>(),
            "{ctx}: block id sequence differs (id encodes kind + position, so this catches a wrong \
             kind, a missing block, an extra block, and a reordering all at once)"
        );
        for (j, (g, e)) in gb.iter().zip(eb).enumerate() {
            cmp_obj(g, e, &format!("{ctx}.blocks[{j}]"));
        }
        for k in keys(exp) {
            if k != "blocks" {
                assert_eq!(got[k], exp[k], "{ctx}.{k}");
            }
        }
    }
}

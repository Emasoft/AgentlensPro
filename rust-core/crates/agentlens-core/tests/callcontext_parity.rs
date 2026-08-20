//! Cross-engine parity for `resolveCallContext` (TRDD-DMWOBWFH P4w.3, freeze row 35).
//!
//! This test is almost entirely about KEY ORDER, which is exactly what a test of freshly-built
//! contexts cannot observe: the resolved shape depends on whether the body named a model, whether
//! it named an EMPTY model, and whether any requestId was available.
//!
//! After any TS change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-callcontext-expected.mjs

use agentlens_core::account_registry::AccountRegistry;
use agentlens_core::call_body_registry::{CallBodyPointer, CallBodyRegistry};
use agentlens_core::raw_body_context::{
    build_call_context, build_call_context_from_json, finalize_resolved_context,
};
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/callcontext-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn bodies_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/bodies")
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Re-run the whole resolve for one oracle case: rebuild the registry state, resolve the pointer,
/// build the context, apply the four post-assignments, and do the account backfill — the same
/// sequence the route performs, minus the lock choreography.
fn resolve(case: &Value) -> (Value, Option<String>) {
    let session = case["session"].as_str().unwrap();
    let mut reg = CallBodyRegistry::default();
    let mut accounts = AccountRegistry::default();
    for p in case["pointers"].as_array().unwrap() {
        let body_ref = p.get("bodyRef").and_then(Value::as_str).map(|r| bodies_dir().join(r).to_string_lossy().into_owned());
        reg.record(
            session,
            CallBodyPointer {
                kind: if p["kind"] == "response" { "response" } else { "request" },
                body_ref,
                inline_body: p.get("inlineBody").and_then(Value::as_str).map(str::to_owned),
                request_id: p.get("requestId").and_then(Value::as_str).map(str::to_owned),
                span_id: p.get("spanId").and_then(Value::as_str).map(str::to_owned),
                model: p.get("model").and_then(Value::as_str).map(str::to_owned),
                query_source: None,
                ts: p["ts"].as_i64().unwrap(),
            },
        );
    }
    let sel_request = case["sel"].get("requestId").and_then(Value::as_str);
    let sel_span = case["sel"].get("spanId").and_then(Value::as_str);
    let Some(ptr) = reg.resolve_request(session, sel_request, sel_span).cloned() else {
        return (Value::Null, None);
    };
    let built = match ptr.body_ref.as_deref().filter(|r| !r.is_empty()) {
        Some(r) => build_call_context(r, false),
        None => ptr
            .inline_body
            .as_deref()
            .and_then(|b| serde_json::from_str::<Value>(b).ok())
            .and_then(|v| build_call_context_from_json(&v, false)),
    };
    let Some(ctx) = built else { return (Value::Null, None) };
    let ctx = finalize_resolved_context(ctx, session, sel_request, ptr.request_id.as_deref(), ptr.model.as_deref());
    if let Some(a) = ctx.get("accountUuid").and_then(Value::as_str).filter(|a| !a.is_empty()) {
        accounts.record(session, a);
    }
    let acct = accounts.account_for(session).map(str::to_owned);
    (ctx, acct)
}

#[test]
fn resolve_call_context_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    for (case, exp) in o["cases"].as_array().unwrap().iter().zip(o["results"].as_array().unwrap()) {
        let name = case["name"].as_str().unwrap();
        let (got, acct) = resolve(case);
        let want = &exp["ctx"];
        if want.is_null() {
            assert!(got.is_null(), "{name}: TS returned null, Rust returned {got}");
            continue;
        }
        assert_eq!(
            keys(&got),
            keys(want),
            "{name}: KEY ORDER differs — this is the whole point of row 35, and it cannot be \
             observed by any test of freshly-built contexts"
        );
        for (k, ev) in want.as_object().unwrap() {
            assert_eq!(&got[k], ev, "{name}.{k}");
        }
        assert_eq!(
            acct.as_deref(),
            exp["accountAfter"].as_str(),
            "{name}: the TRDD-BURNWDGT account backfill must run for every resolved context"
        );
    }
}

/// The three model outcomes share ONE code path and produce THREE different wire shapes, so they
/// are asserted by name: a real model stays put, an EMPTY-STRING model is replaced IN PLACE, and a
/// body that named no model has the key restored at its LITERAL position (before `blocks`) — never
/// appended after `requestId`, which is what a "an absent key appends" reading would produce.
#[test]
fn the_model_slot_keeps_its_literal_position_in_all_three_outcomes() {
    let o = oracle();
    let by_name = |n: &str| -> Value {
        let case = o["cases"].as_array().unwrap().iter().find(|c| c["name"] == n).expect("case present");
        resolve(case).0
    };

    for name in ["body-without-model-appends-it-after-requestId", "empty-string-model-is-replaced-in-place"] {
        let ctx = by_name(name);
        let k = keys(&ctx);
        let model_at = k.iter().position(|x| *x == "model").expect("model present");
        let blocks_at = k.iter().position(|x| *x == "blocks").expect("blocks present");
        assert!(model_at < blocks_at, "{name}: model must sit BEFORE blocks, got {k:?}");
        assert_eq!(ctx["model"], "ptr-model", "{name}");
    }

    // A falsy model with nothing to replace it drops the key entirely — not `null`, not "".
    let ctx = by_name("falsy-model-and-no-pointer-model-drops-the-key");
    assert!(ctx.get("model").is_none(), "an undefined assignment removes the key: {ctx}");

    // requestId, by contrast, is NOT in the literal, so it really does land last.
    let ctx = by_name("model-and-sel-request-id");
    assert_eq!(keys(&ctx).last(), Some(&"requestId"), "requestId appends: {:?}", keys(&ctx));
}

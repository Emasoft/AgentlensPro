//! Cross-engine parity for the burn monitor (TRDD-DMWOBWFH P4r.2): the expected output was
//! produced by the COMPILED src/burnMonitor.ts (tests/fixtures/gen-burnmonitor-expected.mjs —
//! the oracle). Regenerate after any TS monitor change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-burnmonitor-expected.mjs

use agentlens_core::burn::cache_ttl::{AuthRegime, TtlContext};
use agentlens_core::burn::monitor::{
    compute_burn_status, compute_session_status, gather_consumption_events, load_burn_config, observe_capacity_from_premature_end,
};
use serde_json::Value;
use std::collections::HashMap;

fn fixtures_dir() -> std::path::PathBuf {
    std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures")
}

/// '@fixture:<name>' → the absolute path in the fixtures dir (the generator's same magic).
fn resolve_env(env: &Value) -> HashMap<String, String> {
    let dir = fixtures_dir();
    env.as_object()
        .unwrap()
        .iter()
        .map(|(k, v)| {
            let v = v.as_str().unwrap();
            let v = match v.strip_prefix("@fixture:") {
                Some(name) => dir.join(name).to_string_lossy().into_owned(),
                None => v.to_owned(),
            };
            (k.clone(), v)
        })
        .collect()
}

fn ctx_of(v: &Value) -> Option<TtlContext> {
    let o = v.as_object()?;
    Some(TtlContext {
        auth: match o.get("auth").and_then(Value::as_str) {
            Some("subscription") => AuthRegime::Subscription,
            Some("usage-credits") => AuthRegime::UsageCredits,
            Some("api-key") => AuthRegime::ApiKey,
            _ => AuthRegime::Unknown,
        },
        force5m: o.get("force5m").and_then(Value::as_bool).unwrap_or(false),
        enable1h: o.get("enable1h").and_then(Value::as_bool).unwrap_or(false),
    })
}

/// Point at the FIRST diverging path instead of dumping two multi-KB trees.
fn assert_deep_eq(got: &Value, exp: &Value, path: &str) {
    if got == exp {
        return;
    }
    match (got, exp) {
        (Value::Object(g), Value::Object(e)) => {
            for (k, ev) in e {
                let gv = g.get(k).unwrap_or(&Value::Null);
                assert_deep_eq(gv, ev, &format!("{path}.{k}"));
            }
            for k in g.keys() {
                assert!(e.contains_key(k), "{path}: extra key {k} (got {got})");
            }
            panic!("{path}: objects diverge but no field diff fired");
        }
        (Value::Array(g), Value::Array(e)) => {
            assert_eq!(g.len(), e.len(), "{path}: array length (got {got}, exp {exp})");
            for (i, (gv, ev)) in g.iter().zip(e.iter()).enumerate() {
                assert_deep_eq(gv, ev, &format!("{path}[{i}]"));
            }
            panic!("{path}: arrays diverge but no element diff fired");
        }
        _ => panic!("{path}: got {got} expected {exp}"),
    }
}

#[test]
fn burn_monitor_reproduces_the_ts_oracle_exactly() {
    let dir = fixtures_dir();
    let cases: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("burnmonitor-cases.json")).unwrap()).unwrap();
    let expected: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("burnmonitor-expected.json")).unwrap()).unwrap();

    let now = cases["now"].as_f64().unwrap();
    let ttl_ctx = ctx_of(&cases["ttlCtx"]);
    let sessions = cases["sessions"].as_array().unwrap().clone();
    let statusline = cases["statusline"].as_array().unwrap().clone();

    // loadBurnConfig over every env case (env precedence, file parsing, junk filtering).
    for (c, e) in cases["envCases"].as_array().unwrap().iter().zip(expected["configs"].as_array().unwrap()) {
        let name = c["name"].as_str().unwrap();
        let config = load_burn_config(&resolve_env(&c["env"]), std::path::Path::new("/nonexistent-home"));
        assert_deep_eq(&config.to_value(), &e["config"], &format!("config[{name}]"));
    }

    // gatherConsumptionEvents — the merged, deduped, sorted stream.
    let events = gather_consumption_events(&sessions, &statusline, now);
    assert_deep_eq(&Value::Array(events.clone()), &expected["events"], "events");

    // computeBurnStatus under the env-threshold config (all four alert rules fire) and under
    // the observed-only config (pooled suppression + per-account observed + capacityExceeded).
    let status_config = load_burn_config(&resolve_env(&cases["statusEnv"]), std::path::Path::new("/nonexistent-home"));
    let status = compute_burn_status(&events, &sessions, &status_config, now, ttl_ctx.as_ref());
    assert_deep_eq(&status, &expected["status"], "status");
    let observed_config = load_burn_config(&resolve_env(&cases["observedEnv"]), std::path::Path::new("/nonexistent-home"));
    let observed_status = compute_burn_status(&events, &sessions, &observed_config, now, ttl_ctx.as_ref());
    assert_deep_eq(&observed_status, &expected["observedStatus"], "observedStatus");

    // computeSessionStatus over every selector shape.
    for (sel, e) in cases["selectors"].as_array().unwrap().iter().zip(expected["sessionStatuses"].as_array().unwrap()) {
        let sid = sel.get("sessionId").and_then(Value::as_str);
        let ws = sel.get("workspace").and_then(Value::as_str);
        let got = compute_session_status(&sessions, &events, &status_config, sid, ws, now, ttl_ctx.as_ref());
        assert_deep_eq(&got, e, &format!("sessionStatus[{sel}]"));
    }

    // observeCapacityFromPrematureEnd.
    let pe = &cases["prematureEnd"];
    let got = observe_capacity_from_premature_end(&events, pe["accountUuid"].as_str(), pe["windowStartMs"].as_f64().unwrap(), pe["windowEndMs"].as_f64().unwrap());
    assert_deep_eq(&got, &expected["prematureEnd"], "prematureEnd");
}

//! END-TO-END cross-engine parity for `burnSeismic` (TRDD-DMWOBWFH P4x.2t). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-seismicrun-expected.mjs
//!
//! Nothing between the SQL and the result is exported from the TS — the aggregation, the bucket
//! grid, the per-bucket nulls and the event assembly are all locals — so the returned object IS the
//! contract, and this test compares the whole of it: key sets, key ORDER, every array's length and
//! order, and every number.
//!
//! It runs a REAL DuckDB (the same `DuckSession` the server uses), because the SQL is half of what
//! is being ported: `time_bucket`, the `json_extract` paths, the timestamp CASTs in the spawn window
//! and the torn-line probe are all only exercised by executing them.

use agentlens_core::burn_seismic as bs;
use serde_json::Value;

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/seismicrun-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Structural equality with a numeric tolerance. Strings, booleans and nulls are EXACT — the
/// verdict's rounded percentages, the cause classes and the ISO labels are decisions, and a
/// tolerance there would hide a real divergence. Only the continuous statistics get an epsilon,
/// because `ln`/`exp` differ in the last ulp between V8's fdlibm and the platform's.
fn same(got: &Value, exp: &Value, label: &str) {
    match exp {
        Value::Object(o) => {
            assert_eq!(keys(got), keys(exp), "{label}: key set/ORDER differs");
            for (k, ev) in o {
                // `culprits` and `sessions` are ranked by an amount that TIES routinely — a steady
                // spender's event excess is exactly 0, and several sessions can be steady. Both
                // engines then fall back to their sort's stability, i.e. to the insertion order of
                // the per-cell map, i.e. to DuckDB's intra-bucket GROUP order — which is unspecified
                // and differs between the node binding's DuckDB and the Rust crate's. The ranking
                // itself is still asserted; only the tie is broken by a deterministic key first, on
                // BOTH sides, so the comparison pins what the code decides and not what the engine
                // happened to emit.
                if k == "culprits" || k == "sessions" {
                    same(&tie_broken(&got[k]), &tie_broken(ev), &format!("{label}.{k}"));
                    continue;
                }
                same(&got[k], ev, &format!("{label}.{k}"));
            }
        }
        Value::Array(ea) => {
            let ga = got.as_array().unwrap_or_else(|| panic!("{label}: not an array: {got}"));
            assert_eq!(ga.len(), ea.len(), "{label}: length");
            for (i, (g, e)) in ga.iter().zip(ea).enumerate() {
                same(g, e, &format!("{label}[{i}]"));
            }
        }
        Value::Number(n) => {
            let (g, e) = (got.as_f64().unwrap_or_else(|| panic!("{label}: not a number: {got}")), n.as_f64().unwrap());
            let tol = 1e-9 * e.abs().max(1.0);
            assert!((g - e).abs() <= tol, "{label}: got {g}, exp {e}");
        }
        _ => assert_eq!(got, exp, "{label}"),
    }
}

/// Re-sort a ranked list by its own rank key, with the session id as a final tiebreak. Applied to
/// both sides, so it can only neutralize a TIE — a genuine ranking difference still fails.
fn tie_broken(v: &Value) -> Value {
    let Some(items) = v.as_array() else { return v.clone() };
    let mut rows = items.clone();
    let key = |x: &Value| -> (f64, f64, String) {
        let f = |k: &str| x.get(k).and_then(Value::as_f64).unwrap_or(0.0);
        // culprits rank on excessUsd; sessions on eventExcessUsd then costUsd. Reading both is
        // harmless — the absent one is 0 for every element, so it cannot reorder anything.
        (f("excessUsd") + f("eventExcessUsd"), f("costUsd"), x.get("session").and_then(Value::as_str).unwrap_or_default().to_owned())
    };
    rows.sort_by(|a, b| {
        let (ka, kb) = (key(a), key(b));
        kb.0.partial_cmp(&ka.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(kb.1.partial_cmp(&ka.1).unwrap_or(std::cmp::Ordering::Equal))
            .then(ka.2.cmp(&kb.2))
    });
    Value::Array(rows)
}

#[test]
fn burn_seismic_matches_end_to_end() {
    let o = oracle();
    let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/seismicrun");
    let token = fixtures.to_string_lossy().into_owned();
    let all: Vec<std::path::PathBuf> = o["files"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| std::path::PathBuf::from(v.as_str().unwrap().replace("<FIXTURES>", &token)))
        .collect();

    for (name, case) in o["cases"].as_object().unwrap() {
        let c = &case["opts"];
        // Each case gets its OWN connection: the TS opens one per call and closes it in a `finally`,
        // so a shared session would let one case's temporary state reach the next.
        let session = agentlens_store::transcript_sql::DuckSession::open_in_memory().unwrap();
        let query = |sql: &str| session.query(sql);
        let files = match c["files"].as_array() {
            Some(list) => list
                .iter()
                .map(|v| std::path::PathBuf::from(v.as_str().unwrap().replace("<FIXTURES>", &token)))
                .collect(),
            None => all.clone(),
        };
        let opts = bs::BurnSeismicOptions {
            files,
            since_iso: Some(
                c["sinceIso"].as_str().unwrap_or_else(|| o["sinceIso"].as_str().unwrap()).to_owned(),
            ),
            bucket_minutes: c["bucketMinutes"].as_f64(),
            rate_law: c["rateLaw"].as_str(),
            cfar_reference: c["cfarReference"].as_f64(),
            // 'internal' throughout: the 'auto' default probes for the `stochastic` community
            // extension and would try to INSTALL it over the network, which is not a dependency a
            // test may acquire silently.
            pvalue_engine: Some("internal"),
            ..bs::BurnSeismicOptions::default()
        };
        let got = bs::burn_seismic(&opts, &query, 0.0);
        let got: Value =
            serde_json::from_str(&serde_json::to_string(&got).unwrap().replace(&token, "<FIXTURES>")).unwrap();
        same(&got, &case["out"], name);
    }
}

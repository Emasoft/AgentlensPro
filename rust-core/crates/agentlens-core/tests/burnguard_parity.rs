//! Cross-engine parity for the burn guard's feeds (TRDD-DMWOBWFH P4r.4): expected output from
//! the COMPILED bodiesActivity.ts + burnGuard.ts + causingToolCall.ts + projectSlug.ts, over a
//! COMMITTED fixture tree both engines read byte-identically
//! (tests/fixtures/gen-burnguard-expected.mjs — the oracle; it rebuilds the tree, so rerunning
//! it is how you regenerate BOTH sides). After any TS change:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-burnguard-expected.mjs

use agentlens_core::burn::bodies_activity::{extract_response_usage, fmt_fat_senders, BodiesActivityOptions, BodiesActivityTracker};
use agentlens_core::burn::causing_tool_call::{causing_tool_calls, composition, project_slug_of, resolve_project_slugs, CausingCallsOptions};
use agentlens_core::burn::guard::{check_burn_risk, BurnGuardOptions};
use serde_json::{json, Value};

const NOW: f64 = 1_787_000_000_000.0;

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
fn burn_guard_feeds_reproduce_the_ts_oracle_exactly() {
    let dir = fixtures();
    let root = dir.join("burnguard-tree");
    let expected: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("burnguard-expected.json")).unwrap()).unwrap();

    // Re-pin the mtimes the oracle recorded — git checkout clobbers them, and "newest response"
    // is decided by mtime, so a fresh clone would rank by readdir order instead.
    for (name, ms) in expected["mtimes"].as_object().unwrap() {
        let t = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_millis(ms.as_u64().unwrap());
        let f = std::fs::OpenOptions::new().append(true).open(root.join(name)).unwrap();
        f.set_times(std::fs::FileTimes::new().set_modified(t)).unwrap();
    }

    // BodiesActivityTracker: one incremental poll over the committed bodies dir.
    let mut tracker = BodiesActivityTracker::new(root.join("bodies"), BodiesActivityOptions::default());
    tracker.poll(NOW);
    let report = tracker.report(NOW);
    assert_deep_eq(&report, &expected["report"], "report");

    // sessionWarmSince — S1 thrashes (no warm hit), S2's response is the warm one.
    assert_eq!(
        json!({
            "s1": tracker.session_warm_since("11111111-aaaa-bbbb-cccc-000000000001", NOW - 600_000.0, 50_000.0),
            "s2": tracker.session_warm_since("22222222-aaaa-bbbb-cccc-000000000002", NOW - 600_000.0, 50_000.0),
        }),
        expected["warmSince"]
    );

    // fmtFatSenders — empty, the huge senders, and a cap of 1 (the "+N more" tail).
    let empty: Vec<Value> = Vec::new();
    let huge = report["hugeRequests90s"]["senders"].as_array().unwrap();
    let suspects = report["thrash"]["suspects"].as_array().unwrap();
    assert_eq!(
        json!([fmt_fat_senders(&empty, 2), fmt_fat_senders(huge, 2), fmt_fat_senders(suspects, 1)]),
        expected["fmtSenders"]
    );

    // extractResponseUsage — root / nested / no-usage / non-object.
    let usage_cases = [
        json!({"id":"msg_x","model":"m","usage":{"cache_creation_input_tokens":1,"cache_read_input_tokens":2}}),
        json!({"response":{"id":"r","model":"m2","usage":{"cache_creation_input_tokens":5}}}),
        json!({"nothing":true}),
        json!("str"),
    ];
    let got: Vec<Value> = usage_cases
        .iter()
        .map(|c| match extract_response_usage(c) {
            None => Value::Null,
            // num() for the counts: `json!` would print an f64 1 as `1.0`, which is the test
            // harness's shape, not the port's (the wire builders all go through num()).
            Some((model, cc, cr, id)) => json!({ "model": model, "cc": agentlens_core::summarize::helpers::num(cc), "cr": agentlens_core::summarize::helpers::num(cr), "id": id }),
        })
        .collect();
    assert_deep_eq(&Value::Array(got), &expected["usage"], "usage");

    // checkBurnRisk over all three feeds (6 rows; the fixture trips every one).
    let burn_status = json!({ "accountWindows": [
        { "accountUuid": "acct-1111", "accountLabel": "a@example.com", "fiveMinTokensPerMin": 400000,
          "budget": { "fiveHour": { "minutesToExhaustion": 42 }, "sevenDay": { "minutesToExhaustion": 120 } } },
        { "accountUuid": null, "fiveMinTokensPerMin": 10 },
    ] });
    let risk = check_burn_risk(&BurnGuardOptions {
        now: NOW,
        bodies_dir: root.join("bodies"),
        hook_events_dir: root.join("hook-events"),
        fanout_threshold: 5.0,
        spike_tokens_per_min: 250_000.0,
        recent_events: None,
        bodies_activity: Some(&report),
        burn_status: Some(&burn_status),
    });
    assert_deep_eq(&risk, &expected["risk"], "risk");

    // causingToolCalls — the window, the numbering, the torn-line note.
    let causing = causing_tool_calls(&CausingCallsOptions {
        at_ms: NOW - 60_000.0,
        session_id: None,
        workspace: Some("/tmp/wsA"),
        jsonl_path: None,
        window_ms: None,
        forward_slack_ms: None,
        tools: None,
        projects_dirs: vec![root.join("projects")],
    });
    assert_deep_eq(&causing, &expected["causing"], "causing");
    assert_eq!(Value::from(composition(causing["calls"].as_array().unwrap())), expected["composition"]);

    // projectSlugOf / resolveProjectSlugs.
    let slugs = json!([
        project_slug_of("/tmp/wsA"),
        project_slug_of("already-a-slug"),
        project_slug_of("  "),
        resolve_project_slugs("/tmp/wsA", &[root.join("projects")]),
    ]);
    assert_deep_eq(&slugs, &expected["slugs"], "slugs");
}

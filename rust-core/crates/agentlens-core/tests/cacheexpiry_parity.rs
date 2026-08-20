//! Cross-engine parity for `check_cache_expiry` (assessCacheExpiry + handleCheckCacheExpiry,
//! TRDD-OCNHOHE9 / TRDD-DMWOBWFH). Oracle:
//!   pnpm run compile-tests && node rust-core/crates/agentlens-core/tests/fixtures/gen-cacheexpiry-expected.mjs

use agentlens_core::burn::cache_ttl::{AuthRegime, SessionTtlKind, TtlContext};
use agentlens_core::mcp_tools::{assess_cache_expiry, check_cache_expiry};
use serde_json::{json, Value};

fn oracle() -> Value {
    let p = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/cacheexpiry-expected.json");
    serde_json::from_str(&std::fs::read_to_string(p).unwrap()).unwrap()
}

fn keys(v: &Value) -> Vec<&str> {
    v.as_object().map(|o| o.keys().map(String::as_str).collect()).unwrap_or_default()
}

/// Key ORDER is a wire contract `assert_eq!` cannot see (under `preserve_order` a `Value::Object`
/// is an IndexMap whose `PartialEq` ignores order). Asserted explicitly, recursing through
/// `sessions[]` so every row's field order is covered too.
fn same(got: &Value, exp: &Value, label: &str) {
    assert_eq!(keys(got), keys(exp), "{label}: key set/ORDER differs");
    if let Some(o) = exp.as_object() {
        for (k, ev) in o {
            if ev.is_object() {
                same(&got[k], ev, &format!("{label}.{k}"));
            } else if let Some(ea) = ev.as_array() {
                let ga = got[k].as_array().cloned().unwrap_or_default();
                assert_eq!(ga.len(), ea.len(), "{label}.{k}: length");
                for (i, (g, e)) in ga.iter().zip(ea).enumerate() {
                    if e.is_object() {
                        same(g, e, &format!("{label}.{k}[{i}]"));
                    } else {
                        assert_eq!(g, e, "{label}.{k}[{i}]");
                    }
                }
            } else {
                assert_eq!(&got[k], ev, "{label}.{k}");
            }
        }
    }
}

const SUBSCRIPTION: TtlContext = TtlContext { auth: AuthRegime::Subscription, force5m: false, enable1h: false };
const UNKNOWN_AUTH: TtlContext = TtlContext { auth: AuthRegime::Unknown, force5m: false, enable1h: false };

fn timeline_of(c: &Value) -> Vec<Value> {
    c.get("timeline").and_then(Value::as_array).cloned().unwrap_or_default()
}

/// One synthetic card: `start`/`tl` are minutes-ago offsets from `now`; `tl: None` = no timeline
/// entry (drives the 'unknown' verdict path).
#[allow(clippy::too_many_arguments)] // one literal-shaped test fixture builder, mirrors the generator's `card()`
fn card(id: &str, workspace: &str, project_path: &str, start_min_ago: f64, tl_min_ago: Option<f64>, parent: Option<&str>, spawn_kind: Option<&str>, now: f64) -> Value {
    let mut m = serde_json::Map::new();
    m.insert("sessionId".into(), id.into());
    m.insert("workspace".into(), workspace.into());
    m.insert("projectPath".into(), project_path.into());
    m.insert("startTime".into(), agentlens_core::summarize::helpers::iso_from_ms(now - start_min_ago * 60_000.0).into());
    if let Some(p) = parent {
        m.insert("parentSessionId".into(), p.into());
    }
    if let Some(k) = spawn_kind {
        m.insert("spawnKind".into(), k.into());
    }
    let tl: Vec<Value> = match tl_min_ago {
        Some(min_ago) => {
            let mut e = serde_json::Map::new();
            e.insert("type".into(), "api_request".into());
            e.insert("timestamp".into(), agentlens_core::summarize::helpers::iso_from_ms(now - min_ago * 60_000.0).into());
            vec![Value::Object(e)]
        }
        None => vec![],
    };
    m.insert("timeline".into(), Value::Array(tl));
    Value::Object(m)
}

/// The same fleet the generator built: proj1 has three mains (a=10m idle, c=1m idle, plus a
/// subagent and a fork child of main-a), proj2 has two mains (b=2h idle, d=30s idle — the
/// machine-wide-freshest card, which must diverge the machine-wide default from proj1's).
fn pool(now: f64) -> Vec<Value> {
    vec![
        card("main-a", "/w/proj1", "/w/proj1", 10.0, Some(10.0), None, None, now),
        card("sub-a", "/w/proj1", "/w/proj1", 10.0, Some(10.0), Some("main-a"), None, now),
        card("fork-a", "/w/proj1", "/w/proj1", 10.0, None, Some("main-a"), Some("fork"), now),
        card("main-b", "/w/proj2", "/w/proj2", 120.0, Some(120.0), None, None, now),
        card("main-c", "/w/proj1", "/w/proj1", 1.0, Some(1.0), None, None, now),
        card("main-d", "/w/proj2", "/w/proj2", 0.5, Some(0.5), None, None, now),
        card("sibling", "/w/proj1-old", "/w/proj1-old", 1.0, Some(1.0), None, None, now),
    ]
}

#[test]
fn format_idle_matches_the_ts_oracle() {
    let o = oracle();
    assert_eq!(agentlens_core::mcp_tools::format_idle(45_000.0), o["formatIdleSeconds"]);
    assert_eq!(agentlens_core::mcp_tools::format_idle(90_000.0), o["formatIdleMinutes"]);
    assert_eq!(agentlens_core::mcp_tools::format_idle(62.0 * 60_000.0), o["formatIdleHours"]);
    assert_eq!(agentlens_core::mcp_tools::format_idle(-5_000.0), o["formatIdleNegative"]);
}

#[test]
fn assess_cache_expiry_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let now = o["nowMs"].as_f64().unwrap();

    same(
        &assess_cache_expiry(Some(now - 30.0 * 60_000.0), now, Some(SessionTtlKind::Main), Some(&SUBSCRIPTION), None),
        &o["verdictMainFresh"],
        "verdictMainFresh",
    );
    same(
        &assess_cache_expiry(Some(now - 90.0 * 60_000.0), now, Some(SessionTtlKind::Main), Some(&SUBSCRIPTION), None),
        &o["verdictMainExpired"],
        "verdictMainExpired",
    );
    same(
        &assess_cache_expiry(Some(now - 6.0 * 60_000.0), now, Some(SessionTtlKind::Subagent), Some(&SUBSCRIPTION), None),
        &o["verdictSubagentExpired"],
        "verdictSubagentExpired",
    );
    same(&assess_cache_expiry(None, now, Some(SessionTtlKind::Main), Some(&SUBSCRIPTION), None), &o["verdictUnknown"], "verdictUnknown");
    same(
        &assess_cache_expiry(Some(now + 5_000.0), now, Some(SessionTtlKind::Main), Some(&SUBSCRIPTION), None),
        &o["verdictClockSkew"],
        "verdictClockSkew",
    );
    same(
        &assess_cache_expiry(Some(now - 30.0 * 60_000.0), now, Some(SessionTtlKind::Main), Some(&SUBSCRIPTION), Some(15.0 * 60_000.0)),
        &o["verdictThresholdOverride"],
        "verdictThresholdOverride",
    );
    same(
        &assess_cache_expiry(Some(now - 30.0 * 60_000.0), now, Some(SessionTtlKind::Main), Some(&SUBSCRIPTION), Some(0.0)),
        &o["verdictThresholdIgnored"],
        "verdictThresholdIgnored",
    );
    same(
        &assess_cache_expiry(Some(now - 3.0 * 60_000.0), now, Some(SessionTtlKind::Main), Some(&UNKNOWN_AUTH), None),
        &o["verdictAssumedUnknownAuth"],
        "verdictAssumedUnknownAuth",
    );
}

#[test]
fn check_cache_expiry_reproduces_the_ts_oracle_exactly() {
    let o = oracle();
    let now = o["nowMs"].as_f64().unwrap();
    let s = pool(now);
    let ttl_ctx = Some(&SUBSCRIPTION);

    same(
        &check_cache_expiry(&s, &timeline_of, ttl_ctx, &json!({"sessionId": "main-a"}), now, 20_000.0, None),
        &o["toolBySessionId"],
        "toolBySessionId",
    );
    same(
        &check_cache_expiry(&s, &timeline_of, ttl_ctx, &json!({"sessionId": "nope"}), now, 20_000.0, None),
        &o["toolBySessionIdMissing"],
        "toolBySessionIdMissing",
    );
    same(
        &check_cache_expiry(&s, &timeline_of, ttl_ctx, &json!({"sessionId": "main-b", "project": "/w/proj1"}), now, 20_000.0, None),
        &o["toolBySessionIdOverridesProject"],
        "toolBySessionIdOverridesProject",
    );
    same(
        &check_cache_expiry(&s, &timeline_of, ttl_ctx, &json!({"sessionId": "fork-a"}), now, 20_000.0, None),
        &o["toolForkUnknown"],
        "toolForkUnknown",
    );
    same(
        &check_cache_expiry(&s, &timeline_of, ttl_ctx, &json!({"sessionId": "main-a", "thresholdMinutes": 1}), now, 20_000.0, None),
        &o["toolThresholdOverride"],
        "toolThresholdOverride",
    );
    same(
        &check_cache_expiry(&s, &timeline_of, ttl_ctx, &json!({"project": "/w/proj1"}), now, 20_000.0, None),
        &o["toolProjectScopedDefault"],
        "toolProjectScopedDefault",
    );
    same(
        &check_cache_expiry(&s, &timeline_of, ttl_ctx, &json!({"project": "/w/proj1/"}), now, 20_000.0, None),
        &o["toolProjectScopedTrailingSlash"],
        "toolProjectScopedTrailingSlash",
    );
    same(
        &check_cache_expiry(&s, &timeline_of, ttl_ctx, &json!({"project": ""}), now, 20_000.0, None),
        &o["toolMachineWideDefault"],
        "toolMachineWideDefault",
    );
    same(
        &check_cache_expiry(&[s[6].clone()], &timeline_of, ttl_ctx, &json!({"project": "/w/proj1"}), now, 20_000.0, None),
        &o["toolSiblingPrefixNotInScope"],
        "toolSiblingPrefixNotInScope",
    );
    same(
        &check_cache_expiry(&s, &timeline_of, ttl_ctx, &json!({"all": true, "project": "/w/proj1"}), now, 20_000.0, None),
        &o["toolAllProj1"],
        "toolAllProj1",
    );
    same(
        &check_cache_expiry(&s, &timeline_of, ttl_ctx, &json!({"all": true, "project": ""}), now, 20_000.0, None),
        &o["toolAllWide"],
        "toolAllWide",
    );

    let tails: std::collections::HashMap<&str, f64> = [("main-a", now - 10.0 * 60_000.0), ("main-c", now - 1.0 * 60_000.0)].into();
    let resolver = |id: &str| -> Option<f64> { tails.get(id).copied() };
    same(
        &check_cache_expiry(&s, &timeline_of, ttl_ctx, &json!({"project": "/w/proj1"}), now, 20_000.0, Some(&resolver)),
        &o["toolDefaultWithResolver"],
        "toolDefaultWithResolver",
    );

    // An ALREADY-ELAPSED budget. `scanWithBudget` computes `deadline = Date.now() + timeBudgetMs`
    // UNCONDITIONALLY, so a negative budget is a deadline in the past: nothing is scanned and
    // `stoppedEarly` is true. The first port of this gated the deadline behind `budget > 0`, which
    // INVERTS the meaning — "no budget, scan the whole corpus" — and every existing case passed
    // because none of them used a non-generous budget. Pinned with -1 rather than 0 because a zero
    // budget is millisecond-nondeterministic (however many items fit in the current ms).
    same(
        &check_cache_expiry(&s, &timeline_of, ttl_ctx, &json!({"all": true, "project": ""}), now, -1.0, None),
        &o["toolAllElapsedBudget"],
        "toolAllElapsedBudget",
    );
    same(
        &check_cache_expiry(&s, &timeline_of, ttl_ctx, &json!({"project": "/w/proj1"}), now, -1.0, None),
        &o["toolDefaultElapsedBudget"],
        "toolDefaultElapsedBudget",
    );
}

/// An elapsed budget must produce an EMPTY, honestly-labelled answer — not a silent full scan.
/// This is the shape the `> 0` guard turned inside out: `sessionsScanned: 0` with
/// `stoppedEarly: true`, and on the default path no pick at all plus the subset `note`.
#[test]
fn an_elapsed_scan_budget_stops_before_the_first_item() {
    let o = oracle();
    let now = o["nowMs"].as_f64().unwrap();
    let s = pool(now);
    let all = check_cache_expiry(&s, &timeline_of, Some(&SUBSCRIPTION), &json!({"all": true, "project": ""}), now, -1.0, None);
    assert_eq!(all["coverage"]["sessionsScanned"], 0, "{all}");
    assert_eq!(all["coverage"]["stoppedEarly"], true);
    assert_eq!(all["coverage"]["sessionsConsidered"], s.len(), "the pool is still reported in full");
    assert_eq!(all["sessions"].as_array().unwrap().len(), 0);

    let def = check_cache_expiry(&s, &timeline_of, Some(&SUBSCRIPTION), &json!({"project": "/w/proj1"}), now, -1.0, None);
    assert_eq!(def["sessions"].as_array().unwrap().len(), 0, "nothing probed ⇒ no pick: {def}");
    assert!(def["note"].as_str().unwrap_or_default().contains("stopped early"), "{def}");
}

/// A sibling directory that merely shares a path PREFIX (`/w/proj1-old` vs `/w/proj1`) must never
/// match — a bare `starts_with` would treat it as a subdirectory.
#[test]
fn a_sibling_directory_sharing_a_prefix_is_never_in_scope() {
    let o = oracle();
    let now = o["nowMs"].as_f64().unwrap();
    let s = pool(now);
    let got = check_cache_expiry(&[s[6].clone()], &timeline_of, Some(&SUBSCRIPTION), &json!({"project": "/w/proj1"}), now, 20_000.0, None);
    assert_eq!(got["sessions"].as_array().unwrap().len(), 0, "{got}");
    assert_eq!(got["scope"]["sessionsInScope"], 0, "{got}");
}

/// The project-scoped default and the machine-wide default pick DIFFERENT sessions here — proj1's
/// newest main is `main-c`, but proj2 carries `main-d`, strictly fresher machine-wide.
#[test]
fn project_scope_and_machine_wide_default_diverge_on_purpose() {
    let o = oracle();
    let now = o["nowMs"].as_f64().unwrap();
    let s = pool(now);
    let scoped = check_cache_expiry(&s, &timeline_of, Some(&SUBSCRIPTION), &json!({"project": "/w/proj1"}), now, 20_000.0, None);
    let wide = check_cache_expiry(&s, &timeline_of, Some(&SUBSCRIPTION), &json!({"project": ""}), now, 20_000.0, None);
    assert_eq!(scoped["sessions"][0]["sessionId"], "main-c");
    assert_eq!(wide["sessions"][0]["sessionId"], "main-d");
}
